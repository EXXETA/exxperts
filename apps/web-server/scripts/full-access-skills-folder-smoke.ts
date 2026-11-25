import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(50);

// A room reads the folder of a skill that is on in it, and nothing else of the
// skills folder, through the file tools the live session really gets: a real
// server, a synthetic gateway that plays the model and calls the tools, and
// each tool's result read back from the next completion request. No room
// changes a skill, the rest of the app's data stays closed, a changed skill
// stays open as it now is, and bash off, a bounded room, a background run and
// a data profile follow the same rule. A skill in the folder shared with other
// tools opens the same way at its real folder, wherever its link leads, for
// reading only; in the room's own folder the room writes it as it writes the
// rest of that folder. Throwaway HOME.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");

// Not resolved to its real path on purpose: on macOS the temp folder is a
// link (/var to /private/var), so the paths the room uses differ from the
// real ones, as they can on a person's machine.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-folder-"));
const home = path.join(tempRoot, "home");
const workspaceRoot = path.join(home, "workspace");
fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

const REFUSED = "so rooms don't open it";
const READ_ONLY = "can be read but not changed by rooms";
const LINK = "this room doesn't follow links";
const OUTSIDE = "is outside this room's folder and the folders allowed for it";
// The app's skills folder outside a skill that is on: named as what it is, never as a secret.
const SKILLS = "is in the app's skills folder. A room can't change a skill's folder, and reads only the folders of the skills that are on in it, which read_skill gives; write into the room's folder instead.";
const REFERENCE = "REFERENCE-NEEDLE: the guide's reference text.";
const OTHER = "OTHER-NEEDLE: a second skill's notes.";
const SECRET = "SECRET-NEEDLE";
const AUTH = "AUTH-NEEDLE";

interface StateLayout {
	stateRoot: string;
	agentDir: string;
	appRoot: string;
	agentsRoot: string;
	store: string;
}

function layout(stateRoot: string): StateLayout {
	const agentDir = path.join(stateRoot, ".exxperts", "agent");
	const appRoot = path.join(stateRoot, ".exxperts", "app");
	return { stateRoot, agentDir, appRoot, agentsRoot: path.join(appRoot, "personalized-agents"), store: path.join(agentDir, "skills") };
}

let linksAllowed = true;

// A downloaded-style skill as the Skills page leaves it, a second skill whose
// name starts with the first one's, a secret file and a link to the auth file.
async function plantState(state: StateLayout, gatewayPort: number): Promise<void> {
	const { sha256, writeSkillProvenance } = await import("../src/skills-store.js");
	for (const dir of [state.agentsRoot, state.agentDir, state.appRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(state.agentDir, "models.json"), JSON.stringify({
		providers: {
			"openai-compatible": {
				name: "Synthetic Gateway",
				baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
				api: "openai-completions",
				models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(state.agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: `synthetic-${AUTH}` } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(state.appRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(state.appRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	const guide = path.join(state.store, "guide");
	fs.mkdirSync(path.join(guide, "scripts"), { recursive: true, mode: 0o700 });
	const manifest = "---\nname: guide\ndescription: A guide with a reference file and a script\n---\n\nRead reference.md, then run scripts/hello.sh.\n";
	fs.writeFileSync(path.join(guide, "SKILL.md"), manifest, { mode: 0o600 });
	fs.writeFileSync(path.join(guide, "reference.md"), `${REFERENCE}\n`, { mode: 0o600 });
	fs.writeFileSync(path.join(guide, "scripts", "hello.sh"), "echo hello\n", { mode: 0o700 });
	fs.writeFileSync(path.join(guide, ".env"), `${SECRET}=1\n`, { mode: 0o600 });
	if (linksAllowed) {
		try {
			fs.symlinkSync(path.join(state.agentDir, "auth.json"), path.join(guide, "link-to-auth"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
			linksAllowed = false;
			console.log("SKIPPED: the link cases (this system does not allow links here)");
		}
	}
	writeSkillProvenance(guide, { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(manifest) });

	const other = path.join(state.store, "guidebook");
	fs.mkdirSync(other, { recursive: true, mode: 0o700 });
	const otherManifest = "---\nname: guidebook\ndescription: A second skill\n---\n\nNothing to run.\n";
	fs.writeFileSync(path.join(other, "SKILL.md"), otherManifest, { mode: 0o600 });
	fs.writeFileSync(path.join(other, "notes.md"), `${OTHER}\n`, { mode: 0o600 });
	writeSkillProvenance(other, { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(otherManifest) });

	// Marked by its author for picking by hand only: the person picks it in the room, so on there its folder opens; off, it closes.
	const picked = path.join(state.store, "picked");
	fs.mkdirSync(picked, { recursive: true, mode: 0o700 });
	const pickedManifest = "---\nname: picked\ndescription: Picked by hand only\ndisable-model-invocation: true\n---\n\nNothing to run.\n";
	fs.writeFileSync(path.join(picked, "SKILL.md"), pickedManifest, { mode: 0o600 });
	fs.writeFileSync(path.join(picked, "notes.md"), `${OTHER}\n`, { mode: 0o600 });
	writeSkillProvenance(picked, { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(pickedManifest) });

	// A skill folder in the library that is itself a link: on in the room, its folder stays closed.
	if (linksAllowed) {
		const target = path.join(state.stateRoot, "linked-target");
		fs.mkdirSync(target, { recursive: true, mode: 0o700 });
		const linkedManifest = "---\nname: linked\ndescription: A linked skill folder\n---\n\nNothing to run.\n";
		fs.writeFileSync(path.join(target, "SKILL.md"), linkedManifest, { mode: 0o600 });
		fs.writeFileSync(path.join(target, "notes.md"), `${OTHER}\n`, { mode: 0o600 });
		writeSkillProvenance(target, { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(linkedManifest) });
		fs.symlinkSync(target, path.join(state.store, "linked"), "dir");
	}
}

// ---------------------------------------------------------------------------
// The synthetic gateway plays the model: each leg of a turn calls the next
// scripted tool, and once every call has run it captures the tool results.
// ---------------------------------------------------------------------------
interface ScriptedCall {
	name: string;
	args: Record<string, unknown>;
	/** Runs just before this call is sent, between two calls of one turn. */
	before?: () => void;
}
let script: ScriptedCall[] = [];
let turnResults: string[] | null = null;

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function toolMessageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (Array.isArray(message?.content)) return message.content.map((part: any) => (typeof part?.text === "string" ? part.text : JSON.stringify(part))).join("\n");
	return JSON.stringify(message?.content ?? "");
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const toolMessages = messages.filter((m) => m?.role === "tool");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${toolMessages.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		const next = Array.isArray(parsed?.tools) && parsed.tools.length > 0 ? script[toolMessages.length] : undefined;
		if (next) {
			next.before?.();
			const id = `call_${toolMessages.length}`;
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: next.name, arguments: "" } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			if (toolMessages.length > 0) turnResults = toolMessages.map(toolMessageText);
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 5, total_tokens: 155 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

const WebSocketImpl: any = (await import("ws")).default;

class LiveServer {
	process: ChildProcessWithoutNullStreams | undefined;
	output: string[] = [];
	port = 0;

	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	async start(env: Record<string, string | undefined>): Promise<void> {
		this.port = await freePort();
		this.process = spawn("npx", ["tsx", "src/index.ts"], {
			shell: process.platform === "win32",
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env: { ...env, PORT: String(this.port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot } as NodeJS.ProcessEnv,
		});
		this.process.stdout.on("data", (chunk) => this.output.push(String(chunk)));
		this.process.stderr.on("data", (chunk) => this.output.push(String(chunk)));
		const deadline = Date.now() + 20_000;
		let lastError = "server did not respond";
		while (Date.now() < deadline) {
			if (this.process.exitCode != null) throw new Error(`server exited before startup with code ${this.process.exitCode}`);
			try {
				const response = await fetch(`${this.baseUrl}/healthz`);
				if (response.ok) return;
				lastError = `healthz returned ${response.status}`;
			} catch (error) {
				lastError = (error as Error).message;
			}
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		throw new Error(`server did not become ready: ${lastError}`);
	}

	async stop(): Promise<void> {
		await stopSmokeServer(this.process);
		this.process = undefined;
	}

	async json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
		const response = await authedFetch(`${this.baseUrl}${pathname}`, {
			...init,
			headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
		});
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : null };
	}

	async createRoom(name: string): Promise<string> {
		const room = await this.json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
		assert(room.status === 201, `room creation: expected 201, got ${room.status}: ${JSON.stringify(room.body)}`);
		const agentId = String(room.body?.agent?.id ?? room.body?.agent?.agentId ?? "");
		assert(agentId, `room creation must return an id, got ${JSON.stringify(room.body).slice(0, 300)}`);
		return agentId;
	}

	async setWorkspace(agentId: string, workspaceAccessMode: "localFiles" | "bounded", bashEnabled: boolean): Promise<void> {
		const workspace = await this.json(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, {
			method: "PUT",
			body: JSON.stringify({ root: workspaceRoot, displayLabel: "Skills Folder Workspace", workspaceAccessMode, bashEnabled }),
		});
		assert(workspace.status === 200, `workspace default PUT: expected 200, got ${workspace.status}: ${JSON.stringify(workspace.body)}`);
		assert(workspace.body?.policy?.bashEnabled === bashEnabled, `the room default must carry bashEnabled ${bashEnabled}`);
	}

	async skillAction(agentId: string, action: string, name: string): Promise<any> {
		const result = await this.json(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action, name }) });
		assert(result.status === 200, `${action} ${name}: expected 200, got ${result.status}: ${JSON.stringify(result.body)}`);
		return result.body;
	}

	// One prompt turn over the room's live connection; resolves with the result
	// of every scripted call once the turn has settled on the server.
	// agent_end reaches the socket before that, and until then a settings save
	// is refused as a turn in flight, so it waits on the room's status, the
	// field that refusal reads.
	async runTurn(agentId: string, conversationId: string, calls: ScriptedCall[]): Promise<string[]> {
		const seeded = await this.json(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`, {
			method: "PUT",
			body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
		});
		assert(seeded.status === 200, `thread seed: expected 200, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);
		script = calls;
		turnResults = null;
		const socket = new WebSocketImpl(`ws://127.0.0.1:${this.port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const frames: any[] = [];
		socket.addEventListener("message", (event: { data: unknown }) => {
			try { frames.push(JSON.parse(String(event.data))); } catch {}
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
		});
		socket.send(JSON.stringify({ type: "prompt", text: "Please use the guide skill." }));
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (turnResults && frames.some((frame) => frame?.type === "event" && frame?.event?.type === "agent_end")) {
				let activeThread: any;
				await waitUntil(async () => {
					const status = await this.json(`/api/persistent-agents/${encodeURIComponent(agentId)}/status`);
					activeThread = status.body?.activeThread;
					return status.status === 200 && activeThread?.inFlight === false;
				}, "the turn has settled on the server", 20_000).catch((error: Error) => {
					// JSON.stringify(undefined) is undefined: a status request that failed
					// before any answer must still surface its own error, not a TypeError.
					const seen = JSON.stringify(activeThread) ?? "none read";
					throw new Error(`${error.message}; the room's active thread: ${seen.slice(0, 400)}`, { cause: error });
				});
				try { socket.close(); } catch {}
				const results = turnResults as string[];
				assert(results.length === calls.length, `expected ${calls.length} tool results, got ${results.length}`);
				return results;
			}
			const errors = frames.filter((frame) => String(frame?.type ?? "").includes("error"));
			if (errors.length > 0) throw new Error(`turn errored: ${JSON.stringify(errors[0]).slice(0, 400)}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`turn did not run its tool calls and end; frame types: ${frames.map((f) => f?.type).join(", ")}`);
	}
}

function opened(result: string, needle: string, what: string): void {
	assert(!result.includes(REFUSED) && !result.includes(OUTSIDE) && result.includes(needle), `${what} must open, got: ${result.slice(0, 500)}`);
}

// Outside the fence, the app's data says it's closed, and the skills folder says
// it is one: the folder of a skill that isn't on, or a write into a skill's. No
// refusal offers a command.
function refused(result: string, what: string): void {
	assert(result.includes(REFUSED) || result.includes(READ_ONLY) || result.includes(LINK) || result.includes(OUTSIDE) || result.includes(SKILLS), `${what} must be refused, got: ${result.slice(0, 500)}`);
	assert(!/command/i.test(result) && !result.includes(REFERENCE) && !result.includes(OTHER) && !result.includes(AUTH), `${what}: the refusal must offer no command and show nothing, got: ${result.slice(0, 500)}`);
}

// A secret name can be stopped earlier, by the content policy, before the floor.
function secretRefused(result: string, what: string): void {
	assert(result.includes(REFUSED) || result.includes("Content policy blocked"), `${what} must be refused, got: ${result.slice(0, 500)}`);
}

// Joined without path.join, which would fold the .. away before the tool sees it.
const literal = (...parts: string[]): string => parts.join(path.sep);
const read = (p: string): ScriptedCall => ({ name: "read", args: { path: p } });
const ls = (p: string): ScriptedCall => ({ name: "ls", args: { path: p } });
const find = (pattern: string, p: string): ScriptedCall => ({ name: "find", args: { pattern, path: p } });
const grep = (pattern: string, p: string): ScriptedCall => ({ name: "grep", args: { pattern, path: p } });
const write = (p: string, content: string): ScriptedCall => ({ name: "write", args: { path: p, content } });
const edit = (p: string, oldText: string, newText: string): ScriptedCall => ({ name: "edit", args: { path: p, edits: [{ oldText, newText }] } });
const readSkill = (name: string): ScriptedCall => ({ name: "read_skill", args: { name } });

// Windows only: the folder's 8.3 short name, or null when the volume has none.
function shortName(dir: string): string | null {
	if (process.platform !== "win32") return null;
	// Handed to cmd as written, as Node's own shell spawn does: Node's quoting would keep the inner quotes in the path.
	const result = spawnSync("cmd", ["/d", "/s", "/c", `"for %I in ("${dir}") do @echo %~sI"`], { encoding: "utf8", windowsVerbatimArguments: true });
	const short = String(result.stdout ?? "").trim();
	return short && short.toLowerCase() !== dir.toLowerCase() ? short : null;
}

const main = layout(home);
const profile = layout(path.join(home, ".exxperts-work"));
const server = new LiveServer();
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	await plantState(main, gatewayPort);
	const guide = path.join(main.store, "guide");

	await server.start({ ...smokeHomeEnv(home), EXXPERTS_CODING_AGENT_DIR: main.agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: main.agentsRoot });
	const room = await server.createRoom("Skills Room");
	await server.setWorkspace(room, "localFiles", true);
	const switched = await server.skillAction(room, "enable", "guide");
	assert((switched?.skills ?? []).find((s: any) => s.name === "guide")?.status === "ok", "the guide skill must be on");
	for (const name of linksAllowed ? ["picked", "linked"] : ["picked"]) {
		const on = await server.skillAction(room, "enable", name);
		assert((on?.skills ?? []).some((s: any) => s.name === name), `the ${name} skill must be on`);
	}

	// 1. Reading the folder of the skill that is on, never approved: every path
	// form that lands in it opens; the folder of a skill that isn't on, and the
	// skills folder around them, don't.
	const readCalls = [
		read(path.join(guide, "reference.md")),
		read("~/.exxperts/agent/skills/guide/reference.md"),
		read(path.relative(workspaceRoot, path.join(guide, "reference.md"))),
		read(literal(main.store, "guidebook", "..", "guide", "reference.md")),
		read(path.join(fs.realpathSync.native(guide), "reference.md")),
		read(path.join(guide, "provenance.json")),
		ls(guide),
		find("*.md", guide),
		grep("NEEDLE", guide),
		readSkill("guide"),
		read(path.join(main.store, "guidebook", "notes.md")),
		ls(main.store),
		find("*.md", main.store),
		grep("NEEDLE", main.store),
		read(path.join(main.store, "picked", "notes.md")),
		...(linksAllowed ? [read(path.join(main.store, "linked", "notes.md"))] : []),
	];
	const r1 = await server.runTurn(room, "conv-read", readCalls);
	opened(r1[0], REFERENCE, "reading the guide skill's file by its absolute path");
	opened(r1[1], REFERENCE, "the ~ form");
	opened(r1[2], REFERENCE, "a path relative to the room's folder");
	opened(r1[3], REFERENCE, "a .. form that lands inside the guide skill's folder");
	opened(r1[4], REFERENCE, "the folder's real path");
	opened(r1[5], "\"source\"", "reading provenance.json");
	opened(r1[6], "reference.md", "ls of the guide skill's folder");
	assert(!r1[6].includes(".env"), `ls must leave out the secret file, got: ${r1[6]}`);
	opened(r1[7], "reference.md", "find started inside the guide skill's folder");
	opened(r1[8], REFERENCE, "grep started at the guide skill's folder");
	assert(!r1[8].includes(SECRET) && !r1[8].includes(AUTH), `grep must leave out secrets and the auth file, got: ${r1[8]}`);
	assert(r1[9].includes(guide) && r1[9].includes("Read them with the read tool"), `read_skill must hand over the skill's folder and say it can be read, got: ${r1[9].slice(-900)}`);
	refused(r1[10], "a skill that isn't on");
	refused(r1[11], "ls of the skills folder");
	refused(r1[12], "find over the skills folder");
	refused(r1[13], "grep over the skills folder");
	opened(r1[14], OTHER, "the folder of a skill that is on and picked by hand only");
	if (linksAllowed) refused(r1[15], "the folder of a skill that is on but is a link");
	// Switched off in the room, the skill picked by hand only opens nothing.
	await server.skillAction(room, "disable", "picked");
	const [pickedOff] = await server.runTurn(room, "conv-picked-off", [read(path.join(main.store, "picked", "notes.md"))]);
	refused(pickedOff, "the folder of a skill picked by hand only, switched off");

	// 2. What stays closed in the same live session: no room changes a skill.
	const closedCalls = [
		read(path.join(guide, ".env")),
		read(literal(main.store, "..", "auth.json")),
		read(path.join(main.agentDir, "auth.json")),
		read(path.join(main.appRoot, "persistent-agent-ai-profile.json")),
		find("*.md", home),
		grep("NEEDLE", home),
		write(path.join(guide, "reference.md"), "changed\n"),
		edit(path.join(guide, "scripts", "hello.sh"), "echo hello", "echo changed"),
		write(path.join(guide, "provenance.json"), "{}\n"),
		write(path.join(main.store, "made-here", "SKILL.md"), "---\nname: made-here\ndescription: Written by a room\n---\n\nHello.\n"),
		write(literal(main.store, "..", "auth.json"), "{}\n"),
		write(main.store, "x\n"),
		...(linksAllowed ? [read(path.join(guide, "link-to-auth")), write(path.join(guide, "link-to-auth"), "{}\n")] : []),
	];
	const r2 = await server.runTurn(room, "conv-closed", closedCalls);
	secretRefused(r2[0], "a secret file inside the guide skill's folder");
	refused(r2[1], "skills/../auth.json");
	refused(r2[2], "the auth file beside the skills folder");
	refused(r2[3], "the rest of the app's data");
	refused(r2[4], "find started above the room's folder");
	refused(r2[5], "grep started above the room's folder");
	refused(r2[6], "writing a file in the guide skill's folder");
	refused(r2[7], "editing the guide skill's script");
	refused(r2[8], "writing a skill's provenance.json");
	refused(r2[9], "writing a new skill");
	refused(r2[10], "writing skills/../auth.json");
	refused(r2[11], "writing the skills folder itself");
	if (linksAllowed) {
		refused(r2[12], "a link inside the guide skill's folder that points at the auth file");
		refused(r2[13], "writing through that link");
	}
	assert(fs.readFileSync(path.join(main.agentDir, "auth.json"), "utf8").includes(AUTH), "the auth file must be untouched");
	assert(fs.readFileSync(path.join(guide, "reference.md"), "utf8") === `${REFERENCE}\n` && fs.readFileSync(path.join(guide, "scripts", "hello.sh"), "utf8") === "echo hello\n", "the guide skill's files must be untouched");
	assert(!fs.existsSync(path.join(main.store, "made-here")), "no room may write a skill");
	const shortGuide = shortName(guide);
	if (shortGuide) {
		const [short] = await server.runTurn(room, "conv-short", [read(path.join(shortGuide, "reference.md"))]);
		opened(short, REFERENCE, "the folder's 8.3 short name, which names the same folder");
	} else {
		console.log(process.platform === "win32" ? "SKIPPED: the 8.3 case (this volume has no short names)" : "SKIPPED: the 8.3 case (short names exist only on Windows)");
	}

	// 2b. A shared-folder skill linked to a real folder inside ~/.agents: it reads through the file tools at its
	// real folder, is never written, and a link inside it to a file outside opens nothing.
	const sharedReal = path.join(home, ".agents", "kept", "shared-guide");
	fs.mkdirSync(sharedReal, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(sharedReal, "SKILL.md"), "---\nname: shared-guide\ndescription: A guide kept in the shared folder\n---\n\nRead reference.md.\n", { mode: 0o600 });
	fs.writeFileSync(path.join(sharedReal, "reference.md"), `${REFERENCE}\n`, { mode: 0o600 });
	fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
	fs.symlinkSync(sharedReal, path.join(home, ".agents", "skills", "shared-guide"), process.platform === "win32" ? "junction" : "dir");
	if (linksAllowed) fs.symlinkSync(path.join(main.agentDir, "auth.json"), path.join(sharedReal, "link-to-auth"));
	await server.skillAction(room, "enable", "shared-guide");
	const sharedFolder = fs.realpathSync.native(sharedReal);
	const r2b = await server.runTurn(room, "conv-shared", [
		read(path.join(sharedFolder, "reference.md")),
		readSkill("shared-guide"),
		write(path.join(sharedFolder, "reference.md"), "changed\n"),
		edit(path.join(sharedFolder, "reference.md"), "REFERENCE", "CHANGED"),
		...(linksAllowed ? [read(path.join(sharedFolder, "link-to-auth"))] : []),
	]);
	opened(r2b[0], REFERENCE, "a shared-folder skill's file at its real folder inside ~/.agents");
	assert(r2b[1].includes(`This skill's bundled files live at:\n${sharedFolder}`), `read_skill hands over the shared skill's real folder, got: ${r2b[1].slice(-900)}`);
	refused(r2b[2], "writing a file in the shared skill's folder");
	refused(r2b[3], "editing a file in the shared skill's folder");
	if (linksAllowed) refused(r2b[4], "a link inside the shared skill's folder to the auth file");
	assert(fs.readFileSync(path.join(sharedReal, "reference.md"), "utf8") === `${REFERENCE}\n`, "the shared skill's files must be untouched");

	// 2c. Shared-folder skills linked outside ~/.agents: one elsewhere reads through the file tools at its real folder
	// and is never written; one in the room's own folder is written there as the room's folder is.
	const sharedSkill = (real: string, name: string): string => {
		fs.mkdirSync(real, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(real, "SKILL.md"), `---\nname: ${name}\ndescription: A guide kept elsewhere\n---\n\nRead reference.md.\n`, { mode: 0o600 });
		fs.writeFileSync(path.join(real, "reference.md"), `${REFERENCE}\n`, { mode: 0o600 });
		fs.symlinkSync(real, path.join(home, ".agents", "skills", name), process.platform === "win32" ? "junction" : "dir");
		return fs.realpathSync.native(real);
	};
	const awayGuide = sharedSkill(path.join(home, "team-guides", "away-guide"), "away-guide");
	const roomGuide = sharedSkill(path.join(workspaceRoot, "team-skills", "room-guide"), "room-guide");
	await server.skillAction(room, "enable", "away-guide");
	await server.skillAction(room, "enable", "room-guide");
	const r2c = await server.runTurn(room, "conv-shared-away", [
		read(path.join(awayGuide, "reference.md")),
		readSkill("away-guide"),
		write(path.join(awayGuide, "reference.md"), "changed\n"),
		write(path.join(roomGuide, "notes.md"), "kept\n"),
	]);
	opened(r2c[0], REFERENCE, "a shared-folder skill's file at its real folder outside ~/.agents");
	assert(r2c[1].includes(`This skill's bundled files live at:\n${awayGuide}`), `read_skill hands over the real folder outside ~/.agents, got: ${r2c[1].slice(-900)}`);
	refused(r2c[2], "writing a file in a shared skill's folder outside ~/.agents");
	assert(fs.readFileSync(path.join(awayGuide, "reference.md"), "utf8") === `${REFERENCE}\n`, "the shared skill's files outside ~/.agents must be untouched");
	assert(!r2c[3].includes(REFUSED) && !r2c[3].includes(READ_ONLY) && fs.readFileSync(path.join(roomGuide, "notes.md"), "utf8") === "kept\n", `a write in the room's own folder where a skill's folder is lands, got: ${r2c[3].slice(0, 500)}`);

	// 3. The terminal doesn't decide it: with Bash off the skill's folder still
	// opens for reading only. A bounded room follows the same rule.
	await server.setWorkspace(room, "localFiles", false);
	const r3 = await server.runTurn(room, "conv-bash-off", [read(path.join(guide, "reference.md")), write(path.join(guide, "reference.md"), "x\n"), read(path.join(main.store, "guidebook", "notes.md")), ls(main.store)]);
	opened(r3[0], REFERENCE, "the guide skill's folder with Bash off");
	refused(r3[1], "writing the guide skill's folder with Bash off");
	refused(r3[2], "a skill that isn't on, with Bash off");
	assert(r3[3].includes(`${main.store} ${SKILLS}`), `listing the skills folder with Bash off is refused as the skills folder, got: ${r3[3].slice(0, 500)}`);
	const bounded = await server.createRoom("Bounded Room");
	await server.setWorkspace(bounded, "bounded", false);
	const [boundedBefore] = await server.runTurn(bounded, "conv-bounded-before", [read(path.join(guide, "reference.md"))]);
	refused(boundedBefore, "a skill that isn't on in this bounded room");
	await server.skillAction(bounded, "enable", "guide");
	const boundedAfter = await server.runTurn(bounded, "conv-bounded-after", [read(path.join(guide, "reference.md")), write(path.join(guide, "reference.md"), "x\n")]);
	opened(boundedAfter[0], REFERENCE, "the guide skill's folder in a bounded room");
	refused(boundedAfter[1], "writing the guide skill's folder from a bounded room");
	await server.setWorkspace(room, "localFiles", true);
	await server.stop();

	// 4. A background run of the same room, through the real background run:
	// the same fence. Then the person changes the skill's script, and the folder
	// stays open, the script as it now is, with no step by the person.
	delete process.env.EXXPERTS_STATE_HOME;
	delete process.env.EXXPERTS_DATA_DIR;
	Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXPERTS_CODING_AGENT_DIR: main.agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: main.agentsRoot, EXXETA_HOME: repoRoot });
	const { executePersistentRoomBackgroundPrompt } = await import("../src/persistent-room-background-execution.js");
	const runInBackground = async (executionId: string, calls: ScriptedCall[]): Promise<string[]> => {
		script = calls;
		turnResults = null;
		await executePersistentRoomBackgroundPrompt({
			roomId: room,
			target: { kind: "fresh-thread", model: { provider: "openai-compatible", model: "room-model" } },
			prompt: "Please use the guide skill.",
			executionId,
			cwd: workspaceRoot,
			agentDir: main.agentDir,
		} as any);
		const results = turnResults as string[] | null;
		assert(results && results.length === calls.length, `the background run must call each tool once, got ${JSON.stringify(results)}`);
		return results;
	};
	const outsideFile = path.join(tempRoot, "outside.md");
	fs.writeFileSync(outsideFile, `${OTHER}\n`);
	const background = await runInBackground("skills-folder-background", [read(path.join(guide, "reference.md")), write(path.join(guide, "reference.md"), "x\n"), write(path.join(workspaceRoot, ".mcp.json"), "{}\n"), read(outsideFile)]);
	opened(background[0], REFERENCE, "the guide skill's folder in a background run");
	refused(background[1], "writing the guide skill's folder in a background run");
	assert(background[2].includes(READ_ONLY) && !/command/i.test(background[2]), `a background run's refused write offers no command, got: ${background[2].slice(0, 500)}`);
	assert(background[3].includes(OUTSIDE) && !background[3].includes(OTHER), `a background run stops at the room's folder too, got: ${background[3].slice(0, 500)}`);
	fs.writeFileSync(path.join(guide, "scripts", "hello.sh"), "echo changed by the person\n", { mode: 0o700 });
	const [afterChange, changedScript] = await runInBackground("skills-folder-background-changed", [read(path.join(guide, "reference.md")), read(path.join(guide, "scripts", "hello.sh"))]);
	opened(afterChange, REFERENCE, "a skill whose files changed since it was switched on");
	opened(changedScript, "echo changed by the person", "the changed script, as it now is");

	// 5. A data profile: the skill on under <home>/.exxperts-work opens
	// the same way, found from the profile; the main store's skill and the
	// profile's auth file don't.
	await plantState(profile, gatewayPort);
	const profileGuide = path.join(profile.store, "guide");
	await server.start({ ...smokeHomeEnv(home), EXXPERTS_STATE_HOME: profile.stateRoot, EXXETA_PERSISTENT_AGENTS_ROOT: profile.agentsRoot });
	const profileRoom = await server.createRoom("Profile Room");
	await server.setWorkspace(profileRoom, "localFiles", true);
	await server.skillAction(profileRoom, "enable", "guide");
	const r5 = await server.runTurn(profileRoom, "conv-profile", [
		read(path.join(profileGuide, "reference.md")),
		write(path.join(profile.store, "made-in-profile", "SKILL.md"), "---\nname: made-in-profile\ndescription: x\n---\n\nx\n"),
		read(path.join(profile.agentDir, "auth.json")),
		read(path.join(main.store, "guide", "reference.md")),
	]);
	opened(r5[0], REFERENCE, "the profile's skill that is on");
	refused(r5[1], "writing into the profile's skills folder");
	assert(!fs.existsSync(path.join(profile.store, "made-in-profile")), "no room may write a skill in a profile");
	refused(r5[2], "the profile's auth file");
	refused(r5[3], "the skill folder outside the loaded profile");

	console.log("full-access-skills-folder-smoke: OK");
} catch (error) {
	console.error(server.output.join("").slice(-6000));
	throw error;
} finally {
	try { gateway.close(); } catch {}
	await server.stop();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
