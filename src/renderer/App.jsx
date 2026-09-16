import React, { useEffect, useState, useCallback, useRef } from 'react';
import { init, Action, AuthType, AuthStatus, logout, getSessionInfo } from '@thoughtspot/visual-embed-sdk';
import { SpotterEmbed, useEmbedRef } from '@thoughtspot/visual-embed-sdk/react';
import { useAnswerNotification } from './useAnswerNotification';
import { useSpotterAnalytics } from './useSpotterAnalytics';
import { useConversationActivity } from './useConversationActivity';
import { useShareAnalytics } from './useShareAnalytics';
import { useEmbedErrors } from './useEmbedErrors';
import { useOrgs } from './useOrgs';
import { OrgSwitcher } from './OrgSwitcher';
import { initAnalytics, identify, track, setOrg } from './analytics';
import tsLogo from './logo.png';

// The embed takes one handler per event, but notifications and analytics both
// listen to the same four. Fan each event out instead of letting one win.
function mergeHandlers(...maps) {
  const merged = {};
  for (const map of maps) {
    for (const [event, handler] of Object.entries(map)) {
      const previous = merged[event];
      merged[event] = previous
        ? (...args) => { previous(...args); handler(...args); }
        : handler;
    }
  }
  return merged;
}

// Genuine workarounds for the embed overflowing its container, not styling —
// there is no CSS variable equivalent, so they stay as raw rules.
const LAYOUT_RULES = {
  'html': { 'overflow-x': 'clip !important', 'width': '100% !important' },
  'body': { 'width': '100% !important', 'max-width': '100% !important', 'overflow-x': 'clip !important', 'box-sizing': 'border-box !important' },
  '[class*="chatMessages"], [class*="chatBody"], [class*="conversationThread"], [class*="messageList"], [class*="chatContent"], [class*="messageContainer"], [class*="conversationContainer"]': { 'overflow-y': 'auto !important', 'width': '100% !important', 'max-width': '100% !important', 'box-sizing': 'border-box !important', 'word-break': 'break-word !important', 'overflow-wrap': 'break-word !important', 'white-space': 'normal !important' },
};

const EMBED_CUSTOMIZATIONS = {
  style: {
    customCSS: {
      variables: {
        // A desktop window is far wider than a browser column, and 100% left the
        // prompt bar stretched across ~1075px. Cap it at a readable measure but
        // keep the percentage fallback so it still collapses at the 800px
        // minimum window width.
        '--ts-var-spotter-chat-width': 'min(860px, 100%)',
      },
      rules_UNSTABLE: LAYOUT_RULES,
    },
  },
};

// Shared utility: extract a short friendly label from a ThoughtSpot host URL
function getHostLabel(tsHost) {
  try { return new URL(tsHost).hostname.split('.')[0]; } catch { return 'Spotter'; }
}

// ---------- Update banner ----------

// `info.mode` is decided in the main process: `ready` when electron-updater has
// staged an install, `downloading` while it fetches, `manual` when auto-update is
// unavailable and the user must grab the release themselves.
function UpdateBanner({ info, onDismiss }) {
  const { mode, version, url } = info;

  const action = {
    ready: { label: 'Restart', onClick: () => window.electronAPI?.installUpdate() },
    manual: { label: 'Download', onClick: () => window.electronAPI?.openExternal(url) },
  }[mode];

  const message = {
    ready: `✨ Version ${version} is ready to install`,
    downloading: `Downloading version ${version}…`,
    manual: `✨ Version ${version} is available`,
    current: 'Spotter is up to date',
  }[mode];

  return (
    <div className="update-banner" role="status">
      <span>{message}</span>
      {action && (
        <button className="update-banner-btn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      <button className="update-banner-dismiss" onClick={onDismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}

// ---------- SDK init ----------

function initializeSDK(tsHost, customizations, thirdPartyVars, onSuccess, onAuthFailed) {
  const authEE = init({
    thoughtSpotHost: tsHost,
    authType: AuthType.None,
    customizations,
    suppressNoCookieAccessAlert: true,
    // Turns the embedded app's pushState into replaceState (26.9+). Without it
    // the iframe builds up history the user cannot see, and a back gesture in a
    // window with no address bar walks through it instead of doing nothing.
    overrideHistoryState: true,
    // Read by a third-party script through window.tsEmbed, but only once the
    // cluster has External Tool Script Integration enabled and the hosting
    // domain allowlisted. Inert until then — see README.
    customVariablesForThirdPartyTools: thirdPartyVars,
  });

  if (authEE) {
    authEE
      .on(AuthStatus.SUCCESS, () => onSuccess?.())
      .on(AuthStatus.SDK_SUCCESS, () => onSuccess?.())
      .on(AuthStatus.FAILURE, () => onAuthFailed?.());
  }
}

// ---------- Error Boundary ----------

// Shown for both ways Spotter can fail: a render that throws in this window,
// and an embed that reports itself unusable. One screen because from the user's
// side it is one situation — Spotter is not there and reloading is the way out.
function EmbedErrorScreen() {
  return (
    <div className="loading-overlay">
      <p className="loading-text">Something went wrong loading Spotter.</p>
      <button className="setup-button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return <EmbedErrorScreen />;
    }
    return this.props.children;
  }
}

// ---------- Shared logo ----------

function SpotterLogo() {
  return (
    <img src={tsLogo} alt="ThoughtSpot" style={{ width: 64, height: 64, borderRadius: 16 }} />
  );
}

// ---------- Setup page ----------

function SetupPage({ onConnect }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    let cleaned = url.trim();
    if (!cleaned) { setError('Please enter a URL'); return; }
    if (!cleaned.startsWith('http')) cleaned = 'https://' + cleaned;
    try {
      const parsed = new URL(cleaned);
      cleaned = parsed.origin;
    } catch {
      setError('Invalid URL'); return;
    }
    setError('');
    try {
      // The main process re-validates and rejects anything that is not HTTPS.
      await onConnect(cleaned);
    } catch {
      setError('Could not connect to that URL — it must start with https://');
    }
  };

  return (
    <div className="app-container">
      <div className="titlebar">
        <span className="titlebar-title">Spotter</span>
      </div>
      <div className="setup-page">
        <div className="setup-card">
          <div className="setup-logo">
            <SpotterLogo />
          </div>
          <h1 className="setup-title">Connect to ThoughtSpot</h1>
          <p className="setup-subtitle">
            Enter the URL of your ThoughtSpot instance to launch Spotter
          </p>
          <form className="setup-form" onSubmit={handleSubmit}>
            <input
              className="setup-input"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="e.g. https://mycompany.thoughtspot.cloud"
              autoFocus
            />
            {error && <p className="setup-error">{error}</p>}
            <button className="setup-button" type="submit">Connect</button>
          </form>
          <p className="setup-hint">
            This is the URL you use to access ThoughtSpot in your browser
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------- Login page ----------

function LoginPage({ tsHost, onAuthDone, onBack }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const hostLabel = (() => {
    try { return new URL(tsHost).hostname; } catch { return tsHost; }
  })();

  const handleSignIn = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.electronAPI?.openAuthWindow();
      if (result?.success) {
        onAuthDone();
      } else {
        setError('Sign in was cancelled or timed out. Please try again.');
      }
    } catch {
      setError('Failed to open the sign-in window.');
    }
    setLoading(false);
  };

  return (
    <div className="app-container">
      <div className="titlebar">
        <span className="titlebar-title">Spotter</span>
      </div>
      <div className="setup-page">
        <div className="setup-card">
          <div className="setup-logo">
            <SpotterLogo />
          </div>
          <h1 className="setup-title">Sign in to ThoughtSpot</h1>
          <p className="setup-subtitle">{hostLabel}</p>
          <button
            className="setup-button"
            onClick={handleSignIn}
            disabled={loading}
          >
            {loading ? 'Opening sign-in window…' : 'Sign in'}
          </button>
          {error && <p className="setup-error">{error}</p>}
          <button className="setup-back-btn" onClick={onBack}>
            ← Wrong URL? Go back
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Spotter page ----------

function SpotterPage({ tsHost, appVersion, onSignOut, onAuthLost }) {
  const embedRef = useEmbedRef();
  const [sdkInitialized, setSdkInitialized] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);
  const sdkKeyRef = useRef(null);

  useEffect(() => {
    if (sdkKeyRef.current === tsHost) return; // already initialized for this host
    sdkKeyRef.current = tsHost;
    const thirdPartyVars = {
      surface: 'spotter-desktop',
      appVersion,
      platform: window.electronAPI?.platform,
    };
    initializeSDK(tsHost, EMBED_CUSTOMIZATIONS, thirdPartyVars, () => setSdkReady(true), onAuthLost);
    // init() returns synchronously; auth resolves later. Flipping this now lets the
    // embed mount and start loading its iframe while we are still waiting on auth,
    // instead of the two waits running back to back.
    setSdkInitialized(true);
  }, [tsHost, appVersion, onAuthLost]);

  // Identity comes from the ThoughtSpot session rather than anything we hold, so
  // it can only be resolved once auth has landed.
  useEffect(() => {
    if (!sdkReady) return;
    let cancelled = false;
    (async () => {
      try {
        // The email is not part of the embed session info, so it comes from the
        // main process, which owns the session cookies. Requested alongside
        // rather than after, so a slow or failing user lookup does not hold up
        // identifying the user by the GUID we already have.
        const [session, user] = await Promise.all([
          getSessionInfo(),
          window.electronAPI?.getCurrentUser?.() ?? null,
        ]);
        if (cancelled) return;
        identify({
          userGUID: session?.userGUID,
          host: getHostLabel(tsHost),
          clusterName: session?.clusterName,
          clusterVersion: session?.releaseVersion,
          appVersion,
          platform: window.electronAPI?.platform,
          arch: window.electronAPI?.arch,
          email: user?.email,
          displayName: user?.displayName,
          accountType: user?.accountType,
          isFirstLogin: user?.isFirstLogin,
        });
      } catch {
        // Analytics identity is best-effort; a failure here must not surface.
      }
    })();
    return () => { cancelled = true; };
  }, [sdkReady, tsHost, appVersion]);

  const answerNotification = useAnswerNotification();
  const analytics = useSpotterAnalytics();
  const shareAnalytics = useShareAnalytics();
  const { handlers: errorHandlers, fatal: embedFailed, reset: resetEmbedError } = useEmbedErrors();
  const { handlers: conversationHandlers, hasAsked, reset: resetConversation } = useConversationActivity();
  const { orgs, currentOrgId, switching, error: orgError, epoch, switchTo } = useOrgs({
    tsHost,
    enabled: sdkReady,
  });
  const hostLabel = getHostLabel(tsHost);

  // Keep the analytics super property in step with the Org actually in view,
  // on first load as well as after a switch.
  const currentOrgName = orgs.find((org) => org.id === currentOrgId)?.name;
  useEffect(() => { setOrg(currentOrgName); }, [currentOrgName]);

  const handleSelectOrg = useCallback(async (orgId) => {
    const target = orgs.find((org) => org.id === orgId);
    // Only interrupt when there is a conversation to lose; switching from an
    // empty chat costs the user nothing.
    if (hasAsked()) {
      const confirmed = await window.electronAPI?.confirmOrgSwitch?.(target?.name ?? 'another Org');
      if (!confirmed) return;
    }
    if (await switchTo(orgId)) {
      resetConversation();
      resetEmbedError();
      track('Org Switched');
    }
  }, [orgs, hasAsked, resetConversation, resetEmbedError, switchTo]);

  return (
    <div className="app-container">
      <div className="titlebar">
        <span className="titlebar-title">{hostLabel} - Spotter</span>
        <div className="titlebar-actions">
          <OrgSwitcher
            orgs={orgs}
            currentOrgId={currentOrgId}
            switching={switching}
            error={orgError}
            onSelect={handleSelectOrg}
          />
          <button className="titlebar-btn" onClick={onSignOut}>
            Logout
          </button>
        </div>
      </div>
      {!sdkReady && (
        <div className="loading-overlay">
          <div className="spinner" />
          <p className="loading-text">Connecting to ThoughtSpot...</p>
        </div>
      )}
      {sdkInitialized && (
        // Kept at full size while warming so the embed lays out against real
        // dimensions rather than reflowing when it is revealed.
        <div
          className={`embed-container${sdkReady ? '' : ' embed-container--warming'}`}
          id="ts-embed"
        >
          <ErrorBoundary>
            {embedFailed && <EmbedErrorScreen />}
            {!embedFailed && (
            <SpotterEmbed
              // Remount on Org switch: a new key destroys the iframe and builds a
              // fresh one, which picks up the session's newly-switched Org.
              key={epoch}
              ref={embedRef}
              frameParams={{ width: '100%', height: '100%' }}
              worksheetId="auto_mode"
              updatedSpotterChatPrompt={true}
              // Lets users interrupt a long generation (26.5+)
              enableStopAnswerGenerationEmbed={true}
              // The refreshed Spotter UI and its ambient glow (26.9+). Both are
              // rendered inside the iframe, so older clusters simply ignore them.
              updatedSpotterExperience={true}
              showSpotterRadiance={true}
              spotterChatConfig={{
                enableStarterPrompts: true, // 26.8+
                spotterFileUploadEnabled: true, // 26.6+
              }}
              // Live as of champagne 26.9. Only the labels that read oddly outside
              // a browser tab are overridden; the rest keep ThoughtSpot's
              // translated defaults so other locales are not pinned to English.
              spotterShareConversationConfig={{
                enableShareConversation: true, // 26.9+
                spotterShareModalTitle: 'Share this conversation',
                spotterShareEmptySubtitle: 'Not shared with anyone yet',
              }}
              {...mergeHandlers(answerNotification, analytics, shareAnalytics, conversationHandlers, errorHandlers)}
              spotterSidebarConfig={{
                enablePastConversationsSidebar: true,
                spotterSidebarTitle: 'My Conversations',
                spotterSidebarDefaultExpanded: false,
              }}
              // The sidebar footer's docs/"Best Practices" link points at the
              // ThoughtSpot help site, which has nowhere useful to go from a
              // desktop window. Removed rather than repointed (26.3+).
              hiddenActions={[Action.SpotterDocs]}
            />
            )}
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}

// ---------- Root ----------

export default function App() {
  const [tsHost, setTsHost] = useState(null);
  const [authDone, setAuthDone] = useState(false);
  const [checking, setChecking] = useState(true);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [appVersion, setAppVersion] = useState(null);

  useEffect(() => {
    initAnalytics();
    (async () => {
      const api = window.electronAPI;
      const [saved, loggedIn, version] = await Promise.all([
        api?.getHostUrl?.() ?? null,
        api?.getLoggedIn?.() ?? false, // skip LoginPage if a previous session authenticated
        api?.getAppVersion?.() ?? null,
      ]);
      if (saved) setTsHost(saved);
      if (loggedIn) setAuthDone(true);
      setAppVersion(version);
      setChecking(false);
    })();
  }, []);

  // Check once on startup, then stay subscribed: electron-updater downloads in the
  // background and reports separately when a build is staged and ready to install.
  useEffect(() => {
    (async () => {
      try {
        const info = await window.electronAPI?.checkForUpdates();
        if (info) setUpdateInfo(info);
      } catch {
        // Silently ignore update check failures
      }
    })();
    return window.electronAPI?.onUpdateAvailable?.(setUpdateInfo);
  }, []);

  const handleConnect = useCallback(async (url) => {
    await window.electronAPI?.setHostUrl?.(url);
    setTsHost(url);
  }, []);

  const handleAuthDone = useCallback(async () => {
    await window.electronAPI?.setLoggedIn(true);
    setAuthDone(true);
  }, []);

  const handleAuthLost = useCallback(async () => {
    await window.electronAPI?.setLoggedIn(false);
    setAuthDone(false);
  }, []);

  const handleDisconnect = useCallback(async () => {
    await window.electronAPI?.clearHostUrl();
    setTsHost(null);
    setAuthDone(false);
  }, []);

  const handleSignOut = useCallback(async () => {
    try { logout(); } catch (e) { console.error('SDK logout error:', e); }
    await window.electronAPI?.logout();
  }, []);

  useEffect(() => window.electronAPI?.onMenuAction?.((action) => {
    if (action === 'switch-instance') handleDisconnect();
    else if (action === 'sign-out') handleSignOut();
  }), [handleDisconnect, handleSignOut]);

  const updateBanner = updateInfo ? (
    <UpdateBanner info={updateInfo} onDismiss={() => setUpdateInfo(null)} />
  ) : null;

  if (checking) {
    return (
      <div className="app-container">
        {updateBanner}
        <div className="titlebar"><span className="titlebar-title">Spotter</span></div>
        <div className="loading-overlay"><div className="spinner" /></div>
      </div>
    );
  }

  if (!tsHost) {
    return (
      <>
        {updateBanner}
        <SetupPage onConnect={handleConnect} />
      </>
    );
  }

  if (!authDone) {
    return (
      <>
        {updateBanner}
        <LoginPage tsHost={tsHost} onAuthDone={handleAuthDone} onBack={handleDisconnect} />
      </>
    );
  }

  return (
    <>
      {updateBanner}
      <SpotterPage
        tsHost={tsHost}
        appVersion={appVersion}
        onSignOut={handleSignOut}
        onAuthLost={handleAuthLost}
      />
    </>
  );
}
