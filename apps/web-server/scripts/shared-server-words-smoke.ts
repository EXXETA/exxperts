// The words a shared server shows where the desktop's would be false there:
// no "your machine", no "sign in", no "your account", and no setting a member
// can't reach. Each line is read first as the desktop shows it, unchanged,
// then as a shared server shows it, for a member and for the admin where the
// two differ. No server, no browser: the sentences and the page's lines are
// plain functions. The memory cards and a scheduled run's reason learn they
// are on a shared server the way the page does, from its client-context read;
// the components' sentence builders are handed what the component passes
// (its shared-server flag or role), and the pictures show the screens. A
// failed answer is drawn whole, with the page's own client-context read: a
// member sees no Details, the admin, in a process of its own (the page learns
// who it is once), keeps them.
//
// Run alone, from the repo root:
//   node --import tsx/esm apps/web-server/scripts/shared-server-words-smoke.ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import webSearchExtension from "../../../pi-package/extensions/web-search/index.js";
import { modelUnreachableSentence } from "../src/model-call-causes.js";
import { roomModelUnavailableSentence } from "../src/room-models.js";
import { registerServerHooks } from "../src/server-hooks.js";
import { absorbRunPausedSentence, reviewRunPausedSentence } from "../../web-ui/src/memory-v2-copy.js";
import { fetchRemoteClientContext } from "../../web-ui/src/remote-client-context.js";
import { formatFriendlyRunReason, runShownStatus } from "../../web-ui/src/scheduled-run-reason.js";
import { failureLine, failureLineText, NOT_SENT_AGAIN, turnFailureLine, type TurnFailure } from "../../web-ui/src/turn-failure-line.js";

const failures: string[] = [];
function same(got: unknown, want: unknown, label: string): void {
	if (got !== want) failures.push(`${label}:\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
}

// The page's components, loaded with the page's own React.
const pageRequire = createRequire(new URL("../../web-ui/package.json", import.meta.url));
(globalThis as { React?: unknown }).React = pageRequire("react");
const component = (file: string) => import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../web-ui/src/components/${file}`)).href) as Promise<Record<string, any>>;
// Read optionally, so a build without one fails each of its rows by name.
const named = async (file: string, name: string) => ((await component(file))[name] ?? (() => `(no ${name} in ${file})`)) as (...args: any[]) => any;
const formatRunStatus = await named("RoomScheduledTasksSection.tsx", "formatRunStatus");
const deriveScheduleState = await named("RoomScheduledTasksSection.tsx", "deriveScheduleState");
const unavailableSentence = await named("RoomModelSection.tsx", "unavailableSentence");
const defaultUnavailableSentence = await named("ai-defaults-group.tsx", "defaultUnavailableSentence");
const conversationPanelCaption = await named("Memory.tsx", "conversationPanelCaption");
const connectCardHeading = await named("launcher-room-card.tsx", "connectCardHeading");
const Message = (await component("Message.tsx")).Message;
const { createElement } = pageRequire("react");
const { renderToStaticMarkup } = pageRequire("react-dom/server");

const sol = { provider: "openai-codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol", name: "GPT-6.1 Sol", providerLabel: "ChatGPT" };
const roomRow = (reason: "signed-out" | "not-offered", source: "room" | "default") => ({ stored: source === "room" ? sol : null, chosen: sol, effective: null, source, reason });
const defaultsRow = (reason: "signed-out" | "not-offered") => ({ stored: sol, chosen: sol, effective: null, source: "default", reason });
const onceJob = { id: "job-1", name: "Morning report", type: "once", schedule: "2026-11-20T08:00:00.000Z", enabled: true, nextRunAt: "2026-11-20T08:00:00.000Z" };
const pausedRun = { status: "blocked", reason: "owner_paused", message: "Did not run." };
const blockedRun = { status: "blocked", reason: "model_not_found" };
const notOnAccountRun = { status: "blocked", reason: "model_not_on_account", target: { model: { provider: "openai-codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol" } } };
// The Memory notice names a local model by its id, as the app shows it.
const llama = { provider: "ollama", model: "llama3" };
const roomNames = { model: () => "GPT-6.1 Sol", provider: () => "ChatGPT" };

// A failed answer as the chat draws it, with the provider's own words kept for Details; `newest`: drawn in full with its buttons, else folded.
const PROVIDER_SAID = "Rate limit reached for gpt-6.1-sol in organization org-4711 on requests per min.";
const noop = () => {};
// `wayOn`: the line's way on once the page replaced it, as after a Try again that could not send the message again whole.
function failedAnswerShown(shared: boolean, newest: boolean, failure: TurnFailure = "other", wayOn?: string): string {
	const parts = turnFailureLine("GPT-6.1 Sol", failure, "openai-codex", undefined, shared);
	const item = { kind: "system", id: "failed-1", level: "error", failure, provider: "openai-codex", details: PROVIDER_SAID, detailsFrom: "ChatGPT", ...failureLine(wayOn === undefined ? parts : { ...parts, wayOn }, "lost") };
	const failureActions = { shared, reviewsMemory: false, tryAgainUnavailable: false, onTryAgain: noop, onReviewMemory: noop, onChooseModel: noop, onReplaceKey: noop, onOpenAiSetup: noop };
	// React warns that the row's layout effect does nothing outside a browser: true, and beside the point here.
	const realError = console.error;
	console.error = (...args: unknown[]) => { if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) realError(...args); };
	try { return renderToStaticMarkup(createElement(Message, { item, newestFailure: newest, failureActions })) as string; } finally { console.error = realError; }
}
// Every cause a failed answer can carry, each with a way on of its own: a member who no longer sees Details still reads what to do.
const TURN_FAILURES: TurnFailure[] = ["quota", "region-or-plan", "gateway-refused", "gateway-not-found", "still-busy", "connection", "local-connection", "refused", "cut-off", "too-large", "request-size", "overflow", "empty-answer", "signed-out", "not-offered", "other"];

// The web search tool as a room's session registers it, against a state folder whose setting has search off.
const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-shared-words-"));
const savedStateHome = process.env.EXXPERTS_STATE_HOME;
const savedProvider = process.env.EXXETA_SEARCH_PROVIDER;
process.on("exit", () => fs.rmSync(stateHome, { recursive: true, force: true }));
process.env.EXXPERTS_STATE_HOME = stateHome;
delete process.env.EXXETA_SEARCH_PROVIDER;
fs.mkdirSync(path.join(stateHome, ".exxperts", "app"), { recursive: true });
fs.writeFileSync(path.join(stateHome, ".exxperts", "app", "web-search.json"), `${JSON.stringify({ provider: "disabled" })}\n`);
async function searchTool(): Promise<{ description: string; offText: string }> {
	let tool: any;
	webSearchExtension({ registerTool: (definition: unknown) => { tool = definition; } } as never);
	const answer = await tool.execute("smoke", { query: "weather" });
	return { description: tool.description, offText: answer?.content?.[0]?.text };
}

if (process.env.SHARED_SERVER_WORDS_AS === "admin") {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ remote: false, capability: "full", sharedServer: true, person: { id: "p-admin", name: "Ada", admin: true } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
	try { await fetchRemoteClientContext(); } finally { globalThis.fetch = realFetch; }
	same(failedAnswerShown(true, true).includes("Show details") && failedAnswerShown(true, true).includes(PROVIDER_SAID), true, "S8 the admin's failed answer shows Details with the provider's words");
	same(failedAnswerShown(true, false).includes(">Details<"), true, "S8 the admin's folded failed answer keeps Details");
	same(failedAnswerShown(true, true).includes("Nothing was lost. Try again; if it repeats, choose another model."), true, "S8 the admin's plain failed answer keeps its way on");
	if (failures.length > 0) throw new Error(`shared server words, as the admin:\n  ${failures.join("\n  ")}`);
	console.log("admin rows: ok");
	process.exit(0);
}

// --- On the desktop: today's words, exactly ----------------------------------------
{
	same(formatRunStatus(runShownStatus(blockedRun as never, true)), "Blocked", "D1d a blocked run's status");
	same(JSON.stringify(deriveScheduleState(onceJob, blockedRun)), JSON.stringify({ label: "Blocked", tone: "danger" }), "D1d a one-off task blocked");
	same(unavailableSentence(roomRow("signed-out", "default"), "conversation", false), "The default, GPT-6.1 Sol on ChatGPT, is signed out. This room waits until you sign in again or choose another model.", "D2b Room settings, Model, the default signed out");
	same(unavailableSentence(roomRow("signed-out", "room"), "memory", false), "GPT-6.1 Sol on ChatGPT is signed out. This room waits until you sign in again or choose another model.", "D2b Room settings, Model, the room's own Memory model signed out");
	same(defaultUnavailableSentence(defaultsRow("signed-out"), false), "GPT-6.1 Sol on ChatGPT is signed out. Rooms on this default wait until you sign in again or choose another here.", "D2c AI setup's default signed out");
	same(defaultUnavailableSentence(defaultsRow("not-offered"), false), "GPT-6.1 Sol on ChatGPT is no longer offered. Rooms on this default wait until you choose another here.", "D2c AI setup's default no longer offered");
	same(roomModelUnavailableSentence(sol, "not-offered", "memory", roomNames as never, "defaults"), "The default memory model, GPT-6.1 Sol on ChatGPT, is no longer offered. Choose another default in Settings, AI setup.", "D2 the Memory page chat, the memory default no longer offered");
	same(formatFriendlyRunReason(notOnAccountRun as never, true), "GPT-6.1 Sol isn't available on your ChatGPT account. Choose another model in Room settings, Model.", "D7a a scheduled run's reason, the model not on the account");
	same(absorbRunPausedSentence("GPT-6.1 Sol", "signed-out", "openai-codex"), "GPT-6.1 Sol's provider is signed out. Nothing was lost.", "D7b Memorize paused, signed out");
	same(absorbRunPausedSentence("GPT-6.1 Sol", "not-on-account", "openai-codex"), "GPT-6.1 Sol isn't available on your ChatGPT account. Nothing was lost.", "D7b Memorize paused, not on the account");
	same(reviewRunPausedSentence("GPT-6.1 Sol", { cause: "signed-out", model: { provider: "openai-codex" } }, false), "GPT-6.1 Sol's provider is signed out. Nothing was lost.", "D7b Review paused, signed out");
	same(absorbRunPausedSentence("Llama 3", "not-answering", "ollama", undefined, "local-connection"), "Llama 3 could not be reached on this computer. Nothing was lost. Check that the app running it is open, then try again.", "D7d Memorize paused, a model at a local address");
	same(failureLineText(turnFailureLine("Llama 3", "local-connection", "ollama"), "lost"), "Llama 3 could not be reached on this computer. Nothing was lost. Check that the app running it is open, then try again.", "D7d the chat's line, a model at a local address");
	same(modelUnreachableSentence("not-answering", llama, undefined, "local-connection"), "Llama3 could not be reached on this computer. Nothing was lost. Check that the app running it is open, then try again.", "D7d the Memory notice, a model at a local address");
	same(conversationPanelCaption("Kickoff", false), "The conversation \"Kickoff\" was saved from, as stored on your machine. Read-only.", "D7e the Memory page's conversation panel");
	same(failedAnswerShown(false, true).includes("Show details") && failedAnswerShown(false, true).includes(PROVIDER_SAID), true, "D8 a failed answer shows Details with the provider's words");
	same(failedAnswerShown(false, false).includes(">Details<"), true, "D8 a folded failed answer keeps Details");
	same(failedAnswerShown(false, true).includes("Nothing was lost. Try again; if it repeats, choose another model."), true, "D8 a failed answer's plain line keeps its way on");
	const search = await searchTool();
	same(search.offText, "Web search is switched off in AI setup under Web search. Turn it back on there to use it.", "D5 what the model reads with search off");
	same(search.description, "Search the public web. Works out of the box (DuckDuckGo); a local SearXNG instance is used instead when one is configured (optional, for heavier use).", "D5b the tool's description with search off");
}

// --- The page on a shared server, as a member ------------------------------------------
{
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ remote: false, capability: "full", sharedServer: true, person: { id: "p-member", name: "Mia", admin: false } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
	try { await fetchRemoteClientContext(); } finally { globalThis.fetch = realFetch; }

	same(formatRunStatus(runShownStatus(pausedRun as never, true)), "Paused", "S1d a repeating task's paused run's status");
	same(formatRunStatus(runShownStatus(pausedRun as never, false)), "Blocked", "S1d a one-off task's paused run keeps today's status");
	same(JSON.stringify(deriveScheduleState(onceJob, pausedRun)), JSON.stringify({ label: "Blocked", tone: "danger" }), "S1d a one-off task paused keeps today's status and tone");
	same(JSON.stringify(deriveScheduleState(onceJob, blockedRun)), JSON.stringify({ label: "Blocked", tone: "danger" }), "S1d a one-off task blocked for another reason stays blocked");
	same(formatFriendlyRunReason(pausedRun as never, true), "Did not run.", "S1 a paused run's line is the server's own sentence");
	same(unavailableSentence(roomRow("signed-out", "default"), "conversation", true), "The default, GPT-6.1 Sol on ChatGPT, isn't available on this server. This room waits until you choose another model, or your admin adds one.", "S2b Room settings, Model, the default signed out");
	same(unavailableSentence(roomRow("signed-out", "room"), "memory", true), "GPT-6.1 Sol on ChatGPT isn't available on this server. This room waits until you choose another Memory model, or your admin adds one.", "S2b Room settings, Model, the room's own Memory model signed out");
	same(unavailableSentence(roomRow("not-offered", "default"), "conversation", true), "The default, GPT-6.1 Sol on ChatGPT, is no longer offered. This room waits until you choose another model.", "S2b Room settings, Model, the default no longer offered, as on the desktop");
	same(defaultUnavailableSentence(defaultsRow("signed-out"), true), "GPT-6.1 Sol on ChatGPT isn't available on this server. Rooms on this default wait until your admin chooses another.", "S2c AI setup's default signed out, as a member");
	same(defaultUnavailableSentence(defaultsRow("not-offered"), true), "GPT-6.1 Sol on ChatGPT is no longer offered. Rooms on this default wait until your admin chooses another.", "S2c AI setup's default no longer offered, as a member");
	same(formatFriendlyRunReason(notOnAccountRun as never, true), "GPT-6.1 Sol isn't available on this server's ChatGPT account. Choose another model in Room settings, Model.", "S7a a scheduled run's reason, the model not on the account");
	same(absorbRunPausedSentence("GPT-6.1 Sol", "signed-out", "openai-codex"), "GPT-6.1 Sol's provider isn't available on this server. Nothing was lost.", "S7b Memorize paused, signed out");
	same(absorbRunPausedSentence("GPT-6.1 Sol", "not-on-account", "openai-codex"), "GPT-6.1 Sol isn't available on this server's ChatGPT account. Nothing was lost.", "S7b Memorize paused, not on the account");
	same(reviewRunPausedSentence("GPT-6.1 Sol", { cause: "signed-out", model: { provider: "openai-codex" } }, false), "GPT-6.1 Sol's provider isn't available on this server. Nothing was lost.", "S7b Review paused, signed out");
	same(absorbRunPausedSentence("Llama 3", "not-answering", "ollama", undefined, "local-connection"), "Llama 3 could not be reached. Nothing was lost. Try again, and tell your admin if it keeps failing.", "S7d Memorize paused, a model at a local address");
	same(failureLineText(turnFailureLine("Llama 3", "local-connection", "ollama", undefined, true), "lost"), "Llama 3 could not be reached. Nothing was lost. Try again, and tell your admin if it keeps failing.", "S7d the chat's line, a model at a local address");
	same(conversationPanelCaption("Kickoff", true), "The conversation \"Kickoff\" was saved from, as stored on this server. Read-only.", "S7e the Memory page's conversation panel");
	for (const newest of [true, false]) {
		const shown = failedAnswerShown(true, newest);
		same(/Details|Show details/.test(shown) || shown.includes(PROVIDER_SAID), false, `S8 a member's ${newest ? "newest" : "folded"} failed answer has no Details and none of the provider's words`);
		same(shown.includes("GPT-6.1 Sol could not answer this message."), true, `S8 a member's ${newest ? "newest" : "folded"} failed answer keeps its line`);
	}
	same(failedAnswerShown(true, true).includes("Nothing was lost. Try again, and tell your admin if it keeps failing."), true, "S8 a member's plain failed answer, its cause behind Details, sends them to the admin");
	same(failedAnswerShown(true, true).includes("choose another model."), false, "S8 a member's plain failed answer no longer guesses at another model in its words (its Choose another model button stays)");
	const notSentAgain = failedAnswerShown(true, true, "other", NOT_SENT_AGAIN);
	// The page writes an apostrophe as &#x27;.
	same(notSentAgain.includes(NOT_SENT_AGAIN.replaceAll("'", "&#x27;")) && !notSentAgain.includes("tell your admin"), true, "S8 a member's plain failed answer that can't be sent again keeps saying so");
	same(failedAnswerShown(true, true, "refused").includes("You can reword it, or choose another model"), true, "S8 a member's failed answer with a cause of its own keeps its way on");
	for (const failure of TURN_FAILURES) same(typeof turnFailureLine("GPT-6.1 Sol", failure, "openai-codex", undefined, true).wayOn, "string", `S8 a failed answer's line on a shared server says what to do: ${failure}`);
}

// --- The page on a shared server, as its admin: in a process of its own, since the page learns who it is once ---
{
	const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, SHARED_SERVER_WORDS_AS: "admin" }, encoding: "utf8" });
	same(child.status === 0 ? child.stdout.trim() : `${child.stdout}${child.stderr}`, "admin rows: ok", "S8 the admin's rows");
}

// --- The server, once a shared server's entry has registered -------------------------------
registerServerHooks({});
{
	same(roomModelUnavailableSentence(sol, "not-offered", "memory", roomNames as never, "defaults"), "The default memory model, GPT-6.1 Sol on ChatGPT, is no longer offered. Your admin can choose another in AI setup.", "S2 the Memory page chat, the memory default no longer offered");
	same(roomModelUnavailableSentence(sol, "not-offered", "memory", roomNames as never, "room"), "This room's memory model, GPT-6.1 Sol on ChatGPT, is no longer offered. Choose another Memory model in Room settings, Model.", "S2 a room's own Memory model no longer offered keeps its way on");
	same(modelUnreachableSentence("not-answering", llama, undefined, "local-connection"), "Llama3 could not be reached. Nothing was lost. Try again, and tell your admin if it keeps failing.", "S7d the Memory notice, a model at a local address");
	const search = await searchTool();
	same(search.offText, "Web search is off on this server. Your admin can turn it on under Web search.", "S5 what the model reads with search off");
	same(search.description, "Search the public web.", "S5b the tool's description with search off");
	fs.writeFileSync(path.join(stateHome, ".exxperts", "app", "web-search.json"), `${JSON.stringify({ provider: "duckduckgo" })}\n`);
	same((await searchToolDescription()), "Search the public web. Works out of the box (DuckDuckGo); a local SearXNG instance is used instead when one is configured (optional, for heavier use).", "S5b the tool's description with search on");
}

async function searchToolDescription(): Promise<string> {
	let tool: any;
	webSearchExtension({ registerTool: (definition: unknown) => { tool = definition; } } as never);
	return tool.description;
}

// --- Empty Home's heading, by who reads it ---
{
	same(connectCardHeading(null), "Connect an AI to get started", "D6b empty Home's heading on the desktop");
	same(connectCardHeading("member"), "No AI is set up yet", "S6b empty Home's heading on a shared server, as a member");
	same(connectCardHeading("admin"), "Connect an AI to get started", "S6b empty Home's heading on a shared server, as the admin");
}

if (savedStateHome === undefined) delete process.env.EXXPERTS_STATE_HOME;
else process.env.EXXPERTS_STATE_HOME = savedStateHome;
if (savedProvider !== undefined) process.env.EXXETA_SEARCH_PROVIDER = savedProvider;
if (failures.length > 0) throw new Error(`shared server words:\n  ${failures.join("\n  ")}`);
console.log("shared-server-words smoke: ok");
