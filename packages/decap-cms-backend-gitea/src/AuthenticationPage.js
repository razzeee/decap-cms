import React from 'react';
import PropTypes from 'prop-types';
import styled from '@emotion/styled';
import { PkceAuthenticator } from 'decap-cms-lib-auth';
import { AuthenticationPage, Icon } from 'decap-cms-ui-default';

const LoginButtonIcon = styled(Icon)`
  margin-right: 18px;
`;

const ForkApprovalContainer = styled.div`
  display: flex;
  flex-flow: column nowrap;
  justify-content: space-around;
  flex-grow: 0.2;
`;
const ForkButtonsContainer = styled.div`
  display: flex;
  flex-flow: column nowrap;
  justify-content: space-around;
  align-items: center;
`;

export default class GiteaAuthenticationPage extends React.Component {
  static propTypes = {
    inProgress: PropTypes.bool,
    config: PropTypes.object.isRequired,
    onLogin: PropTypes.func.isRequired,
    t: PropTypes.func.isRequired,
    backend: PropTypes.object,
  };

  state = {};

  componentDidMount() {
    // Manually validate PropTypes - React 19 breaking change
    PropTypes.checkPropTypes(
      GiteaAuthenticationPage.propTypes,
      this.props,
      'prop',
      'GiteaAuthenticationPage',
    );

    const { base_url = 'https://try.gitea.io', app_id = '' } = this.props.config.backend;
    this.auth = new PkceAuthenticator({
      base_url,
      auth_endpoint: 'login/oauth/authorize',
      app_id,
      auth_token_endpoint: 'login/oauth/access_token',
      auth_token_endpoint_content_type: 'application/json; charset=utf-8',
    });
    // Complete authentication if we were redirected back to from the provider.
    this.auth.completeAuth((err, data) => {
      if (err) {
        this.setState({ loginError: err.toString() });
        return;
      } else if (data) {
        const { open_authoring: openAuthoring = false } = this.props.config.backend;
        if (openAuthoring) {
          return this.loginWithOpenAuthoring(data)
            .then(() => this.props.onLogin(data))
            .catch(error => {
              this.setState({
                loginError: error && error.toString ? error.toString() : String(error),
                findingFork: false,
                requestingFork: false,
              });
            });
        }
        this.props.onLogin(data);
      }
    });
  }

  getPermissionToFork = () => {
    return new Promise((resolve, reject) => {
      this.setState({
        requestingFork: true,
        approveFork: () => {
          this.setState({ requestingFork: false });
          resolve();
        },
        refuseFork: () => {
          this.setState({ requestingFork: false });
          reject();
        },
      });
    });
  };

  loginWithOpenAuthoring(data) {
    const { backend } = this.props;

    this.setState({ findingFork: true });
    return backend
      .authenticateWithFork({ userData: data, getPermissionToFork: this.getPermissionToFork })
      .catch(err => {
        this.setState({ findingFork: false });
        console.error(err);
        throw err;
      });
  }

  handleLogin = e => {
    e.preventDefault();
    const { open_authoring: openAuthoring = false } = this.props.config.backend;
    this.auth.authenticate({ scope: 'repository' }, (err, data) => {
      if (err) {
        this.setState({ loginError: err.toString() });
        return;
      }
      if (openAuthoring) {
        return this.loginWithOpenAuthoring(data)
          .then(() => this.props.onLogin(data))
          .catch(error => {
            this.setState({
              loginError: error && error.toString ? error.toString() : String(error),
              findingFork: false,
              requestingFork: false,
            });
          });
      }
      this.props.onLogin(data);
    });
  };

  renderLoginButton = () => {
    const { inProgress, t } = this.props;
    return inProgress || this.state.findingFork ? (
      t('auth.loggingIn')
    ) : (
      <React.Fragment>
        <LoginButtonIcon type="gitea" />
        {t('auth.loginWithGitea')}
      </React.Fragment>
    );
  };

  getAuthenticationPageRenderArgs() {
    const { requestingFork } = this.state;

    if (requestingFork) {
      const { approveFork, refuseFork } = this.state;
      return {
        renderPageContent: ({ LoginButton, TextButton, showAbortButton }) => (
          <ForkApprovalContainer>
            <p>
              Open Authoring is enabled: we need to use a fork on your Gitea account. (If a fork
              already exists, we'll use that.)
            </p>
            <ForkButtonsContainer>
              <LoginButton onClick={approveFork}>Fork the repo</LoginButton>
              {showAbortButton && (
                <TextButton onClick={refuseFork}>Don't fork the repo</TextButton>
              )}
            </ForkButtonsContainer>
          </ForkApprovalContainer>
        ),
      };
    }

    return {
      renderButtonContent: this.renderLoginButton,
    };
  }

  render() {
    const { config, t } = this.props;
    const authenticationPageRenderArgs = this.getAuthenticationPageRenderArgs();
    return (
      <AuthenticationPage
        onLogin={this.handleLogin}
        loginDisabled={
          this.props.inProgress || this.state.findingFork || this.state.requestingFork
        }
        loginErrorMessage={this.state.loginError}
        logoUrl={config.logo_url} // Deprecated, replaced by `logo.src`
        logo={config.logo}
        siteUrl={config.site_url}
        t={t}
        {...authenticationPageRenderArgs}
      />
    );
  }
}
