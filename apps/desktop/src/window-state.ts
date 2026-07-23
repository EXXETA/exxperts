// Remembers the main window's size/position (and maximized flag) across
// launches. Stored in userData; restored only when the saved bounds still
// intersect a connected display's work area, so a detached monitor never
// strands the window off-screen.
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, screen, type Rectangle } from "electron";

type SavedState = { bounds?: Rectangle; maximized?: boolean };

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

export function loadWindowState(): SavedState {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as SavedState;
    const b = state.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 400 || b.height < 300) return {};
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    return visible ? state : {};
  } catch {
    return {};
  }
}

export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const state: SavedState = {
      // Normal (unmaximized) bounds, so unmaximizing after a restart goes
      // back to the remembered size.
      bounds: win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds(),
      maximized: win.isMaximized(),
    };
    try {
      const file = stateFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state));
    } catch {
      // remembering the window is best-effort
    }
  };
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on("resize", debounced);
  win.on("move", debounced);
  win.on("maximize", debounced);
  win.on("unmaximize", debounced);
  // The window only hides on close (tray semantics), so save immediately too.
  win.on("close", save);
}
