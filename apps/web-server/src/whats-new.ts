import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

/**
 * The one-time What's new window after an update.
 *
 * The app already knows what changed, because the changelog ships inside the
 * package next to package.json; what was missing was the moment where the
 * person who just updated gets told. This module owns that moment's facts:
 * which version is running, what its changelog section says, and which
 * version was last acknowledged. The rule that makes it one-time and
 * fresh-install-silent lives in resolveWhatsNew. A missing record alone does
 * not mean a fresh install: everyone updating into the first version that
 * carries this feature has no record either, so the module looks for state
 * that only using the app leaves behind to tell the two apart. A truly fresh
 * machine records quietly; an existing one gets its window, and only a
 * dismissal (or a sectionless changelog) records.
 *
 * The acknowledged version persists in ~/.exxperts/app/whats-new.json, the
 * same shape of tiny document as web-search.json next door, written the same
 * atomic way.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same three-steps-up resolution index.ts uses for REPO_ROOT: from this
// source file's directory, apps/web-server/src, three levels up is the repo
// checkout in development and the package root when installed, and both keep
// package.json and CHANGELOG.md side by side at that level (the npm "files"
// list ships apps/web-server/src as source, so the layout never diverges).
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..");

const FILE_NAME = "whats-new.json";

export function whatsNewStatePath(): string {
	return productAppStatePath(FILE_NAME);
}

/**
 * Whether this machine was an exxperts installation before this process ran.
 * Needed because a missing whats-new.json is ambiguous: it marks a fresh
 * install only from the version that introduced this file onward, and every
 * machine updating into that version arrives without one. The markers are
 * state that only using the app creates and that server startup never does
 * (boot makes just the state root, the empty agents/ and skills/ dirs, and
 * the dot-led .mcp-grants-migration.json stamp inside personalized-agents;
 * the usage reconcile writes nothing when there are no rooms):
 * personalized-agents/ gains a room directory when a room is created (room
 * ids are [a-zA-Z0-9_-], so boot's dot-led stamp is skipped), usage.jsonl
 * appears once any model turn has run, and persistent-agent-ai-profile.json
 * once a provider profile was picked in AI setup. Any one of them proves
 * prior life; a genuinely fresh home has none of them at the moment the
 * first /api/whats-new fetch arrives. Deliberately cheap: two existsSync
 * calls and at most one readdir of the rooms directory.
 */
export function hasPriorInstallationState(): boolean {
	if (fs.existsSync(productAppStatePath("usage.jsonl"))) return true;
	if (fs.existsSync(productAppStatePath("persistent-agent-ai-profile.json"))) return true;
	try {
		return fs.readdirSync(productAppStatePath("personalized-agents")).some((entry) => !entry.startsWith("."));
	} catch {
		return false;
	}
}

export function readAppVersion(packageRoot: string = PACKAGE_ROOT): string | null {
	try {
		const raw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf8");
		const version = (JSON.parse(raw) as { version?: unknown }).version;
		return typeof version === "string" && version.trim() ? version.trim() : null;
	} catch {
		return null;
	}
}

export function readChangelog(packageRoot: string = PACKAGE_ROOT): string | null {
	try {
		return fs.readFileSync(path.join(packageRoot, "CHANGELOG.md"), "utf8");
	} catch {
		return null;
	}
}

/**
 * The bullets under `## <version> ...`, without their leading "- ", or null
 * when the changelog has no section for that version. A bullet in this file
 * is one long markdown paragraph; a wrapped continuation line joins its
 * bullet with a space so a future hand-wrapped entry still reads as one.
 */
export function parseChangelogEntries(markdown: string, version: string): string[] | null {
	const lines = markdown.split(/\r?\n/);
	let inSection = false;
	let found = false;
	const entries: string[] = [];
	for (const line of lines) {
		const heading = /^##\s+(\S+)/.exec(line);
		if (heading) {
			if (inSection) break;
			inSection = heading[1] === version;
			if (inSection) found = true;
			continue;
		}
		if (!inSection) continue;
		if (/^-\s+/.test(line)) {
			entries.push(line.replace(/^-\s+/, "").trim());
		} else if (line.trim() && entries.length > 0) {
			entries[entries.length - 1] = `${entries[entries.length - 1]} ${line.trim()}`;
		}
	}
	return found ? entries : null;
}

/**
 * Plain numeric dotted comparison, enough for this package's x.y.z versions.
 * Anything that does not parse as numbers compares equal, which errs toward
 * not showing a window rather than showing one twice.
 */
export function compareVersions(a: string, b: string): number {
	const parse = (value: string): number[] => value.split(".").map((part) => {
		const n = Number.parseInt(part, 10);
		return Number.isFinite(n) ? n : 0;
	});
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const l = left[i] ?? 0;
		const r = right[i] ?? 0;
		if (l !== r) return l < r ? -1 : 1;
	}
	return 0;
}

export function readAcknowledgedVersion(): string | null {
	try {
		const raw = fs.readFileSync(whatsNewStatePath(), "utf8");
		const version = (JSON.parse(raw) as { acknowledgedVersion?: unknown }).acknowledgedVersion;
		return typeof version === "string" && version.trim() ? version.trim() : null;
	} catch {
		// Missing file and unreadable file both read as "no record": the worst
		// this can do is record the current version and stay quiet, never show
		// a window that was already dismissed twice in a row.
		return null;
	}
}

export function recordAcknowledgedVersion(version: string): void {
	const filePath = whatsNewStatePath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify({ acknowledgedVersion: version }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
}

export type WhatsNewPayload = { version: string; entries: string[] | null; show: boolean };

/**
 * What the window should do right now. Reading this can write: a genuinely
 * fresh install records the current version on the spot, and so does an
 * update whose changelog has nothing to say, because an empty window helps
 * nobody and the next update should count from here. A machine with no
 * record but with prior installation state is an update into the first
 * version that carries this feature: it gets the window and records only on
 * dismissal, like any other update.
 */
export function resolveWhatsNew(packageRoot: string = PACKAGE_ROOT): WhatsNewPayload {
	const version = readAppVersion(packageRoot);
	if (!version) return { version: "", entries: null, show: false };
	const acknowledged = readAcknowledgedVersion();
	if (acknowledged === null && !hasPriorInstallationState()) {
		recordAcknowledgedVersion(version);
		return { version, entries: null, show: false };
	}
	if (acknowledged !== null && compareVersions(acknowledged, version) >= 0) {
		return { version, entries: null, show: false };
	}
	const changelog = readChangelog(packageRoot);
	const entries = changelog === null ? null : parseChangelogEntries(changelog, version);
	if (!entries || entries.length === 0) {
		recordAcknowledgedVersion(version);
		return { version, entries: null, show: false };
	}
	return { version, entries, show: true };
}

/** The seen POST: recording the current version again is a no-op by shape. */
export function acknowledgeWhatsNew(packageRoot: string = PACKAGE_ROOT): void {
	const version = readAppVersion(packageRoot);
	if (version) recordAcknowledgedVersion(version);
}
