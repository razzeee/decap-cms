import { stripIndent } from 'common-tags';
import trimStart from 'lodash/trimStart';
import semaphore from 'semaphore';
import {
  asyncLock,
  basename,
  blobToFileObj,
  branchFromContentKey,
  Cursor,
  CURSOR_COMPATIBILITY_SYMBOL,
  entriesByFiles,
  entriesByFolder,
  filterByExtension,
  getBlobSHA,
  getMediaAsBlob,
  getMediaDisplayURL,
  getPreviewStatus,
  runWithLock,
  unsentRequest,
  unpublishedEntries,
  contentKeyFromBranch,
} from 'decap-cms-lib-util';

import API, { API_NAME, MOCK_PULL_REQUEST } from './API';
import AuthenticationPage from './AuthenticationPage';
import type { GiteaRepository } from './types';

import type {
  AssetProxy,
  AsyncLock,
  Config,
  Credentials,
  DisplayURL,
  Entry,
  Implementation,
  ImplementationFile,
  PersistOptions,
  User,
} from 'decap-cms-lib-util';
import type { Semaphore } from 'semaphore';
import type { GiteaUser } from './types';

const MAX_CONCURRENT_DOWNLOADS = 10;

type ApiFile = { id: string; type: string; name: string; path: string; size: number };

const { fetchWithTimeout: fetch } = unsentRequest;

export default class Gitea implements Implementation {
  lock: AsyncLock;
  api: API | null;
  options: {
    proxied: boolean;
    API: API | null;
    useWorkflow?: boolean;
    useOpenAuthoring?: boolean;
  };
  originRepo: string;
  repo?: string;
  branch: string;
  apiRoot: string;
  mediaFolder?: string;
  token: string | null;
  cmsLabelPrefix: string;
  previewContext: string;
  openAuthoringEnabled: boolean;
  alwaysForkEnabled: boolean;
  initialWorkflowStatus: string;
  _currentUserPromise?: Promise<GiteaUser>;
  _userIsOriginMaintainerPromises?: {
    [key: string]: Promise<boolean>;
  };
  _mediaDisplayURLSem?: Semaphore;

  constructor(config: Config, options = {}) {
    this.options = {
      proxied: false,
      API: null,
      useWorkflow: false,
      useOpenAuthoring: false,
      ...options,
    };

    if (
      !this.options.proxied &&
      (config.backend.repo === null || config.backend.repo === undefined)
    ) {
      throw new Error('The Gitea backend needs a "repo" in the backend configuration.');
    }

    this.api = this.options.API || null;
    this.repo = this.originRepo = config.backend.repo || '';
    this.branch = config.backend.branch?.trim() || 'master';
    this.apiRoot = config.backend.api_root || 'https://try.gitea.io/api/v1';
    this.token = '';
    this.mediaFolder = config.media_folder;
    this.cmsLabelPrefix = config.backend.cms_label_prefix || '';
    this.previewContext = config.backend.preview_context || '';
    this.openAuthoringEnabled = config.backend.open_authoring || false;
    this.alwaysForkEnabled = config.backend.always_fork || false;
    this.initialWorkflowStatus = config.backend.initial_workflow_status || 'draft';
    this.lock = asyncLock();

    // Validate open authoring configuration
    if (this.openAuthoringEnabled) {
      if (!this.options.useWorkflow) {
        throw new Error(
          'backend.open_authoring is true but publish_mode is not set to editorial_workflow.',
        );
      }
    }
  }

  isGitBackend() {
    return true;
  }

  async status() {
    const auth =
      (await this.api
        ?.user()
        .then(user => !!user)
        .catch(e => {
          console.warn('[StaticCMS] Failed getting Gitea user', e);
          return false;
        })) || false;

    return { auth: { status: auth }, api: { status: true, statusPage: '' } };
  }

  authComponent() {
    return AuthenticationPage;
  }

  restoreUser(user: User) {
    return this.authenticate(user);
  }

  async currentUser({ token }: { token: string }) {
    if (!this._currentUserPromise) {
      this._currentUserPromise = fetch(`${this.apiRoot}/user`, {
        headers: {
          Authorization: `token ${token}`,
        },
      }).then(res => res.json());
    }
    return this._currentUserPromise;
  }

  async userIsOriginMaintainer({
    username: usernameArg,
    token,
  }: {
    username?: string;
    token: string;
  }) {
    const username = usernameArg || (await this.currentUser({ token })).login;
    this._userIsOriginMaintainerPromises = this._userIsOriginMaintainerPromises || {};
    if (!this._userIsOriginMaintainerPromises[username]) {
      this._userIsOriginMaintainerPromises[username] = fetch(
        `${this.apiRoot}/repos/${this.originRepo}/collaborators/${username}/permission`,
        {
          headers: {
            Authorization: `token ${token}`,
          },
        },
      )
        .then(res => res.json())
        .then(({ permission }) => permission === 'admin' || permission === 'write');
    }
    return this._userIsOriginMaintainerPromises[username];
  }

  /**
   * Check if a fork exists for the current user with the correct parent
   */
  async forkExists({ token }: { token: string }): Promise<boolean> {
    try {
      const result: GiteaRepository = await fetch(`${this.apiRoot}/repos/${this.repo}`, {
        headers: { Authorization: `token ${token}` },
      }).then(res => res.json());

      // Check that it's a fork and has the correct parent
      const parentRepo = result.parent as GiteaRepository | null;
      return (
        result.fork === true &&
        parentRepo !== null &&
        parentRepo.full_name.toLowerCase() === this.originRepo.toLowerCase()
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * Poll until fork is available (fork creation is async in Gitea)
   */
  async pollUntilForkExists({ token, interval = 250 }: { token: string; interval?: number }) {
    const maxAttempts = 20; // 5 seconds max
    for (let i = 0; i < maxAttempts; i++) {
      const exists = await this.forkExists({ token });
      if (exists) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    return false;
  }

  /**
   * Create a fork or sync existing fork with upstream
   */
  async authenticateWithFork(state: Credentials, user: GiteaUser): Promise<{
    useOpenAuthoring: boolean;
    repo: string;
  }> {
    const token = state.token as string;

    // Check if user is a maintainer of the origin repo
    const isOriginMaintainer = await this.userIsOriginMaintainer({ token });

    if (isOriginMaintainer && !this.alwaysForkEnabled) {
      // Maintainers work directly on the origin repo
      return {
        useOpenAuthoring: false,
        repo: this.originRepo,
      };
    }

    // Non-maintainers (or always_fork enabled) use a fork
    const repoName = this.originRepo.split('/')[1];
    const forkRepo = `${user.login}/${repoName}`;
    this.repo = forkRepo;

    const forkExists = await this.forkExists({ token });

    if (forkExists) {
      // Fork exists - try to sync with upstream
      try {
        await fetch(`${this.apiRoot}/repos/${forkRepo}/mirror-sync`, {
          method: 'POST',
          headers: { Authorization: `token ${token}` },
        });
      } catch (e) {
        // Sync might not be available, continue anyway
        console.warn('Could not sync fork with upstream:', e);
      }
    } else {
      // Create the fork
      await fetch(`${this.apiRoot}/repos/${this.originRepo}/forks`, {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      // Wait for fork to be created
      const created = await this.pollUntilForkExists({ token });
      if (!created) {
        throw new Error('Timed out waiting for fork to be created');
      }
    }

    return {
      useOpenAuthoring: true,
      repo: forkRepo,
    };
  }

  async authenticate(state: Credentials) {
    this.token = state.token as string;

    // For open authoring, we need to check fork status first
    if (this.openAuthoringEnabled) {
      // Get user info first
      const user = await this.currentUser({ token: this.token });

      // Set up fork if needed
      const { useOpenAuthoring, repo } = await this.authenticateWithFork(state, user);
      this.repo = repo;
      this.options.useOpenAuthoring = useOpenAuthoring;
    }

    const apiCtor = API;
    this.api = new apiCtor({
      token: this.token,
      branch: this.branch,
      repo: this.repo,
      originRepo: this.originRepo,
      apiRoot: this.apiRoot,
      cmsLabelPrefix: this.cmsLabelPrefix,
      useOpenAuthoring: this.options.useOpenAuthoring,
      initialWorkflowStatus: this.initialWorkflowStatus,
    });

    const user = await this.api!.user();

    if (!this.openAuthoringEnabled) {
      // Only check write access if not using open authoring
      const isCollab = await this.api!.hasWriteAccess().catch(error => {
        error.message = stripIndent`
          Repo "${this.repo}" not found.

          Please ensure the repo information is spelled correctly.

          If the repo is private, make sure you're logged into a Gitea account with access.

          If your repo is under an organization, ensure the organization has granted access to Static
          CMS.
        `;
        throw error;
      });

      // Unauthorized user
      if (!isCollab) {
        throw new Error('Your Gitea user account does not have access to this repo.');
      }
    }

    // Authorized user
    return {
      name: user.full_name,
      login: user.login,
      avatar_url: user.avatar_url,
      token: state.token as string,
    };
  }

  logout() {
    this.token = null;
    if (this.api && this.api.reset && typeof this.api.reset === 'function') {
      return this.api.reset();
    }
  }

  getToken() {
    return Promise.resolve(this.token);
  }

  getCursorAndFiles = (files: ApiFile[], page: number) => {
    const pageSize = 20;
    const count = files.length;
    const pageCount = Math.ceil(files.length / pageSize);

    const actions = [] as string[];
    if (page > 1) {
      actions.push('prev');
      actions.push('first');
    }
    if (page < pageCount) {
      actions.push('next');
      actions.push('last');
    }

    const cursor = Cursor.create({
      actions,
      meta: { page, count, pageSize, pageCount },
      data: { files },
    });
    const pageFiles = files.slice((page - 1) * pageSize, page * pageSize);
    return { cursor, files: pageFiles };
  };

  async entriesByFolder(folder: string, extension: string, depth: number) {
    const repoURL = this.api!.originRepoURL;

    let cursor: Cursor;

    const listFiles = () =>
      this.api!.listFiles(folder, {
        repoURL,
        depth,
      }).then(files => {
        const filtered = files.filter(file => filterByExtension(file, extension));
        const result = this.getCursorAndFiles(filtered, 1);
        cursor = result.cursor;
        return result.files;
      });

    const readFile = (path: string, id: string | null | undefined) =>
      this.api!.readFile(path, id, { repoURL }) as Promise<string>;

    const files = await entriesByFolder(
      listFiles,
      readFile,
      this.api!.readFileMetadata.bind(this.api),
      API_NAME,
    );
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    files[CURSOR_COMPATIBILITY_SYMBOL] = cursor;
    return files;
  }

  async allEntriesByFolder(folder: string, extension: string, depth: number) {
    const repoURL = this.api!.originRepoURL;

    const listFiles = () =>
      this.api!.listFiles(folder, {
        repoURL,
        depth,
      }).then(files => files.filter(file => filterByExtension(file, extension)));

    const readFile = (path: string, id: string | null | undefined) => {
      return this.api!.readFile(path, id, { repoURL }) as Promise<string>;
    };

    const files = await entriesByFolder(
      listFiles,
      readFile,
      this.api!.readFileMetadata.bind(this.api),
      API_NAME,
    );
    return files;
  }

  entriesByFiles(files: ImplementationFile[]) {
    const repoURL = this.api!.repoURL;

    const readFile = (path: string, id: string | null | undefined) =>
      this.api!.readFile(path, id, { repoURL }).catch(() => '') as Promise<string>;

    return entriesByFiles(files, readFile, this.api!.readFileMetadata.bind(this.api), API_NAME);
  }

  // Fetches a single entry.
  getEntry(path: string) {
    const repoURL = this.api!.originRepoURL;
    return this.api!.readFile(path, null, { repoURL })
      .then(data => ({
        file: { path, id: null },
        data: data as string,
      }))
      .catch(() => ({ file: { path, id: null }, data: '' }));
  }

  async getMedia(mediaFolder = this.mediaFolder, folderSupport?: boolean) {
    if (!mediaFolder) {
      return [];
    }
    return this.api!.listFiles(mediaFolder, undefined, folderSupport).then(files =>
      files.map(({ id, name, size, path, type }) => {
        return { id, name, size, displayURL: { id, path }, path, isDirectory: type === 'tree' };
      }),
    );
  }

  async getMediaFile(path: string) {
    const blob = await getMediaAsBlob(path, null, this.api!.readFile.bind(this.api!));

    const name = basename(path);
    const fileObj = blobToFileObj(name, blob);
    const url = URL.createObjectURL(fileObj);
    const id = await getBlobSHA(blob);

    return {
      id,
      displayURL: url,
      path,
      name,
      size: fileObj.size,
      file: fileObj,
      url,
    };
  }

  getMediaDisplayURL(displayURL: DisplayURL) {
    this._mediaDisplayURLSem = this._mediaDisplayURLSem || semaphore(MAX_CONCURRENT_DOWNLOADS);
    return getMediaDisplayURL(
      displayURL,
      this.api!.readFile.bind(this.api!),
      this._mediaDisplayURLSem,
    );
  }

  persistEntry(entry: Entry, options: PersistOptions) {
    // persistEntry is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.persistFiles(entry.dataFiles, entry.assets, options),
      'Failed to acquire persist entry lock',
    );
  }

  async persistMedia(mediaFile: AssetProxy, options: PersistOptions) {
    try {
      await this.api!.persistFiles([], [mediaFile], options);
      const { sha, path, fileObj } = mediaFile as AssetProxy & { sha: string };
      const displayURL = URL.createObjectURL(fileObj as Blob);
      return {
        id: sha,
        name: fileObj!.name,
        size: fileObj!.size,
        displayURL,
        path: trimStart(path, '/'),
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  deleteFiles(paths: string[], commitMessage: string) {
    return this.api!.deleteFiles(paths, commitMessage);
  }

  async traverseCursor(cursor: Cursor, action: string) {
    const meta = cursor.meta!;
    const files = cursor.data!.get('files')!.toJS() as ApiFile[];

    let result: { cursor: Cursor; files: ApiFile[] };
    switch (action) {
      case 'first': {
        result = this.getCursorAndFiles(files, 1);
        break;
      }
      case 'last': {
        result = this.getCursorAndFiles(files, meta.get('pageCount'));
        break;
      }
      case 'next': {
        result = this.getCursorAndFiles(files, meta.get('page') + 1);
        break;
      }
      case 'prev': {
        result = this.getCursorAndFiles(files, meta.get('page') - 1);
        break;
      }
      default: {
        result = this.getCursorAndFiles(files, 1);
        break;
      }
    }

    const readFile = (path: string, id: string | null | undefined) =>
      this.api!.readFile(path, id, { repoURL: this.api!.originRepoURL }).catch(
        () => '',
      ) as Promise<string>;

    const entries = await entriesByFiles(
      result.files,
      readFile,
      this.api!.readFileMetadata.bind(this.api),
      API_NAME,
    );

    return {
      entries,
      cursor: result.cursor,
    };
  }

  async unpublishedEntries() {
    const listEntriesKeys = () =>
      this.api!.listUnpublishedBranches().then(branches =>
        branches.map(branch => contentKeyFromBranch(branch)),
      );

    const ids = await unpublishedEntries(listEntriesKeys);
    return ids;
  }

  async unpublishedEntry({
    id,
    collection,
    slug,
  }: {
    id?: string;
    collection?: string;
    slug?: string;
  }) {
    if (id) {
      const data = await this.api!.retrieveUnpublishedEntryData(id);
      return data;
    } else if (collection && slug) {
      const contentKey = this.api!.generateContentKey(collection, slug);
      const data = await this.api!.retrieveUnpublishedEntryData(contentKey);
      return data;
    } else {
      throw new Error('Missing unpublished entry id or collection and slug');
    }
  }

  async unpublishedEntryDataFile(collection: string, slug: string, path: string, id: string) {
    const contentKey = this.api!.generateContentKey(collection, slug);
    const branch = branchFromContentKey(contentKey);
    const data = (await this.api!.readFile(path, id, { branch })) as string;
    return data;
  }

  async unpublishedEntryMediaFile(collection: string, slug: string, path: string, id: string) {
    const contentKey = this.api!.generateContentKey(collection, slug);
    const branch = branchFromContentKey(contentKey);
    const blob = (await this.api!.readFile(path, id, { branch, parseText: false })) as Blob;
    const name = basename(path);
    const fileObj = blobToFileObj(name, blob);
    return {
      id: path,
      name,
      path,
      size: fileObj.size,
      displayURL: URL.createObjectURL(fileObj),
      file: fileObj,
    };
  }

  updateUnpublishedEntryStatus(collection: string, slug: string, newStatus: string) {
    return runWithLock(
      this.lock,
      () => this.api!.updateUnpublishedEntryStatus(collection, slug, newStatus),
      'Failed to acquire update entry status lock',
    );
  }

  publishUnpublishedEntry(collection: string, slug: string) {
    return runWithLock(
      this.lock,
      () => this.api!.publishUnpublishedEntry(collection, slug),
      'Failed to acquire publish entry lock',
    );
  }

  deleteUnpublishedEntry(collection: string, slug: string) {
    return runWithLock(
      this.lock,
      () => this.api!.deleteUnpublishedEntry(collection, slug),
      'Failed to acquire delete entry lock',
    );
  }

  async getDeployPreview(collection: string, slug: string) {
    try {
      const statuses = await this.api!.getStatuses(collection, slug);
      const deployStatus = getPreviewStatus(statuses, this.previewContext);

      if (deployStatus) {
        const { target_url: url, state } = deployStatus;
        return { url, status: state };
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
  }
}
