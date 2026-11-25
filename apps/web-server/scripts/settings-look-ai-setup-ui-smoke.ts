// The settings windows' new look on Settings' AI setup
// (53-settings-look-ai-setup.css). With the switch off, the page renders as
// before: its markup and every element's computed style, read with providers
// in every state, a sign-in waiting in the browser, the models opened, a
// row's key form, and Add provider's panel open, with and without its own key
// form. Every rule of the page file sits under the switch's class and names
// AI setup's section. The selectors a hosted check pins sit on the same
// elements with the switch on and off. With the switch on, in both themes:
// provider rows 64 tall, a dot per state beside words that are never
// coloured, the fix buttons ending at one x, "N room models" starting at one
// x, ··· 28 px, each control's hover, pressed and keyboard ring; Add provider
// the page's one ink button, giving way while a form shows its own; the
// loading card's grey bars after 300 ms; the status words with a capital;
// the phone's three lines; the error and a key's notice as inline messages.
//
// The world is a server on a scratch home with one custom provider whose key
// is saved through the app. The other states are answered in the page: the
// providers' status, the sign-in status and the providers to add (each
// state's provider is a copy of the saved one), a sign-in started and
// waiting, a refused sign-in, a key saved with a notice, and a shared
// server's client context. Nothing signs in anywhere, nothing is removed.
// Set LOOK_OFF_READING to a file to keep the switch-off reading for comparing
// two builds, and LOOK_OFF_BASE to compare with one; LOOK_ROWS to run some
// rows; LOOK_SHOTS to a folder for the pictures.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { answered, assert, DARK, desktop, goToPage, installColourTools, installReach, LIGHT, LOOK_FILE, lookPages, nearColour, notLookPageFilesAfterLook, phone, requestsFromNow, rulesOutsideRoots, same, SWITCH_CLASS } from "./settings-look-smoke-parts.js";

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings look ai setup ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const stylesDir = path.join(repoRoot, "apps", "web-ui", "src", "styles");
const PAGE_FILE = "53-settings-look-ai-setup.css";
const SECTION = ".ai-profile-switcher-section";
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-ai-setup-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const ROOM = "Look Room";
const shots = process.env.LOOK_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

// --- The providers, one per state ----------------------------------------------------------

type Status = "signed-out" | "key-saved" | "signed-in" | "setup-needed" | "refused" | "refused-no-workspace" | "signed-out-gone";
/** Each state's row: its name, and what its provider's answer changes. The built-in signed-out row and the saved key are the server's own. */
const STATES: Record<Status, { name: string; ready?: boolean; configured?: boolean; keyRefused?: "refused" | "no-workspace" | "signed-out"; noModels?: boolean }> = {
	"signed-out": { name: "ChatGPT Plus/Pro" },
	"key-saved": { name: "Synthetic" },
	"signed-in": { name: "Team plan", ready: true, configured: true },
	"setup-needed": { name: "Team gateway", ready: false, configured: true },
	refused: { name: "Office key", ready: true, configured: true, keyRefused: "refused" },
	"refused-no-workspace": { name: "Workspace key", ready: true, configured: true, keyRefused: "no-workspace" },
	"signed-out-gone": { name: "Old sign-in", ready: true, configured: true, keyRefused: "signed-out", noModels: true },
};
const ORDER = Object.keys(STATES) as Status[];
const idOf = (status: Status) => `look-${status}`;
// Its key form opens from the row (an API key provider); the others sign in.
const KEY_ROW: Status = "setup-needed";
const BUILTIN_ID = "openai-codex";

/** The words each row's second line says, with the switch off and on (written out, as the person reads them). */
const WORDS: Record<Status | "signing-in", { off: string; on: string }> = {
	"signed-out": { off: "signed out", on: "Signed out" },
	"key-saved": { off: "key saved", on: "Key saved" },
	"signed-in": { off: "signed in", on: "Signed in" },
	"setup-needed": { off: "setup needed", on: "Setup needed" },
	refused: { off: "not accepted at the last try", on: "Not accepted at the last try" },
	"refused-no-workspace": { off: "not accepted at the last try: key isn't tied to a workspace", on: "Not accepted at the last try: key isn't tied to a workspace" },
	"signed-out-gone": { off: "signed out", on: "Signed out" },
	"signing-in": { off: "finish signing in in your browser…", on: "Finish signing in in your browser…" },
};
/** The dot each state takes: a ring, green, amber or the spinner. */
const DOT: Record<Status | "signing-in", "ring" | "ok" | "warn" | "spin"> = {
	"signed-out": "ring", "key-saved": "ok", "signed-in": "ok", "setup-needed": "warn", refused: "warn", "refused-no-workspace": "warn", "signed-out-gone": "ring", "signing-in": "spin",
};
/** The look's colours. */
const COLOUR = {
	[LIGHT]: { text: "#171717", soft: "#34312d", muted: "#6d675f", ink: "#111111", ok: "#357a42", warn: "#9a650f", card: "#ffffff" },
	[DARK]: { text: "#f2f0ec", soft: "#d5d0c8", muted: "#aaa39a", ink: "#f4f1ec", ok: "#6bc77a", warn: "#e8a838", card: "#373737" },
};

type Scene = {
	/** The providers in every state; otherwise the server's own. */
	states?: boolean;
	/** Held until resolved: the providers' status, to see the page load. */
	hold?: Promise<void>;
	/** A sign-in refused when it starts. */
	refuseSignIn?: boolean;
	/** A shared server, read by its admin. */
	shared?: boolean;
	/** A line from the status under the list. */
	stateMessage?: string;
};

type Profile = { id: string; label: string; kind: string; ready: boolean; provider: Record<string, unknown>; runsIn?: string; processes?: { persistentRoom: { ready: boolean; models: unknown[] } } };

function withStates(real: { profiles: Profile[]; state: Record<string, unknown> }, scene: Scene) {
	const saved = real.profiles.find((profile) => profile.id === "custom-synthetic")!;
	const builtin = real.profiles.find((profile) => profile.provider.id === BUILTIN_ID)!;
	assert(saved && builtin, "the server lists the saved key and the built-in sign-in");
	const copies = ORDER.filter((status) => status !== "signed-out" && status !== "key-saved").map((status) => {
		const state = STATES[status];
		return {
			...saved,
			id: idOf(status),
			label: state.name,
			ready: state.ready!,
			provider: { ...saved.provider, id: idOf(status), configured: state.configured!, ...(state.keyRefused ? { keyRefused: state.keyRefused } : {}), ...(status === "refused" ? { source: "environment", label: "SYNTHETIC_KEY" } : {}) },
			processes: state.noModels ? { persistentRoom: { ready: true, models: [] } } : saved.processes,
			// A shared server says where each provider's models run.
			...(scene.shared ? { runsIn: "eu" } : {}),
		};
	});
	return { ...real, state: { ...real.state, message: scene.stateMessage ?? null }, profiles: [builtin, { ...saved, ...(scene.shared ? { runsIn: "eu" } : {}) }, ...copies] };
}

// Lets go of a held answer; set by the row that holds one.
let release = null as (() => void) | null;

/** The server's own answer to a routed request, or null when the page closed first and nothing is left to answer. */
async function serverAnswer<T>(route: Route): Promise<T | null> {
	return route.fetch().then((answerOf) => answerOf.json() as Promise<T>).catch(() => null);
}
const signIns = { started: 0 };

/** The page's answers for the scene: the providers, the sign-ins, the providers to add, a sign-in and a key's save. */
async function answer(page: Page, scene: Scene): Promise<void> {
	await page.unrouteAll({ behavior: "ignoreErrors" });
	await page.route("**/api/persistent-agent-ai-profile", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		if (scene.hold) await scene.hold;
		// A page closed while its answer was held has nothing left to answer.
		const real = await serverAnswer<{ profiles: Profile[]; state: Record<string, unknown> }>(route);
		if (real) await route.fulfill({ json: scene.states ? withStates(real, scene) : real }).catch(() => {});
	});
	if (!scene.states) return;
	await page.route("**/api/auth/status", async (route) => {
		const real = await serverAnswer<{ providers: Array<Record<string, unknown>> }>(route);
		if (!real) return;
		const providers = real.providers.filter((provider) => provider.id !== "synthetic");
		providers.push({ id: "synthetic", name: "Synthetic", configured: true, oauth: false, signedInWithOAuth: false, source: "stored" });
		providers.push({ id: idOf("signed-in"), name: STATES["signed-in"].name, configured: true, oauth: true, signedInWithOAuth: true, source: "stored" });
		await route.fulfill({ json: { ...real, providers } }).catch(() => {});
	});
	await page.route("**/api/auth/providers", async (route) => {
		const real = await serverAnswer<{ providers: Array<Record<string, unknown>> }>(route);
		if (!real) return;
		const providers = [...real.providers, { id: idOf(KEY_ROW), name: STATES[KEY_ROW].name, authTypes: ["api_key"], configured: true, profileId: idOf(KEY_ROW) }];
		// A saved key with no provider of its own: on a shared server its row offers Remove key…
		if (scene.shared) providers.push({ id: "look-saved-key", name: "Look saved key", authTypes: ["api_key"], configured: true, profileId: null });
		await route.fulfill({ json: { providers } }).catch(() => {});
	});
	await page.route("**/api/auth/login", async (route) => {
		signIns.started += 1;
		if (scene.refuseSignIn) await route.fulfill({ status: 502, json: { error: "The sign-in could not start. Try again in a moment." } });
		else await route.fulfill({ json: { url: "about:blank" } });
	});
	await page.route("**/api/auth/login/status", (route) => route.fulfill({ json: { pending: true } }));
	await page.route("**/api/auth/login/cancel", (route) => route.fulfill({ json: { ok: true } }));
	await page.route("**/api/auth/api-key", (route) => route.fulfill({ json: { ok: true, notice: "Saved. Its service didn't answer, so the key isn't checked yet." } }));
	if (scene.shared) await page.route("**/api/remote/client-context", (route) => route.fulfill({ json: { remote: false, capability: "full", sharedServer: true, person: { id: "look-admin", name: "Look Admin", admin: true } } }));
}

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true }).first();
const section = (page: Page) => visible(page, SECTION);
const rowOf = (page: Page, status: Status) => section(page).locator(`.ai-profile-row-group[data-provider-id="${status === "signed-out" ? BUILTIN_ID : status === "key-saved" ? "synthetic" : idOf(status)}"]`);

/** Opens Settings on AI setup with the scene's answers, its requests answered and the pointer away. */
async function openAiSetup(page: Page, scene: Scene = {}): Promise<Locator> {
	await answer(page, scene);
	await page.addInitScript(() => { window.open = () => null; });
	// When the loading card showed and when its bars came, by the page's own clock, from before the page loads.
	if (scene.hold) await page.addInitScript(() => {
		const w = window as any;
		const mark = () => {
			const card = document.querySelector(".ai-profile-card-loading");
			if (!w.__cardAt && card) {
				w.__cardAt = performance.now();
				const style = getComputedStyle(card);
				w.__cardFirst = { height: card.getBoundingClientRect().height, edge: style.borderTopColor, fill: style.backgroundColor };
			}
			if (!w.__barsAt && document.querySelector(".ai-profile-loading-row")) w.__barsAt = performance.now();
		};
		new MutationObserver(mark).observe(document, { childList: true, subtree: true });
	});
	await page.reload();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	await installColourTools(page);
	requestsFromNow(page);
	await page.locator("button.sidebar-config-gear").filter({ visible: true }).first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10000 });
	await goToPage(page, "AI setup");
	if (!scene.hold) {
		await section(page).locator(".ai-profile-row").first().waitFor({ timeout: 15000 });
		if (scene.states) await rowOf(page, "signed-in").waitFor({ timeout: 15000 });
		await answered(page, "AI setup");
	}
	await page.mouse.move(5, 5);
	return section(page);
}

async function closePage(page: Page): Promise<void> {
	await page.context().close();
}

/** Starts the built-in row's sign-in, answered as waiting in the browser. */
async function startSignIn(page: Page): Promise<void> {
	await rowOf(page, "signed-out").getByRole("button", { name: "Sign in", exact: true }).click();
	await rowOf(page, "signed-out").locator(".ai-profile-sub").filter({ hasText: /^finish signing in/i }).waitFor();
	await page.mouse.move(5, 5);
}

/** Reads until two reads a beat apart agree: a 100 ms fade has ended. */
async function settledRead<T>(read: () => Promise<T>): Promise<T> {
	let last = JSON.stringify(await read());
	for (let i = 0; i < 20; i++) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		const next = await read();
		if (JSON.stringify(next) === last) return next;
		last = JSON.stringify(next);
	}
	return read();
}

// --- The page file ------------------------------------------------------------------------

async function checkRulesUnderSwitch(browser: Browser): Promise<void> {
	const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1280), "off");
	const css = fs.readFileSync(path.join(stylesDir, PAGE_FILE), "utf8");
	same(await rulesOutsideRoots(page, css, [SWITCH_CLASS]), [], `rules in ${PAGE_FILE} outside ${SWITCH_CLASS}`);
	// Each rule also names AI setup's own section, since .ai-setup-section alone holds other pages too.
	const outsideSection = (text: string) => page.evaluate(({ text, section }) => {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(text);
		const found: string[] = [];
		const walk = (rules: CSSRuleList) => {
			for (const rule of rules) {
				if (rule instanceof CSSStyleRule) found.push(...rule.selectorText.split(/,(?![^(]*\))/).map((one) => one.trim()).filter((one) => !one.includes(`${section}`) || !new RegExp(`\\s${section.replace(".", "\\.")}(?![\\w-])`).test(one)));
				else if (rule instanceof CSSMediaRule) walk(rule.cssRules);
			}
		};
		walk(sheet.cssRules);
		return found;
	}, { text, section: SECTION });
	same(await outsideSection(css), [], `rules in ${PAGE_FILE} that do not name ${SECTION}`);
	// The checks themselves: a rule outside the switch or the section is found, in a media query too, and a longer name is not the section.
	same(await rulesOutsideRoots(page, `.ai-profile-row { color: red; } @media (max-width: 760px) { ${SWITCH_CLASS} .a, .ai-profile-sub { color: red; } }`, [SWITCH_CLASS]), [".ai-profile-row", ".ai-profile-sub"], "the switch check's own probe");
	same(await outsideSection(`${SWITCH_CLASS} .ai-setup-section .ai-profile-row { color: red; } @media (max-width: 760px) { ${SWITCH_CLASS} ${SECTION}-more .a, ${SWITCH_CLASS} ${SECTION} .b { color: red; } }`), [`${SWITCH_CLASS} .ai-setup-section .ai-profile-row`, `${SWITCH_CLASS} ${SECTION}-more .a`], "the section check's own probe");
	const imports = [...fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]);
	same(notLookPageFilesAfterLook(imports), [], `the style files after ${LOOK_FILE} that are not the look's page files`);
	assert(imports.indexOf(PAGE_FILE) > imports.indexOf(LOOK_FILE), `${PAGE_FILE} loads after ${LOOK_FILE}`);
	const loaded = await page.evaluate(() => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule && rule.selectorText.includes(".ai-profile-loading-row"))));
	assert(loaded, "the page's stylesheet carries the page file's rules");
	await closePage(page);
	console.log(`  ok  every rule of ${PAGE_FILE} sits under ${SWITCH_CLASS} and names ${SECTION}, and it loads after ${LOOK_FILE}`);
}

// --- What stays as it was ------------------------------------------------------------------

/** An element's markup, with React's generated ids blanked, and every element's computed style by property name; this run's folder and ports blanked, so two runs read alike. */
async function readAsItIs(root: Locator) {
	const read = await root.evaluate((element) => {
		const blank = (text: string) => text.replace(/«[^»]*»|:r[0-9a-z]+:/g, "#id");
		const styles = [element, ...element.querySelectorAll("*")].map((one) => {
			const style = getComputedStyle(one);
			return `${one.tagName.toLowerCase()}.${[...one.classList].join(".")} ${[...style].sort().map((name) => `${name}:${style.getPropertyValue(name)}`).join(";")}`;
		});
		return { markup: blank(element.outerHTML), styles: styles.map(blank) };
	});
	let text = JSON.stringify(read);
	for (const folder of new Set([tempRoot, fs.realpathSync(tempRoot)])) text = text.replaceAll(folder, "<temp>");
	return JSON.parse(text.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>"));
}

async function checkOff(browser: Browser): Promise<void> {
	const reading: Record<string, unknown> = {};
	for (const [where, options] of [["1440 light", desktop(1440, 900, LIGHT)], ["390 light", phone(LIGHT)]] as const) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, options, "off");
		let opened = await openAiSetup(page, { states: true });
		same(await page.locator(".settings-look-next").count(), 0, `${where}, switch off: elements with the look's class`);
		same(await opened.locator("[data-status], .ai-profile-card-loading, .ai-profile-loading-row").count(), 0, `${where}, switch off: the look's own marks`);
		reading[`${where}, every state`] = await settledRead(() => readAsItIs(opened));
		await startSignIn(page);
		reading[`${where}, a sign-in waiting`] = await settledRead(() => readAsItIs(opened));
		await rowOf(page, "signed-out").getByRole("button", { name: "Cancel", exact: true }).click();
		await rowOf(page, "key-saved").locator(".ai-profile-models-toggle").click();
		await opened.locator(".ai-profile-models").waitFor();
		await page.mouse.move(5, 5);
		reading[`${where}, the models opened`] = await settledRead(() => readAsItIs(opened));
		await rowOf(page, KEY_ROW).getByRole("button", { name: "Add API key", exact: true }).click();
		await opened.locator(".ai-profile-key-form").waitFor();
		reading[`${where}, a row's key form`] = await settledRead(() => readAsItIs(opened));
		await opened.locator(".ai-profile-key-form").getByRole("button", { name: "Cancel", exact: true }).click();
		await opened.locator(".add-provider-toggle").click();
		await opened.locator(".add-provider-block .settings-row").first().waitFor({ timeout: 15000 });
		await answered(page, `${where}, the panel`);
		await page.mouse.move(5, 5);
		reading[`${where}, the panel`] = await settledRead(() => readAsItIs(opened));
		await opened.locator(".add-provider-block").getByRole("button", { name: "Add key", exact: true }).first().click();
		await opened.locator(".add-provider-row-key-form").waitFor();
		reading[`${where}, the panel's key form`] = await settledRead(() => readAsItIs(opened));
		await closePage(page);
	}
	if (process.env.LOOK_OFF_READING) fs.writeFileSync(process.env.LOOK_OFF_READING, JSON.stringify(reading, null, 1));
	if (process.env.LOOK_OFF_BASE) {
		const base = JSON.parse(fs.readFileSync(process.env.LOOK_OFF_BASE, "utf8")) as Record<string, { markup: string; styles: string[] }>;
		same(Object.keys(reading), Object.keys(base), "the scenes read against the base's");
		for (const [scene, read] of Object.entries(reading) as Array<[string, { markup: string; styles: string[] }]>) {
			same(read.markup, base[scene].markup, `${scene}: the markup against the base's`);
			const differ = read.styles.findIndex((style, i) => style !== base[scene].styles[i]);
			assert(differ < 0 && read.styles.length === base[scene].styles.length, `${scene}: an element's computed style against the base's: ${read.styles[differ]?.slice(0, 200)} / ${base[scene].styles[differ]?.slice(0, 200)}`);
		}
		console.log(`  ..  the switch-off reading matches ${path.basename(process.env.LOOK_OFF_BASE)}: ${Object.keys(reading).length} scenes`);
	}
	console.log(`  ok  switch off: ${Object.keys(reading).join("; ")}: read whole, markup and computed styles`);
}

// --- The pinned selectors ------------------------------------------------------------------

/** The selectors shared-server-page-smoke.ts pins on AI setup. */
const PINNED = [".add-provider-toggle", ".ai-profile-row-group[data-provider-id]", ".ai-profile-sub", ".ai-profile-menu-btn", ".ai-profile-menu-item", ".ai-defaults-group .room-model-pick", ".add-provider-block", ".add-provider-remove-confirm", ".settings-row-sub", ".models-run-in"];

/** For each pinned selector, each element it finds: its tag and its words, in lower case (the look starts the status words with a capital). */
async function readPinned(page: Page) {
	return page.evaluate((selectors) => Object.fromEntries(selectors.map((selector) => [selector, [...document.querySelectorAll(selector)].filter((element) => !element.closest(".settings-dialog") || element.closest(".ai-profile-switcher-section")).map((element) => `${element.tagName.toLowerCase()} ${(element.textContent ?? "").trim().slice(0, 40).toLowerCase()}`)])), PINNED);
}

async function checkHostedSelectors(browser: Browser): Promise<void> {
	const read: Record<string, Record<string, Record<string, string[]>>> = { off: {}, on: {} };
	for (const look of ["off", "on"] as const) {
		for (const shared of [false, true]) {
			const where = shared ? "a shared server's admin" : "this computer";
			const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1440), look);
			const opened = await openAiSetup(page, { states: true, shared });
			read[look][`${where}, the list`] = await readPinned(page);
			await rowOf(page, "key-saved").locator(".ai-profile-menu-btn").click();
			await page.locator(".ai-profile-menu").waitFor();
			read[look][`${where}, the menu`] = await readPinned(page);
			await page.keyboard.press("Escape");
			await page.locator(".ai-profile-menu").waitFor({ state: "detached" });
			await opened.locator(".add-provider-toggle").click();
			await opened.locator(".add-provider-block .settings-row").first().waitFor({ timeout: 15000 });
			await answered(page, `${look}, ${where}, the panel`);
			read[look][`${where}, the panel`] = await readPinned(page);
			if (shared) {
				// The question's first step only: its Remove is never pressed.
				await opened.locator(".add-provider-row-group").filter({ hasText: "Look saved key" }).getByRole("button", { name: "Remove key…", exact: true }).click();
				await opened.locator(".add-provider-remove-confirm").waitFor();
				read[look][`${where}, a key's removal asked`] = await readPinned(page);
			}
			await closePage(page);
		}
	}
	for (const at of Object.keys(read.off)) same(read.on[at], read.off[at], `${at}: the pinned selectors on the same elements, switch on as off`);
	const found = (where: string) => new Set(Object.entries(read.on).filter(([at]) => at.startsWith(where)).flatMap(([, selectors]) => Object.entries(selectors).filter(([, elements]) => elements.length).map(([selector]) => selector)));
	const here = found("this computer");
	const shared = found("a shared server");
	same(PINNED.filter((selector) => !here.has(selector) && !shared.has(selector)), [], "pinned selectors found nowhere");
	console.log(`  ok  the pinned selectors sit on the same elements with the switch on and off; only a shared server shows ${PINNED.filter((selector) => !here.has(selector)).join(", ")}`);
}

// --- Provider rows --------------------------------------------------------------------------

/** What each provider row draws: its box, its second line's words, colour and dot, and its controls' boxes. */
async function readRows(page: Page) {
	return page.evaluate((section) => {
		const w = window as any;
		const hexOf = (colour: string) => w.__seen(document.querySelector(section)!, colour) as string;
		return [...document.querySelectorAll(`${section} .ai-profile-row-group`)].map((group) => {
			const row = group.querySelector(".ai-profile-row")!;
			const sub = row.querySelector(".ai-profile-sub")!;
			const dot = getComputedStyle(sub, "::before");
			const fix = row.querySelector(".ai-profile-side > .rs-btn");
			const toggle = row.querySelector(".ai-profile-models-toggle");
			const menu = row.querySelector(".ai-profile-menu-btn");
			const box = (element: Element | null) => element ? element.getBoundingClientRect() : null;
			const subStyle = getComputedStyle(sub);
			return {
				id: group.getAttribute("data-provider-id"),
				height: box(row)!.height,
				words: sub.textContent,
				wordsColour: w.__seen(sub, subStyle.color) as string,
				contrast: Number(w.__contrast(sub).toFixed(2)),
				dot: { width: dot.width, height: dot.height, fill: dot.backgroundColor === "rgba(0, 0, 0, 0)" ? "none" : hexOf(dot.backgroundColor), ring: dot.borderTopStyle === "none" || dot.borderTopWidth === "0px" ? "none" : `${dot.borderTopWidth} ${hexOf(dot.borderTopColor)}`, spin: dot.animationName },
				fixRight: fix ? Math.round(box(fix)!.right * 10) / 10 : null,
				fixHeight: fix ? box(fix)!.height : null,
				// The count ends the status line: after the state's words, on their line.
				countInLine: toggle ? box(toggle)!.left >= box(sub)!.right - 0.5 && Math.abs(box(toggle)!.top + box(toggle)!.height / 2 - (box(sub)!.top + box(sub)!.height / 2)) <= 1 : null,
				menu: menu ? [box(menu)!.width, box(menu)!.height] : null,
			};
		});
	}, SECTION);
}

/** A control's fill as seen at rest, under the pointer, pressed, and its ring by keyboard. */
async function readStates(page: Page, control: Locator) {
	const fill = () => control.evaluate((element) => (window as any).__fill(element) as string);
	await page.mouse.move(5, 5);
	const rest = await settledRead(fill);
	await control.hover();
	const hover = await settledRead(fill);
	await page.mouse.down();
	const pressed = await settledRead(fill);
	// Let go over the page's lead, so the click lands on no control and not on the veil, which closes the window.
	const lead = (await page.locator(".settings-dialog-pane .pane-lead").filter({ visible: true }).first().boundingBox())!;
	await page.mouse.move(lead.x + 4, lead.y + 4);
	await page.mouse.up();
	await page.mouse.move(5, 5);
	await control.focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
	const ring = await control.evaluate((element) => { const style = getComputedStyle(element); return [element.matches(":focus-visible"), style.outlineStyle, style.outlineWidth]; });
	await control.blur();
	return { rest, hover, pressed, ring };
}

/** A provider's opened row: its models' names alone, then where its sign-in comes from when the app doesn't hold it. */
async function readOpened(opened: Locator, providerId: string, c: { text: string; muted: string }, at: string, from: string | null): Promise<void> {
	const group = opened.locator(`.ai-profile-row-group[data-provider-id="${providerId}"]`);
	const read = await group.evaluate((element) => {
		const w = window as any;
		const detail = element.querySelector(".ai-profile-models")!;
		const names = [...detail.querySelectorAll("span[title]")];
		const look = (one: Element) => { const style = getComputedStyle(one); return [`${style.fontSize}/${style.lineHeight}`, w.__seen(one, style.color) as string]; };
		const row = element.querySelector(".ai-profile-row")!.getBoundingClientRect();
		const words = (one: Element) => { const range = document.createRange(); range.selectNodeContents(one); return range.getBoundingClientRect(); };
		return {
			text: (detail as HTMLElement).innerText.split("\n").filter((line) => line.trim() !== ""),
			names: names.map((name) => name.textContent),
			// How many lines each name takes: one, unless it is longer than the row.
			lines: names.map((name) => name.getClientRects().length),
			left: Math.round(words(names[0]).left - words(element.querySelector(".ai-profile-name-text")!).left),
			top: Math.round(words(names[0]).top - row.bottom),
			line: getComputedStyle(detail).borderTopWidth,
			under: Math.round(element.getBoundingClientRect().bottom - detail.lastElementChild!.getBoundingClientRect().bottom),
			looks: [look(names[0]), detail.querySelector(".ai-profile-models-source") ? look(detail.querySelector(".ai-profile-models-source")!) : null],
		};
	});
	assert(read.names.length >= 2, `${at}, ${providerId} opened: its models (${read.names.join(" ")})`);
	same(read.text, [read.names.join(" "), ...(from === null ? [] : [from])], `${at}, ${providerId} opened: its words`);
	same([read.lines.every((lines) => lines === 1), read.left, read.line, read.under], [true, 0, "0px", 16], `${at}, ${providerId} opened: each name on one line, on the row's left edge, no line over them, 16 under them`);
	assert(read.top >= -14 && read.top <= 0, `${at}, ${providerId} opened: the names under the row's line (${read.top} from its end)`);
	same(read.looks[0]![0], "13px/18px", `${at}, ${providerId} opened: a name's size`);
	nearColour(read.looks[0]![1], c.text, `${at}, ${providerId} opened: a name's colour`);
	if (from !== null) {
		same(read.looks[1]![0], "13px/18px", `${at}, ${providerId} opened: the source's size`);
		nearColour(read.looks[1]![1], c.muted, `${at}, ${providerId} opened: the source's colour`);
	}
}

async function checkProviderRows(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1440, 900, theme), "on");
		const opened = await openAiSetup(page, { states: true });
		const at = `${theme}`;
		await startSignIn(page);
		const rows = await settledRead(() => readRows(page));
		const statusOf = (id: string | null): Status | "signing-in" => id === BUILTIN_ID ? "signing-in" : id === "synthetic" ? "key-saved" : id!.replace(/^look-/, "") as Status;
		same(rows.map((row) => statusOf(row.id)).sort(), [...ORDER.filter((status) => status !== "signed-out"), "signing-in"].sort(), `${at}: a row for each state`);
		const c = COLOUR[theme];
		for (const row of rows) {
			const status = statusOf(row.id);
			const where = `${at}, ${status}`;
			same(row.height, 64, `${where}: the row's height`);
			same(row.words, WORDS[status].on, `${where}: the words`);
			assert(row.contrast >= 4.5, `${where}: the words at ${row.contrast}:1`);
			nearColour(row.wordsColour, DOT[status] === "warn" ? c.soft : c.muted, `${where}: the words' colour, never the dot's`);
			const kind = DOT[status];
			if (kind === "spin") same([row.dot.width, row.dot.height, row.dot.spin, row.dot.fill], ["12px", "12px", "spin", "none"], `${where}: the spinner`);
			else {
				same([row.dot.width, row.dot.height, row.dot.spin], ["8px", "8px", "none"], `${where}: the 8 px dot`);
				if (kind === "ring") { same(row.dot.fill, "none", `${where}: a ring, hollow`); nearColour(row.dot.ring.split(" ")[1], c.muted, `${where}: the ring's colour`); assert(["1px", "1.5px"].includes(row.dot.ring.split(" ")[0]), `${where}: the ring's width, 1.5 px as the screen draws it: ${row.dot.ring}`); }
				else { same(row.dot.ring, "none", `${where}: a filled dot`); nearColour(row.dot.fill, kind === "ok" ? c.ok : c.warn, `${where}: the dot's colour`); }
			}
			if (row.menu) same(row.menu, [28, 28], `${where}: ··· 28 px`);
			if (row.fixHeight !== null) same(row.fixHeight, 28, `${where}: the fix button 28 tall`);
		}
		const fixRights = [...new Set(rows.map((row) => row.fixRight).filter((x) => x !== null))];
		same(fixRights.length, 1, `${at}: the fix buttons' right edges (${fixRights.join(", ")})`);
		assert(rows.filter((row) => row.fixRight !== null).length >= 4, `${at}: rows with a fix button`);
		// One row pattern (44): the count is part of the status line, not a column of its own.
		same(rows.filter((row) => row.countInLine === false).map((row) => row.id), [], `${at}: a count not ending its status line`);
		assert(rows.some((row) => row.countInLine === true) && rows.some((row) => row.countInLine === null), `${at}: rows with and without a count`);
		// Each control answers: the fix button and ··· with a fill; the count, words in the status line, in the text colour.
		for (const [name, control] of [
			// Replace key: the sign-in under way holds every Sign in off.
			["the fix button", rowOf(page, "refused").locator(".ai-profile-side > .rs-btn")],
			["···", rowOf(page, "key-saved").locator(".ai-profile-menu-btn")],
		] as const) {
			const states = await readStates(page, control);
			assert(states.hover !== states.rest, `${at}, ${name}: a fill under the pointer (${states.rest} → ${states.hover})`);
			assert(states.pressed !== states.hover, `${at}, ${name}: pressed differs from hover (${states.hover} → ${states.pressed})`);
			same(states.ring, [true, "solid", "2px"], `${at}, ${name}: the keyboard's ring`);
		}
		// ··· keeps its hover fill while its menu is open, with the pointer away.
		const more = rowOf(page, "key-saved").locator(".ai-profile-menu-btn");
		const moreHover = (await readStates(page, more)).hover;
		await more.click();
		await page.locator(".ai-profile-menu").waitFor();
		await page.mouse.move(5, 5);
		const moreOpen = await settledRead(() => more.evaluate((element) => [element.getAttribute("aria-expanded"), (window as any).__fill(element) as string]));
		same(moreOpen, ["true", moreHover], `${at}: ··· with its menu open keeps the hover fill`);
		await page.keyboard.press("Escape");
		await page.locator(".ai-profile-menu").waitFor({ state: "detached" });
		const toggle = rowOf(page, "key-saved").locator(".ai-profile-models-toggle");
		same(await toggle.evaluate((element) => { const style = getComputedStyle(element); return [element.getBoundingClientRect().height, style.fontSize, style.fontWeight, (window as any).__painted(style.backgroundColor)]; }), [18, "13px", "400", false], `${at}: the count, words 13/18 on the status line with no fill`);
		const countColour = () => toggle.evaluate((element) => (window as any).__seen(element, getComputedStyle(element).color) as string);
		await page.mouse.move(5, 5);
		const countRest = await settledRead(countColour);
		await toggle.hover();
		const countHover = await settledRead(countColour);
		await page.mouse.move(5, 5);
		nearColour(countRest, c.muted, `${at}, the count at rest: muted`);
		nearColour(countHover, c.text, `${at}, the count under the pointer: the text colour`);
		await toggle.focus();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");
		same(await toggle.evaluate((element) => { const style = getComputedStyle(element); return [element.matches(":focus-visible"), style.outlineStyle, style.outlineWidth]; }), [true, "solid", "2px"], `${at}, the count: the keyboard's ring`);
		await toggle.blur();
		// Opened: just the models' names, on the row's left edge, no line over them and nothing its line says already.
		await toggle.click();
		await readOpened(opened, "synthetic", c, at, null);
		await toggle.click();
		// A sign-in the app doesn't hold: where it comes from, quiet, in the row's own words.
		const outside = rowOf(page, "refused").locator(".ai-profile-models-toggle");
		await outside.click();
		await readOpened(opened, idOf("refused"), c, at, "Environment variable: SYNTHETIC_KEY");
		await outside.click();
		await toggle.click();
		same(await settledRead(() => toggle.evaluate((element) => getComputedStyle(element.querySelector(".disclosure-chevron")!).transform)), "matrix(0, -1, 1, 0, 0, 0)", `${at}: the chevron points up while open`);
		if (shots) await page.screenshot({ path: path.join(shots, `rows-${theme}.png`) });
		await closePage(page);
	}
	// A touch screen wider than a phone: 44 px controls, and the long reason no longer fits its line.
	const touch = await lookPages({ baseUrl, room: ROOM }).openPage(browser, { ...desktop(1000, 800), hasTouch: true, isMobile: true }, "on");
	await openAiSetup(touch, { states: true });
	same(await touch.evaluate(() => [matchMedia("(hover: none)").matches, matchMedia("(max-width: 760px)").matches]), [true, false], "touch 1000: no hover, not a phone");
	await startSignIn(touch);
	const touchRows = await settledRead(() => readRows(touch));
	same([...new Set(touchRows.map((row) => row.fixRight).filter((x) => x !== null))].length, 1, `touch 1000: the fix buttons' right edges (${touchRows.map((row) => row.fixRight).join(", ")})`);
	same(touchRows.filter((row) => row.countInLine === false).map((row) => row.id), [], "touch 1000: a count not ending its status line");
	// A finger 12 above or under "N room models" still reaches it: 44 tall, its line 18.
	const missed = await touch.evaluate(() => [...document.querySelectorAll(".ai-profile-models-toggle")].flatMap((toggle) => {
		toggle.scrollIntoView({ block: "center" });
		const box = toggle.getBoundingClientRect();
		return [box.top - 12, box.bottom + 12].filter((y) => document.elementFromPoint((box.left + box.right) / 2, y)?.closest(".ai-profile-models-toggle") !== toggle).map((y) => `${toggle.textContent} at ${Math.round(y - box.top)}`);
	}));
	same([await touch.locator(".ai-profile-models-toggle").count() > 0, missed], [true, []], "touch 1000: a finger beside the models count's line reaches it");
	const cut = await rowOf(touch, "refused-no-workspace").locator(".ai-profile-sub").evaluate((sub) => {
		const style = getComputedStyle(sub);
		return { over: sub.scrollWidth > sub.clientWidth, line: sub.getBoundingClientRect().height, display: style.display, overflow: style.overflowX, ending: style.textOverflow, nowrap: style.whiteSpace };
	});
	same(cut, { over: true, line: 18, display: "block", overflow: "hidden", ending: "ellipsis", nowrap: "nowrap" }, "touch 1000: the long reason, cut on its one line with an ellipsis");
	await closePage(touch);
	console.log("  ok  provider rows: 64 tall in every state, a ring, a green or amber dot or the spinner beside muted or soft words at 4.5:1, fix buttons ending at one x, the count starting at one x, ··· 28 px, hover, pressed and the ring on each control, the opened models' names alone, both themes; on a touch screen wider than a phone the columns hold, and a reason too long for its line ends in \"…\"");
}

// --- One ink button -----------------------------------------------------------------------

async function inkButtons(page: Page, ink: string): Promise<string[]> {
	return page.evaluate((ink) => {
		const w = window as any;
		return [...document.querySelectorAll(".settings-dialog button")].filter((button) => button.getClientRects().length > 0 && w.__painted(getComputedStyle(button).backgroundColor) && w.__seen(button, getComputedStyle(button).backgroundColor) === ink).map((button) => (button.textContent ?? "").trim());
	}, ink);
}

async function checkInk(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1440, 900, theme), "on");
		const opened = await openAiSetup(page, { states: true });
		const ink = COLOUR[theme].ink;
		const add = opened.locator(".add-provider-toggle");
		same(await settledRead(() => inkButtons(page, ink)), [], `${theme}: the ink buttons`);
		const states = await readStates(page, add);
		assert(states.hover !== states.rest && states.pressed !== states.hover, `${theme}: Add provider's hover and pressed (${states.rest}, ${states.hover}, ${states.pressed})`);
		same(states.ring, [true, "solid", "2px"], `${theme}: Add provider's ring`);
		// A row's key form brings the page's one ink button, its Save key.
		await rowOf(page, KEY_ROW).getByRole("button", { name: "Add API key", exact: true }).click();
		await opened.locator(".ai-profile-key-form input").fill("synthetic-look-key");
		await page.mouse.move(5, 5);
		same(await settledRead(() => inkButtons(page, ink)), ["Save key"], `${theme}, a row's key form: the ink buttons`);
		await opened.locator(".ai-profile-key-form").getByRole("button", { name: "Cancel", exact: true }).click();
		same(await settledRead(() => inkButtons(page, ink)), [], `${theme}, the form closed: the ink buttons`);
		// So does the panel's.
		await add.click();
		await opened.locator(".add-provider-block .settings-row").first().waitFor({ timeout: 15000 });
		await answered(page, `${theme}, the panel`);
		await page.mouse.move(5, 5);
		same(await settledRead(() => inkButtons(page, ink)), [], `${theme}, the panel open: the ink buttons`);
		await opened.locator(".add-provider-block").getByRole("button", { name: "Add key", exact: true }).first().click();
		await opened.locator(".add-provider-row-key-form input").fill("synthetic-look-key");
		await page.mouse.move(5, 5);
		same(await settledRead(() => inkButtons(page, ink)), ["Save key"], `${theme}, the panel's key form: the ink buttons`);
		// The provider's note: 6 px under the field, 12 above the line before the next provider.
		same(await opened.locator(".add-provider-row-group.key-open").evaluate((group) => {
			const field = group.querySelector(".add-provider-row-key-form input")!.getBoundingClientRect();
			const note = group.querySelector(".add-provider-key-note")!.getBoundingClientRect();
			const next = group.nextElementSibling!.getBoundingClientRect();
			return [Math.round(note.top - field.bottom), Math.round(next.top - note.bottom)];
		}), [6, 12], `${theme}, the panel's key form: its note's room above and below`);
		// The filter hides the form, its ink button with it.
		const filter = opened.locator(".add-provider-filter");
		await filter.fill("no provider is called this");
		await opened.locator(".add-provider-row-key-form").waitFor({ state: "detached" });
		same(await settledRead(() => inkButtons(page, ink)), [], `${theme}, the panel's key form filtered away: the ink buttons`);
		await filter.fill("");
		await opened.locator(".add-provider-row-key-form").waitFor();
		await page.mouse.move(5, 5);
		same(await settledRead(() => inkButtons(page, ink)), ["Save key"], `${theme}, the filter cleared: the ink buttons`);
		await opened.locator(".add-provider-row-key-form").getByRole("button", { name: "Cancel", exact: true }).click();
		same(await settledRead(() => inkButtons(page, ink)), [], `${theme}, the panel's form closed: the ink buttons`);
		await closePage(page);
	}
	console.log("  ok  no ink button at rest, Add provider with hover, pressed and the ring; while a row's or the panel's key form shows, its Save key is the one, both themes");
}

// --- Loading -----------------------------------------------------------------------------

async function checkLoading(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1440, 900, theme), "on");
		const hold = new Promise<void>((resolve) => { release = resolve; });
		await openAiSetup(page, { states: true, hold });
		await page.locator(".ai-profile-loading-row").first().waitFor({ timeout: 5000 });
		const read = await page.evaluate((section) => {
			const w = window as any;
			const card = document.querySelector(`${section} .ai-profile-card-loading`)!;
			const sentence = card.querySelector(".ai-profile-card-empty")!;
			const box = sentence.getBoundingClientRect();
			const rows = [...card.querySelectorAll(".ai-profile-loading-row")];
			return {
				waited: w.__barsAt - w.__cardAt,
				first: w.__cardFirst,
				height: card.getBoundingClientRect().height,
				rows: rows.map((row) => [row.getBoundingClientRect().height, ...[...row.children].map((bar) => { const b = bar.getBoundingClientRect(); return `${b.width}x${b.height} ${getComputedStyle(bar).animationName}`; })]),
				hidden: { words: sentence.textContent, size: [box.width, box.height], clip: getComputedStyle(sentence).clip, readerHides: sentence.closest("[aria-hidden=true]") !== null },
				busy: card.getAttribute("aria-busy"),
			};
		}, SECTION);
		assert(read.waited >= 295, `${theme}: the bars came ${Math.round(read.waited)} ms after the card`);
		same(read.first, { height: read.height, edge: "rgba(0, 0, 0, 0)", fill: "rgba(0, 0, 0, 0)" }, `${theme}: before the bars, the card keeps their room with no edge`);
		same(read.rows, [[64, "120x10 none", "180x8 none"], [64, "120x10 none", "180x8 none"], [64, "120x10 none", "180x8 none"]], `${theme}: three rows of bars, no shimmer`);
		same({ ...read.hidden, clip: "" }, { words: "Profile status is still loading.", size: [1, 1], clip: "", readerHides: false }, `${theme}: the sentence, for a screen reader only`);
		same(read.busy, "true", `${theme}: the card says it is loading`);
		if (shots) await page.screenshot({ path: path.join(shots, `loading-${theme}.png`) });
		release!();
		await section(page).locator(".ai-profile-row").first().waitFor({ timeout: 15000 });
		same(await page.locator(".ai-profile-loading-row, .ai-profile-card-loading").count(), 0, `${theme}: the bars gone with the answer`);
		await closePage(page);
	}
	console.log("  ok  loading: no bars for the first 300 ms, the card keeping their room with no edge, then three rows of them, no shimmer, the sentence for a screen reader only, gone with the answer, both themes");
}

// --- Words ----------------------------------------------------------------------------------

async function checkStatusWords(browser: Browser): Promise<void> {
	for (const look of ["off", "on"] as const) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1440), look);
		await openAiSetup(page, { states: true });
		await startSignIn(page);
		const words = await page.evaluate((section) => Object.fromEntries([...document.querySelectorAll(`${section} .ai-profile-row-group`)].map((group) => [group.getAttribute("data-provider-id"), group.querySelector(".ai-profile-sub")!.textContent])), SECTION);
		const want = Object.fromEntries([[BUILTIN_ID, WORDS["signing-in"][look]], ["synthetic", WORDS["key-saved"][look]], ...ORDER.filter((status) => status !== "signed-out" && status !== "key-saved").map((status) => [idOf(status), WORDS[status][look]])]);
		same(words, want, `switch ${look}: the status words`);
		await rowOf(page, "signed-out").getByRole("button", { name: "Cancel", exact: true }).click();
		await rowOf(page, "signed-out").locator(".ai-profile-sub").filter({ hasText: /^signed out$/i }).waitFor();
		same(await rowOf(page, "signed-out").locator(".ai-profile-sub").textContent(), WORDS["signed-out"][look], `switch ${look}: signed out`);
		await closePage(page);
	}
	console.log("  ok  the status words start with a capital with the switch on and are today's with it off");
}

// --- Phone -----------------------------------------------------------------------------------

async function checkPhone(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, phone(theme), "on");
		await openAiSetup(page, { states: true });
		await installReach(page);
		const read = await settledRead(() => page.evaluate((section) => {
			const pane = document.querySelector(".settings-dialog-pane")!;
			const rows = [...document.querySelectorAll(`${section} .ai-profile-row`)].map((row) => {
				const top = (selector: string) => { const element = row.querySelector(selector); return element ? Math.round(element.getBoundingClientRect().top) : null; };
				const middle = (selector: string) => { const element = row.querySelector(selector); if (!element) return null; const box = element.getBoundingClientRect(); return Math.round(box.top + box.height / 2); };
				const name = row.querySelector(".ai-profile-name")!.getBoundingClientRect();
				const sub = row.querySelector(".ai-profile-sub")!.getBoundingClientRect();
				const words = document.createRange();
				words.selectNodeContents(row.querySelector(".ai-profile-sub")!);
				const fix = row.querySelector(".ai-profile-side > .rs-btn")?.getBoundingClientRect();
				const menu = row.querySelector(".ai-profile-menu-btn")!.getBoundingClientRect();
				const box = row.getBoundingClientRect();
				const toggle = row.querySelector(".ai-profile-models-toggle");
				const count = document.createRange();
				if (toggle) count.selectNodeContents(toggle);
				return {
					order: [top(".ai-profile-name"), top(".ai-profile-sub"), middle(".ai-profile-models-toggle")],
					// A count on a line of its own starts on the state's words, the "·" left at the end of theirs.
					wrapped: toggle && toggle.getBoundingClientRect().top >= sub.bottom - 1
						? [Math.round(count.getClientRects()[0].left - words.getClientRects()[0].left), getComputedStyle(toggle, "::before").content, getComputedStyle(row.querySelector(".ai-profile-sub")!, "::after").content.includes("·")]
						: null,
					nameToState: Math.round(sub.top - name.bottom),
					// The state's words end before the button, however they wrap.
					stateClear: fix ? [...words.getClientRects()].every((line) => line.right <= fix.left) : null,
					// The fix button then ···, both on the right edge at one middle.
					fixBesideName: fix ? fix.left >= name.right && fix.right <= menu.left && Math.abs((fix.top + fix.height / 2) - (menu.top + menu.height / 2)) <= 1 : null,
					menuOnRight: Math.round(box.right - menu.right) <= 0 && Math.abs((menu.top + menu.height / 2) - (box.top + box.height / 2)) <= 1,
				};
			});
			const reach = (target: Element): number => (window as any).__reach(target);
			const small = [...document.querySelectorAll(`${section} button, ${section} input`)].filter((target) => target.getClientRects().length > 0).map((target) => [(target.textContent ?? target.getAttribute("aria-label") ?? "").trim(), reach(target)] as const).filter(([, height]) => height < 43.5);
			return { rows, sideways: [document.documentElement.scrollWidth - window.innerWidth, pane.scrollWidth - pane.clientWidth], small };
		}, SECTION));
		for (const [i, row] of read.rows.entries()) {
			const [name, status, count] = row.order;
			assert(name !== null && status !== null && status > name, `${theme}, phone, row ${i + 1}: the state under the name (${row.order.join(", ")})`);
			if (count !== null) assert(count > status, `${theme}, phone, row ${i + 1}: the count under the state (${row.order.join(", ")})`);
			same(row.nameToState, 2, `${theme}, phone, row ${i + 1}: the state 2 px under the name`);
			if (row.wrapped) same(row.wrapped, [0, "none", true], `${theme}, phone, row ${i + 1}: the count on the line under the state's, on its words' edge`);
			if (row.fixBesideName !== null) assert(row.fixBesideName, `${theme}, phone, row ${i + 1}: the button on the right, before ··· and on its middle`);
			if (row.stateClear !== null) assert(row.stateClear, `${theme}, phone, row ${i + 1}: the state's words clear of the button`);
			assert(row.menuOnRight, `${theme}, phone, row ${i + 1}: ··· on the right, on the row's middle`);
		}
		assert(read.rows.some((row) => row.wrapped), `${theme}, phone: a row whose count takes a line of its own`);
		same(read.sideways, [0, 0], `${theme}, phone: sideways scrolling`);
		same(read.small, [], `${theme}, phone: targets under 44 px`);
		if (shots) await page.screenshot({ path: path.join(shots, `phone-${theme}.png`), fullPage: true });
		await closePage(page);
	}
	console.log("  ok  phone: each row's name, the state 2 px under it, then the count; the button and ··· on the right at one middle; nothing scrolls sideways; every target 44 px or more, both themes");
}

// --- The lines under the list -------------------------------------------------------------------

async function readLine(locator: Locator) {
	return locator.evaluate((element) => {
		const w = window as any;
		const style = getComputedStyle(element);
		const dot = getComputedStyle(element, "::before");
		return { words: w.__seen(element, style.color) as string, size: `${style.fontSize}/${style.lineHeight}`, radius: style.borderTopLeftRadius, edge: style.borderTopStyle, dot: [dot.width, dot.height, w.__seen(element, dot.backgroundColor) as string], fill: w.__fill(element) as string, contrast: Number(w.__contrast(element).toFixed(2)) };
	});
}

async function checkLines(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const c = COLOUR[theme];
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1440, 900, theme), "on");
		const opened = await openAiSetup(page, { states: true, refuseSignIn: true, stateMessage: "The saved choice of provider couldn't be read, so the first ready one is used." });
		same(await opened.locator(".ai-defaults-group .group-head").innerText(), "Default models", `${theme}: the words over the default models`);
		// A refused sign-in: the error.
		await rowOf(page, "signed-out").getByRole("button", { name: "Sign in", exact: true }).click();
		const error = opened.locator(":scope > .checkpoint-proposal-error");
		await error.waitFor();
		const red = await readLine(error);
		nearColour(red.words, c.text, `${theme}: the error's words`);
		same([red.size, red.radius, red.edge, red.dot.slice(0, 2)], ["13px/18px", "12px", "none", ["8px", "8px"]], `${theme}: the error, an inline message`);
		assert(red.contrast >= 4.5, `${theme}: the error's words at ${red.contrast}:1`);
		const redHue = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return r - Math.max(g, b); };
		assert(redHue(red.dot[2]) > 60, `${theme}: the error's dot is red (${red.dot[2]})`);
		assert(red.fill !== c.card && red.fill !== (await opened.evaluate((element) => (window as any).__fill(element.closest(".settings-dialog-pane")))), `${theme}: the error on the strip's own fill (${red.fill})`);
		const muted = await readLine(opened.locator(":scope > .cli-note").first());
		nearColour(muted.words, c.muted, `${theme}: a line under the list, muted`);
		same(muted.size, "13px/18px", `${theme}: a line under the list's size`);
		if (shots) await page.screenshot({ path: path.join(shots, `error-${theme}.png`) });
		await closePage(page);
		// A key saved without its check: the notice (a fresh page, since an error line takes the notice's place).
		const again = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1440, 900, theme), "on");
		const fresh = await openAiSetup(again, { states: true });
		await rowOf(again, KEY_ROW).getByRole("button", { name: "Add API key", exact: true }).click();
		await fresh.locator(".ai-profile-key-form input").fill("synthetic-look-key");
		await fresh.locator(".ai-profile-key-form").getByRole("button", { name: "Save key", exact: true }).click();
		const notice = fresh.locator(":scope > .settings-help[role=status]");
		await notice.waitFor();
		await again.mouse.move(5, 5);
		const read = await readLine(notice);
		nearColour(read.words, c.text, `${theme}: the notice's words`);
		same([read.size, read.radius, read.edge, read.dot.slice(0, 2)], ["13px/18px", "12px", "none", ["8px", "8px"]], `${theme}: the notice, an inline message`);
		nearColour(read.dot[2], c.text, `${theme}: the notice's dot, ink`);
		assert(read.contrast >= 4.5, `${theme}: the notice's words at ${read.contrast}:1`);
		if (shots) await again.screenshot({ path: path.join(shots, `notice-${theme}.png`) });
		await closePage(again);
	}
	console.log("  ok  the error and a key's notice are inline messages, a red and an ink dot, their words in the text colour at 4.5:1; the other lines muted, both themes");
}

// --- Pictures, when asked for ---------------------------------------------------------------

async function checkPictures(browser: Browser): Promise<void> {
	if (!shots) return;
	const take = async (page: Page, name: string) => { await page.mouse.move(5, 5); await new Promise((resolve) => setTimeout(resolve, 300)); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
	for (const theme of [LIGHT, DARK] as const) {
		for (const [width, options] of [["desktop", desktop(1440, 900, theme)], ["phone", phone(theme)]] as const) {
			const at = `${width}-${theme}`;
			const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, options, "on");
			const opened = await openAiSetup(page, { states: true });
			await take(page, `${at}-states`);
			// A phone shows the first rows only: the rest of the list too.
			if (width === "phone") {
				await section(page).locator(".ai-profile-row-group").last().scrollIntoViewIfNeeded();
				await take(page, `${at}-states-end`);
			}
			await rowOf(page, "key-saved").locator(".ai-profile-models-toggle").click();
			await rowOf(page, "key-saved").scrollIntoViewIfNeeded();
			await take(page, `${at}-models-open`);
			await rowOf(page, "key-saved").locator(".ai-profile-models-toggle").click();
			await opened.locator(".add-provider-toggle").click();
			await opened.locator(".add-provider-block .settings-row").first().waitFor({ timeout: 15000 });
			await opened.locator(".add-provider-block").getByRole("button", { name: "Add key", exact: true }).first().click();
			await opened.locator(".add-provider-row-key-form input").fill("synthetic-look-key");
			await opened.locator(".add-provider-row-key-form").scrollIntoViewIfNeeded();
			await take(page, `${at}-panel-key-form`);
			await closePage(page);
			const held = await lookPages({ baseUrl, room: ROOM }).openPage(browser, options, "on");
			const hold = new Promise<void>((resolve) => { release = resolve; });
			await openAiSetup(held, { states: true, hold });
			// A build from before the look draws the card alone: its stylesheet has no bars' rule.
			const hasBars = await held.evaluate(() => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule && rule.selectorText.includes(".ai-profile-loading-row"))));
			await section(held).locator(hasBars ? ".ai-profile-loading-row" : ".ai-profile-card").first().waitFor({ timeout: 5000 });
			await take(held, `${at}-loading`);
			release!();
			await closePage(held);
			if (width === "phone") continue;
			const desk = await lookPages({ baseUrl, room: ROOM }).openPage(browser, options, "on");
			const page2 = await openAiSetup(desk, { states: true, refuseSignIn: false });
			await startSignIn(desk);
			await take(desk, `${at}-signing-in`);
			await rowOf(desk, "signed-out").getByRole("button", { name: "Cancel", exact: true }).click();
			await rowOf(desk, "key-saved").locator(".ai-profile-menu-btn").click();
			await desk.locator(".ai-profile-menu").waitFor();
			await take(desk, `${at}-menu`);
			await desk.keyboard.press("Escape");
			const add = page2.locator(".add-provider-toggle");
			await add.hover();
			await new Promise((resolve) => setTimeout(resolve, 300));
			await desk.screenshot({ path: path.join(shots, `${at}-add-hover.png`), clip: { x: 1000, y: 40, width: 440, height: 140 } });
			await desk.mouse.down();
			await new Promise((resolve) => setTimeout(resolve, 300));
			await desk.screenshot({ path: path.join(shots, `${at}-add-pressed.png`), clip: { x: 1000, y: 40, width: 440, height: 140 } });
			const lead = (await desk.locator(".settings-dialog-pane .pane-lead").filter({ visible: true }).first().boundingBox())!;
			await desk.mouse.move(lead.x + 4, lead.y + 4);
			await desk.mouse.up();
			await add.focus();
			await desk.keyboard.press("Shift+Tab");
			await desk.keyboard.press("Tab");
			await new Promise((resolve) => setTimeout(resolve, 300));
			await desk.screenshot({ path: path.join(shots, `${at}-add-focus.png`), clip: { x: 1000, y: 40, width: 440, height: 140 } });
			await rowOf(desk, KEY_ROW).getByRole("button", { name: "Add API key", exact: true }).click();
			await page2.locator(".ai-profile-key-form input").fill("synthetic-look-key");
			await page2.locator(".ai-profile-key-form").getByRole("button", { name: "Save key", exact: true }).click();
			await page2.locator(":scope > .settings-help[role=status]").scrollIntoViewIfNeeded();
			await take(desk, `${at}-key-notice`);
			await closePage(desk);
			const refused = await lookPages({ baseUrl, room: ROOM }).openPage(browser, options, "on");
			await openAiSetup(refused, { states: true, refuseSignIn: true });
			await rowOf(refused, "signed-out").getByRole("button", { name: "Sign in", exact: true }).click();
			await section(refused).locator(":scope > .checkpoint-proposal-error").scrollIntoViewIfNeeded();
			await take(refused, `${at}-error`);
			await closePage(refused);
		}
	}
	console.log(`  ok  pictures in ${shots}`);
}

let server: ChildProcessWithoutNullStreams | null = null;
let model: http.Server | undefined;
try {
	const agents = await import("../src/persistent-agents.js");
	agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	// A model server is never asked here; the app wants one set up to list its models.
	const modelPort = await freePort();
	model = http.createServer((_req, res) => { res.writeHead(500); res.end(); }).listen(modelPort, "127.0.0.1");
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { synthetic: { name: "Synthetic", baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", input: ["text"], contextWindow: 128000, maxTokens: 16384 }, { id: "narrow-model", name: "Narrow Model", input: ["text"], contextWindow: 128000, maxTokens: 16384 }] } } }));
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-synthetic", providerId: "synthetic", label: "Synthetic", roomModels: ["room-model", "narrow-model"], learnModel: "room-model", reviewMemoryModel: "room-model" }] }));
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-synthetic" }));
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
	const saved = await authedFetch(`${baseUrl}/api/auth/api-key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "synthetic", key: "synthetic-test-key" }) });
	assert(saved.ok, `saving the synthetic key: ${saved.status}`);
	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		const failed: string[] = [];
		const only = process.env.LOOK_ROWS?.split(",");
		for (const check of [checkRulesUnderSwitch, checkOff, checkHostedSelectors, checkProviderRows, checkInk, checkLoading, checkStatusWords, checkPhone, checkLines, checkPictures]) {
			if (only && !only.includes(check.name)) continue;
			try {
				await check(browser);
			} catch (error) {
				failed.push(`${check.name}: ${(error as Error).message.split("\n").filter((line, i) => i === 0 || /waiting for/.test(line)).slice(0, 2).join(" ").replace(/\u001b\[\d+m/g, "")}`);
				console.log(`  FAIL ${failed.at(-1)}`);
				release?.();
				for (const context of browser.contexts()) { if (shots) for (const open of context.pages()) await open.screenshot({ path: path.join(shots, `fail-${check.name}.png`) }).catch(() => {}); await context.close(); }
			}
		}
		assert(failed.length === 0, `${failed.length} rows failed:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("settings look ai setup ui smoke passed");
} finally {
	await stopSmokeServer(server);
	model?.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
