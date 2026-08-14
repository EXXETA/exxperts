// One-click install layer over electron-updater: nothing here downloads or
// installs anything until the user has chosen "Install and restart".
// autoDownload and autoInstallOnAppQuit stay off and no timers exist. The
// only unattended network call in the app is the single anonymous version
// check the shell runs once at startup (update-check.ts); everything in this
// file waits for a click, so the no-telemetry story stays true.
//
// Trust boundary, same stance as update-check.ts: the feed is input, not
// authority. electron-updater verifies the download against the sha512 in the
// signed release's metadata; everything WE render (dialog text, progress
// heading) is derived from a parsed numeric version triple, never from feed
// strings. A feed whose version does not parse to a strictly newer triple is
// treated as an error, never installed.
//
// What can one-click update: the Windows NSIS install (updates via the setup
// exe) and both macOS installs (dmg and zip both land the same .app; updates
// arrive via the zip target, which is why Squirrel.Mac requires the build to
// be signed). What cannot: the Windows portable zip (no installer to re-run;
// detected by the NSIS uninstaller's absence next to the exe) and unpackaged
// dev runs - both keep the manual open-the-release-page path, as does any
// updater error.
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { autoUpdater, CancellationToken } from "electron-updater";
import { isNewerVersion } from "./update-check";

const FEED_OVERRIDE = process.env.EXXPERTS_DESKTOP_UPDATE_FEED;

let configured = false;

function configure(): void {
  if (configured) return;
  configured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableWebInstaller = true;
  // Field failures used to be invisible: a blocked proxy or a rejected
  // signature left only a silent fallback dialog. electron-updater's own log
  // lines go to the shell's stdout/stderr, where the Health Check and a
  // terminal run can both see them.
  autoUpdater.logger = console;
  if (FEED_OVERRIDE && FEED_OVERRIDE.trim()) {
    // The same test override the version check honors: a generic feed serving
    // latest.yml / latest-mac.yml plus the artifacts, so the full download +
    // install flow can be exercised against a locally hosted build.
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: "generic", url: FEED_OVERRIDE.trim() });
  }
}

// Smoke hook: repoint the feed to exercise the error path without touching
// the module's real configuration logic.
export function smokeSetFeed(url: string): void {
  configure();
  autoUpdater.setFeedURL({ provider: "generic", url });
}

export type UpdaterAvailability = "ok" | "portable" | "dev";

export function updaterAvailability(): UpdaterAvailability {
  if (!app.isPackaged && !(FEED_OVERRIDE && FEED_OVERRIDE.trim())) return "dev";
  if (process.platform === "win32" && app.isPackaged) {
    // Only an NSIS-installed app can re-run an installer; a portable-zip
    // extraction has no uninstaller next to the exe.
    const dir = path.dirname(process.execPath);
    const hasUninstaller = fs.readdirSync(dir).some((f) => /^uninstall .*\.exe$/i.test(f));
    if (!hasUninstaller) return "portable";
  }
  return "ok";
}

// The policy in one assertable place: anything but a supported install
// variant falls back to the manual browser download.
export function installPlan(availability: UpdaterAvailability): "one-click" | "manual" {
  return availability === "ok" ? "one-click" : "manual";
}

function parseTriple(v: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

export type UpdaterCheck =
  | { status: "available"; version: string }
  | { status: "none" }
  | { status: "error" };

// A blocked proxy makes electron-updater's check hang with no deadline of its
// own, which is what "the update takes forever" looked like from the outside.
// A bounded wait turns that into a visible error and the manual fallback.
const CHECK_TIMEOUT_MS = 15_000;
// How long a check stays usable for the download that follows it. The
// download needs electron-updater to have checked in this process; repeating
// the request one click later only added a second round trip to the feed.
const CHECK_FRESH_MS = 60_000;

let lastCheck: { at: number; result: UpdaterCheck } | null = null;

// electron-updater's own feed check (it must run before downloadUpdate). The
// version-compare hardening from update-check.ts applies on top: a feed whose
// version is unparseable or not strictly newer is never "available".
export async function checkViaUpdater(currentVersion: string): Promise<UpdaterCheck> {
  configure();
  const result = await runCheck(currentVersion);
  lastCheck = { at: Date.now(), result };
  return result;
}

async function runCheck(currentVersion: string): Promise<UpdaterCheck> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CHECK_TIMEOUT_MS); });
    const result = await Promise.race([autoUpdater.checkForUpdates(), timeout]);
    if (result === null) return { status: "error" }; // the feed never answered
    const raw = result?.updateInfo?.version ?? "";
    if (!isNewerVersion(currentVersion, raw)) return { status: "none" };
    const version = parseTriple(raw);
    if (!version) return { status: "none" };
    return { status: "available", version };
  } catch {
    return { status: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type DownloadOutcome = "ready" | "cancelled" | "error";

// Downloads the update (checksum-verified by electron-updater against the
// feed metadata). onProgress reports honest numbers for the progress window;
// registerCancel hands the caller a way to abort (closing the window).
export async function downloadUpdate(
  currentVersion: string,
  hooks: { onProgress: (percent: number, transferredBytes: number, totalBytes: number) => void; registerCancel: (cancel: () => void) => void },
): Promise<DownloadOutcome> {
  // Reuse the check the caller just made (the offer dialog cannot appear
  // without one); only a stale or missing result costs another round trip.
  const fresh = lastCheck && Date.now() - lastCheck.at < CHECK_FRESH_MS ? lastCheck.result : null;
  const check = fresh ?? await checkViaUpdater(currentVersion);
  if (check.status !== "available") return "error";
  const token = new CancellationToken();
  hooks.registerCancel(() => token.cancel());
  const onProgress = (p: { percent: number; transferred: number; total: number }) => {
    hooks.onProgress(p.percent, p.transferred, p.total);
  };
  autoUpdater.on("download-progress", onProgress);
  try {
    await autoUpdater.downloadUpdate(token);
    return "ready";
  } catch {
    return token.cancelled ? "cancelled" : "error";
  } finally {
    autoUpdater.off("download-progress", onProgress);
  }
}

// Quits and installs the verified download; the caller stops the server child
// first and clears the way through the shell's quit interception.
export function quitAndInstallNow(): void {
  autoUpdater.quitAndInstall(false, true);
}
