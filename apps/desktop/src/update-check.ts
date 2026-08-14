// Update notice (the check layer; updater.ts does one-click installs). One
// anonymous version check runs once at startup; after that the check only
// runs when the user picks "Check for Updates..." or opens the Health Check
// window. Nothing polls on a timer and nothing but the version request leaves
// the machine, so the no-telemetry story stays true. When the feed's latest
// release is newer than this build, the tray gains an update entry, the
// health window a download line, and the app window a settings-menu notice.
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
const stateListeners: Array<() => void> = [];

export function getAvailableUpdate(): AvailableUpdate | null {
  return available;
}

// What the app window needs to render its own notice, in one object: the
// version offered (null when there is nothing to offer) and the build the
// user is running. Both are plain version strings; the available one comes
// from the parsed numeric triple, never from raw feed text.
export type UpdateSnapshot = { available: string | null; current: string };

export function getUpdateSnapshot(currentVersion: string): UpdateSnapshot {
  return { available: available?.version ?? null, current: currentVersion };
}

// More than one consumer now: the tray rebuild and the push into the app
// window, both registered by the shell (health.ts also triggers checks and
// must not import the shell). A single slot would have silently replaced one
// with the other.
export function onUpdateStateChanged(fn: () => void): void {
  stateListeners.push(fn);
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
    for (const listener of stateListeners) listener();
    return "update";
  } catch {
    return "error"; // offline is a valid state; stay quiet
  }
}

export function openUpdatePage(): void {
  if (available) void shell.openExternal(available.url);
}
