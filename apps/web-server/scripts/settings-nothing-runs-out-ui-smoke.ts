// Nothing on Settings or Room settings runs out of its box or over its
// neighbour. Every page of both windows is opened in the states listed here
// (forms, each way a task repeats, refused and failed answers, requests held
// open, long names, long lists), at 1440 and 761, the narrowest desktop width,
// and by touch at 390. A new state is one more line in the list. Each is asked
// the same four things: nothing scrolls sideways; no word or control passes its
// card's inner edge, or the page's where it stands in none; no word lies on a
// control or on another word; and no word is squeezed, broken inside or stacked
// a few letters to a line. Then the two forms where that went wrong, held
// closer: a new profile's refused name, every reason the server gives, and a
// task's form, at 320 too. Offline: the lab's own answers, some stood in for.
// Set LOOK_ROWS to a part of a state's name to run only those, or to "the two
// forms" for the last, and LOOK_SHOTS to a folder for a picture of each state
// that fails.
//
// The list covers every class the windows' components can draw but these:
// - the old look's, which the lookNext branches replace: connector-rooms-words,
//   connector-item-note and its is-error, connector-fact-wrong, connector-fact-line,
//   room-skills-name-row, -live, -desc, -warn and -picker*, room-connector-allowed*,
//   room-connectors-picker-foot, skill-review-head, skill-review-title-block,
//   skill-import-queue, skill-detail-back, web-search-fallback-heading,
//   ai-profile-models-row, settings-dialog-kicker;
// - hidden by the look's own styles: settings-table-head, skill-table-head,
//   skill-upload-input;
// - a conversation's answer alone, which no page of the windows shows:
//   figure-table, figure-maths, figure-strip-plain, mermaid-diagram-writing,
//   mermaid-diagram-code-toggle, mermaid-diagram-writing-code, answer-chart-writing,
//   md-image-button, image-action* and the is-narrow beside them;
// - until the app's own drawing code has loaded, which no answer stands in for:
//   mermaid-diagram-loading*, mermaid-viewer-loading, maths-pending, maths-loading,
//   figure-sweep; a diagram that drew once and fails in its window:
//   mermaid-viewer-error, mermaid-diagram-error-title;
// - is-copied, an icon alone, two seconds after a press;
// - files these windows import only words or a function from:
//   launcher-room-card and model-notice; and ui-spinner, which nothing draws.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { authedFetch, freePort, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { answered, assert, desktop, goToPage, isPhone, lookPages, phone, requestsFromNow, same, type Window } from "./settings-look-smoke-parts.js";
import { closeBrowser, closeContext } from "./smoke-close-context.js";
import { waitEvery } from "./smoke-wait.js";

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings nothing runs out ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const waitUntil = waitEvery(100);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-nothing-runs-out-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const { CONNECTOR_WORDS } = await import("../../web-ui/src/connector-rows.js");
const { ADD_SKILL_WAYS } = await import("../../web-ui/src/skill-source-copy.js");

// Names as long as people give them, with spaces and without.
const ROOM = "Board papers and the monthly reporting for the finance team";
const BARE_ROOM = "Bare Room";
const LONG_WORD = "Quarterly_board_papers_and_the_monthly_reporting_for_2026";
const LONG_SKILL = "w".repeat(48);
const LONG_LINE = "Every figure in an offer comes with the source it was taken from and the day it was read, so that a reader who opens the paper months later can still tell which report it belonged to.";
const LONG_PATH = "/Users/alexandra.example/Library/Mobile Documents/com~apple~CloudDocs/Shared with the finance team/exxperts data/profiles-and-rooms";
const LONG_REASON = `The change could not be saved to ${LONG_PATH}/settings.json because the disk is full, so nothing was changed.`;

const { openPage, openWindow } = lookPages({ baseUrl, room: ROOM });
const bareRoom = lookPages({ baseUrl, room: BARE_ROOM });

// --- The page's own requests, answered here ------------------------------------

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const refused = (status = 500) => json({ error: LONG_REASON }, status);
/** The server's own answer; asked again when the connection it is asked over was just closed for being idle. */
const served = (route: Route) => route.fetch({ maxRetries: 3 });
/** Answers the requests of one method; the others go on to the server. */
const only = (method: string, answer: (route: Route) => unknown) => (route: Route) => route.request().method() === method ? answer(route) : route.fallback();

const day = 86_400_000;
const REMOTE_ON = { enabled: true, address: "100.101.102.103", port: 8443, tunnelAddress: "100.101.102.103", scheme: "https", dnsName: "alexandras-workstation-in-the-northern-office.tail1234.ts.net", tlsFallbackReason: null, degradedReason: null, stateFile: "valid", keepAwake: true };
const REMOTE_OFF = { ...REMOTE_ON, enabled: false, address: null, tunnelAddress: null, scheme: null, dnsName: null, stateFile: "absent", keepAwake: false };
const REMOTE_ROOMS = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, displayName: [ROOM, LONG_WORD, "Desk"][i % 3], exposed: i % 2 === 0, bashEnabled: i % 4 === 0, writeEnabled: i % 4 === 0 }));
const DEVICES = [LONG_WORD, "Alexandra's telephone for travelling between the northern and the southern office", "iPad"].map((name, i) => ({ id: `d${i}`, name, capability: i % 2 ? "read-only" : "full", createdAt: new Date(Date.now() - 9 * day).toISOString(), lastSeenAt: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: "" }));

async function remote(page: Page, over: { status?: unknown; devices?: unknown[]; rooms?: unknown[]; pending?: unknown[]; fail?: boolean } = {}): Promise<void> {
	await page.route("**/api/remote/status", json(over.status ?? REMOTE_ON));
	await page.route("**/api/remote/devices", over.fail ? refused() : json({ devices: over.devices ?? DEVICES }));
	await page.route("**/api/remote/rooms", json({ rooms: over.rooms ?? REMOTE_ROOMS }));
	await page.route("**/api/remote/enroll-pending", json({ pending: over.pending ?? [] }));
	await page.route("**/api/remote/enroll-code", json({ url: `https://${REMOTE_ON.dnsName}:8443/pair`, expiresAt: new Date(Date.now() + 600_000).toISOString() }));
	await page.route("**/api/remote/rooms/exposure", refused());
}

const WEB_SEARCH = { provider: "duckduckgo", baseUrl: "", source: "settings", providerSearch: true, webPages: false, saved: { provider: "duckduckgo", baseUrl: "" }, envProvider: null, unreadable: null };
const SEARXNG = { ...WEB_SEARCH, provider: "searxng", baseUrl: `http://localhost:8080/${LONG_WORD}`, saved: { provider: "searxng", baseUrl: `http://localhost:8080/${LONG_WORD}` } };
async function webSearch(page: Page, payload: unknown, engine: unknown = { phase: "idle", baseUrl: null, message: null, running: false }, put?: (route: Route) => unknown): Promise<void> {
	await page.route("**/api/settings/web-search", (route) => route.request().method() === "GET" ? json(payload)(route) : (put ?? json(payload))(route));
	await page.route("**/api/web-search/searxng/setup", json(engine));
}

const profiles = (names: string[], over: object = {}) => json({ active: null, profiles: names.map((name) => ({ name })), home: { dir: LONG_PATH, defaultDir: LONG_PATH, source: "default", canMove: true }, ...over });
const PROFILE_NAMES = [LONG_WORD, "Client work for the northern region and its partners in 2026", ...Array.from({ length: 10 }, (_, i) => `client-${i}`)];

/** The room's tasks and runs: names long and short, every state a run can have. */
const RUN_STATES = ["succeeded", "failed", "blocked", "running", "queued", "cancelled", "deferred"];
async function tasks(page: Page): Promise<void> {
	await page.route("**/schedules", only("GET", async (route) => {
		const response = await served(route);
		const body = await response.json();
		const job = body.jobs[0];
		const jobs = [...body.jobs, ...RUN_STATES.map((state, i) => ({ ...job, id: `task-${state}`, name: [LONG_WORD, LONG_LINE, state][i % 3], type: "once", schedule: "+30m", prompt: LONG_LINE }))];
		await route.fulfill({ response, json: { ...body, jobs, summary: { ...body.summary, totalCount: jobs.length } } });
	}));
	await page.route("**/background-runs*", only("GET", async (route) => {
		const response = await served(route);
		const body = await response.json();
		const when = new Date(Date.now() - day).toISOString();
		const runs = RUN_STATES.map((status) => ({ runId: `run-${status}`, kind: "scheduled-prompt", status, reason: status === "failed" ? "model_error" : null, message: LONG_LINE, createdAt: when, updatedAt: when, startedAt: when, finishedAt: when, source: { trigger: "schedule-due", scheduleId: `task-${status}`, dueAt: when }, warnings: [], target: { kind: "none" }, scope: { kind: "persistent-room" }, ...(status === "failed" ? { error: { code: "model_error", message: LONG_LINE } } : {}) }));
		await route.fulfill({ response, json: { ...body, runs, latestRuns: runs } });
	}));
}

/** The connectors this computer has: answering, failing, waiting for a sign-in, programs; long names among them. */
const CONNECTORS = [
	{ id: "team-wiki", name: "Team wiki" },
	{ id: "long-name", name: "Quarterly board papers, monthly reporting and the yearly plan" },
	{ id: "long-word", name: LONG_WORD },
	{ id: "office-files", name: "Office files" },
	{ id: "ticket-desk", name: "Ticket desk" },
	{ id: "slow-desk", name: "Slow desk" },
	{ id: "long-address", name: "Long address" },
] as const;

/** The providers in every state, with long names: copies of the saved key's, as the server lists one. */
async function providers(page: Page): Promise<void> {
	const STATES: Array<[string, object, object]> = [
		["signed in", { ready: true }, { configured: true }],
		["setup needed", { ready: false }, { configured: true }],
		["refused", { ready: true }, { configured: true, keyRefused: "refused" }],
		["no workspace", { ready: true }, { configured: true, keyRefused: "no-workspace" }],
		["signed out", { ready: false }, { configured: false }],
		["gone", { ready: true }, { configured: true, keyRefused: "signed-out" }],
	];
	await page.route("**/api/persistent-agent-ai-profile", only("GET", async (route) => {
		const response = await served(route);
		const body = await response.json();
		const saved = body.profiles.find((one: { id: string }) => one.id === "custom-synthetic");
		const copies = STATES.map(([state, over, provider], i) => ({ ...saved, id: `look-${i}`, label: i % 2 ? `${LONG_WORD} ${state}` : `The gateway of the northern region and its partners, ${state}`, ...over, provider: { ...saved.provider, id: `look-${i}`, ...provider } }));
		await route.fulfill({ response, json: { ...body, profiles: [...body.profiles, ...copies] } });
	}));
	await page.route("**/api/auth/providers", only("GET", async (route) => {
		const response = await served(route);
		const body = await response.json();
		await route.fulfill({ response, json: { providers: [...body.providers, { id: "look-1", name: LONG_WORD, authTypes: ["api_key"], configured: true, profileId: "look-1" }, { id: "look-4", name: "Signed out", authTypes: ["api_key"], configured: false, profileId: "look-4" }] } });
	}));
}

/** The one model under a long name, wherever a page reads it. */
async function longModel(page: Page): Promise<void> {
	await page.route(/\/api\/(persistent-agent-room\/model-status|persistent-agent-ai-profile|ai\/defaults|persistent-agents\/[^/]+\/models)(\?|$)/, only("GET", async (route) => {
		const response = await served(route);
		await route.fulfill({ response, body: (await response.text()).replaceAll("Room Model", LONG_WORD) });
	}));
}

/** The model with Recommended after its name, as AI setup's providers list one. */
async function recommended(page: Page): Promise<void> {
	await page.route("**/api/persistent-agent-room/model-status", only("GET", async (route) => {
		const response = await served(route);
		const body = await response.json();
		await route.fulfill({ response, json: { ...body, providers: body.providers.map((provider: { conversation: object[] }) => ({ ...provider, conversation: provider.conversation.map((option) => ({ ...option, recommended: true })) })) } });
	}));
}

/** The rows' model signed out: a sentence beside its name that takes every width it gets. */
async function signedOutModel(page: Page): Promise<void> {
	type Rows = Record<string, { effective?: unknown } | unknown>;
	const signedOut = (rows: Rows): Rows => Object.fromEntries(Object.entries(rows).map(([task, row]) => [task, row && typeof row === "object" && "effective" in row ? { ...row, chosen: row.effective, stored: row.effective, effective: null, reason: "signed-out" } : row]));
	await page.route("**/api/ai/defaults", only("GET", async (route) => {
		const response = await served(route);
		const { defaults } = await response.json() as { defaults: Rows };
		await route.fulfill({ response, json: { defaults: signedOut(defaults) } });
	}));
	// A room's rows come with the room in Home's list.
	await page.route("**/api/persistent-agents", only("GET", async (route) => {
		const response = await served(route);
		const rooms = await response.json() as Array<{ models: Rows }>;
		await route.fulfill({ response, json: rooms.map((one) => ({ ...one, models: signedOut(one.models) })) });
	}));
}

/** Folders and sites a room may use besides its own. */
async function alsoAllowed(page: Page): Promise<void> {
	const list = { folders: [LONG_WORD, "Shared with the finance team in the northern region and its partners", "Notes"].map((name, i) => ({ name, path: `${LONG_PATH}/${name}`, access: i % 2 ? "write" : "read", canAllowChanges: true })), sites: [{ host: `${LONG_WORD.toLowerCase().replaceAll("_", "-")}.example.com`, port: 8443 }, { host: "example.com", port: 443 }] };
	await page.route("**/also-allowed*", only("GET", json(list)));
	await page.route("**/also-allowed/remove", json({ list: { ...list, folders: list.folders.slice(1) } }));
}

// --- The states ------------------------------------------------------------------

const pane = (page: Page) => page.locator(".settings-dialog-pane").filter({ visible: true }).first();
const press = (page: Page, name: string | RegExp, at = 0) => pane(page).getByRole("button", { name, exact: typeof name === "string" }).filter({ visible: true }).nth(at).click();
/** Waits for what a press brings. */
const shows = (page: Page, selector: string) => page.locator(selector).filter({ visible: true }).first().waitFor({ timeout: 10000 });

type State = {
	name: string;
	which: Window;
	label: string;
	/** Answers put in place of the server's before the page loads again. */
	answers?: (page: Page) => Promise<unknown>;
	/** What a person does on the open page. */
	act?: (page: Page) => Promise<unknown>;
	room?: typeof bareRoom;
	/** What is read when it isn't the page: a question, a menu or a window before it. */
	read?: string;
	/** A request held open on purpose: the page as it is while it waits. */
	held?: true;
};
/** An answer that never comes. */
const held = () => {};
const QUESTION = ".confirm-dialog-backdrop .checkpoint-input-card";
const MENU = "body > .ai-profile-menu";
const settings = (label: string, name: string, over: Omit<State, "name" | "which" | "label"> = {}): State => ({ which: "settings", label, name: `Settings, ${label}: ${name}`, ...over });
const room = (label: string, name: string, over: Omit<State, "name" | "which" | "label"> = {}): State => ({ which: "room", label, name: `Room settings, ${label}: ${name}`, ...over });

const addMenu = (page: Page, button: string, way: string) => press(page, button).then(() => page.getByRole("menuitem", { name: way }).click());
const newTask = async (page: Page, mode: string) => {
	await press(page, "New task");
	await pane(page).getByRole("radio", { name: mode, exact: true }).click();
};
const oneTime = (kind: "In" | "At") => async (page: Page) => {
	await newTask(page, "One time");
	await pane(page).getByRole("radio", { name: kind, exact: true }).click();
};
const editTask = async (page: Page, name: string) => {
	await pane(page).locator(".room-schedules-job").filter({ hasText: name }).getByRole("button", { name: "Edit" }).click();
	await shows(page, "form.room-schedules-form");
};
/** A one-time task's edit, opened at its In or its At. */
const editOneTime = (kind: "In" | "At") => async (page: Page) => {
	await editTask(page, "Check the new figures");
	await pane(page).getByRole("radio", { name: kind, exact: true }).click();
};
const diagramSkill = (page: Page) => changed(/\/api\/skills\/pdf(\?|$)/, () => ({ body: ["```mermaid", "flowchart LR", `  A[${LONG_WORD}] --> B[${LONG_LINE}] --> C[Report] --> D[${LONG_WORD}]`, "```", ""].join("\n") }))(page);
const openDiagram = async (page: Page) => {
	await openSkill(page, "pdf");
	await shows(page, ".mermaid-diagram-svg");
	if (await page.locator(".skill-doc-toggle").isVisible()) await page.locator(".skill-doc-toggle").click();
};
const openSkill = async (page: Page, name: string) => {
	await pane(page).locator(".skill-table-row").filter({ has: page.locator(".skill-table-name-text", { hasText: new RegExp(`^${name}$`) }) }).click();
	await shows(page, ".skill-detail");
};
const addConnector = async (page: Page, way: string) => {
	await pane(page).locator(".connector-add-btn").click();
	await page.getByRole("menuitem", { name: way }).click();
	await shows(page, ".connector-custom-form");
};
/** The server's own answer to one GET, some of its fields changed. */
const changed = (url: string | RegExp, change: (body: any) => object) => (page: Page) => page.route(url, only("GET", async (route) => {
	const response = await served(route);
	const body = await response.json();
	await route.fulfill({ response, json: { ...body, ...change(body) } });
}));
/** One connector's status, some of its fields changed. */
const connectorAs = (id: string, over: object) => changed("**/api/mcp/status", (body) => ({ servers: body.servers.map((one: { name: string }) => (one.name === id ? { ...one, ...over } : one)) }));
/** A connector that waits for its sign-in. */
const signInNeeded = changed("**/api/mcp/status", (body) => ({ servers: body.servers.map((one: { name: string; auth: object }) => (one.name === "long-word" ? { ...one, lastCheck: { at: 1, ok: false, needsAuth: true }, auth: { ...one.auth, mode: "oauth", explicit: true, hasStoredTokens: false } } : one)) }));
/** A skill uploaded, with each thing its review can say. */
const UPLOADED = { id: "look-upload", name: LONG_WORD, description: LONG_LINE.repeat(6), body: LONG_LINE, source: "upload", license: LONG_WORD, version: LONG_WORD, scanFindings: [{ index: 2, codePoint: 8203, label: "ZERO WIDTH SPACE", category: "zero-width" }], files: [{ path: `${LONG_PATH.slice(1)}/${LONG_WORD}.py`, kind: "scripts" }], replaces: true, replacesVersion: "v", replacesName: LONG_WORD, outsidePath: `${LONG_PATH}/${LONG_WORD}`, writtenName: LONG_WORD, token: "t" };
const upload = async (page: Page) => {
	await addMenu(page, "Add skill", ADD_SKILL_WAYS.upload);
	await page.locator(".skill-upload-input").setInputFiles({ name: "look.md", mimeType: "text/markdown", buffer: Buffer.from("# look") });
	await shows(page, ".skill-review");
};
/** The list with a skill that can't be read, one whose name is taken, updates waiting and one already updated. */
const skillList = (page: Page) => page.route(/\/api\/skills(\?|$)/, only("GET", async (route) => {
	const response = await served(route);
	const skills = await response.json();
	const changes = { added: [], removed: [], changed: [] };
	await route.fulfill({ response, json: skills.map((one: object, i: number) => ({ ...one, ...(i === 0 ? { unreadable: true } : i === 1 ? { nameTaken: LONG_WORD } : {}), source: "user", update: { state: "available", autoSkipped: {}, updated: { at: new Date().toISOString(), automatic: true, changes, versions: { from: null, to: null } }, candidate: { id: "u", commit: "c", path: "p", filesSha256: "f", changes, versions: { from: null, to: null }, scanFindings: [], hiddenCharacters: false, changedHere: false } } })) });
}));
/** The library as a room lists it: one skill it can't read, one whose name is taken, the rest started by hand, their files elsewhere or not opened. */
const roomSkills = async (page: Page) => {
	await page.route(/\/api\/skills(\?|$)/, only("GET", async (route) => {
		const response = await served(route);
		const skills = await response.json();
		const more = [{ unreadable: true }, { nameTaken: LONG_WORD }, { instructionsOnly: "home" }, { filesAt: `${LONG_PATH}/${LONG_WORD}` }, { scriptsReadOnly: true }];
		await route.fulfill({ response, json: more.map((one, i) => ({ ...skills[i % skills.length], name: `skill-${i}`, displayName: i % 2 ? LONG_WORD : "Monthly figures", description: LONG_LINE, source: "user", fileCount: 4, disableModelInvocation: true, ...one })) });
	}));
	await changed("**/skill-settings", (body) => ({ ...body, skillFiles: "read", skills: [0, 1, 2, 3, 4].map((i) => ({ name: `skill-${i}`, status: "ok", manualOnly: true })) }))(page);
};
/** A newer version of a skill: files it changes, a new description, a check that failed since. */
const updateOf = changed(/\/api\/skills\/pdf(\?|$)/, () => ({ update: { state: "available", missed: { reason: "offline", message: LONG_REASON, host: "git.example.com" }, autoSkipped: {}, candidate: { id: "u", commit: "c", path: "skills/pdf", filesSha256: "f", changes: { added: [{ path: `${LONG_PATH.slice(1)}/${LONG_WORD}.py`, kind: "scripts" }], removed: [{ path: "notes.md", kind: "docs" }], changed: [{ path: LONG_WORD, kind: "docs" }] }, versions: { from: "1.0", to: LONG_WORD }, scanFindings: [{ index: 3, codePoint: 8203, label: "ZERO WIDTH SPACE", category: "zero-width" }], hiddenCharacters: true, description: LONG_LINE, body: LONG_LINE, changedHere: true } } }));
/** The window in which a provider's or a gateway's models are chosen. */
const FORM = ".configure-profile-modal";
/** A provider's models to choose from, with long names. */
async function catalogOf(page: Page): Promise<void> {
	await providers(page);
	await page.route("**/model-catalog*", json({ provider: "look-1", providerLabel: LONG_WORD, suggested: "m-0", note: LONG_LINE, models: [LONG_WORD, "The long model of the northern region and its partners, newest", "Short"].map((name, i) => ({ id: `m-${i}`, name, contextWindow: 272000, suggestedDefault: i === 0 })) }));
}
/** A saved gateway, its models under long names: one that has been adjusted, one that has not. */
async function gatewayOf(page: Page): Promise<void> {
	const models = [LONG_WORD, "The long model of the northern region and its partners, newest"];
	await page.route("**/api/persistent-agent-ai-profile", only("GET", async (route) => {
		const response = await served(route);
		const body = await response.json();
		const saved = body.profiles.find((one: { id: string }) => one.id === "custom-synthetic");
		await route.fulfill({ response, json: { ...body, profiles: [...body.profiles, { ...saved, id: "gateway-look", label: LONG_WORD, kind: "gateway" }] } });
	}));
	const config = { id: "gateway-look", providerId: "gateway-look", label: LONG_WORD, baseUrl: `https://example.com/${LONG_WORD}`, roomModels: models.map((modelId) => ({ modelId, vision: true, webSearch: false, reasoning: true, contextWindow: 272000 })), maintenanceModel: models[0], isDefault: false };
	await page.route("**/gateways/**", (route) => route.request().method() === "GET" ? json(config)(route) : json({ models, detected: models.map((id) => ({ id, vision: true, reasoning: false, contextWindow: 128000, mode: "embedding" })), excludedNonChat: [{ id: LONG_WORD, mode: "embedding" }] })(route));
}
/** A shared server's admin. */
const ADMIN = { remote: false, capability: "full", sharedServer: true, person: { id: "p1", name: "Alex", admin: true }, signOut: null, publicPages: null };
/** A skill's instructions with each thing they can draw, wider than the page. */
const SKILL_BODY = [`# ${LONG_WORD}`, "| Name | What it says | Figure |", "|---|---|---|", `| \`${LONG_WORD}\` | ${LONG_LINE} | 1 |`, "", "```js", `const ${LONG_WORD} = "${LONG_WORD}${LONG_WORD}${LONG_WORD}";`, "```", "", "$$", `${"x_{1} + y^{2} + ".repeat(20)}z`, "$$", "", "```mermaid", "flowchart LR", `  A[${LONG_WORD}] --> B[${LONG_LINE}] --> C[Report] --> D[${LONG_WORD}]`, "```", "", "$$", "\\frac{", "$$", "", "```chart", "type: bar", `title: ${LONG_LINE}`, `note: ${LONG_WORD}`, "Region, Sales", `${LONG_WORD}, 3`, "South, 4", "```", "", `![${LONG_WORD}](https://example.com/${LONG_WORD}.png)`, ""].join("\n");
/** The app open on another device, over remote access. */
const AWAY = { ...ADMIN, remote: true, sharedServer: false, person: null };
/** A change to a room's notes, with a note of each kind of change, and the same for a copy that doesn't read as notes. */
const CHANGED_NOTES = { kind: "learn", eventId: "s1", approvedAt: new Date().toISOString(), notes: true, afterBasis: null, afterVerified: false, conversations: { left: [LONG_WORD], joined: [LONG_LINE] }, topics: [{ section: `Deep Memory / ${LONG_WORD}`, changes: ["added", "updated", "moved", "archived"].map((change, i) => ({ id: `n${i}`, change, before: `${LONG_LINE} ${LONG_WORD}`, after: LONG_LINE, from: LONG_WORD, why: "budget", reason: LONG_LINE })) }] };
const CHANGED_LINES = { ...CHANGED_NOTES, notes: false, topics: undefined, sections: [{ section: LONG_WORD, beforeText: `${LONG_LINE}\n${LONG_WORD}`, afterText: `${LONG_WORD}${LONG_WORD}\n${LONG_LINE}` }] };
const whatChanged = (change: object) => async (page: Page) => { await page.route(/\/memory\/history(\?|$)/, only("GET", json({ history: HISTORY }))); await page.route("**/event-diff*", json(change)); };
const openChange = async (page: Page) => { await pane(page).locator(".memory-history-toggle").first().click(); await shows(page, ".mem-diff"); };
/** A room's saves, newest first: one that can be undone, then one taken back. */
const HISTORY = [{ ts: Date.now(), kind: "learn", saveId: "s1", sessions: 12, title: LONG_WORD, diffable: true }, { ts: Date.now() - day, kind: "review", saveId: "s0", topicsTidied: 4, undone: true, diffable: true }, { ts: Date.now() - 2 * day, kind: "user_edit", operation: "archive_delete", topic: LONG_WORD, saveId: "s2" }];
/** A key saved for a provider under a long name, with no profile of its own. */
async function keyOf(page: Page, configured = true): Promise<void> {
	await page.route("**/api/auth/providers", only("GET", async (route) => {
		const response = await served(route);
		const body = await response.json();
		await route.fulfill({ response, json: { providers: [...body.providers, { id: "look-key", name: LONG_WORD, authTypes: ["api_key"], configured, profileId: null }] } });
	}));
}
/** The providers to add with Copilot's own sign-in among them. */
async function copilotOf(page: Page): Promise<void> {
	await page.route("**/api/auth/providers", only("GET", async (route) => {
		const response = await served(route);
		const body = await response.json();
		await route.fulfill({ response, json: { providers: [...body.providers.filter((one: { id: string }) => one.id !== "github-copilot"), { id: "github-copilot", name: "GitHub Copilot", authTypes: ["oauth"], configured: false, profileId: null }] } });
	}));
}
/** The last provider's or gateway's menu, one of its ways pressed. */
const gatewayMenu = async (page: Page, way: string) => {
	await pane(page).locator(".ai-profile-card [aria-haspopup='menu']").last().click();
	await page.locator(MENU).getByRole("menuitem", { name: way }).click();
	await shows(page, FORM);
};
const approveModels = (page: Page) => gatewayMenu(page, "Approve models");
/** A new gateway's form, its models typed by hand. */
const manualGateway = async (page: Page) => {
	await press(page, "Add provider");
	await press(page, "Add gateway");
	await shows(page, FORM);
	const form = page.locator(FORM);
	await form.getByPlaceholder("Company gateway").fill(LONG_WORD);
	await form.getByPlaceholder("https://litellm.example.com/v1").fill(`https://example.com/${LONG_WORD}`);
	await form.locator("input[type=password]").fill("k".repeat(80));
	await form.getByRole("button", { name: "enter ids manually" }).click();
	await form.locator("textarea").fill(`${LONG_WORD}\nshort-model`);
	await shows(page, `${FORM} .gateway-model-list`);
};
const openModelList = async (page: Page) => {
	await pane(page).locator(".room-model-pick").first().click();
	await shows(page, ".room-model-menu");
};
/** The room's name in its field: on a phone its way in is on the window's own list. */
/** On a phone the room's name stands on the list of pages, before any of them. */
const backOnPhone = async (page: Page) => { if (isPhone(page)) await page.locator(".settings-dialog-back").filter({ visible: true }).click(); };
const rename = async (page: Page) => {
	await backOnPhone(page);
	await page.getByRole("button", { name: "Rename room" }).filter({ visible: true }).first().click();
	await page.locator(".room-settings-rename-input").fill(LONG_WORD);
};
const directoryKey = async (page: Page) => {
	await pane(page).locator(".connector-dir-row").getByRole("button", { expanded: false }).first().click();
	await shows(page, ".connector-dir-token-input");
};
const connectorEdit = (what: "address" | "key") => async (page: Page) => {
	await openConnector(page, "team-wiki");
	await press(page, what === "key" ? CONNECTOR_WORDS.button.changeKey : CONNECTOR_WORDS.button.changeAddress);
	await shows(page, ".connector-edit");
};
const openConnector = async (page: Page, id: string) => {
	const name = CONNECTORS.find((one) => one.id === id)!.name;
	await pane(page).locator(".connector-list .connector-item").filter({ has: page.locator(".connector-item-name-text", { hasText: new RegExp(`^${name}$`) }) }).locator(".connector-item-hit").click({ position: { x: 24, y: 24 } });
	await shows(page, ".connector-page");
};
/** Creating a profile with this name, refused by the server itself. */
const createProfile = (name: string) => async (page: Page) => {
	await pane(page).locator(".state-profile-new input").fill(name);
	await press(page, "Create profile");
	await shows(page, ".state-profile-new .workspaces-error");
};
/** Each reason the server gives for a new profile's name, with a name that gets it. */
const REFUSED_NAMES: Array<[string, string]> = [
	["an empty name", ""],
	["a name too long", "x".repeat(65)],
	["a name with forbidden characters", "a/b"],
	["a name that starts with a dot", ".hidden"],
	["a reserved name", "con"],
	["a name of 57 letters that is taken", LONG_WORD],
];

const STATES: State[] = [
	// Settings, Profiles
	settings("Profiles", "as it is"),
	settings("Profiles", "many, with long names", { answers: (page) => page.route("**/api/settings/state-profile", profiles(PROFILE_NAMES)) }),
	settings("Profiles", "a long name loaded", { answers: (page) => page.route("**/api/settings/state-profile", profiles(PROFILE_NAMES, { active: LONG_WORD })) }),
	settings("Profiles", "could not be read", { answers: (page) => page.route("**/api/settings/state-profile", refused()) }),
	settings("Profiles", "switch asked", { answers: (page) => page.route("**/api/settings/state-profile", profiles(PROFILE_NAMES)), act: (page) => press(page, "Switch") }),
	settings("Profiles", "delete asked", { answers: (page) => page.route("**/api/settings/state-profile", profiles(PROFILE_NAMES)), act: (page) => press(page, "Delete") }),
	settings("Profiles", "delete refused", { answers: async (page) => { await page.route("**/api/settings/state-profile", profiles(PROFILE_NAMES)); await page.route("**/api/settings/state-profile/delete", refused(409)); }, act: async (page) => { await press(page, "Delete"); await press(page, "Delete"); await shows(page, ".state-profiles > .archived-rooms-note"); } }),
	settings("Profiles", "a typed folder", { answers: async (page) => { await page.route("**/api/settings/state-profile", profiles(PROFILE_NAMES)); await page.route("**/api/system/choose-folder", json({ supported: false, cancelled: false, path: null })); }, act: async (page) => { await press(page, "Move"); await shows(page, "input[aria-label='New data folder path']"); } }),
	settings("Profiles", "a typed folder refused", { answers: async (page) => { await page.route("**/api/settings/state-profile", profiles(PROFILE_NAMES)); await page.route("**/api/system/choose-folder", json({ supported: false, cancelled: false, path: null })); await page.route("**/api/settings/state-home/plan", refused(400)); }, act: async (page) => { await press(page, "Move"); await pane(page).locator("input[aria-label='New data folder path']").fill(LONG_PATH); await press(page, "Check"); await shows(page, ".state-profiles.settings-group > .archived-rooms-note"); } }),
	settings("Profiles", "a move asked", { answers: async (page) => { await page.route("**/api/settings/state-profile", profiles(PROFILE_NAMES)); await page.route("**/api/system/choose-folder", json({ supported: true, cancelled: false, path: LONG_PATH })); await page.route("**/api/settings/state-home/plan", json({ dir: LONG_PATH, mode: "migrate", moving: PROFILE_NAMES.slice(0, 2) })); }, act: async (page) => { await press(page, "Move"); await shows(page, ".state-profile-asking"); } }),
	settings("Profiles", "a data folder that can't be moved", { answers: (page) => page.route("**/api/settings/state-profile", profiles(["default"], { home: { dir: LONG_PATH, defaultDir: LONG_PATH, source: "env", canMove: false, reason: LONG_REASON } })) }),
	settings("Profiles", "a name whose reason is one long word", { answers: (page) => page.route("**/api/settings/state-profile/create", json({ error: `A profile named "${"n".repeat(64)}" already exists.` }, 400)), act: createProfile("taken") }),
	...REFUSED_NAMES.map(([name, value]) => settings("Profiles", name, { act: createProfile(value) })),

	// Room settings, Scheduled tasks
	room("Scheduled tasks", "as it is"),
	room("Scheduled tasks", "every run state and long names", { answers: tasks }),
	room("Scheduled tasks", "the room has none", { room: bareRoom }),
	room("Scheduled tasks", "could not be read", { answers: async (page) => { await page.route("**/schedules", refused()); await page.route("**/background-runs*", refused()); } }),
	room("Scheduled tasks", "a new task, Daily", { act: (page) => newTask(page, "Daily") }),
	room("Scheduled tasks", "a new task, Weekly", { act: (page) => newTask(page, "Weekly") }),
	room("Scheduled tasks", "a new task, One time, In", { act: oneTime("In") }),
	room("Scheduled tasks", "a new task, One time, At", { act: oneTime("At") }),
	room("Scheduled tasks", "a new task, Advanced", { act: (page) => newTask(page, "Advanced") }),
	room("Scheduled tasks", "a one-time task's edit, In", { act: editOneTime("In") }),
	room("Scheduled tasks", "a one-time task's edit, At", { act: editOneTime("At") }),
	room("Scheduled tasks", "a weekly task's edit", { act: (page) => editTask(page, "Weekly summary") }),
	room("Scheduled tasks", "a new task, its fields empty", { act: async (page) => { await press(page, "New task"); await press(page, "Save task"); await shows(page, ".settings-needed-line"); } }),
	room("Scheduled tasks", "a new task refused", { answers: (page) => page.route("**/schedules", only("POST", refused(400))), act: async (page) => { await oneTime("In")(page); await pane(page).locator(".room-schedules-form input").first().fill(LONG_WORD); await pane(page).locator(".room-schedules-form textarea").fill(LONG_LINE); await press(page, "Save task"); await shows(page, ".room-schedules-form > .workspaces-error"); } }),
	room("Scheduled tasks", "a task's delete asked", { act: async (page) => { await press(page, "Delete"); await shows(page, ".room-schedules-delete-confirm"); } }),

	// Settings, AI setup
	settings("AI setup", "as it is"),
	settings("AI setup", "every provider state, long names", { answers: providers }),
	settings("AI setup", "a long model name", { answers: longModel }),
	settings("AI setup", "a model signed out", { answers: signedOutModel }),
	settings("AI setup", "its providers never answered", { answers: (page) => page.route("**/api/persistent-agent-ai-profile", only("GET", refused())) }),
	settings("AI setup", "a provider's models", { answers: providers, act: (page) => pane(page).locator(".ai-profile-models-toggle").first().click() }),
	settings("AI setup", "a provider's key", { answers: providers, act: async (page) => { await pane(page).locator(".ai-profile-signin").filter({ hasText: "Add API key" }).first().click(); await shows(page, ".ai-profile-key-form"); } }),
	settings("AI setup", "a sign-in under way", { answers: async (page) => { await providers(page); await page.route("**/api/auth/login", json({ url: "about:blank" })); await page.route("**/api/auth/login/status", json({ pending: true })); }, act: async (page) => { await page.evaluate(() => { window.open = () => null; }); await pane(page).locator(".ai-profile-signin").filter({ hasText: "Sign in" }).first().click(); } }),
	settings("AI setup", "a sign-in refused", { answers: async (page) => { await providers(page); await page.route("**/api/auth/login", refused(502)); }, act: async (page) => { await page.evaluate(() => { window.open = () => null; }); await pane(page).locator(".ai-profile-signin").filter({ hasText: "Sign in" }).first().click(); await shows(page, ".ai-profile-switcher-section > .checkpoint-proposal-error"); } }),
	settings("AI setup", "Add provider", { answers: providers, act: (page) => press(page, "Add provider") }),

	settings("AI setup", "a provider's menu", { answers: providers, act: async (page) => { await pane(page).locator(".ai-profile-card [aria-haspopup='menu']").last().click(); await shows(page, MENU); }, read: MENU }),
	settings("AI setup", "removing a provider asked", { answers: providers, act: async (page) => { await pane(page).locator(".ai-profile-card [aria-haspopup='menu']").last().click(); await page.locator(MENU).getByRole("menuitem", { name: /^Remove/ }).click(); await shows(page, `${MENU} .ai-profile-menu-confirm`); }, read: MENU }),
	settings("AI setup", "the model list", { answers: longModel, act: openModelList, read: ".room-model-menu" }),
	settings("AI setup", "Add provider, a key", { act: async (page) => { await press(page, "Add provider"); await press(page, "Add key"); } }),
	settings("AI setup", "a provider's key refused", { answers: async (page) => { await providers(page); await page.route("**/api/auth/**", (route) => route.request().method() === "GET" ? route.fallback() : refused(400)(route)); }, act: async (page) => { await pane(page).locator(".ai-profile-signin").filter({ hasText: "Add API key" }).first().click(); await pane(page).locator(".ai-profile-key-form input").fill("k".repeat(80)); await press(page, "Save key"); await shows(page, ".add-provider-key-error"); } }),
	settings("AI setup", "a provider's models approved", { answers: catalogOf, act: approveModels, read: FORM }),
	settings("AI setup", "a provider's models, a save refused", { answers: async (page) => { await catalogOf(page); await page.route("**/api/persistent-agent-ai-profiles/custom", only("PUT", refused(400))); }, act: async (page) => { await approveModels(page); await page.locator(`${FORM} .configure-profile-model-option input`).first().check(); await page.locator(FORM).getByRole("button", { name: /^Save/ }).click(); await shows(page, `${FORM} .checkpoint-proposal-error`); }, read: FORM }),
	settings("AI setup", "a provider's models could not be read", { answers: async (page) => { await providers(page); await page.route("**/model-catalog*", refused()); }, act: async (page) => { await approveModels(page); await shows(page, `${FORM} .checkpoint-proposal-error`); }, read: FORM }),
	settings("AI setup", "a gateway's models approved", { answers: gatewayOf, act: approveModels, read: FORM }),
	settings("AI setup", "a gateway that says nothing of its models", { answers: async (page) => { await gatewayOf(page); await page.route("**/gateways/*/discover", json({ models: [LONG_WORD, "short-model"], detected: [] })); }, act: async (page) => { await approveModels(page); await shows(page, `${FORM} .gateway-model-list-hint`); }, read: FORM }),
	settings("AI setup", "a gateway model adjusted, its figure wrong", { answers: gatewayOf, act: async (page) => { await approveModels(page); const form = page.locator(FORM); await form.locator(".gateway-model-adjust").first().click(); await form.getByLabel(`Context window for ${LONG_WORD}`).fill("a lot"); await form.locator(".gateway-model-bulk-row .gateway-model-window-input").fill("a lot"); await shows(page, `${FORM} .gateway-model-window-error`); await shows(page, `${FORM} .gateway-model-bulk-detected`); await shows(page, `${FORM} .gateway-model-detected-note`); }, read: FORM }),
	settings("AI setup", "a shared server's gateway, a new address", { answers: async (page) => { await page.route("**/api/remote/client-context", json(ADMIN)); await gatewayOf(page); }, act: async (page) => { await gatewayMenu(page, "Edit gateway"); const form = page.locator(FORM); await shows(page, `${FORM} .gateway-shared-line`); await form.getByPlaceholder("https://litellm.example.com/v1").fill(`https://other.example.com/${LONG_WORD}`); await form.locator("input[type=password]").fill("k".repeat(80)); await form.getByRole("button", { name: /^Save/ }).click(); await shows(page, `${FORM} .gateway-address-confirm`); }, read: FORM }),
	settings("AI setup", "a shared server's profile, removing it asked", { answers: async (page) => { await page.route("**/api/remote/client-context", json(ADMIN)); await catalogOf(page); }, act: async (page) => { await approveModels(page); await shows(page, `${FORM} .models-run-in-field`); await page.locator(`${FORM} .configure-profile-remove`).click(); await shows(page, `${FORM} .configure-profile-remove-confirm`); }, read: FORM }),
	settings("AI setup", "a shared server's key, removing it asked", { answers: async (page) => { await page.route("**/api/remote/client-context", json(ADMIN)); await keyOf(page); }, act: async (page) => { await press(page, "Add provider"); await pane(page).locator(".add-provider-row-group").filter({ hasText: LONG_WORD }).getByRole("button", { name: /^Remove/ }).click(); await shows(page, ".add-provider-remove-confirm"); } }),
	settings("AI setup", "a saved provider's sign-in, words to follow", { answers: async (page) => { await page.route("**/api/persistent-agent-ai-profile", only("GET", async (route) => { const response = await served(route); const body = await response.json(); const [first, ...rest] = body.profiles; await route.fulfill({ response, json: { ...body, profiles: [{ ...first, label: LONG_WORD, ready: false, provider: { ...first.provider, id: "look-oauth", configured: false } }, ...rest] } }); })); await page.route("**/api/auth/providers", json({ providers: [{ id: "look-oauth", name: LONG_WORD, authTypes: ["oauth"] }] })); await page.route("**/api/auth/login", json({ url: "about:blank", instructions: `${LONG_WORD} ${LONG_LINE}` })); await page.route("**/api/auth/login/status", json({ pending: true })); }, act: async (page) => { await page.evaluate(() => { window.open = () => null; }); await pane(page).locator(".ai-profile-signin").first().click(); await shows(page, ".ai-profile-signin-instructions"); } }),
	settings("AI setup", "a sign-in with words to follow", { answers: async (page) => { await copilotOf(page); await page.route("**/api/auth/login", json({ url: "about:blank", instructions: `${LONG_WORD} ${LONG_LINE}` })); await page.route("**/api/auth/login/status", json({ pending: true })); }, act: async (page) => { await page.evaluate(() => { window.open = () => null; }); await press(page, "Add provider"); const row = pane(page).locator(".add-provider-row-group").filter({ hasText: "GitHub Copilot" }); await row.getByRole("button", { name: "Sign in", exact: true }).click(); await pane(page).locator(".copilot-signin-form").getByRole("button", { name: "Sign in", exact: true }).click(); await shows(page, ".add-provider-instructions"); } }),
	settings("AI setup", "a key added", { answers: async (page) => { await keyOf(page, false); await page.route("**/api/auth/**", (route) => route.request().method() === "GET" ? route.fallback() : json({ ok: true })(route)); await page.route("**/model-catalog*", json({ provider: "look-key", providerLabel: LONG_WORD, suggested: "m-0", models: [{ id: "m-0", name: LONG_WORD, suggestedDefault: true }] })); await page.route("**/api/persistent-agent-ai-profiles/custom", only("PUT", json({ ok: true }))); }, act: async (page) => { await press(page, "Add provider"); const row = pane(page).locator(".add-provider-row-group").filter({ hasText: LONG_WORD }); await row.getByRole("button", { name: "Add key" }).click(); await row.locator("input[type=password]").fill("k".repeat(80)); await row.getByRole("button", { name: "Save key" }).click(); await shows(page, FORM); await page.locator(FORM).getByRole("button", { name: "Save profile" }).click(); await shows(page, ".add-provider-added-note"); } }),
	settings("AI setup", "a provider's models, its sign-in from elsewhere", { answers: changed("**/api/persistent-agent-ai-profile", (body) => ({ profiles: body.profiles.map((one: { provider: object }) => ({ ...one, provider: { ...one.provider, configured: true, source: "environment", label: LONG_WORD } })) })), act: async (page) => { await pane(page).locator(".ai-profile-models-toggle").last().click(); await shows(page, ".ai-profile-models-source"); } }),
	settings("AI setup", "the model list, a key refused", { answers: changed("**/api/persistent-agent-ai-profile", (body) => ({ profiles: body.profiles.map((one: { provider: object }) => ({ ...one, provider: { ...one.provider, keyRefused: "refused" } })) })), act: async (page) => { await openModelList(page); await shows(page, ".room-model-option.marked"); }, read: ".room-model-menu" }),
	settings("AI setup", "the model list, a model too small", { answers: async (page) => { await longModel(page); await changed("**/api/ai/defaults", (body) => ({ defaults: { ...body.defaults, conversation: { ...body.defaults.conversation, tooSmall: [{ provider: "synthetic", model: "room-model", room: LONG_WORD }] } } }))(page); }, act: async (page) => { await openModelList(page); await shows(page, ".room-model-option.unpickable"); await shows(page, ".room-model-menu-note"); }, read: ".room-model-menu" }),
	settings("AI setup", "the model list, empty", { answers: changed("**/api/persistent-agent-room/model-status", () => ({ providers: [] })), act: async (page) => { await openModelList(page); await shows(page, ".room-model-menu-empty"); }, read: ".room-model-menu" }),
	settings("AI setup", "Copilot's company address", { answers: copilotOf, act: async (page) => { await press(page, "Add provider"); await pane(page).locator(".add-provider-row-group").filter({ hasText: "GitHub Copilot" }).getByRole("button", { name: "Sign in", exact: true }).click(); await shows(page, ".copilot-signin-form"); } }),
	settings("AI setup", "a gateway's model ids typed", { act: manualGateway, read: FORM }),
	settings("AI setup", "a gateway's model ids typed, refused", { answers: (page) => page.route("**/api/**/gateways**", (route) => route.request().method() === "GET" ? route.fallback() : refused(400)(route)), act: async (page) => { await manualGateway(page); await page.locator(FORM).getByRole("button", { name: /^(Save|Add)/ }).last().click(); await shows(page, `${FORM} .checkpoint-proposal-error`); }, read: FORM }),
	settings("AI setup", "a gateway added", { act: async (page) => { await press(page, "Add provider"); await press(page, "Add gateway"); await shows(page, ".configure-profile-modal"); }, read: ".configure-profile-modal" }),

	// Settings, Instructions
	settings("Instructions", "as it is"),
	settings("Instructions", "long lines", { answers: (page) => page.route("**/api/settings/instructions", only("GET", async (route) => { const response = await served(route); const body = await response.json(); await route.fulfill({ response, json: { ...body, instructions: { ...body.instructions, text: `${LONG_WORD}${LONG_WORD}\n${LONG_LINE}` } } }); })) }),
	settings("Instructions", "could not be read", { answers: (page) => page.route(/instructions/, only("GET", refused())) }),

	// Settings, Skills
	settings("Skills", "as it is, long names"),
	settings("Skills", "could not be read", { answers: (page) => page.route(/\/api\/skills(\?|$)/, only("GET", refused())) }),
	settings("Skills", "a skill's page", { act: (page) => openSkill(page, "pdf") }),
	settings("Skills", "a skill's page, long name", { act: (page) => openSkill(page, LONG_SKILL) }),
	settings("Skills", "a skill's page, deleting it asked", { act: async (page) => { await openSkill(page, LONG_SKILL); await pane(page).locator(".skill-detail").getByRole("button", { name: "Delete", exact: true }).click(); await shows(page, QUESTION); }, read: QUESTION }),
	settings("Skills", "a skill's page, an update to it", { answers: updateOf, act: (page) => openSkill(page, "pdf") }),
	settings("Skills", "an upload reviewed, everything it can say", { answers: (page) => page.route("**/api/skills/upload", only("POST", json(UPLOADED))), act: async (page) => { await upload(page); await shows(page, ".skill-review-scripts"); await shows(page, ".skill-review-outside"); await shows(page, ".skill-review-replace"); await shows(page, ".skill-review-desc-counter.over"); } }),
	settings("Skills", "an upload reviewed, refused", { answers: async (page) => { await page.route("**/api/skills/upload", only("POST", json({ ...UPLOADED, description: "Short.", replaces: false }))); await page.route("**/api/skills/accept", only("POST", refused(400))); }, act: async (page) => { await upload(page); await pane(page).locator(".skill-review-actions .rs-btn-primary").click(); await shows(page, ".skill-review-error"); } }),
	settings("Skills", "updates waiting, skills it can't use, a notice", { answers: skillList, act: (page) => shows(page, ".skill-auto-notice") }),
	settings("Skills", "Browse featured, not read", { answers: (page) => page.route("**/api/skills/**", (route) => /sources|featured/.test(route.request().url()) ? refused()(route) : route.fallback()), act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.featured); await shows(page, ".skill-browse-error"); } }),
	settings("Skills", "a skill's page, from a link, its files elsewhere", { answers: changed(/\/api\/skills\/pdf(\?|$)/, () => ({ source: "user", provenance: { source: `https://example.com/${LONG_WORD}/${LONG_WORD}`, license: LONG_WORD, importedAt: new Date().toISOString() }, version: LONG_WORD, license: LONG_WORD, disableModelInvocation: true, filesAt: `${LONG_PATH}/${LONG_WORD}`, body: `${LONG_LINE}\n\n`.repeat(40), files: [{ path: `${LONG_WORD}.py`, kind: "scripts" }, { path: `${LONG_PATH.slice(1)}/guide.md`, kind: "references" }], fileCount: 3 })), act: async (page) => { await openSkill(page, "pdf"); await shows(page, ".skill-doc-toggle"); } }),
	settings("Skills", "a skill's page, a table, code, a formula, a diagram and a chart", { answers: changed(/\/api\/skills\/pdf(\?|$)/, () => ({ body: SKILL_BODY })), act: async (page) => { await openSkill(page, "pdf"); await pane(page).locator(".skill-doc-toggle").click(); await shows(page, ".mermaid-diagram-svg"); await shows(page, ".skill-doc .maths-display"); await shows(page, ".skill-doc .maths-as-written"); await shows(page, ".answer-chart-card svg"); } }),
	settings("Skills", "a skill's page, a diagram made larger", { answers: diagramSkill, act: async (page) => { await openDiagram(page); await page.locator(".mermaid-diagram-canvas").click(); await shows(page, ".mermaid-diagram-canvas.enlarged"); } }),
	settings("Skills", "a skill's page, a diagram's code", { answers: diagramSkill, act: async (page) => { await openDiagram(page); await page.locator(".figure-switch-option", { hasText: /code/i }).click(); await shows(page, ".figure-code"); } }),
	settings("Skills", "a skill's page, a diagram in its own window", { answers: diagramSkill, act: async (page) => { await openDiagram(page); await page.getByRole("button", { name: "Open expanded diagram" }).click(); await shows(page, ".mermaid-viewer-svg"); }, read: ".mermaid-viewer-modal" }),
	settings("Skills", "a skill's page, a diagram's code in its own window", { answers: diagramSkill, act: async (page) => { await openDiagram(page); await page.getByRole("button", { name: "Open expanded diagram" }).click(); await page.locator(".mermaid-viewer-actions .icon-btn").click(); await shows(page, ".mermaid-viewer-modal .figure-code-copy"); }, read: ".mermaid-viewer-modal" }),
	settings("Skills", "a skill's page, a diagram that can't be drawn", { answers: changed(/\/api\/skills\/pdf(\?|$)/, () => ({ body: "```mermaid\nflowchart TD\n  A[[[ -->" + LONG_WORD + "\n```\n" })), act: async (page) => { await openSkill(page, "pdf"); await shows(page, ".mermaid-diagram-error-title, .mermaid-fallback"); } }),
	settings("Skills", "a file dragged over Upload", { act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.upload); await shows(page, ".skill-upload-drop"); await page.locator(".skill-upload-drop").dispatchEvent("dragover"); await shows(page, ".skill-upload-drop.dragging"); }, read: ".skill-upload-modal" }),
	settings("Skills", "Browse featured, still reading", { answers: (page) => page.route("**/api/skills/featured*", held), act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.featured); await shows(page, ".skill-browse-loading"); }, held: true }),
	settings("Skills", "From a repository address, still scanning", { answers: (page) => page.route("**/api/skills/repo/scan", held), act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.repository); await pane(page).locator(".skill-import-url").fill(`https://example.com/${LONG_WORD}`); await press(page, "Scan"); await shows(page, ".skill-import-loading"); }, held: true }),
	settings("Skills", "a shared server's library", { answers: (page) => page.route("**/api/remote/client-context", json(ADMIN)), act: (page) => shows(page, ".skill-table-no-rooms") }),
	settings("Skills", "a skill's page, hidden characters in it", { answers: changed(/\/api\/skills\/pdf(\?|$)/, () => ({ scanFindings: Array.from({ length: 14 }, (_, index) => ({ index, codePoint: 8203, label: "ZERO WIDTH SPACE", category: "zero-width" })), description: `${LONG_LINE} ${LONG_LINE} ${LONG_LINE}`, files: [{ path: `${LONG_PATH.slice(1)}/${LONG_WORD}.py`, kind: "scripts" }], fileCount: 2 })), act: (page) => openSkill(page, "pdf") }),
	settings("Skills", "From a repository address, a skill too big, long names", { answers: (page) => page.route("**/api/skills/repo/scan", only("POST", async (route) => { const response = await served(route); const body = await response.json(); await route.fulfill({ response, json: { ...body, skills: body.skills.map((one: object, i: number) => ({ ...one, name: LONG_WORD, path: `${LONG_PATH.slice(1)}/${i}`, ...(i === 0 ? { tooBig: { files: 4000 } } : i === 1 ? { description: "" } : {}) })) } }); })), act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.repository); await pane(page).locator(".skill-import-url").fill(teamRepo); await press(page, "Scan"); await shows(page, ".skill-import-found"); } }),
	settings("Skills", "Write it yourself", { act: (page) => addMenu(page, "Add skill", ADD_SKILL_WAYS.write) }),
	settings("Skills", "Write it yourself, fields empty", { act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.write); await press(page, "Save skill"); await shows(page, ".settings-needed-line"); } }),
	settings("Skills", "Write it yourself, a name with no letters", { act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.write); await pane(page).locator(".skill-write-block input").first().fill("!!!"); await shows(page, ".skill-field-error"); } }),
	settings("Skills", "a skill's page, its name taken", { answers: async (page) => { await skillList(page); await changed(/\/api\/skills\/pdf(\?|$)/, () => ({ nameTaken: LONG_WORD }))(page); }, act: async (page) => { await pane(page).locator(".skill-table-row").first().click(); await shows(page, ".skill-detail-problem"); } }),
	settings("Skills", "Write it yourself, refused", { answers: (page) => page.route("**/api/skills", only("POST", refused(400))), act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.write); const fields = pane(page).locator(".skill-write-block :is(input, textarea)"); for (let i = 0; i < await fields.count(); i++) await fields.nth(i).fill("long words here").catch(() => undefined); await press(page, "Save skill"); await shows(page, ".skill-write-block .checkpoint-proposal-error"); } }),
	settings("Skills", "From a repository address", { act: (page) => addMenu(page, "Add skill", ADD_SKILL_WAYS.repository) }),
	settings("Skills", "From a repository address, empty", { act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.repository); await press(page, "Scan"); await shows(page, ".settings-needed-line"); } }),
	settings("Skills", "From a repository address, failed", { answers: (page) => page.route("**/api/skills/repo/scan", refused(502)), act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.repository); await pane(page).locator(".skill-import-url").fill(`https://example.com/${LONG_WORD}`); await press(page, "Scan"); await shows(page, ".skill-import-from-repo [role=alert], .skill-import-from-repo .workspaces-error, .skill-import-from-repo .checkpoint-proposal-error"); } }),
	settings("Skills", "From a repository address, scanned", { act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.repository); await pane(page).locator(".skill-import-url").fill(teamRepo); await press(page, "Scan"); await shows(page, ".skill-import-found"); } }),
	settings("Skills", "Browse featured, a source failed", { act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.featured); await page.locator(".skill-browse-directory").waitFor({ timeout: 30000 }); } }),
	settings("Skills", "a repository's skill reviewed", { act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.repository); await pane(page).locator(".skill-import-url").fill(teamRepo); await press(page, "Scan"); await pane(page).locator(".skill-import-option").first().click(); await shows(page, ".skill-review"); } }),
	settings("Skills", "a repository's skill added", { answers: (page) => page.route("**/api/skills/repo/import", only("POST", json({ ok: true, name: "x" }))), act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.repository); await pane(page).locator(".skill-import-url").fill(teamRepo); await press(page, "Scan"); await pane(page).locator(".skill-import-option").first().click(); await pane(page).locator(".skill-review-actions .rs-btn-primary").click(); await shows(page, ".skill-import-option-added"); } }),

	settings("Skills", "Add skill's menu", { act: (page) => press(page, "Add skill"), read: ".skill-add-menu" }),
	settings("Skills", "Upload a file", { act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.upload); await shows(page, ".skill-upload-modal"); }, read: ".skill-upload-modal" }),
	settings("Skills", "Upload a file, refused", { answers: (page) => page.route("**/api/skills/**", only("POST", refused(400))), act: async (page) => { await addMenu(page, "Add skill", ADD_SKILL_WAYS.upload); await page.locator(".skill-upload-input").setInputFiles({ name: `${LONG_WORD}.md`, mimeType: "text/markdown", buffer: Buffer.from(`---\nname: ${LONG_SKILL}\ndescription: ${LONG_LINE}\n---\nText.\n`) }); await shows(page, ".skill-message, .checkpoint-proposal-error"); } }),
	settings("Skills", "an update check failed", { answers: (page) => page.route("**/api/skills/updates/check", refused(502)), act: async (page) => { await pane(page).locator(".pane-check-link").first().click(); } }),
	settings("Skills", "a skill's page, deleting it refused", { answers: (page) => page.route("**/api/skills/**", only("DELETE", refused(409))), act: async (page) => { await openSkill(page, "pdf"); await pane(page).locator(".skill-detail").getByRole("button", { name: "Delete", exact: true }).click(); await page.locator(QUESTION).getByRole("button").last().click(); await page.locator(QUESTION).waitFor({ state: "detached" }); } }),

	// Settings, Connectors
	settings("Connectors", "as it is, every state and long names"),
	settings("Connectors", "could not be read", { answers: (page) => page.route("**/api/mcp/status", refused()) }),
	settings("Connectors", "none", { answers: (page) => page.route("**/api/mcp/status", async (route) => { const response = await served(route); await route.fulfill({ response, json: { ...(await response.json()), servers: [] } }); }) }),
	...(["team-wiki", "office-files", "ticket-desk", "long-address"] as const).map((id) => settings("Connectors", `${id}'s page`, { act: (page) => openConnector(page, id) })),
	settings("Connectors", "ticket-desk's page, its technical details open", { act: async (page) => { await openConnector(page, "ticket-desk"); await pane(page).locator("summary").first().click(); } }),
	settings("Connectors", "a connector's page, its tools long", { answers: (page) => page.route("**/api/mcp/status", async (route) => { const response = await served(route); const body = await response.json(); await route.fulfill({ response, json: { ...body, servers: body.servers.map((server: { name: string }) => (server.name === "team-wiki" ? { ...server, tools: { count: 3, names: [LONG_WORD, "create_page", "x"], titles: {}, descriptions: { [LONG_WORD]: LONG_LINE, create_page: LONG_LINE, x: "Short." }, readOnly: [LONG_WORD], cachedAt: 1 } } : server)) } }); }), act: (page) => openConnector(page, "team-wiki") }),
	settings("Connectors", "Add connector's menu", { act: (page) => pane(page).locator(".connector-add-btn").click(), read: MENU }),
	settings("Connectors", "a directory entry's key", { act: directoryKey }),
	settings("Connectors", "a directory entry's key refused", { answers: (page) => page.route("**/api/mcp/servers", only("POST", refused(400))), act: async (page) => { await directoryKey(page); await pane(page).locator(".connector-dir-token-input").fill("k".repeat(80)); await pane(page).locator(".connector-dir-token-row").getByRole("button", { name: "Add", exact: true }).click(); await shows(page, ".connector-dir-note.connector-outcome-error"); } }),
	settings("Connectors", "no directory entry found", { act: async (page) => { await pane(page).locator(".connector-dir-search").fill(LONG_WORD); } }),
	settings("Connectors", "a connector's address changed", { act: connectorEdit("address") }),
	settings("Connectors", "a connector's address refused", { answers: (page) => page.route("**/api/mcp/servers/**", (route) => route.request().method() === "GET" ? route.fallback() : refused(400)(route)), act: async (page) => { await connectorEdit("address")(page); await pane(page).locator(".connector-edit-input").first().fill(`${standInAt("/")}${LONG_WORD}`); await pane(page).locator(".connector-edit .rs-btn-primary").click(); await shows(page, ".connector-edit .connector-row-error"); } }),
	settings("Connectors", "a connector moved to another site", { answers: connectorAs("team-wiki", { movesToAnotherSite: false }), act: async (page) => { await connectorEdit("address")(page); await pane(page).locator(".connector-edit-input").first().fill(`https://example.org/${LONG_WORD}`); await shows(page, ".connector-edit-hint"); } }),
	settings("Connectors", "its choices can't be read", { answers: connectorAs("team-wiki", { choicesUnreadable: "cannot-read" }), act: async (page) => { await openConnector(page, "team-wiki"); await shows(page, ".connector-tools-unreadable"); } }),
	settings("Connectors", "its address not found", { answers: (page) => page.route("**/api/mcp/servers/*/test", json({ at: Date.now(), ok: false, error: LONG_REASON, httpStatus: 404 })), act: async (page) => { await openConnector(page, "team-wiki"); await shows(page, ".connector-status-check"); } }),
	settings("Connectors", "a sign-in it doesn't offer", { answers: async (page) => { await connectorAs("long-word", { lastCheck: { at: 1, ok: true }, auth: { mode: "oauth", explicit: false, hasStoredTokens: false } })(page); await page.route("**/api/mcp/servers/*/test", json({ at: Date.now(), ok: true })); await page.route("**/api/mcp/servers/*/login", (route) => (route.request().method() === "POST" ? json({ started: true, pending: true })(route) : json({ pending: false, cause: "no-sign-in" })(route))); }, act: async (page) => { await openConnector(page, "long-word"); await pane(page).getByRole("button", { name: CONNECTOR_WORDS.button.signIn, exact: true }).first().click(); await shows(page, ".connector-fact-note"); } }),
	settings("Connectors", "a check under way", { act: async (page) => { await page.route("**/api/mcp/servers/*/test", held); await openConnector(page, "team-wiki"); await pane(page).locator(".connector-slot-btn").first().click(); await shows(page, ".connector-slot-btn.is-busy"); }, held: true }),
	settings("Connectors", "brought in from another app", { answers: connectorAs("team-wiki", { source: { path: LONG_PATH, kind: "import", importKind: "claude-desktop", importFile: `${LONG_PATH}/claude_desktop_config.json` } }), act: async (page) => { await openConnector(page, "team-wiki"); await shows(page, ".connector-note"); } }),
	settings("Connectors", "a sign-in under way", { answers: signInNeeded, act: async (page) => { await page.route("**/api/mcp/servers/*/login", (route) => (route.request().method() === "POST" ? json({ started: true, pending: true })(route) : json({ pending: true })(route))); await pane(page).locator(".connector-list > .connector-item").filter({ hasText: LONG_WORD }).locator(".connector-item-side button").click(); await shows(page, ".connector-waiting-foot"); } }),
	settings("Connectors", "a connector's page, its sign-in under way", { answers: signInNeeded, act: async (page) => { await page.route("**/api/mcp/servers/*/login", (route) => (route.request().method() === "POST" ? json({ started: true, pending: true })(route) : json({ pending: true })(route))); await openConnector(page, "long-word"); await pane(page).locator(".connector-slot-btn").first().click(); await shows(page, ".connector-status-note"); } }),
	settings("Connectors", "a program whose runtime is missing", { answers: connectorAs("office-files", { lastCheck: { at: 1, ok: false, error: LONG_REASON, programFailure: { cause: "runtime-missing", runtime: "node" } } }), act: async (page) => { await shows(page, ".connector-way-link"); await openConnector(page, "office-files"); await shows(page, ".connector-way-link"); } }),
	settings("Connectors", "a connector added", { answers: async (page) => { await page.route("**/api/mcp/servers", only("POST", json({ name: "team-wiki" }))); await page.route("**/api/mcp/servers/*/test", json({ ok: true })); }, act: async (page) => { await addConnector(page, CONNECTOR_WORDS.addWays.web); const form = pane(page).locator(".connector-custom-form"); await form.locator("input").nth(0).fill(LONG_WORD); await form.locator("input").nth(1).fill("https://example.com/mcp"); await press(page, CONNECTOR_WORDS.form.add); await shows(page, ".connector-notice"); } }),
	settings("Connectors", "a connector's key changed", { act: connectorEdit("key") }),
	settings("Connectors", "a tool's choices", { act: async (page) => { await openConnector(page, "team-wiki"); await pane(page).locator(".connector-choice-btn").first().click(); await shows(page, MENU); }, read: MENU }),
	settings("Connectors", "a tool's choice refused", { answers: (page) => page.route("**/api/mcp/**", (route) => route.request().method() === "GET" ? route.fallback() : refused(500)(route)), act: async (page) => { await openConnector(page, "team-wiki"); await pane(page).locator(".connector-choice-btn").first().click(); await page.locator(MENU).getByRole("menuitemradio").last().click(); } }),
	settings("Connectors", "removing a connector asked", { act: async (page) => { await openConnector(page, "long-word"); await pane(page).getByRole("button", { name: CONNECTOR_WORDS.button.remove, exact: true }).last().click(); await shows(page, QUESTION); }, read: QUESTION }),
	settings("Connectors", "removing a connector refused", { answers: (page) => page.route("**/api/mcp/**", only("DELETE", refused(500))), act: async (page) => { await openConnector(page, "long-word"); await pane(page).getByRole("button", { name: CONNECTOR_WORDS.button.remove, exact: true }).last().click(); await page.locator(QUESTION).getByRole("button").last().click(); await page.locator(QUESTION).waitFor({ state: "detached" }); } }),
	settings("Connectors", "by web address, its fold open", { act: async (page) => { await addConnector(page, CONNECTOR_WORDS.addWays.web); await pane(page).locator(".connector-custom-form [aria-expanded='false']").first().click(); } }),
	settings("Connectors", "by web address", { act: (page) => addConnector(page, CONNECTOR_WORDS.addWays.web) }),
	settings("Connectors", "as a program", { act: (page) => addConnector(page, CONNECTOR_WORDS.addWays.program) }),
	settings("Connectors", "by web address, empty", { act: async (page) => { await addConnector(page, CONNECTOR_WORDS.addWays.web); await press(page, CONNECTOR_WORDS.form.add); await shows(page, ".settings-needed-line"); } }),
	settings("Connectors", "by web address, refused", { answers: (page) => page.route("**/api/mcp/servers", only("POST", refused(400))), act: async (page) => { await addConnector(page, CONNECTOR_WORDS.addWays.web); const fields = pane(page).locator(".connector-custom-form input:not([type=checkbox], [type=radio])"); await fields.nth(0).fill(LONG_WORD); await fields.nth(1).fill(`https://example.com/${LONG_WORD}/mcp`); await press(page, CONNECTOR_WORDS.form.add); await shows(page, ".connector-custom-form [role=alert], .connector-custom-form .connector-form-error, .connector-custom-form .workspaces-error, .connector-custom-form .checkpoint-proposal-error"); } }),
	settings("Connectors", "a shared server's short page", { answers: (page) => page.route("**/api/remote/client-context", json({ remote: false, sharedServer: true })) }),
	settings("Connectors", "over remote access, read only", { answers: (page) => page.route("**/api/remote/client-context", json({ remote: true, capability: "read-only" })) }),

	// Settings, Web search
	settings("Web search", "as it is"),
	settings("Web search", "an engine being saved", { answers: (page) => webSearch(page, SEARXNG, undefined, held), act: async (page) => { await pane(page).locator(".settings-row-choice").filter({ hasText: "DuckDuckGo" }).first().click(); await shows(page, ".settings-row.pending"); }, held: true }),
	settings("Web search", "a long address", { answers: (page) => webSearch(page, SEARXNG) }),
	settings("Web search", "an engine picked, not saved yet", { answers: (page) => webSearch(page, WEB_SEARCH), act: async (page) => { await pane(page).locator(".settings-row-choice").filter({ hasText: "SearXNG" }).first().click(); await shows(page, ".web-search-pending-note"); } }),
	settings("Web search", "an engine that failed to start", { answers: (page) => webSearch(page, SEARXNG, { phase: "error", baseUrl: null, message: LONG_REASON, running: false }) }),
	settings("Web search", "an engine starting", { answers: (page) => webSearch(page, SEARXNG, { phase: "starting", baseUrl: null, message: LONG_LINE, running: true }) }),
	settings("Web search", "a save refused", { answers: (page) => webSearch(page, SEARXNG, undefined, refused()), act: async (page) => { await press(page, "Save"); await shows(page, "section[aria-label='Web search'] [role=alert], section[aria-label='Web search'] .workspaces-error"); } }),
	settings("Web search", "set by the environment", { answers: (page) => webSearch(page, { ...SEARXNG, source: "environment", envProvider: "searxng" }) }),
	settings("Web search", "could not be read", { answers: (page) => page.route("**/api/settings/web-search", refused()) }),

	// Settings, Appearance
	settings("Appearance", "as it is"),

	// Settings, Remote access
	settings("Remote access", "off", { answers: (page) => remote(page, { status: REMOTE_OFF, devices: [], rooms: [] }) }),
	settings("Remote access", "on, many rooms, long names", { answers: remote }),
	settings("Remote access", "degraded", { answers: (page) => remote(page, { status: { ...REMOTE_ON, enabled: false, degradedReason: LONG_REASON, tlsFallbackReason: LONG_REASON } }) }),
	settings("Remote access", "a code to scan", { answers: async (page) => { await remote(page); await page.route("**/api/remote/enroll-code", json({ url: `https://${REMOTE_ON.dnsName}:8443/pair`, expiresAt: new Date(Date.now() + 600_000).toISOString(), matrix: Array.from({ length: 29 }, (_, y) => Array.from({ length: 29 }, (_, x) => (x * y) % 3 === 0)) })); }, act: (page) => shows(page, ".remote-pairing-qr") }),
	settings("Remote access", "a pairing waiting", { answers: (page) => remote(page, { pending: [{ requestId: "q1", deviceName: LONG_WORD, createdAt: new Date().toISOString() }] }), act: (page) => shows(page, ".remote-pending-row") }),
	settings("Remote access", "its folds open", { answers: (page) => remote(page, { status: { ...REMOTE_ON, scheme: "http", tlsFallbackReason: LONG_REASON } }), act: async (page) => { for (const fold of await pane(page).locator("summary").all()) await fold.click(); } }),
	settings("Remote access", "a device's removal asked", { answers: remote, act: (page) => press(page, "Revoke") }),
	settings("Remote access", "could not be read", { answers: (page) => page.route("**/api/remote/status", refused()) }),

	// Room settings, Model, Memory, Instructions
	room("Model", "as it is"),
	room("Model", "a long model name", { answers: longModel }),
	room("Model", "signed out", { answers: signedOutModel }),
	room("Model", "could not be read", { answers: (page) => page.route("**/api/persistent-agent-room/model-status", only("GET", refused())), act: (page) => shows(page, ".room-model-error") }),
	room("Model", "the model list", { answers: longModel, act: openModelList, read: ".room-model-menu" }),
	room("Model", "a shared server's member, two providers in the list", { answers: async (page) => { await page.route("**/api/remote/client-context", json({ ...ADMIN, person: { ...ADMIN.person, admin: false } })); await changed("**/api/persistent-agent-room/model-status", (body) => ({ providers: [...body.providers.map((one: { conversation: object[] }) => ({ ...one, runsIn: "eu", conversation: one.conversation.map((option) => ({ ...option, recommended: true })) })), ...body.providers.map((one: object) => ({ ...one, id: "second", label: LONG_WORD, runsIn: "unknown" }))] }))(page); }, act: async (page) => { await openModelList(page); await shows(page, ".models-run-in-note"); await shows(page, ".room-model-menu .models-run-in"); await shows(page, ".room-model-option-tag"); await shows(page, ".room-model-pick-provider"); }, read: ".room-model-menu" }),
	room("Model", "its provider refused the key", { answers: changed("**/api/persistent-agent-ai-profile", (body) => ({ profiles: body.profiles.map((one: { provider: object }) => ({ ...one, provider: { ...one.provider, keyRefused: "refused" } })) })), act: (page) => shows(page, ".room-model-refused") }),
	room("Memory", "as it is, long notes"),
	room("Memory", "a note moved", { act: async (page) => { await pane(page).locator(".memory-topic-head").first().click(); await press(page, "Move"); } }),
	room("Memory", "a note's save refused", { answers: (page) => page.route(/\/memory\//, (route) => route.request().method() === "GET" ? route.fallback() : refused(409)(route)), act: async (page) => { await pane(page).locator(".memory-topic-head").first().click(); await press(page, "Edit"); await pane(page).locator("textarea").first().fill(LONG_LINE); await press(page, "Save"); } }),
	room("Memory", "no note found", { act: (page) => pane(page).locator("input[type='search']").first().fill(LONG_WORD) }),
	room("Memory", "a topic open", { act: (page) => pane(page).locator(".memory-topic-head").first().click() }),
	room("Memory", "over its limit, a note in parts", { answers: async (page) => { await changed(/\/memory\/entries(\?|$)/, (body) => ({ budget: { ...body.budget, reviewTargetTokens: 999_000, liveTokens: 999_000 }, topics: body.topics.map((topic: { entries: object[] }) => ({ ...topic, entries: topic.entries.map((entry) => ({ ...entry, text: `${LONG_LINE}\n\n- ${LONG_WORD}\n- ${LONG_LINE}\n\n${LONG_WORD}` })) })) }))(page); }, act: async (page) => { await pane(page).locator(".memory-topic-head").first().click(); await shows(page, ".memory-entry-gap"); await shows(page, ".memory-budget-over"); } }),
	room("Memory", "its history, a save undone, an undo refused", { answers: async (page) => { await page.route(/\/memory\/history(\?|$)/, only("GET", json({ history: HISTORY }))); await page.route(/\/memory\/undo$/, refused(409)); }, act: async (page) => { await shows(page, ".memory-history-undone"); await press(page, "Undo"); await shows(page, ".room-memory-history .room-maintenance-error"); } }),
	room("Memory", "its history, undone with a lower limit", { answers: async (page) => { await page.route(/\/memory\/history(\?|$)/, only("GET", json({ history: HISTORY }))); await page.route(/\/memory\/undo$/, json({ ok: true, limitLoweredTo: 24000, openConversationKeepsMemory: true })); }, act: async (page) => { await press(page, "Undo"); await shows(page, ".room-memory-history .memory-history-status"); } }),
	room("Memory", "what a save changed", { answers: whatChanged(CHANGED_NOTES), act: openChange }),
	room("Memory", "what a save changed, its lines", { answers: whatChanged(CHANGED_LINES), act: openChange }),
	room("Memory", "what a save changed, full screen", { answers: whatChanged(CHANGED_NOTES), act: async (page) => { await openChange(page); await pane(page).locator(".mem-close").click(); await shows(page, ".mem-fullscreen"); }, read: ".mem-fullscreen" }),
	room("Memory", "what a save changed, not read", { answers: async (page) => { await whatChanged(CHANGED_NOTES)(page); await page.route("**/event-diff*", refused()); }, act: async (page) => { await pane(page).locator(".memory-history-toggle").first().click(); await shows(page, ".memory-history-change"); } }),
	room("Memory", "a note edited", { act: async (page) => { await pane(page).locator(".memory-topic-head").first().click(); await press(page, "Edit"); } }),
	room("Memory", "a note's delete asked", { act: async (page) => { await pane(page).locator(".memory-topic-head").first().click(); await press(page, "Delete"); } }),
	room("Memory", "a new note", { act: (page) => press(page, "Add note") }),
	room("Memory", "its archive", { act: (page) => pane(page).locator(".memory-archive-head .pane-head-actions .rs-btn").click() }),
	room("Memory", "could not be read", { answers: (page) => page.route(/\/memory\//, only("GET", refused())) }),
	room("Memory", "nothing in it", { room: bareRoom }),
	room("Instructions", "as it is"),
	room("Instructions", "could not be read", { answers: (page) => page.route(/instructions/, only("GET", refused())) }),
	room("Instructions", "too long, with hidden characters", { act: async (page) => { await pane(page).locator("textarea").fill(`${LONG_LINE.repeat(200)}\u0001\u0002`); await shows(page, ".room-instructions-controls"); await shows(page, ".room-instructions-count.over"); } }),
	room("Instructions", "saved, then its switch", { answers: (page) => page.route(/\/instructions(\/global)?$/, only("PUT", async (route) => { const url = route.request().url(); const current = await page.request.get(url.replace(/\/global$/, "")); const body = await current.json(); await json({ ...body, instructions: { ...body.instructions, text: LONG_LINE.trim(), updatedAt: new Date().toISOString() }, ...(url.endsWith("/global") ? { global: { ...body.global, enabled: false } } : {}) })(route); })), act: async (page) => { await pane(page).locator("textarea").fill(LONG_LINE); await press(page, "Save"); await shows(page, ".room-instructions-state"); await pane(page).locator(".workspaces-tool-switch").filter({ visible: true }).click(); await shows(page, ".workspaces-success"); } }),
	room("Instructions", "the global text open, the room's unreadable", { answers: changed(/\/instructions(\?|$)/, (body) => ({ instructions: { ...body.instructions, text: "", unreadable: LONG_REASON }, global: { instructions: { text: `${LONG_LINE}\n${LONG_WORD}${LONG_WORD}`, fingerprint: null, updatedAt: null }, enabled: true, updatedAt: null } })), act: async (page) => { await pane(page).locator(".room-instructions-global-toggle").click(); await shows(page, ".room-instructions-global-text"); } }),
	room("Instructions", "closed with unsaved changes", { act: async (page) => { await pane(page).locator("textarea").fill(LONG_LINE); await page.locator(".settings-dialog-close").filter({ visible: true }).first().click(); await shows(page, ".confirm-dialog-three"); }, read: QUESTION }),

	// Room settings, Folder
	room("Folder", "as it is, a long folder name"),
	room("Folder", "none yet", { room: bareRoom }),
	room("Folder", "typed, no picker", { room: bareRoom, answers: (page) => page.route("**/api/system/choose-folder", json({ error: "No folder window here.", code: "unsupported_platform" }, 501)), act: async (page) => { await press(page, "Choose folder"); await shows(page, ".folder-pane-typed"); } }),
	room("Folder", "a change refused", { answers: (page) => page.route("**/workspace-default", only("PUT", refused(409))), act: async (page) => { await pane(page).locator(".workspaces-tool-switch").first().click(); } }),
	room("Folder", "folders and sites allowed besides", { answers: alsoAllowed }),
	room("Folder", "a folder taken off the list", { answers: alsoAllowed, act: (page) => pane(page).locator(".also-allowed .also-allowed-row .also-allowed-cross").first().click() }),
	room("Folder", "a folder already on the list", { answers: async (page) => { await alsoAllowed(page); await page.route("**/also-allowed/folders", only("POST", async (route) => { const list = await page.evaluate((url) => fetch(url).then((answer) => answer.json()), route.request().url().replace(/\/folders$/, "")); await json({ list, state: "already", line: `${LONG_WORD} ${LONG_LINE}` })(route); })); }, act: async (page) => { await pane(page).locator(".also-allowed-add").click(); await shows(page, ".also-allowed-line"); } }),
	room("Folder", "a folder being taken off the list", { answers: async (page) => { await alsoAllowed(page); await page.route("**/also-allowed/remove", held); }, act: async (page) => { await pane(page).locator(".also-allowed .also-allowed-row .also-allowed-cross").first().click(); await shows(page, ".also-allowed-saving"); }, held: true }),
	room("Folder", "a change being saved", { answers: (page) => page.route("**/workspace-default", only("PUT", held)), act: async (page) => { await pane(page).locator(".workspaces-tool-switch").filter({ visible: true }).first().click(); await shows(page, ".folder-pane-saving"); }, held: true }),
	room("Folder", "a typed path refused", { room: bareRoom, answers: async (page) => { await page.route("**/api/system/choose-folder", json({ error: "No folder window here.", code: "unsupported_platform" }, 501)); await page.route("**/workspace-default", only("PUT", refused(400))); }, act: async (page) => { await press(page, "Choose folder"); await pane(page).locator(".folder-pane-typed input").fill(LONG_PATH); await pane(page).locator(".folder-pane-typed button[type='submit']").click(); } }),
	room("Folder", "not found", { answers: changed("**/workspace-default", () => ({ warnings: [LONG_REASON], shellMissingNote: LONG_LINE })), act: (page) => shows(page, ".folder-pane-not-found") }),
	room("Folder", "not found, on a phone", { answers: async (page) => { await page.route("**/api/remote/client-context", json(AWAY)); await changed("**/workspace-default", () => ({ warnings: [LONG_REASON] }))(page); }, act: (page) => shows(page, ".folder-pane-location .settings-row-tag") }),
	room("Folder", "stop using it asked", { act: async (page) => { await pane(page).getByRole("button", { name: "Stop using this folder" }).first().click(); await shows(page, QUESTION); }, read: QUESTION }),
	room("Folder", "could not be read", { answers: (page) => page.route("**/workspace-default", only("GET", refused())) }),

	// Room settings, Skills and Connectors
	room("Skills", "as it is, long names"),
	room("Skills", "could not be read", { answers: (page) => page.route("**/skill-settings", only("GET", refused())) }),
	room("Skills", "a switch refused", { answers: (page) => page.route("**/skill-settings", only("PUT", refused())), act: async (page) => { await pane(page).getByRole("switch").first().click(); } }),
	room("Skills", "skills it can't use, started by hand, files elsewhere", { answers: roomSkills, act: async (page) => { await shows(page, ".room-skill-open"); await shows(page, ".room-skill-how"); await shows(page, ".room-skills-files"); } }),
	room("Connectors", "as it is, every state and long names"),
	room("Skills", "none found", { act: async (page) => { await pane(page).locator(".room-skills-search").fill(LONG_WORD); await shows(page, ".room-skills-empty"); } }),
	room("Connectors", "its archived room", { answers: (page) => page.route("**/mcp-connectors", only("GET", refused(410))), act: (page) => shows(page, ".is-archived") }),
	room("Connectors", "answers kept for tools", { answers: changed("**/mcp-connectors", (body) => ({ allowedTools: Object.fromEntries(body.granted.map((one: { name: string }) => [one.name, [{ tool: "t", shown: LONG_WORD }, { tool: "u", shown: "Read the monthly figures of the northern region and its partners" }]])) })), act: (page) => shows(page, ".room-connector-answer") }),
	room("Connectors", "one gone, one whose name rooms can't take", { answers: changed("**/mcp-connectors", (body) => ({ configuredConnectors: [...body.configuredConnectors, `${LONG_WORD} and its partners`], granted: [...body.granted, { name: LONG_WORD, configured: false }] })), act: (page) => shows(page, ".room-skills-row.is-wrapping") }),
	room("Connectors", "none on", { room: bareRoom }),
	room("Connectors", "could not be read", { answers: (page) => page.route("**/mcp-connectors", only("GET", refused())) }),
	room("Connectors", "a switch refused", { answers: (page) => page.route("**/mcp-connectors", only("PUT", refused())), act: async (page) => { await pane(page).getByRole("switch").first().click(); } }),

	// Room settings, Conversation, Archive or delete, the room's name
	room("Conversation", "as it is"),
	room("Conversation", "its tip", { act: async (page) => { await pane(page).locator(".rs-info").filter({ visible: true }).first().focus(); await shows(page, ".rs-info-tip"); }, read: ".rs-info-tip" }),
	room("Conversation", "none open", { room: bareRoom }),
	room("Conversation", "forget asked", { act: async (page) => { await press(page, "Forget"); await shows(page, QUESTION); }, read: QUESTION }),
	room("Conversation", "forget refused", { answers: (page) => page.route("**/memento", refused(409)), act: async (page) => { await press(page, "Forget"); await page.locator(QUESTION).getByRole("button").last().click(); await page.locator(QUESTION).waitFor({ state: "detached" }); } }),
	room("Archive or delete", "as it is"),
	room("Archive or delete", "delete asked", { act: async (page) => { await pane(page).getByRole("button", { name: "Delete room" }).click(); await shows(page, QUESTION); }, read: QUESTION }),
	room("Archive or delete", "renaming it", { act: rename, read: ".room-settings-rename-form" }),
	room("Archive or delete", "its state beside its name", { answers: (page) => page.route(/\/api\/persistent-agents(\?|$)/, only("GET", async (route) => { const response = await served(route); const all = await response.json(); await route.fulfill({ response, json: all.map((one: object) => ({ ...one, status: "needs_absorb" })) }); })), act: async (page) => { await backOnPhone(page); await shows(page, ".room-settings-status"); }, read: ".settings-dialog-heading" }),
	room("Archive or delete", "a rename with no name", { act: async (page) => { await rename(page); await page.locator(".room-settings-rename-input").fill(""); await shows(page, ".room-settings-rename-hint"); }, read: ".settings-dialog-head" }),
	room("Archive or delete", "a rename that changes memory", { answers: (page) => page.route(/\/rename/, json({ memoryMentions: { count: 3, lines: [1, 2, 3].map((line) => ({ line, text: `${LONG_WORD} ${ROOM} ${LONG_LINE}` })) } })), act: async (page) => { await rename(page); await page.locator(".room-settings-rename-form button[type='submit']").click(); await shows(page, ".room-settings-rename-preview"); }, read: ".settings-dialog-head-note" }),
	room("Archive or delete", "a rename refused", { answers: (page) => page.route(/\/rename/, refused(409)), act: async (page) => { await rename(page); await page.locator(".room-settings-rename-form button[type='submit']").click(); await shows(page, ".settings-dialog-head-note"); }, read: ".settings-dialog-head-note" }),
	room("Archive or delete", "archive refused", { answers: (page) => page.route(/\/api\/persistent-agents\/[^/]+\/archive/, refused(409)), act: async (page) => { await press(page, "Archive"); } }),
];

// --- What is asked of every state -------------------------------------------------

type Fault = string;

/** The faults of what is read (the open page, or what stands before it), or of the parts of it named, one line each, empty when nothing runs out or over: see the file's head. */
async function faultsOf(page: Page, read = ".settings-dialog-pane", parts = "*"): Promise<Fault[]> {
	return page.evaluate(({ read, parts }) => {
		type Box = { left: number; right: number; top: number; bottom: number };
		const found: string[] = [];
		const open = [...document.querySelectorAll(read)].find((one) => one.getClientRects().length > 0);
		if (!open) return [`nothing shows at ${read}`];
		// Read from its top, where the title line lies over nothing.
		open.scrollTop = 0;
		const said = (element: Element) => `${element.tagName.toLowerCase()}.${String((element as HTMLElement).className).trim().split(/\s+/).join(".")}`;
		const wide = (scroller: Element, what: string) => { if (scroller.scrollWidth > scroller.clientWidth + 1) found.push(`${what} scrolls sideways: ${scroller.scrollWidth} in ${scroller.clientWidth}`); };
		wide(open, "the pane");
		wide(document.scrollingElement!, "the page");

		// A closed fold keeps its words' boxes; only checkVisibility knows they aren't drawn.
		const shown = (element: Element) => element.getClientRects().length > 0 && element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
		const clip = (box: Box, element: Element): Box | null => {
			// What a box that hides its overflow leaves of it; a scroller that only clips up and down does too.
			let { left, right, top, bottom } = box;
			for (let at: Element | null = element; at && at !== open; at = at.parentElement) {
				const style = getComputedStyle(at);
				if (style.overflowX === "visible" && style.clipPath === "none") continue;
				const edge = at.getBoundingClientRect();
				left = Math.max(left, edge.left); right = Math.min(right, edge.right); top = Math.max(top, edge.top); bottom = Math.min(bottom, edge.bottom);
			}
			return right - left > 1.5 && bottom - top > 1.5 ? { left, right, top, bottom } : null;
		};
		const painted = (style: CSSStyleDeclaration) => !/^rgba\(.*, 0\)$|transparent/.test(style.backgroundColor) || (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none" && !/^rgba\(.*, 0\)$/.test(style.borderTopColor));

		// A pinned foot lies over the scrolling page by design: it is read as a box of its own.
		const PINNED = ".skill-review-actions, .connector-waiting-foot";
		// The cards' inner edges, and the page's own column.
		const CARDS = ".settings-rows, .ai-profile-card, .room-skills-rows, .room-schedules-list, .room-schedules-run-list, .connector-list, .skill-table, .room-danger-zone .settings-row";
		const boxOf = (element: Element): Box & { what: string } | null => {
			const card = element.closest(PINNED) ?? element.closest(CARDS);
			const holder = card && getComputedStyle(card).display !== "contents" ? card : open;
			const style = getComputedStyle(holder);
			const edge = holder.getBoundingClientRect();
			// A card with no side padding still holds its words inside its border.
			return { left: edge.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft), right: edge.left + (holder as HTMLElement).clientLeft + holder.clientWidth - parseFloat(style.paddingRight), top: -1e9, bottom: 1e9, what: holder === open ? "the page's column" : `its card ${said(holder)}` };
		};

		// Every word's lines, and every control's box.
		const words: Array<{ element: Element; text: string; lines: Box[] }> = [];
		const controls: Array<{ element: Element; box: Box; paint: boolean }> = [];
		for (const element of open.querySelectorAll(parts)) {
			if (!shown(element) || element.closest("[aria-hidden='true'], .sr-only, svg")) continue;
			if (element.matches("button, input:not([type='hidden']), select, textarea, a, summary, [role='switch']")) {
				const edge = element.getBoundingClientRect();
				const box = clip({ left: edge.left, right: edge.right, top: edge.top, bottom: edge.bottom }, element.parentElement!);
				const style = getComputedStyle(element);
				const field = element.matches("input, select, textarea");
				if (box) controls.push({ element, box, paint: field || painted(style) });
			}
			for (const node of element.childNodes) {
				if (node.nodeType !== Node.TEXT_NODE || !node.textContent!.trim()) continue;
				const range = document.createRange();
				range.selectNodeContents(node);
				const lines = [...range.getClientRects()].map((line) => clip(line, element)).filter((line): line is Box => line !== null);
				if (lines.length) words.push({ element, text: node.textContent!.trim(), lines });
			}
		}
		const within = (box: Box, element: Element, what: string) => {
			const edge = boxOf(element)!;
			if (box.right > edge.right + 1) found.push(`${what} runs ${Math.round(box.right - edge.right)} past the right of ${edge.what}`);
			if (box.left < edge.left - 1) found.push(`${what} runs ${Math.round(edge.left - box.left)} past the left of ${edge.what}`);
		};
		// A control drawn as a box is held by its box, one without by its words.
		for (const { element, box, paint } of controls) if (paint && !element.matches(".sr-only")) within(box, element, said(element));
		for (const { element, text, lines } of words) for (const line of lines) within(line, element, `the words "${text.slice(0, 40)}"`);

		// Overlaps: words over words, words over controls, controls over controls.
		const overlap = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4;
		const nested = (a: Element, b: Element) => a.contains(b) || b.contains(a);
		const boxes = [...words.flatMap(({ element, text, lines }) => lines.map((box) => ({ element, box, what: `the words "${text.slice(0, 40)}"` }))), ...controls.filter(({ paint }) => paint).map(({ element, box }) => ({ element, box, what: said(element) }))];
		for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
			const [a, b] = [boxes[i], boxes[j]];
			if (a.element === b.element || nested(a.element, b.element) || !overlap(a.box, b.box) || a.element.closest(PINNED) !== b.element.closest(PINNED)) continue;
			found.push(`${a.what} lies on ${b.what}`);
		}

		// Squeezed: a word broken inside its letters, or lines of a few letters each.
		for (const { element, text, lines } of words) {
			const style = getComputedStyle(element);
			const tops = [...new Set(lines.map((line) => Math.round(line.top)))];
			if (tops.length >= 3 && text.length / tops.length < 10 && (text.includes(" ") || !style.whiteSpace.startsWith("pre"))) found.push(`the words "${text.slice(0, 40)}" take ${tops.length} lines of about ${Math.round(text.length / tops.length)} letters`);
			const node = [...element.childNodes].find((one) => one.nodeType === Node.TEXT_NODE && one.textContent!.trim())!;
			for (const match of node.textContent!.matchAll(/(?<=^|\s)[A-Za-z]{4,20}(?=[.,]?(?:\s|$))/g)) {
				const range = document.createRange();
				range.setStart(node, match.index!);
				range.setEnd(node, match.index! + match[0].length);
				const at = [...range.getClientRects()].map((line) => Math.round(line.top));
				if (new Set(at).size > 1 && style.hyphens !== "auto") found.push(`the word "${match[0]}" is broken across lines`);
			}
		}
		return [...new Set(found)];
	}, { read, parts });
}

// --- The run -----------------------------------------------------------------------

type Read = { state: string; width: number; faults: Fault[] };

/** Waits until the pane has stopped moving: nothing running that ends. */
const still = (page: Page, what: string) => waitUntil(() => page.evaluate(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().iterations === Infinity)), `${what}: nothing moving`, 10000);

/** Opens a state on a page of its window, its requests answered and the pointer away. */
async function openState(page: Page, state: State, at: string): Promise<void> {
	await page.unrouteAll({ behavior: "ignoreErrors" });
	await state.answers?.(page);
	await page.reload();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	requestsFromNow(page);
	if (state.which === "room") await (state.room ?? { openWindow }).openWindow(page, "room");
	else {
		// The gear itself: with remote access on, the footer's first button is its pill, which opens the window elsewhere.
		await page.locator("button.sidebar-config-gear").filter({ visible: true }).first().click();
		await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await page.waitForSelector(".settings-overlay", { timeout: 10000 });
	}
	await goToPage(page, state.label);
	await answered(page, at);
	await state.act?.(page);
	if (!state.held) await answered(page, at);
	await page.mouse.move(5, 5);
	await still(page, at);
}

const shots = process.env.LOOK_SHOTS;

async function sweep(browser: Browser, device: "desktop" | "phone", states: State[]): Promise<Read[]> {
	const reads: Read[] = [];
	const page = await openPage(browser, device === "desktop" ? desktop(1440, 900) : phone(), "on");
	for (const state of states) {
		const at = `${state.name}, ${device}`;
		const widths = device === "desktop" ? [1440, 761] : [390];
		await page.setViewportSize({ width: widths[0], height: device === "desktop" ? 900 : 844 });
		try {
			await openState(page, state, at);
		} catch (error) {
			if (shots) await page.screenshot({ path: path.join(shots, `unopened-${device}-${state.name.replace(/[^A-Za-z0-9]+/g, "-")}.png`) }).catch(() => {});
			reads.push({ state: state.name, width: widths[0], faults: [`not opened: ${(error as Error).message.split("\n").slice(0, 4).join(" ")}`] });
			continue;
		}
		for (const width of widths) {
			await page.setViewportSize({ width, height: device === "desktop" ? 900 : 844 });
			await still(page, `${at}, ${width}`);
			const faults = await faultsOf(page, state.read);
			reads.push({ state: state.name, width, faults });
			if (shots && (faults.length || process.env.LOOK_ALL)) await page.screenshot({ path: path.join(shots, `${width}-${state.name.replace(/[^A-Za-z0-9]+/g, "-")}.png`) });
		}
	}
	await closeContext(page.context());
	return reads;
}

// --- The two forms, held closer -----------------------------------------------------

type Edges = { left: number; right: number; top: number; bottom: number };
const edges = (page: Page, selector: string) => pane(page).locator(selector).filter({ visible: true }).first().evaluate((element): Edges => { const { left, right, top, bottom } = element.getBoundingClientRect(); return { left, right, top, bottom }; });

/** A refused new profile: the reason wraps under the field and the button, which stay exactly where they were. */
async function refusedProfiles(browser: Browser): Promise<void> {
	for (const width of [1440, 761, 390]) {
		// Tall enough that no scrollbar comes with the reason and takes its width.
		const page = await openPage(browser, { ...(width === 390 ? phone() : desktop()), viewport: { width, height: 1400 } }, "on");
		for (const [name, value] of REFUSED_NAMES) {
			const what = `${name} at ${width}`;
			await openState(page, settings("Profiles", name), what);
			const place = async () => ({ words: await edges(page, ".state-profile-new > .settings-row-main"), field: await edges(page, ".state-profile-new input"), button: await edges(page, ".state-profile-new .rs-btn") });
			const before = await place();
			await createProfile(value)(page);
			await page.mouse.move(5, 5);
			await still(page, what);
			const after = await place();
			same(after.words, before.words, `${what}: the words stay where they were`);
			same(after.field, before.field, `${what}: the field stays where it was`);
			if (width > 760) same(after.button, before.button, `${what}: Create profile stays where it was`);
			const reason = await edges(page, ".state-profile-new .workspaces-error");
			const row = await edges(page, ".state-profile-new");
			const right = width > 760 ? after.button.right : row.right;
			assert(reason.left >= after.field.left - 1 && reason.right <= right + 1 && reason.top >= after.field.bottom && reason.bottom <= row.bottom + 1, `${what}: the reason stands under its field, inside the row: ${JSON.stringify({ reason, field: after.field, button: after.button, row })}`);
			const words = await pane(page).locator(".state-profile-new .workspaces-error").evaluate((element) => ({ inside: element.scrollWidth <= element.clientWidth, sideways: element.closest(".settings-dialog-pane")!.scrollWidth > element.closest(".settings-dialog-pane")!.clientWidth }));
			same(words, { inside: true, sideways: false }, `${what}: every word of the reason inside it, and nothing sideways`);
		}
		await closeContext(page.context());
	}
	console.log(`  ok  ${REFUSED_NAMES.length} refused names at 1440, 761 and 390: the reason wraps in its columns, the words, the field and the button unmoved`);
}

/** A task's form on a phone: the words at a width they read at, each row's controls whole and inside the card. */
async function taskForms(browser: Browser): Promise<void> {
	const forms: Array<[string, (page: Page) => Promise<void>]> = [
		["a new one-time task, In", oneTime("In")], ["a new one-time task, At", oneTime("At")],
		["a one-time task's edit, In", editOneTime("In")], ["a one-time task's edit, At", editOneTime("At")],
		["a new daily task", (page) => newTask(page, "Daily")], ["a new weekly task", (page) => newTask(page, "Weekly")], ["a new advanced task", (page) => newTask(page, "Advanced")],
	];
	const page = await openPage(browser, phone(), "on");
	for (const [name, act] of forms) for (const width of [390, 320]) {
		const what = `${name} at ${width}`;
		await page.setViewportSize({ width, height: 844 });
		await openState(page, room("Scheduled tasks", name, { act }), what);
		const rows = await pane(page).locator(".room-schedules-form .settings-row:has(> .settings-row-main)").evaluateAll((all) => all.map((row) => {
			const box = row.getBoundingClientRect();
			const words = row.querySelector(".settings-row-main")!.getBoundingClientRect();
			const controls = [...row.querySelectorAll("button, input, select")].map((control) => ({ box: control.getBoundingClientRect(), whole: control.scrollWidth <= control.clientWidth }));
			return {
				words: Math.round(words.width), label: row.querySelector(".settings-row-label")!.textContent,
				past: controls.filter(({ box: at }) => at.right > box.right + 1 || at.left < box.left - 1).length,
				over: controls.filter(({ box: at }) => Math.min(at.right, words.right) - Math.max(at.left, words.left) > 1 && Math.min(at.bottom, words.bottom) - Math.max(at.top, words.top) > 1).length,
				cut: controls.filter(({ whole }) => !whole).length,
			};
		}));
		assert(rows.length > 0, `${what}: no row to read`);
		for (const row of rows) assert(row.words >= 120 && row.past === 0 && row.over === 0 && row.cut === 0, `${what}, ${row.label}: the words at least 120 wide, no control past the row, over the words or cut: ${JSON.stringify(row)}`);
		same(await faultsOf(page, undefined, ".room-schedules-form *"), [], `${what}: the form's faults`);
	}
	await closeContext(page.context());
	console.log(`  ok  ${forms.length} task forms at 390 and 320: words read in full, every control whole and inside its row`);
}

/** A model's name is cut only where the words beside it leave it too little: a short one is whole beside any sentence. */
async function modelNames(browser: Browser): Promise<void> {
	for (const width of [1440, 761]) {
		const page = await openPage(browser, desktop(width, 900), "on");
		for (const state of [settings("AI setup", "a model signed out", { answers: signedOutModel }), room("Model", "signed out", { answers: signedOutModel })]) {
			const what = `${state.name} at ${width}`;
			await openState(page, state, what);
			await shows(page, ".room-model-unavailable");
			const names = await pane(page).locator(".room-model-row:has(.room-model-unavailable) .room-model-pick-name").evaluateAll((all) => all.map((name) => name.scrollWidth <= name.clientWidth));
			assert(names.length > 0 && names.every(Boolean), `${what}: a short model name is whole beside a long sentence: ${JSON.stringify(names)}`);
		}
		await closeContext(page.context());
	}
	console.log("  ok  a short model name is whole beside a long sentence, at 1440 and 761");
}

/** A kept answer's connector is read whatever its tool's name is: two connectors' rows never look the same. */
async function keptAnswers(browser: Browser): Promise<void> {
	const state = stateNamed("Room settings, Connectors: answers kept for tools");
	const lost: string[] = [];
	for (const width of [1440, 1000, 761, 390, 320]) {
		const page = await openPage(browser, width > 760 ? desktop(width, 900) : { ...phone(), viewport: { width, height: 844 } }, "on");
		const what = `${state.name} at ${width}`;
		await openState(page, state, what);
		const seen = await pane(page).locator(".room-connector-of").evaluateAll((all) => all.map((connector) => {
			const own = connector.getBoundingClientRect();
			const box = connector.parentElement!.getBoundingClientRect();
			return { name: connector.textContent, seen: Math.round(Math.min(own.right, box.right) - Math.max(own.left, box.left)) };
		}));
		assert(seen.length > 1, `${what}: no answers`);
		for (const one of seen) if (one.seen < 48) lost.push(`${one.name} at ${width}: ${one.seen} px`);
		await closeContext(page.context());
	}
	assert(lost.length === 0, `a kept answer's connector is cut to nothing: ${lost.join(", ")}`);
	console.log("  ok  a kept answer's connector is read beside or under a long tool's name, at 1440, 1000, 761, 390 and 320");
}

/** Lists whose rows have smaller words right beside a name: the row, its name and those words. */
const NAME_LINES = [
	{ list: "the model list", state: room("Model", "the model list", { answers: recommended, act: openModelList }), row: ".room-model-menu .room-model-option", name: ".room-model-option-name", beside: [".room-model-option-tag", ".room-model-option-context"] },
	{ list: "Connectors", state: stateNamed("Settings, Connectors: as it is, every state and long names"), row: ".connector-list > .connector-item", name: ".connector-item-name-text", beside: [".connector-item-name > .connector-dir-kind"] },
	{ list: "a task's runs", state: stateNamed("Room settings, Scheduled tasks: every run state and long names"), row: ".room-schedules-run-primary", name: "strong", beside: [".room-schedules-run-status"] },
];
function stateNamed(name: string): State {
	const state = STATES.find((one) => one.name === name);
	assert(state, `no state called ${name}`);
	return state;
}
/**
 * In each of those lists a row's name and the words beside it stand on one
 * baseline. Read at a Windows screen's scales, where a font's rounding shows
 * it: the scale is the browser's own, since a page's emulated one is drawn
 * after the layout.
 */
async function nameLines(): Promise<void> {
	for (const scale of [1, 1.25, 1.75]) {
		const browser = await chromium.launch({ args: [`--force-device-scale-factor=${scale}`, "--window-size=1440,900"] });
		try {
			for (const { list, state, ...selectors } of NAME_LINES) {
				const page = await openPage(browser, { viewport: null }, "on");
				const what = `${list} at a scale of ${scale}`;
				await openState(page, state, what);
				const rows = await page.locator(selectors.row).evaluateAll((all, { name, beside }) => all.map((row) => {
					const baseline = (selector: string): number | null => {
						const words = row.querySelector(selector);
						if (!words) return null;
						// An empty box in the line stands on its baseline.
						const mark = document.createElement("span");
						mark.style.cssText = "display: inline-block; width: 0; height: 0;";
						words.append(mark);
						const at = mark.getBoundingClientRect().bottom;
						mark.remove();
						return at;
					};
					return { name: baseline(name), beside: beside.map(baseline).filter((one): one is number => one !== null) };
				}), selectors);
				assert(rows.some((row) => row.beside.length === selectors.beside.length), `${what}: no row with all its words: ${JSON.stringify(rows)}`);
				const off = rows.filter((row) => row.beside.some((at) => Math.abs(at - row.name!) > 0.5));
				assert(off.length === 0, `${what}: a row's words stand on one baseline: ${JSON.stringify(off)}`);
				await closeContext(page.context());
			}
		} finally {
			await closeBrowser(browser);
		}
	}
	console.log(`  ok  ${NAME_LINES.map((one) => one.list).join(", ")} at 100, 125 and 175 %: a row's name and the words beside it on one baseline`);
}

// --- The stand-in connectors and the team's repository -----------------------------------

const standIn = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		if (new URL(req.url ?? "/", "http://x").pathname !== "/wiki/mcp") return void res.writeHead(401, { "content-type": "text/plain" }).end("sign in first");
		const message = JSON.parse(raw || "{}");
		if (message.id === undefined) return void res.writeHead(202).end();
		const result = message.method === "initialize" ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1.0.0" } }
			: message.method === "tools/list" ? { tools: ["search_pages", "create_page", LONG_WORD].map((name) => ({ name, description: `${name}.`, inputSchema: { type: "object" } })) } : {};
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
});
await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
const standInAt = (where: string) => `http://127.0.0.1:${(standIn.address() as AddressInfo).port}${where}`;

const teamRepo = path.join(tempRoot, "team");
function git(args: string[]): void {
	const run = spawnSync("git", ["-c", "user.email=smoke@test", "-c", "user.name=Smoke", ...args], { cwd: teamRepo, encoding: "utf-8" });
	assert(run.status === 0, `git ${args.join(" ")}: ${run.stderr || run.stdout}`);
}
function seedRepo(): void {
	for (const [name, description] of [["pdf", "Read, fill in and combine PDF files."], ["board-pack", LONG_LINE], [LONG_SKILL, "The longest name a skill may have."]]) {
		const dir = path.join(teamRepo, "skills", name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\n---\n\nThe ${name} instructions.\n`);
	}
	git(["init", "-q", "-b", "main"]);
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "first"]);
}

let server: ChildProcessWithoutNullStreams | null = null;
let model: http.Server | undefined;
try {
	const agents = await import("../src/persistent-agents.js");
	const roomId = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	agents.createPersistentAgentFromScaffoldInput({ displayName: BARE_ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	// A model server is never asked here; the app wants one set up to show its rooms.
	const modelPort = await freePort();
	model = http.createServer((_req, res) => { res.writeHead(500); res.end(); }).listen(modelPort, "127.0.0.1");
	const appDir = path.join(tempHome, ".exxperts", "app");
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { synthetic: { name: "Synthetic", baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", input: ["text"], contextWindow: 128000, maxTokens: 16384 }] } } }));
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-synthetic", providerId: "synthetic", label: "Synthetic", roomModels: ["room-model"], learnModel: "room-model", reviewMemoryModel: "room-model" }] }));
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-synthetic" }));
	seedRepo();
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(CONNECTORS.map(({ id, name }) => [id, {
		displayName: name,
		...(id === "office-files" ? { command: "never-started-connector", args: ["--stdio"] } : { url: id === "ticket-desk" || id === "slow-desk" ? "http://127.0.0.1:9/mcp" : standInAt(id === "long-address" ? `/${"workspace-".repeat(16)}mcp` : "/wiki/mcp") }),
	}])) }));
	const now = Date.now();
	fs.writeFileSync(path.join(agentDir, "mcp-connector-checks.json"), JSON.stringify({ schemaVersion: 1, checks: { "ticket-desk": { at: now, ok: false, httpStatus: 404, error: "HTTP 404" }, "slow-desk": { at: now, ok: false, error: "fetch failed" }, "long-address": { at: now, ok: false, needsAuth: true, httpStatus: 401 } } }));
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1", EXXPERTS_SKILLS_FEATURED_SOURCES: JSON.stringify([{ source: teamRepo, author: "team" }, { source: path.join(tempRoot, "missing"), author: "nobody" }]), EXXPERTS_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
	const seed = async (method: "POST" | "PUT", route: string, body: unknown) => {
		const answer = await authedFetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const text = await answer.text();
		assert(answer.ok, `seeding ${route}: ${answer.status} ${text}`);
		return JSON.parse(text);
	};
	await seed("POST", "/api/auth/api-key", { provider: "synthetic", key: "synthetic-test-key" });
	const at = `/api/persistent-agents/${encodeURIComponent(roomId)}`;
	await seed("POST", `${at}/schedules`, { name: "Weekly summary", type: "cron", schedule: "0 0 9 * * 1", prompt: "Write the weekly summary of the reports.", enabled: true });
	await seed("POST", `${at}/schedules`, { name: "Check the new figures", type: "once", schedule: "+30m", prompt: "Check the figures that came in today.", enabled: true });
	await seed("POST", "/api/settings/state-profile/create", { name: LONG_WORD });

	const scan = await seed("POST", "/api/skills/repo/scan", { source: teamRepo });
	for (const name of ["pdf", LONG_SKILL]) await seed("POST", "/api/skills/repo/import", { token: scan.token, path: `skills/${name}` });
	for (const name of ["pdf", LONG_SKILL]) await seed("PUT", `${at}/skill-settings`, { action: "enable", name });
	for (const id of ["team-wiki", "long-word", "ticket-desk"]) await seed("PUT", `${at}/mcp-connectors`, { action: "grant", name: id });
	for (const [topic, text] of [[LONG_WORD, LONG_LINE], ["General", `${LONG_WORD}${LONG_WORD}`], ["General", "Reports go out on Fridays."]]) await seed("POST", `${at}/memory/entries`, { topic, kind: "fact", text, newTopic: true });
	const archived = await seed("POST", `${at}/memory/entries`, { topic: "General", kind: "fact", text: `${LONG_WORD} ${LONG_LINE}`, newTopic: true });
	const gone = await authedFetch(`${baseUrl}${at}/memory/entries/${encodeURIComponent(archived.entry.id)}`, { method: "DELETE" });
	assert(gone.ok, `archiving a note: ${gone.status}`);
	const folder = path.join(tempHome, "Documents", LONG_WORD);
	fs.mkdirSync(folder, { recursive: true });
	await seed("PUT", `${at}/workspace-default`, { root: folder, workspaceAccessMode: "localFiles", bashEnabled: true });
	await seed("PUT", `${at}/threads/pi_look_conversation_0001`, { state: "active", origin: "launcher", model: { provider: "synthetic", model: "room-model" }, items: [] });

	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		const wanted = process.env.LOOK_ROWS;
		const states = STATES.filter((state) => !wanted || state.name.includes(wanted));
		const reads = (await Promise.all([sweep(browser, "desktop", states), sweep(browser, "phone", states)])).flat();
		const bad = reads.filter((read) => read.faults.length > 0);
		for (const read of bad) console.log(`  FAIL ${read.state}, ${read.width}:\n${read.faults.map((fault) => `         ${fault}`).join("\n")}`);
		assert(bad.length === 0, `${bad.length} of ${reads.length} reads had something run out or over`);
		console.log(`  ok  ${states.length} states at 1440, 761 and 390: nothing sideways, past its card, over its neighbour or squeezed`);
		if (!wanted || wanted === "the two forms") {
			await refusedProfiles(browser);
			await taskForms(browser);
			await modelNames(browser);
	await keptAnswers(browser);
			await nameLines();
		}
	} finally {
		await closeBrowser(browser);
	}
	console.log("settings nothing runs out ui smoke passed");
} finally {
	await stopSmokeServer(server);
	model?.close();
	standIn.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
