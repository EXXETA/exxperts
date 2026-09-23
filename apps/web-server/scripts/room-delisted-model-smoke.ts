// A conversation keeps the model it started on after that model leaves the
// active profile's curated list; the list gates a NEW conversation only.
//
// Seeds a room whose active thread is locked to anthropic/claude-opus-4-5, a
// catalogue model that is not on the curated Claude list, under a synthetic
// Claude sign-in, then checks through the server: the room status names the
// model, the thread resumes (PUT and WebSocket bind), a new conversation on
// that model is refused on every creating path with today's message, one on
// a curated model is accepted, and the fresh thread after a Forget and after
// a Remember starts on the profile's first curated model.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-delisted-model-home-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-delisted-model-cwd-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const roomsRoot = path.join(productAppRoot, "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = roomsRoot;

const delisted = { provider: "anthropic", model: "claude-opus-4-5", label: "Opus 4.5" };
const curatedFirst = { provider: "anthropic", model: "claude-opus-5-5" };
const serverOutput: string[] = [];
let server: ChildProcessWithoutNullStreams | null = null;

async function waitForServer(child: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`server exited before startup with code ${child.exitCode}: ${serverOutput.join("")}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(pathname: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: init.body ? { "content-type": "application/json" } : {} });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

function smokeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]) delete env[key];
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	env.EXXPERTS_AUTH_TOKEN = SMOKE_SERVER_AUTH_ENV.EXXPERTS_AUTH_TOKEN;
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	env.EXXETA_PERSISTENT_AGENTS_ROOT = roomsRoot;
	return env;
}

const WebSocketImpl: any = (await import("ws")).default;

// Opens a room session and returns the first frame the server sends: "ready"
// when the bind succeeded, "error" when it was refused (the server closes the
// socket after an error frame).
async function firstSessionFrame(agentId: string, conversationId: string, model: { provider: string; model: string }): Promise<Record<string, any>> {
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=${model.provider}&model=${model.model}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frame = await new Promise<Record<string, any>>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no frame from the session bind for ${conversationId}`)), 20_000);
		socket.addEventListener("message", (event: { data: unknown }) => {
			try {
				const parsed = JSON.parse(String(event.data));
				if (parsed.type === "ready" || parsed.type === "error") {
					clearTimeout(timer);
					resolve(parsed);
				}
			} catch {}
		});
		socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("websocket failed to connect")); });
	});
	try { socket.close(); } catch {}
	return frame;
}

try {
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(productAppRoot, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "synthetic-oauth-access-do-not-print", refresh: "synthetic-oauth-refresh-do-not-print", expires: Date.now() + 600_000 } }, null, 2));
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "anthropic" }, null, 2));

	// The room and its conversation, written the way a build that still listed
	// the model wrote them: a standby thread with a real turn, locked to it.
	const agents = await import("../src/persistent-agents.js");
	const profiles = await import("../src/persistent-agent-ai-profiles.js");
	const scaffolded = agents.createPersistentAgentFromScaffoldInput({ displayName: "Delisted Model Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = scaffolded.agent.agentId;
	assert(!profiles.isPersistentRoomModelForProfile("anthropic", delisted.provider, delisted.model), "the fixture model must be outside the curated Claude list");
	const conversationId = "c_delisted_standby";
	const items = [{ kind: "user", id: "u1", text: "Synthetic turn before the list changed." }, { kind: "assistant", id: "a1", text: "Synthetic answer.", streaming: false }];
	agents.writePersistentAgentThread(agentId, conversationId, { state: "standby", origin: "home", model: delisted, items }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: tempCwd }),
		allowInactiveProfileModel: true,
	});

	// The gates that stay, in process: a new lock on the delisted model is refused
	// on the scheduled-room path and the checkpoint path, with today's message.
	let refused = "";
	try {
		profiles.assertPersistentRoomModelForActiveProfile("anthropic", delisted.provider, delisted.model, "scheduled-room background work");
	} catch (error) {
		refused = (error as Error).message;
	}
	assert(/model is not approved for scheduled-room background work: anthropic\/claude-opus-4-5/.test(refused), `the scheduled-room lock refuses the delisted model, got ${refused}`);
	assert(profiles.resolveScheduledRoomModelLockForProfile("anthropic").model === curatedFirst.model, "the scheduled-room lock is the first curated model");
	refused = "";
	try {
		profiles.resolveCheckpointModelLockForProfile("anthropic", delisted);
	} catch (error) {
		refused = (error as Error).message;
	}
	assert(/model is not approved .*checkpoint compression inherited persistent-room model/.test(refused), `a new checkpoint lock on the delisted model is refused, got ${refused}`);
	assert(profiles.resolveCheckpointModelLockForProfile("anthropic", delisted, { existingLock: true }).model === delisted.model, "the saved conversation's own lock is inherited for Remember");

	server = spawn("npx", ["tsx", "src/index.ts"], { shell: process.platform === "win32", ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: smokeEnv() });
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// The room status names the model the conversation runs on.
	const statuses = await requestJson("/api/persistent-agents");
	assert(statuses.status === 200, `room statuses should load, got ${statuses.status}`);
	const room = statuses.body.find((row: any) => row.id === agentId);
	assert(room?.runtime?.state === "standby" && room.runtime.activeThreadId === conversationId, `the room should be standby on the seeded thread, got ${JSON.stringify(room?.runtime)}`);
	assert(room.runtime.model?.model === delisted.model && room.runtime.model?.label === delisted.label, `the status should carry the delisted model and its name, got ${JSON.stringify(room.runtime.model)}`);
	const modelStatus = await requestJson("/api/persistent-agent-room/model-status");
	assert(modelStatus.status === 200 && !modelStatus.body.roomModels.some((option: any) => option.model === delisted.model), "the picker for a new conversation offers only the curated list");
	assert(modelStatus.body.roomModels[0]?.model === curatedFirst.model && modelStatus.body.roomModels[0]?.recommended === true, "the first curated model is the recommended one");

	// Resume: the thread PUT the web app sends on Resume, then the session bind.
	const resume = await requestJson(`/api/persistent-agents/${agentId}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: delisted, items }) });
	assert(resume.status === 200 && resume.body?.thread?.model?.model === delisted.model, `the existing conversation should resume on its own model, got ${resume.status}: ${JSON.stringify(resume.body)}`);
	const bound = await firstSessionFrame(agentId, conversationId, delisted);
	assert(bound.type === "ready" && bound.model?.model === delisted.model, `the session should bind to the saved conversation on its own model, got ${JSON.stringify(bound)}`);
	const otherModel = await firstSessionFrame(agentId, conversationId, curatedFirst);
	assert(otherModel.type === "error" && /locked to anthropic\/claude-opus-4-5/.test(String(otherModel.message)), `a resume on another model keeps today's lock message, got ${JSON.stringify(otherModel)}`);

	// A NEW conversation on the delisted model is refused on every creating path.
	const newBind = await firstSessionFrame(agentId, "c_new_on_delisted", delisted);
	assert(newBind.type === "error" && /model is not approved for persistent-agent rooms: anthropic\/claude-opus-4-5/.test(String(newBind.message)), `a new conversation on the delisted model is refused at the bind, got ${JSON.stringify(newBind)}`);
	const newPut = await requestJson(`/api/persistent-agents/${agentId}/threads/c_new_on_delisted`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: delisted, items: [] }) });
	assert(newPut.status === 400 && /model is not approved .*persistent-agent thread writes: anthropic\/claude-opus-4-5/.test(String(newPut.body?.error)), `a PUT that creates a thread on the delisted model is refused, got ${newPut.status}: ${JSON.stringify(newPut.body)}`);
	const selection = await requestJson("/api/persistent-agent-room/model-selection", { method: "POST", body: JSON.stringify(delisted) });
	assert(selection.status === 400 && /model is not approved for persistent-agent rooms: anthropic\/claude-opus-4-5/.test(String(selection.body?.error)), `the model-selection POST refuses the delisted model, got ${selection.status}: ${JSON.stringify(selection.body)}`);
	const curatedSelection = await requestJson("/api/persistent-agent-room/model-selection", { method: "POST", body: JSON.stringify(curatedFirst) });
	assert(curatedSelection.status === 200, `the model-selection POST accepts a curated model, got ${curatedSelection.status}: ${JSON.stringify(curatedSelection.body)}`);

	// Forget: the old conversation closes and the fresh thread starts on the first curated model.
	const memento = await requestJson(`/api/persistent-agents/${agentId}/memento`, { method: "POST", body: JSON.stringify({ conversationId }) });
	assert(memento.status === 200, `Forget should succeed on the delisted conversation, got ${memento.status}: ${JSON.stringify(memento.body)}`);
	const afterMemento = (await requestJson("/api/persistent-agents")).body.find((row: any) => row.id === agentId);
	assert(afterMemento.runtime.activeThreadId?.startsWith("postmem_") && afterMemento.runtime.model?.model === curatedFirst.model, `the fresh thread after Forget should start on the first curated model, got ${JSON.stringify(afterMemento.runtime)}`);
	const oldThread = await requestJson(`/api/persistent-agents/${agentId}/threads/${conversationId}`);
	assert(oldThread.body?.thread?.state === "closed" && oldThread.body.thread.model.model === delisted.model, "the old conversation is closed and keeps its lock");

	// A new conversation on a curated model is accepted.
	const curatedPut = await requestJson(`/api/persistent-agents/${agentId}/threads/c_new_on_curated`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { ...curatedFirst, label: "Opus 5.5" }, items: [] }) });
	assert(curatedPut.status === 200, `a new conversation on a curated model is accepted, got ${curatedPut.status}: ${JSON.stringify(curatedPut.body)}`);

	await stopSmokeServer(server);
	server = null;

	// Remember, in process (the approval never invokes a model): the fresh
	// thread after a checkpoint takes the resolved fresh model, the old
	// conversation keeps its lock.
	const rememberId = "c_delisted_remember";
	agents.writePersistentAgentThread(agentId, rememberId, { state: "active", origin: "home", model: delisted, items: [{ kind: "user", id: "u2", text: "Synthetic checkpoint source turn." }] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: rememberId, model, cwd: tempCwd }),
		allowInactiveProfileModel: true,
	});
	const rememberThread = agents.getPersistentAgentThread(agentId, rememberId);
	assert(rememberThread?.runtime.kind === "pi-session-jsonl", "the Remember fixture must be Pi-backed");
	const session = agents.openPersistentAgentPiSessionManager(agentId, rememberThread.runtime as any, tempCwd);
	session.appendMessage({ role: "user", content: "Synthetic checkpointable source turn.", timestamp: Date.now() });
	const proposal = await agents.buildCheckpointProposal({ agentId, conversationId: rememberId, model: delisted, density: "standard", items: [{ kind: "user", text: "Synthetic checkpoint source turn." }], runtimeCwd: tempCwd }, async () => ({
		text: "TITLE:\nDelisted model checkpoint\n\nSESSION_ARC:\nSynthetic checkpoint on a delisted model.\n\nBODY:\n- The conversation kept its model.\n\nPARKED:\nNone\n",
		usage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
	}));
	assert(proposal.process?.model?.model === delisted.model, `the proposal runs on the conversation's own lock, got ${JSON.stringify(proposal.process?.model)}`);
	const parsed = agents.parseCheckpointApprovalRequest({
		conversationId: rememberId,
		model: delisted,
		density: proposal.density,
		proposal,
		approvedRecentContext: "### RC-DRAFT | CLOSED | 2026-09-23 | Delisted model checkpoint\n\n**Session arc:** Synthetic checkpoint on a delisted model.\n\n**Body:**\n- The conversation kept its model.\n\n**Parked:**\nNone\n",
	}, agentId);
	const checkpoint = agents.writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date(), { runtimeCwd: tempCwd, freshModel: curatedFirst });
	const postCheckpoint = agents.getPersistentAgentThread(agentId, checkpoint.postCheckpoint.activeThreadId);
	assert(postCheckpoint?.threadId.startsWith("postcp_") && postCheckpoint.model.model === curatedFirst.model, `the fresh thread after Remember should start on the resolved curated model, got ${JSON.stringify(postCheckpoint?.model)}`);
	assert(agents.getPersistentAgentThread(agentId, rememberId)?.model.model === delisted.model, "the old conversation keeps its lock after Remember");

	console.log("room delisted model smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-60).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempCwd, { recursive: true, force: true });
	}
}
