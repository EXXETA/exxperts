# exxperts desktop shell

The Electron app around the local exxperts server: it spawns the same server
the `exxperts web` command runs, signs the window in through the token
handshake, and keeps the server alive from the tray (closing the window hides
it; only Quit stops the server).

- `npm run dev` runs against a scratch state dir (never the real `~/.exxperts`); `-- --real-state` opts out.
- `npm run smoke` / `npm run smoke:update` / `npm run smoke:packaged` are the end-to-end checks (see scripts/).
- `npm run package` builds the distributable app; the server payload is the release archive built by `scripts/bundle-release.mjs`.

Privacy: the app makes no background network calls of its own. Check for
Updates and the Health Check contact the GitHub releases feed when you use
them; nothing runs on a schedule. Room web searches query DuckDuckGo (or
your local SearXNG instance when one is configured); search terms leave the
machine only when a room actually searches.

Known limit of unsigned local builds: macOS refuses notification-center
registration for ad-hoc-signed apps, so notification banners do not display
in locally packaged development builds (the tray dot is the finished-task
signal there). The signed release builds notify normally.
