# exxperts desktop shell

The Electron app around the local exxperts server: it spawns the same server
the `exxperts web` command runs, signs the window in through the token
handshake, and keeps the server alive from the tray (closing the window hides
it; only Quit stops the server).

- `npm run dev` runs against a scratch state dir (never the real `~/.exxperts`); `-- --real-state` opts out.
- `npm run smoke` / `npm run smoke:update` / `npm run smoke:packaged` are the end-to-end checks (see scripts/).
- `npm run package` builds the distributable app; the server payload is the release archive built by `scripts/bundle-release.mjs`.

Privacy: one network call runs on a schedule. The app asks the GitHub
releases feed (`api.github.com`, the latest release of this repository) for
the newest version number when it starts and again every six hours while it
stays open, so an app that never restarts still learns about new releases.
The request carries no account or usage data; a newer version only shows an
update notice, and nothing downloads or installs until you choose it. There
is no setting to turn the check off. Check for Updates and the Health Check
make the same request when you use them. The server the app runs also
re-reads your saved gateways' model declarations shortly after start and
once a day; that contacts only the gateway addresses you saved. Room web
searches query DuckDuckGo (or your local SearXNG instance when one is
configured); search terms leave the machine only when a room actually
searches.

Known limit of unsigned local builds: macOS refuses notification-center
registration for ad-hoc-signed apps, so notification banners do not display
in locally packaged development builds (the tray dot is the finished-task
signal there). The signed release builds notify normally.
