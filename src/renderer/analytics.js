// The default mixpanel-browser entry bundles the session-replay recorder
// (@mixpanel/rrweb), which this app deliberately does not use. The core loader
// is Mixpanel's documented way to leave it out — it halves the renderer bundle
// and makes "no session replay" a property of the build, not just a setting.
import mixpanel from 'mixpanel-browser/src/loaders/loader-module-core';

// Usage tracking for the desktop app, reported to our own Mixpanel project.
//
// The token is injected at build time by webpack's DefinePlugin from
// MIXPANEL_TOKEN. When it is absent — which is every developer machine that has
// not set the variable — every function here becomes a no-op, so `npm start`
// never writes into the production project.
const TOKEN = process.env.MIXPANEL_TOKEN;

let ready = false;

export function initAnalytics() {
  if (!TOKEN || ready) return;
  try {
    mixpanel.init(TOKEN, {
      // The renderer is served from file://, where cookies are unavailable —
      // Mixpanel's default persistence would silently fail to keep a distinct
      // id across launches, making every session look like a new user.
      persistence: 'localStorage',
      // There are no page views in a single-window desktop app.
      track_pageview: false,
      // Clicks, inputs, scrolls and submits are captured automatically. Passing
      // an object merges over Mixpanel's defaults, so only pageview changes.
      //
      // pageview is off because this renderer is a single file:// page: the
      // default 'full-url' mode would report the local filesystem path, which
      // carries the macOS account name in a dev build and the bundle path in a
      // packaged one. Neither is usage data, and there is no navigation to
      // measure anyway.
      autocapture: { pageview: false },
      // Session replay stays off deliberately. It would record the Spotter
      // conversation — question text, returned values, whatever customer data is
      // on screen. Explicit rather than implicit so nobody has to guess.
      record_sessions_percent: 0,
    });
    ready = true;
  } catch (err) {
    console.error('Mixpanel init failed:', err?.message || err);
  }
}

// Called once the ThoughtSpot session is known. Identity is the ThoughtSpot user
// GUID; the instance hostname and build metadata ride along as super properties
// so every later event carries them without being passed explicitly.
export function identify({
  userGUID, host, clusterName, clusterVersion, appVersion, platform, arch,
  email, displayName, accountType, isFirstLogin,
}) {
  if (!ready) return;
  try {
    if (userGUID) mixpanel.identify(userGUID);
    mixpanel.register({
      ts_host: host,
      // The cluster's own name, which is what people call it in conversation;
      // ts_host stays because a renamed cluster keeps its hostname and vice
      // versa, so neither one identifies an instance on its own.
      cluster_name: clusterName,
      // What the cluster actually reports, rather than the lower bound the
      // `signal` property on Answer Completed infers from which completion
      // event fired.
      cluster_version: clusterVersion,
      app_version: appVersion,
      platform,
      arch,
      // How this user signs in, which on a desktop app that leans on SSO is
      // the difference between auth paths rather than a user attribute.
      account_type: accountType,
      // Registered rather than set on the profile so events from a first
      // session can be told apart later; as a profile property it would be
      // overwritten on the next launch and lose exactly that.
      is_first_login: isFirstLogin,
      surface: 'spotter-desktop',
    });
    // Identity attributes go on the profile rather than onto every event.
    // Mixpanel joins profile properties into event queries anyway, so
    // registering them as super properties would copy an email address onto
    // every row for no extra analytical reach.
    //
    // $email and $name are Mixpanel's reserved names — spelled this way they
    // populate the profile view and are what cohort filters and notifications
    // expect; any other spelling is just an opaque custom property.
    const profile = {};
    if (email) profile.$email = email;
    if (displayName) profile.$name = displayName;
    if (Object.keys(profile).length) mixpanel.people.set(profile);
  } catch (err) {
    console.error('Mixpanel identify failed:', err?.message || err);
  }
}

// The active Org rides along as a super property so every later event is
// attributable to one, without each call site having to pass it. Registered
// separately from identify() because the Org list resolves after the session
// does, and can change mid-session when the user switches.
export function setOrg(orgName) {
  if (!ready || !orgName) return;
  try {
    mixpanel.register({ org_name: orgName });
  } catch (err) {
    console.error('Mixpanel setOrg failed:', err?.message || err);
  }
}

export function track(event, props) {
  if (!ready) return;
  try {
    mixpanel.track(event, props);
  } catch (err) {
    console.error('Mixpanel track failed:', err?.message || err);
  }
}
