// Immediate launch feedback. The main window cannot exist until the server
// answers /healthz, which on a cold first start (fresh install, cold
// TypeScript loader, antivirus scanning every file it touches) can take a
// minute or more. Without this window that whole stretch is dead air: no
// window, no tray, nothing in the taskbar, and the launch reads as a hang.
// This small window appears before the server is spawned and is swapped for
// the real app window once the page has loaded.
import { BrowserWindow } from "electron";

let bootWin: BrowserWindow | null = null;
let shown = false;
let finished = false;

const BOOT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>exxperts</title>
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0d0d0f; color: #e8e8ec; font: 14px/1.5 system-ui, sans-serif; user-select: none; }
  .wrap { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 0 40px; text-align: center; }
  .spinner { width: 26px; height: 26px; border-radius: 50%; border: 3px solid rgba(140, 165, 255, 0.25);
             border-top-color: #8CA5FF; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 15px; font-weight: 600; margin: 0; }
  #status { margin: 0; color: #a8a8b3; }
</style></head><body><div class="wrap"><div class="spinner"></div><h1>Starting exxperts</h1>
<p id="status">The first launch after installing can take a minute while the local server warms up.</p>
</div></body></html>`;

// onDismissed fires only when the USER closes the window while startup is
// still in flight (closing the only visible surface of a not-yet-started app
// means "abort the launch"), never when the shell retires it itself.
export function showBootWindow(onDismissed: () => void): void {
  const win = new BrowserWindow({
    width: 460,
    height: 220,
    title: "exxperts",
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#0d0d0f",
    webPreferences: { sandbox: true },
  });
  win.setMenuBarVisibility(false);
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BOOT_HTML)}`);
  win.on("closed", () => {
    bootWin = null;
    if (!finished) onDismissed();
  });
  bootWin = win;
  shown = true;
}

export function setBootStatus(text: string): void {
  if (!bootWin || bootWin.isDestroyed()) return;
  void bootWin.webContents
    .executeJavaScript(`document.getElementById("status").textContent = ${JSON.stringify(text)}; true`)
    .catch(() => undefined);
}

// Retire the window without triggering the dismissed-by-user path. Called
// both on success (the real window took over) and on startup failure (the
// error window took over).
export function closeBootWindow(): void {
  finished = true;
  if (bootWin && !bootWin.isDestroyed()) bootWin.close();
  bootWin = null;
}

export function bootWindowWasShown(): boolean {
  return shown;
}

export function bootWindowOpen(): boolean {
  return bootWin !== null && !bootWin.isDestroyed();
}
