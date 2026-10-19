const { session } = require('electron');
const config = require('./config');
const { isValidHttpsUrl } = require('./urls');

// The endpoint the SDK and ThoughtSpot itself use to ask "is this session still
// good": 200 while it is, 401 once it has expired or been signed out.
const IS_ACTIVE_PATH = '/callosum/v1/session/isactive';

// The persisted loggedIn flag only records that a sign-in once completed. The
// SDK cannot be asked instead: with AuthType.None it reports success without
// checking anything. So the session is checked here, on the same cookie jar the
// embed uses, before the app trusts the flag.
//
// Resolves true or false when the cluster answered, and null when it could not
// be reached. Offline is not signed out: treating it as such would send someone
// back to the sign-in screen every time they open the app on a train.
async function isSessionActive() {
  const host = config.read().hostUrl;
  if (!isValidHttpsUrl(host)) return false;
  try {
    const res = await session.defaultSession.fetch(`${host}${IS_ACTIVE_PATH}`, {
      credentials: 'include',
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    return null;
  } catch {
    return null;
  }
}

module.exports = { isSessionActive };
