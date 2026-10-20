import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

// A live Full access room with the terminal on reads and writes the person's
// skills folder again, through the file tools the live session really gets:
// a real server, a synthetic gateway that plays the model and calls the
// tools, and each tool's result read back from the next completion request.
// The rest of the app's data stays closed, provenance.json stays unwritable,
// the version pins still catch a room's edits, and bash off, a bounded room,
// a background run and a data profile behave as they must. Throwaway HOME.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;

// Not resolved to its real path on purpose: on macOS the temp folder is a
// link (/var to /private/var), so the paths the room uses differ from the
// real ones, as they can on a person's machine.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-folder-"));
const home = path.join(tempRoot, "home");
const workspaceRoot = path.join(tempRoot, "workspace");
fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

const REFUSED = "so rooms don't open it";
const READ_ONLY = "can be read but not changed by rooms";
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
		this.process = spawn(process.execPath, ["--import", tsxLoader, "src/index.ts"], {
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
	// of every scripted call once the turn has ended on the server.
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
				// agent_end precedes release of the room's turn guard; closing early can cancel cleanup.
				const status = await this.json(`/api/persistent-agents/${encodeURIComponent(agentId)}/status`);
				assert(status.status === 200, `room status: expected 200, got ${status.status}`);
				assert(status.body?.activeThread?.threadId === conversationId, "the scripted conversation must remain active until its turn finishes");
				if (status.body.activeThread.inFlight === false) {
					try { socket.close(); } catch {}
					const results = turnResults as string[];
					assert(results.length === calls.length, `expected ${calls.length} tool results, got ${results.length}`);
					return results;
				}
			}
			const errors = frames.filter((frame) => String(frame?.type ?? "").includes("error"));
			if (errors.length > 0) throw new Error(`turn errored: ${JSON.stringify(errors[0]).slice(0, 400)}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`turn did not run its tool calls and end; frame types: ${frames.map((f) => f?.type).join(", ")}`);
	}
}

function opened(result: string, needle: string, what: string): void {
	assert(!result.includes(REFUSED) && result.includes(needle), `${what} must open, got: ${result.slice(0, 500)}`);
}

function refused(result: string, what: string): void {
	assert(result.includes(REFUSED) || result.includes(READ_ONLY), `${what} must be refused by the floor, got: ${result.slice(0, 500)}`);
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
	const result = spawnSync("cmd", ["/c", `for %I in ("${dir}") do @echo %~sI`], { encoding: "utf8" });
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
	await server.skillAction(room, "enable", "guide");
	const approved = await server.skillAction(room, "approve-execution", "guide");
	assert((approved?.skills ?? []).find((s: any) => s.name === "guide")?.executeState === "approved", "the guide skill must report its execution approved");

	// 1. Reading: every path form that lands in the skills folder opens; the
	// first call is the one origin/main refuses.
	const readCalls = [
		read(path.join(guide, "reference.md")),
		read("~/.exxperts/agent/skills/guide/reference.md"),
		read(path.relative(workspaceRoot, path.join(guide, "reference.md"))),
		read(literal(main.store, "guidebook", "..", "guide", "reference.md")),
		read(path.join(fs.realpathSync.native(guide), "reference.md")),
		read(path.join(main.store, "guidebook", "notes.md")),
		read(path.join(guide, "provenance.json")),
		ls(guide),
		ls(main.store),
		find("*.md", guide),
		grep("NEEDLE", main.store),
		readSkill("guide"),
	];
	const r1 = await server.runTurn(room, "conv-read", readCalls);
	opened(r1[0], REFERENCE, "reading a skill's file by its absolute path");
	opened(r1[1], REFERENCE, "the ~ form");
	opened(r1[2], REFERENCE, "a path relative to the session's folder");
	opened(r1[3], REFERENCE, "a .. form that lands inside the skills folder");
	opened(r1[4], REFERENCE, "the folder's real path");
	opened(r1[5], OTHER, "another skill's file");
	opened(r1[6], "\"source\"", "reading provenance.json");
	opened(r1[7], "reference.md", "ls of a skill folder");
	assert(!r1[7].includes(".env"), `ls must leave out the secret file, got: ${r1[7]}`);
	opened(r1[8], "guidebook", "ls of the skills folder");
	opened(r1[9], "reference.md", "find started inside a skill folder");
	opened(r1[10], REFERENCE, "grep started at the skills folder");
	assert(r1[10].includes(OTHER), `grep over the skills folder must see every skill, got: ${r1[10]}`);
	assert(!r1[10].includes(SECRET) && !r1[10].includes(AUTH), `grep must leave out secrets and the auth file, got: ${r1[10]}`);
	assert(r1[11].includes(guide) && r1[11].includes("Read them with the read tool"), `read_skill must hand over the approved folder and say it can be read, got: ${r1[11].slice(-900)}`);

	// 2. What stays closed in the same live session.
	const closedCalls = [
		read(path.join(guide, ".env")),
		read(literal(main.store, "..", "auth.json")),
		read(path.join(main.agentDir, "auth.json")),
		read(path.join(main.appRoot, "persistent-agent-ai-profile.json")),
		read(path.join(home, ".EXXPERTS", "agent", "skills", "guide", "reference.md")),
		read(path.join(path.dirname(main.store), "Skills", "guide", "reference.md")),
		find("*.md", home),
		grep("NEEDLE", home),
		write(path.join(guide, "provenance.json"), "{}\n"),
		edit(path.join(guide, "provenance.json"), "upload", "local"),
		write(path.join(main.store, "made-here", "provenance.json"), "{}\n"),
		write(literal(main.store, "..", "auth.json"), "{}\n"),
		write(path.join(guide, ".git"), "gitdir: /elsewhere\n"),
		write(literal(guide, "provenance.json", "."), "{}\n"),
		write(main.store, "x\n"),
		find("**/.exxperts/**/*.md", home),
		{ name: "grep", args: { pattern: "NEEDLE", path: home, glob: "**/.exxperts/**" } },
		...(linksAllowed ? [read(path.join(guide, "link-to-auth")), write(path.join(guide, "link-to-auth"), "{}\n")] : []),
	];
	const r2 = await server.runTurn(room, "conv-closed", closedCalls);
	secretRefused(r2[0], "a secret file inside a skill folder");
	refused(r2[1], "skills/../auth.json");
	refused(r2[2], "the auth file beside the skills folder");
	refused(r2[3], "the rest of the app's data");
	refused(r2[4], "the path to the skills folder spelled in another case");
	refused(r2[5], "the skills folder spelled in another case");
	assert(!r2[6].includes("reference.md") && !r2[6].includes("notes.md"), `find started above the app's data must leave it out, got: ${r2[6].slice(0, 500)}`);
	assert(!r2[7].includes(REFERENCE) && !r2[7].includes(AUTH), `grep started above the app's data must leave it out, got: ${r2[7].slice(0, 500)}`);
	refused(r2[8], "writing a skill's provenance.json");
	refused(r2[9], "editing a skill's provenance.json");
	refused(r2[10], "writing provenance.json into a new skill");
	refused(r2[11], "writing skills/../auth.json");
	refused(r2[12], "writing a .git file into a skill folder");
	refused(r2[13], "writing provenance.json with a trailing .");
	refused(r2[14], "writing the skills folder itself");
	assert(!r2[15].includes("reference.md") && !r2[15].includes("notes.md"), `a find glob naming the app's data from above must still leave it out, got: ${r2[15].slice(0, 500)}`);
	assert(!r2[16].includes(REFERENCE) && !r2[16].includes(AUTH) && !r2[16].includes(SECRET), `a grep glob naming the app's data from above must still leave it out, got: ${r2[16].slice(0, 500)}`);
	if (linksAllowed) {
		refused(r2[17], "a link inside a skill folder that points at the auth file");
		refused(r2[18], "writing through that link");
	}
	assert(fs.readFileSync(path.join(main.agentDir, "auth.json"), "utf8").includes(AUTH), "the auth file must be untouched");
	assert(!fs.existsSync(path.join(main.store, "made-here", "provenance.json")), "no provenance.json may be written by a room");
	const shortGuide = shortName(guide);
	if (shortGuide) {
		const [short] = await server.runTurn(room, "conv-short", [read(path.join(shortGuide, "reference.md"))]);
		refused(short, "the folder's 8.3 short name");
	} else {
		console.log(process.platform === "win32" ? "SKIPPED: the 8.3 case (this volume has no short names)" : "SKIPPED: the 8.3 case (short names exist only on Windows)");
	}

	// 3. Writing opens, and the version pins catch what a room changed: a new
	// script voids the run approval, a new SKILL.md needs the person's review.
	const writeCalls = [
		write(path.join(main.store, "made-here", "SKILL.md"), "---\nname: made-here\ndescription: Written by a room\n---\n\nHello.\n"),
		edit(path.join(guide, "scripts", "hello.sh"), "echo hello", "echo changed"),
		readSkill("guide"),
		edit(path.join(guide, "SKILL.md"), "then run scripts/hello.sh.", "then run scripts/hello.sh twice."),
		readSkill("guide"),
	];
	const r3 = await server.runTurn(room, "conv-write", writeCalls);
	assert(!r3[0].includes(REFUSED) && fs.existsSync(path.join(main.store, "made-here", "SKILL.md")), `writing a new skill must open, got: ${r3[0].slice(0, 300)}`);
	assert(!r3[1].includes(REFUSED) && fs.readFileSync(path.join(guide, "scripts", "hello.sh"), "utf8").includes("changed"), `editing a skill's script must open, got: ${r3[1].slice(0, 300)}`);
	assert(r3[2].includes("Read reference.md") && !r3[2].includes(guide), `a changed script must void the run approval, got: ${r3[2].slice(-600)}`);
	assert(!r3[3].includes(REFUSED) && fs.readFileSync(path.join(guide, "SKILL.md"), "utf8").includes("twice"), `editing a skill's SKILL.md must open, got: ${r3[3].slice(0, 300)}`);
	assert(r3[4].includes("changed since the user enabled it") && !r3[4].includes("twice"), `a changed SKILL.md must need review, got: ${r3[4].slice(0, 400)}`);
	assert(!fs.existsSync(path.join(main.store, "made-here", "provenance.json")), "a skill a room wrote must have no provenance");
	const library = await server.json("/api/skills");
	assert(library.status === 200 && Array.isArray(library.body), `the Skills list: expected 200 and a list, got ${library.status}`);
	assert(library.body.some((skill: any) => skill?.name === "made-here"), `a skill a room wrote must appear in the Skills list, got: ${JSON.stringify(library.body.map((skill: any) => skill?.name))}`);

	// 4. Closed again on the next call once the terminal is off, and never
	// open in a bounded room.
	await server.setWorkspace(room, "localFiles", false);
	const r4 = await server.runTurn(room, "conv-bash-off", [read(path.join(guide, "reference.md")), write(path.join(main.store, "made-off", "SKILL.md"), "x\n"), ls(main.store)]);
	refused(r4[0], "reading with the terminal off");
	refused(r4[1], "writing with the terminal off");
	refused(r4[2], "ls with the terminal off");
	assert(!fs.existsSync(path.join(main.store, "made-off")), "nothing may be written with the terminal off");
	const bounded = await server.createRoom("Bounded Room");
	await server.setWorkspace(bounded, "bounded", false);
	const [boundedRead] = await server.runTurn(bounded, "conv-bounded", [read(path.join(guide, "reference.md"))]);
	assert(!boundedRead.includes(REFERENCE), `a bounded room must never read the skills folder, got: ${boundedRead.slice(0, 300)}`);
	await server.setWorkspace(room, "localFiles", true);
	await server.stop();

	// 5. A background run of the same room, terminal on, through the real
	// background run: its file tools never open the skills folder.
	delete process.env.EXXPERTS_STATE_HOME;
	delete process.env.EXXPERTS_DATA_DIR;
	Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXPERTS_CODING_AGENT_DIR: main.agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: main.agentsRoot, EXXETA_HOME: repoRoot });
	const { executePersistentRoomBackgroundPrompt } = await import("../src/persistent-room-background-execution.js");
	script = [read(path.join(guide, "reference.md"))];
	turnResults = null;
	await executePersistentRoomBackgroundPrompt({
		roomId: room,
		target: { kind: "fresh-thread", model: { provider: "openai-compatible", model: "room-model" } },
		prompt: "Please use the guide skill.",
		executionId: "skills-folder-background",
		cwd: workspaceRoot,
		agentDir: main.agentDir,
	} as any);
	const backgroundResults = turnResults as string[] | null;
	assert(backgroundResults && backgroundResults.length === 1, `the background run must call read once, got ${JSON.stringify(backgroundResults)}`);
	refused(backgroundResults[0], "reading the skills folder from a background run");

	// 6. A data profile: the store under <home>/.exxperts-work opens the same
	// way, found from the profile, and its auth file stays closed.
	await plantState(profile, gatewayPort);
	const profileGuide = path.join(profile.store, "guide");
	await server.start({ ...smokeHomeEnv(home), EXXPERTS_STATE_HOME: profile.stateRoot, EXXETA_PERSISTENT_AGENTS_ROOT: profile.agentsRoot });
	const profileRoom = await server.createRoom("Profile Room");
	await server.setWorkspace(profileRoom, "localFiles", true);
	const r6 = await server.runTurn(profileRoom, "conv-profile", [
		read(path.join(profileGuide, "reference.md")),
		write(path.join(profile.store, "made-in-profile", "SKILL.md"), "---\nname: made-in-profile\ndescription: x\n---\n\nx\n"),
		read(path.join(profile.agentDir, "auth.json")),
		read(path.join(main.store, "guide", "reference.md")),
	]);
	opened(r6[0], REFERENCE, "the profile's skills folder");
	assert(!r6[1].includes(REFUSED) && fs.existsSync(path.join(profile.store, "made-in-profile", "SKILL.md")), `writing into the profile's skills folder must open, got: ${r6[1].slice(0, 300)}`);
	refused(r6[2], "the profile's auth file");
	refused(r6[3], "the skills folder outside the loaded profile");
	const profileLibrary = await server.json("/api/skills");
	assert(Array.isArray(profileLibrary.body) && profileLibrary.body.some((skill: any) => skill?.name === "made-in-profile"), `a skill a room wrote in a profile must appear in that profile's Skills list, got: ${JSON.stringify(profileLibrary.body)?.slice(0, 300)}`);

	console.log("full-access-skills-folder-smoke: OK");
} catch (error) {
	console.error(server.output.join("").slice(-6000));
	throw error;
} finally {
	try { gateway.close(); } catch {}
	await server.stop();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
