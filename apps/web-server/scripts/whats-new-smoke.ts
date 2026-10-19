// What's new after an update: what the window shows, and when it records.
//
// Run: node scripts/run-smokes.mjs whats-new

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { deepStrictEqual } from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, freePort, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";

// The record lives in the app state folder: isolate it before the module
// (and the state-path helper it uses) is loaded.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-whats-new-"));
const tempHome = path.join(tempRoot, "home");
fs.mkdirSync(tempHome, { recursive: true });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
delete process.env.EXXPERTS_STATE_HOME;

const {
	acknowledgeWhatsNew,
	compareVersions,
	hasPriorInstallationState,
	minorBase,
	parseChangelogReleases,
	recordAcknowledgedVersion,
	resolveWhatsNew,
	whatsNewStatePath,
} = await import("../src/whats-new.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, label: string): void {
	try {
		deepStrictEqual(actual, expected);
	} catch {
		throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

const failures: string[] = [];
async function check(label: string, run: () => void | Promise<void>): Promise<void> {
	try {
		await run();
		console.log(`  ok  ${label}`);
	} catch (error) {
		failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		console.log(`  FAIL ${label}`);
	}
}

// Pinned literals, never built by the code under test.
const CHANGELOG = [
	"# Changelog",
	"",
	"Prose above the first section is not an entry.",
	"",
	"## 0.14.5 (2026-10-25)",
	"",
	"- Fixed: the next patch.",
	"",
	"## 0.14.4 (2026-10-19)",
	"",
	"- Rooms: a patch bullet",
	"  that wraps onto a continuation line.",
	"- Fixed: a second patch bullet.",
	"",
	"## 0.14.3 (2026-10-15)",
	"",
	"- Memory: the third patch.",
	"",
	"## 0.14.2 (2026-10-07)",
	"",
	"- Memorize: the second patch.",
	"",
	"## 0.14.1 (2026-10-02)",
	"",
	"- Desktop: the first patch.",
	"",
	"## 0.14.0 (2026-09-28)",
	"",
	"- Models: the big release's headline. Its second sentence stays in the notes.",
	"- Home: its second bullet.",
	"",
	"## 0.13.2 (2026-09-23)",
	"",
	"- Models: the older line's last patch.",
	"",
	"## 0.13.1 (2026-09-23)",
	"",
	"- Models: the older line's first patch.",
	"",
	"## 0.13.0 (2026-09-21)",
	"",
	"- Memory: the older line's big release.",
	"",
	"## 0.12.2 (2026-09-16)",
	"",
	"- Memory: a release this machine already saw.",
	"",
].join("\n");
const WITHOUT_0142_BULLETS = CHANGELOG.replace("- Memorize: the second patch.\n", "");
// The record as the earlier rule wrote it, before patches were shown.
const OLD_FORMAT_RECORD = (version: string) => `${JSON.stringify({ acknowledgedVersion: version }, null, 2)}\n`;

type Release = { version: string; date: string | null; entries: string[] };
type Sections = { major: Release[]; minor: Release[] };
type Payload = { version: string; show: boolean; sections?: Sections | null };

const R0140: Release = { version: "0.14.0", date: "2026-09-28", entries: ["Models: the big release's headline. Its second sentence stays in the notes.", "Home: its second bullet."] };
const R0141: Release = { version: "0.14.1", date: "2026-10-02", entries: ["Desktop: the first patch."] };
const R0142: Release = { version: "0.14.2", date: "2026-10-07", entries: ["Memorize: the second patch."] };
const R0143: Release = { version: "0.14.3", date: "2026-10-15", entries: ["Memory: the third patch."] };
const R0144: Release = { version: "0.14.4", date: "2026-10-19", entries: ["Rooms: a patch bullet that wraps onto a continuation line.", "Fixed: a second patch bullet."] };
const R0130: Release = { version: "0.13.0", date: "2026-09-21", entries: ["Memory: the older line's big release."] };
const R0131: Release = { version: "0.13.1", date: "2026-09-23", entries: ["Models: the older line's first patch."] };
const R0132: Release = { version: "0.13.2", date: "2026-09-23", entries: ["Models: the older line's last patch."] };

// The page checks below render these same payloads.
const TWO_MAJORS: Payload = { version: "0.14.3", show: true, sections: { major: [R0130, R0140], minor: [R0143, R0142, R0141, R0132, R0131] } };
const PATCH_ONLY: Payload = { version: "0.14.4", show: true, sections: { major: [], minor: [R0144, R0143, R0142, R0141] } };
const ACROSS_A_LINE: Payload = { version: "0.14.4", show: true, sections: { major: [R0140], minor: [R0144, R0143, R0142, R0141, R0132, R0131] } };

const packageRoot = path.join(tempRoot, "package-root");
fs.mkdirSync(packageRoot, { recursive: true });
const usageLog = path.join(tempHome, ".exxperts", "app", "usage.jsonl");

/** This machine runs `version`, with `changelog` shipped beside it. */
function install(version: string, changelog: string = CHANGELOG): void {
	fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "x", version })}\n`);
	fs.writeFileSync(path.join(packageRoot, "CHANGELOG.md"), changelog);
}

/** A clean state folder, with or without the trace that using the app leaves. */
function machine(used: boolean): void {
	fs.rmSync(path.join(tempHome, ".exxperts"), { recursive: true, force: true });
	if (used) {
		fs.mkdirSync(path.dirname(usageLog), { recursive: true });
		fs.writeFileSync(usageLog, "");
	}
}

function recorded(): string | null {
	try {
		return (JSON.parse(fs.readFileSync(whatsNewStatePath(), "utf8")) as { acknowledgedVersion?: string }).acknowledgedVersion ?? null;
	} catch {
		return null;
	}
}

function resolve(): Payload {
	return resolveWhatsNew(packageRoot) as Payload;
}

function versionsOf(payload: Payload): { major: string[]; minor: string[] } {
	const of = (releases: Release[] | undefined): string[] => (releases ?? []).map((release) => release.version);
	return { major: of(payload.sections?.major), minor: of(payload.sections?.minor) };
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let ranParts = "the module and the page markup; the real page skipped (Chromium not installed)";

try {
	assert(whatsNewStatePath().startsWith(tempHome), "the record must live in the throwaway home");

	await check("the changelog parses into releases with their version, date and bullets", () => {
		const releases = parseChangelogReleases(`${CHANGELOG}\n## Unreleased\n\n- Not a release.\n`) as Release[];
		same(releases.map((release) => release.version), ["0.14.5", "0.14.4", "0.14.3", "0.14.2", "0.14.1", "0.14.0", "0.13.2", "0.13.1", "0.13.0", "0.12.2"], "every versioned section, in file order, and nothing else");
		const patch = releases.find((release) => release.version === "0.14.4");
		same(patch?.date, "2026-10-19", "the date in the heading");
		same(patch?.entries, ["Rooms: a patch bullet that wraps onto a continuation line.", "Fixed: a second patch bullet."], "bullets lose their dash and a wrapped bullet reads as one");
		same(releases[releases.length - 1]?.entries, ["Memory: a release this machine already saw."], "the last section reads to the end of the file");
		same((parseChangelogReleases(WITHOUT_0142_BULLETS) as Release[]).find((release) => release.version === "0.14.2")?.entries, [], "a section without bullets has none");
		assert(compareVersions("0.9.3", "0.10.0") < 0 && compareVersions("1.0.0", "0.10.0") > 0 && compareVersions("0.10.0", "0.10.0") === 0, "versions compare as numbers");
		assert(minorBase("0.10.1") === "0.10.0" && minorBase("1.2.3") === "1.2.0", "a version's line starts at its x.y.0");
	});

	await check("any heading ends a release, and a repeated version keeps its first section", () => {
		const releases = parseChangelogReleases([
			"## 0.14.1 (2026-10-02)",
			"",
			"- Desktop: the first patch.",
			"### Added",
			"- Stray: under a smaller heading.",
			"##0.14.2",
			"- Stray: under a mistyped heading.",
			"## 0.14.1 (2026-10-03)",
			"- Stray: in a repeated section.",
			"",
		].join("\n"));
		same(releases, [{ version: "0.14.1", date: "2026-10-02", entries: ["Desktop: the first patch."] }], "only the first section's own bullets");
	});

	await check("a fresh install is quiet, and its first patch update shows that patch alone", () => {
		machine(false);
		// Boot stamps a dot-led marker among the rooms on a fresh install too.
		const rooms = path.join(tempHome, ".exxperts", "app", "personalized-agents");
		fs.mkdirSync(rooms, { recursive: true });
		fs.writeFileSync(path.join(rooms, ".mcp-grants-migration.json"), "{}\n");
		assert(hasPriorInstallationState() === false, "a home with only boot's stamps reads as a fresh install");
		install("0.14.4");
		const fresh = resolve();
		assert(fresh.show === false && !fresh.sections, `a fresh install shows nothing, got ${JSON.stringify(fresh)}`);
		same(recorded(), "0.14.4", "a fresh install records the running version on the spot");
		assert(resolve().show === false, "the same version stays quiet");
		install("0.14.5");
		same(versionsOf(resolve()), { major: [], minor: ["0.14.5"] }, "the next patch shows only itself");
	});

	await check("a patch update shows its own section, until it is seen", () => {
		machine(true);
		install("0.14.4");
		recordAcknowledgedVersion("0.14.3");
		same(resolve(), { version: "0.14.4", show: true, sections: { major: [], minor: [R0144] } }, "the patch alone, under Minor releases");
		same(recorded(), "0.14.3", "showing records nothing");
		assert(resolve().show === true, "an unseen window survives a reload");
		acknowledgeWhatsNew(packageRoot);
		same(recorded(), "0.14.4", "seen records the running version");
		assert(resolve().show === false, "a seen version never shows again");
	});

	await check("two missed majors read oldest first, and every missed patch reads newest first", () => {
		machine(true);
		install("0.14.3");
		recordAcknowledgedVersion("0.12.2");
		same(resolve(), TWO_MAJORS, "the skipped run");
	});

	await check("a patch-only update from 0.14.3 shows the patches since 0.14.0, newest first, and no major", () => {
		machine(true);
		install("0.14.4");
		fs.mkdirSync(path.dirname(whatsNewStatePath()), { recursive: true });
		fs.writeFileSync(whatsNewStatePath(), OLD_FORMAT_RECORD("0.14.3"));
		same(resolve(), PATCH_ONLY, "the patch-only update");
	});

	await check("an update across a line, from 0.13.2 to 0.14.4, puts 0.14.0 under majors and the patches newest first", () => {
		machine(true);
		install("0.14.4");
		fs.mkdirSync(path.dirname(whatsNewStatePath()), { recursive: true });
		fs.writeFileSync(whatsNewStatePath(), OLD_FORMAT_RECORD("0.13.2"));
		same(resolve(), ACROSS_A_LINE, "the update across a line");
	});

	await check("when a line's x.y.0 was seen, only the missed patches show", () => {
		machine(true);
		install("0.14.1");
		recordAcknowledgedVersion("0.13.1");
		same(versionsOf(resolve()), { major: ["0.14.0"], minor: ["0.14.1", "0.13.2"] }, "the sections");
	});

	await check("an empty section is skipped, and a run with nothing to say records quietly", () => {
		machine(true);
		install("0.14.3", WITHOUT_0142_BULLETS);
		recordAcknowledgedVersion("0.14.1");
		same(versionsOf(resolve()), { major: [], minor: ["0.14.3"] }, "the empty release has no row");
		install("0.14.2", WITHOUT_0142_BULLETS);
		const empty = resolve();
		assert(empty.show === false, `nothing to say shows nothing, got ${JSON.stringify(empty)}`);
		same(recorded(), "0.14.2", "and records, so the next update counts from here");
	});

	await check("an old-format record at 0.14.3 shows 0.14.1 onward once, and then never again", () => {
		machine(true);
		install("0.14.4");
		fs.mkdirSync(path.dirname(whatsNewStatePath()), { recursive: true });
		fs.writeFileSync(whatsNewStatePath(), OLD_FORMAT_RECORD("0.14.3"));
		same(versionsOf(resolve()), { major: [], minor: ["0.14.4", "0.14.3", "0.14.2", "0.14.1"] }, "the patches that passed quietly, and the running one");
		same(recorded(), "0.14.3", "the catch-up records nothing until seen");
		acknowledgeWhatsNew(packageRoot);
		assert(resolve().show === false, "once seen, the catch-up is over");
		install("0.14.5");
		same(versionsOf(resolve()), { major: [], minor: ["0.14.5"] }, "the next update shows only itself");
	});

	await check("an old-format record in an older line counts as seen only up to that line's x.y.0", () => {
		machine(true);
		install("0.14.1");
		fs.writeFileSync(whatsNewStatePath(), OLD_FORMAT_RECORD("0.13.1"));
		same(versionsOf(resolve()), { major: ["0.14.0"], minor: ["0.14.1", "0.13.2", "0.13.1"] }, "the running line's x.y.0, and the older line from its first update");
	});

	await check("an update from before this window existed shows the running line from its x.y.0", () => {
		machine(true);
		assert(hasPriorInstallationState() === true, "a usage log reads as an installation in use");
		install("0.14.3");
		same(versionsOf(resolve()), { major: ["0.14.0"], minor: ["0.14.3", "0.14.2", "0.14.1"] }, "the running line");
		same(recorded(), null, "nothing is recorded until seen");
		acknowledgeWhatsNew(packageRoot);
		same(recorded(), "0.14.3", "seen records the running version");
	});

	await check("a missing changelog shows nothing and records nothing", () => {
		machine(true);
		install("0.14.4");
		fs.writeFileSync(whatsNewStatePath(), OLD_FORMAT_RECORD("0.14.3"));
		fs.rmSync(path.join(packageRoot, "CHANGELOG.md"));
		assert(resolve().show === false, "no changelog, no window");
		same(recorded(), "0.14.3", "the old record stays");
		install("0.14.4");
		same(versionsOf(resolve()), { major: [], minor: ["0.14.4", "0.14.3", "0.14.2", "0.14.1"] }, "with the changelog back, the catch-up still runs");
	});

	await check("a record that is not a plain version reads as none", () => {
		machine(true);
		install("0.14.4");
		const record = (version: string) => fs.writeFileSync(whatsNewStatePath(), `${JSON.stringify({ acknowledgedVersion: version, rule: "every-release" })}\n`);
		record("garbage");
		const runningLine = { major: ["0.14.0"], minor: ["0.14.4", "0.14.3", "0.14.2", "0.14.1"] };
		same(versionsOf(resolve()), runningLine, "garbage: the running line, not the whole changelog");
		record("0.14.4-rc.1");
		same(versionsOf(resolve()), runningLine, "a prerelease record does not hide its release");
	});

	await check("a downgrade stays quiet and keeps the newer record", () => {
		machine(true);
		install("0.14.3");
		recordAcknowledgedVersion("0.14.4");
		assert(resolve().show === false, "a downgrade shows nothing");
		same(recorded(), "0.14.4", "the newer record stands");
	});

	await check("on a shared server a browser drops what its seen mark covers, and with no mark sees only the newest line", async () => {
		const { sharedServerReleases } = await import(new URL("../../web-ui/src/components/whats-new-dialog.tsx", import.meta.url).href) as { sharedServerReleases: (sections: Sections, seenMark: string | null) => Sections };
		const shown = (seenMark: string | null) => versionsOf({ ...TWO_MAJORS, sections: sharedServerReleases(TWO_MAJORS.sections as Sections, seenMark) });
		same(shown("0.14.1"), { major: [], minor: ["0.14.3", "0.14.2"] }, "a mark inside the newest line");
		same(shown("0.13.1"), { major: ["0.14.0"], minor: ["0.14.3", "0.14.2", "0.14.1", "0.13.2"] }, "a mark in an older line");
		const newestLine = { major: ["0.14.0"], minor: ["0.14.3", "0.14.2", "0.14.1"] };
		same(shown(null), newestLine, "no mark: the newest line only");
		same(shown("not a version"), newestLine, "a mark that is not a version counts as none");
		same(shown("0.14.3"), { major: [], minor: [] }, "a mark at the running version leaves nothing");
	});

	await check("majors show in full, patches are closed rows naming what they touch, and an empty section is not shown", async () => {
		const dialog: any = await import(new URL("../../web-ui/src/components/whats-new-dialog.tsx", import.meta.url).href);
		// React lives with the page.
		const pageRequire = createRequire(new URL("../../web-ui/package.json", import.meta.url));
		(globalThis as any).React = pageRequire("react");
		const { createElement } = pageRequire("react");
		const { renderToStaticMarkup } = pageRequire("react-dom/server");
		const render = (payload: Payload): string => renderToStaticMarkup(createElement(dialog.WhatsNewDialog, { sections: payload.sections, onClose: () => {} }));
		const heads = (html: string): string[] => Array.from(html.matchAll(/<h2 class="whats-new-section-head">([^<]+)</g), (match) => match[1]);
		const majors = (html: string): string[] => Array.from(html.matchAll(/whats-new-release-head whats-new-release-head-first"><span class="whats-new-release-version">([^<]+)</g), (match) => match[1]);
		const rows = (html: string): string[] => Array.from(html.matchAll(/aria-expanded="(true|false)" aria-controls="whats-new-lines-([^"]+)"/g), (match) => `${match[2]} ${match[1] === "true" ? "open" : "closed"}`);
		const html = render(TWO_MAJORS);
		assert(html.includes("<h1 class=\"whats-new-title\">What&#x27;s new</h1>") && html.includes("aria-label=\"What&#x27;s new\""), "the title and the dialog's name are What's new");
		same(heads(html), ["Major releases", "Minor releases"], "the two sections");
		same(majors(html), ["0.13.0", "0.14.0"], "the majors, oldest first");
		assert(html.includes("28 Sep 2026"), "a release heading carries its date");
		assert(html.includes("<strong>Models:</strong> the big release&#x27;s headline.") && !html.includes("Its second sentence"), "a bullet reads as its label and first sentence, as before");
		same(rows(html), ["0.14.3 closed", "0.14.2 closed", "0.14.1 closed", "0.13.2 closed", "0.13.1 closed"], "with a major to read, every patch row starts closed, newest first");
		assert(/<button type="button" class="whats-new-row-toggle" aria-expanded="false"[^>]*>.*?<span class="whats-new-release-version">0\.14\.3<\/span><span class="whats-new-release-date">15 Oct 2026<\/span><span class="whats-new-row-labels">Memory<\/span><\/button>/.test(html), "a row is a button with the version, the date and what it touches");
		assert(/<div id="whats-new-lines-0\.14\.3" class="whats-new-row-lines" hidden="">/.test(html), "a closed row's lines are hidden");
		assert(!html.includes("Show older releases"), "nothing folds behind Show older releases");
		const patchOnly = render(PATCH_ONLY);
		same(heads(patchOnly), ["Minor releases"], "with no major, only Minor releases");
		same(rows(patchOnly), ["0.14.4 open", "0.14.3 closed", "0.14.2 closed", "0.14.1 closed"], "with no major, the newest patch starts open");
		assert(patchOnly.includes("<span class=\"whats-new-row-labels\">Rooms · Fixed</span>"), "the labels read once each, in order");
		same(heads(render({ ...TWO_MAJORS, sections: { major: [R0140], minor: [] } })), ["Major releases"], "with no patch, only Major releases");
	});

	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (executable && fs.existsSync(executable)) {
		ranParts = "the module, the page markup and the real page";
		let started: Promise<string> | undefined;
		const serverUrl = (): Promise<string> => started ??= (async () => {
			const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
			const port = await freePort();
			const baseUrl = `http://127.0.0.1:${port}`;
			const serverHome = path.join(tempRoot, "server-home");
			fs.mkdirSync(serverHome, { recursive: true });
			server = spawn("npx", ["tsx", "src/index.ts"], {
				shell: process.platform === "win32",
				...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
				cwd: webServerDir,
				env: smokeHomeEnv(serverHome, { PORT: String(port), LOG_LEVEL: "warn", ...SMOKE_SERVER_AUTH_ENV }) as NodeJS.ProcessEnv,
			});
			server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
			server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
			const deadline = Date.now() + 60_000;
			for (;;) {
				if (server.exitCode !== null) throw new Error(`the server exited with code ${server.exitCode}`);
				if (await fetch(`${baseUrl}/healthz`).then((res) => res.ok).catch(() => false)) break;
				if (Date.now() > deadline) throw new Error("the server did not come up");
				await new Promise((done) => setTimeout(done, 150));
			}
			return baseUrl;
		})();
		/** The real page, its What's new request answered with `payload`. */
		const openPage = async (payload: Payload, run: (page: Page, seenPosts: () => number) => Promise<void>, shared?: { seenMark: string }): Promise<void> => {
			const baseUrl = await serverUrl();
			const browser = await chromium.launch();
			try {
				const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
				let seenPosts = 0;
				await context.route((url) => url.pathname === "/api/whats-new", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) }));
				await context.route((url) => url.pathname === "/api/whats-new/seen", (route) => {
					if (route.request().method() === "POST") seenPosts += 1;
					return route.fulfill({ contentType: "application/json", body: "{\"ok\":true}" });
				});
				if (shared) {
					await context.route((url) => url.pathname === "/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: false, capability: "full", sharedServer: true }) }));
					await context.addInitScript((mark) => { try { localStorage.setItem("exxperts.whats-new-seen", mark); } catch {} }, shared.seenMark);
				}
				const page = await context.newPage();
				await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				await page.locator(".whats-new-dialog").waitFor({ timeout: 20_000 });
				await run(page, () => seenPosts);
				await context.close();
			} finally {
				await browser.close();
			}
		};

		const rowStates = (page: Page) => page.locator(".whats-new-row-toggle").evaluateAll((buttons) => buttons.map((button) => `${button.querySelector(".whats-new-release-version")?.textContent} ${button.getAttribute("aria-expanded") === "true" ? "open" : "closed"}`));
		const visibleEntries = (page: Page) => page.locator(".whats-new-dialog .whats-new-entry:visible").allInnerTexts();

		await check("the page after a patch-only update: the newest patch open on top, rows open by click and by keyboard, Tab starts at the x, the x records seen", () => openPage(PATCH_ONLY, async (page, seenPosts) => {
			const dialog = page.locator(".whats-new-dialog");
			assert(await page.evaluate(() => document.activeElement?.classList.contains("whats-new-dialog") === true), "focus starts on the window");
			same(await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle), "none", "the window shows no ring of its own");
			await page.keyboard.press("Tab");
			assert(await page.evaluate(() => document.activeElement?.classList.contains("whats-new-close") === true), "the first Tab reaches the x");
			assert(await dialog.getByRole("button", { name: "Continue" }).count() === 0, "there is no Continue button");
			same([await dialog.locator(".whats-new-title").innerText(), await dialog.getAttribute("aria-label")], ["What's new", "What's new"], "the title and the dialog's name");
			same(await dialog.locator(".whats-new-section-head").allInnerTexts(), ["MINOR RELEASES"], "only Minor releases");
			same(await rowStates(page), ["0.14.4 open", "0.14.3 closed", "0.14.2 closed", "0.14.1 closed"], "0.14.4 open on top, three closed rows below");
			same(await visibleEntries(page), ["Rooms: a patch bullet that wraps onto a continuation line.", "Fixed: a second patch bullet."], "only the open row's lines show");
			await dialog.getByRole("button", { name: /^0\.14\.2/ }).click();
			same(await rowStates(page), ["0.14.4 open", "0.14.3 closed", "0.14.2 open", "0.14.1 closed"], "a click opens a row, and several stay open");
			assert((await visibleEntries(page)).includes("Memorize: the second patch."), "the opened row's lines show");
			await page.keyboard.press("Tab");
			let focused = "";
			for (let step = 0; step < 8 && focused !== "0.14.1"; step++) {
				focused = await page.evaluate(() => document.activeElement?.closest(".whats-new-row-toggle")?.querySelector(".whats-new-release-version")?.textContent ?? "");
				if (focused !== "0.14.1") await page.keyboard.press("Tab");
			}
			same(focused, "0.14.1", "Tab reaches the rows");
			const focusRing = await page.evaluate(() => getComputedStyle(document.activeElement as Element).backgroundColor);
			assert(focusRing !== "rgba(0, 0, 0, 0)" && focusRing !== "transparent", `a focused row shows it, got ${focusRing}`);
			await page.keyboard.press("Enter");
			same(await rowStates(page), ["0.14.4 open", "0.14.3 closed", "0.14.2 open", "0.14.1 open"], "Enter opens the focused row");
			await page.keyboard.press("Space");
			same(await rowStates(page), ["0.14.4 open", "0.14.3 closed", "0.14.2 open", "0.14.1 closed"], "Space closes it again");
			await dialog.getByRole("button", { name: /^0\.14\.4/ }).click();
			same(await rowStates(page), ["0.14.4 closed", "0.14.3 closed", "0.14.2 open", "0.14.1 closed"], "the row that started open closes too");
			assert(await dialog.getByRole("link", { name: "Read the full notes" }).count() === 1, "Read the full notes stays");
			await dialog.getByRole("button", { name: "Close" }).click();
			await dialog.waitFor({ state: "detached", timeout: 5000 });
			assert(seenPosts() === 1, `the x sends seen once, sent ${seenPosts()}`);
		}));

		await check("the page after an update across a line: 0.14.0 in full under Major releases, the patches closed, newest first, and Escape records seen", () => openPage(ACROSS_A_LINE, async (page, seenPosts) => {
			const dialog = page.locator(".whats-new-dialog");
			same(await dialog.locator(".whats-new-section-head").allInnerTexts(), ["MAJOR RELEASES", "MINOR RELEASES"], "both sections");
			same(await dialog.locator(".whats-new-release-head-first .whats-new-release-version").allInnerTexts(), ["0.14.0"], "the major");
			same(await rowStates(page), ["0.14.4 closed", "0.14.3 closed", "0.14.2 closed", "0.14.1 closed", "0.13.2 closed", "0.13.1 closed"], "the patches closed, newest first");
			same(await visibleEntries(page), ["Models: the big release's headline.", "Home: its second bullet."], "only the major's lines show");
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "detached", timeout: 5000 });
			assert(seenPosts() === 1, `Escape sends seen once, sent ${seenPosts()}`);
		}));

		await check("on a shared server the page shows only what is newer than this browser's seen mark", () => openPage(TWO_MAJORS, async (page, seenPosts) => {
			const dialog = page.locator(".whats-new-dialog");
			same(await dialog.locator(".whats-new-section-head").allInnerTexts(), ["MINOR RELEASES"], "the majors, all at or below the mark, are gone");
			same(await rowStates(page), ["0.14.3 open", "0.14.2 closed"], "the releases after the mark, the newest open");
			await dialog.getByRole("button", { name: "Close" }).click();
			await dialog.waitFor({ state: "detached", timeout: 5000 });
			assert(seenPosts() === 0, `a shared server is never sent seen, sent ${seenPosts()}`);
		}, { seenMark: "0.14.1" }));
	}
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
	if (serverOutput.length > 0) console.error(serverOutput.join("").slice(-4000));
	console.error(`\nwhats-new smoke: ${failures.length} failed, in ${ranParts}\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
	process.exit(1);
}
console.log(`whats-new smoke: all assertions passed, in ${ranParts}`);
