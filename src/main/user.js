const { session } = require('electron');
const config = require('./config');
const { isValidHttpsUrl } = require('./urls');

// The logged-in user's own profile. `email` is not part of the session info the
// embed SDK exposes, so it has to be asked for separately; this v2 endpoint is
// the documented source for it and needs no privilege beyond being logged in.
const CURRENT_USER_PATH = '/api/rest/2.0/auth/session/user';

// Same reasoning as orgs.js: the host comes from persisted config rather than
// the renderer, and the call runs here so it rides the auth window's cookie jar
// and avoids the file:// renderer's Origin: null.
async function fetchCurrentUser() {
  const host = config.read().hostUrl;
  if (!isValidHttpsUrl(host)) return null;
  try {
    const res = await session.defaultSession.fetch(`${host}${CURRENT_USER_PATH}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Only these fields are passed on. The endpoint also returns privileges,
    // group membership, favourites and org lists, none of which this app has
    // any use for and none of which should reach analytics.
    return {
      // Nullable in the API — a user created without one, or hidden by the
      // identity provider, has no email at all.
      email: data?.email ?? null,
      name: data?.name ?? null,
      displayName: data?.display_name ?? null,
      // How the user authenticates: LOCAL_USER, SAML_USER, OIDC_USER,
      // LDAP_USER or REMOTE_USER.
      accountType: data?.account_type ?? null,
      // Left as null rather than defaulted to false when absent, so "the
      // cluster did not say" stays distinguishable from "not a first login".
      isFirstLogin: data?.is_first_login ?? null,
    };
  } catch {
    return null;
  }
}

module.exports = { fetchCurrentUser };
