const { app, BrowserWindow, Notification, dialog, session, ipcMain, shell, screen } = require('electron');
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

// Matches the renderer's chrome color so the window does not flash on launch.
const BACKGROUND = '#ffffff';
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
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isSameOrigin(details.url, currentTsHost)) return callback({});
    const headers = { ...details.responseHeaders };
    delete headers['x-frame-options'];
    delete headers['X-Frame-Options'];
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['Content-Security-Policy-Report-Only'];
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
    backgroundColor: BACKGROUND,
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
// them one at a time completes against a copy of a real profile, where the bulk
// clear is what stalls — it has not yet been confirmed against a live session,
// so it is attempted on a timeout rather than relied on. Everything here is
// bounded, so logout can never hang again whatever the outcome.
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
      backgroundColor: '#ffffff',
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

ipcMain.handle('check-for-updates', () => updater.checkForUpdates(onUpdateReady));
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
      const info = await updater.checkForUpdates(onUpdateReady);
      sendToRenderer('update-available', info || { mode: 'current' });
    },
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
