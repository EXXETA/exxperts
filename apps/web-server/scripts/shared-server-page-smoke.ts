// The page on a shared server: when the client-context probe says
// sharedServer, the controls that only work on someone's own computer are not
// on the page, the settings only an admin may change are read-only with one
// line, Home lists the rooms A to Z with no sort control, the page never asks
// for what such a server refuses, a refused start-up read leaves the page
// usable, and a signed-out person is sent to sign in instead of being told the
// connection is lost. A failed message whose line sends the person to their
// admin offers no button for that: a gateway's bare 403 shows Choose another
// model alone there, and Replace key as well on this computer; a gateway's
// bare 404 handed back before its model list was read tells the person to
// tell the admin there with no button, and on this computer to check the
// gateway, with AI setup's button. With
// sharedServer false every control is there as today. Who is signed in shows
// in the sidebar's footer, with Sign out and the line on what it ends when the
// server sends its sign-out link: Sign out posts the server's sign-out and
// follows the link only on its confirmed answer; a refused, failed or stalled
// one follows nothing and offers Try again and this browser's sign-out alone,
// even when the page's own closed connection meets a 401 meanwhile.
// The signed-out line's Sign in again goes to that link too, else to "/".
// the admin alone can change the AI setup (never sign a provider in or out),
// a different person on a later read reloads the page, and a room on a shared
// server keeps trying past two minutes. On a shared server the page names the
// person it was opened for on every request and on its socket, and a 403 or a
// 409 whose JSON says endsPage: true ends the page with that answer's words,
// or a fallback line when it has none; Home's dropped socket asks
// client-context before each rebuild there. The answers here are stand-ins for
// the server's (a refused person, a switched-off one): their words and codes
// are the smoke's own. The ending comes also when the first read failed, and a
// request answered after it reaches no caller; the same answers without the
// field, and the field on a 401, a 500 or a 503, end nothing (rows X1 to X6,
// X3a, X3b).
// The Wallet's
// address shows the person's own usage there and, for the admin, the
// company's totals below it, never the Wallet's read, and reads nothing
// before the probe answers or when it fails; it asks once per showing, never
// on a timer, a failed read says so, and a refused company read takes that part
// away; on this computer the Wallet waits for an answer, then reads.
// The probe is intercepted in the page, so one ordinary server serves both.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Route, type WebSocketRoute } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { closeBrowser, closeContext } from "./smoke-close-context.js";
import { CAN_CHANGE_FILES, CHANGE_FOLDER, COMMANDS, STOP_USING_FOLDER } from "../src/room-box/card-text.js";
import {
	COMPANY_USAGE_CSV_HOVER,
	COMPANY_USAGE_LINE,
	COMPANY_USAGE_EMPTY,
	COMPANY_USAGE_TITLE,
	SHARED_USAGE_FOOTER,
	SHARED_USAGE_HEADING,
	SHARED_USAGE_LINE,
	SHARED_USAGE_MODELS_HINT,
	SHARED_USAGE_NAV,
	SHARED_USAGE_NAV_HOVER,
	SHARED_USAGE_ROOMS_HINT,
	SHARED_USAGE_UNAVAILABLE_ROOM,
	SHARED_USAGE_UNREADABLE,
} from "../../web-ui/src/usage-words.js";
import { ADD_SKILL_WAYS, ADD_TO_LIBRARY, BROWSE_FEATURED_LINK, SKILL_FILES_LINES, skillScriptsCount } from "../../web-ui/src/skill-source-copy.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-shared-server-page-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

// Pinned literals, never built by the code under test.
const SHARED_LINE = "On a shared server, your admin sets this up.";
const NO_FOLDER_LINE = "On a shared server, rooms don't use a folder.";
const LOST_LINE = "exxperts lost its connection. Restarting the app usually fixes this.";
const LOST_SHARED_LINE = "exxperts lost its connection to the server. It usually comes back by itself within a minute. If it doesn't, reload the page.";
const SIGNED_OUT_LINE = "You were signed out. Sign in again to carry on.";
// Sign out, its scope line, and the line with its two choices when the sign-out fails.
const SIGN_OUT_ROW = "Sign out This signs you out on every device.";
const SIGN_OUT_FAILED_ROW = "Your other devices may still be signed in. Try again Sign out of this browser only";
// The page's own wait for the sign-out's answer (SIGN_OUT_WAIT_MS in product-shell.tsx).
const SIGN_OUT_WAIT_MS = 10_000;
const SIGN_OUT_REFUSED = { error: "exxperts could not sign you out on your other devices, so try again.", code: "sign_out_failed" };
// The edge's answer to every request of a session a stored sign-out ends.
const SESSION_SIGNED_OUT = { error: "You were signed out.", code: "session_signed_out" };
const ADMIN_HINT = "Just made an admin? Sign out and in again to get the admin's controls.";
// The admin's AI setup on a shared server: the one confirmation before a removal, the key-only one, and the empty list's lines.
const REMOVE_LINE = (name: string) => `Remove ${name}? Its models leave everyone's list, and a room using one stops answering until someone there picks another model. Conversations are kept.`;
const REMOVE_KEY_ONLY_LINE = (name: string) => `Remove ${name}? No models from this key are approved, so no room is affected.`;
const DESKTOP_REMOVE_LINE = (name: string) => `Remove ${name}? This signs out and deletes its models.`;
const NO_PROVIDERS = { admin: "No models yet. Add an API key or a gateway with Add provider.", member: "No models yet. Ask your admin to add one." };
const STILL_LOADING = "Profile status is still loading.";
// Both gateway forms on a shared server, and the question before a saved gateway's new address.
const GATEWAY_LINE = "Changes here reach every room that uses this gateway, from its next answer.";
const NEW_ADDRESS_LINE = "Use the new address? Every room on this gateway sends its next answer there.";
// Where a provider's models run, as everyone reads it beside its models, and the admin's field for it.
const RUNS_IN_LABEL = {
	eu: { short: "EU", line: "Your admin says this model runs in the EU." },
	"outside-eu": { short: "Outside EU", line: "Your admin says this model runs outside the EU." },
	unknown: { short: "Location unknown", line: "Your admin hasn't said where this model runs." },
} as const;
// Above a member's model list, for the eye: whose statement the labels are.
const RUNS_IN_LIST_LINE = "Your admin states where each model runs.";
const RUNS_IN_HEADING = "Where its models run";
const RUNS_IN_HELP = "Shown to everyone beside these models, as your statement.";
const RUNS_IN_SET_BY_INSTALL = "Your organisation's install sets this.";
// A shared server's sign-in status: no provider, to anyone.
const SHARED_AUTH_STATUS = { anyConfigured: false, authDir: "", providers: [] };
// A note on a skill's files the Skills page no longer shows, here or on a shared server.
const SKILL_FILES_NOTE = "A skill's files run only in rooms where you allow them, and only as they were when you did.";
const DESKTOP_INSTRUCTIONS_HEAD = "Standing guidance for every room that has not switched them off: how to answer, what to prefer, what to avoid. Changes apply from the next message.";
const COMPANY_INSTRUCTIONS_HEAD = "Standing guidance for every room in your company that has not switched them off: how to answer, what to prefer, what to avoid. Changes apply from the next message.";
const PILL_SHARED = "This room lost its connection. It keeps trying by itself.";
const PILL_DESKTOP_FAILED = "This room lost its connection. Use Reconnect to try again, or restart the app if it keeps happening.";
const RECONNECT_SHARED = "Try again now. If it keeps failing, reload the page or tell your admin.";
const RECONNECT_DESKTOP = "The automatic reconnect gave up. Try again now. If it keeps failing, restart exxperts.";
// The words for a missing or gone model, as the word list has them: a member and the admin on a shared server, and
// this computer as today. Each stopped state is a message handed back with the notice, for a key provider (the Claude
// API key) or a sign-in (ChatGPT).
type StoppedWords = { state: string; provider: string; model: string; key?: "missing" | "refused" | "no-workspace"; line: string; buttons: string };
const KEY_MODEL = { provider: "anthropic-api-key", model: "claude-opus-5-5" };
const SIGN_IN_MODEL = { provider: "openai-codex", model: "gpt-6.1-sol" };
const MODEL_WORDS: Record<"member" | "admin" | "computer", { help: string; stopped: StoppedWords[]; picker: string; enter: string; opening: string }> = {
	member: {
		help: "Your AI. Your admin sets up the models for this server. Each room picks one in Room settings, Model.",
		stopped: [
			{ state: "no key", ...KEY_MODEL, key: "missing", line: `Anthropic isn't available on this server. Choose another model to continue this conversation, or tell your admin.`, buttons: "Choose another model" },
			{ state: "a refused key", ...KEY_MODEL, key: "refused", line: `Anthropic did not accept the saved key. Choose another model to continue this conversation, or tell your admin.`, buttons: "Choose another model" },
			// The room's own model is named: the conversation runs on it.
			{ state: "a key outside a workspace", ...KEY_MODEL, key: "no-workspace", line: `GPT-6.1 Terra cannot answer because its key isn't tied to a workspace. Choose another model to continue this conversation, or tell your admin.`, buttons: "Choose another model" },
		],
		picker: "No models yet. Ask your admin to add one in Settings, AI setup.",
		enter: "Ask your admin to add a model in Settings, AI setup.",
		opening: "No AI model is set up on this server yet. Ask your admin to add one in Settings, AI setup, then open the room again.",
	},
	admin: {
		help: "Connect your AI. Open the gear, then Settings, AI setup. Add an API key or connect your company gateway. Set the default models for your rooms there.",
		stopped: [
			{ state: "no key", ...KEY_MODEL, key: "missing", line: `No Claude API key is saved. Add the key again to continue this conversation.`, buttons: "Choose another model|Add key" },
			{ state: "a refused key", ...KEY_MODEL, key: "refused", line: `Anthropic did not accept the saved key. Replace the key to continue this conversation.`, buttons: "Choose another model|Replace key" },
			{ state: "a sign-in gone", ...SIGN_IN_MODEL, line: `ChatGPT isn't available on this server. Choose another model to continue this conversation.`, buttons: "Choose another model" },
		],
		picker: "No models yet. Add an API key or a gateway in Settings, AI setup.",
		enter: "Add an API key or a gateway in Settings, AI setup.",
		opening: "No AI model is set up yet. Add an API key or a gateway in Settings, AI setup, then open the room again.",
	},
	computer: {
		help: "Connect your AI. Open the gear, then Settings, AI setup. Sign in with a subscription, add an API key, or connect your company gateway. Set the default models for your rooms there.",
		stopped: [
			{ state: "no key", ...KEY_MODEL, key: "missing", line: `No Claude API key is saved. Add the key again to continue this conversation.`, buttons: "Choose another model|Add key" },
			{ state: "a sign-in gone", ...SIGN_IN_MODEL, line: `ChatGPT Plus/Pro is signed out. Sign in again to continue this conversation.`, buttons: "Choose another model|Sign in" },
		],
		picker: "Sign in to an AI provider in Settings, AI setup, to choose a model.",
		enter: "Sign in to an AI provider in Settings, AI setup.",
		opening: "No AI provider is signed in. Sign in in Settings, AI setup, then open the room again.",
	},
};
// The server's own sign-out link, as client-context hands it over.
const SIGN_OUT_LINK = "/oauth2/sign_out?rd=https%3A%2F%2Flogin.example.test%2Flogout";
type Person = { id: string; name: string; admin: boolean };
// A name that is markup if it is ever read as markup.
const MEMBER: Person = { id: "11111111-1111-4111-8111-111111111111", name: "<i>Sample</i> Member", admin: false };
const ADMIN: Person = { id: "22222222-2222-4222-8222-222222222222", name: "Sample Admin", admin: true };
const OTHER: Person = { id: "33333333-3333-4333-8333-333333333333", name: "Sample Other", admin: false };
const ORDER_NOT_LOADED = "The saved order could not be loaded";
const walletLine = async (page: Page) => (await page.locator(".dashboard-page .landing-hero p").innerText()).trim();
const USAGE_READ = "GET /api/usage";
// Stand-ins for a shared server's two usage answers (the server's own are its hosted smoke's). A room of the
// person's with no name (gone, or its record unreadable) must never show its id.
const GONE_ROOM_ID = "gone-room-1a2b3c4d";
const OWN_USAGE = {
	range: "all",
	model: "all",
	models: [{ id: "model one", label: "Model One", turns: 3, rawIds: 1 }],
	agent: "all",
	agentNames: { "alpha-room": "Alpha Room" },
	totals: { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0, turns: 3, activeDays: 2 },
	previous: null,
	byAgent: [
		{ agent: "alpha-room", retired: false, turns: 2, tokens: 3000, kinds: {} },
		{ agent: GONE_ROOM_ID, retired: true, turns: 1, tokens: 1200, kinds: { upkeep: { turns: 1 } } },
	],
	byModel: [{ id: "model one", label: "Model One", rawIds: 1, turns: 3, tokens: 4200 }],
	series: { kind: "daily", buckets: [{ label: "Nov 18", ts: 0, turns: 1, tokens: 1200 }, { label: "Nov 19", ts: 1, turns: 2, tokens: 3000 }] },
	weekHour: Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => (day === 2 && hour === 10 ? 3 : 0))),
	recent: {
		rows: [
			{ ts: Date.now() - 60_000, agent: "alpha-room", model: "model-one", modelName: "Model One", kind: "chat", input: 500, output: 100, cacheRead: 1500, cacheWrite: 0 },
			{ ts: Date.now() - 120_000, agent: GONE_ROOM_ID, model: "model-one", modelName: "Model One", kind: "upkeep", input: 500, output: 100, cacheRead: 1500, cacheWrite: 0 },
		],
		total: 3,
	},
};
const COMPANY_USAGE = {
	range: "all",
	model: "all",
	models: [{ id: "model one", label: "Model One", turns: 7, rawIds: 1 }],
	totals: { input: 4000, output: 900, cacheRead: 6000, cacheWrite: 0, turns: 7, activeDays: 2 },
	byModel: [{ id: "model one", label: "Model One", rawIds: 1, turns: 7, tokens: 10900 }],
	series: { kind: "daily", buckets: [{ label: "Nov 17", ts: 0, turns: 3, tokens: 4000 }, { label: "Nov 18", ts: 1, turns: 4, tokens: 6900 }] },
};
/** An organisation with no finished day of usage yet. */
const COMPANY_USAGE_NONE = {
	...COMPANY_USAGE,
	models: [],
	totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, activeDays: 0 },
	byModel: [],
	series: { kind: "daily", buckets: [] },
};
/** An organisation whose only rows name no model: they count in the turns, never in the models. */
const COMPANY_USAGE_NO_MODEL = { ...COMPANY_USAGE_NONE, totals: { ...COMPANY_USAGE_NONE.totals, input: 300, output: 200, turns: 5, activeDays: 1 } };
/** How the stand-in usage reads answer, and how often each was asked. */
/** The company read answers each range with its own body, or one body for every range. */
type UsageStandIn = { mine: number; company: number; mineStatus: number; companyStatus: number; companyAnswer: object | ((range: string) => object) };
async function standInUsage(context: BrowserContext, usage: UsageStandIn): Promise<void> {
	await context.route((url) => url.pathname === "/api/usage/mine", (route) => {
		usage.mine += 1;
		return route.fulfill({ status: usage.mineStatus, contentType: "application/json", body: JSON.stringify(usage.mineStatus === 200 ? OWN_USAGE : { code: "usage_unreadable" }) });
	});
	await context.route((url) => url.pathname === "/api/usage", (route) => {
		usage.company += 1;
		const range = new URL(route.request().url()).searchParams.get("range") ?? "all";
		const body = usage.companyStatus === 200 ? (typeof usage.companyAnswer === "function" ? usage.companyAnswer(range) : usage.companyAnswer) : usage.companyStatus === 403 ? { code: "hosted_route_admin", error: "Only your organisation's admin can do this." } : { code: "usage_unreadable" };
		return route.fulfill({ status: usage.companyStatus, contentType: "application/json", body: JSON.stringify(body) });
	});
}
const newUsageStandIn = (): UsageStandIn => ({ mine: 0, company: 0, mineStatus: 200, companyStatus: 200, companyAnswer: COMPANY_USAGE });
/** How often a stand-in was asked, read at this moment: the counts change under the page. */
const timesAsked = (usage: UsageStandIn, which: "mine" | "company"): number => usage[which];
const BOUNDARY_LINE = "Something went wrong on this page. Reloading usually fixes it.";
const REFUSAL = { error: "Refused by the shared server smoke.", code: "smoke_refused" };
// Stand-ins for the server's answers that end the page: a request whose page names a person no longer signed in, and
// a switched-off person. The cover says each answer's own words; one without words gets the fallback line.
const ANOTHER_PERSON = { error: "Another person is signed in on this server now.", code: "smoke_another_person", endsPage: true };
const SWITCHED_OFF = { error: "The smoke's server has ended your access.", code: "smoke_access_ended", endsPage: true };
const ENDED_FALLBACK_LINE = "You can't use this page any more. Reload to see what you can do next.";
// The cover's own lines: a read finds another person, and a page that never knew its person.
const OTHER_PERSON_LINE = "You can't use this page any more: a different account is now signed in to exxperts in this browser.";
const UNKNOWN_PERSON_LINE = "This page could not tell who is signed in. Reload to carry on.";
// The stand-in for the server's answer when it cannot read the mark, and its refusal page for a switched-off page load.
const SWITCHED_OFF_UNCHECKED = { error: "exxperts could not check whether your access is switched on, so try again in a moment.", code: "switched_off_unchecked" };
const SWITCHED_OFF_PAGE = `<!doctype html><title>exxperts</title><p class="smoke-refusal-page">${SWITCHED_OFF.error}</p>`;
const SWITCHED_OFF_CLOSE = { code: 4403, reason: SWITCHED_OFF.code };
const PAGE_PERSON_HEADER = "x-exxperts-page-person";
const PAGE_PERSON_PROTOCOLS = (person: Person) => ["exxperts", `exxperts-person.${person.id}`];
// Every route a shared server refuses that the page can call, which it must
// not even ask for: any request under these paths...
const NEVER_ASKED: readonly string[] = [
	"/api/remote/",
	"/api/settings/state-profile",
	"/api/settings/state-home/",
	"/api/settings/room-order",
	"/api/whats-new/seen",
	"/api/system/choose-folder",
	"/api/task-store/gc",
	"/api/auth/login",
	"/api/auth/logout",
	"/api/auth/api-key",
	"/api/mcp/",
	"/api/skills/featured",
	"/api/skills/repo/",
	"/api/web-search/searxng/setup",
	"/api/usage",
	"/api/knowledge/",
];
// ...and these room paths, whatever the method...
const NEVER_READ: readonly RegExp[] = [/^\/api\/persistent-agents\/[^/]+\/(prompt-diagnostics|reattach-buffer-stats)$/];
// ...and any change (a method other than GET) to these, whose reads are open.
const NEVER_CHANGED: readonly RegExp[] = [
	/^\/api\/ai\/defaults$/,
	/^\/api\/settings\/(instructions|web-search)$/,
	/^\/api\/skills(\/|$)/,
	/^\/api\/persistent-agent-ai-profile(s\/|$)/,
	/^\/api\/persistent-agents\/[^/]+\/(workspace-default|workspace-policy|bash-settings|workspace\/validate|consult)$/,
	/^\/api\/persistent-agents\/[^/]+\/files\/[^/]+\/save$/,
	/^\/api\/artifacts\/[^/]+\/export$/,
];
// Never counted: the probe itself, which the smoke answers.
const ALWAYS_ASKED: readonly string[] = ["/api/remote/client-context", "/api/usage/mine"];

// What the organisation's admin may do on top of everyone: the AI setup's writes, the
// skills library's, the organisation's instructions and the company's usage. Provider sign-in and sign-out
// (login, logout), the featured skills and a repository import are refused for the admin too.
const ADMIN_MAY_ASK: readonly string[] = ["/api/auth/api-key", "/api/usage", "/api/usage/export.csv"];
// ...and one key's removal, under the save's path.
const ADMIN_MAY_ASK_UNDER: readonly string[] = ["/api/auth/api-key/"];
const ADMIN_MAY_CHANGE: readonly RegExp[] = [/^\/api\/ai\/defaults$/, /^\/api\/persistent-agent-ai-profile(s\/|$)/, /^\/api\/settings\/instructions$/, /^\/api\/skills(\/|$)/];

/** Whether a shared server refuses this request (method and path, no query) for this person. */
function refusedOnSharedServer(method: string, pathname: string, admin: boolean): boolean {
	if (ALWAYS_ASKED.includes(pathname)) return false;
	if (admin && (ADMIN_MAY_ASK.includes(pathname) || ADMIN_MAY_ASK_UNDER.some((prefix) => pathname.startsWith(prefix)))) return false;
	if (NEVER_ASKED.some((prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) return true;
	if (NEVER_READ.some((pattern) => pattern.test(pathname))) return true;
	if (admin && ADMIN_MAY_CHANGE.some((pattern) => pattern.test(pathname))) return false;
	return method !== "GET" && method !== "HEAD" && NEVER_CHANGED.some((pattern) => pattern.test(pathname));
}

const ROOMS = ["Beta Room", "Alpha Room", "Bash Room"];
const MEMBER_SEES_SKILL = "Member Sees";
const A_TO_Z = ["Alpha Room", "Bash Room", "Beta Room"];
const Z_TO_A = ["Beta Room", "Bash Room", "Alpha Room"];
const SHELF_FILE = "notes.txt";
// Home's socket retries within seconds and the warning waits out a 12-second
// grace after at least two failed attempts; a minute is ample.
const OUTAGE_LIMIT_MS = 60_000;

// A signed-in provider, so AI setup draws its rows and the rooms have a model.
const agentDir = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: "sk-smoke" } }), { mode: 0o600 });
const workspaceRoot = path.join(tempHome, "bash-room-folder");
fs.mkdirSync(workspaceRoot, { recursive: true });

let server: ChildProcessWithoutNullStreams | null = null;

async function api(method: string, url: string, body?: unknown): Promise<any> {
	const res = await authedFetch(`${baseUrl}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	assert(res.ok, `${method} ${url}: ${res.status} ${text}`);
	return text ? JSON.parse(text) : null;
}

// --- apiFetch with no browser: the page's person joins the caller's own headers in every form, and the answers that end the page ---
{
	const realFetch = globalThis.fetch;
	let reloads = 0;
	const reloaded = () => reloads;
	const toSignIn: string[] = [];
	const sent: Request[] = [];
	let answer = (_request: Request): Response | Promise<Response> => Response.json({});
	// The page's reload and its way to sign in, counted; fetch builds the request the browser would send, from the same arguments.
	const stored = new Map<string, string>();
	Object.assign(globalThis, {
		location: { reload: () => { reloads += 1; }, assign: (to: string) => { toSignIn.push(to); } },
		sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } },
	});
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input instanceof Request ? input : new URL(String(input), "http://page.test"), init);
		sent.push(request);
		return answer(request);
	}) as typeof fetch;
	try {
		const api = await import("../../web-ui/src/api.js");
		const clientContext = await import("../../web-ui/src/remote-client-context.js");
		const last = () => sent[sent.length - 1];
		await api.apiFetch("/api/before", { headers: { "X-Caller": "kept" } });
		assert(!last().headers.has(PAGE_PERSON_HEADER) && last().headers.get("x-caller") === "kept", "apiFetch: a page that knows no person named one");
		answer = () => Response.json({ remote: false, capability: "full", sharedServer: true, person: MEMBER });
		await clientContext.fetchRemoteClientContext();
		answer = () => Response.json({});
		const forms: Array<[string, () => Promise<Response>]> = [
			["a plain object", () => api.apiFetch("/api/a", { headers: { "X-Caller": "kept" } })],
			["a Headers object", () => api.apiFetch("/api/a", { method: "POST", body: "{}", headers: new Headers({ "X-Caller": "kept" }) })],
			["a list of pairs", () => api.apiFetch("/api/a", { headers: [["X-Caller", "kept"]] })],
			["a Request", () => api.apiFetch(new Request("http://page.test/api/a", { headers: { "X-Caller": "kept" } }))],
			["no headers", () => api.apiFetch("/api/a")],
		];
		for (const [form, call] of forms) {
			await call();
			assert(last().headers.get(PAGE_PERSON_HEADER) === MEMBER.id, `apiFetch with ${form}: the page's person is not named, got ${JSON.stringify(last().headers.get(PAGE_PERSON_HEADER))}`);
			assert(form === "no headers" || last().headers.get("x-caller") === "kept", `apiFetch with ${form}: the caller's own header was lost`);
		}
		pass("apiFetch: no person, no header; with one, X-Exxperts-Page-Person names it beside the caller's own headers (plain object, Headers, pairs, a Request)");
		answer = () => Response.json({ error: "This room is busy.", code: "room_busy" }, { status: 409 });
		const conflict = await api.fetchJson("/api/b").then(() => null, (error: unknown) => error);
		assert(conflict instanceof api.ApiRequestError && conflict.status === 409 && conflict.code === "room_busy" && conflict.message === "This room is busy.", `apiFetch: another 409 did not reach its caller as the server's answer: ${String(conflict)}`);
		assert(!clientContext.personHasChanged() && reloaded() === 0, "apiFetch: another 409 ended the page");
		// The field ends the page, never a code or words: a 403 and a 409 without it, or with it other than true, and the
		// field on any other status reach their caller as the server's answer.
		const { endsPage: _field, ...withoutField } = ANOTHER_PERSON;
		const endingNothing: Array<[string, number, unknown]> = [
			["a 403 without the field", 403, withoutField],
			["a 409 without the field", 409, withoutField],
			["a 403 whose field is the string \"true\"", 403, { ...withoutField, endsPage: "true" }],
			["a 409 whose field is 1", 409, { ...withoutField, endsPage: 1 }],
			["a 401 with the field", 401, ANOTHER_PERSON],
			["a 500 with the field", 500, ANOTHER_PERSON],
			["a 503 with the field", 503, ANOTHER_PERSON],
		];
		for (const [what, status, body] of endingNothing) {
			answer = () => Response.json(body, { status });
			const res = await api.apiFetch("/api/f");
			assert(res.status === status && JSON.stringify(await res.json()) === JSON.stringify(body), `apiFetch: ${what} did not reach its caller as the server's answer`);
			assert(!clientContext.personHasChanged() && reloaded() === 0, `apiFetch: ${what} ended the page`);
		}
		// The 401 sent the page to sign in, as any 401 does: forgotten, so the rows below start clean.
		assert(toSignIn.length === 1, `apiFetch: the 401 with the field did not send the page to sign in (${JSON.stringify(toSignIn)})`);
		toSignIn.length = 0;
		stored.clear();
		pass("apiFetch: a 403 and a 409 without endsPage, or with it other than true, and endsPage on a 401, a 500 and a 503 reach their caller and end nothing");
		// X3a: two requests out when the page ends, answered after it: a 200 and a 401.
		const held = new Map<string, (late: Response) => void>();
		answer = (request) => new Promise<Response>((resolve) => { held.set(new URL(request.url).pathname, resolve); });
		const lateOk = api.apiFetch("/api/late-ok").then(() => "answered", () => "thrown");
		const late401 = api.apiFetch("/api/late-401").then(() => "answered", () => "thrown");
		await until(() => held.size === 2, "X3a: the two late requests were not sent");
		// X3b: a client-context read whose answer began before the ending and whose body ends after it, naming another person.
		let endBody = () => {};
		const body = new ReadableStream<Uint8Array>({ start: (stream) => { endBody = () => { stream.enqueue(new TextEncoder().encode(JSON.stringify({ remote: false, capability: "full", sharedServer: true, person: OTHER }))); stream.close(); }; } });
		const lateRead = clientContext.refreshRemoteClientContext();
		await until(() => held.has("/api/remote/client-context"), "X3b: the read was not sent");
		held.get("/api/remote/client-context")?.(new Response(body, { headers: { "content-type": "application/json" } }));
		held.delete("/api/remote/client-context");
		answer = () => Response.json(ANOTHER_PERSON, { status: 409 });
		const refused = await Promise.allSettled([api.apiFetch("/api/c"), api.apiFetch("/api/d")]);
		assert(refused.every((result) => result.status === "rejected"), "apiFetch: a 409 with endsPage came back to its caller as an answer");
		assert(clientContext.personHasChanged() && reloaded() === 1, `apiFetch: two 409s with endsPage did not end the page once (${reloaded()} reloads)`);
		held.get("/api/late-ok")?.(Response.json({ ok: true }));
		held.get("/api/late-401")?.(Response.json(SESSION_SIGNED_OUT, { status: 401 }));
		assert(await lateOk === "thrown", "X3a: a request sent before the page ended, answered 200 after, reached its caller");
		assert(await late401 === "thrown" && toSignIn.length === 0, `X3a: a request sent before the page ended, answered 401 after, reached its caller or sent the page to sign in (${JSON.stringify(toSignIn)})`);
		endBody();
		const lateResult = await lateRead;
		assert(lateResult === "person changed" && reloaded() === 1, `X3b: a read whose body ended after the page ended was taken (${lateResult}, ${reloaded()} reloads)`);
		pass("X3a, X3b apiFetch: on a changed person's page, a request sent before the ending and answered after (200, 401) throws and sends the page nowhere, and a read whose body ends after the ending is not taken");
		const before = sent.length;
		await api.apiFetch("/api/e").catch(() => {});
		assert(sent.length === before, "apiFetch: a request was sent after the page ended");
		pass("apiFetch: another 409 reaches its caller; a 409 with endsPage ends the page once and nothing is sent after it");
	} finally {
		globalThis.fetch = realFetch;
		Reflect.deleteProperty(globalThis, "location");
		Reflect.deleteProperty(globalThis, "sessionStorage");
	}
}

// Environments without an installed Chromium (the Linux Docker gate sets
// EXXETA_SKIP_BROWSER_INSTALL=1) cannot run a browser assertion at all; skip
// whole, as the other browser smokes do.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("shared server page smoke skipped (Chromium not installed)");
		fs.rmSync(tempHome, { recursive: true, force: true });
		process.exit(0);
	}
}

/** What the probe answers now: a test changes it between reads, or has the next ones fail. */
type ProbeAnswer = { person?: Person; signOut?: string; remote?: boolean; refuse?: boolean; fail: boolean; stall: boolean; holdNext: boolean; holding: boolean; released: number; release: (fail?: boolean) => void };
type Opened = { context: BrowserContext; page: Page; asked: string[]; probe: ProbeAnswer; reads: () => number; pending: () => number };

/**
 * How the server's sign-out answers in the page, and the sign-out links the page followed. "hold" answers on release();
 * "lost" writes the record (recorded()) and never answers; "signed-out" is the edge's refusal once a record ends the session.
 */
type SignOutRoute = { mode: "answer" | "refuse" | "network" | "stall" | "hold" | "lost" | "signed-out"; posts: number; release: () => void; followed: string[]; recorded?: () => void };

async function routeSignOut(context: BrowserContext, signOut: SignOutRoute): Promise<void> {
	await context.route("**/api/session/sign-out", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		signOut.posts += 1;
		if (signOut.mode === "lost") signOut.recorded?.();
		// Never answered: the page's own deadline has to end it.
		if (signOut.mode === "stall" || signOut.mode === "lost") return;
		if (signOut.mode === "signed-out") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(SESSION_SIGNED_OUT) });
		if (signOut.mode === "network") return route.abort();
		if (signOut.mode === "refuse") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify(SIGN_OUT_REFUSED) });
		if (signOut.mode === "hold") await new Promise<void>((resolve) => { signOut.release = resolve; });
		return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	// The gate's sign-out, followed: kept by path and query, and answered with a blank page.
	await context.route("**/oauth2/sign_out?**", (route) => {
		const url = new URL(route.request().url());
		signOut.followed.push(`${url.pathname}${url.search}`);
		return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Signed out</title>" });
	});
}

/** A signed-in page whose client-context probe answers sharedServer, and the person and sign-out link, as given. */
async function openApp(browser: Browser, sharedServer: boolean, prepare?: (context: BrowserContext) => Promise<unknown>, who: { person?: Person; signOut?: string; remote?: boolean; fail?: boolean } = {}): Promise<Opened> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const probe: ProbeAnswer = { ...who, fail: who.fail === true, stall: false, holdNext: false, holding: false, released: 0, release: () => {} };
	const answerBody = () => JSON.stringify({ remote: probe.remote === true, capability: "full", sharedServer, ...(probe.person ? { person: probe.person } : {}), ...(probe.signOut ? { signOut: probe.signOut } : {}) });
	await context.route("**/api/remote/client-context", async (route) => {
		// Never answered: the page's own deadline has to end it.
		if (probe.stall) return;
		// The edge refuses the person the page names.
		if (probe.refuse) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(ANOTHER_PERSON) });
		// The next question: its answer is fixed now (who is signed in at this moment) but sent only when released,
		// or it fails then: an answer or a failure that comes late, once the page has moved on.
		if (probe.holdNext) {
			probe.holdNext = false;
			const body = answerBody();
			probe.holding = true;
			const fail = await new Promise<boolean>((resolve) => { probe.release = (failed = false) => resolve(failed); });
			probe.holding = false;
			probe.released += 1;
			return fail ? route.abort() : route.fulfill({ contentType: "application/json", body });
		}
		if (probe.fail) return route.abort();
		return route.fulfill({ contentType: "application/json", body: answerBody() });
	});
	if (prepare) await prepare(context);
	const page = await context.newPage();
	const asked: string[] = [];
	let reads = 0;
	let pending = 0;
	pendingOf.set(page, () => pending);
	let roomReadies = 0;
	roomReadyOf.set(page, () => roomReadies);
	page.on("websocket", (socket) => {
		if (!socket.url().includes("persistentAgentId=")) return;
		socket.on("framereceived", (frame) => { try { if (JSON.parse(String(frame.payload))?.type === "ready") roomReadies += 1; } catch {} });
	});
	page.on("request", () => { pending += 1; });
	page.on("requestfinished", () => { pending -= 1; });
	page.on("requestfailed", () => { pending -= 1; });
	page.on("request", (request) => {
		const { pathname } = new URL(request.url());
		if (pathname === "/api/remote/client-context") reads += 1;
		if (refusedOnSharedServer(request.method(), pathname, probe.person?.admin === true)) asked.push(`${request.method()} ${pathname}`);
	});
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	return { context, page, asked, probe, reads: () => reads, pending: () => pending };
}

// Each opened page's count of requests in flight, for the helpers that are handed only the page.
const pendingOf = new WeakMap<Page, () => number>();
// Each opened page's count of ready frames on its room sockets: a room counts as entered once its socket said ready,
// so a step that drops the connection next always lands on a ready room.
const roomReadyOf = new WeakMap<Page, () => number>();

/** settled() that leaves out a probe read the row holds on purpose. */
function besideHeld(opened: Opened): Pick<Opened, "page" | "pending"> {
	return { page: opened.page, pending: () => opened.pending() - (opened.probe.holding ? 1 : 0) };
}

/** settled() for a helper that has only the page. */
async function settledPage(page: Page): Promise<void> {
	await settled({ page, pending: pendingOf.get(page) ?? (() => 0) });
}

/** Polls until the condition holds, or fails with the message. */
async function until(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = 15000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(message);
}

/** Whether the condition comes true within the time; a wait for something that should NOT happen. */
async function appears(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

/** Nothing in flight and the page has drawn twice since: the point to assert that something did NOT happen. */
async function settled(opened: Pick<Opened, "page" | "pending">): Promise<void> {
	// A long-lived request (a stream) may never end: the wait is bounded.
	await appears(() => opened.pending() <= 0, 3000);
	await opened.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** A first load of the Wallet's address, from a blank page, with the first read of client-context held: `asked` starts empty here. */
async function firstLoadOfWalletHeld(opened: Opened): Promise<void> {
	const { page, probe, asked } = opened;
	await page.goto("about:blank");
	probe.holdNext = true;
	asked.length = 0;
	await page.goto(`${baseUrl}/#/dashboard`);
	await until(() => probe.holding, "the Wallet's address: the page did not ask client-context on its first load");
	await page.locator(".dashboard").waitFor({ timeout: 10000 });
	await settled(besideHeld(opened));
}

/** The rooms' names in the order Home draws their cards. */
async function cardOrder(page: Page): Promise<string[]> {
	const texts = await page.locator(".persistent-agent-card").allInnerTexts();
	return texts.map((text) => ROOMS.find((name) => text.includes(name)) ?? "?");
}

async function openSettings(page: Page): Promise<void> {
	// The gear by its class: on a shared server Sign out comes before it in the footer.
	await page.locator(".product-sidebar-footer .sidebar-config-gear").click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10000 });
}

async function openTab(page: Page, tab: string): Promise<void> {
	await page.locator(".settings-dialog-nav button").filter({ hasText: tab }).first().click();
	await settledPage(page);
}

async function tabCount(page: Page, tab: string): Promise<number> {
	return page.locator(".settings-dialog-nav button").filter({ hasText: tab }).count();
}

async function closeSettings(page: Page): Promise<void> {
	const overlay = page.locator(".settings-overlay");
	await page.keyboard.press("Escape");
	if (!(await appears(async () => (await overlay.count()) === 0, 1000))) {
		await page.locator(".settings-dialog-close").first().click();
		await overlay.waitFor({ state: "detached", timeout: 5000 });
	}
}

async function enterRoom(page: Page, name: string): Promise<void> {
	await page.goto(`${baseUrl}/`);
	await page.waitForLoadState("networkidle");
	// "Enter" the first time, "Resume" once the room has a conversation.
	await openRoomFromHome(page, name);
	await settledPage(page);
}

// A prompt on unsaved work that holds the reload: the page stays, so what it still does is seen.
async function holdReload(page: Page): Promise<void> {
	await page.evaluate(() => window.addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; }));
	page.on("dialog", (dialog) => void dialog.dismiss());
}

// The server in front of a switched-off person, once refusing() holds: every API request 403 with endsPage, the
// page load its refusal page. Registered after openApp's own routes, so it answers first.
async function routeSwitchedOff(context: BrowserContext, refusing: () => boolean): Promise<void> {
	await context.route("**/api/**", (route) => refusing()
		? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify(SWITCHED_OFF) })
		: route.fallback());
	await context.route((url) => url.pathname === "/", (route) => refusing() && route.request().isNavigationRequest()
		? route.fulfill({ status: 403, contentType: "text/html", body: SWITCHED_OFF_PAGE })
		: route.fallback());
}

/** The reload held by a prompt on unsaved work, and each try to leave the page counted by its prompt. */
async function countHeldReloads(page: Page): Promise<() => number> {
	let tries = 0;
	await page.evaluate(() => window.addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; }));
	page.on("dialog", (dialog) => {
		if (dialog.type() === "beforeunload") tries += 1;
		void dialog.dismiss();
	});
	return () => tries;
}

/** The cover for an ended page: its line word for word, its one button Reload with the focus, nothing else. */
async function assertEndedCover(page: Page, row: string, line: string, timeoutMs = 15000): Promise<void> {
	const cover = page.locator(".person-changed-cover");
	await until(async () => (await cover.count()) === 1, `${row}: the page did not end with the cover`, timeoutMs);
	const seen = await cover.evaluate((node) => ({
		text: node.querySelector("p")?.textContent ?? "",
		buttons: Array.from(node.querySelectorAll("button")).map((button) => button.textContent),
		focused: document.activeElement?.textContent ?? "",
		inCover: !!document.activeElement?.closest(".person-changed-cover"),
	}));
	assert(seen.text === line, `${row}: the cover does not say ${JSON.stringify(line)} word for word: ${JSON.stringify(seen.text)}`);
	assert(seen.buttons.length === 1 && seen.buttons[0] === "Reload" && seen.inCover && seen.focused === "Reload", `${row}: the cover's button is not Reload with the focus: ${JSON.stringify(seen)}`);
	assert((await page.getByText(/lost its connection/).count()) === 0, `${row}: a lost-connection line shows`);
}

/** The cover for a switched-off person: the refusal's words. */
function assertSwitchedOffCover(page: Page, row: string, timeoutMs = 15000): Promise<void> {
	return assertEndedCover(page, row, SWITCHED_OFF.error, timeoutMs);
}

/** Into a room from Home, and back to Home from a room, without reloading the page. In a room means its socket said ready. */
async function openRoomFromHome(page: Page, name: string): Promise<void> {
	const readies = roomReadyOf.get(page);
	assert(readies, "a page not opened by openApp has no ready count");
	const before = readies();
	await page.locator(".persistent-agent-card").filter({ hasText: name }).locator(".persistent-agent-primary-actions .landing-action").first().click();
	await page.locator(".topbar-actions").getByRole("button", { name: "Room settings", exact: true }).waitFor({ timeout: 15000 });
	await until(() => readies() > before, `${name}: the room's live connection did not say ready`);
}

async function leaveRoomToHome(page: Page): Promise<void> {
	await page.locator(".sidebar-home-btn").click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
}

async function openRoomWorkspace(page: Page): Promise<void> {
	await page.locator(".topbar-actions").getByRole("button", { name: "Room settings", exact: true }).click();
	await page.locator(".settings-dialog-nav button").filter({ hasText: "Folder" }).first().click();
	await page.locator(".room-workspace-section").waitFor({ timeout: 10000 });
	await settledPage(page);
}

async function openShelfFile(page: Page): Promise<void> {
	// The panel names a shelf file without its extension.
	await page.locator(".attachments-entry").click();
	await page.locator(".att-card").filter({ hasText: SHELF_FILE.replace(/\.txt$/, "") }).first().locator(".att-open").click();
	await page.locator(".artifact-viewer-quiet").filter({ hasText: "Download" }).first().waitFor({ timeout: 10000 });
}

async function countText(page: Page, scope: string, text: string): Promise<number> {
	return page.locator(scope).getByText(text, { exact: true }).count();
}

/**
 * Home with its live connection passed through to the server until drop(),
 * after which every connection is closed at once: the server is still there,
 * but the page cannot reach it live, as when a sign-in runs out.
 */
async function openWithDroppableConnection(browser: Browser, sharedServer: boolean, signedOut: boolean, setUp?: (context: BrowserContext) => Promise<unknown>, who?: { person?: Person; signOut?: string }): Promise<{ opened: Opened; drop: () => void; isLive: () => boolean }> {
	let dropped = false;
	const live: WebSocketRoute[] = [];
	const opened = await openApp(browser, sharedServer, async (context) => {
		await setUp?.(context);
		await context.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			if (dropped) {
				void ws.close();
				return;
			}
			ws.connectToServer();
			live.push(ws);
		});
		if (signedOut) {
			await context.route("**/api/auth/status", (route) =>
				dropped
					? route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Not signed in.", code: "auth_required" }) })
					: route.continue());
		}
	}, who);
	return {
		opened,
		isLive: () => live.length > 0,
		drop: () => {
			dropped = true;
			for (const ws of live.splice(0)) void ws.close();
		},
	};
}

try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 200 });

	const ids: Record<string, string> = {};
	for (const name of ROOMS) {
		const created = await api("POST", "/api/persistent-agents", { displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		ids[name] = created.agentId ?? created.id ?? created.agent?.id;
		assert(typeof ids[name] === "string", `room create answered no id: ${JSON.stringify(created)}`);
	}
	// A saved order the shared page must not use: Z to A here, A to Z there.
	await api("PUT", "/api/settings/room-order", { mode: "name-desc" });
	// A room with a folder and commands on: its chip, Edit and Clear.
	await api("PUT", `/api/persistent-agents/${encodeURIComponent(ids["Bash Room"])}/workspace-default`, { root: workspaceRoot, displayLabel: "Bash Room Folder", workspaceAccessMode: "localFiles", bashEnabled: true });
	// A file on Alpha Room's shelf: its viewer offers Save.
	await api("POST", `/api/persistent-agents/${encodeURIComponent(ids["Alpha Room"])}/files`, { filename: SHELF_FILE, contentBase64: Buffer.from("shared server smoke\n").toString("base64") });

	const browser = await chromium.launch();
	try {
		// --- the first read failed, then a later one answered: on a shared server who it is can't be told, on this computer nothing changes ---
		for (const sharedServer of [true, false]) {
			const where = sharedServer ? "shared" : "this computer";
			const opened = await openApp(browser, sharedServer, undefined, { fail: true });
			const { context, page, probe, reads } = opened;
			await holdReload(page);
			// Someone is signed in by now, and the page cannot know whether it is whom it was opened for.
			if (sharedServer) probe.person = OTHER;
			probe.fail = false;
			const before = reads();
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await until(() => reads() > before, `${where}: a focus did not read again`);
			if (sharedServer) {
				const cover = page.locator(".person-changed-cover");
				await cover.waitFor({ timeout: 15000 });
				const words = await cover.locator("p").innerText();
				assert(words === UNKNOWN_PERSON_LINE, `shared: the page does not say it could not tell who is signed in: ${JSON.stringify(words)}`);
				assert((await page.locator(".product-sidebar-footer .signed-in-as").count()) === 0, "shared: the page adopted whoever is signed in now");
				pass("shared: a failed first read and a later answer with a person: the page is ended (Reload held), not adopted, and its words do not say another person");
			} else {
				await settled(opened);
				assert((await page.locator(".person-changed-cover").count()) === 0, "this computer: a failed first read and a desktop answer ended the page");
				assert((await page.locator(".room-sort").count()) === 1, "this computer: the page is not as the desktop's after the answer");
				pass("this computer: a failed first read and a later desktop answer is adopted quietly");
			}
			await closeContext(context);
		}

		// --- sharedServer: true, a conversation whose own model was taken away while the room's pick is another ---
		// The room's refusal names the conversation's model; the notice names that one, never the room's pick
		// (control: a refusal that names no model, as a server before the name was sent answers, names the room's pick).
		for (const named of [true, false]) {
			const what = named ? "model gone" : "model gone control";
			const GONE = "Gone Model On Removed Key";
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (!ws.url().includes("persistentAgentId=")) return void ws.connectToServer();
					ws.send(JSON.stringify({ type: "error", code: "room_model_unavailable", message: "This room's model is no longer offered.", provider: "removed-key", ...(named ? { model: GONE } : {}) }));
					void ws.close();
				});
			}, { person: MEMBER });
			const { context, page } = opened;
			// The room never says ready: its connection is refused at once.
			await page.goto(`${baseUrl}/`);
			await page.waitForLoadState("networkidle");
			await page.locator(".persistent-agent-card").filter({ hasText: "Beta Room" }).locator(".persistent-agent-primary-actions .landing-action").first().click();
			const notice = page.locator(".room-model-notice");
			await notice.waitFor({ timeout: 15000 });
			const line = (await notice.locator(".room-workspace-nudge-text").innerText()).trim();
			if (named) assert(line === `${GONE} is no longer offered.`, `${what}: the notice reads ${JSON.stringify(line)}`);
			// Beta Room's pick is the sign-in's model, as the Model picker names it.
			else assert(line === "GPT-6.1 Sol is no longer offered.", `${what}: the notice reads ${JSON.stringify(line)}`);
			pass(named
				? "shared: a conversation whose own model went away, the room's pick another, is told that model is no longer offered, never the room's pick"
				: "shared: a refusal naming no model keeps the notice's words, naming the room's pick");
			await closeContext(context);
		}

		// --- sharedServer: true, a read held across the second person's sign-in: a refresh does not take its old answer ---
		{
			const live: WebSocketRoute[] = [];
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { context, page, probe } = opened;
			const threadRequests: string[] = [];
			let watching = false;
			page.on("request", (request) => {
				if (watching && /\/api\/persistent-agents\/[^/]+\/threads\//.test(new URL(request.url()).pathname)) threadRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
			});
			await enterRoom(page, "Beta Room");
			await page.evaluate(() => window.addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; }));
			page.on("dialog", (dialog) => void dialog.dismiss());
			// The room drops; its retry's question is sent and held, answered by the first person.
			probe.holdNext = true;
			for (const ws of live.splice(0)) void ws.close();
			await until(() => probe.holding, "held read: the room never retried", 30000);
			// The second person signs in; the page gets the focus back while that read is still out.
			probe.person = OTHER;
			watching = true;
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			probe.release();
			// A reconnect that went on from the first answer would read the thread before the fresh read ends the page.
			await assertEndedCover(page, "held read", OTHER_PERSON_LINE);
			await settled(opened);
			assert(threadRequests.length === 0, `held read: the reconnect went on from the first person's answer and read or saved a room as the second: ${threadRequests.join(", ")}`);
			pass("shared: a read held across the second person's sign-in: the refresh takes a fresh read, the page ends with the other-person line, and no thread is read or saved");
			await closeContext(context);
		}

		// --- sharedServer: true, a room's retry whose first question fails late, after the person went to another room ---
		{
			const live: WebSocketRoute[] = [];
			let droppedRoom: string | null = null;
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.clock.install();
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (droppedRoom && ws.url().includes(droppedRoom)) {
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { context, page, probe } = opened;
			const otherRoomThread: string[] = [];
			page.on("request", (request) => {
				if (new URL(request.url()).pathname.includes(`/api/persistent-agents/${ids["Alpha Room"]}/threads/`)) otherRoomThread.push(`${request.method()} ${new URL(request.url()).pathname}`);
			});
			await enterRoom(page, "Beta Room");
			// Beta Room loses its connection; its retry's first question is held, to fail once the person has moved on.
			droppedRoom = ids["Beta Room"];
			probe.holdNext = true;
			for (const ws of live.splice(0)) void ws.close();
			await until(() => probe.holding, "late preflight: the room never retried", 30000);
			// The person leaves for another room while that question is out.
			await leaveRoomToHome(page);
			await openRoomFromHome(page, "Alpha Room");
			// What the other room's entry set off on a timer (its first save) is done before the window opens.
			await page.clock.runFor(5000);
			await settled(besideHeld(opened));
			const windowStart = otherRoomThread.length;
			// It fails now, and the server answers from here: a retry wrongly scheduled for the other room would get as far as its
			// thread within the ladder's next delays, which the clock runs through.
			probe.release(true);
			for (let second = 0; second < 10; second += 1) {
				await page.clock.runFor(1000);
				await settled(opened);
			}
			assert(otherRoomThread.length === windowStart, `late preflight: the first room's late failure made the other room read or save its thread: ${otherRoomThread.slice(windowStart).join(", ")}`);
			await settled(opened);
			assert((await page.locator(".composer-reconnect-btn").count()) === 0, "late preflight: the other room shows Reconnect");
			pass("shared: a room's retry that fails late, after the person went to another room, does nothing to that other room");
			await closeContext(context);
		}

		// --- sharedServer: true, an admin demoted, then Settings opened for the first time ---
		{
			// A component that is mounted after the role went asks the answer anew: it must get the newest one, not the first.
			const opened = await openApp(browser, true, undefined, { person: ADMIN, signOut: SIGN_OUT_LINK });
			const { context, page, probe } = opened;
			assert((await page.locator(".product-sidebar-footer .signed-in-as-tag").count()) === 1, "demoted admin: the Admin tag is missing at the start");
			probe.person = { ...ADMIN, admin: false };
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await until(async () => (await page.locator(".product-sidebar-footer .signed-in-as-tag").count()) === 0, "demoted admin: the footer still shows the Admin tag after the read");
			await openSettings(page);
			await openTab(page, "AI setup");
			await until(async () => (await countText(page, ".settings-overlay", ADMIN_HINT)) === 2, "demoted admin: Settings opened afterwards shows the old role (the setup is still open)");
			assert((await page.locator(".settings-overlay .add-provider-toggle").count()) === 0, "demoted admin: Settings opened afterwards offers Add provider");
			assert((await page.locator(".settings-overlay .ai-defaults-group .room-model-pick:not(:disabled)").count()) === 0, "demoted admin: Settings opened afterwards lets the default models be changed");
			pass("shared: after an admin is demoted, Settings opened for the first time shows the new role");
			await closeContext(context);
		}

		// --- sharedServer: true, the admin's AI setup: each removal asks first, in the shared server's words ---
		{
			const keyOnly = { id: "groq", name: "Groq" };
			const withModels = "mistral";
			await api("POST", "/api/auth/api-key", { provider: keyOnly.id, key: "smoke-key-only" });
			await api("POST", "/api/auth/api-key", { provider: withModels, key: "smoke-with-models" });
			const catalog = await api("GET", `/api/persistent-agent-ai-profiles/model-catalog?provider=${withModels}`);
			await api("PUT", "/api/persistent-agent-ai-profiles/custom", { providerId: withModels, roomModels: [catalog.suggested], learnModel: catalog.suggested });
			const profileId = `custom-${withModels}`;
			const profileLabel = String((await api("GET", "/api/persistent-agent-ai-profile")).profiles.find((profile: { id: string }) => profile.id === profileId)?.label ?? "");
			assert(profileLabel, "shared removals: the mistral profile was not saved");
			const stillSaved = async () => (await api("GET", "/api/persistent-agent-ai-profile")).profiles.some((profile: { id: string }) => profile.id === profileId);
			const keyRow = (page: Page) => page.locator(".settings-overlay .add-provider-row-group").filter({ has: page.locator(".settings-row-label", { hasText: new RegExp(`^${keyOnly.name}$`) }) });

			// A member's row on a shared server: its sign-in status lists no provider, and the row still reads as a key, collapsed and open.
			{
				const { context, page } = await openApp(browser, true, (ctx) => ctx.route("**/api/auth/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(SHARED_AUTH_STATUS) })), { person: MEMBER, signOut: SIGN_OUT_LINK });
				await openSettings(page);
				await openTab(page, "AI setup");
				const row = page.locator(`.settings-overlay .ai-profile-row-group[data-provider-id="${withModels}"]`);
				await row.waitFor({ timeout: 10000 });
				assert((await row.locator(".ai-profile-sub").innerText()).trim() === "Key saved", `shared member row: the collapsed row reads ${JSON.stringify(await row.locator(".ai-profile-sub").innerText())}`);
				await row.locator(".ai-profile-models-toggle").click();
				const opened = row.locator(".ai-profile-models");
				await opened.waitFor({ timeout: 5000 });
				assert((await row.locator(".ai-profile-sub").innerText()).trim() === "Key saved", `shared member row: the opened row reads ${JSON.stringify(await row.locator(".ai-profile-sub").innerText())}`);
				const words = await opened.innerText();
				assert(words.trim() !== "" && !/connection|key saved|signed in|not connected/i.test(words), `shared member row: the opened row holds just its models, got ${JSON.stringify(words)}`);
				pass("shared: with no provider in the sign-in status, a member's key row reads key saved, collapsed and open, and opens just its models");
				await closeContext(context);
			}

			// No provider yet: a settled list says so, by who reads it, and never that it is still loading.
			for (const [who, person] of [["admin", ADMIN], ["member", MEMBER]] as const) {
				const { context, page } = await openApp(browser, true, (ctx) => ctx.route("**/api/persistent-agent-ai-profile", async (route) => {
					if (route.request().method() !== "GET") return route.continue();
					const answer = await (await route.fetch()).json();
					return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...answer, profiles: [], activeProfileId: null, activeProfile: null }) });
				}), { person, signOut: SIGN_OUT_LINK });
				await openSettings(page);
				await openTab(page, "AI setup");
				await until(async () => (await countText(page, ".settings-overlay .ai-profile-card-empty", NO_PROVIDERS[who])) === 1, `shared empty list: the ${who} is not told ${JSON.stringify(NO_PROVIDERS[who])}`);
				assert((await countText(page, ".settings-overlay", STILL_LOADING)) === 0, `shared empty list: the ${who}'s settled list says it is still loading`);
				pass(`shared: a settled AI setup with no provider tells the ${who} ${JSON.stringify(NO_PROVIDERS[who])}, never that it is still loading`);
				await closeContext(context);
			}

			for (const sharedServer of [true, false]) {
				const what = sharedServer ? "shared removals" : "desktop removals";
				const { context, page, asked } = await openApp(browser, sharedServer, undefined, sharedServer ? { person: ADMIN, signOut: SIGN_OUT_LINK } : {});
				await openSettings(page);
				await openTab(page, "AI setup");
				const row = page.locator(`.settings-overlay .ai-profile-row-group[data-provider-id="${withModels}"]`);
				await row.waitFor({ timeout: 10000 });
				if (sharedServer) {
					// A double click on Remove provider…, with the menu opening below the row and then above it (a window too short below): the first click asks, the second removes nothing.
					const fullSize = page.viewportSize();
					for (const direction of ["below", "above"] as const) {
						if (direction === "above" && fullSize) {
							const box = await row.boundingBox();
							if (box) await page.setViewportSize({ width: fullSize.width, height: Math.ceil(box.y + box.height + 40) });
							await row.scrollIntoViewIfNeeded();
						}
						const opener = row.locator(".ai-profile-menu-btn");
						await opener.click();
						const remove = page.locator(".ai-profile-menu-item").filter({ hasText: "Remove provider…" });
						await remove.waitFor({ timeout: 10000 });
						const [menuBox, openerBox] = [await page.locator(".ai-profile-menu-item").first().boundingBox(), await opener.boundingBox()];
						const opened = menuBox && openerBox && menuBox.y >= openerBox.y + openerBox.height ? "below" : "above";
						assert(opened === direction, `${what}: the row menu opened ${opened} the row, where this case needs ${direction}`);
						await remove.dblclick();
						await page.waitForLoadState("networkidle");
						assert(await stillSaved(), `${what}: a double click on Remove provider… with the menu ${direction} the row removed the profile`);
						await page.keyboard.press("Escape");
						await until(async () => (await page.locator(".ai-profile-menu-item").count()) === 0, `${what}: the row menu stayed open after Escape`);
					}
					if (fullSize) await page.setViewportSize(fullSize);
				}
				// The row menu's Remove provider…
				await row.locator(".ai-profile-menu-btn").click();
				await page.locator(".ai-profile-menu-item").filter({ hasText: "Remove provider…" }).click();
				const menuLine = sharedServer ? REMOVE_LINE(profileLabel) : DESKTOP_REMOVE_LINE(profileLabel);
				await until(async () => (await countText(page, "body", menuLine)) === 1, `${what}: the row menu's confirmation does not read ${JSON.stringify(menuLine)}`);
				await page.locator(".ai-profile-menu-item").filter({ hasText: "Keep it" }).click();
				assert(await stillSaved(), `${what}: Keep it removed the profile`);
				if (sharedServer) {
					// Approve models' Remove profile asks the same, and removes nothing until it is answered. Keep it left the menu open.
					await page.locator(".ai-profile-menu-item").filter({ hasText: "Approve models" }).click();
					await page.locator(".configure-profile-remove").click();
					await until(async () => (await countText(page, ".configure-profile-remove-confirm", REMOVE_LINE(profileLabel))) === 1, `${what}: Approve models' Remove profile does not ask first`);
					assert(await stillSaved(), `${what}: Remove profile removed the profile before it was confirmed`);
					await page.locator(".configure-profile-remove-confirm button").filter({ hasText: "Keep it" }).click();
					assert((await page.locator(".configure-profile-remove-confirm").count()) === 0, `${what}: Keep it left the confirmation open`);
					await page.locator(".configure-profile-modal button").filter({ hasText: /^Cancel$/ }).click();
				} else {
					await page.locator(".ai-profile-menu-backdrop").click();
				}
				// The add menu's saved key with no approved models: Remove key.
				await page.locator(".settings-overlay .add-provider-toggle").click();
				await keyRow(page).waitFor({ timeout: 10000 });
				assert((await keyRow(page).locator(".settings-row-sub").innerText()).trim() === "API key · saved", `${what}: the key-only row does not read saved`);
				if (sharedServer) {
					// On a phone the saved key's buttons stay on the screen, and the pane never scrolls sideways.
					const wide = page.viewportSize();
					await page.setViewportSize({ width: 390, height: 800 });
					await until(async () => (await keyRow(page).locator("button").evaluateAll((buttons) => buttons.every((button) => { const box = button.getBoundingClientRect(); return box.left >= 0 && box.right <= 390; }))), `${what}: on a phone the saved key's buttons run past the screen`);
					assert(await page.locator(".settings-dialog-pane").first().evaluate((pane) => pane.scrollWidth <= pane.clientWidth), `${what}: on a phone the saved key's row makes the settings pane scroll sideways`);
					const cut = await keyRow(page).locator("button").evaluateAll((buttons) => buttons.filter((button) => button.scrollWidth > button.clientWidth).map((button) => button.textContent?.trim()));
					assert(cut.length === 0, `${what}: on a phone the saved key's buttons cut their words: ${JSON.stringify(cut)}`);
					if (wide) await page.setViewportSize(wide);
				}
				// A shared server's asks first, so its name ends in "…".
				await keyRow(page).locator("button").filter({ hasText: sharedServer ? /^Remove key…$/ : /^Remove key$/ }).click();
				if (sharedServer) {
					await until(async () => (await countText(page, ".add-provider-remove-confirm", REMOVE_KEY_ONLY_LINE(keyOnly.name))) === 1, `${what}: Remove key does not ask first`);
					// The button that opened it stays in its place, switched off, so the row's buttons do not move; the focus goes to the safe choice.
					const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
					assert(focused === "Keep it", `${what}: with Remove key's confirmation open the focus is on ${JSON.stringify(focused)}`);
					const removeKeyShown = keyRow(page).locator("button").filter({ hasText: /^Remove key…$/ });
					assert((await removeKeyShown.count()) === 1 && (await removeKeyShown.isDisabled()), `${what}: Remove key left its row, or stayed on, while its question is asked`);
					assert((await api("GET", "/api/auth/providers")).providers.find((provider: { id: string }) => provider.id === keyOnly.id)?.configured === true, `${what}: the key went before the removal was confirmed`);
					await page.locator(".add-provider-remove-confirm button").filter({ hasText: /^Remove$/ }).click();
				} else {
					assert((await page.locator(".add-provider-remove-confirm").count()) === 0, `${what}: this computer's Remove key asks first`);
				}
				await until(async () => (await keyRow(page).locator(".settings-row-sub").innerText()).trim() === "API key", `${what}: the key-only row still reads saved after Remove key`);
				assert((await api("GET", "/api/auth/providers")).providers.find((provider: { id: string }) => provider.id === keyOnly.id)?.configured === false, `${what}: the key is still saved`);
				if (sharedServer) assert(asked.length === 0, `${what}: the page asked for what a shared server refuses: ${asked.join(", ")}`);
				pass(sharedServer
					? "shared: the admin's row menu Remove provider…, Approve models' Remove profile and the add menu's Remove key each ask first in the shared server's words, remove nothing until answered, and Remove key then removes the key with no refused request; a double click on Remove provider… keeps the profile, with the menu below the row and above it"
					: "this computer: the row menu keeps its own words and Remove key removes at once, with no question");
				await closeContext(context);
				if (sharedServer) await api("POST", "/api/auth/api-key", { provider: keyOnly.id, key: "smoke-key-only" });
			}

			// Back as the rows after this one found the server: the key-only key went in the desktop pass.
			const removed = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom/${profileId}`, { method: "DELETE" });
			assert(removed.ok, `shared removals: removing the mistral profile afterwards: ${removed.status} ${await removed.text()}`);
		}

		// --- the admin's gateway forms: the standing line and the new address's question on a shared server only, and there a form
		// that leaves the name and address alone never puts back what another window saved since it opened; this computer's
		// forms send their name and address as they always did ---
		{
			// Closed loopback ports: the forms' model loads fail at once and fall back to the approved list.
			const addresses = ["http://127.0.0.1:9/v1", "http://127.0.0.1:9/v2", "http://127.0.0.1:9/v3", "http://127.0.0.1:9/v4"];
			// Another server than the addresses above: its own host, so the saved key does not go with it.
			const OTHER_SERVER_ADDRESS = "http://127.0.0.2:9/v1";
			const OTHER_SERVER_ADDRESS_LATER = "http://127.0.0.2:9/v2";
			// The server's own answer to a move to another server with no key (gateways.ts).
			const KEY_FOR_NEW_ADDRESS = "Enter the gateway API key to save a new address.";
			const created = await api("POST", "/api/persistent-agent-ai-profiles/gateways", { label: "Smoke gateway", baseUrl: addresses[0], key: "smoke-gateway-key", roomModels: [{ modelId: "gw-one" }] });
			const gateway = { id: String(created.gateway.id), providerId: String(created.gateway.providerId) };
			const storedGateway = async () => api("GET", `/api/persistent-agent-ai-profiles/gateways/${encodeURIComponent(gateway.id)}`);
			// Another window's save: the address only, as Edit gateway sends it.
			const otherWindowMoves = async (baseUrl: string) => api("PUT", `/api/persistent-agent-ai-profiles/gateways/${encodeURIComponent(gateway.id)}`, { baseUrl, roomModels: (await storedGateway()).roomModels.map((model: { modelId: string }) => ({ modelId: model.modelId })) });
			const openMenuItem = async (page: Page, item: string) => {
				const row = page.locator(`.settings-overlay .ai-profile-row-group[data-provider-id="${gateway.providerId}"]`);
				await row.waitFor({ timeout: 10000 });
				await row.locator(".ai-profile-menu-btn").click();
				await page.locator(".ai-profile-menu-item").filter({ hasText: new RegExp(`^${item}$`) }).click();
			};
			for (const sharedServer of [true, false]) {
				const what = sharedServer ? "shared gateway forms" : "desktop gateway forms";
				const { context, page, asked } = await openApp(browser, sharedServer, undefined, sharedServer ? { person: ADMIN, signOut: SIGN_OUT_LINK } : {});
				await openSettings(page);
				await openTab(page, "AI setup");

				// Approve models, then another window moves the address, then this one saves its models.
				const openedWith = await storedGateway();
				await openMenuItem(page, "Approve models");
				const approve = page.locator(".gateway-config-modal");
				const saveModels = approve.locator("button").filter({ hasText: /^Save models$/ });
				await until(() => saveModels.isEnabled(), `${what}: Approve models never let its models be saved`);
				assert((await countText(page, ".gateway-config-modal", GATEWAY_LINE)) === (sharedServer ? 1 : 0), `${what}: Approve models ${sharedServer ? "lacks" : "shows"} the gateway line`);
				await otherWindowMoves(addresses[1]);
				const gatewayPut = () => page.waitForRequest((request) => new URL(request.url()).pathname === `/api/persistent-agent-ai-profiles/gateways/${gateway.id}` && request.method() === "PUT", { timeout: 10000 }).then((request) => request.postDataJSON() as Record<string, unknown>);
				let sent = gatewayPut();
				await saveModels.click();
				await until(async () => (await approve.count()) === 0, `${what}: Approve models did not close after Save models`);
				const approveBody = await sent;
				// This computer sends the name and the address it opened with, as before; a shared server neither.
				const afterApprove = sharedServer ? addresses[1] : openedWith.baseUrl;
				assert(sharedServer ? !("label" in approveBody) && !("baseUrl" in approveBody) : approveBody.label === openedWith.label && approveBody.baseUrl === openedWith.baseUrl, `${what}: Approve models sent ${JSON.stringify({ label: approveBody.label, baseUrl: approveBody.baseUrl })}`);
				assert((await storedGateway()).baseUrl === afterApprove, `${what}: after Approve models the address is ${(await storedGateway()).baseUrl}`);

				// Edit gateway with a new name only, after another window moved the address: no question, the name goes, the address stays.
				await openMenuItem(page, "Edit gateway");
				const edit = page.locator(".gateway-config-modal");
				const name = edit.locator('input[placeholder="Company gateway"]');
				const address = edit.locator('input[placeholder="https://litellm.example.com/v1"]');
				await until(async () => (await address.inputValue()) === afterApprove, `${what}: Edit gateway did not load the address`);
				assert((await countText(page, ".gateway-config-modal", GATEWAY_LINE)) === (sharedServer ? 1 : 0), `${what}: Edit gateway ${sharedServer ? "lacks" : "shows"} the gateway line`);
				await otherWindowMoves(addresses[2]);
				const renamed = sharedServer ? "Shared smoke gateway" : "Desktop smoke gateway";
				await name.fill(renamed);
				const saveGateway = edit.locator("button").filter({ hasText: /^Save gateway$/ });
				sent = gatewayPut();
				await saveGateway.click();
				await until(async () => (await edit.count()) === 0, `${what}: a new name alone asked before it saved`);
				const renameBody = await sent;
				assert(sharedServer ? renameBody.label === renamed && !("baseUrl" in renameBody) : renameBody.label === renamed && renameBody.baseUrl === afterApprove, `${what}: a new name alone sent ${JSON.stringify({ label: renameBody.label, baseUrl: renameBody.baseUrl })}`);
				const movedTo = sharedServer ? addresses[2] : afterApprove;
				const afterRename = await storedGateway();
				assert(afterRename.label === renamed && afterRename.baseUrl === movedTo, `${what}: a new name alone saved ${JSON.stringify({ label: afterRename.label, baseUrl: afterRename.baseUrl })}`);

				// Edit gateway with a new address: a shared server asks first, Keep editing saves nothing, a double click on Save only asks, Use new address saves it.
				await openMenuItem(page, "Edit gateway");
				await until(async () => (await address.inputValue()) === movedTo, `${what}: Edit gateway did not load the moved address`);
				await address.fill(addresses[3]);
				await saveGateway.click();
				if (sharedServer) {
					await until(async () => (await countText(page, ".gateway-address-confirm", NEW_ADDRESS_LINE)) === 1, `${what}: a new address does not ask first`);
					assert((await storedGateway()).baseUrl === addresses[2], `${what}: the new address was saved before it was confirmed`);
					await page.locator(".gateway-address-confirm button").filter({ hasText: /^Keep editing$/ }).click();
					assert((await page.locator(".gateway-address-confirm").count()) === 0 && (await saveGateway.count()) === 1, `${what}: Keep editing did not go back to the form`);
					assert((await storedGateway()).baseUrl === addresses[2], `${what}: Keep editing saved the new address`);
					// "Use new address" takes Save's place: the second click of a double click on Save never answers it.
					await saveGateway.dblclick();
					await until(async () => (await countText(page, ".gateway-address-confirm", NEW_ADDRESS_LINE)) === 1, `${what}: a double click on Save does not ask first`);
					await page.waitForLoadState("networkidle");
					assert((await page.locator(".gateway-address-confirm").count()) === 1 && (await storedGateway()).baseUrl === addresses[2], `${what}: a double click on Save answered "use the new address?"`);
					await page.locator(".gateway-address-confirm button").filter({ hasText: /^Use new address$/ }).click();
				} else {
					assert((await page.locator(".gateway-address-confirm").count()) === 0, `${what}: this computer asks before a new address`);
				}
				await until(async () => (await edit.count()) === 0, `${what}: Edit gateway did not close after the new address`);
				assert((await storedGateway()).baseUrl === addresses[3], `${what}: the new address was not saved: ${(await storedGateway()).baseUrl}`);
				if (sharedServer) {
					// A move to another server with the key left blank: no question whose yes the server would refuse, the key field asks for that server's key, and nothing is saved; with a key typed, the question comes.
					await openMenuItem(page, "Edit gateway");
					await until(async () => (await address.inputValue()) === addresses[3], `${what}: Edit gateway did not load the address before a move to another server`);
					await address.fill(OTHER_SERVER_ADDRESS);
					await saveGateway.click();
					await until(async () => (await countText(page, ".gateway-config-modal", KEY_FOR_NEW_ADDRESS)) === 1, `${what}: a move to another server with no key does not ask for the key`);
					// The key field takes the focus, so a long form brings its sentence into view.
					await until(async () => (await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.getAttribute("placeholder"))) === "leave blank to keep the saved key", `${what}: the key field does not take the focus when the key is asked for`);
					assert((await page.locator(".gateway-address-confirm").count()) === 0, `${what}: a move to another server with no key asks "use the new address?"`);
					assert((await storedGateway()).baseUrl === addresses[3], `${what}: a move to another server with no key saved the address`);
					const keyField = edit.locator('input[placeholder="leave blank to keep the saved key"]');
					await keyField.fill("smoke-other-server-key");
					await saveGateway.click();
					await until(async () => (await countText(page, ".gateway-address-confirm", NEW_ADDRESS_LINE)) === 1, `${what}: a move to another server with its key does not ask first`);
					// Clearing the key with the question open takes the question away.
					await keyField.fill("");
					assert((await page.locator(".gateway-address-confirm").count()) === 0, `${what}: the question stayed after the key was cleared`);
					// Another window moves the gateway to that server meanwhile: this form, loaded before, still asks for the key and saves nothing.
					const moved = await api("PUT", `/api/persistent-agent-ai-profiles/gateways/${encodeURIComponent(gateway.id)}`, { baseUrl: OTHER_SERVER_ADDRESS, key: "smoke-other-window-key", roomModels: (await storedGateway()).roomModels.map((model: { modelId: string }) => ({ modelId: model.modelId })) });
					assert(moved?.gateway?.baseUrl === OTHER_SERVER_ADDRESS || (await storedGateway()).baseUrl === OTHER_SERVER_ADDRESS, `${what}: the other window's move to another server was not saved`);
					await address.fill(OTHER_SERVER_ADDRESS_LATER);
					await saveGateway.click();
					await until(async () => (await countText(page, ".gateway-config-modal", KEY_FOR_NEW_ADDRESS)) === 1, `${what}: a form loaded before another window's move does not ask for the key`);
					assert((await page.locator(".gateway-address-confirm").count()) === 0, `${what}: a form loaded before another window's move asks "use the new address?"`);
					assert((await storedGateway()).baseUrl === OTHER_SERVER_ADDRESS, `${what}: a form loaded before another window's move saved ${(await storedGateway()).baseUrl} unasked`);
					await edit.locator("button").filter({ hasText: /^Cancel$/ }).click();
					await api("PUT", `/api/persistent-agent-ai-profiles/gateways/${encodeURIComponent(gateway.id)}`, { baseUrl: addresses[3], key: "smoke-gateway-key", roomModels: (await storedGateway()).roomModels.map((model: { modelId: string }) => ({ modelId: model.modelId })) });
				} else {
					// This computer: the server's answer to a move with no key shows at the key field, and the focus stays where it was.
					await openMenuItem(page, "Edit gateway");
					await until(async () => (await address.inputValue()) === addresses[3], `${what}: Edit gateway did not load the address before a move to another server`);
					await address.fill(OTHER_SERVER_ADDRESS);
					await saveGateway.click();
					await until(async () => (await countText(page, ".gateway-config-modal", KEY_FOR_NEW_ADDRESS)) === 1, `${what}: a move to another server with no key does not show the server's answer`);
					assert((await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.getAttribute("placeholder"))) !== "leave blank to keep the saved key", `${what}: the key field takes the focus on this computer`);
					assert((await storedGateway()).baseUrl === addresses[3], `${what}: a move to another server with no key saved the address`);
					await edit.locator("button").filter({ hasText: /^Cancel$/ }).click();
				}
				if (sharedServer) assert(asked.length === 0, `${what}: the page asked for what a shared server refuses: ${asked.join(", ")}`);
				pass(sharedServer
					? "shared: both gateway forms carry the gateway line, a new address asks first and Keep editing saves nothing, a move to another server with no key asks for the key and not the question, and a form that left the name and address alone never puts back an address another window saved"
					: "this computer: no gateway line and no question before a new address, and both forms send their name and address as before");
				await closeContext(context);
				await otherWindowMoves(addresses[0]);
			}
			const removed = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/gateways/${encodeURIComponent(gateway.id)}`, { method: "DELETE" });
			assert(removed.ok, `shared gateway forms: removing the smoke gateway afterwards: ${removed.status} ${await removed.text()}`);
		}

		// --- where a provider's models run: a member reads each provider's label beside its models in both model menus and
		// in AI setup, and the admin states it in a gateway's form and a key's Approve models; this computer shows neither ---
		{
			// The server here is this computer's, which never answers a location: a shared server's answers are stood in for.
			const places = ["eu", "outside-eu", "unknown"] as const;
			const assigned = new Map<string, (typeof places)[number]>();
			const placeOf = (id: string) => {
				if (!assigned.has(id)) assigned.set(id, places[assigned.size % places.length]);
				return assigned.get(id)!;
			};
			const asShared = async (ctx: BrowserContext, extra: Record<string, Record<string, unknown>> = {}) => {
				await ctx.route("**/api/persistent-agent-room/model-status", async (route) => {
					const status = await (await route.fetch()).json();
					return route.fulfill({ json: { ...status, providers: (status.providers ?? []).map((provider: { id: string }) => ({ ...provider, runsIn: placeOf(provider.id) })) } });
				});
				await ctx.route("**/api/persistent-agent-ai-profile", async (route) => {
					if (route.request().method() !== "GET") return route.fallback();
					const status = await (await route.fetch()).json();
					return route.fulfill({ json: { ...status, profiles: status.profiles.map((profile: { id: string; provider: { id: string } }) => ({ ...profile, runsIn: placeOf(profile.provider.id), setByInstall: false, ...(extra[profile.id] ?? {}) })) } });
				});
				await ctx.route("**/api/persistent-agent-ai-profiles/gateways/*", async (route) => {
					if (route.request().method() !== "GET") return route.fallback();
					const gateway = await (await route.fetch()).json();
					return route.fulfill({ json: { ...gateway, runsIn: placeOf(gateway.providerId), setByInstall: false, ...(extra[gateway.id] ?? {}) } });
				});
			};
			// Each label on the page: the words for the eye and the sentence for a screen reader, in the scope's order.
			const labels = async (page: Page, scope: string) => page.locator(`${scope} .models-run-in`).evaluateAll((spans) => spans.map((span) => `${span.querySelector("[aria-hidden=true]")?.textContent ?? ""}|${span.querySelector(".sr-only")?.textContent ?? ""}`));
			const want = (id: string) => `${RUNS_IN_LABEL[placeOf(id)].short}|${RUNS_IN_LABEL[placeOf(id)].line}`;
			// The line above a list's models: shown, above its first model and starting where the group headings' words do, on a
			// shared server; none on this computer.
			const listLine = async (page: Page, list: string, what: string) => {
				// Where an element's words start: its edge plus its own inset.
				const line = page.locator(`${list} .models-run-in-note`);
				const shown = await line.evaluateAll((lines) => lines.map((element) => ({ text: (element as HTMLElement).innerText.trim(), seen: (element as HTMLElement).checkVisibility(), top: element.getBoundingClientRect().top, left: element.getBoundingClientRect().left + parseFloat(getComputedStyle(element).paddingLeft) })));
				const firstModel = await page.locator(`${list} [role=option]`).first().evaluate((row) => row.getBoundingClientRect().top);
				const heading = await page.locator(`${list} .room-model-menu-kicker:not(.models-run-in-note)`).first().evaluate((element) => element.getBoundingClientRect().left + parseFloat(getComputedStyle(element).paddingLeft));
				return { shown, firstModel, heading, what };
			};
			const assertListLine = ({ shown, firstModel, heading, what }: Awaited<ReturnType<typeof listLine>>, sharedServer: boolean) => {
				if (!sharedServer) return assert(shown.length === 0, `${what}: a line above the models on this computer: ${JSON.stringify(shown)}`);
				assert(shown.length === 1 && shown[0].text === RUNS_IN_LIST_LINE && shown[0].seen && shown[0].top < firstModel, `${what}: the line above the models reads ${JSON.stringify(shown)}, first model at ${firstModel}`);
				assert(Math.abs(shown[0].left - heading) < 1, `${what}: the line's words start at ${shown[0].left}, the group headings' at ${heading}`);
			};

			for (const sharedServer of [true, false]) {
				const what = sharedServer ? "shared locations" : "desktop locations";
				const { context, page } = await openApp(browser, sharedServer, sharedServer ? (ctx) => asShared(ctx) : undefined, sharedServer ? { person: MEMBER, signOut: SIGN_OUT_LINK } : {});
				const providers = (await api("GET", "/api/persistent-agent-room/model-status")).providers as { id: string; label: string }[];
				// The groups a menu shows (a shared server's leave subscriptions out), each with its provider.
				const shownGroups = async (scope: string) => (await page.locator(`${scope}[aria-label]`).evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label") ?? "")))
					.map((label) => ({ label, id: providers.find((provider) => provider.label === label)?.id ?? "" }));
				// Room settings, Model: every model row carries its provider's label.
				// Not Beta Room: the pick below stays with the room's one conversation, and later rows need Beta Room to follow the
				// admin's default model.
				await enterRoom(page, "Alpha Room");
				await page.locator(".topbar-actions").getByRole("button", { name: "Room settings", exact: true }).click();
				await page.locator(".settings-dialog-nav button").filter({ hasText: "Model" }).first().click();
				await page.locator(".room-model-pick:not(:disabled)").first().click();
				// The menu opens before the room's models have loaded: wait for a provider's group.
				await page.locator(".room-model-menu .room-model-menu-group[aria-label]").first().waitFor({ timeout: 10000 });
				const inRoomSettings = await shownGroups(".room-model-menu .room-model-menu-group");
				assertListLine(await listLine(page, ".room-model-menu", `${what}: Room settings' menu`), sharedServer);
				assert(inRoomSettings.length > 0 && inRoomSettings.every((group) => group.id), `${what}: Room settings' menu groups ${JSON.stringify(inRoomSettings)}`);
				for (const provider of inRoomSettings) {
					const group = `.room-model-menu .room-model-menu-group[aria-label="${provider.label}"]`;
					const rows = await page.locator(`${group} [role=option]`).count();
					assert(rows > 0, `${what}: Room settings' menu has no ${provider.label} rows`);
					const seen = await labels(page, group);
					assert(JSON.stringify(seen) === JSON.stringify(sharedServer ? Array(rows).fill(want(provider.id)) : []), `${what}: Room settings' ${provider.label} rows carry ${JSON.stringify(seen)}`);
				}
				await page.keyboard.press("Escape");
				await closeSettings(page);
				// The message box's model menu: the same.
				// It opens on the effort dial when the model has one; the models are a step on.
				await page.locator(".model-pick-trigger").first().click();
				await page.locator(".model-pick-effort-model, .model-pick-group").first().waitFor({ timeout: 10000 });
				if ((await page.locator(".model-pick-group").count()) === 0) await page.locator(".model-pick-effort-model").click();
				await page.locator(".model-pick-group").first().waitFor({ timeout: 10000 });
				const inMessageBox = await shownGroups(".model-pick-group");
				assertListLine(await listLine(page, ".model-pick-list", `${what}: the message box's menu`), sharedServer);
				assert(inMessageBox.length > 0 && inMessageBox.every((group) => group.id), `${what}: the message box's menu groups ${JSON.stringify(inMessageBox)}`);
				for (const provider of inMessageBox) {
					const group = `.model-pick-group[aria-label="${provider.label}"]`;
					const rows = await page.locator(`${group} [role=option]`).count();
					const seen = await labels(page, group);
					assert(rows > 0 && JSON.stringify(seen) === JSON.stringify(sharedServer ? Array(rows).fill(want(provider.id)) : []), `${what}: the message box's ${provider.label} rows (${rows}) carry ${JSON.stringify(seen)}`);
				}
				if (sharedServer) {
					// On a phone the list is a sheet from the bottom, with its own inset: the line keeps the headings' there too.
					const wide = page.viewportSize();
					await page.keyboard.press("Escape");
					if ((await page.locator(".model-pick-effort").count()) > 0) await page.keyboard.press("Escape");
					await until(async () => (await page.locator(".model-pick-group, .model-pick-effort").count()) === 0, `${what}: the message box's model menu did not close`);
					await page.setViewportSize({ width: 390, height: 844 });
					await page.locator(".model-pick-trigger").first().click();
					await page.locator(".model-pick-sheet .model-pick-effort-model, .model-pick-sheet .model-pick-group").first().waitFor({ timeout: 10000 });
					if ((await page.locator(".model-pick-sheet .model-pick-group").count()) === 0) await page.locator(".model-pick-effort-model").click();
					await page.locator(".model-pick-sheet .model-pick-group").first().waitFor({ timeout: 10000 });
					assertListLine(await listLine(page, ".model-pick-sheet .model-pick-list", `${what}: the message box's menu on a phone`), sharedServer);
					await page.keyboard.press("Escape");
					if ((await page.locator(".model-pick-effort").count()) > 0) await page.keyboard.press("Escape");
					await until(async () => (await page.locator(".model-pick-group, .model-pick-effort").count()) === 0, `${what}: the message box's model menu did not close on a phone`);
					if (wide) await page.setViewportSize(wide);
					await page.locator(".model-pick-trigger").first().click();
					await page.locator(".model-pick-effort-model, .model-pick-group").first().waitFor({ timeout: 10000 });
					if ((await page.locator(".model-pick-group").count()) === 0) await page.locator(".model-pick-effort-model").click();
					await page.locator(".model-pick-group").first().waitFor({ timeout: 10000 });
					// The list can open over the button that opened it: the second click of a double click picks nothing.
					const other = page.locator(".model-pick-group [role=option]:not(.is-current)").first();
					await other.dispatchEvent("click", { detail: 2 });
					await page.waitForLoadState("networkidle");
					assert((await page.locator(".model-pick-group").count()) > 0 && (await other.getAttribute("aria-selected")) !== "true", `${what}: a double click's second click picked a model in the message box's menu`);
					// A first click still picks: the model in use, picked again, closes the list or steps on to its effort.
					await page.locator(".model-pick-group [role=option].is-current").first().dispatchEvent("click", { detail: 1 });
					await until(async () => (await page.locator(".model-pick-group").count()) === 0, `${what}: a first click on a model in the message box's menu did nothing`);
				}
				await page.keyboard.press("Escape");
				if ((await page.locator(".model-pick-effort").count()) > 0) await page.keyboard.press("Escape");
				await until(async () => (await page.locator(".model-pick-group, .model-pick-effort").count()) === 0, `${what}: the message box's model menu did not close`);
				// AI setup, from Home: beside each provider's name.
				await page.goto(`${baseUrl}/`);
				await page.waitForLoadState("networkidle");
				await openSettings(page);
				await openTab(page, "AI setup");
				const rowGroups = page.locator(".settings-overlay .ai-profile-row-group");
				await rowGroups.first().waitFor({ timeout: 10000 });
				for (const id of await rowGroups.evaluateAll((groups) => groups.map((group) => group.getAttribute("data-provider-id") ?? ""))) {
					const seen = await labels(page, `.settings-overlay .ai-profile-row-group[data-provider-id="${id}"] .ai-profile-name`);
					assert(JSON.stringify(seen) === JSON.stringify(sharedServer ? [want(id)] : []), `${what}: AI setup's ${id} row carries ${JSON.stringify(seen)}`);
				}
				pass(sharedServer
					? "shared: a member reads each provider's location beside every one of its models in Room settings and the message box, and beside it in AI setup, the short words for the eye and the admin's sentence for a screen reader, with one line above each model list saying the admin states it"
					: "this computer: no location beside any model or provider");
				await closeContext(context);
			}

			// The admin's field: a gateway's form and a key's Approve models, sent only when changed; read-only for the install's gateway.
			const created = await api("POST", "/api/persistent-agent-ai-profiles/gateways", { label: "Located gateway", baseUrl: "http://127.0.0.1:9/v1", key: "smoke-located-key", roomModels: [{ modelId: "located-one" }] });
			const gateway = { id: String(created.gateway.id), providerId: String(created.gateway.providerId) };
			const keyProvider = "mistral";
			await api("POST", "/api/auth/api-key", { provider: keyProvider, key: "smoke-located-key" });
			const catalog = await api("GET", `/api/persistent-agent-ai-profiles/model-catalog?provider=${keyProvider}`);
			await api("PUT", "/api/persistent-agent-ai-profiles/custom", { providerId: keyProvider, roomModels: [catalog.suggested], learnModel: catalog.suggested });
			const menuItem = async (page: Page, providerId: string, item: string) => {
				const row = page.locator(`.settings-overlay .ai-profile-row-group[data-provider-id="${providerId}"]`);
				await row.waitFor({ timeout: 10000 });
				await row.locator(".ai-profile-menu-btn").click();
				await page.locator(".ai-profile-menu-item").filter({ hasText: new RegExp(`^${item}$`) }).click();
			};
			const field = (page: Page) => page.locator(".models-run-in-field");
			const sentBody = (page: Page, pathname: string) => page.waitForRequest((request) => new URL(request.url()).pathname === pathname && request.method() === "PUT", { timeout: 10000 }).then((request) => request.postDataJSON() as Record<string, unknown>);
			for (const sharedServer of [true, false]) {
				const what = sharedServer ? "shared location field" : "desktop location field";
				// Both start at Unknown before the page reads AI setup's list, where a key's Approve models takes its location from.
				assigned.clear();
				assigned.set(gateway.providerId, "unknown");
				assigned.set(keyProvider, "unknown");
				const { context, page } = await openApp(browser, sharedServer, sharedServer ? (ctx) => asShared(ctx) : undefined, sharedServer ? { person: ADMIN, signOut: SIGN_OUT_LINK } : {});
				await openSettings(page);
				await openTab(page, "AI setup");
				const gatewayUrl = `/api/persistent-agent-ai-profiles/gateways/${gateway.id}`;
				// Edit gateway: the field with the gateway's location; a change is sent, an untouched one is not.
				await menuItem(page, gateway.providerId, "Edit gateway");
				const edit = page.locator(".gateway-config-modal");
				const saveGateway = edit.locator("button").filter({ hasText: /^Save gateway$/ });
				await until(() => saveGateway.isEnabled(), `${what}: Edit gateway never let it be saved`);
				if (sharedServer) {
					assert((await field(page).locator("h3").innerText()).trim() === RUNS_IN_HEADING && (await field(page).locator(".cli-note").innerText()).trim() === RUNS_IN_HELP, `${what}: the gateway's field reads ${JSON.stringify(await field(page).innerText())}`);
					let startsAt = "";
					await until(async () => (startsAt = await field(page).locator("select").inputValue()) === "unknown", `${what}: the gateway's field does not start at Unknown`).catch((error) => { throw new Error(`${error.message}: ${startsAt}`); });
					await field(page).locator("select").selectOption({ label: "In the EU" });
				} else {
					assert((await field(page).count()) === 0, `${what}: Edit gateway shows the location field`);
				}
				let body = sentBody(page, gatewayUrl);
				await saveGateway.click();
				assert((await body).runsIn === (sharedServer ? "eu" : undefined), `${what}: Edit gateway sent runsIn ${JSON.stringify((await body).runsIn)}`);
				await until(async () => (await edit.count()) === 0, `${what}: Edit gateway did not close after saving`);
				if (sharedServer) {
					assigned.set(gateway.providerId, "eu");
					await menuItem(page, gateway.providerId, "Edit gateway");
					await until(async () => (await field(page).locator("select").inputValue()) === "eu", `${what}: the gateway's field does not show its saved location`);
					await edit.locator('input[placeholder="Company gateway"]').fill("Located gateway again");
					body = sentBody(page, gatewayUrl);
					await saveGateway.click();
					assert(!("runsIn" in (await body)), `${what}: an untouched location was sent: ${JSON.stringify(await body)}`);
					await until(async () => (await edit.count()) === 0, `${what}: Edit gateway did not close after the second save`);
				}
				// A key's Approve models: the same field.
				await menuItem(page, keyProvider, "Approve models");
				const approve = page.locator(".configure-profile-modal");
				const saveProfile = approve.locator("button").filter({ hasText: /^Save profile$/ });
				await until(() => saveProfile.isEnabled(), `${what}: the key's Approve models never let it be saved`);
				if (sharedServer) {
					let keyShows = "";
					await until(async () => (keyShows = await field(page).locator("select").inputValue()) === "unknown", `${what}: the key's field does not show its location`).catch((error) => { throw new Error(`${error.message}: ${keyShows}`); });
					await field(page).locator("select").selectOption({ label: "Outside the EU" });
				} else {
					assert((await field(page).count()) === 0, `${what}: the key's Approve models shows the location field`);
				}
				body = sentBody(page, "/api/persistent-agent-ai-profiles/custom");
				await saveProfile.click();
				assert((await body).runsIn === (sharedServer ? "outside-eu" : undefined), `${what}: the key's save sent runsIn ${JSON.stringify((await body).runsIn)}`);
				await until(async () => (await approve.count()) === 0, `${what}: the key's Approve models did not close after saving`);
				pass(sharedServer
					? "shared: the admin's gateway form and a key's Approve models show where its models run, Unknown first, send a changed location and leave an untouched one out"
					: "this computer: neither form shows a location or sends one");
				await closeContext(context);
			}
			// The install's gateway: the field read-only with its line, and no Remove gateway… in its row's menu.
			{
				assigned.clear();
				assigned.set(gateway.providerId, "eu");
				const { context, page } = await openApp(browser, true, (ctx) => asShared(ctx, { [gateway.id]: { setByInstall: true } }), { person: ADMIN, signOut: SIGN_OUT_LINK });
				await openSettings(page);
				await openTab(page, "AI setup");
				const row = page.locator(`.settings-overlay .ai-profile-row-group[data-provider-id="${gateway.providerId}"]`);
				await row.waitFor({ timeout: 10000 });
				await row.locator(".ai-profile-menu-btn").click();
				await page.locator(".ai-profile-menu-item").first().waitFor({ timeout: 10000 });
				const items = (await page.locator(".ai-profile-menu-item").allInnerTexts()).map((text) => text.trim());
				assert(items.includes("Edit gateway") && !items.includes("Remove gateway…"), `shared install gateway: its row's menu offers ${items.join("|")}`);
				await page.locator(".ai-profile-menu-item").filter({ hasText: /^Edit gateway$/ }).click();
				await until(async () => (await field(page).locator("select").inputValue()) === "eu", "shared install gateway: the field does not show the install's location");
				assert(await field(page).locator("select").isDisabled(), "shared install gateway: the location can be changed");
				assert((await field(page).locator(".cli-note").innerText()).trim() === RUNS_IN_SET_BY_INSTALL, `shared install gateway: the field's line reads ${JSON.stringify(await field(page).locator(".cli-note").innerText())}`);
				pass("shared: the install's gateway shows its location read-only with the install's line, and its row offers no Remove gateway… (the other rows' Remove is in shared removals)");
				await closeContext(context);
			}
			const removed = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/gateways/${encodeURIComponent(gateway.id)}`, { method: "DELETE" });
			assert(removed.ok, `shared location field: removing the gateway afterwards: ${removed.status}`);
			const removedProfile = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom/custom-${keyProvider}`, { method: "DELETE" });
			assert(removedProfile.ok, `shared location field: removing the key's profile afterwards: ${removedProfile.status}`);
		}

		// --- sharedServer: true, a member ---
		await api("POST", "/api/skills", { id: "member-sees", displayName: MEMBER_SEES_SKILL, description: "A skill a member opens.", instructions: "Answer briefly." });
		{
			const { context, page, asked } = await openApp(browser, true, undefined, { person: MEMBER, signOut: SIGN_OUT_LINK });
			const footer = page.locator(".product-sidebar-footer .signed-in-as");
			assert((await footer.innerText()).replace(/\s+/g, " ").trim() === `Signed in as <i>Sample</i> Member ${SIGN_OUT_ROW}`, `shared Home: the footer does not read as the member signed in with Sign out and its scope line, got ${JSON.stringify(await footer.innerText())}`);
			assert((await footer.locator("i, b, script").count()) === 0, "shared Home: the name was read as markup");
			assert((await footer.locator(".signed-in-as-tag").count()) === 0, "shared Home: a member carries the Admin tag");

			assert(JSON.stringify(await cardOrder(page)) === JSON.stringify(A_TO_Z), `shared Home: rooms not A to Z: ${await cardOrder(page)}`);
			assert((await page.locator(".room-sort").count()) === 0, "shared Home: the sort control is on the page");
			assert((await page.getByText(ORDER_NOT_LOADED).count()) === 0, "shared Home: the order-not-loaded sentence is on the page");
			assert((await page.locator(".product-nav button").filter({ hasText: "Wallet" }).count()) === 0, "shared Home: the Wallet button is on the page");
			assert((await page.locator(".remote-on-pill").count()) === 0, "shared Home: the remote pill is on the page");
			pass("shared: Home lists the rooms A to Z with no sort control, no order sentence, no Wallet and no remote pill, and the footer says who is signed in, as text, with Sign out and its scope line");

			await openSettings(page);
			assert((await tabCount(page, "Remote access")) === 0, "shared Settings: Remote access is offered");
			assert((await tabCount(page, "Profiles")) === 0, "shared Settings: Profiles is offered");

			await openTab(page, "AI setup");
			assert((await countText(page, ".settings-overlay .ai-defaults-group", SHARED_LINE)) === 1, "shared AI setup: the default models have no shared-server line");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 2, "shared AI setup: expected the line under the default models and under the providers");
			assert((await countText(page, ".settings-overlay", ADMIN_HINT)) === 2, "shared AI setup: a member does not get the new admin's hint beside both lines");
			for (const selector of [".add-provider-toggle", ".ai-profile-signin", ".ai-profile-menu-btn", ".ai-defaults-group .room-model-pick:not(:disabled)"]) {
				assert((await page.locator(`.settings-overlay ${selector}`).count()) === 0, `shared AI setup: ${selector} is operable`);
			}
			assert((await page.locator(".settings-overlay .ai-defaults-group .room-model-pick").count()) === 2, "shared AI setup: the two default models are not shown");

			await openTab(page, "Web search");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "shared Web search: no shared-server line");
			for (const selector of ['input[type="checkbox"]', 'input[type="radio"]', "select"]) {
				assert((await page.locator(`.settings-overlay ${selector}`).count()) === 0, `shared Web search: ${selector} is operable`);
			}

			await openTab(page, "Instructions");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "shared Instructions: no shared-server line");
			assert((await countText(page, ".settings-overlay", ADMIN_HINT)) === 0, "shared Instructions: a member gets the new admin's hint");
			assert((await countText(page, ".settings-overlay", DESKTOP_INSTRUCTIONS_HEAD)) === 1, "shared Instructions: a member's head line is not this computer's");
			// Under the box, one row: the line from its left edge and the counter at its right end.
			const lineBox = await page.locator(".settings-overlay").getByText(SHARED_LINE, { exact: false }).boundingBox();
			const countBox = await page.locator(".settings-overlay #global-instructions-count").boundingBox();
			const textBox = await page.locator(".settings-overlay .room-instructions-textarea").boundingBox();
			assert(countBox && lineBox && textBox
				&& Math.abs(lineBox.y - (textBox.y + textBox.height) - 12) < 1 && Math.abs(countBox.x + countBox.width - (textBox.x + textBox.width)) < 3
				&& Math.abs(countBox.y + countBox.height / 2 - (lineBox.y + lineBox.height / 2)) <= 1 && lineBox.x + lineBox.width <= countBox.x && Math.abs(lineBox.x - textBox.x) < 3,
				`shared Instructions: the line and the counter are not one row under the box, at its two ends: box ${JSON.stringify(textBox)}, counter ${JSON.stringify(countBox)}, line ${JSON.stringify(lineBox)}`);
			assert((await page.locator(".settings-overlay .room-instructions-textarea[readonly]").count()) === 1, "shared Instructions: the text can be edited");
			assert((await page.locator(".settings-overlay .room-instructions-section button").filter({ hasText: /^Save$/ }).count()) === 0, "shared Instructions: Save is offered");

			await openTab(page, "Connectors");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "shared Connectors: no shared-server line");
			for (const selector of [".connector-dir-search", ".connector-dir-row button", ".connector-item-slot button", "button.connector-item-more", ".pane-head-actions button"]) {
				assert((await page.locator(`.settings-overlay ${selector}`).count()) === 0, `shared Connectors: ${selector} is on the page`);
			}

			await openTab(page, "Skills");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "shared Skills: no shared-server line");
			assert((await countText(page, ".settings-overlay", ADMIN_HINT)) === 0, "shared Skills: a member gets the new admin's hint");
			await page.locator(".settings-overlay .skill-row").filter({ hasText: MEMBER_SEES_SKILL }).waitFor({ timeout: 10000 });
			assert((await countText(page, ".settings-overlay", SKILL_FILES_NOTE)) === 0, "shared Skills: a member's library says a skill's files run");
			assert((await page.locator(".settings-overlay .pane-head-actions button").count()) === 0, "shared Skills: Add skill is offered");
			assert((await page.locator(".settings-overlay .skill-row").filter({ hasText: MEMBER_SEES_SKILL }).locator(".skill-table-cell:not(.skill-table-from)").count()) === 1, "shared Skills: a member's library doesn't say how many rooms use a skill");
			await page.locator(".settings-overlay .skill-row").filter({ hasText: MEMBER_SEES_SKILL }).click();
			await page.locator(".settings-overlay .skill-detail").waitFor({ timeout: 10000 });
			assert((await page.locator(".settings-overlay .skill-detail button").filter({ hasText: /^Delete$/ }).count()) === 0, "shared Skills: a skill's page offers Delete to a member");
			assert((await countText(page, ".settings-overlay .skill-detail", "Used in")) === 1, "shared Skills: a member's skill page has no Used in");
			await closeSettings(page);
			pass("shared: Settings has no Remote access or Profiles; AI setup, its default models, web search, instructions, connectors and skills are read-only with the line");
			assert(asked.length === 0, `shared start, Home and Settings: the page asked for what a shared server refuses: ${asked.join(", ")}`);
			pass("shared start, Home and Settings: the page never asked for a refused route (the clean-up read at start included)");

			await enterRoom(page, "Bash Room");
			const railFooter = page.locator(".sidebar-footer .signed-in-as");
			assert((await railFooter.innerText()).replace(/\s+/g, " ").trim() === `Signed in as <i>Sample</i> Member ${SIGN_OUT_ROW}`, `shared room: the rail's footer does not say who is signed in with Sign out and its scope line, got ${JSON.stringify(await railFooter.innerText())}`);
			assert((await page.locator(".bash-mode-chip").count()) === 0, "shared room: the Bash chip is on the page");
			await openRoomWorkspace(page);
			const sharedPane = page.locator(".room-workspace-section");
			assert((await sharedPane.locator("button").count()) === 0, "shared room with a folder: the Folder pane offers a button");
			for (const input of await sharedPane.locator("input").all()) assert(await input.isDisabled(), "shared room with a folder: a Folder pane switch can be changed");
			await closeSettings(page);

			await enterRoom(page, "Alpha Room");
			await openRoomWorkspace(page);
			assert((await page.locator(".room-workspace-section button").filter({ hasText: "Choose folder" }).count()) === 0, "shared room without a folder: Choose folder is offered");
			assert((await countText(page, ".room-workspace-section", NO_FOLDER_LINE)) === 1, "shared room without a folder: no shared-server line");
			await closeSettings(page);
			await openShelfFile(page);
			assert((await page.locator(".artifact-viewer-quiet").filter({ hasText: /^\s*Save\s*$/ }).count()) === 0, "shared room: Save is offered for a shelf file");
			pass("shared: rooms offer no Bash chip, no folder control, no Choose folder and no Save");

			assert(asked.length === 0, `shared rooms and room settings: the page asked for what a shared server refuses: ${asked.join(", ")}`);
			pass("shared rooms and room settings: the page never asked for a refused route");
			await closeContext(context);
		}

		// --- sharedServer: true, the organisation's admin ---
		{
			const { context, page, asked, probe } = await openApp(browser, true, undefined, { person: ADMIN, signOut: SIGN_OUT_LINK });
			const footer = page.locator(".product-sidebar-footer .signed-in-as");
			assert((await footer.locator(".signed-in-as-tag").innerText()) === "Admin", "admin Home: the Admin tag is missing");
			await openSettings(page);
			await openTab(page, "AI setup");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 0 && (await countText(page, ".settings-overlay", ADMIN_HINT)) === 0, "admin AI setup: the read-only line is shown");
			assert((await page.locator(".settings-overlay .add-provider-toggle").count()) === 1, "admin AI setup: Add provider is missing");
			assert((await page.locator(".settings-overlay .ai-defaults-group .room-model-pick:not(:disabled)").count()) === 2, "admin AI setup: the default models cannot be changed");
			// A write the admin may make goes through.
			const saved = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/ai/defaults" && res.request().method() === "PUT", { timeout: 10000 });
			await page.locator(".settings-overlay .ai-defaults-group .room-model-pick").first().click();
			await page.locator('.room-model-menu [role="option"][aria-selected="false"]:not(.unpickable)').first().click();
			assert((await saved).status() === 200, "admin AI setup: the default model was refused");
			// Provider sign-in and sign-out are not offered, in a row's menu or in the list to add from.
			await page.locator(".settings-overlay .ai-profile-menu-btn").first().click();
			const menuItems = (await page.locator(".ai-profile-menu [role=menuitem], [role=menuitem].ai-profile-menu-item").allInnerTexts()).map((text) => text.trim());
			assert(menuItems.length > 0, "admin AI setup: a provider's menu has no items");
			assert(!menuItems.some((text) => /^Sign (in again|out)$/.test(text)), `admin AI setup: a provider's menu offers sign-in or sign-out: ${menuItems.join("|")}`);
			await page.keyboard.press("Escape");
			await page.locator(".settings-overlay .add-provider-toggle").click();
			await page.locator(".add-provider-block").getByRole("button", { name: "Add key" }).first().waitFor({ timeout: 10000 });
			const adding = await page.locator(".add-provider-block").innerText();
			assert(!/Subscription|Sign in|Remove key|Keys stay on this device/.test(adding), `admin AI setup: the list to add from offers a sign-in, a key removal or a device line: ${adding}`);
			assert(/Add gateway/.test(adding) && /Add key/.test(adding), "admin AI setup: a gateway and a key can't be added");
			// A read that takes the admin's role away closes what is open (a row's key form too) and locks the setup.
			const addKey = page.locator(".settings-overlay .ai-profile-signin").filter({ hasText: "Add API key" });
			assert((await addKey.count()) >= 1, `admin AI setup: no row offers Add API key: ${(await page.locator(".settings-overlay .ai-profile-signin").allInnerTexts()).join("|")}`);
			await addKey.first().click();
			await page.locator(".settings-overlay .ai-profile-key-form").waitFor({ timeout: 10000 });
			// A default-model menu left open must close too: it is portaled, and would still take a pick.
			await page.locator(".settings-overlay .ai-defaults-group .room-model-pick").first().click();
			await page.locator(".room-model-menu").waitFor({ timeout: 10000 });
			probe.person = { ...ADMIN, admin: false };
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await until(async () => (await countText(page, ".settings-overlay", ADMIN_HINT)) === 2, "admin AI setup: the setup stayed open after the admin's role was taken away");
			await until(async () => (await page.locator(".room-model-menu").count()) === 0, "admin AI setup: a default-model menu stayed open after the admin's role was taken away");
			assert((await page.locator(".settings-overlay .ai-profile-key-form, .settings-overlay .add-provider-key-form").count()) === 0, "admin AI setup: a key form stayed open after the admin's role was taken away");
			assert((await page.locator(".settings-overlay .add-provider-toggle").count()) === 0, "admin AI setup: Add provider stayed after the admin's role was taken away");
			await closeSettings(page);
			assert(asked.length === 0, `admin: the page asked for what a shared server refuses even for its admin: ${asked.join(", ")}`);
			pass("shared admin: Admin tag, the AI setup open (a default model saved), no sign-in or sign-out or key removal anywhere, and the page asked for nothing refused");
			await closeContext(context);
		}

		// --- sharedServer: true, the organisation's admin sets up skills and the instructions ---
		{
			const { context, page, asked, probe } = await openApp(browser, true, undefined, { person: ADMIN, signOut: SIGN_OUT_LINK });
			const overlay = page.locator(".settings-overlay");
			const skillNames = async () => ((await api("GET", "/api/skills")) as Array<{ name: string }>).map((skill) => skill.name);
			const addSkill = overlay.locator(".pane-head-actions button").filter({ hasText: /^Add skill$/ });
			const menuItem = (name: string) => page.locator(".skill-add-menu [role=menuitem]").filter({ hasText: new RegExp(`^${name}$`) });
			// The admin's library starts empty.
			await api("DELETE", "/api/skills/member-sees", {});
			await openSettings(page);
			await openTab(page, "Skills");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 0 && (await countText(page, ".settings-overlay", ADMIN_HINT)) === 0, "admin Skills: the read-only line is shown");
			await until(async () => (await countText(page, ".settings-overlay", "No skills yet. Use Add skill to write or upload one.")) === 1, "admin Skills: the empty library does not say to write or upload one");
			assert((await countText(page, ".settings-overlay", BROWSE_FEATURED_LINK)) === 0, "admin Skills: Browse featured is offered on the empty page, which the server refuses");
			await addSkill.click();
			assert((await menuItem(ADD_SKILL_WAYS.write).count()) === 1 && (await menuItem(ADD_SKILL_WAYS.upload).count()) === 1, "admin Skills: writing or uploading a skill is missing");
			assert((await menuItem(ADD_SKILL_WAYS.repository).count()) === 0, "admin Skills: adding from a repository is offered, which the server refuses");
			assert((await menuItem(ADD_SKILL_WAYS.featured).count()) === 0, "admin Skills: Browse featured is offered, which the server refuses");

			// Write one.
			await menuItem(ADD_SKILL_WAYS.write).click();
			const form = overlay.locator(".skill-write-block");
			await form.locator("input").nth(0).fill("Admin Written");
			await form.locator("input").nth(1).fill("Written by the admin.");
			await form.locator("textarea").fill("Answer in full sentences.");
			const written = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/skills" && res.request().method() === "POST", { timeout: 10000 });
			await form.getByRole("button", { name: "Save skill" }).click();
			assert((await written).status() === 201, "admin Skills: writing a skill was refused");
			await overlay.locator(".skill-row").filter({ hasText: "Admin Written" }).waitFor({ timeout: 10000 });
			assert((await skillNames()).includes("admin-written"), "admin Skills: the written skill is not on the server");
			assert((await countText(page, ".settings-overlay", "Added “Admin Written” to your company's library.")) === 1, "admin Skills: no company's library notice after writing a skill");
			assert((await countText(page, ".settings-overlay", SKILL_FILES_NOTE)) === 0, "admin Skills: the library says a skill's files run");
			// The rooms a skill is used in would be the admin's own only, so the admin's library counts none.
			assert((await overlay.locator(".skill-row").filter({ hasText: "Admin Written" }).locator(".skill-table-cell:not(.skill-table-from)").count()) === 0, "admin Skills: the library says how many rooms use a skill");
			assert(!/used in/i.test((await overlay.locator(".skill-row").filter({ hasText: "Admin Written" }).getAttribute("aria-label")) ?? ""), "admin Skills: a library row names its rooms");

			// Upload one with a script beside it, review it, add it. Its rooms run no skill's files, and the review says so.
			await addSkill.click();
			await menuItem(ADD_SKILL_WAYS.upload).click();
			const uploaded = new JSZip();
			uploaded.file("admin-uploaded/SKILL.md", "---\nname: admin-uploaded\ndescription: Uploaded by the admin.\n---\nCheck the dates twice.\n");
			uploaded.file("admin-uploaded/scripts/check.sh", "echo checked\n");
			await page.locator(".skill-upload-input").setInputFiles({ name: "admin-uploaded.zip", mimeType: "application/zip", buffer: await uploaded.generateAsync({ type: "nodebuffer" }) });
			// The review's one message about its scripts: how many, then where they run.
			const scriptsLine = overlay.locator(".skill-review-scripts-text");
			await scriptsLine.waitFor({ timeout: 10000 });
			assert(JSON.stringify(await scriptsLine.allTextContents()) === JSON.stringify([`${skillScriptsCount(1)} ${SKILL_FILES_LINES.sharedServer.one}`]), `admin Skills: the review of a skill with a script does not say it never runs here, got ${JSON.stringify(await scriptsLine.allTextContents())}`);
			const accepted = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/skills/accept", { timeout: 10000 });
			await overlay.getByRole("button", { name: ADD_TO_LIBRARY }).click();
			assert((await accepted).status() === 201, "admin Skills: adding an uploaded skill was refused");
			await overlay.locator(".skill-row").filter({ hasText: "admin-uploaded" }).waitFor({ timeout: 10000 });
			assert((await skillNames()).includes("admin-uploaded"), "admin Skills: the uploaded skill is not on the server");
			assert((await countText(page, ".settings-overlay", "Added “admin-uploaded” to your company's library.")) === 1, "admin Skills: no company's library notice after uploading a skill");

			// Remove the written one from its page.
			await overlay.locator(".skill-row").filter({ hasText: "Admin Written" }).click();
			await overlay.locator(".skill-detail").waitFor({ timeout: 10000 });
			assert((await countText(page, ".settings-overlay .skill-detail", "Used in")) === 0, "admin Skills: a skill's page has Used in");
			assert((await countText(page, ".settings-overlay .skill-detail", "Delete skill")) === 1, "admin Skills: the delete row is not Delete skill");
			assert((await countText(page, ".settings-overlay .skill-detail", "Removes it from your company's library. Rooms that use it stop using it.")) === 1, "admin Skills: the delete row does not say it leaves the company's library");
			await overlay.locator(".skill-detail button").filter({ hasText: /^Delete$/ }).click();
			const question = page.locator(".confirm-dialog-backdrop");
			assert((await question.locator("h2").innerText()).trim() === "Remove “Admin Written” for everyone?", "admin Skills: the delete question does not ask to remove it for everyone");
			assert((await question.locator("p").innerText()).trim() === "Every room in your company that uses it stops using it.", "admin Skills: the delete question does not say every room in the company stops using it");
			const removed = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/skills/admin-written" && res.request().method() === "DELETE", { timeout: 10000 });
			assert((await question.locator("button").filter({ hasText: /^Delete$/ }).count()) === 0, "admin Skills: the delete question's button reads Delete");
			await question.locator("button").filter({ hasText: /^Remove$/ }).click();
			assert((await removed).status() === 200, "admin Skills: removing a skill was refused");
			await overlay.locator(".skill-row").filter({ hasText: "Admin Written" }).waitFor({ state: "detached", timeout: 10000 });
			assert(!(await skillNames()).includes("admin-written"), "admin Skills: the removed skill is still on the server");
			assert((await countText(page, ".settings-overlay", "Removed “Admin Written” from your company's library.")) === 1, "admin Skills: no company's library notice after removing a skill");
			pass("shared admin Skills: write, upload and remove from the page, each read back from the server, with the company's library's words, no Used in, no Browse featured and no adding from a repository");

			// The organisation's instructions.
			await openTab(page, "Instructions");
			const box = overlay.locator(".room-instructions-textarea");
			assert((await overlay.locator(".room-instructions-textarea[readonly]").count()) === 0, "admin Instructions: the text is read-only");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 0 && (await countText(page, ".settings-overlay", ADMIN_HINT)) === 0, "admin Instructions: the read-only line is shown");
			assert((await countText(page, ".settings-overlay", COMPANY_INSTRUCTIONS_HEAD)) === 1, "admin Instructions: the head line does not name the company");
			await box.fill("Answer in plain words.");
			const instructionsSaved = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/settings/instructions" && res.request().method() === "PUT", { timeout: 10000 });
			await overlay.locator(".room-instructions-section button").filter({ hasText: /^Save$/ }).click();
			assert((await instructionsSaved).status() === 200, "admin Instructions: saving was refused");
			assert((await api("GET", "/api/settings/instructions")).instructions.text === "Answer in plain words.", "admin Instructions: the text is not on the server");
			pass("shared admin Instructions: changed from the page and read back from the server");

			// A read that takes the role away: the draft goes back to what is saved, the box locks, and Write skill closes.
			await box.fill("A draft the member cannot save.");
			probe.person = { ...ADMIN, admin: false };
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await until(async () => (await overlay.locator(".room-instructions-textarea[readonly]").count()) === 1, "admin Instructions: the box stayed open after the admin's role was taken away");
			assert((await box.inputValue()) === "Answer in plain words.", "admin Instructions: the draft stayed after the admin's role was taken away");
			// Once text is saved, the line carries when it was saved after it.
			const footLine = (await overlay.locator(".room-instructions-foot .cli-note").first().innerText()).trim();
			assert(footLine.startsWith(SHARED_LINE) && (await countText(page, ".settings-overlay", ADMIN_HINT)) === 0, `admin Instructions: no read-only line after the admin's role was taken away, got ${JSON.stringify(footLine)}`);
			probe.person = ADMIN;
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await openTab(page, "Skills");
			await addSkill.click();
			await menuItem(ADD_SKILL_WAYS.write).click();
			await overlay.locator(".skill-write-block").waitFor({ timeout: 10000 });
			probe.person = { ...ADMIN, admin: false };
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await until(async () => (await overlay.locator(".skill-write-block").count()) === 0, "admin Skills: Write skill stayed open after the admin's role was taken away");
			assert((await overlay.locator(".pane-head-actions button").count()) === 0, "admin Skills: Add skill stayed after the admin's role was taken away");
			await closeSettings(page);
			assert(asked.length === 0, `admin Skills and Instructions: the page asked for what a shared server refuses even for its admin: ${asked.join(", ")}`);
			pass("shared admin: a read that takes the role away locks the instructions with the saved text and closes Write skill, and the page asked for nothing refused");
			await closeContext(context);
		}

		// --- sharedServer: true, no sign-out link and no name; then the person changing ---
		{
			const bare = await openApp(browser, true, undefined, { person: { ...MEMBER, name: "" } });
			assert((await bare.page.locator(".product-sidebar-footer .signed-in-as").count()) === 0, "shared without a name or link: the footer shows something");
			await closeContext(bare.context);
			const noLink = await openApp(browser, true, undefined, { person: MEMBER });
			assert((await noLink.page.locator(".product-sidebar-footer .signed-in-as").innerText()).includes("Signed in as"), "shared without a link: the name is missing");
			assert((await noLink.page.locator(".product-sidebar-footer .signed-in-as").innerText()).replace(/\s+/g, " ").trim() === "Signed in as <i>Sample</i> Member", "shared without a link: the footer says more than who is signed in (a Sign out or its scope line)");
			assert((await noLink.page.locator(".product-sidebar-footer .signed-in-as :is(a, button)").count()) === 0, "shared without a link: a Sign out item is offered");
			await closeContext(noLink.context);
			pass("shared: no Sign out item or scope line without the server's link, and nothing at all without a name or a link");

			const opened = await openApp(browser, true, undefined, { person: MEMBER, signOut: SIGN_OUT_LINK });
			const { context, page, probe, reads } = opened;
			const footer = page.locator(".product-sidebar-footer .signed-in-as");
			const focusPage = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
			const showPage = (persisted: boolean) => page.evaluate((flag) => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: flag })), persisted);
			// A read that fails never turns a shared server into the desktop.
			probe.fail = true;
			let before = reads();
			await focusPage();
			await until(() => reads() > before, "shared: focus did not read the person again");
			await settled(opened);
			assert((await footer.count()) === 1 && (await page.locator(".product-nav button").filter({ hasText: "Wallet" }).count()) === 0, "shared: a failed read turned the page into the desktop");
			probe.fail = false;
			// A page shown again from the back-forward cache reads; an ordinary show does not.
			before = reads();
			await showPage(false);
			await settled(opened);
			assert(reads() === before, `shared: a pageshow that was not from the cache read the person (${reads() - before} reads)`);
			await showPage(true);
			await until(() => reads() > before, "shared: a pageshow from the cache did not read the person");
			// Its read has to be over before the next row starts one: a focus meanwhile would only wait behind it.
			await settled(opened);
			// A read that stalls ends at the page's own deadline and does not hold later ones behind it;
			// then another person on a read reloads the page.
			probe.stall = true;
			before = reads();
			await focusPage();
			await until(() => reads() > before, "shared: a focus did not start a read");
			probe.stall = false;
			probe.person = OTHER;
			let reloaded = false;
			page.once("load", () => { reloaded = true; });
			await until(async () => {
				if (!reloaded) await focusPage().catch(() => {});
				return reloaded;
			}, "shared: a stalled read held every later read, so the page never saw the other person", 40000);
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
			assert((await footer.innerText()).includes("Sample Other"), "shared: the page reloaded but does not show the other person");
			pass("shared: focus and a pageshow from the cache read the person again, a failed read keeps the shared view, a stalled read ends at its deadline, and another person reloads the page");
			await closeContext(context);

			const local = await openApp(browser, false);
			before = local.reads();
			await local.page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await settled(local);
			assert(local.reads() === before, "this computer: focus read the person again");
			assert((await local.page.locator(".signed-in-as").count()) === 0, "this computer: the footer says who is signed in");
			assert((await local.page.locator(".product-sidebar-footer").getByText(/This signs you out|Sign out/).count()) === 0, "this computer: a Sign out or its scope line shows");
			pass("this computer: nothing reads the person again and the footer says nothing");
			await closeContext(local.context);
		}

		// --- Sign out: the server's sign-out first, its link only on a confirmed answer, and the two choices when it fails ---
		{
			const open = async () => {
				const signOut: SignOutRoute = { mode: "answer", posts: 0, release: () => {}, followed: [] };
				const opened = await openApp(browser, true, (context) => routeSignOut(context, signOut), { person: MEMBER, signOut: SIGN_OUT_LINK });
				const footer = opened.page.locator(".product-sidebar-footer .signed-in-as");
				const row = async () => (await footer.innerText()).replace(/\s+/g, " ").replace(/^Signed in as <i>Sample<\/i> Member /, "").trim();
				return { ...opened, signOut, footer, row };
			};
			const followedLink = (signOut: SignOutRoute) => signOut.followed.length === 1 && signOut.followed[0] === SIGN_OUT_LINK;

			// Answered: nothing is followed while the answer is out, a second press sends nothing, then the link is followed.
			{
				const opened = await open();
				const { page, signOut, footer, row } = opened;
				signOut.mode = "hold";
				const look = () => footer.getByRole("button", { name: "Sign out", exact: true }).evaluate((button) => { const style = getComputedStyle(button); return `${style.textDecorationLine} ${style.opacity}`; });
				const resting = await look();
				// Two presses in one go: the first disables the button before the second can send.
				await footer.getByRole("button", { name: "Sign out", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
				await until(() => signOut.posts > 0, "S1 answered: Sign out sent no request");
				await settled({ page, pending: () => opened.pending() - 1 });
				assert(signOut.posts === 1, `S1 answered: a second press while the request was out sent it again (${signOut.posts} requests)`);
				assert(signOut.followed.length === 0, "S1 answered: the sign-out link was followed before the server's answer");
				assert(await footer.getByRole("button", { name: "Sign out", exact: true }).isDisabled(), "S1 answered: Sign out can be pressed again while the request is out");
				assert((await row()) === SIGN_OUT_ROW, `S1 answered: the scope line left while the request is out, got ${JSON.stringify(await row())}`);
				const pending = await look();
				assert(pending !== resting, `S1 answered: Sign out looks the same while its request is out as before the press (${resting}), so nothing shows the press took`);
				signOut.release();
				await until(() => followedLink(signOut), `S1 answered: the confirmed answer did not follow the server's link (${JSON.stringify(signOut.followed)})`);
				assert(signOut.posts === 1, `S1 answered: more than one request was sent (${signOut.posts})`);
				pass("Sign out: shows its scope line, sends the server's sign-out once however often it is pressed, follows nothing while the answer is out, and follows the server's link on the confirmed answer");
				await closeContext(opened.context);
			}

			// Refused, then Try again answered: nothing followed on the refusal, the link followed on the second answer.
			{
				const opened = await open();
				const { page, signOut, footer, row } = opened;
				signOut.mode = "refuse";
				await footer.getByRole("button", { name: "Sign out", exact: true }).click();
				await until(async () => (await row()) === SIGN_OUT_FAILED_ROW, `S2 refused: the failure line and its two choices did not show, got ${JSON.stringify(await row())}`);
				await settled(opened);
				assert(signOut.followed.length === 0, "S2 refused: a refused sign-out followed the link");
				assert((await page.evaluate(() => document.activeElement?.textContent)) === "Try again", "S2 refused: focus did not come to Try again");
				signOut.mode = "answer";
				await footer.getByRole("button", { name: "Try again", exact: true }).click();
				await until(() => followedLink(signOut), `S2 refused: Try again's confirmed answer did not follow the server's link (${JSON.stringify(signOut.followed)})`);
				assert(signOut.posts === 2, `S2 refused: Try again did not send the request again (${signOut.posts} requests)`);
				pass("Sign out refused: the failure line with Try again and Sign out of this browser only, nothing followed; Try again sends again and follows the link on its confirmed answer");
				await closeContext(opened.context);
			}

			// Failed on the network, then this browser only: the link is followed with no further request.
			{
				const opened = await open();
				const { signOut, footer, row } = opened;
				signOut.mode = "network";
				await footer.getByRole("button", { name: "Sign out", exact: true }).click();
				await until(async () => (await row()) === SIGN_OUT_FAILED_ROW, `S3 network: the failure line and its two choices did not show, got ${JSON.stringify(await row())}`);
				await settled(opened);
				assert(signOut.followed.length === 0, "S3 network: a sign-out with no answer followed the link");
				await footer.getByRole("button", { name: "Sign out of this browser only", exact: true }).click();
				await until(() => followedLink(signOut), `S3 network: Sign out of this browser only did not follow the server's link (${JSON.stringify(signOut.followed)})`);
				assert(signOut.posts === 1, `S3 network: Sign out of this browser only sent the server's sign-out (${signOut.posts} requests)`);
				pass("Sign out failed on the network: the failure line, nothing followed; Sign out of this browser only follows the link with no request");
				await closeContext(opened.context);
			}

			// Stalled: still waiting before the page's deadline, the failure line after it, nothing followed.
			{
				const opened = await open();
				const { signOut, footer, row } = opened;
				signOut.mode = "stall";
				const pressed = Date.now();
				await footer.getByRole("button", { name: "Sign out", exact: true }).click();
				await until(() => signOut.posts > 0, "S4 stalled: Sign out sent no request");
				await new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS / 2));
				assert((await row()) === SIGN_OUT_ROW && (await footer.getByRole("button", { name: "Sign out", exact: true }).isDisabled()), `S4 stalled: before the deadline the page gave up waiting, got ${JSON.stringify(await row())}`);
				await until(async () => (await row()) === SIGN_OUT_FAILED_ROW, "S4 stalled: no failure line came after the page's deadline", SIGN_OUT_WAIT_MS + 10_000);
				const waited = Date.now() - pressed;
				assert(waited >= SIGN_OUT_WAIT_MS - 500, `S4 stalled: the failure line came before the deadline (${waited} ms)`);
				await settled(opened);
				assert(signOut.followed.length === 0, "S4 stalled: a stalled sign-out followed the link");
				pass(`Sign out stalled: the failure line comes at the page's deadline (${Math.round(waited / 100) / 10} s), nothing followed`);
				await closeContext(opened.context);
			}

			// Lost after the record: the server wrote it and closed this page's live connection, so the page's sign-in
			// check and its client-context reads answer 401 session_signed_out, but the sign-out's own answer never comes.
			// The page goes nowhere by itself, however long the failure line waits for the person, and moving to Memory
			// while the answer is out keeps where the sign-out stands: then Try again, which the edge refuses as signed out,
			// follows the link.
			{
				const signOut: SignOutRoute = { mode: "answer", posts: 0, release: () => {}, followed: [] };
				const live: WebSocketRoute[] = [];
				let recorded = false;
				signOut.recorded = () => {
					recorded = true;
					for (const ws of live.splice(0)) void ws.close({ code: 4401, reason: SESSION_SIGNED_OUT.code });
				};
				let checked = 0;
				// The 401s answered once the person has been looking at the failure line for a while.
				let lateRefusals = 0;
				let lateFrom = Infinity;
				const opened = await openApp(browser, true, async (context) => {
					await routeSignOut(context, signOut);
					// Registered after openApp's own answer, so it comes first once the record is written.
					await context.route("**/api/remote/client-context", (route) => {
						if (!recorded) return route.fallback();
						if (Date.now() >= lateFrom) lateRefusals += 1;
						return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(SESSION_SIGNED_OUT) });
					});
					await context.routeWebSocket(/\/ws(\?|$)/, (ws) => {
						if (recorded) return void ws.close({ code: 4401, reason: SESSION_SIGNED_OUT.code });
						ws.connectToServer();
						live.push(ws);
					});
					await context.route("**/api/auth/status", (route) => {
						if (!recorded) return route.continue();
						checked += 1;
						if (Date.now() >= lateFrom) lateRefusals += 1;
						return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(SESSION_SIGNED_OUT) });
					});
				}, { person: MEMBER, signOut: SIGN_OUT_LINK });
				const { page } = opened;
				const footer = page.locator(".product-sidebar-footer .signed-in-as");
				const row = async () => (await footer.innerText().catch(() => "")).replace(/\s+/g, " ").replace(/^Signed in as <i>Sample<\/i> Member /, "").trim();
				await until(() => live.length > 0, "S5 lost: the page's live connection never opened");
				let left: string | null = null;
				page.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) left ??= new URL(request.url()).pathname; });
				signOut.mode = "lost";
				const pressed = Date.now();
				// Past the page's 15 s between two sign-in redirects (api.ts): a hold that ran out there would show here.
				lateFrom = pressed + 16_000;
				await footer.getByRole("button", { name: "Sign out", exact: true }).click();
				await until(() => checked > 0 || left !== null, "S5 lost: the page never asked whether it is still signed in after its live connection closed", 30_000);
				// Another screen's footer, mounted while the answer is out.
				await page.locator(".product-nav button").filter({ hasText: "Memory" }).click();
				await page.locator(".product-nav button.active").filter({ hasText: "Memory" }).waitFor({ timeout: 10_000 });
				assert(Date.now() - pressed < SIGN_OUT_WAIT_MS, "S5 lost: Memory opened only after the page's deadline, so the row proves nothing about a footer mounted while the answer is out");
				assert((await row()) === SIGN_OUT_ROW && (await footer.getByRole("button", { name: "Sign out", exact: true }).isDisabled()), `S5 lost: Memory's footer offers Sign out again while the answer is out, got ${JSON.stringify(await row())}`);
				await until(async () => left !== null || (await row()) === SIGN_OUT_FAILED_ROW, `S5 lost: Memory's footer showed no failure line after the page's deadline, got ${JSON.stringify(await row())}`, SIGN_OUT_WAIT_MS + 10_000);
				assert(left === null, `S5 lost: the page left for ${left} by itself while the sign-out's answer was out, before the person chose`);
				// The person reads the failure line for a while; Home keeps asking meanwhile, and every answer is 401.
				await until(() => left !== null || (Date.now() >= pressed + 30_000 && lateRefusals > 0), `S5 lost: past 16 s after the press, ${lateRefusals} 401 answer(s) came, so the row proves nothing`, 60_000);
				assert(left === null, `S5 lost: the page left for ${left} by itself ${Math.round((Date.now() - pressed) / 1000)} s after the press, while the failure line waited for the person`);
				assert((await row()) === SIGN_OUT_FAILED_ROW, `S5 lost: the failure line left before the person chose, got ${JSON.stringify(await row())}`);
				assert(signOut.followed.length === 0, "S5 lost: a sign-out whose answer never came followed the link");
				assert(checked > 0 && (await page.getByText(SIGNED_OUT_LINE, { exact: true }).count()) === 0, `S5 lost: the signed-out banner shows beside the failure line (sign-in checks answered 401: ${checked}), so the page says both signed out and maybe still signed in`);
				signOut.mode = "signed-out";
				await footer.getByRole("button", { name: "Try again", exact: true }).click();
				await until(() => followedLink(signOut), `S5 lost: Try again, refused as signed out, did not follow the server's link (${JSON.stringify(signOut.followed)})`);
				assert(signOut.posts === 2, `S5 lost: Try again did not send the request again (${signOut.posts} requests)`);
				pass(`Sign out whose answer is lost after the record: the 401s that follow (${lateRefusals} past 16 s) send the page nowhere, Memory opened meanwhile keeps the sign-out where it stands, the failure line stays until the person chooses, and Try again, refused as signed out, follows the link`);
				await closeContext(opened.context);
			}
		}

		// --- The page names its person: on every request and its socket on a shared server, nowhere on this computer ---
		for (const sharedServer of [true, false]) {
			const where = sharedServer ? "shared" : "this computer";
			const opened = await openApp(browser, sharedServer, (ctx) => ctx.addInitScript(() => {
				// Each socket's constructor arguments, and the protocol the server answered.
				const sockets: Array<{ url: string; protocols: unknown; answered?: string }> = [];
				Object.assign(window, { smokeSockets: sockets });
				window.WebSocket = new Proxy(window.WebSocket, {
					construct(target, args) {
						const socket = Reflect.construct(target, args) as WebSocket;
						const entry: { url: string; protocols: unknown; answered?: string } = { url: String(args[0]), protocols: args[1] ?? null };
						sockets.push(entry);
						socket.addEventListener("open", () => { entry.answered = socket.protocol; });
						return socket;
					},
				});
			}), sharedServer ? { person: MEMBER } : {});
			const { context, page } = opened;
			const named: Array<{ request: string; person: string | undefined }> = [];
			page.on("request", (request) => {
				const { pathname } = new URL(request.url());
				if (["fetch", "xhr"].includes(request.resourceType()) && pathname.startsWith("/api/")) named.push({ request: `${request.method()} ${pathname}`, person: request.headers()[PAGE_PERSON_HEADER] });
			});
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await openRoomFromHome(page, "Beta Room");
			await settled(opened);
			const expected = sharedServer ? MEMBER.id : undefined;
			assert(named.length > 0, `${where}: no request was seen`);
			const wrong = named.filter((entry) => entry.person !== expected);
			assert(wrong.length === 0, `${where}: requests that do not name ${expected ?? "no one"}: ${JSON.stringify(wrong)}`);
			const roomSocket = () => page.evaluate(() => (window as unknown as { smokeSockets: Array<{ url: string; protocols: unknown; answered?: string }> }).smokeSockets.filter((entry) => entry.url.includes("persistentAgentId=")).pop());
			await until(async () => (await roomSocket())?.answered !== undefined, `${where}: the room's socket never opened`);
			const room = await roomSocket();
			assert(JSON.stringify(room?.protocols) === JSON.stringify(sharedServer ? PAGE_PERSON_PROTOCOLS(MEMBER) : null), `${where}: the room's socket offered ${JSON.stringify(room?.protocols)}`);
			assert(room?.answered === (sharedServer ? "exxperts" : ""), `${where}: the server answered the protocol ${JSON.stringify(room?.answered)}`);
			pass(sharedServer
				? `shared: ${named.length} requests name the page's person in ${PAGE_PERSON_HEADER}, and the room's socket offers exxperts then exxperts-person.<id>, answered with exxperts`
				: `this computer: ${named.length} requests and the room's socket name no person and offer no protocol`);
			await closeContext(context);
		}

		// --- sharedServer: true, the server refuses the person the page names and says the page ends: it ends with the answer's words and sends nothing more ---
		{
			let refusing = false;
			let socketsAfter = 0;
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (refusing) {
						socketsAfter += 1;
						void ws.close();
						return;
					}
					ws.connectToServer();
				});
				// Every request from here on, as the edge answers once another person is signed in.
				await ctx.route("**/api/**", (route) => refusing
					? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(ANOTHER_PERSON) })
					: route.fallback());
			}, { person: MEMBER });
			const { context, page } = opened;
			await holdReload(page);
			let sentAfter = 0;
			let ended = false;
			page.on("request", (request) => { if (ended && ["fetch", "xhr"].includes(request.resourceType())) sentAfter += 1; });
			refusing = true;
			await page.locator(".persistent-agent-card").filter({ hasText: "Beta Room" }).locator(".persistent-agent-primary-actions .landing-action").first().click();
			await assertEndedCover(page, "refused person", ANOTHER_PERSON.error);
			await settled(opened);
			ended = true;
			const socketsThen = socketsAfter;
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			const more = await appears(() => sentAfter > 0 || socketsAfter > socketsThen, 3000);
			assert(!more, `refused person: the ended page sent ${sentAfter} request(s) and opened ${socketsAfter - socketsThen} socket(s)`);
			pass("shared: a request answered 409 with endsPage ends the page with the cover in the answer's words (reload held) and nothing is sent after it");
			await closeContext(context);
		}

		// --- sharedServer: true, a 403 and a 409 with endsPage and no words: the page ends with the fallback line ---
		for (const [status, body] of [[403, { code: SWITCHED_OFF.code, endsPage: true }], [409, { error: "", code: ANOTHER_PERSON.code, endsPage: true }]] as const) {
			let refusing = false;
			const opened = await openApp(browser, true, (ctx) => ctx.route("**/api/**", (route) => refusing
				? route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
				: route.fallback()), { person: MEMBER });
			const { context, page } = opened;
			await holdReload(page);
			refusing = true;
			await page.locator(".persistent-agent-card").filter({ hasText: "Beta Room" }).locator(".persistent-agent-primary-actions .landing-action").first().click();
			await assertEndedCover(page, `a ${status} with endsPage and no words`, ENDED_FALLBACK_LINE);
			pass(`shared: a ${status} with endsPage and ${"error" in body ? "empty words" : "no words"} ends the page with the fallback line`);
			await closeContext(context);
		}

		// --- A switched-off person: the server refuses every request with a 403 with endsPage and closes the socket with 4403 ---
		// X1: at Home, the socket closed with 4403: the next question ends the page, and it reloads into the edge's refusal page.
		{
			let refusing = false;
			const live: WebSocketRoute[] = [];
			const opened = await openApp(browser, true, async (ctx) => {
				await routeSwitchedOff(ctx, () => refusing);
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (refusing) return void ws.close(SWITCHED_OFF_CLOSE);
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { context, page } = opened;
			await until(() => live.length > 0, "X1: Home's socket never opened");
			refusing = true;
			for (const ws of live.splice(0)) void ws.close(SWITCHED_OFF_CLOSE);
			await until(async () => (await page.locator(".smoke-refusal-page").count()) === 1, "X1: the page did not reload into the edge's refusal page", 30000);
			assert((await page.locator(".smoke-refusal-page").innerText()) === SWITCHED_OFF.error, "X1: the reloaded page is not the edge's refusal page");
			pass("X1 shared: Home's socket closed with 4403 while every request is refused: the next question ends the page and it reloads into the refusal page");
			await closeContext(context);
		}

		// X2: in a room, its socket still open, the reload held: a refused request ends the page, which closes the socket itself.
		{
			let refusing = false;
			const live: WebSocketRoute[] = [];
			let closedByPage = 0;
			let socketsAfter = 0;
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.clock.install();
				await routeSwitchedOff(ctx, () => refusing);
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (refusing) {
						socketsAfter += 1;
						return void ws.close(SWITCHED_OFF_CLOSE);
					}
					const server = ws.connectToServer();
					ws.onClose((code, reason) => {
						if (refusing) closedByPage += 1;
						void server.close({ code, reason });
					});
					live.push(ws);
				});
			}, { person: MEMBER });
			const { context, page, reads } = opened;
			await enterRoom(page, "Beta Room");
			const reloads = await countHeldReloads(page);
			let sentAfter = 0;
			let ended = false;
			page.on("request", (request) => { if (ended && ["fetch", "xhr"].includes(request.resourceType())) sentAfter += 1; });
			refusing = true;
			const readsBefore = reads();
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await until(() => reads() > readsBefore, "X2: a focus did not ask client-context");
			await assertSwitchedOffCover(page, "X2");
			await until(() => closedByPage > 0, "X2: the page did not close its own live connection");
			await until(() => reloads() === 1, `X2: the page did not try to reload once (${reloads()})`);
			ended = true;
			await page.clock.runFor(150_000);
			await settled(opened);
			assert(sentAfter === 0 && socketsAfter === 0, `X2: the ended page went on: ${sentAfter} request(s), ${socketsAfter} socket(s)`);
			assert((await page.getByText(/lost its connection/).count()) === 0, "X2: a lost-connection line shows beside the cover");
			assert(reloads() === 1, `X2: the page tried to reload ${reloads()} times`);
			pass("X2 shared: in a room with its socket open, a request refused with a 403 with endsPage ends the page once: the cover with the answer's words and Reload, the socket closed by the page, no ladder and no lost-connection line after it");
			await closeContext(context);
		}

		// X3: two requests out when the page ends, answered after it: client-context with a 200 naming another person, and
		// the sign-in check with a 401. Neither reaches its caller: the cover keeps its words, and nothing sends the page anywhere.
		{
			let refusing = false;
			let holding = false;
			const held: Array<() => Promise<void>> = [];
			const live: WebSocketRoute[] = [];
			const opened = await openApp(browser, true, async (ctx) => {
				await routeSwitchedOff(ctx, () => refusing);
				await ctx.route(/\/api\/(remote\/client-context|auth\/status)$/, async (route) => {
					if (!holding) return route.fallback();
					const late = new URL(route.request().url()).pathname === "/api/auth/status"
						? { status: 401, contentType: "application/json", body: JSON.stringify(SESSION_SIGNED_OUT) }
						: { contentType: "application/json", body: JSON.stringify({ remote: false, capability: "full", sharedServer: true, person: OTHER }) };
					await new Promise<void>((resolve) => { held.push(async () => { resolve(); }); });
					return route.fulfill(late);
				});
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (holding) return void ws.close();
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { context, page } = opened;
			await until(() => live.length > 0, "X3: Home's socket never opened");
			let navigations = 0;
			page.on("request", (request) => { if (request.isNavigationRequest()) navigations += 1; });
			// A click first: a page with no touch from the person shows no prompt on leaving, so the reload would not be held.
			await page.locator(".home-page h1").click();
			const reloads = await countHeldReloads(page);
			holding = true;
			for (const ws of live.splice(0)) void ws.close();
			// The drop asks at once whether the person is still signed in, and Home's retry asks client-context.
			await until(() => held.length === 2, `X3: the sign-in check and the retry's question were not both sent (${held.length})`, 30000);
			holding = false;
			refusing = true;
			await page.locator(".persistent-agent-card").filter({ hasText: "Beta Room" }).locator(".persistent-agent-primary-actions .landing-action").first().click();
			await assertSwitchedOffCover(page, "X3");
			await until(() => reloads() === 1, `X3: the page did not try to reload once (${reloads()})`);
			for (const release of held.splice(0)) await release();
			await settled(opened);
			await assertSwitchedOffCover(page, "X3 after the late answers");
			const redirected = await page.evaluate(() => sessionStorage.getItem("exxperts-auth-redirect"));
			assert(reloads() === 1 && navigations === 0 && redirected === null, `X3: a late answer moved the page: ${reloads()} reload tries, ${navigations} navigations, sign-in mark ${JSON.stringify(redirected)}`);
			pass("X3 shared, reload held: a client-context read answered 200 with another person and a sign-in check answered 401, both after the page ended, reach no caller: the cover keeps the sentence and the page goes nowhere");
			await closeContext(context);
		}

		// X4: the first read failed, so the page took itself for this computer; then the socket closes with 4403 and the
		// person is refused. Its next retry asks client-context and ends the page, at Home and in a room. Only that question
		// is refused here: the sign-in check answers "signed in" and anything else gets no answer, so no other request can
		// end the page in its place. At Home the drop asks the sign-in check too, as on a shared server.
		for (const where of ["Home", "a room"] as const) {
			let refusing = false;
			let signInChecks = 0;
			const live: WebSocketRoute[] = [];
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.route("**/api/**", (route) => {
					if (!refusing) return route.fallback();
					const { pathname } = new URL(route.request().url());
					if (pathname === "/api/remote/client-context") return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify(SWITCHED_OFF) });
					if (pathname !== "/api/auth/status") return route.abort();
					signInChecks += 1;
					return route.fulfill({ contentType: "application/json", body: "{}" });
				});
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (refusing) return void ws.close(SWITCHED_OFF_CLOSE);
					ws.connectToServer();
					live.push(ws);
				});
			}, { fail: true });
			const { context, page, probe } = opened;
			if (where === "a room") await enterRoom(page, "Beta Room");
			// A click first: a page with no touch from the person shows no prompt on leaving, so the reload would not be held.
			else await page.locator(".home-page h1").click();
			const reloads = await countHeldReloads(page);
			await until(() => live.length > 0, `X4 ${where}: the live connection never opened`);
			probe.fail = false;
			refusing = true;
			for (const ws of live.splice(0)) void ws.close(SWITCHED_OFF_CLOSE);
			await assertSwitchedOffCover(page, `X4 ${where}`, 30000);
			await until(() => reloads() === 1, `X4 ${where}: the page did not try to reload once (${reloads()})`);
			assert(where === "a room" || signInChecks > 0, `X4 ${where}: the drop did not ask whether the person is still signed in`);
			pass(`X4 a failed first read, then a 4403 and client-context refused, ${where}: the next retry asks client-context and the page ends with the sentence${where === "Home" ? "; the drop asked the sign-in check" : ""}`);
			await closeContext(context);
		}

		// X5, X6: the edge cannot read the mark (503 switched_off_unchecked), or refuses with another code (403): nothing
		// ends, and both ladders keep asking. The room first, then Home.
		for (const [row, status, body] of [["X5", 503, SWITCHED_OFF_UNCHECKED], ["X6", 403, REFUSAL]] as const) {
			let refusing = false;
			const live: WebSocketRoute[] = [];
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.clock.install();
				await ctx.route("**/api/**", (route) => refusing ? route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }) : route.fallback());
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (refusing) return void ws.close();
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { context, page, reads } = opened;
			await enterRoom(page, "Beta Room");
			const reloads = await countHeldReloads(page);
			let navigations = 0;
			page.on("request", (request) => { if (request.isNavigationRequest()) navigations += 1; });
			const runUntil = async (condition: () => boolean, message: string) => {
				for (let step = 0; step < 120 && !condition(); step += 1) {
					await page.clock.runFor(1000);
					await settled(opened);
				}
				assert(condition(), message);
			};
			for (const where of ["a room", "Home"] as const) {
				if (where === "Home") {
					refusing = false;
					await leaveRoomToHome(page);
				}
				await until(() => live.length > 0, `${row} ${where}: the live connection never opened`);
				refusing = true;
				const readsBefore = reads();
				for (const ws of live.splice(0)) void ws.close();
				await runUntil(() => reads() >= readsBefore + 3, `${row} ${where}: the ladder stopped asking client-context after ${reads() - readsBefore} question(s)`);
				assert((await page.locator(".person-changed-cover").count()) === 0 && reloads() === 0 && navigations === 0, `${row} ${where}: a ${status} ${body.code} ended the page`);
			}
			pass(`${row} shared: ${status} ${body.code} on every request ends nothing; Home's ladder and the room's keep asking client-context`);
			await closeContext(context);
		}

		// --- Home's dropped socket: on a shared server each try asks client-context before the rebuild; on this computer as today ---
		for (const sharedServer of [true, false]) {
			const where = sharedServer ? "shared" : "this computer";
			const live: WebSocketRoute[] = [];
			let refused = false;
			let tries = 0;
			const opened = await openApp(browser, sharedServer, async (ctx) => {
				await ctx.clock.install();
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (refused) {
						tries += 1;
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
			}, sharedServer ? { person: MEMBER } : {});
			const { context, page, probe, reads } = opened;
			await holdReload(page);
			const lines: string[] = [];
			page.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") lines.push(message.text()); });
			// The ladder's clock runs on a second at a time until the condition holds.
			const runUntil = async (condition: () => boolean | Promise<boolean>, message: string, seconds = 60) => {
				for (let step = 0; step < seconds; step += 1) {
					if (await condition()) return;
					await page.clock.runFor(1000);
					await settled(opened);
				}
				throw new Error(message);
			};
			await until(() => live.length > 0, `${where} ladder: Home's socket never opened`);
			refused = true;
			const readsBefore = reads();
			if (sharedServer) probe.fail = true;
			for (const ws of live.splice(0)) void ws.close();
			if (sharedServer) {
				// No answer: each try asks again later and rebuilds nothing.
				await runUntil(() => reads() >= readsBefore + 2, "shared ladder: the ladder did not ask client-context before its tries");
				// A server that answers nothing is an outage: the lost-connection line comes, as when each rebuild failed.
				await runUntil(async () => (await page.getByText(LOST_SHARED_LINE, { exact: true }).count()) === 1, "shared ladder: client-context answering nothing never brought the lost-connection line");
				assert(tries === 0, `shared ladder: ${tries} socket(s) rebuilt while client-context did not answer`);
				// An answer: the next try rebuilds.
				probe.fail = false;
				await runUntil(() => tries > 0, "shared ladder: no rebuild once client-context answered");
				// Refused: the next question ends the page, with no rebuild after it.
				probe.refuse = true;
				const triesThen = tries;
				await runUntil(async () => (await page.locator(".person-changed-cover").count()) === 1, "shared ladder: a 409 with endsPage on client-context did not end the page");
				assert(tries === triesThen, `shared ladder: the socket was rebuilt ${tries - triesThen} time(s) after client-context answered 409`);
				const readsThen = reads();
				const linesThen = lines.length;
				await page.clock.runFor(60_000);
				await settled(opened);
				assert(tries === triesThen && reads() === readsThen && lines.length === linesThen, `shared ladder: the ended page went on (${tries - triesThen} sockets, ${reads() - readsThen} reads, lines ${JSON.stringify(lines.slice(linesThen))})`);
				pass(`shared: Home's dropped socket asks client-context first; no answer rebuilds nothing and brings the lost-connection line, an answer rebuilds, and its 409 with endsPage ends the page with no rebuild and no further line (${lines.length} warning lines in all)`);
			} else {
				await runUntil(() => tries >= 2, "this computer ladder: Home's socket was not rebuilt");
				assert(reads() === readsBefore, `this computer ladder: the ladder read client-context ${reads() - readsBefore} time(s)`);
				pass(`this computer: Home's dropped socket is rebuilt as today (${tries} tries), with no client-context question`);
			}
			await closeContext(context);
		}

		// --- A remote device on this computer keeps its rule for the default models ---
		{
			const { context, page } = await openApp(browser, false, undefined, { remote: true });
			await openSettings(page);
			await openTab(page, "AI setup");
			assert((await page.locator(".settings-overlay .ai-defaults-group .room-model-pick:not(:disabled)").count()) === 2, "remote device with full access: the default models are read-only");
			pass("this computer, remote device with full access: the default models can still be changed");
			await closeContext(context);
		}

		// --- sharedServer: true, a long name on a phone ---
		{
			const longName = "Sample Person With A Very Long Name That Keeps Going ".repeat(4).trim();
			const { context, page } = await openApp(browser, true, undefined, { person: { ...MEMBER, name: longName }, signOut: SIGN_OUT_LINK });
			await page.setViewportSize({ width: 390, height: 800 });
			const gear = page.locator(".product-sidebar-footer .sidebar-config-gear");
			await gear.waitFor({ timeout: 10000 });
			await until(async () => {
				const box = await gear.boundingBox();
				return box !== null && box.x >= 0 && box.x + box.width <= 390;
			}, "shared phone: a long name pushed Settings off the screen");
			assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, "shared phone: a long name made the page scroll sideways");
			assert((await page.locator(".product-sidebar-footer .signed-in-as-name").evaluate((node) => node.scrollWidth > node.clientWidth)), "shared phone: the long name was not cut");
			assert(await page.locator(".product-sidebar .product-nav").evaluate((node) => node.scrollWidth <= node.clientWidth), "shared phone: with Sign out in the footer, the top bar's tabs are cut (the nav has to scroll)");
			assert(await page.locator(".product-sidebar-footer .signed-in-as-scope").isVisible(), "shared phone: the scope line is not on screen");
			pass("shared phone: a long name is cut with an ellipsis, Settings stays on screen, and Sign out with its scope line leaves the tabs whole");
			await closeContext(context);
		}

		// --- sharedServer: true, another person while a room's retry waits: nothing of the old page is saved ---
		{
			const saves: string[] = [];
			const live: WebSocketRoute[] = [];
			let down = false;
			let connectsAfterChange = 0;
			let changed = false;
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (changed) connectsAfterChange += 1;
					if (down) {
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { page, probe, reads } = opened;
			page.on("request", (request) => {
				if (changed && request.method() !== "GET" && /\/api\/persistent-agents\/[^/]+\/threads\//.test(new URL(request.url()).pathname)) saves.push(`${request.method()} ${new URL(request.url()).pathname}`);
			});
			await enterRoom(page, "Beta Room");
			await holdReload(page);
			// Every retry fails at the first question until the server answers as someone else.
			down = true;
			probe.fail = true;
			const asked = reads();
			for (const ws of live.splice(0)) void ws.close();
			await until(() => reads() > asked, "person change: the room never retried");
			probe.person = OTHER;
			probe.fail = false;
			down = false;
			changed = true;
			await page.locator(".person-changed-cover").waitFor({ timeout: 30000 });
			await settled(opened);
			assert(saves.length === 0, `person change: the old page saved a thread as the new person: ${saves.join(", ")}`);
			assert(connectsAfterChange === 0, `person change: the old page opened ${connectsAfterChange} connection(s) after the change`);
			// The cover is what a click on the old composer would hit.
			// A hit that is null (off the screen) is not a cover: it needs a real element with the cover above it.
			const covered = await page.evaluate(() => {
				const box = document.querySelector("textarea")?.getBoundingClientRect();
				if (!box) return false;
				const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
				return hit !== null && hit.closest(".person-changed-cover") !== null;
			});
			assert(covered, "person change: the old room's composer is still usable");
			pass("shared: another person signing in while a room's retry waits blanks the page and saves and reconnects nothing, even when the reload is held");
			await closeContext(opened.context);
		}

		// --- sharedServer: true, another person while a reconnect waits on its save ---
		{
			const live: WebSocketRoute[] = [];
			let holdPut = false;
			let held: Route | null = null;
			let changed = false;
			let connectsAfterChange = 0;
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (changed) connectsAfterChange += 1;
					ws.connectToServer();
					live.push(ws);
				});
				await ctx.route(/\/api\/persistent-agents\/[^/]+\/threads\//, (route) => {
					if (holdPut && route.request().method() === "PUT") {
						held = route;
						return;
					}
					return route.continue();
				});
			}, { person: MEMBER });
			const { page, probe } = opened;
			await enterRoom(page, "Beta Room");
			await holdReload(page);
			// The room drops; its retry gets as far as saving the thread, and the save is held.
			holdPut = true;
			for (const ws of live.splice(0)) void ws.close();
			await until(() => held !== null, "reconnect on save: the retry never reached its save", 30000);
			// While it waits, the server answers as someone else.
			probe.person = OTHER;
			changed = true;
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await page.locator(".person-changed-cover").waitFor({ timeout: 15000 });
			// The cover is all that can be reached or read: the page under it is inert, and focus is inside it.
			const access = await page.evaluate(() => {
				const cover = document.querySelector(".person-changed-cover");
				const others = Array.from(document.body.children).filter((node) => node !== cover && !node.contains(cover) && !cover?.contains(node));
				return {
					unreachable: others.every((node) => (node as HTMLElement).inert === true),
					hidden: others.every((node) => node.getAttribute("aria-hidden") === "true"),
					focusInCover: !!document.activeElement?.closest(".person-changed-cover"),
				};
			});
			assert(access.unreachable && access.hidden, `person change: the page under the cover is still reachable (${JSON.stringify(access)})`);
			assert(access.focusInCover, "person change: focus was not moved into the cover");
			for (let tab = 0; tab < 4; tab += 1) await page.keyboard.press("Tab");
			assert(await page.evaluate(() => !!document.activeElement?.closest(".person-changed-cover")), "person change: Tab left the cover");
			// The save now comes back; nothing may go on from it as the new person.
			const savedBack = page.waitForResponse((res) => res.request().method() === "PUT" && /\/threads\//.test(new URL(res.url()).pathname), { timeout: 15000 });
			await (held as unknown as Route).continue();
			await savedBack;
			await settled(opened);
			assert(connectsAfterChange === 0, `reconnect on save: the old page opened ${connectsAfterChange} connection(s) as the new person after its save came back`);
			pass("shared: another person while a reconnect waits on its save: the cover takes focus and the page under it is unreachable, and no connection opens as the new person");
			await closeContext(opened.context);
		}

		// --- sharedServer: true, a finished question for the room left behind does not touch the room the person is in ---
		{
			const live: WebSocketRoute[] = [];
			const droppedRooms = new Set<string>();
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if ([...droppedRooms].some((id) => ws.url().includes(id))) {
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { context, page, probe } = opened;
			await enterRoom(page, "Beta Room");
			// Beta Room drops; its retry's question is held, to be answered late. Every later question fails at once.
			droppedRooms.add(ids["Beta Room"]);
			probe.holdNext = true;
			for (const ws of live.splice(0)) void ws.close();
			await until(() => probe.holding, "obsolete retry: the room never retried", 30000);
			probe.fail = true;
			await leaveRoomToHome(page);
			await openRoomFromHome(page, "Alpha Room");
			await settled(besideHeld(opened));
			// Alpha Room drops too and is retrying.
			droppedRooms.add(ids["Alpha Room"]);
			for (const ws of live.splice(0)) void ws.close();
			await page.getByText("Reconnecting…", { exact: true }).waitFor({ timeout: 15000 });
			probe.release();
			await until(() => probe.released > 0, "obsolete retry: the first room's question was never answered");
			await settled(opened);
			// It has been answered: the room the person is in keeps reading as retrying, never as plain offline.
			for (let look = 0; look < 30; look += 1) {
				assert((await page.getByText("Offline", { exact: true }).count()) === 0, "obsolete retry: the first room's answer made the room the person is in read as offline");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			pass("shared: a first room's question that finishes late leaves the room the person is in still retrying");
			await closeContext(context);
		}

		// --- sharedServer: true, an older sign-in check that comes back late does not undo a newer one ---
		{
			let dropped = false;
			let statusCalls = 0;
			let olderDone = 0;
			let releaseOlder = () => {};
			const olderHeld = new Promise<void>((resolve) => { releaseOlder = resolve; });
			const live: WebSocketRoute[] = [];
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.clock.install();
				// The page was sent to sign in a moment ago, so it will not go twice.
				await ctx.addInitScript(() => { if (!sessionStorage.getItem("exxperts-auth-redirect")) sessionStorage.setItem("exxperts-auth-redirect", String(Date.now() + 120_000)); });
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (dropped) {
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
				await ctx.route("**/api/auth/status", async (route) => {
					if (!dropped) return route.continue();
					statusCalls += 1;
					if (statusCalls === 1) {
						// The first check is held and finds the person still signed in; the second finds the session over.
						await olderHeld;
						olderDone += 1;
						return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers: [] }) });
					}
					return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Not signed in.", code: "auth_required" }) });
				});
			}, { person: MEMBER });
			const { context, page } = opened;
			await until(() => live.length > 0, "stale check: the page's live connection never opened");
			dropped = true;
			for (const ws of live.splice(0)) void ws.close();
			const signedOutLine = page.getByText(SIGNED_OUT_LINE, { exact: true });
			// The older check, held on purpose, is not in flight for settling.
			const besideOlder = { page, pending: () => opened.pending() - (statusCalls > 0 && olderDone === 0 ? 1 : 0) };
			for (let second = 0; (await signedOutLine.count()) === 0; second += 1) {
				assert(second < 60, "stale check: the signed-out line never showed");
				await page.clock.runFor(1000);
				await settled(besideOlder);
			}
			releaseOlder();
			await until(() => olderDone > 0, "stale check: the older check never came back");
			for (let look = 0; look < 20; look += 1) {
				assert((await page.getByText(SIGNED_OUT_LINE, { exact: true }).count()) === 1, "stale check: an older answer that came back late replaced the signed-out line");
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			pass("shared: an older sign-in check that comes back late does not undo the newer one that found the session over");
			await closeContext(context);
		}

		// --- sharedServer: true, a start-up read refused ---
		{
			let refusedReads = 0;
			const opened = await openApp(browser, true, (ctx) =>
				ctx.route("**/api/persistent-agent-ai-profile", (route) => {
					if (route.request().method() !== "GET") return route.continue();
					refusedReads += 1;
					return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify(REFUSAL) });
				}));
			const { context, page } = opened;
			await until(() => refusedReads > 0, "refused start-up read: the page never read the profiles");
			await settled(opened);
			assert((await page.getByText("Your rooms.", { exact: true }).count()) === 1, "refused start-up read: Home is not drawn");
			assert((await page.locator(".persistent-agent-card").count()) === ROOMS.length, "refused start-up read: the rooms are not listed");
			assert((await page.getByText(BOUNDARY_LINE).count()) === 0, "refused start-up read: the page fell back to the error boundary");
			assert((await page.getByText(REFUSAL.error).count()) === 0, "refused start-up read: the refusal's body is shown as data");
			await openSettings(page);
			await openTab(page, "Web search");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "refused start-up read: Settings is not usable");
			await closeSettings(page);
			pass("shared: a start-up read answered 403 { error, code } leaves Home and Settings usable");
			await closeContext(context);
		}

		// --- The live connection drops: signed out, a real outage, and the same on this computer ---
		{
			const onClock = (context: BrowserContext) => context.clock.install();
			const signedOut = await openWithDroppableConnection(browser, true, true, onClock);
			const outage = await openWithDroppableConnection(browser, true, false, onClock);
			const local = await openWithDroppableConnection(browser, false, true, onClock);
			for (const { opened, isLive } of [signedOut, outage, local]) {
				await until(isLive, "dropped connection: a page's live connection never opened");
				await settled(opened);
			}
			let toSignIn = false;
			signedOut.opened.page.on("request", (request) => { if (request.isNavigationRequest() && new URL(request.url()).pathname === "/") toSignIn = true; });
			let localLeft = false;
			local.opened.page.on("request", (request) => { if (request.isNavigationRequest()) localLeft = true; });
			let outageLeft = false;
			outage.opened.page.on("request", (request) => { if (request.isNavigationRequest()) outageLeft = true; });
			for (const { drop } of [signedOut, outage, local]) drop();
			const outageLine = outage.opened.page.getByText(LOST_SHARED_LINE, { exact: true });
			const localLine = local.opened.page.getByText(LOST_LINE);
			let waited = 0;
			while (!toSignIn || (await outageLine.count()) === 0 || (await localLine.count()) === 0) {
				assert(waited < OUTAGE_LIMIT_MS, `dropped connection: within a minute, sent to sign in ${toSignIn}, the shared line ${await outageLine.count()}, this computer's line ${await localLine.count()}`);
				for (const { opened } of [outage, local, ...(toSignIn ? [] : [signedOut])]) await opened.page.clock.runFor(1000);
				for (const { opened } of [outage, local]) await settled(opened);
				waited += 1000;
			}
			assert(!outageLeft, "shared outage: the page left although the person is signed in");
			assert((await outage.opened.page.getByText(/Restarting the app/).count()) === 0, "shared outage: the line tells the person to restart the app");
			assert(!localLeft, "this computer: the page left instead of saying the connection is lost");
			pass(`a dropped connection: on a shared server a 401 sends the page to sign in, a signed-in person sees the lost-connection line in the shared words, and this computer shows the line as today (${waited / 1000}s on the pages' clock)`);
			for (const { opened } of [signedOut, outage, local]) await closeContext(opened.context);

			// A sign-in that ended, with the page already sent to sign in a moment ago (it does not go twice
			// within 15 s): the first failed attempt says so at once, with a way to sign in, and the lost line never shows.
			// Sign in again goes to the server's sign-out link when it sends one (a session ended on another device keeps
			// this browser's cookie, which only the full sign-out clears), and to "/" when it sends none.
			for (const signOut of [undefined, SIGN_OUT_LINK]) {
				const where = signOut ? "with the server's sign-out link" : "with no sign-out link";
				const again = await openWithDroppableConnection(browser, true, true, async (context) => {
					await context.addInitScript(() => { if (!sessionStorage.getItem("exxperts-auth-redirect")) sessionStorage.setItem("exxperts-auth-redirect", String(Date.now() + 60_000)); });
				}, { person: MEMBER, signOut });
				await until(() => again.isLive(), `B1 signed out ${where}: the page's live connection never opened`);
				again.drop();
				await again.opened.page.getByText(SIGNED_OUT_LINE, { exact: true }).waitFor({ timeout: 8000 });
				const href = await again.opened.page.locator(".connection-lost-banner a").getAttribute("href");
				assert(href === (signOut ?? "/"), `B1 signed out ${where}: Sign in again goes to ${JSON.stringify(href)}, not ${signOut ? "the server's sign-out link" : "/"}`);
				assert((await again.opened.page.getByText(/lost its connection/).count()) === 0, `B1 signed out ${where}: the lost-connection line shows beside it`);
				pass(`a sign-in that ended inside the no-second-redirect window, ${where}: the page says it at the first failed attempt, Sign in again going to ${signOut ? "the server's sign-out link" : "/"}`);
				await closeContext(again.opened.context);
			}
		}

		// --- A room's connection lost for longer than two minutes (the clock runs on, so it takes seconds) ---
		for (const sharedServer of [true, false]) {
			const live: WebSocketRoute[] = [];
			let down = false;
			let threadReads = 0;
			const opened = await openApp(browser, sharedServer, async (context) => {
				await context.clock.install();
				await context.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (down) {
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
				await context.route(/\/api\/persistent-agents\/[^/]+\/threads\//, (route) => {
					if (!down) return route.continue();
					threadReads += 1;
					return route.abort();
				});
			}, sharedServer ? { person: MEMBER } : {});
			const { page, probe, reads } = opened;
			const where = sharedServer ? "shared" : "this computer";
			const runFor = async (seconds: number) => {
				for (let step = 0; step < seconds / 5; step += 1) {
					await page.clock.runFor(5000);
					await settled(opened);
				}
			};
			await enterRoom(page, "Beta Room");
			// What the room's entry set off on a timer (its first save) is done before the drop.
			await runFor(5);
			down = true;
			probe.fail = true;
			for (const ws of live.splice(0)) void ws.close();
			await runFor(130);
			const reconnect = page.locator(".composer-reconnect-btn");
			if (sharedServer) {
				assert((await reconnect.count()) === 0, `${where}: the room gave up after two minutes`);
				assert((await page.locator(`[title="${PILL_SHARED}"]`).count()) >= 1, `${where}: the pill does not say the room keeps trying`);
				assert(threadReads === 0, `${where}: the room read its thread (${threadReads}) while the server did not answer client-context`);
				// The server answers client-context again but the thread not yet: only then is the thread asked for.
				probe.fail = false;
				const readsBefore = reads();
				await runFor(30);
				assert(reads() > readsBefore, `${where}: a retry did not read client-context first`);
				assert(threadReads > 0, `${where}: a retry never read the thread once client-context answered`);
				assert((await reconnect.count()) === 0, `${where}: the room gave up while the server was coming back`);
				// And back: the next retry brings the room up with no button and no reload.
				down = false;
				await runFor(30);
				await page.locator('[title="Context and model details"]').first().waitFor({ timeout: 10000 });
				assert((await page.locator(`[title="${PILL_SHARED}"]`).count()) === 0, `${where}: the pill still says the room lost its connection`);
				pass(`${where}: past two minutes the room keeps trying, asks client-context before its thread, and is back once the server is (${threadReads} thread reads)`);
			} else {
				await reconnect.waitFor({ timeout: 10000 });
				assert((await reconnect.getAttribute("title")) === RECONNECT_DESKTOP, `${where}: the Reconnect tooltip is not the desktop's`);
				assert((await page.locator(`[title="${PILL_DESKTOP_FAILED}"]`).count()) >= 1, `${where}: the pill is not the desktop's words`);
				pass(`${where}: the room gives up after two minutes with Reconnect and the desktop's words`);
			}
			await closeContext(opened.context);
		}

		// --- A room that is still finishing an answer stands down, on a shared server and on this computer ---
		for (const sharedServer of [true, false]) {
			const live: WebSocketRoute[] = [];
			let cooking = false;
			const { context, page } = await openApp(browser, sharedServer, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (cooking) {
						ws.send(JSON.stringify({ type: "error", code: "room_cooking", error: "This room is still finishing an answer." }));
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
			}, sharedServer ? { person: MEMBER } : {});
			const where = sharedServer ? "shared" : "this computer";
			await enterRoom(page, "Beta Room");
			cooking = true;
			for (const ws of live.splice(0)) void ws.close();
			const reconnect = page.locator(".composer-reconnect-btn");
			await reconnect.waitFor({ timeout: 20000 });
			assert((await reconnect.getAttribute("title")) === (sharedServer ? RECONNECT_SHARED : RECONNECT_DESKTOP), `${where} stand-down: the Reconnect tooltip is not that edition's words, got ${JSON.stringify(await reconnect.getAttribute("title"))}`);
			pass(`${where}: a room still finishing an answer stands down with Reconnect and that edition's words${sharedServer ? ", not the keep-trying ladder" : ""}`);
			await closeContext(context);
		}

		// --- A gateway's bare 403, handed back the way the server hands a failed message back ---
		for (const sharedServer of [true, false]) {
			let roomSocket: WebSocketRoute | undefined;
			const opened = await openApp(browser, sharedServer, (ctx) =>
				ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					ws.connectToServer();
					if (ws.url().includes("persistentAgentId=")) roomSocket = ws;
				}));
			const { context, page } = opened;
			const where = sharedServer ? "shared" : "this computer";
			await enterRoom(page, "Beta Room");
			assert(roomSocket, `${where}: the room's live connection is open`);
			// A room without a folder: the hint to connect one, never on a shared server, where there is no folder to set.
			const folderHint = page.locator(".room-workspace-nudge:not(.room-model-notice)");
			// The hint waits for the room's folder to be read: once the room's reads are done it would show.
			if (sharedServer) {
				await settled(opened);
				assert((await folderHint.count()) === 0, `${where}: the hint to connect a folder shows`);
			}
			else await folderHint.waitFor({ timeout: 10000 });
			roomSocket.send(JSON.stringify({ type: "prompt_returned", text: "A question for the gateway.", failure: "gateway-refused", model: { provider: "acme-gw", model: "acme-model" } }));
			const line = page.locator(".failure-line:not(.is-folded)");
			await line.waitFor({ timeout: 10000 });
			const shown = (await line.locator(".system-line-text").innerText()).replace(/\s+/g, " ").trim();
			const buttons = (await line.locator(".failure-actions .rs-btn").allInnerTexts()).map((text) => text.trim()).join("|");
			if (sharedServer) {
				assert(shown.endsWith("Tell your admin, or choose another model."), `${where}: the gateway's 403 sends the person to the admin, got ${JSON.stringify(shown)}`);
				assert(buttons === "Choose another model", `${where}: no button for telling the admin and no Replace key, only Choose another model, got ${JSON.stringify(buttons)}`);
			} else {
				assert(shown.endsWith("Replace the gateway's key, or choose another model."), `${where}: the gateway's 403 names the key, its button in place of where it is replaced, got ${JSON.stringify(shown)}`);
				assert(buttons === "Choose another model|Replace key", `${where}: Replace key and Choose another model, got ${JSON.stringify(buttons)}`);
				await line.getByRole("button", { name: "Replace key" }).click();
				await page.locator(".settings-overlay").waitFor({ timeout: 10000 });
				const activeTab = (await page.locator(".settings-dialog-nav [aria-current='page']").allInnerTexts()).join("|");
				assert(activeTab.includes("AI setup"), `${where}: Replace key opens Settings at AI setup, got ${JSON.stringify(activeTab)}`);
				await closeSettings(page);
			}
			pass(`${where}: a gateway's bare 403 offers ${buttons.replace("|", " and ")}${sharedServer ? ", never a button for telling the admin, and no hint to connect a folder" : ", and the hint to connect a folder shows"}`);
			// A gateway's bare 404 handed back before its model list was read: the gateway is checked in AI setup, which on a shared server is the admin's.
			await page.locator("textarea").first().fill("");
			roomSocket.send(JSON.stringify({ type: "prompt_returned", text: "A question the gateway cannot find.", failure: "gateway-not-found", model: { provider: "acme-gw", model: "acme-model" } }));
			await line.locator(".system-line-text", { hasText: "could not find" }).waitFor({ timeout: 10000 });
			const notFound = (await line.locator(".system-line-text").innerText()).replace(/\s+/g, " ").trim();
			const notFoundButtons = (await line.locator(".failure-actions .rs-btn").allInnerTexts()).map((text) => text.trim()).join("|");
			if (sharedServer) {
				assert(notFound.endsWith("Tell your admin."), `${where}: the gateway's 404 sends the person to the admin, got ${JSON.stringify(notFound)}`);
				assert(notFoundButtons === "", `${where}: no button for a gateway's 404, got ${JSON.stringify(notFoundButtons)}`);
			} else {
				assert(notFound.endsWith("Check the gateway."), `${where}: the gateway's 404 names what to check, its button in place of where, got ${JSON.stringify(notFound)}`);
				assert(notFoundButtons === "Open AI setup", `${where}: AI setup's button only, got ${JSON.stringify(notFoundButtons)}`);
				await line.getByRole("button", { name: "Open AI setup" }).click();
				await page.locator(".settings-overlay").waitFor({ timeout: 10000 });
				const activeTab = (await page.locator(".settings-dialog-nav [aria-current='page']").allInnerTexts()).join("|");
				assert(activeTab.includes("AI setup"), `${where}: Open AI setup opens Settings at AI setup, got ${JSON.stringify(activeTab)}`);
				await closeSettings(page);
			}
			pass(`${where}: a gateway's bare 404 ${sharedServer ? "tells the person to tell the admin, with no button" : "names what to check, with AI setup's button"}`);
			await closeContext(context);
		}

		// --- The words for a missing or gone model: a member and the admin on a shared server, and this computer as today ---
		for (const who of [MEMBER, ADMIN, null]) {
			const where = who === null ? "this computer" : who.admin ? "shared admin" : "shared member";
			const words = who === null ? MODEL_WORDS.computer : who.admin ? MODEL_WORDS.admin : MODEL_WORDS.member;
			let roomSocket: WebSocketRoute | undefined;
			// No model at all: every room's row has none, and no provider is ready. The rooms read as never opened, so
			// their cards offer Enter, whose tooltip names what is missing, not Resume.
			let noModels = false;
			let noProviders = false;
			// The room's folder cannot be read: Delete names no folder rather than guessing.
			let noFolderRead = false;
			const { context, page } = await openApp(browser, who !== null, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					ws.connectToServer();
					if (ws.url().includes("persistentAgentId=")) roomSocket = ws;
				});
				await ctx.route("**/api/persistent-agents", async (route) => {
					if (!noModels || route.request().method() !== "GET") return route.fallback();
					const statuses = await (await route.fetch()).json();
					return route.fulfill({ json: statuses.map((status: any) => ({ ...status, runtime: { ...status.runtime, activeThreadId: null }, models: { ...status.models, conversation: { ...status.models?.conversation, chosen: null, effective: null, reason: undefined, refusal: undefined } } })) });
				});
				await ctx.route("**/api/persistent-agents/*/workspace-default", (route) => noFolderRead && route.request().method() === "GET" ? route.abort() : route.fallback());
				await ctx.route("**/api/persistent-agent-room/model-status", async (route) => {
					if (!noProviders) return route.fallback();
					const status = await (await route.fetch()).json();
					return route.fulfill({ json: { ...status, providers: (status.providers ?? []).map((provider: any) => ({ ...provider, ready: false })) } });
				});
			}, who ? { person: who } : {});

			await page.locator(".product-sidebar-footer button").first().click();
			await page.locator(".sidebar-config-menu").getByRole("menuitem", { name: /^Help/ }).click();
			await page.locator(".sidebar-config-menu").getByRole("menuitem", { name: "How it works" }).click();
			const firstStep = (await page.locator(".help-steps p").first().innerText()).replace(/\s+/g, " ").trim();
			assert(firstStep === words.help, `${where}: Help's first step reads ${JSON.stringify(firstStep)}`);
			await page.keyboard.press("Escape");
			pass(`${where}: Help's first step says who sets up the models`);

			// The room stopped on its key: one message handed back with the notice, in a page opened afresh for each state.
			for (const gone of words.stopped) {
				roomSocket = undefined;
				await enterRoom(page, "Beta Room");
				assert(roomSocket, `${where}: the room's live connection is open`);
				(roomSocket as WebSocketRoute).send(JSON.stringify({ type: "prompt_returned", text: "A question for the model.", notice: true, model: { provider: gone.provider, model: gone.model }, ...(gone.key ? { key: gone.key } : {}) }));
				const notice = page.locator(".room-model-notice");
				await notice.waitFor({ timeout: 10000 });
				const line = (await notice.locator(".room-workspace-nudge-text").innerText()).replace(/\s+/g, " ").trim();
				const buttons = (await notice.locator(".room-workspace-nudge-actions button").allInnerTexts()).map((text) => text.trim()).join("|");
				assert(line === gone.line, `${where}, ${gone.state}: the stopped notice reads ${JSON.stringify(line)}`);
				assert(buttons === gone.buttons, `${where}, ${gone.state}: the stopped notice offers ${JSON.stringify(buttons)}, not ${JSON.stringify(gone.buttons)}`);
			}
			pass(`${where}: the room's stopped notice for a gone key says the way on and offers ${words.stopped.map((gone) => gone.buttons).join(", then ")}`);

			// Room settings, Model, with no provider ready.
			noProviders = true;
			await enterRoom(page, "Beta Room");
			await page.locator(".topbar-actions").getByRole("button", { name: "Room settings", exact: true }).click();
			await page.locator(".settings-dialog-nav button").filter({ hasText: "Model" }).first().click();
			await page.locator(".room-model-pick:not(:disabled)").first().click();
			const empty = (await page.locator(".room-model-menu-empty").innerText()).trim();
			assert(empty === words.picker, `${where}: the empty Model picker reads ${JSON.stringify(empty)}`);
			await page.keyboard.press("Escape");
			pass(`${where}: the empty Model picker says how a model comes`);

			// Archive or delete names this machine only on this computer, and the folder only for a room with a linked one,
			// the same in the pane and in the Delete question.
			const deleteReads = async (room: string, failRead: boolean, linked: boolean): Promise<void> => {
				await closeSettings(page);
				await enterRoom(page, room);
				noFolderRead = failRead;
				await page.locator(".topbar-actions").getByRole("button", { name: "Room settings", exact: true }).click();
				await page.locator(".settings-dialog-nav button").filter({ hasText: "Archive or delete" }).first().click();
				const dangerZone = page.locator(".room-danger-zone");
				const said = linked ? "are deleted. The folder you linked is not touched. This cannot be undone." : "are deleted. This cannot be undone.";
				await until(async () => (await dangerZone.innerText()).includes("This room holds"), `${where}, ${room}: Archive or delete never showed its counts`);
				if (linked) await until(async () => (await dangerZone.innerText()).includes(said), `${where}, ${room}: Delete never named the folder you linked: ${JSON.stringify(await dangerZone.innerText())}`);
				await settledPage(page);
				const pane = (await dangerZone.innerText()).replace(/\s+/g, " ");
				await dangerZone.getByRole("button", { name: "Delete room", exact: true }).click();
				const dialog = page.getByRole("alertdialog");
				await dialog.waitFor({ timeout: 5000 });
				const question = (await dialog.innerText()).replace(/\s+/g, " ");
				await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
				await dialog.waitFor({ state: "detached", timeout: 5000 });
				noFolderRead = false;
				for (const [part, text] of [["pane", pane], ["question", question]]) {
					assert(text.includes(said) && !text.includes("Your folder on disk") && (linked || !text.includes("folder")), `${where}, ${room}${failRead ? " with its folder unread" : ""}: Delete's ${part} reads ${JSON.stringify(text)}`);
				}
				assert(pane.includes("on this machine") === (who === null), `${where}, ${room}: the pane ${who === null ? "does not name" : "names"} this machine: ${JSON.stringify(pane)}`);
			};
			await deleteReads("Beta Room", false, false);
			await deleteReads("Bash Room", false, who === null);
			if (who === null) await deleteReads("Bash Room", true, false);
			await closeSettings(page);
			pass(`${where}: Archive or delete ${who === null ? "names this machine, and the folder you linked only once it is read and the room has one" : "names no machine or folder of the person's"}`);

			// Home with no model at all: Enter's tooltip, then a room opened by its address.
			noModels = true;
			await page.goto(`${baseUrl}/`);
			await page.waitForLoadState("networkidle");
			const enter = page.locator(".persistent-agent-card").filter({ hasText: "Alpha Room" }).locator("button.landing-action", { hasText: "Enter" });
			await until(async () => (await enter.getAttribute("title")) === words.enter, `${where}: Enter's tooltip reads ${JSON.stringify(await enter.getAttribute("title"))}`);
			await page.goto(`${baseUrl}/#/room/${encodeURIComponent(ids["Alpha Room"])}`);
			await page.reload();
			const opening = page.locator(".home-resume-error");
			await opening.waitFor({ timeout: 10000 });
			assert((await opening.innerText()).trim() === words.opening, `${where}: a room opened by its address reads ${JSON.stringify(await opening.innerText())}`);
			pass(`${where}: with no model, Enter's tooltip and a room opened by its address say how a model comes`);
			await closeContext(context);
		}

		// --- sharedServer: true, the usage address: nothing read before the answer, then the person's own part, and the company's for the admin only ---
		for (const [who, person] of [["a member", MEMBER], ["the admin", ADMIN]] as const) {
			const usage = newUsageStandIn();
			const opened = await openApp(browser, true, (context) => standInUsage(context, usage), { person, signOut: SIGN_OUT_LINK });
			const { context, page, probe, asked } = opened;
			const nav = page.locator(".product-nav button").filter({ hasText: SHARED_USAGE_NAV });
			assert((await nav.count()) === 1 && (await nav.getAttribute("title")) === SHARED_USAGE_NAV_HOVER, `shared usage, ${who}: the sidebar has no ${SHARED_USAGE_NAV} button with its hover text`);
			assert((await page.locator(".product-nav button").filter({ hasText: "Wallet" }).count()) === 0, `shared usage, ${who}: the Wallet button is on the page`);
			await firstLoadOfWalletHeld(opened);
			assert(timesAsked(usage, "mine") === 0 && timesAsked(usage, "company") === 0 && !asked.includes(USAGE_READ), `shared usage, ${who}: usage was read before the page knew the server was shared`);
			assert((await page.locator(".dashboard").innerText()).trim() === "Loading…", `shared usage, ${who}: the page before the answer reads ${JSON.stringify(await page.locator(".dashboard").innerText())}`);
			probe.release();
			await page.locator(".dashboard .kpi").first().waitFor({ timeout: 10000 });
			await settled(opened);
			assert((await page.locator(".dashboard-page .landing-hero h1").innerText()).trim() === SHARED_USAGE_HEADING, `shared usage, ${who}: the heading reads ${JSON.stringify(await page.locator(".dashboard-page .landing-hero h1").innerText())}`);
			assert((await walletLine(page)) === SHARED_USAGE_LINE, `shared usage, ${who}: the line reads ${JSON.stringify(await walletLine(page))}`);
			// What the admin sees is said to members; the admin has the part itself.
			if (person.admin) assert((await page.locator(".dash-footer").count()) === 0, `shared usage, ${who}: the admin is told what the admin sees`);
			else {
				assert((await page.locator(".dash-footer").innerText()).trim() === SHARED_USAGE_FOOTER, `shared usage, ${who}: the footer reads ${JSON.stringify(await page.locator(".dash-footer").innerText())}`);
				// Who else sees a member's usage reads as plainly as the cards' hints.
				const [footerColour, hintColour] = await Promise.all([".dash-footer", ".kpi .hint"].map((sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).color)));
				assert(footerColour === hintColour, `shared usage, ${who}: the footer is ${footerColour}, fainter than the hints' ${hintColour}`);
			}
			// Every room and turn in sight: the earlier rooms' fold and the turn list open.
			await page.locator(".bar-row-fold").click();
			await page.locator(".recent-summary").click();
			await page.locator(".recent-body tbody tr").first().waitFor({ timeout: 10000 });
			const text = await page.locator(".dashboard").innerText();
			assert(!text.includes("$") && !/value|billed|spend/i.test(text), `shared usage, ${who}: the page shows money: ${JSON.stringify(text)}`);
			assert(text.includes(SHARED_USAGE_UNAVAILABLE_ROOM) && !text.includes(GONE_ROOM_ID), `shared usage, ${who}: a room with no name is not shown as ${SHARED_USAGE_UNAVAILABLE_ROOM}, or its id shows`);
			// The own part's choices scope only the own part: the organisation part has its own.
			const hints = (await page.locator(".bar-list-sub").allInnerTexts()).map((line) => line.trim());
			assert(JSON.stringify(hints) === JSON.stringify([SHARED_USAGE_ROOMS_HINT, SHARED_USAGE_MODELS_HINT]), `shared usage, ${who}: the Rooms and Models hints read ${JSON.stringify(hints)}`);
			assert(usage.mine === 1, `shared usage, ${who}: the person's own usage was read ${usage.mine} times`);
			const company = page.locator(".company-usage");
			if (person.admin) {
				await company.locator(".kpi").first().waitFor({ timeout: 10000 });
				assert((await company.locator("h2.company-usage-title").innerText()).trim() === COMPANY_USAGE_TITLE, `shared usage, ${who}: the company part's title reads ${JSON.stringify(await company.locator("h2.company-usage-title").innerText())}`);
				assert((await company.getByText(COMPANY_USAGE_LINE, { exact: true }).count()) === 1, `shared usage, ${who}: the company part's line is missing`);
				// The part's title sits under the page's own title and over the part's chart titles.
				const size = (loc: Locator): Promise<number> => loc.first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
				const sizes = [await size(page.locator(".dashboard-page .landing-hero h1")), await size(company.locator("h2.company-usage-title")), await size(company.locator(".chart-block h2"))];
				assert(sizes[0]! > sizes[1]! && sizes[1]! > sizes[2]!, `shared usage, ${who}: the page, part and chart titles are ${JSON.stringify(sizes)} px`);
				assert((await company.locator(".range-toggle").count()) === 1, `shared usage, ${who}: the company part has no range switch`);
				const csv = company.locator(".export-btn");
				assert((await csv.getAttribute("href")) === "/api/usage/export.csv" && (await csv.getAttribute("title")) === COMPANY_USAGE_CSV_HOVER, `shared usage, ${who}: the company CSV link is wrong`);
				assert(usage.company === 1, `shared usage, ${who}: the company's usage was read ${usage.company} times`);
			} else {
				assert((await company.count()) === 0 && usage.company === 0 && !asked.includes(USAGE_READ), `shared usage, ${who}: a member was shown or asked the company's usage`);
			}
			// Never on a timer: the desktop's Wallet asks again within 5 s; this page waits for the next showing.
			assert(!(await appears(() => usage.mine > 1 || usage.company > (person.admin ? 1 : 0), 6000)), `shared usage, ${who}: usage was read again on a timer`);
			// Coming back to the address asks again, once.
			await page.goto(`${baseUrl}/#/`);
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
			await page.goto(`${baseUrl}/#/dashboard`);
			await until(() => usage.mine === 2, `shared usage, ${who}: coming back to the address did not read the person's usage again`);
			await page.locator(".dashboard .kpi").first().waitFor({ timeout: 10000 });
			await settled(opened);
			pass(`shared: the usage address, for ${who}, reads nothing before the answer, shows the person's own usage with no money, its own hints, and a room with no name by no id${person.admin ? ", and the company's part with its CSV" : ", never the company's"}, and asks again only when shown again`);
			await closeContext(context);
		}

		// --- sharedServer: true, the usage address: a failed read says so; a refused company read takes that part away ---
		{
			const usage = newUsageStandIn();
			usage.mineStatus = 500;
			usage.companyStatus = 403;
			const opened = await openApp(browser, true, (context) => standInUsage(context, usage), { person: ADMIN, signOut: SIGN_OUT_LINK });
			const { context, page } = opened;
			await page.goto(`${baseUrl}/#/dashboard`);
			await page.getByText(SHARED_USAGE_UNREADABLE, { exact: true }).waitFor({ timeout: 10000 });
			await until(() => usage.company === 1, "shared usage, refusals: the admin's page did not ask the company's usage");
			await settled(opened);
			assert((await page.locator(".dashboard .kpi").count()) === 0, "shared usage, refusals: numbers show beside the failed read");
			assert((await page.locator(".company-usage").count()) === 0, "shared usage, refusals: the company part stays after a refusal");
			// Try again asks once more, and an answered read shows the numbers in place of the line.
			usage.mineStatus = 200;
			await page.locator(".usage-unreadable").getByRole("button", { name: "Try again" }).click();
			await page.locator(".dashboard .kpi").first().waitFor({ timeout: 10000 });
			assert(usage.mine === 2 && (await page.getByText(SHARED_USAGE_UNREADABLE, { exact: true }).count()) === 0, `shared usage, refusals: Try again did not read the person's usage once more (${usage.mine} reads)`);
			// The control: the same page with the company's read answered shows that part.
			usage.companyStatus = 200;
			await page.goto(`${baseUrl}/#/`);
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
			await page.goto(`${baseUrl}/#/dashboard`);
			await page.locator(".company-usage .kpi").first().waitFor({ timeout: 10000 });
			assert((await page.getByText(SHARED_USAGE_UNREADABLE, { exact: true }).count()) === 0, "shared usage, refusals: the failure line stays once the reads are answered");
			pass("shared: a failed usage read shows its one line and no numbers with Try again, which reads once more, a refused company read takes the company part away, and answered reads show both");
			await closeContext(context);
		}

		// --- sharedServer: true, the usage address: an organisation with no usage offers nothing to narrow or download ---
		{
			const usage = newUsageStandIn();
			usage.companyAnswer = COMPANY_USAGE_NONE;
			const opened = await openApp(browser, true, (context) => standInUsage(context, usage), { person: ADMIN, signOut: SIGN_OUT_LINK });
			const { context, page } = opened;
			await page.goto(`${baseUrl}/#/dashboard`);
			const company = page.locator(".company-usage");
			await company.getByText(COMPANY_USAGE_EMPTY, { exact: true }).waitFor({ timeout: 10000 });
			await settled(opened);
			const controls = await company.locator(".export-btn, .range-toggle, .model-select").count();
			assert(controls === 0, `shared usage, no company usage: ${controls} controls show beside "${COMPANY_USAGE_EMPTY}"`);
			await closeContext(context);
			// Rows with no model, narrowed to a range that holds none of them: not "no usage", and the range switch stays to widen it again.
			const narrowed = newUsageStandIn();
			narrowed.companyAnswer = (range) => (range === "all" ? COMPANY_USAGE_NO_MODEL : { ...COMPANY_USAGE_NONE, range });
			const again = await openApp(browser, true, (context) => standInUsage(context, narrowed), { person: ADMIN, signOut: SIGN_OUT_LINK });
			await again.page.goto(`${baseUrl}/#/dashboard`);
			const part = again.page.locator(".company-usage");
			await part.locator(".kpi").first().waitFor({ timeout: 10000 });
			const asked = narrowed.company;
			await part.locator(".range-toggle").getByRole("button", { name: "7d", exact: true }).click();
			await until(() => narrowed.company === asked + 1, "shared usage, rows with no model: the 7d range was not asked");
			await settled(again);
			assert((await part.getByText(COMPANY_USAGE_EMPTY, { exact: true }).count()) === 0, `shared usage, rows with no model: a narrowed range says "${COMPANY_USAGE_EMPTY}"`);
			assert((await part.locator(".range-toggle").count()) === 1, "shared usage, rows with no model: the range switch is gone on a narrowed range");
			pass("shared: an organisation with no usage says so and shows no range, model or CSV control; one with usage shows its range switch and CSV (the admin's row above); a narrowed range with no turns keeps its switch and never says there is no usage");
			await closeContext(again.context);
		}

		// --- sharedServer: true, a phone: the turn cards label tokens in and out on the six columns ---
		{
			const usage = newUsageStandIn();
			const opened = await openApp(browser, true, (context) => standInUsage(context, usage), { person: MEMBER, signOut: SIGN_OUT_LINK });
			const { context, page } = opened;
			await page.setViewportSize({ width: 390, height: 800 });
			await page.goto(`${baseUrl}/#/dashboard`);
			await page.locator(".recent-summary").click();
			const cells = page.locator(".recent-body.recent-tokens tbody tr").first().locator("td");
			await cells.first().waitFor({ timeout: 10000 });
			const marks = await cells.evaluateAll((tds) => tds.map((td) => getComputedStyle(td, "::before").content));
			assert(JSON.stringify(marks.slice(4)) === JSON.stringify(['"↑ "', '"↓ "']), `shared usage, phone: the in and out cells are marked ${JSON.stringify(marks)}`);
			assert(marks.slice(0, 4).every((mark) => mark === "none" || mark === "normal"), `shared usage, phone: a cell before the counts is marked ${JSON.stringify(marks)}`);
			assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, "shared usage, phone: the page scrolls sideways");
			const rangeHeights = await page.locator(".range-toggle button").evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().height));
			assert(rangeHeights.length > 0 && rangeHeights.every((h) => h >= 36), `shared usage, phone: a range button is too small to tap: ${JSON.stringify(rangeHeights)}`);
			pass("shared phone: each turn card marks tokens in and out on their own cells, the range buttons take a finger, and the page does not scroll sideways");
			await closeContext(context);
		}

		// --- sharedServer: true, a phone, the person named and no sign-out link: the name takes a row of its own, so every tab shows ---
		{
			const { context, page } = await openApp(browser, true, undefined, { person: MEMBER });
			await page.setViewportSize({ width: 390, height: 800 });
			await page.locator(".product-sidebar-footer .signed-in-as-name").waitFor({ timeout: 10000 });
			const usageTab = page.locator(".product-nav button").filter({ hasText: SHARED_USAGE_NAV });
			assert(await page.locator(".product-sidebar .product-nav").evaluate((node) => node.scrollWidth <= node.clientWidth), "shared phone, no sign-out: the top bar's tabs are cut (the nav has to scroll)");
			const box = await usageTab.boundingBox();
			assert(box !== null && box.x >= 0 && box.x + box.width <= 390, `shared phone, no sign-out: the ${SHARED_USAGE_NAV} tab is off the screen`);
			pass("shared phone: with the person named and no sign-out link, the name takes its own row and every tab shows");
			await closeContext(context);
		}

		// --- sharedServer: true, the first read fails: not knowing is not this computer, so still no usage read ---
		{
			const usage = newUsageStandIn();
			const opened = await openApp(browser, true, (context) => standInUsage(context, usage), { person: MEMBER, signOut: SIGN_OUT_LINK });
			const { context, page, probe, asked, reads } = opened;
			await page.goto("about:blank");
			probe.fail = true;
			asked.length = 0;
			usage.mine = 0;
			const before = reads();
			await page.goto(`${baseUrl}/#/dashboard`);
			await page.locator(".dashboard").waitFor({ timeout: 10000 });
			await settled(opened);
			assert(timesAsked(usage, "mine") === 0 && !asked.includes(USAGE_READ), "shared usage, a failed first read: the page read usage");
			await until(() => reads() >= before + 2, "shared usage, a failed first read: the page did not ask client-context again");
			await settled(opened);
			assert(timesAsked(usage, "mine") === 0 && !asked.includes(USAGE_READ), "shared usage, a failed first read: the page read usage while it asked again");
			assert((await page.locator(".dashboard").innerText()).trim() === "Loading…", `shared usage, a failed first read: the page reads ${JSON.stringify(await page.locator(".dashboard").innerText())}`);
			probe.fail = false;
			await page.locator(".dashboard .kpi").first().waitFor({ timeout: 20000 });
			await settled(opened);
			assert(usage.mine === 1 && !asked.includes(USAGE_READ), "shared usage, a failed first read: once the answer came the page read the Wallet's usage, or its own not once");
			pass("shared: after a failed first read the usage address reads no usage, asks again, and shows the person's own usage once the answer comes");
			await closeContext(context);
		}

		// --- sharedServer: false, the Wallet's address: the neighbour of the rows above, through the same count ---
		{
			const opened = await openApp(browser, false);
			const { context, page, probe, asked } = opened;
			await firstLoadOfWalletHeld(opened);
			assert(!asked.includes(USAGE_READ), "this computer's Wallet: usage was read before the page knew which server this is");
			probe.release();
			await page.locator(".dashboard .export-btn").waitFor({ timeout: 10000 });
			assert(asked.includes(USAGE_READ), "this computer's Wallet: the Wallet shows, but its read was not counted: the shared rows prove nothing");
			assert((await page.getByText(SHARED_USAGE_FOOTER, { exact: true }).count()) === 0, "this computer's Wallet: the shared server's footer is shown");
			for (const hint of [SHARED_USAGE_ROOMS_HINT, SHARED_USAGE_MODELS_HINT]) assert((await page.getByText(hint, { exact: true }).count()) === 0, `this computer's Wallet: the shared server's hint "${hint}" is shown`);
			assert((await walletLine(page)) === "What your exxperts cost, locally measured.", `this computer's Wallet: the line reads ${JSON.stringify(await walletLine(page))}`);
			await closeContext(context);
			// A failed read holds the Wallet back here too, and the next answer opens it.
			const failed = await openApp(browser, false);
			await failed.page.goto("about:blank");
			failed.probe.fail = true;
			failed.asked.length = 0;
			await failed.page.goto(`${baseUrl}/#/dashboard`);
			await failed.page.locator(".dashboard").waitFor({ timeout: 10000 });
			await settled(failed);
			assert(!failed.asked.includes(USAGE_READ), "this computer's Wallet: usage was read after a failed read of client-context");
			failed.probe.fail = false;
			await failed.page.locator(".dashboard .export-btn").waitFor({ timeout: 20000 });
			assert(failed.asked.includes(USAGE_READ), "this computer's Wallet: the Wallet shows after the failed read, but its read was not counted");
			await closeContext(failed.context);
			pass("this computer: the Wallet waits for the answer, then reads usage and shows, and after a failed read the next answer opens it");
		}

		// --- sharedServer: false, every control as today ---
		{
			const { context, page } = await openApp(browser, false);
			assert(JSON.stringify(await cardOrder(page)) === JSON.stringify(Z_TO_A), `this computer: Home does not use the saved order: ${await cardOrder(page)}`);
			assert((await page.locator(".room-sort").count()) === 1, "this computer: the sort control is missing");
			assert((await page.locator(".product-nav button").filter({ hasText: "Wallet" }).count()) === 1, "this computer: the Wallet button is missing");

			await openSettings(page);
			assert((await tabCount(page, "Remote access")) === 1, "this computer: Remote access is missing");
			assert((await tabCount(page, "Profiles")) === 1, "this computer: Profiles is missing");
			await openTab(page, "AI setup");
			assert((await page.locator(".settings-overlay .add-provider-toggle").count()) === 1, "this computer: Add provider is missing");
			assert((await page.locator(".settings-overlay .ai-defaults-group .room-model-pick:not(:disabled)").count()) === 2, "this computer: the default models cannot be changed");
			await openTab(page, "Web search");
			assert((await page.locator('.settings-overlay input[type="checkbox"]').count()) > 0, "this computer: web search cannot be changed");
			await openTab(page, "Instructions");
			assert((await page.locator(".settings-overlay .room-instructions-textarea[readonly]").count()) === 0, "this computer: the instructions are read-only");
			assert((await countText(page, ".settings-overlay", DESKTOP_INSTRUCTIONS_HEAD)) === 1, "this computer: the instructions' head line changed");
			// Save and Discard appear once the text changes; Discard puts the box back.
			const instructionsBox = page.locator(".settings-overlay .room-instructions-textarea");
			await instructionsBox.fill(`${await instructionsBox.inputValue()} Edited.`);
			const instructionsButton = (name: string) => page.locator(".settings-overlay .room-instructions-section button").filter({ hasText: new RegExp(`^${name}$`) });
			await instructionsButton("Save").waitFor({ timeout: 5_000 }).catch(() => {});
			assert((await instructionsButton("Save").count()) === 1 && (await instructionsButton("Discard").count()) === 1, "this computer: Save is missing");
			await instructionsButton("Discard").click();
			await instructionsButton("Save").waitFor({ state: "detached", timeout: 5_000 });
			await openTab(page, "Connectors");
			assert((await page.locator(".settings-overlay .connector-dir-search").count()) === 1, "this computer: the connector directory is missing");
			await openTab(page, "Skills");
			await page.locator(".settings-overlay .skill-row").first().waitFor({ timeout: 10000 });
			assert((await countText(page, ".settings-overlay", SKILL_FILES_NOTE)) === 0, "this computer: the library still says a skill's files run only where you allow them");
			await page.locator(".settings-overlay .pane-head-actions button").filter({ hasText: /^Add skill$/ }).click();
			assert((await page.locator(".skill-add-menu [role=menuitem]").filter({ hasText: ADD_SKILL_WAYS.repository }).count()) === 1, "this computer: adding from a repository is missing");
			assert((await page.locator(".skill-add-menu [role=menuitem]").filter({ hasText: ADD_SKILL_WAYS.featured }).count()) === 1, "this computer: Browse featured is missing");
			await page.keyboard.press("Escape");
			assert((await page.locator(".settings-overlay").getByText(SHARED_LINE, { exact: true }).count()) === 0, "this computer: the shared-server line is shown");
			await closeSettings(page);
			pass("this computer: the sort control, Wallet, Remote access, Profiles and every setting control are there, with no shared-server line");

			await enterRoom(page, "Bash Room");
			assert((await page.locator(".bash-mode-chip").count()) === 1, "this computer: the Bash chip is missing");
			await openRoomWorkspace(page);
			const folderPane = page.locator(".room-workspace-section");
			await folderPane.getByRole("switch", { name: COMMANDS, exact: true }).waitFor({ timeout: 10_000 });
			assert((await folderPane.getByRole("switch", { name: CAN_CHANGE_FILES, exact: true }).count()) === 1, "this computer: Can change files is missing");
			assert((await folderPane.getByRole("button", { name: STOP_USING_FOLDER }).count()) === 1 && (await folderPane.getByRole("button", { name: CHANGE_FOLDER }).count()) === 1, "this computer: Change folder or Stop using is missing");
			await closeSettings(page);
			await enterRoom(page, "Alpha Room");
			await openRoomWorkspace(page);
			assert((await page.locator(".room-workspace-section button").filter({ hasText: "Choose folder" }).count()) === 1, "this computer: Choose folder is missing");
			assert((await countText(page, ".room-workspace-section", NO_FOLDER_LINE)) === 0, "this computer: the shared-server folder line is shown");
			await closeSettings(page);
			await openShelfFile(page);
			assert((await page.locator(".artifact-viewer-quiet").filter({ hasText: /^\s*Save\s*$/ }).count()) === 1, "this computer: Save is missing");
			pass("this computer: rooms offer the Bash chip, the Folder pane's controls, Choose folder and Save");
			await closeContext(context);
		}
	} finally {
		await closeBrowser(browser);
	}

	console.log("shared-server-page smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
