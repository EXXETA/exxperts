// The update panel: one small window for the whole one-click update, from
// the check through the download to the install and the reopen. It replaces
// the Health Check's text window in that role; the text window itself stays
// as it is for the Health Check and the server-stopped notices.
//
// Driven the way the text window is: a sandboxed data: page with no preload
// and no IPC, and three state setters that push one JSON-encoded object into
// it with executeJavaScript. Every string in the panel is built here from
// the parsed version triple and the numbers electron-updater reports, never
// from feed text. Cancel is the page's own window.close(), which Electron
// honours for a BrowserWindow (verified in a dev run); the caller treats the
// window closing during the download as the cancel, as before. Once the
// download is complete the window keeps the user out but lets the quit
// through: both install paths quit the app by closing every window through
// the normal close event, and a window that refused that close would leave
// the app open on "Reopening" for ever. setClosable(false) is such a refusal
// on macOS (the native close needs the closable style; verified: close()
// then leaves the window standing) and on Windows too (the native close
// checks the disabled close item and cancels the quit), so it is never
// called. On macOS the window buttons are hidden instead, the closable style
// stays and the native quitAndInstall's close lands. On Windows and Linux
// the panel ignores a close while installing until the app's own quit begins
// (before-quit fires before the quit closes the windows), so the user's
// close is refused and the quit's is honoured; that branch is read from
// Electron's source and is not exercised by the desktop smoke.
import path from "node:path";
import { app, BrowserWindow, nativeImage, nativeTheme } from "electron";

export type UpdatePanel = {
  window: BrowserWindow;
  setChecking(): void;
  setDownloading(transferredBytes: number, totalBytes: number, timeLeft: string | null): void;
  setInstalling(totalBytes: number): void;
  close(): void;
};

const WIDTH = 440;
const HEIGHT = 184;
const TITLE = "exxperts update";

// The exact colours of the spec, dark and light, pushed into the page as CSS
// custom properties so a theme change only re-pushes them.
type Palette = Record<"bg" | "text" | "secondary" | "muted" | "track" | "buttonBorder" | "buttonBg" | "accent", string>;

function palette(dark: boolean): Palette {
  return dark
    ? { bg: "#1c1c1e", text: "#f2f2f4", secondary: "#a9a9b0", muted: "#8a8a92", track: "#2c2c30", buttonBorder: "#45454b", buttonBg: "#26262a", accent: "#8ca5ff" }
    : { bg: "#f6f6f7", text: "#1c1c1e", secondary: "#5c5c64", muted: "#6b6b73", track: "#e2e2e6", buttonBorder: "#c9c9cf", buttonBg: "#ffffff", accent: "#4a63c9" };
}

// The app icon for the panel's tile. Packaging ships dist/ and assets/ only,
// and build/ (the icns, the ico, the iconset) is not in the app, so the tile
// reads a tracked copy: assets/update-icon.png is build/icon.iconset/
// icon_128x128.png (128 px). Fallbacks: the executable's own icon from the
// OS, and failing that an empty tile (never placeholder text).
function assetIconDataUrl(): string {
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "update-icon.png"));
  return icon.isEmpty() ? "" : icon.toDataURL();
}

const MB = 1024 * 1024;
const megabytes = (n: number) => Math.max(1, Math.round(n / MB));

type PanelState = {
  theme: Palette;
  state: "checking" | "downloading" | "installing";
  title: string;
  line: string;
  percent: number;
  bytes: string;
  time: string;
  note: string;
};

// The page: the mock's layout and values, the theme as custom properties on
// :root, and one render() that assigns the pushed strings and numbers to the
// slots. No divider lines: the card is the window, sized to its content.
function pageHtml(theme: Palette, iconDataUrl: string): string {
  const vars = Object.entries(theme).map(([k, v]) => `--${k}:${v}`).join(";");
  // The tracked icon has the platform's transparent margin (the tile occupies
  // 104 of its 128 px, centred); scaling by 128/104 inside the clipped 40 px
  // slot makes the tile itself the 40 px rounded square of the mock. The OS
  // fallback icon has no such margin and is shown as is.
  const icon = iconDataUrl ? `<img src="${iconDataUrl}" alt="" style="transform:scale(1.2308)">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title>
<style>
:root{${vars}}
html,body{margin:0;height:100%;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:-apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;font-size:13px;-webkit-font-smoothing:antialiased;user-select:none;cursor:default}
.card{box-sizing:border-box;width:${WIDTH}px;height:${HEIGHT}px;padding:22px 24px 20px;display:flex;flex-direction:column;gap:16px}
.head{display:flex;align-items:center;gap:14px}
.icon{width:40px;height:40px;border-radius:10px;overflow:hidden;flex-shrink:0}
.icon img{display:block;width:40px;height:40px}
.titles{display:flex;flex-direction:column;gap:2px;min-width:0}
.title{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.line{font-size:13px;color:var(--secondary)}
.progress{display:flex;flex-direction:column;gap:8px}
.track{height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.fill{width:0;height:6px;border-radius:3px;background:var(--accent)}
.checking .fill{width:26%;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:sweep 1.6s ease-in-out infinite}
@keyframes sweep{from{transform:translateX(-100%)}to{transform:translateX(385%)}}
.bytes{display:flex;justify-content:space-between;min-height:15px;font-size:12px;line-height:15px;color:var(--secondary);font-variant-numeric:tabular-nums}
.foot{display:flex;justify-content:space-between;align-items:center;padding-top:2px}
.installing .foot{align-items:flex-start}
.note{font-size:12px;line-height:1.35;color:var(--muted);max-width:280px}
.installing .note{max-width:300px}
button{font:inherit;font-size:13px;font-weight:500;padding:7px 16px;border-radius:8px;border:1px solid var(--buttonBorder);background:var(--buttonBg);color:var(--text);cursor:pointer;flex-shrink:0}
button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.installing button{display:none}
.spin{display:none;height:16px;font-size:12px;color:var(--muted);align-items:center;gap:8px;flex-shrink:0}
.installing .spin{display:inline-flex}
.spin svg{display:inline-block;animation:turn 1s linear infinite}
@keyframes turn{to{transform:rotate(360deg)}}
</style></head><body>
<div class="card">
  <div class="head">
    <div class="icon">${icon}</div>
    <div class="titles"><div class="title" id="title"></div><div class="line" id="state"></div></div>
  </div>
  <div class="progress">
    <div class="track"><div class="fill" id="fill"></div></div>
    <div class="bytes"><span id="bytes"></span><span id="time"></span></div>
  </div>
  <div class="foot">
    <span class="note" id="note"></span>
    <button type="button" id="cancel">Cancel</button>
    <span class="spin"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--track)" stroke-width="2"></circle><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-dasharray="26 34.6" transform="rotate(-90 7 7)"></circle></svg>Reopening</span>
  </div>
</div>
<script>
document.getElementById("cancel").addEventListener("click", () => window.close());
window.render = (s) => {
  for (const k of Object.keys(s.theme)) document.documentElement.style.setProperty("--" + k, s.theme[k]);
  document.body.className = s.state;
  document.getElementById("title").textContent = s.title;
  document.getElementById("state").textContent = s.line;
  document.getElementById("fill").style.width = s.state === "checking" ? "" : s.percent + "%";
  document.getElementById("bytes").textContent = s.bytes;
  document.getElementById("time").textContent = s.time;
  document.getElementById("note").textContent = s.note;
};
</script>
</body></html>`;
}

export function openUpdatePanel(options: { version: string; parent?: BrowserWindow }): UpdatePanel {
  const { version, parent } = options;
  let theme = palette(nativeTheme.shouldUseDarkColors);
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: TITLE,
    parent,
    show: false,
    backgroundColor: theme.bg,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true },
  });
  win.setMenuBarVisibility(false);
  // Centred over the app window; over the screen when the app window is
  // hidden (an offer taken from the tray menu).
  if (parent && !parent.isDestroyed() && parent.isVisible()) {
    const pb = parent.getBounds();
    const wb = win.getBounds();
    win.setPosition(Math.round(pb.x + (pb.width - wb.width) / 2), Math.round(pb.y + (pb.height - wb.height) / 2));
  } else {
    win.center();
  }
  win.once("ready-to-show", () => { if (!win.isDestroyed()) win.show(); });

  const title = `Updating exxperts to ${version}`;
  let current: PanelState = { theme, state: "checking", title, line: "Checking for the update", percent: 0, bytes: "", time: "", note: "exxperts closes and reopens by itself when the download is done." };
  let loaded = false;
  const push = () => {
    if (!loaded || win.isDestroyed()) return;
    void win.webContents.executeJavaScript(`window.render(${JSON.stringify(current)}); true`).catch(() => undefined);
  };
  win.webContents.once("did-finish-load", () => {
    loaded = true;
    push();
  });

  const iconDataUrl = assetIconDataUrl();
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml(theme, iconDataUrl))}`);
  if (!iconDataUrl) {
    void app.getFileIcon(process.execPath, { size: "large" }).then((icon) => {
      if (icon.isEmpty() || win.isDestroyed()) return;
      const src = JSON.stringify(icon.toDataURL());
      void win.webContents.executeJavaScript(
        `{ const img = document.createElement("img"); img.src = ${src}; img.alt = ""; document.querySelector(".icon").replaceChildren(img); } true`,
      ).catch(() => undefined);
    }).catch(() => undefined);
  }

  // Theme follows the app: re-push the colours when the OS theme changes.
  const onThemeChange = () => {
    if (win.isDestroyed()) return;
    theme = palette(nativeTheme.shouldUseDarkColors);
    win.setBackgroundColor(theme.bg);
    current = { ...current, theme };
    push();
  };
  nativeTheme.on("updated", onThemeChange);
  win.on("closed", () => nativeTheme.off("updated", onThemeChange));
  // While installing, on Windows and Linux, the user's close is refused and
  // the quit's is not: the quit announces itself on before-quit first.
  let installing = false;
  let quitting = false;
  const onBeforeQuit = () => { quitting = true; };
  app.on("before-quit", onBeforeQuit);
  win.on("closed", () => app.off("before-quit", onBeforeQuit));
  win.on("close", (event) => { if (installing && !quitting && process.platform !== "darwin") event.preventDefault(); });

  return {
    window: win,
    setChecking() {
      current = { ...current, state: "checking", line: "Checking for the update", percent: 0, bytes: "", time: "", note: "exxperts closes and reopens by itself when the download is done." };
      push();
    },
    setDownloading(transferredBytes, totalBytes, timeLeft) {
      const percent = totalBytes > 0 ? Math.min(100, Math.max(0, (transferredBytes / totalBytes) * 100)) : 0;
      current = {
        ...current,
        state: "downloading",
        line: "Downloading the update",
        percent,
        bytes: `${megabytes(transferredBytes)} of ${megabytes(totalBytes)} MB`,
        time: timeLeft ?? "",
        note: "exxperts closes and reopens by itself when the download is done.",
      };
      push();
    },
    setInstalling(totalBytes) {
      // The quit is under way from here: the user's own close goes, in the
      // way that keeps the quit's close of this window working (see the
      // header comment). Never setClosable(false).
      installing = true;
      if (!win.isDestroyed() && process.platform === "darwin") win.setWindowButtonVisibility(false);
      // On Windows the NSIS installer's own small window follows the panel
      // (the install runs after the app has quit); on macOS the swap and the
      // relaunch take a few seconds.
      const wait = process.platform === "win32" ? "one to two minutes" : "a few seconds";
      current = {
        ...current,
        state: "installing",
        line: "Download complete. Installing and reopening",
        percent: 100,
        bytes: `${megabytes(totalBytes)} of ${megabytes(totalBytes)} MB`,
        time: wait,
        note: "Your rooms, conversations and settings stay as they are.",
      };
      push();
    },
    close() {
      if (!win.isDestroyed()) win.close();
    },
  };
}
