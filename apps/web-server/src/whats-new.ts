import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

/**
 * People skip updates, so the window shows every release since the one this
 * machine last acknowledged.
 *
 * The acknowledged version persists in ~/.exxperts/app/whats-new.json, the
 * same shape of tiny document as web-search.json next door, written the same
 * atomic way.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same resolution index.ts uses for REPO_ROOT: EXXETA_HOME when the launcher
// names the install root, else three levels up from this file's directory
// (apps/web-server/src, or apps/web-server/dist for the bundled server), which
// is the repo checkout in development and the package root when installed;
// both keep package.json and CHANGELOG.md side by side at that level.
const PACKAGE_ROOT = process.env.EXXETA_HOME ? path.resolve(process.env.EXXETA_HOME) : path.resolve(__dirname, "..", "..", "..");

const FILE_NAME = "whats-new.json";

// A record without this marker was written when patch updates passed unseen,
// so it vouches only for its line's x.y.0.
const RULE = "every-release";

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

export type WhatsNewRelease = { version: string; date: string | null; entries: string[] };

/** A bullet is one markdown paragraph: a wrapped line joins its bullet. */
export function parseChangelogReleases(markdown: string): WhatsNewRelease[] {
	const releases: WhatsNewRelease[] = [];
	let current: WhatsNewRelease | null = null;
	for (const line of markdown.split(/\r?\n/)) {
		if (line.startsWith("#")) {
			const heading = /^##\s+(\d+\.\d+\.\d+)(?=\s|$)(?:\s+\((\d{4}-\d{2}-\d{2})\))?/.exec(line);
			const fresh = heading !== null && !releases.some((release) => release.version === heading[1]);
			current = fresh ? { version: heading[1], date: heading[2] ?? null, entries: [] } : null;
			if (current) releases.push(current);
		} else if (current && /^-\s+/.test(line)) {
			current.entries.push(line.replace(/^-\s+/, "").trim());
		} else if (current && line.trim() && current.entries.length > 0) {
			current.entries[current.entries.length - 1] += ` ${line.trim()}`;
		}
	}
	return releases;
}

/** Numeric x.y.z comparison; a part that is not a number reads as 0. */
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

export function minorBase(version: string): string {
	const parts = version.split(".").map((part) => {
		const n = Number.parseInt(part, 10);
		return Number.isFinite(n) ? n : 0;
	});
	return `${parts[0] ?? 0}.${parts[1] ?? 0}.0`;
}

function readAcknowledgement(): { version: string; everyRelease: boolean } | null {
	try {
		const record = JSON.parse(fs.readFileSync(whatsNewStatePath(), "utf8")) as { acknowledgedVersion?: unknown; rule?: unknown };
		const version = typeof record.acknowledgedVersion === "string" ? record.acknowledgedVersion.trim() : "";
		return /^\d+\.\d+\.\d+$/.test(version) ? { version, everyRelease: record.rule === RULE } : null;
	} catch {
		return null;
	}
}

export function recordAcknowledgedVersion(version: string): void {
	const filePath = whatsNewStatePath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify({ acknowledgedVersion: version, rule: RULE }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
}

export type WhatsNewSections = { major: WhatsNewRelease[]; minor: WhatsNewRelease[] };

export type WhatsNewPayload = { version: string; sections: WhatsNewSections | null; show: boolean };

/**
 * Reading can write: a fresh install, or an update with nothing to show,
 * records the running version so the next update counts from here.
 */
export function resolveWhatsNew(packageRoot: string = PACKAGE_ROOT): WhatsNewPayload {
	const version = readAppVersion(packageRoot);
	if (!version) return { version: "", sections: null, show: false };
	const acknowledged = readAcknowledgement();
	if (acknowledged === null && !hasPriorInstallationState()) {
		recordAcknowledgedVersion(version);
		return { version, sections: null, show: false };
	}
	if (acknowledged !== null && compareVersions(acknowledged.version, version) >= 0) {
		return { version, sections: null, show: false };
	}
	// No record on a machine in use: an update from before this window
	// existed, from a version nobody knows, so the running line tells its story.
	const unseen = (release: string): boolean => acknowledged === null
		? compareVersions(release, minorBase(version)) >= 0
		: compareVersions(release, acknowledged.everyRelease ? acknowledged.version : minorBase(acknowledged.version)) > 0;
	const changelog = readChangelog(packageRoot);
	if (changelog === null) return { version, sections: null, show: false };
	const releases = parseChangelogReleases(changelog)
		.filter((release) => release.entries.length > 0 && unseen(release.version) && compareVersions(release.version, version) <= 0);
	if (releases.length === 0) {
		recordAcknowledgedVersion(version);
		return { version, sections: null, show: false };
	}
	const isMajor = (release: WhatsNewRelease): boolean => minorBase(release.version) === release.version;
	return {
		version,
		sections: {
			major: releases.filter(isMajor).sort((a, b) => compareVersions(a.version, b.version)),
			minor: releases.filter((release) => !isMajor(release)).sort((a, b) => compareVersions(b.version, a.version)),
		},
		show: true,
	};
}

/** The seen POST: recording the current version again is a no-op by shape. */
export function acknowledgeWhatsNew(packageRoot: string = PACKAGE_ROOT): void {
	const version = readAppVersion(packageRoot);
	if (version) recordAcknowledgedVersion(version);
}
