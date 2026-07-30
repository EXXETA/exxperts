// One-click install layer over electron-updater, USER-INITIATED ONLY: nothing
// here runs until the user has clicked "Check for Updates..." and then chosen
// "Install and restart". autoDownload and autoInstallOnAppQuit stay off, no
// timers exist, and the no-telemetry story stays true: the feed is contacted
// only inside a user-initiated flow.
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

// electron-updater's own feed check (it must run before downloadUpdate). The
// version-compare hardening from update-check.ts applies on top: a feed whose
// version is unparseable or not strictly newer is never "available".
export async function checkViaUpdater(currentVersion: string): Promise<UpdaterCheck> {
  configure();
  try {
    const result = await autoUpdater.checkForUpdates();
    const raw = result?.updateInfo?.version ?? "";
    if (!isNewerVersion(currentVersion, raw)) return { status: "none" };
    const version = parseTriple(raw);
    if (!version) return { status: "none" };
    return { status: "available", version };
  } catch {
    return { status: "error" };
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
  const check = await checkViaUpdater(currentVersion);
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
