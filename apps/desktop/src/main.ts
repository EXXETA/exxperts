// exxperts desktop shell, v1.
//
// Thin and additive by design: spawn the same local web server the CLI
// launcher runs, wait for /healthz, sign the window in through the existing
// /auth/session token handshake, and keep the server alive from the tray.
// Closing the window hides it (server and scheduled work keep running); only
// Quit stops the server.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from "electron";
import { payloadVersion, PORT, probePort, SERVER_ORIGIN, ServerHandle, serverRoot, takeOverPort } from "./server";
import { showHealthCheck, showTextWindow } from "./health";
import { loadWindowState, trackWindowState } from "./window-state";
import { checkForUpdate, getAvailableUpdate, isNewerVersion, onUpdateStateChanged, openUpdatePage } from "./update-check";

const SMOKE = process.env.EXXPERTS_DESKTOP_SMOKE === "1";

// Menu roles (About/Hide/Quit) read the app name, which otherwise falls back
// to the npm package name "@exxeta/exxperts-desktop". In dev, give userData
// its own dir so a dev run never shares state (or the single-instance lock)
// with an installed app.
app.setName("exxperts");
// Must match the NSIS shortcut's AppUserModelID (electron-builder uses the
// appId) or Windows silently drops toast notifications.
if (process.platform === "win32") app.setAppUserModelId("com.exxeta.exxperts");
// The web-ui gates its desktop-only CSS on this token. userAgentFallback is
// the reliable channel into navigator.userAgent (a per-webContents
// setUserAgent only changes request headers, not what the page sees).
app.userAgentFallback = `${app.userAgentFallback} ExxpertsDesktop/${app.getVersion()}`;
// About panel: the product version plus the bundled server payload's own
// version (they can drift between releases; showing both makes "which build
// is this" answerable without a terminal).
app.setAboutPanelOptions({
  applicationName: "exxperts",
  applicationVersion: app.getVersion(),
  version: `server ${payloadVersion()}`,
});
if (SMOKE) {
  // Smoke runs must never share userData with a real install (packaged
  // smoke would otherwise clobber the installed app's window state, share
  // its cookie jar, and silently exit through its single-instance lock).
  const scratch = process.env.EXXPERTS_DESKTOP_SCRATCH_HOME;
  app.setPath("userData", path.join(scratch && scratch.trim() ? path.resolve(scratch.trim()) : os.tmpdir(), "smoke-user-data"));
} else if (!app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "exxperts-dev"));
}

const server = new ServerHandle();
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let authToken = "";
let quitting = false;

let smokeFailed = false;

function smokeFail(message: string): never {
  if (!smokeFailed) console.error(`DESKTOP_SMOKE_FAIL ${message}`);
  smokeFailed = true;
  process.exitCode = 1;
  quitting = true;
  void server.stop().finally(() => app.exit(1));
  throw new Error(message);
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  setTrayBadge(false);
}

// Electron ships NO context menu of its own: right-click does nothing until
// the app builds one. Editable fields get cut/copy/paste plus the OS
// spellchecker's suggestions; plain selections get copy.
let smokeContextMenuItems = -1;

function wireContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      template.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
    }
    if (params.misspelledWord) {
      template.push({
        label: "Add to Dictionary",
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      template.push({ type: "separator" });
    }
    if (params.isEditable) {
      template.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll" },
      );
    } else if (params.selectionText.trim()) {
      template.push({ role: "copy" });
    }
    if (template.length === 0) return;
    // Built even in smoke mode so a crashing template cannot smoke green;
    // only the (blocking) popup is skipped there.
    const menu = Menu.buildFromTemplate(template);
    if (SMOKE) {
      smokeContextMenuItems = template.length;
      return;
    }
    menu.popup({ window: win });
  });
}

// exxperts:// deep links. Two producers: the OS (protocol handler, e.g. a
// notification clicked or a link from another app) and the web-ui itself,
// which navigates to exxperts://focus as its only channel to say "show the
// window" (sandboxed page, no preload IPC). The SPA has no URL routing, so a
// deep link shows the window in whatever room the page is in; notifications
// are fired from the open room, which makes that the right room.
let smokeDeepLink = false;

function handleDeepLink(rawUrl: string): void {
  let route = "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "exxperts:") return;
    route = parsed.host || parsed.pathname.replace(/\//g, "");
  } catch {
    return;
  }
  // task-done is the page's badge signal (a notification just fired): mark
  // the tray, do NOT surface the window. Every other route (focus, OS-level
  // invocations) shows the window, which clears the badge.
  if (route === "task-done") {
    const win = mainWindow;
    if (!win || win.isDestroyed() || !win.isVisible() || !win.isFocused()) setTrayBadge(true);
    return;
  }
  smokeDeepLink = true;
  showMainWindow();
}

// Same-origin popups (artifact "Open in new tab") become app child windows,
// which carry the session cookie; anything external goes to the real browser.
// Origin comparison must go through URL parsing: a prefix check waves through
// userinfo tricks like http://localhost:8790@evil.com.
function isAppOrigin(url: string): boolean {
  try {
    return new URL(url).origin === SERVER_ORIGIN;
  } catch {
    return false;
  }
}

function wireNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppOrigin(url)) return { action: "allow" };
    if (url.startsWith("exxperts:")) {
      handleDeepLink(url);
      return { action: "deny" };
    }
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppOrigin(url)) {
      event.preventDefault();
      if (url.startsWith("exxperts:")) {
        handleDeepLink(url);
        return;
      }
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  // Child windows inherit the same policy, else a popup could navigate
  // anywhere in-app.
  win.webContents.on("did-create-window", (child) => {
    wireNavigation(child);
    wireContextMenu(child);
  });
}

function createMainWindow(startHidden: boolean): BrowserWindow {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    width: saved.bounds?.width ?? 1440,
    height: saved.bounds?.height ?? 920,
    x: saved.bounds?.x,
    y: saved.bounds?.y,
    minWidth: 960,
    minHeight: 600,
    title: "exxperts",
    backgroundColor: "#0d0d0f",
    // Auto-started at login = tray only; the page still loads (hidden), so
    // the server runs and notifications fire. The window appears on tray or
    // Dock activation.
    show: !startHidden,
    // Real-app look on macOS: no title bar, traffic lights inset over the
    // sidebar; the web-ui provides the drag region (desktop-gated CSS).
    // Traffic lights pinned explicitly so the in-chrome toggle's CSS offsets
    // align deterministically (the hiddenInset default varies).
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 18 } } : {}),
    webPreferences: { sandbox: true, spellcheck: true },
  });
  if (saved.maximized) {
    // On a hidden boot, defer to the first reveal so the maximized flag is
    // not lost (an early save would write false).
    if (startHidden) win.once("show", () => win.maximize());
    else win.maximize();
  }
  trackWindowState(win);
  wireNavigation(win);
  wireContextMenu(win);
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("show", () => setTrayBadge(false));
  win.on("focus", () => setTrayBadge(false));
  return win;
}

function openInBrowser(): void {
  if (!authToken) return;
  void shell.openExternal(`${SERVER_ORIGIN}/auth/session?token=${encodeURIComponent(authToken)}`);
}

let trayIconOk = false;

// Launch at login: auto-started means tray only, no window (the --hidden arg
// on Windows; wasOpenedAtLogin on macOS). Toggle lives in the tray menu and
// is packaged-only: a dev toggle would register the bare electron binary as
// the login item.
function loginItemEnabled(): boolean {
  try {
    // Windows registers WITH args:["--hidden"]; the getter must pass the
    // same args or openAtLogin reads false and the checkbox can never show
    // (or one-click disable) an active registration.
    return app.getLoginItemSettings(process.platform === "win32" ? { args: ["--hidden"] } : {}).openAtLogin;
  } catch {
    return false;
  }
}

function setLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings(
    process.platform === "win32"
      ? { openAtLogin: enabled, args: ["--hidden"] }
      : { openAtLogin: enabled, openAsHidden: true },
  );
}

let trayMenu: Electron.Menu | null = null;

function buildTrayMenu(): Electron.Menu {
  const update = getAvailableUpdate();
  return Menu.buildFromTemplate([
    ...(update
      ? [
          { label: `Update available: v${update.version}`, click: openUpdatePage },
          { type: "separator" as const },
        ]
      : []),
    { label: "Open exxperts", click: showMainWindow },
    { label: "Open in Browser", click: openInBrowser },
    { label: "Health Check", click: () => { void showHealthCheck(mainWindow ?? undefined); } },
    { label: "Check for Updates...", click: () => { void manualUpdateCheck(); } },
    { type: "separator" },
    {
      // Apple's own Dock-menu label for this setting.
      label: "Open at Login",
      type: "checkbox",
      checked: loginItemEnabled(),
      enabled: app.isPackaged,
      click: (item) => setLaunchAtLogin(item.checked),
    },
    { type: "separator" },
    { label: "Quit exxperts", role: "quit" },
  ]);
}

// macOS pops a FRESH menu on every tray click so the Open at Login checkbox
// always reads current OS truth (the Dock menu and System Settings can change
// it out-of-band; a static menu desyncs - field-confirmed). Windows/Linux
// keep a set context menu (no pre-open hook exists there) refreshed on every
// state change.
function refreshTrayMenu(): void {
  if (!tray) return;
  trayMenu = buildTrayMenu();
  if (process.platform !== "darwin") tray.setContextMenu(trayMenu);
}

// User-initiated check with visible feedback; the tray rebuild also
// re-reads the login-item state, curing a stale checkbox in passing.
async function manualUpdateCheck(): Promise<void> {
  const result = await checkForUpdate(app.getVersion());
  refreshTrayMenu();
  if (result === "update") {
    const update = getAvailableUpdate();
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "exxperts",
      message: `exxperts v${update?.version} is available.`,
      detail: "The download opens in your browser; quit exxperts before installing over it.",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) openUpdatePage();
  } else if (result === "none") {
    await dialog.showMessageBox({
      type: "info",
      title: "exxperts",
      message: `You are on the latest version (v${app.getVersion()}).`,
      buttons: ["OK"],
    });
  } else {
    await dialog.showMessageBox({
      type: "warning",
      title: "exxperts",
      message: "Could not reach the update feed.",
      detail: "Check your network connection and try again.",
      buttons: ["OK"],
    });
  }
}

// Tray icon in both states. macOS: flat template glyph (OS inverts black +
// alpha), badge variant from the same generator. Windows/Linux: the brand
// tile (payload favicon, one mark everywhere), badged variant from the
// shell's assets (same composition, same generator).
function trayImage(badged: boolean): Electron.NativeImage {
  if (process.platform === "darwin") {
    const asset = badged ? "tray-template-badge.png" : "tray-template.png";
    let icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", asset));
    if (!icon.isEmpty()) {
      icon = icon.resize({ width: 18, height: 18 });
      icon.setTemplateImage(true);
    }
    return icon;
  }
  if (badged) {
    const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "tray-tile-badge.png"));
    return icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 });
  }
  const brandRoot = path.join(serverRoot(), "apps", "web-ui");
  let icon = nativeImage.createFromPath(path.join(brandRoot, "dist", "brand", "favicon.png"));
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(brandRoot, "public", "brand", "favicon.png"));
  return icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 });
}

// Unread/finished-task dot: set by the page's task-done signal while the
// window cannot be seen, cleared the moment the window is shown or focused.
let trayBadged = false;

function setTrayBadge(on: boolean): void {
  if (!tray || on === trayBadged) return;
  const img = trayImage(on);
  if (img.isEmpty()) return; // never blank the tray for a missing asset
  trayBadged = on;
  tray.setImage(img);
}

function buildTray(): void {
  const icon = trayImage(false);
  trayIconOk = !icon.isEmpty();
  tray = new Tray(icon);
  tray.setToolTip("exxperts");
  refreshTrayMenu();
  if (process.platform === "darwin") {
    const popupFresh = () => {
      trayMenu = buildTrayMenu();
      tray?.popUpContextMenu(trayMenu);
    };
    tray.on("click", popupFresh);
    tray.on("right-click", popupFresh);
  } else {
    tray.on("click", showMainWindow);
  }
}

function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [{
          label: "exxperts",
          submenu: [
            { role: "about" as const },
            { label: "Check for Updates...", click: () => { void manualUpdateCheck(); } },
            { type: "separator" as const },
            { label: "Health Check", click: () => { void showHealthCheck(mainWindow ?? undefined); } },
            { label: "Open in Browser", click: openInBrowser },
            { type: "separator" as const },
            { role: "hide" as const },
            { role: "hideOthers" as const },
            { type: "separator" as const },
            { role: "quit" as const },
          ],
        }]
      : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function confirmTakeover(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "exxperts",
    message: `An exxperts server is already running on port ${PORT}.`,
    detail: "The desktop app runs its own server. Stop the running one and start the app's server? Browser tabs will need a new sign-in link; the app window signs in automatically.",
    buttons: ["Stop it and continue", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

// Server-crash watchdog: an unexpected child death gets ONE quiet automatic
// restart (same state dir, same token file, the page's WebSocket reconnect
// picks the new server up seamlessly); a second crash within the window is a
// real problem and surfaces the log plus the health window instead of a
// crash loop.
const WATCHDOG_RESET_MS = 10 * 60_000;
let watchdogRestarts = 0;
let lastCrashAt = 0;
let smokeWatchdogRestarted = false;
let crashSurfacedAt = 0;

// A crash DURING the restart re-enters handleServerCrash (the new child's
// exit fires the watchdog while waitReady is still throwing) - without the
// cooldown the user gets two log-tail windows and two health windows.
function surfaceCrash(message: string, tail: string): void {
  if (Date.now() - crashSurfacedAt < 5000) return;
  crashSurfacedAt = Date.now();
  showTextWindow("exxperts server stopped", message, tail || "(no server output)");
  void showHealthCheck(mainWindow ?? undefined);
}

async function handleServerCrash(code: number | null, signal: string | null): Promise<void> {
  if (quitting) return;
  const now = Date.now();
  if (now - lastCrashAt > WATCHDOG_RESET_MS) watchdogRestarts = 0;
  lastCrashAt = now;
  watchdogRestarts += 1;
  const summary = `The exxperts server stopped unexpectedly (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""}).`;
  console.error(`[watchdog] ${summary} restart attempt ${watchdogRestarts}`);
  if (watchdogRestarts > 1) {
    surfaceCrash(`${summary} It was restarted once already; not retrying.`, server.logTail());
    return;
  }
  try {
    server.start();
    await server.waitReady(30_000);
    smokeWatchdogRestarted = true;
    console.error("[watchdog] server restarted");
  } catch (err) {
    surfaceCrash(`${summary} The automatic restart failed.`, `${err instanceof Error ? err.message : String(err)}\n\n${server.logTail()}`);
  }
}

async function startupFailed(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const tail = server.logTail();
  if (SMOKE) smokeFail(`${message}\n${tail}`);
  showTextWindow("exxperts could not start", message, tail || "(no server output)");
  void showHealthCheck();
}

async function boot(): Promise<void> {
  const state = await probePort();
  if (state.kind === "exxperts") {
    if (SMOKE) smokeFail(`port ${PORT} already has an exxperts server`);
    if (!(await confirmTakeover())) {
      app.exit(0);
      return;
    }
    await takeOverPort();
  } else if (state.kind === "other") {
    if (SMOKE) smokeFail(`port ${PORT} occupied by ${state.detail}`);
    await dialog.showMessageBox({
      type: "error",
      title: "exxperts",
      message: `Port ${PORT} is in use by another program (${state.detail}).`,
      detail: "Free the port and start exxperts again.",
      buttons: ["Quit"],
    });
    app.exit(1);
    return;
  }

  server.start();
  await server.waitReady();
  authToken = await server.authToken();

  buildTray();
  buildAppMenu();
  // --hidden = explicit (Windows login item, smoke); wasOpenedAtLogin = the
  // macOS login-item signal.
  const startHidden = process.argv.includes("--hidden")
    || (!SMOKE && app.getLoginItemSettings().wasOpenedAtLogin);
  mainWindow = createMainWindow(startHidden);
  onUpdateStateChanged(refreshTrayMenu);
  server.onUnexpectedExit((code, signal) => { void handleServerCrash(code, signal); });
  await mainWindow.loadURL(`${SERVER_ORIGIN}/auth/session?token=${encodeURIComponent(authToken)}`);

  if (SMOKE) await smokeReport();
}

// Automated end-to-end check: prints what the window actually landed on and
// captures a screenshot, then quits cleanly (which also stops the server).
async function smokeReport(): Promise<void> {
  const win = mainWindow;
  if (!win) smokeFail("no window");
  const url = win.webContents.getURL();
  const title = win.getTitle();
  // Boot visibility must be read BEFORE the deep-link exercise below, which
  // legitimately shows a hidden window.
  const hiddenExpected = process.argv.includes("--hidden");
  const bootVisibleOk = hiddenExpected ? !win.isVisible() : win.isVisible();
  const bootWindow = win.isVisible() ? "visible" : "hidden";
  const shot = process.env.EXXPERTS_DESKTOP_SMOKE_SHOT && !process.argv.includes("--hidden")
    ? process.env.EXXPERTS_DESKTOP_SMOKE_SHOT : undefined;
  await new Promise((r) => setTimeout(r, 3500)); // let the SPA render past the redirect
  if (shot) {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(shot, image.toPNG());
  }
  const landedUrl = win.webContents.getURL();
  // Exercise window-state persistence for real: remove any prior file, then
  // resize to bounds the restore path cannot have produced, and require the
  // fresh file to record them (existsSync alone passes vacuously on a stale
  // file, and resizing to the restored bounds fires no event at all).
  const stateFile = path.join(app.getPath("userData"), "window-state.json");
  fs.rmSync(stateFile, { force: true });
  // The target width must differ from the CURRENT width (a restored state
  // from a prior smoke run could equal a fixed target, firing no resize
  // event and leaving the assertion vacuously red).
  const smokeWidth = win.getBounds().width === 1234 ? 1286 : 1234;
  win.setBounds({ x: 80, y: 80, width: smokeWidth, height: 789 });
  await new Promise((r) => setTimeout(r, 1600)); // debounce is 500ms; leave slack for a loaded machine
  let stateOk = false;
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { bounds?: { width?: number } };
    stateOk = saved.bounds?.width === smokeWidth;
  } catch {
    stateOk = false;
  }
  // Exercise the Health Check window end to end too: doctor runs, its output
  // lands in the rendered pre, and the window screenshots alongside the app.
  const healthWin = await showHealthCheck();
  const healthText: unknown = await healthWin.webContents
    .executeJavaScript(`document.querySelector("pre").textContent`)
    .catch(() => "");
  const healthOk = typeof healthText === "string" && healthText.includes("Node");
  if (shot && !healthWin.isDestroyed()) {
    await new Promise((r) => setTimeout(r, 600)); // let the updated DOM paint before capturing
    const healthImage = await healthWin.webContents.capturePage();
    fs.writeFileSync(shot.replace(/\.png$/, "-health.png"), healthImage.toPNG());
  }
  healthWin.close();
  // The drag-region wiring is invisible in screenshots (native traffic
  // lights are window chrome); assert the computed styles instead.
  const dragRegion: string = process.platform !== "darwin" ? "n/a" : await win.webContents
    .executeJavaScript(`(() => {
      const h = document.querySelector(".product-sidebar-header, .sidebar-header");
      if (!h) return "no-header";
      const cs = getComputedStyle(h);
      const strip = document.querySelector(".desktop-drag-strip");
      const ss = strip ? getComputedStyle(strip) : null;
      const stripOk = !!ss && ss.display === "block" && ss.position === "fixed" && ss.webkitAppRegion === "drag" && ss.height === "48px";
      const cls = document.documentElement.className;
      return cls.includes("desktop-app-mac") && cs.webkitAppRegion === "drag" && cs.paddingTop === "56px" && stripOk
        ? "ok" : "fail(" + cls + "|" + cs.webkitAppRegion + "|" + cs.paddingTop + "|strip=" + (ss ? ss.display + "," + ss.webkitAppRegion : "missing") + ")";
    })()`)
    .catch(() => "error");
  const dragOk = dragRegion === "ok" || dragRegion === "n/a";
  // Context menu: select the heading, then deliver a real right-click over
  // it; the handler must have produced at least a copy item.
  await win.webContents.executeJavaScript(
    `(() => { const h = document.querySelector("h1"); if (h) getSelection().selectAllChildren(h); return h ? "sel" : "no-h1"; })()`,
  ).catch(() => undefined);
  win.webContents.sendInputEvent({ type: "mouseDown", x: 450, y: 60, button: "right", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: 450, y: 60, button: "right", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 600));
  const contextOk = smokeContextMenuItems >= 1;
  const spellOk = win.webContents.session.spellCheckerEnabled;
  // Deep-link plumbing: the page navigating to exxperts://focus must be
  // intercepted (handler fires, window URL untouched).
  await win.webContents.executeJavaScript(`window.location.href = "exxperts://focus"; "sent"`).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
  // In a hidden boot the deep link must additionally REVEAL the window (the
  // notification-click path end to end).
  const deepLinkOk = smokeDeepLink && win.webContents.getURL().startsWith(SERVER_ORIGIN) && (!hiddenExpected || win.isVisible());
  const notifPerm: unknown = await win.webContents
    .executeJavaScript(`typeof Notification === "undefined" ? "missing" : Notification.permission`)
    .catch(() => "error");
  const notifOk = notifPerm === "granted";
  const payload = payloadVersion();
  const loginItemPresent = trayMenu?.items.some((i) => i.label === "Open at Login") ?? false;
  // App menu (macOS habit): Check for Updates... and Health Check live next
  // to About, not only in the tray.
  const appSubmenu = Menu.getApplicationMenu()?.items[0]?.submenu;
  const appMenuOk = process.platform !== "darwin"
    || (!!appSubmenu && appSubmenu.items.some((i) => i.label === "Check for Updates...") && appSubmenu.items.some((i) => i.label === "Health Check"));
  // Update notice: the compare logic is asserted as a table (incl. the
  // 0.6.10-vs-0.6.8 numeric case); the live feed result is environmental
  // (none today, update after a newer release ships, error offline) so it is
  // asserted for tray-menu CONSISTENCY, not for a specific value.
  const updateLogicOk =
    isNewerVersion("0.6.8", "0.7.0")
    && isNewerVersion("0.6.8", "v0.6.10")
    && !isNewerVersion("0.6.8", "0.6.8")
    && !isNewerVersion("0.7.0", "0.6.9")
    && !isNewerVersion("0.6.8", "garbage")
    && !isNewerVersion("0.6.8", "0.6.8-rc.1");
  const updateCheck = await checkForUpdate(app.getVersion());
  refreshTrayMenu();
  const updateItemShown = trayMenu?.items.some((i) => i.label.startsWith("Update available")) ?? false;
  let updateConsistent = updateCheck === "update" ? updateItemShown : !updateItemShown;
  // Under the fake-feed smoke mode the positive outcome is REQUIRED, not
  // environmental.
  if (process.env.EXXPERTS_DESKTOP_EXPECT_UPDATE === "1" && updateCheck !== "update") updateConsistent = false;
  // S5 acceptance evidence: EXXPERTS_DESKTOP_SHOT_MATRIX=<dir> captures the
  // sidebar states at 80/100/125% zoom in REAL Electron (zoom via the real
  // webContents zoom factor, clicks via the real input pipeline).
  const matrixDir = process.env.EXXPERTS_DESKTOP_SHOT_MATRIX;
  let matrixFailure: string | null = null;
  if (matrixDir) {
    fs.mkdirSync(matrixDir, { recursive: true });
    // sendInputEvent takes DIP coordinates = CSS px x zoomFactor; the audit
    // proved unscaled clicks MISS the toggle at 80/125% and screenshot the
    // still-expanded page as "collapsed" - silent false evidence. Coords are
    // scaled and every flip is ASSERTED per zoom level; any miss fails the
    // run.
    const collapsedNow = () => win.webContents.executeJavaScript(`document.documentElement.classList.contains("sidebar-collapsed")`).catch(() => null) as Promise<boolean | null>;
    const clickToggleScaled = async (selector: string, zoom: number) => {
      // Faithful to a real mouse: move (sets the hover/dispatch target),
      // then press and release at the same DIP point.
      const rect = await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      ).catch(() => null) as { x: number; y: number } | null;
      if (!rect) return false;
      const x = Math.round(rect.x * zoom);
      const y = Math.round(rect.y * zoom);
      win.webContents.sendInputEvent({ type: "mouseMove", x, y });
      await new Promise((r) => setTimeout(r, 80));
      win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 500));
      return true;
    };
    // One retry absorbs input-synthesis flake; a second miss is a real
    // failure and fails the run.
    const clickToggleAsserted = async (selector: string, zoom: number, expectCollapsed: boolean) => {
      await clickToggleScaled(selector, zoom);
      if (await collapsedNow() === expectCollapsed) return true;
      await clickToggleScaled(selector, zoom);
      return (await collapsedNow()) === expectCollapsed;
    };
    const clearSelection = () => win.webContents.executeJavaScript(`getSelection()?.removeAllRanges(); true`).catch(() => undefined);
    for (const zoom of [0.8, 1, 1.25]) {
      win.webContents.setZoomFactor(zoom);
      await new Promise((r) => setTimeout(r, 600));
      await clearSelection();
      const tag = String(Math.round(zoom * 100));
      fs.writeFileSync(path.join(matrixDir, `app-expanded-${tag}.png`), (await win.webContents.capturePage()).toPNG());
      const collapsedOk = await clickToggleAsserted(".sidebar-toggle:not(.sidebar-toggle-floating)", zoom, true);
      if (!collapsedOk) {
        const debug = await win.webContents.executeJavaScript(`(() => {
          const t = document.querySelector(".sidebar-toggle:not(.sidebar-toggle-floating)");
          const r = t ? t.getBoundingClientRect() : null;
          const at = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
          return JSON.stringify({ found: !!t, rect: r ? [r.x, r.y, r.width, r.height] : null, display: t ? getComputedStyle(t).display : null, atPoint: at ? at.className || at.tagName : null });
        })()`).catch(() => "debug-failed");
        matrixFailure = `collapse missed at ${tag}% ${debug}`;
        break;
      }
      fs.writeFileSync(path.join(matrixDir, `app-collapsed-${tag}.png`), (await win.webContents.capturePage()).toPNG());
      if (!(await clickToggleAsserted(".sidebar-toggle-floating", zoom, false))) { matrixFailure = `expand missed at ${tag}%`; break; }
    }
    win.webContents.setZoomFactor(1);
    await new Promise((r) => setTimeout(r, 400));
    console.log(matrixFailure ? `DESKTOP_SHOT_MATRIX FAILED: ${matrixFailure}` : `DESKTOP_SHOT_MATRIX written to ${matrixDir} (flips asserted at all zoom levels)`);
  }

  // Sidebar toggle through the REAL input pipeline (round-S1 standing rule:
  // synthetic DOM clicks bypass the compositor hit-test, so only
  // sendInputEvent can prove the drag region is not eating the click).
  // Collapse via the in-header toggle, re-expand via the floating affordance.
  const clickAt = async (selector: string) => {
    const rect = await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    ).catch(() => null) as { x: number; y: number } | null;
    if (!rect) return false;
    win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 500));
    return true;
  };
  const isCollapsedNow = () => win.webContents.executeJavaScript(`document.documentElement.classList.contains("sidebar-collapsed")`).catch(() => null) as Promise<boolean | null>;
  let sidebarToggleOk = false;
  if (await clickAt(".sidebar-toggle:not(.sidebar-toggle-floating)")) {
    const collapsedAfterClick = await isCollapsedNow();
    if (collapsedAfterClick === true && await clickAt(".sidebar-toggle-floating")) {
      sidebarToggleOk = (await isCollapsedNow()) === false;
    }
  }

  // End-to-end notification path: hide the window, drive the page's REAL
  // notifyDesktop helper (its gate passes: hidden + granted), and require
  // the tray badge to appear via the exxperts://task-done signal, then
  // clear on reveal. A real OS notification appears briefly during smokes.
  win.hide();
  await new Promise((r) => setTimeout(r, 300));
  const notifyHook: unknown = await win.webContents
    .executeJavaScript(`window.__exxDesktopNotify ? (window.__exxDesktopNotify("Smoke test task", "Task finished."), "called") : "missing"`)
    .catch((err: unknown) => `error:${err instanceof Error ? err.message : String(err)}`);
  await new Promise((r) => setTimeout(r, 600));
  const badgeSet = trayBadged;
  win.show();
  await new Promise((r) => setTimeout(r, 300));
  const badgeCleared = !trayBadged;
  const notifyE2EOk = notifyHook === "called" && badgeSet && badgeCleared;

  // Watchdog: SIGKILL the real server child and require the automatic
  // restart to bring /healthz back. Runs last so a dying server cannot
  // disturb the earlier assertions.
  let watchdogOk = false;
  const killedPid = server.pid;
  if (killedPid) {
    try {
      process.kill(killedPid, "SIGKILL");
    } catch {
      // leave watchdogOk false
    }
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !watchdogOk) {
      // Non-vacuous: the restart flag alone is not enough - the killed pid
      // must be genuinely gone, the handle must hold a NEW pid, and that
      // server must answer (the tsx-wrapper era produced a green from the
      // orphaned OLD server answering healthz).
      if (smokeWatchdogRestarted && !alive(killedPid) && server.pid && server.pid !== killedPid) {
        try {
          const res = await fetch(`${SERVER_ORIGIN}/healthz`, { signal: AbortSignal.timeout(1000) });
          if (res.ok) watchdogOk = true;
        } catch {
          // not back yet
        }
      }
      if (!watchdogOk) await new Promise((r) => setTimeout(r, 300));
    }
  }
  const ok = landedUrl.startsWith(SERVER_ORIGIN) && !landedUrl.includes("token=") && healthOk && trayIconOk && stateOk && dragOk
    && contextOk && spellOk && deepLinkOk && notifOk && payload !== "unknown" && bootVisibleOk && loginItemPresent
    && updateLogicOk && updateConsistent && notifyE2EOk && watchdogOk && appMenuOk && sidebarToggleOk && matrixFailure === null;
  console.log(`DESKTOP_SMOKE ${ok ? "OK" : "FAIL"} url=${landedUrl} initialUrl=${url} title=${title} tray=${tray ? "yes" : "no"} trayIcon=${trayIconOk ? "ok" : "empty"} health=${healthOk ? "ok" : "fail"} windowState=${stateOk ? "ok" : "missing"} dragRegion=${dragRegion} contextMenu=${contextOk ? `ok(${smokeContextMenuItems})` : "none"} spellcheck=${spellOk ? "on" : "off"} deepLink=${deepLinkOk ? "ok" : "fail"} notifications=${String(notifPerm)} payload=${payload} bootWindow=${bootWindow}${hiddenExpected ? "(hidden expected)" : ""} loginItem=${loginItemPresent ? "present" : "missing"} appMenu=${appMenuOk ? "ok" : "fail"} updateLogic=${updateLogicOk ? "ok" : "fail"} updateCheck=${updateCheck}${updateConsistent ? "" : "(tray inconsistent)"} sidebarToggle=${sidebarToggleOk ? "ok" : "fail"}${matrixFailure ? ` matrix=fail(${matrixFailure})` : ""} notifyE2E=${notifyE2EOk ? "ok" : `fail(hook=${String(notifyHook)},badge=${badgeSet ? "set" : "unset"},cleared=${badgeCleared ? "yes" : "no"})`} watchdog=${watchdogOk ? "ok" : "fail"}`);
  if (!ok) process.exitCode = 1;
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // OS-level protocol registration (macOS reads it from Info.plist in the
  // packaged app; this call covers Windows). Packaged only: a dev run would
  // hijack the OS registration with a bare electron binary path, and dev
  // deep links still work through the in-app navigation interception.
  if (app.isPackaged) app.setAsDefaultProtocolClient("exxperts");
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((a) => a.startsWith("exxperts://"));
    if (link) handleDeepLink(link);
    showMainWindow();
  });
  app.on("activate", showMainWindow);
  app.on("window-all-closed", () => {
    // Tray app: closing windows never quits; only Quit does.
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void server.stop().finally(() => app.exit(typeof process.exitCode === "number" ? process.exitCode : 0));
  });
  void app.whenReady().then(() => boot().catch(startupFailed));
}
