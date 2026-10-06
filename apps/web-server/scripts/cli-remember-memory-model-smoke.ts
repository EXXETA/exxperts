// The CLI's Remember (/checkpoint) runs on the room's Memory row, resolved the
// way the web resolves it, not on the model the conversation talks with. The
// room here talks with Claude and remembers with GPT: the proposal is read by
// GPT and says so, and a Memory row changed while the proposal waits is
// refused at approval with the web's sentence, nothing saved. With GPT signed
// out, Remember refuses in one line, the web's, and nothing else reads.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-cli-remember-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const CLAUDE = { provider: "fake-claude", model: "claude-fake" };
const GPT = { provider: "fake-gpt", model: "gpt-fake" };
const requests: string[] = [];

function sse(res: http.ServerResponse, event: string | null, payload: unknown): void {
	res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}

// Both providers answer the compression prompt with the four fields.
const FIELDS = "TITLE:\nCLI memory row\n\nSESSION_ARC:\nWe checked the CLI.\n\nBODY:\n- Remember reads on the Memory row.\n\nPARKED:\nNone\n";
const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		requests.push(String(body.model));
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (String(req.url ?? "").includes("/messages")) {
			sse(res, "message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: FIELDS } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		const base = { id: "cmpl_1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		sse(res, null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: FIELDS }, finish_reason: null }] });
		sse(res, null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] },
			"fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const { AuthStorage, ModelRegistry } = await import("@exxeta/exxperts-runtime");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "CLI Remember Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE, memory: GPT });
	const conversationId = "c_cli_remember";
	agents.writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "cli", model: CLAUDE, items: [
		{ kind: "user", id: "u1", text: "Which model remembers this room?" },
		{ kind: "assistant", id: "a1", text: "The room's Memory row does." },
	] } as any);

	// The CLI runs inside the room with the conversation's model in its env.
	process.env.EXXETA_PERSISTENT_ROOM_AGENT = agentId;
	process.env.EXXETA_PERSISTENT_ROOM_THREAD = conversationId;
	process.env.EXXETA_PERSISTENT_ROOM_MODEL_PROVIDER = CLAUDE.provider;
	process.env.EXXETA_PERSISTENT_ROOM_MODEL_ID = CLAUDE.model;

	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	// Loaded by a computed path: the extension is typed against the CLI
	// runtime, which the web server's script check does not cover.
	const extensionModule = "../../../pi-package/extensions/cli-rooms/index.js";
	const extension = (await import(extensionModule)).default;
	extension({ registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) => { commands.set(name, spec.handler); }, on: () => {}, registerTool: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, sendMessage: () => {} } as any);
	const checkpoint = commands.get("checkpoint");
	assert(checkpoint, "the CLI registers /checkpoint");

	const modelRegistry = ModelRegistry.create(AuthStorage.create());
	const notes: string[] = [];
	let titleShown = "";
	let onConfirm: () => void = () => {};
	const ctx = (finalChoice: string) => ({
		hasUI: true,
		waitForIdle: async () => {},
		modelRegistry,
		signal: undefined,
		ui: {
			notify: (message: string) => { notes.push(message); },
			input: async () => "",
			select: async (title: string, options: string[]) => {
				if (title.startsWith("Memory proposal:")) { titleShown = title; return finalChoice; }
				return options[0];
			},
			confirm: async () => { onConfirm(); return true; },
		},
	});

	// 1. The proposal is read by the Memory row's model, not the conversation's.
	await checkpoint("", ctx("Discard"));
	assert(titleShown === "Memory proposal: CLI memory row", `the CLI showed the proposal, got ${JSON.stringify(titleShown)} ${JSON.stringify(notes)}`);
	assert(requests.length >= 1 && requests.every((model) => model === GPT.model), `Remember read on the Memory row (gpt-fake), got ${JSON.stringify(requests)}`);

	// 2. The Memory row changes while the proposal waits: approval refuses.
	requests.length = 0;
	onConfirm = () => roomModels.writeRoomModels(agentId, { conversation: CLAUDE, memory: CLAUDE });
	let refused = "";
	try {
		await checkpoint("", ctx("Approve and save memory"));
	} catch (error) {
		refused = (error as Error).message;
	}
	assert(refused === agents.REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE, `a changed Memory row is refused at approval, got ${JSON.stringify(refused)}`);
	assert(requests.every((model) => model === GPT.model), `the second proposal also read on gpt-fake, got ${JSON.stringify(requests)}`);
	// A saved Remember closes the conversation; this one is still open.
	const after = agents.getPersistentAgentThread(agentId, conversationId);
	assert(after && after.state !== "closed", `nothing was saved, the conversation is ${after?.state}`);

	// 3. The Memory row's provider signs out, Claude stays signed in: the CLI
	// refuses with the web's sentence and no model reads the conversation.
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE, memory: GPT });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	requests.length = 0;
	notes.length = 0;
	titleShown = "";
	await checkpoint("", ctx("Discard"));
	assert(notes.includes("This room's memory model, GPT Fake on Fake GPT, is signed out. Sign in again in Settings, AI setup, or choose another model in Room settings, Model."), `a signed-out Memory row is refused in one line, got ${JSON.stringify(notes)}`);
	assert(requests.length === 0 && titleShown === "", `nothing read the conversation in its place, got ${JSON.stringify(requests)}`);
	console.log("cli-remember-memory-model smoke: ok");
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
