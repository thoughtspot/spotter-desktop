# Spotter Desktop

> **GitHub:** [thoughtspot/spotter-desktop](https://github.com/thoughtspot/spotter-desktop)

A native macOS desktop app that brings [ThoughtSpot Spotter](https://www.thoughtspot.com/spotter) to your dock — no browser tab required.

Built with Electron + React, it wraps the ThoughtSpot Visual Embed SDK to deliver a first-class desktop experience with persistent sessions, dark/light theme support, and a collapsible conversation sidebar.

## Features

- Connect to any ThoughtSpot cloud instance
- Full SSO / browser-based sign-in flow
- Persistent session and window size/position across launches
- Collapsible conversation history sidebar
- In-app auto-update
- Signed & notarization-ready macOS build

## Installation

The easiest way to get started is to download the latest release directly — no Node.js or build tools needed.

1. Go to the [Releases](https://github.com/thoughtspot/spotter-desktop/releases) page
2. Download the latest `Spotter-<version>-arm64.dmg` for Apple Silicon, or `Spotter-<version>.dmg` for an Intel Mac
3. Open the `.dmg`, drag **Spotter** to your Applications folder
4. Launch Spotter from Applications or Spotlight

> **First launch on macOS:** If you see a security warning, go to **System Settings → Privacy & Security** and click **Open Anyway**.

---

## Getting Started (Development)

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Run in Development

```bash
npm start        # one-shot build then launch
npm run dev      # watch mode — rebuilds on file changes (use during active development)
```

To open DevTools:

```bash
npm start -- --devtools
```

### Lint

```bash
npm run lint
```

### Build for macOS

```bash
npm run pack
```

Outputs a signed `.dmg` and `.zip` for both Apple Silicon (`-arm64`) and Intel in
the `dist/` folder. Auto-update picks the build matching the running Mac.

### Code Signing & Notarization

To produce a notarized build, set the following environment variables before running `npm run pack`:

```bash
export APPLE_ID="your@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
npm run pack
```

Without these variables, the app is built and signed but not notarized (Gatekeeper will show a warning on first launch).

### Usage Analytics

Spotter usage is reported to Mixpanel when the app is built with a project token:

```bash
MIXPANEL_TOKEN=your_project_token npm run pack
```

Webpack bakes the token into the renderer bundle. Without it every analytics call
is a no-op, so local builds and forks never write into the project.

Two events are sent, both derived from embed events the app already listens to:

| Event | Properties |
| --- | --- |
| `Question Asked` | — |
| `Answer Completed` | `duration_ms`, `signal` |

`signal` records which SDK event reported completion, which doubles as a reading
of the cluster's version: `SpotterResponseComplete` means 26.9+,
`SpotterData` means 10.10+, and `Data` means older than both.

Autocapture is enabled, so Mixpanel also records clicks, input changes, scrolls
and submits on its own. Pageviews are disabled: the renderer is a single
`file://` page, and Mixpanel's default `full-url` mode would report the local
filesystem path rather than anything useful. Session replay is off.

Note that autocapture only sees the app's own chrome — the titlebar, setup and
sign-in screens. Spotter itself renders in a cross-origin iframe that host-page
JavaScript cannot observe; capturing interactions in there needs the External
Tool Script Integration described below.

Users are identified by ThoughtSpot user GUID, with the instance hostname, app
version and platform registered as super properties. Nothing from the contents of
a conversation is collected — no question text, no answer data.

> **External Tool Script Integration is not wired up.** The app passes
> `customVariablesForThirdPartyTools` through `init()`, which is the SDK half of
> that feature, but a hosted script cannot load until ThoughtSpot Support enables
> the integration for the cluster and an administrator allowlists the script
> domain under **Develop > Customizations > Security Settings**. Until then the
> variables are inert and the tracking above runs entirely host-side.

### Publishing a Release

Auto-update reads `latest-mac.yml`, which electron-builder only writes when it
publishes the release itself. Push a tag and let CI do it:

```bash
npm version minor && git push --follow-tags
```

The `Release` workflow builds, signs, notarizes and publishes to GitHub Releases.
It needs these repository secrets: `CSC_LINK` (base64-encoded Developer ID `.p12`),
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`,
and `MIXPANEL_TOKEN`. The Mixpanel one is not optional in practice — without it
the released build reports no usage, and fails silently rather than loudly.

> Releases uploaded by hand will not contain `latest-mac.yml`. The app still
> notices them and falls back to showing a "Download" banner pointing at the
> Releases page, but silent auto-update will not work.

## Project Structure

```
src/
├── main/
│   ├── main.js        # Electron main process (windows, session, IPC)
│   ├── config.js      # Atomic read/write of spotter-config.json
│   ├── menu.js        # Application menu
│   ├── updater.js     # Auto-update, with GitHub Releases fallback
│   └── preload.js     # Preload script (context bridge)
└── renderer/
    ├── index.html     # HTML shell + CSP
    ├── index.jsx      # React entry point
    ├── App.jsx        # Main app component (setup, login, Spotter embed)
    └── styles.css     # Styles (theme tokens, light/dark)
```

## Tech Stack

| Layer | Technology |
|---|---|
| Shell | Electron 41 |
| UI | React 18 |
| Embed | ThoughtSpot Visual Embed SDK 1.51 |
| Bundler | Webpack 5 |
| Packaging | electron-builder + electron-updater |

## Troubleshooting

**Connect to a different ThoughtSpot instance:**

Use **File → Switch Instance…** from the menu bar. **File → Sign Out** clears the
session but keeps the host URL.

**Full reset (clear saved host, session and window position):**

Quit Spotter, delete the config file, and relaunch:
```
~/Library/Application Support/Spotter/spotter-config.json
```
