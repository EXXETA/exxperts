// A saved gateway's bare 404 (a company's, or a model server on this
// computer): one look at the gateway's /models, with the room's address and
// key, says which of three things happened, and the line says it. The model
// is no longer listed (Choose another model), the list itself is not found at
// the saved address (AI setup), or the model is listed and still failed (Try
// again); a list that cannot be read names the gateway and AI setup. On a
// shared server each line ends with the admin, with no AI setup button. A
// built-in provider's 404 stays "no longer offered". One read serves every
// call to that gateway for a while, Memory model calls included, and reads
// /models alone. Only the outcome travels: never the gateway's own words.
// The Memory model's notice and cards, a real Memorize's stop (from its
// patient call or its own probe), and a message handed back, say the same
// lines. Pure reads in a throwaway HOME with four gateways saved and one
// local endpoint.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const failures: string[] = [];
function check(condition: unknown, message: string): void {
	if (!condition) failures.push(message);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-gateway-404-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXPERTS_CODING_AGENT_DIR: path.join(home, ".exxperts", "agent"), EXXETA_PERSISTENT_AGENTS_ROOT: path.join(home, ".exxperts", "app", "personalized-agents") });
delete process.env.EXXPERTS_STATE_HOME;
delete process.env.EXXPERTS_DATA_DIR;
const appDir = path.join(home, ".exxperts", "app");
const agentDir = path.join(home, ".exxperts", "agent");
for (const dir of [appDir, agentDir]) fs.mkdirSync(dir, { recursive: true });

// The gateway's own words for a refused list: they must never reach a line, a frame or a notice.
const GATEWAY_WORDS = "Shh internal-route-9 for tenant 42";
const MODEL = "acme-model";
// Each gateway's /models: another model only, not found, the model listed, or refused with its own words.
const KINDS = ["gone", "address", "listed", "unread"] as const;
const hits = new Map<string, number>();
const endpoint = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		const url = req.url ?? "";
		hits.set(url, (hits.get(url) ?? 0) + 1);
		const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
		if (req.method === "POST") return json(404, undefined);
		if (url === "/gone/v1/models") return json(200, { object: "list", data: [{ object: "model", id: "other-model" }] });
		if (url === "/listed/v1/models") return json(200, { object: "list", data: [{ object: "model", id: MODEL }] });
		if (url === "/unread/v1/models") return json(401, { error: { message: GATEWAY_WORDS } });
		return json(404, undefined);
	});
});
await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
const label = (kind: string) => `${kind[0]!.toUpperCase()}${kind.slice(1)} gateway`;
fs.writeFileSync(path.join(appDir, "openai-compatible-gateways.json"), JSON.stringify({
	version: 1,
	gateways: KINDS.map((kind) => ({ id: `gw-${kind}`, providerId: `gw-${kind}`, label: label(kind), baseUrl: `${base}/${kind}/v1`, roomModels: [{ modelId: MODEL, label: "Acme Model" }], maintenanceModel: MODEL })),
}, null, 2));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(Object.fromEntries(KINDS.map((kind) => [`gw-${kind}`, { type: "api_key", key: `made-up-${kind}-key` }])), null, 2), { mode: 0o600 });

try {
	const causes = await import("../src/model-call-causes.js");
	const lines = await import("../../web-ui/src/turn-failure-line.js");
	const copy = await import("../../web-ui/src/memory-v2-copy.js");
	const { forgetGatewayModelFind, gatewayModelFind } = await import("../src/gateway-model-find.js");
	const { stepBackFromFailedPrompt } = await import("../src/failed-prompt-step-back.js");
	const { complete } = await import("@exxeta/exxperts-ai");

	// A bare 404, through the runtime as a room's call goes: its status is the cause, read with the provider.
	const model = { id: MODEL, name: "Acme Model", api: "openai-completions", provider: "gw-gone", baseUrl: `${base}/chat-call/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
	const answer = await complete(model as never, { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] }, { apiKey: "made-up-key" });
	const words = String(answer.errorMessage ?? "");
	const codes = { errorStatus: (answer as { errorStatus?: number }).errorStatus };
	const turn404 = (provider: string) => causes.turnFailureOf(words, false, provider, false, codes);
	check(codes.errorStatus === 404, `the runtime keeps the 404, got ${JSON.stringify({ words, codes })}`);
	check(turn404("gw-gone") === "gateway-not-found", `a gateway's bare 404 is its own cause, got ${turn404("gw-gone")}`);
	check(turn404("openai") === "not-offered", `a built-in provider's bare 404 still reads no longer offered, got ${turn404("openai")}`);
	check(causes.providerFailureLogFields(causes.failedMessageError(words, codes), "gw-gone")?.cause === "unreachable:gateway-not-found", "the log line reads a gateway's bare 404 the same way");

	// One look at each gateway's list.
	const expected = { gone: "model-gone", address: "address", listed: "model-listed", unread: "unread" } as const;
	for (const kind of KINDS) {
		const find = await gatewayModelFind(`gw-${kind}`, MODEL);
		check(find === expected[kind], `${kind}: the list says ${expected[kind]}, got ${find}`);
	}
	check(await gatewayModelFind("openai", MODEL) === "unread", "a provider that is no saved gateway is never looked up");
	// Two failures in a row read the list once; /models alone is read, never /model/info.
	await gatewayModelFind("gw-gone", MODEL);
	check(hits.get("/gone/v1/models") === 1, `two failures in a row read the list once, got ${hits.get("/gone/v1/models")}`);
	check(![...hits.keys()].some((url) => url.includes("/model/info")), `only /models is read, got ${JSON.stringify([...hits.keys()])}`);

	// The chat's four lines on this computer, and their buttons.
	const call = lines as unknown as Record<string, (...args: unknown[]) => any>;
	const chatLine = (kind: (typeof KINDS)[number], shared: boolean) => lines.failureLineText(call.turnFailureLine("Acme Model", "gateway-not-found", `gw-${kind}`, undefined, shared, label(kind), expected[kind]), "above");
	const LINES = {
		gone: "Gone gateway no longer has Acme Model. Your message is still above. Choose one of its current models.",
		address: "Address gateway isn't answering at its saved address. Your message is still above. Check the address in AI setup.",
		listed: "Listed gateway lists Acme Model but couldn't run it. Your message is still above. Try again later, or tell whoever runs the gateway.",
		unread: "Unread gateway could not find Acme Model. Your message is still above. Check the gateway in AI setup.",
	};
	const BUTTONS = { gone: "chooseModel", address: "aiSetup", listed: "tryAgain", unread: "aiSetup" };
	const shownButtons = (kind: (typeof KINDS)[number], shared: boolean) => Object.entries(call.failureButtons("gateway-not-found", undefined, shared, expected[kind])).filter(([, on]) => on).map(([name]) => name).join("|");
	for (const kind of KINDS) {
		check(chatLine(kind, false) === LINES[kind], `${kind}: the chat's line, got "${chatLine(kind, false)}"`);
		check(shownButtons(kind, false) === BUTTONS[kind], `${kind}: the chat's button, got "${shownButtons(kind, false)}"`);
	}
	check(lines.failureLineWords("Check the address in AI setup.", call.failureButtons("gateway-not-found", undefined, false, "address")) === "Check the address.", "AI setup's button takes the place of where it is");
	check(shownButtons("unread", false) === "aiSetup" && call.failureButtons("gateway-not-found", undefined, false).aiSetup === true, "before the look, the line offers AI setup");

	// The Memory model on a gateway: the same words on the notice and the cards, from the same read.
	const memoryCall = async (kind: string) => {
		try {
			await causes.callWithPatience(async () => { throw causes.failedMessageError(words, codes); }, { model: { provider: `gw-${kind}`, model: MODEL, label: "Acme Model" }, sleep: async () => {} });
		} catch (error) {
			return error as { message?: string; details?: Record<string, unknown> };
		}
		return undefined;
	};
	const gone = await memoryCall("gone");
	check(gone?.details?.detail === "gateway-not-found" && gone.details.gatewayFind === "model-gone", `the Memory notice carries the cause and what the list said, got ${JSON.stringify(gone?.details)}`);
	check(gone?.message === "Gone gateway no longer has Acme Model. Nothing was lost. Choose one of its current models.", `the Memory notice's sentence, got "${gone?.message}"`);
	check(hits.get("/gone/v1/models") === 1, `a Memory model call after the chat's reuses the read, got ${hits.get("/gone/v1/models")}`);
	// A key or address saved again for that gateway: its next failure reads the list again.
	forgetGatewayModelFind("gw-gone");
	await gatewayModelFind("gw-gone", MODEL);
	check(hits.get("/gone/v1/models") === 2, `a key or address saved again reads the list again, got ${hits.get("/gone/v1/models")}`);
	const listedCard = copy.absorbRunPausedSentence("Acme Model", "gateway-not-found", "gw-listed", undefined, undefined, undefined, "Listed gateway", "model-listed");
	check(listedCard === "Listed gateway lists Acme Model but couldn't run it. Nothing was lost. Try again later, or tell whoever runs the gateway.", `a paused memory card's line, got "${listedCard}"`);

	// A real Memorize on a gateway: the fold's patient call and the run's own probe each meet the bare 404,
	// and the run's stop and its paused card say what the list said.
	const absorb = await import("../src/absorb-run.js");
	const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
	absorb.setAbsorbFoldRetryPauseForTests(0);
	const memorize = async (kind: string, generate: () => Promise<never>, probe: () => Promise<{ text: string }>) => {
		const agentId = createPersistentAgentFromScaffoldInput({ displayName: `Memorize ${kind}`, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		const l1bPath = path.join(process.env.EXXETA_PERSISTENT_AGENTS_ROOT!, agentId, "L1b", "current.md");
		const l1b = fs.readFileSync(l1bPath, "utf-8");
		const at = /^##\s+Recent Context\s*$/m.exec(l1b)!;
		fs.writeFileSync(l1bPath, `${l1b.slice(0, at.index + at[0].length)}\n\n### RC-0001 | CLOSED | 2026-09-11 | Plan\n\n**Session arc:** The plan was settled.\n\n**Body:**\n- The plan is the durable point.\n\n**Parked:**\nNone\n`);
		const memoryModel = { provider: `gw-${kind}`, model: MODEL, label: "Acme Model" };
		const { runId } = absorb.startAbsorbRun({ agentId, assessmentMarkdown: "## What these sessions leave behind\n\n- One plan.", model: memoryModel, generate: generate as never, probe: probe as never });
		const deadline = Date.now() + 30_000;
		let run = absorb.getAbsorbRun(agentId, runId);
		while (["prepass", "folding", "budget"].includes(run.state) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			run = absorb.getAbsorbRun(agentId, runId);
		}
		const stop = run.stop;
		const card = stop ? copy.absorbRunPausedSentence("Acme Model", stop.cause, stop.model.provider, stop.key, stop.unreached, stop.quotaWay, stop.gateway, stop.gatewayFind) : "";
		return { stop, card };
	};
	const bare404 = () => causes.failedMessageError(words, codes);
	const patientFold = (kind: string) => () => causes.callWithPatience(async () => { throw bare404(); }, { model: { provider: `gw-${kind}`, model: MODEL, label: "Acme Model" }, sleep: async () => {} });
	const folded = await memorize("gone", patientFold("gone"), async () => ({ text: "OK" }));
	check(folded.stop?.cause === "gateway-not-found" && folded.stop.gatewayFind === "model-gone", `Memorize's stop carries what the list said, got ${JSON.stringify(folded.stop)}`);
	check(folded.card === "Gone gateway no longer has Acme Model. Nothing was lost. Choose one of its current models.", `Memorize's paused card says the model is gone, got "${folded.card}"`);
	const probed = await memorize("listed", async () => { throw new Error("an odd failure"); }, async () => { throw bare404(); });
	check(probed.stop?.cause === "gateway-not-found" && probed.stop.gatewayFind === "model-listed", `Memorize's probe looks at the list too, got ${JSON.stringify(probed.stop)}`);
	check(probed.card === "Listed gateway lists Acme Model but couldn't run it. Nothing was lost. Try again later, or tell whoever runs the gateway.", `the probe's paused card says the model is listed, got "${probed.card}"`);

	const unread = await memoryCall("unread");
	const said = `${unread?.message ?? ""} ${JSON.stringify(unread?.details ?? {})}`;
	check(unread?.details?.gatewayFind === "unread" && !said.includes("Shh") && !said.includes("internal-route"), `none of the gateway's own words reach the notice, got ${said}`);
	const pageRequire = createRequire(new URL("../../web-ui/package.json", import.meta.url));
	const { createElement } = pageRequire("react");
	(globalThis as Record<string, unknown>).React = pageRequire("react");
	const { renderToStaticMarkup } = pageRequire("react-dom/server");
	const component = (file: string) => import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../web-ui/src/components/${file}`)).href) as Promise<any>;
	const buttonsIn = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]).join("|");
	const { ModelNoticePanel } = await component("model-notice.tsx");
	const noticeButtons = (kind: (typeof KINDS)[number]) => buttonsIn(renderToStaticMarkup(createElement(ModelNoticePanel, { notice: { detail: "gateway-not-found", sentence: "x", provider: `gw-${kind}`, gatewayFind: expected[kind] }, onTryAgain: () => {}, onChooseModel: () => {}, onSignIn: () => {} })));
	const NOTICE_BUTTONS = { gone: "Choose another model", address: "Open AI setup|Choose another model", listed: "Try again|Choose another model", unread: "Open AI setup|Choose another model" };
	for (const kind of KINDS) check(noticeButtons(kind) === NOTICE_BUTTONS[kind], `${kind}: the Memory notice's buttons, got ${noticeButtons(kind)}`);

	// A message handed back carries what the list said, so a failure that ended while nobody was in the room says the same line.
	const entries = new Map<string, any>([
		["u1", { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "Hello" }] } }],
		["a1", { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", stopReason: "error", content: [], provider: "gw-listed", model: MODEL, errorMessage: words, ...codes } }],
	]);
	const returned = await stepBackFromFailedPrompt({ sessionManager: { getLeafEntry: () => entries.get("a1"), getEntry: (id: string) => entries.get(id), appendCustomEntry: () => "c1" }, navigateTree: async () => ({ cancelled: false }) } as never, { shown: "Hello" });
	check(returned?.failure === "gateway-not-found" && returned.gatewayFind === "model-listed", `the hand-back carries the cause and what the list said, got ${JSON.stringify(returned)}`);
	const handedBack = returned ? lines.failureLineText(lines.returnedFailureLine("Acme Model", returned as never, false, "Listed gateway"), "back") : "";
	check(handedBack === "Listed gateway lists Acme Model but couldn't run it. Your message is back in the box. Try again later, or tell whoever runs the gateway.", `the hand-back's line, got "${handedBack}"`);

	// On a shared server AI setup is the admin's: each line ends with the admin, with no AI setup button.
	const { fetchRemoteClientContext } = await import("../../web-ui/src/remote-client-context.js");
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ remote: false, capability: "full", sharedServer: true }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
	try { await fetchRemoteClientContext(); } finally { globalThis.fetch = realFetch; }
	const { registerServerHooks } = await import("../src/server-hooks.js");
	registerServerHooks({});
	const SHARED = {
		gone: "Gone gateway no longer has Acme Model. Your message is still above. Choose one of its current models, or tell your admin.",
		address: "Address gateway isn't answering at its saved address. Your message is still above. Tell your admin.",
		listed: "Listed gateway lists Acme Model but couldn't run it. Your message is still above. Try again later, or tell your admin.",
		unread: "Unread gateway could not find Acme Model. Your message is still above. Tell your admin.",
	};
	const SHARED_BUTTONS = { gone: "chooseModel", address: "", listed: "tryAgain", unread: "" };
	for (const kind of KINDS) {
		check(chatLine(kind, true) === SHARED[kind], `${kind}: the chat's line on a shared server, got "${chatLine(kind, true)}"`);
		check(shownButtons(kind, true) === SHARED_BUTTONS[kind], `${kind}: no AI setup button on a shared server, got "${shownButtons(kind, true)}"`);
	}
	const sharedNotice = causes.modelUnreachableSentence("gateway-not-found", { provider: "gw-address", model: MODEL, label: "Acme Model" }, undefined, undefined, undefined, "address");
	check(sharedNotice === "Address gateway isn't answering at its saved address. Nothing was lost. Tell your admin.", `the Memory notice on a shared server, got "${sharedNotice}"`);
	check(copy.memoryModelStopWayOn("gateway-not-found", undefined, undefined, "unread") === "Tell your admin.", "a memory card on a shared server tells the admin");
	check(noticeButtons("address") === "Choose another model", `the Memory notice on a shared server offers no AI setup, got ${noticeButtons("address")}`);
} finally {
	endpoint.close();
	fs.rmSync(home, { recursive: true, force: true });
}

if (failures.length > 0) throw new Error(`gateway bare 404:\n  ${failures.join("\n  ")}`);
console.log("gateway bare 404 smoke: ok");
