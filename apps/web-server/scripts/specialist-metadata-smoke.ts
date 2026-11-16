// A specialist task's model calls name the person that room's usage rows name.
// Specialists stay switched off, so no live task reaches this site: the smoke
// calls runSpecialistWorker directly, as the room would, against a synthetic
// OpenAI-compatible gateway that records each request body. The usage owner
// comes from a registry this process fills, as a shared server's entry does;
// the person is an opaque id written here by hand. Throwaway HOME.
//   S1 with nothing registered (the desktop), the request carries no user.
//   S2 with the room's owner known for task rows, the request's user is that person.
//   S3 a room whose owner is not known: no user, while S2's room, its control, has one.
// Run alone: node --import tsx/esm apps/web-server/scripts/specialist-metadata-smoke.ts
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-specialist-metadata-")));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
const workspaceRoot = path.join(tempRoot, "workspace");
for (const dir of [agentDir, appRoot, agentsRoot, workspaceRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

// Set before any of the server's modules load: they read these once.
Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, EXXETA_HOME: repoRoot, PI_OFFLINE: "1" });
delete process.env.EXXPERTS_DATA_DIR;
delete process.env.EXXPERTS_STATE_HOME;

const MODEL = { provider: "openai-compatible", model: "specialist-model" };
const ROOM = "owned-room";
const UNOWNED_ROOM = "unowned-room";
const PERSON = "p-5d1c9e0a";
const SPACE = "s-0b7e2f44";

const bodies: Record<string, unknown>[] = [];
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let raw = "";
	req.on("data", (chunk) => {
		raw += chunk;
	});
	req.on("end", () => {
		bodies.push(JSON.parse(raw) as Record<string, unknown>);
		const base = { id: "cmpl_specialist_metadata", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL.model };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 } }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

let passes = 0;
function pass(id: string, label: string): void {
	passes += 1;
	console.log(`  ok  ${id}: ${label}`);
}

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [MODEL.provider]: { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: MODEL.model, name: "Specialist Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [MODEL.provider]: { type: "api_key", key: "synthetic-specialist-metadata" } }, null, 2), { mode: 0o600 });

	const { AuthStorage, ModelRegistry } = await import("@exxeta/exxperts-runtime");
	const execution = await import("../src/persistent-room-specialist-execution.js");
	const registry = () => ModelRegistry.create(AuthStorage.create(path.join(agentDir, "auth.json")), path.join(agentDir, "models.json"));
	const findModel = (workerRegistry: any, lock: { provider: string; model: string }) => {
		const found = workerRegistry.find(lock.provider, lock.model);
		assert(found, `the synthetic model ${lock.model} is in the registry`);
		return found;
	};
	let task = 0;
	// One specialist task for the room; the bodies of the requests it sent.
	const runTask = async (id: string, roomId: string): Promise<Record<string, unknown>[]> => {
		const from = bodies.length;
		task += 1;
		const plan = execution.buildSpecialistSessionPlan({ taskId: `tsk-metadata${task}`, templateId: "document-html", brief: "Write the one-pager." });
		await execution.runSpecialistWorker({ plan, modelLock: MODEL, resolveExpectedModel: findModel, modelRegistry: registry(), cwd: workspaceRoot, agentDir, roomId });
		const sent = bodies.slice(from);
		assert(sent.length > 0, `${id}: the task reached the gateway`);
		return sent;
	};

	const desktop = await runTask("S1", ROOM);
	for (const body of desktop) assert(!("user" in body) && !("metadata" in body), `S1: a request with nothing registered names no one: ${JSON.stringify(Object.keys(body))}`);
	pass("S1", "with nothing registered, the specialist's requests carry no user and no metadata");

	const { registerServerHooks } = await import("../src/server-hooks.js");
	const asked: Array<{ roomId: string; kind: unknown }> = [];
	registerServerHooks({
		usageOwner: (roomId, kind) => {
			asked.push({ roomId, kind });
			return roomId === ROOM && kind === "task" ? { person: PERSON, space: SPACE } : undefined;
		},
	});

	const owned = await runTask("S2", ROOM);
	for (const body of owned) {
		assert(body.user === PERSON, `S2: the request's user is the room's person: ${JSON.stringify(body.user)}`);
		assert(!("metadata" in body), "S2: the request carries no metadata field of its own");
	}
	assert(asked.some((entry) => entry.roomId === ROOM && entry.kind === "task"), `S2: the owner was asked for the room's task rows: ${JSON.stringify(asked)}`);
	pass("S2", "with the room's owner known, each request's user is that person, asked for the room's task rows");

	const unowned = await runTask("S3", UNOWNED_ROOM);
	for (const body of unowned) assert(!("user" in body), `S3: a room with no known owner names no one: ${JSON.stringify(body.user)}`);
	pass("S3", "a room whose owner is not known sends no user, while S2's room, its control, does");

	console.log(`specialist-metadata-smoke: ${passes} checks passed`);
} finally {
	try {
		(gateway as any).closeAllConnections?.();
	} catch {}
	try {
		gateway.close();
	} catch {}
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
