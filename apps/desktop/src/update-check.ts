// Update notice (pre-auto-update bridge), USER-INITIATED ONLY: the check
// runs when the user picks "Check for Updates..." or opens the Health Check
// window - nothing polls in the background, so the no-telemetry story stays
// true. When the feed's latest release is newer than this build, the tray
// gains a Download entry and the health window a download line.
//
// Trust boundary: the feed is input, not authority. Nothing from the feed is
// ever rendered or opened directly - the version is parsed to a numeric
// triple and both the label and the release URL are derived from that triple
// alone (a hostile feed, or one injected via the EXXPERTS_DESKTOP_UPDATE_FEED
// test override, can neither place text in the tray nor hand file:// links
// to the OS opener).
import { shell } from "electron";

const FEED_URL = process.env.EXXPERTS_DESKTOP_UPDATE_FEED
  || "https://api.github.com/repos/EXXETA/exxperts/releases/latest";
const RELEASE_PAGE_BASE = "https://github.com/EXXETA/exxperts/releases/tag";

export type AvailableUpdate = { version: string; url: string };

let available: AvailableUpdate | null = null;
let stateChanged: (() => void) | null = null;

export function getAvailableUpdate(): AvailableUpdate | null {
  return available;
}

// The shell registers its tray rebuild here; fired when a check finds an
// update (health.ts also triggers checks and must not import the shell).
export function onUpdateStateChanged(fn: () => void): void {
  stateChanged = fn;
}

function parseTriple(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Numeric triple compare; prerelease suffixes are ignored. Unparseable input
// is never "newer" - a garbage feed must not produce an update banner.
export function isNewerVersion(current: string, latest: string): boolean {
  const a = parseTriple(current);
  const b = parseTriple(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true;
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false;
  }
  return false;
}

export async function checkForUpdate(currentVersion: string): Promise<"update" | "none" | "error"> {
  try {
    const res = await fetch(FEED_URL, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/vnd.github+json", "user-agent": "exxperts-desktop" },
    });
    if (!res.ok) return "error";
    const body = (await res.json()) as { tag_name?: unknown; prerelease?: unknown; draft?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    if (!tag || body.prerelease === true || body.draft === true) return "none";
    if (!isNewerVersion(currentVersion, tag)) return "none";
    const triple = parseTriple(tag);
    if (!triple) return "none";
    const version = `${triple[0]}.${triple[1]}.${triple[2]}`;
    available = { version, url: `${RELEASE_PAGE_BASE}/v${version}` };
    stateChanged?.();
    return "update";
  } catch {
    return "error"; // offline is a valid state; stay quiet
  }
}

export function openUpdatePage(): void {
  if (available) void shell.openExternal(available.url);
}
