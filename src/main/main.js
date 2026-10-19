const { app, BrowserWindow, Notification, dialog, session, ipcMain, shell, screen, nativeTheme, powerMonitor } = require('electron');
const path = require('path');
const config = require('./config');
const orgs = require('./orgs');
const user = require('./user');
const { protocolOf, isSameOrigin, isValidHttpsUrl } = require('./urls');
const updater = require('./updater');
const { buildMenu } = require('./menu');

const INDEX_HTML = path.join(__dirname, '../../build/index.html');
const AUTH_LOADING_HTML = path.join(__dirname, 'auth-loading.html');
// Derived from the updater's repo constant so the allowlist cannot drift away
// from the release URLs the banner actually hands us.
const RELEASES_URL_PREFIX = `https://github.com/${updater.REPO}`;

// Match the renderer's --bg for the current appearance, so the window does not
// flash the wrong color before the first paint. Mirrors styles.css.
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#1f2024' : '#ffffff';
}
const DEFAULT_BOUNDS = { width: 1440, height: 900 };

let mainWindow = null;
let currentTsHost = null;

// ---------- Window bounds ----------

function savedBounds() {
  const { bounds } = config.read();
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) {
    return { width: bounds.width, height: bounds.height };
  }
  // A window restored onto a display that is no longer connected is invisible and
  // unrecoverable without editing the config, so fall back to centering.
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => (
    bounds.x < a.x + a.width && bounds.x + bounds.width > a.x &&
    bounds.y < a.y + a.height && bounds.y + bounds.height > a.y
  ));
  return onScreen ? bounds : { width: bounds.width, height: bounds.height };
}

let boundsTimer = null;
function rememberBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      config.update({ bounds: mainWindow.getNormalBounds() });
    }
  }, 400);
}

// ---------- Response header rewriting ----------

const CSP_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
];

// Header names arrive in whatever case the server sent, so every lookup here is
// case-insensitive rather than guessing at spellings.
function withoutHeaders(responseHeaders, names) {
  const headers = { ...responseHeaders };
  for (const key of Object.keys(headers)) {
    if (names.includes(key.toLowerCase())) delete headers[key];
  }
  return headers;
}

// A policy of `frame-ancestors *` consents to being framed by anyone, and
// fails here only because `*` matches network schemes and this app's top page
// is file://. Dropping that directive gives the frame what a browser would. A
// policy that names its ancestors is a real refusal — an identity provider's
// sign-in page, say — and is left alone, as is X-Frame-Options alongside it.
function withoutWildcardFrameAncestors(responseHeaders) {
  const headers = { ...responseHeaders };
  let dropped = false;
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name !== 'content-security-policy' && name !== 'content-security-policy-report-only') continue;
    headers[key] = (Array.isArray(value) ? value : [value]).map((policy) => (
      policy
        .split(';')
        .filter((directive) => {
          const [directiveName, ...sources] = directive.trim().split(/\s+/);
          const wildcard = directiveName.toLowerCase() === 'frame-ancestors' && sources.includes('*');
          if (wildcard) dropped = true;
          return !wildcard;
        })
        .join(';')
    ));
  }
  // A CSP frame-ancestors directive takes precedence over X-Frame-Options, so
  // a browser ignores X-Frame-Options here. Once the directive is gone it would
  // start applying, and has to go with it.
  return dropped ? withoutHeaders(headers, ['x-frame-options']) : responseHeaders;
}

// ---------- Session hardening ----------

// Embedded content must never be able to spawn an unmanaged BrowserWindow —
// will-navigate only covers top-level navigation, not window.open.
function denyWindowOpen(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    const protocol = protocolOf(url);
    if (protocol === 'https:' || protocol === 'http:') shell.openExternal(url);
    return { action: 'deny' };
  });
}

function configureSession() {
  const defaultSession = session.defaultSession;

  // Deny every privileged web permission except the one Spotter's file upload
  // may need: picking a file through the File System Access API asks for
  // 'fileSystem'. Granted only to the configured ThoughtSpot origin, so an
  // identity provider or any other page in this session still gets nothing.
  const allowed = (permission, url) => (
    permission === 'fileSystem' && isSameOrigin(url, currentTsHost)
  );

  defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requester = details?.requestingUrl || webContents?.getURL() || '';
    callback(allowed(permission, requester));
  });

  defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => (
    allowed(permission, requestingOrigin || '')
  ));

  // Cancel source map requests to suppress console noise
  defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.endsWith('.js.map') || details.url.endsWith('.css.map')) {
      return callback({ cancel: true });
    }
    callback({});
  });

  // Strip framing and CSP restrictions so the embed iframe works. Scoped to the
  // configured ThoughtSpot origin so third-party requests (e.g. OIDC providers)
  // keep their security headers.
  //
  // Nested frames on other origins keep their headers, with one exception.
  // ThoughtSpot renders charts in an iframe on its own chart host, which allows
  // `frame-ancestors *` — and `*` matches network schemes only, so the file://
  // page this app runs on is not an allowed ancestor and Chromium blocks the
  // frame. The embedded app then shows "Cannot display the chart". A browser
  // never hits this because its page is served over https.
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const trusted = isSameOrigin(details.url, currentTsHost);
    if (!trusted && details.resourceType !== 'subFrame') return callback({});
    const headers = trusted
      ? withoutHeaders(details.responseHeaders, CSP_HEADERS)
      : withoutWildcardFrameAncestors(details.responseHeaders);
    callback({ responseHeaders: headers });
  });
}

// ---------- Main window ----------

function createWindow() {
  currentTsHost = config.read().hostUrl || null;

  mainWindow = new BrowserWindow({
    ...DEFAULT_BOUNDS,
    ...savedBounds(),
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(INDEX_HTML);
  denyWindowOpen(mainWindow.webContents);

  // Keep the main window on the local file:// page at all times.
  // isMainFrame check is critical: will-navigate/will-redirect fire for ALL frames including
  // iframes — without this, the SpotterEmbed iframe's OIDC redirect to Okta gets blocked.
  const blockExternalNavigation = (event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !url.startsWith('file://')) {
      event.preventDefault();
    }
  };
  mainWindow.webContents.on('will-navigate', blockExternalNavigation);
  mainWindow.webContents.on('will-redirect', blockExternalNavigation);

  mainWindow.on('resize', rememberBounds);
  mainWindow.on('move', rememberBounds);

  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------- IPC ----------

ipcMain.handle('get-host-url', () => config.read().hostUrl || null);

ipcMain.handle('set-host-url', (_event, url) => {
  if (typeof url !== 'string' || !isValidHttpsUrl(url)) {
    throw new Error('Invalid URL: must be a valid HTTPS URL');
  }
  const origin = new URL(url).origin;
  config.update({ hostUrl: origin });
  currentTsHost = origin;
  return true;
});

ipcMain.handle('clear-host-url', () => {
  config.update({ hostUrl: undefined, authToken: undefined, loggedIn: undefined });
  currentTsHost = null;
  return true;
});


// Signing out has two jobs and only one of them is reliable, so they are
// ordered accordingly.
//
// clearStorageData() never settles while this session is live — it neither
// resolves nor rejects — so anything sequenced after it is unreachable. The
// reload is what returns the user to the login screen, so it runs first and
// unconditionally. Sequencing it after the clear left the window sitting on a
// signed-out embed indefinitely. Reloading first does not rescue the clear
// either; it still times out.
//
// The ThoughtSpot session is already ended server-side by the SDK's logout()
// that runs before this handler, so a clear that fails here leaves cached data
// and identity-provider cookies behind rather than an active app session. The
// cookies are the part worth fighting for: while they survive, a later sign-in
// can be answered by the identity provider without re-authenticating. Removing
// them one at a time does complete where the bulk clear stalls — a real logout
// went from leaving nine cookies behind, identity provider included, to none.
// It keeps the timeout anyway: the reason the bulk call stalls is still not
// understood, so this one is not assumed immune. Everything here is bounded, so
// logout cannot hang again whatever the storage layer does.
const LOGOUT_CLEAR_TIMEOUT_MS = 5000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${LOGOUT_CLEAR_TIMEOUT_MS}ms`)), LOGOUT_CLEAR_TIMEOUT_MS);
    }),
  ]);
}

async function removeAllCookies(ses) {
  for (const cookie of await ses.cookies.get({})) {
    const host = cookie.domain.replace(/^\./, '');
    const url = `http${cookie.secure ? 's' : ''}://${host}${cookie.path}`;
    // One bad cookie must not strand the rest.
    try { await ses.cookies.remove(url, cookie.name); } catch { /* next */ }
  }
}

ipcMain.handle('logout', async () => {
  config.update({ authToken: undefined, loggedIn: undefined });

  if (mainWindow) {
    try {
      await mainWindow.loadFile(INDEX_HTML);
    } catch (err) {
      console.error('Could not reload after logout:', err?.message || err);
    }
  }

  const ses = session.defaultSession;

  try {
    await withTimeout(removeAllCookies(ses), 'Cookie removal');
  } catch (err) {
    console.error('Logout:', err?.message || err);
  }

  // Started rather than awaited: these are the calls that do not settle, and
  // the handler must not be held open by a promise that never resolves. They
  // clear what they can in the background.
  ses.clearStorageData().catch(() => { /* best effort */ });
  ses.clearCache().catch(() => { /* best effort */ });
  ses.clearAuthCache().catch(() => { /* best effort */ });
});

// ---------- Orgs ----------

ipcMain.handle('get-orgs', () => orgs.fetchOrgs());

ipcMain.handle('get-current-user', () => user.fetchCurrentUser());

ipcMain.handle('switch-org', (_event, orgId) => orgs.switchOrg(orgId));

// Switching Org reloads the embed, which throws away whatever is on screen. Ask
// first when there is something to lose. A native sheet rather than an in-page
// modal: the renderer's chat area belongs to the iframe, and this reads as an
// app-level decision.
ipcMain.handle('confirm-org-switch', async (_event, orgName) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Switch', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Switch to ${orgName}?`,
    detail: 'Your current conversation will be closed.',
  });
  return response === 0;
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-logged-in', () => config.read().loggedIn || false);

ipcMain.handle('set-logged-in', (_event, value) => {
  config.update({ loggedIn: !!value });
  return true;
});

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Spotter answers can take a while, so users switch away while one is running.
// Silent when the window already has focus — they can see it themselves.
// app.dock only exists on macOS, so the optional call is the platform check.
ipcMain.on('notify-response-complete', () => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  new Notification({ title: 'Spotter', body: 'Your answer is ready.' })
    .on('click', focusMainWindow)
    .show();
  app.dock?.bounce('informational');
});

// Open a dedicated BrowserWindow for OIDC login.
// Uses defaultSession so the resulting auth cookies are shared with the main window's embed.
// Injects a window.uploadMixpanelEvent stub on dom-ready to work around a ThoughtSpot
// staging bug where their /authorize page calls this function from a script that fails to
// load from CDNjs (the referenced axios version does not exist on that CDN).
// tsHost is read from the persisted config rather than trusted from the renderer.
ipcMain.handle('open-auth-window', async () => {
  const tsHost = config.read().hostUrl;
  if (!tsHost) return { success: false };
  return new Promise((resolve) => {
    let resolved = false;
    let timer = null;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (authWin && !authWin.isDestroyed()) authWin.close();
      resolve(result);
    };

    const authWin = new BrowserWindow({
      width: 520,
      height: 680,
      title: 'Sign in to ThoughtSpot',
      // Without this the window paints its default white before the first
      // document arrives, which reads as a broken window rather than a wait.
      backgroundColor: windowBackground(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // defaultSession used by default — cookies shared with the main window
      },
    });

    // Reaching the identity provider is network-bound and can take several
    // seconds, during which the window would otherwise be an empty rectangle.
    // Paint a local splash first and let the real navigation replace it when it
    // commits. Awaiting the splash matters: starting both at once cancels the
    // file:// load before it is on screen.
    //
    // The file:// navigation is ignored by the did-navigate completion check
    // below, which only accepts URLs on the ThoughtSpot origin.
    authWin.loadFile(AUTH_LOADING_HTML)
      .catch(() => { /* a missing splash must not block signing in */ })
      .then(() => {
        if (!authWin.isDestroyed()) authWin.loadURL(`${tsHost}/callosum/v1/oidc/login`);
      });

    // Some identity providers open the login step with window.open. Keep it inside
    // this window so the resulting cookies land in the shared session, instead of
    // letting it spawn an unrestricted BrowserWindow.
    authWin.webContents.setWindowOpenHandler(({ url }) => {
      if (protocolOf(url) === 'https:') authWin.loadURL(url);
      return { action: 'deny' };
    });

    // Inject the stub on every dom-ready (fires on each page in the auth flow).
    // This must run before the XHR success callback that calls uploadMixpanelEvent.
    authWin.webContents.on('dom-ready', () => {
      authWin.webContents.executeJavaScript(
        'if (typeof window.uploadMixpanelEvent === "undefined") { window.uploadMixpanelEvent = function() {}; }'
      ).catch(() => {});
    });

    // Detect auth completion: ThoughtSpot redirects back to its main app after OIDC
    authWin.webContents.on('did-navigate', (_e, url) => {
      if (
        isSameOrigin(url, tsHost) &&
        !url.includes('/authorize') &&
        !url.includes('/callosum/v1/oidc') &&
        !url.includes('/callosum/v1/saml')
      ) {
        finish({ success: true });
      }
    });

    authWin.on('closed', () => finish({ success: false }));
    timer = setTimeout(() => finish({ success: false }), 10 * 60 * 1000);
  });
});

const onUpdateReady = (info) => sendToRenderer('update-available', info);

// The renderer checks once at launch, but a dock app stays open for days and
// would otherwise sit on an old build until it is quit. Keep checking in the
// background, and again shortly after wake, since a long sleep has most likely
// skipped a check. The delay gives the network time to come back first.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_CHECK_AFTER_WAKE_MS = 30 * 1000;

// Each version is announced once. A banner the user dismissed should not come
// back every few hours for the same release.
let announcedVersion = null;

async function checkForUpdatesAndRemember() {
  const info = await updater.checkForUpdates(onUpdateReady);
  if (info?.version) announcedVersion = info.version;
  return info;
}

async function checkForUpdatesInBackground() {
  const previous = announcedVersion;
  const info = await checkForUpdatesAndRemember();
  if (info && info.version !== previous) sendToRenderer('update-available', info);
}

function scheduleUpdateChecks() {
  setInterval(checkForUpdatesInBackground, UPDATE_CHECK_INTERVAL_MS);
  let wakeTimer = null;
  powerMonitor.on('resume', () => {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(checkForUpdatesInBackground, UPDATE_CHECK_AFTER_WAKE_MS);
  });
}

ipcMain.handle('check-for-updates', () => checkForUpdatesAndRemember());
ipcMain.handle('install-update', () => updater.quitAndInstall());

ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && url.startsWith(RELEASES_URL_PREFIX)) {
    shell.openExternal(url);
  }
});

// ---------- Lifecycle ----------

app.whenReady().then(() => {
  configureSession();
  buildMenu({
    onSwitchInstance: () => sendToRenderer('menu-action', 'switch-instance'),
    onSignOut: () => sendToRenderer('menu-action', 'sign-out'),
    onCheckForUpdates: async () => {
      // Asked for explicitly, so always answer — even with "up to date".
      const info = await checkForUpdatesAndRemember();
      sendToRenderer('update-available', info || { mode: 'current' });
    },
  });
  createWindow();
  scheduleUpdateChecks();

  // The CSS follows the appearance on its own; the native window background
  // shows through on resize and during reloads, so it has to follow too.
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(windowBackground());
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
