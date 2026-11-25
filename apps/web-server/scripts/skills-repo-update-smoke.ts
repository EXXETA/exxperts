// Updating a skill added from a repository, through the real server: what an
// add from a repository keeps in the skill's record, adding the same skill
// again as a Replace, a check (one ask per repository and ref, a
// fetch only when it moved, each state), Update (the swap, its refusals, the
// two stops, an update bound to the installation it was found for) and what a
// room's next message is told when a skill's instructions change.
// The repositories are served by a git server on this machine (git's own
// http-backend); the model is a synthetic gateway that keeps every request.
// Throwaway HOME and temp folder; nothing reaches a real host.
//
// Run: node scripts/run-smokes.mjs skills-repo-update

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOM_STATE_HEADING } from "../src/room-state-message.js";
import { classifyRemoteRoute } from "../src/remote-route-policy.js";
import { recordedAddress, resolveRepoSource, shownRepositoryAddress } from "../src/skills-repo-fetch.js";
import { skillUpdatesFailedLine } from "../../web-ui/src/skill-source-copy.js";
import { pairDevice, remoteRequest } from "./smoke-pairing.js";
import { git, gitServesHttp, startStandInGitServer, writeSkill } from "./stand-in-git-server.js";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

if (!gitServesHttp()) {
	console.log("SKIPPED: this git has no http-backend to serve the stand-in repositories");
	process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const { serverLaunchArgs } = createRequire(import.meta.url)(path.join(repoRoot, "bin", "lib", "server-entry.cjs")) as {
	serverLaunchArgs: (root: string, options?: { tsxLoader?: boolean; env?: NodeJS.ProcessEnv }) => string[];
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-update-"));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
const store = path.join(agentDir, "skills");
const serveRoot = path.join(tempRoot, "serve");
const workRoot = path.join(tempRoot, "work");
// The server's own temp folder, where it holds the checkouts a check fetched.
const serverTmp = path.join(tempRoot, "server-tmp");
for (const dir of [agentsRoot, agentDir, appRoot, serveRoot, workRoot, serverTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

// --- Stand-in repositories ------------------------------------------------------

/**
 * The files' hash as the record keeps it, worked out here by hand: each file
 * of the folder but the app's own record, in code point order, its path, a
 * NUL, its size, a NUL, then its bytes.
 */
function filesHash(dir: string): string {
	const files: string[] = [];
	const walk = (rel: string) => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile() && child !== "provenance.json") files.push(child);
		}
	};
	walk("");
	files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const hash = crypto.createHash("sha256");
	for (const file of files) {
		const bytes = fs.readFileSync(path.join(dir, file));
		hash.update(`${file}\0${bytes.length}\0`);
		hash.update(bytes);
	}
	return hash.digest("hex");
}

const standIn = await startStandInGitServer(serveRoot, workRoot);
const { requests: gitRequests, signedOut, held, makeRepo, countFor } = standIn;
const gitPort = standIn.port();

// --- The synthetic model --------------------------------------------------------

interface Call { userTexts: string[]; toolTexts: string[] }
const calls: Call[] = [];
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		calls.push({ userTexts: messages.filter((m) => m?.role === "user").map((m) => textOf(m.content)), toolTexts: messages.filter((m) => m?.role === "tool").map((m) => textOf(m.content)) });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${calls.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 12, total_tokens: 162 } }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

// --- The server -------------------------------------------------------------------

const WebSocketImpl: any = (await import("ws")).default;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let port = 0;
async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const post = (pathname: string, body: unknown) => json(pathname, { method: "POST", body: JSON.stringify(body) });
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		assert(Date.now() < deadline, `timed out waiting until ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
const model = { provider: "openai-compatible", model: "room-model" };
async function startServer(): Promise<void> {
	port = await freePort();
	const env = { ...process.env, ...smokeHomeEnv(home), EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1", EXXPERTS_REMOTE_TEST_ADDRESS: "::1", TMPDIR: serverTmp, TEMP: serverTmp, TMP: serverTmp } as NodeJS.ProcessEnv;
	delete env.EXXPERTS_SERVER_BUNDLE;
	const started = spawn(process.execPath, serverLaunchArgs(repoRoot, { tsxLoader: true, env }), { ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env });
	serverProcess = started;
	started.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	started.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	const ready = Date.now() + 30_000;
	for (;;) {
		assert(Date.now() < ready, "the server came up");
		try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

const record = (name: string) => JSON.parse(fs.readFileSync(path.join(store, name, "provenance.json"), "utf-8"));
/** Adds the skill at `skillPath` of `address` the way the page does: scan, review, then add (or Replace, when the review asks). */
async function addFromRepository(address: string, skillPath: string): Promise<{ candidate: any; added: { status: number; body: any } }> {
	const scan = await post("/api/skills/repo/scan", { source: address });
	assert(scan.status === 200, `the scan of ${address} works, got ${scan.status}: ${JSON.stringify(scan.body)}`);
	const candidate = await post("/api/skills/repo/candidate", { token: scan.body.token, path: skillPath });
	assert(candidate.status === 200, `the review of ${skillPath} opens, got ${candidate.status}: ${JSON.stringify(candidate.body)}`);
	const added = await post("/api/skills/repo/import", { token: scan.body.token, path: skillPath, ...(candidate.body.replaces ? { replace: true } : {}) });
	return { candidate: candidate.body, added };
}

/** Adds the skills at `skillPaths` of `address` from one scan, each as a new skill. */
async function addMany(address: string, skillPaths: string[]): Promise<void> {
	const scan = await post("/api/skills/repo/scan", { source: address });
	assert(scan.status === 200, `the scan of ${address} works, got ${scan.status}: ${JSON.stringify(scan.body)}`);
	for (const skillPath of skillPaths) {
		const added = await post("/api/skills/repo/import", { token: scan.body.token, path: skillPath });
		assert(added.status === 201, `${skillPath} is added, got ${added.status}: ${JSON.stringify(added.body)}`);
	}
}
const LIB = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "mu", "nu", "xi", "omicron"];
/** The version mark the room's index names, worked out here by hand: the start of the SKILL.md's sha256. */
const versionMark = (manifest: string) => crypto.createHash("sha256").update(manifest).digest("hex").slice(0, 12);
/** Checks the named skills; their results by name. */
async function checkUpdates(names: string[]): Promise<Map<string, any>> {
	const answer = await post("/api/skills/updates/check", { names });
	assert(answer.status === 200, `the check works, got ${answer.status}: ${JSON.stringify(answer.body)}`);
	return new Map((answer.body.results as any[]).map((result) => [result.name, result]));
}
const updateOf = (name: string, body: unknown) => post(`/api/skills/${encodeURIComponent(name)}/update`, body);
/** What the page sends for an update a check found: its candidate and the installed files' hash it was shown with. */
const askFor = (result: any) => ({ candidate: result?.candidate?.id, installedFilesSha256: result?.installedFilesSha256 });
const skillView = async (name: string): Promise<any> => ((await json("/api/skills")).body as any[]).find((skill) => skill.name === name);
interface Snapshot { files: string; record: any }
const snapshot = (name: string): Snapshot => ({ files: filesHash(path.join(store, name)), record: record(name) });
/** A skill written straight into the store with the record given: the records an add can't make here. */
function handMade(name: string, provenance: Record<string, unknown>): void {
	writeSkill(store, name, name, `The ${name} instructions.`);
	const manifest = fs.readFileSync(path.join(store, name, "SKILL.md"), "utf-8");
	fs.writeFileSync(path.join(store, name, "provenance.json"), JSON.stringify({ importedAt: new Date().toISOString(), license: null, sha256: crypto.createHash("sha256").update(manifest).digest("hex"), ...provenance }));
}
/** The checkouts in the server's temp folder that hold `rel`. */
function checkoutsHolding(rel: string): string[] {
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (fs.existsSync(path.join(dir, rel))) {
			found.push(dir);
			return;
		}
		if (depth === 0) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && entry.name !== ".git") walk(path.join(dir, entry.name), depth - 1);
	};
	walk(serverTmp, 3);
	return found;
}

const failed: string[] = [];
async function row(name: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
		console.log(`ok ${name}`);
	} catch (error) {
		failed.push(`row ${name}: ${(error as Error).message}`);
		console.log(`FAIL ${name}: ${(error as Error).message}`);
	}
}

let ws: any;
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-update" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	// The repository "skills": pdf on main, and a branch "feature" whose pdf says more.
	const skills = makeRepo("skills");
	writeSkill(skills.work, "skills/pdf", "pdf", "Read PDFs. MAIN-BODY.");
	fs.writeFileSync(path.join(skills.work, "skills", "pdf", "extract.py"), "print('pdf')\n");
	writeSkill(skills.work, "skills/notes", "notes", "Take notes.");
	skills.commit("first");
	skills.push();
	git(skills.work, ["checkout", "-q", "-b", "feature"]);
	writeSkill(skills.work, "skills/pdf", "pdf", "Read PDFs. FEATURE-BODY.");
	const featureCommit = skills.commit("feature work");
	skills.push("HEAD:feature");
	git(skills.work, ["checkout", "-q", "main"]);

	// The repository "lib": fourteen skills, one for each case a check and an update meet.
	const lib = makeRepo("lib");
	for (const name of LIB) writeSkill(lib.work, `skills/${name}`, name, `The ${name} instructions.`);
	writeSkill(lib.work, "skills/gamma", "gamma", "Gamma, first.", "The gamma skill.", 'version: "1.0"\n');
	fs.writeFileSync(path.join(lib.work, "skills", "gamma", "notes.md"), "first notes\n");
	fs.writeFileSync(path.join(lib.work, "skills", "gamma", "old.md"), "old\n");
	const libFirst = lib.commit("first");
	lib.push();

	await startServer();
	const created = await post("/api/persistent-agents", { displayName: "Update Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const room = String(created.body?.agent?.id ?? created.body?.agent?.agentId ?? "");
	assert(created.status === 201 && room, `room created, got ${created.status}`);
	const switchOn = async (name: string) => {
		const answer = await json(`/api/persistent-agents/${encodeURIComponent(room)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name }) });
		assert(answer.status === 200, `switching ${name} on: ${answer.status} ${JSON.stringify(answer.body)}`);
	};
	/** The rooms the library lists for a skill: a room whose entry is of a skill since deleted is not among them. */
	const roomsOf = async (name: string): Promise<string[]> => ((await json("/api/skills")).body as any[]).find((skill) => skill.name === name)?.rooms.map((ref: any) => ref.id) ?? [];

	// --- 1. An add from an address with #branch keeps the ref, its kind, the folder, the commit and the files' hash.
	await row("1 an add from #branch keeps the ref, its kind, the folder, the commit and the files' hash", async () => {
		const { added } = await addFromRepository(`${skills.url}#feature`, "skills/pdf");
		assert(added.status === 201, `the add works, got ${added.status}: ${JSON.stringify(added.body)}`);
		const kept = record("pdf").repository;
		const wanted = { address: skills.url, ref: "feature", refKind: "branch", path: "skills/pdf", commit: featureCommit, filesSha256: filesHash(path.join(store, "pdf")) };
		assert(JSON.stringify(kept) === JSON.stringify(wanted), `the record keeps ${JSON.stringify(wanted)}, got ${JSON.stringify(kept)}`);
		assert(fs.readFileSync(path.join(store, "pdf", "SKILL.md"), "utf-8").includes("FEATURE-BODY"), "the branch's version is the one added");
	});

	// --- 2. Adding the same skill again offers Replace instead of the bare 409, keeps its identity and its rooms.
	await row("2 adding the same skill again offers Replace and keeps it on in its rooms", async () => {
		await switchOn("pdf");
		const identity = record("pdf").identity;
		const { candidate, added } = await addFromRepository(skills.url, "skills/pdf");
		assert(candidate.replaces === true, `the review asks to replace it, got ${JSON.stringify(candidate)}`);
		assert(added.status === 200, `the Replace works, got ${added.status}: ${JSON.stringify(added.body)}`);
		assert(record("pdf").identity === identity, "the skill keeps its identity");
		assert(record("pdf").repository?.ref === undefined && record("pdf").repository?.refKind === "default", `the repository it was added from again is stored, got ${JSON.stringify(record("pdf").repository)}`);
		assert(fs.readFileSync(path.join(store, "pdf", "SKILL.md"), "utf-8").includes("MAIN-BODY"), "the new version is in place");
		assert((await roomsOf("pdf")).includes(room), `the room keeps it on, got ${JSON.stringify(await roomsOf("pdf"))}`);
	});

	// --- 3. An update that changes only the instructions reaches the room's next message.
	await row("3 an update that changes only the instructions tells the room's next message to read it again", async () => {
		const conversationId = "conv-update";
		const threadPath = `/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversationId}`;
		assert((await json(threadPath, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model, items: [] }) })).status === 200, "thread seeded");
		const frames: any[] = [];
		ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${room}&conversationId=${conversationId}&modelProvider=${model.provider}&model=${model.model}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
		ws.addEventListener("message", (event: any) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
		await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
		await waitUntil(() => frames.some((frame) => frame.type === "ready"), "the room is ready");
		const turn = async (text: string): Promise<Call> => {
			const before = calls.length;
			const mark = frames.length;
			ws.send(JSON.stringify({ type: "prompt", text }));
			await waitUntil(() => frames.slice(mark).some((frame) => frame.type === "event" && frame.event?.type === "agent_end"), `the turn for ${text} ended`);
			await waitUntil(() => calls.length > before, "the model was asked");
			return calls[calls.length - 1];
		};
		const stateCopies = (call: Call) => call.userTexts.filter((text) => text.startsWith(ROOM_STATE_HEADING));
		const manifest = path.join(store, "pdf", "SKILL.md");
		const first = await turn("Hello.");
		const oldLine = `- pdf \u2014 The pdf skill. (version ${versionMark(fs.readFileSync(manifest, "utf-8"))})`;
		assert(stateCopies(first).some((copy) => copy.includes(oldLine)), `the first message is told pdf is on, with its version, got ${JSON.stringify(stateCopies(first))}`);
		// The repository changes the instructions, and nothing else: the name and the description stay.
		writeSkill(skills.work, "skills/pdf", "pdf", "Read PDFs. CHANGED-BODY.");
		skills.commit("instructions only");
		skills.push();
		const found = (await checkUpdates(["pdf"])).get("pdf");
		assert(found?.state === "available", `the check finds the new version, got ${JSON.stringify(found)}`);
		assert(JSON.stringify(found.candidate.changes) === JSON.stringify({ added: [], removed: [], changed: [{ path: "SKILL.md", kind: "instructions" }] }), `only the instructions change, got ${JSON.stringify(found.candidate.changes)}`);
		const updated = await updateOf("pdf", askFor(found));
		assert(updated.status === 200, `the update works, got ${updated.status}: ${JSON.stringify(updated.body)}`);
		const second = await turn("Again.");
		const copies = stateCopies(second);
		assert(copies.length === 2 && copies[1] !== copies[0], `the next message gets a new copy of the room's state, got ${copies.length} copies`);
		const newLine = `- pdf \u2014 The pdf skill. (version ${versionMark(fs.readFileSync(manifest, "utf-8"))})`;
		assert(newLine !== oldLine && copies[0].includes(oldLine) && !copies[0].includes(newLine), `the first copy names the old version only, got ${copies[0]}`);
		assert(copies[1].includes(newLine) && !copies[1].includes(oldLine), `the new copy names the new version only, got ${copies[1]}`);
		// The index's standing line tells the room what a changed version means.
		assert(copies[1].includes("has been updated since: read it again before using it"), `the new copy says a changed version is to be read again, got ${copies[1]}`);
	});

	// --- The record ---------------------------------------------------------------

	await row("4 an add from an address with a user name stores the address without it", async () => {
		await addMany(`http://tokenuser@127.0.0.1:${gitPort}/team/lib.git`, LIB.map((name) => `skills/${name}`));
		for (const name of LIB) {
			const wanted = { address: lib.url, refKind: "default", path: `skills/${name}`, commit: libFirst, filesSha256: filesHash(path.join(store, name)) };
			assert(JSON.stringify(record(name).repository) === JSON.stringify(wanted), `${name}'s record keeps ${JSON.stringify(wanted)}, got ${JSON.stringify(record(name).repository)}`);
			assert(!fs.readFileSync(path.join(store, name, "provenance.json"), "utf-8").includes("tokenuser"), `${name}'s record keeps no user name`);
		}
		const listed = await skillView("alpha");
		assert(listed?.repository?.address === lib.url && !JSON.stringify(listed).includes("tokenuser"), `GET /api/skills shows the address without the user name, got ${JSON.stringify(listed?.repository)}`);
	});

	await row("5 an SSH address keeps its login in the record, and the page shows it without", async () => {
		const ssh = resolveRepoSource("ssh://git@git.example.com/team/tools.git#main");
		assert(ssh.ok && recordedAddress(ssh.value) === "ssh://git@git.example.com/team/tools.git", `an ssh:// address keeps git@, got ${ssh.ok ? recordedAddress(ssh.value) : ssh.error}`);
		const https = resolveRepoSource("https://tok3n@git.example.com/team/tools.git");
		assert(https.ok && recordedAddress(https.value) === "https://git.example.com/team/tools.git", `an https address keeps no user name, got ${https.ok ? recordedAddress(https.value) : https.error}`);
		assert(shownRepositoryAddress("ssh://git@git.example.com/team/tools.git") === "ssh://git.example.com/team/tools.git", "the shown address leaves the SSH login out");
		handMade("upsilon", { source: "ssh://git.example.com/team/tools.git", repository: { address: "ssh://git@git.example.com/team/tools.git", refKind: "default", path: "skills/upsilon", commit: "1".repeat(40), filesSha256: "" } });
		const listed = await skillView("upsilon");
		assert(listed?.repository?.address === "ssh://git.example.com/team/tools.git", `GET /api/skills shows the SSH address without its login, got ${JSON.stringify(listed?.repository)}`);
		assert(record("upsilon").repository.address === "ssh://git@git.example.com/team/tools.git", "the record keeps the SSH login");
	});

	// --- The check ----------------------------------------------------------------

	await row("6 a check asks each repository and ref once, and fetches nothing when it didn't move", async () => {
		gitRequests.length = 0;
		const results = await checkUpdates(LIB);
		for (const name of LIB) assert(results.get(name)?.state === "current", `${name} is current, got ${JSON.stringify(results.get(name))}`);
		assert(JSON.stringify(countFor("lib")) === JSON.stringify({ asks: 1, fetches: 0 }), `fourteen skills of one repository: one ask and no fetch, got ${JSON.stringify(countFor("lib"))}`);
	});

	await row("7 a check of a name that isn't a skill of the person's own is refused", async () => {
		const answer = await post("/api/skills/updates/check", { names: ["alpha", "no-such-skill"] });
		assert(answer.status === 400 && answer.body?.code === "unknown-skill", `unknown name: 400, got ${answer.status} ${JSON.stringify(answer.body)}`);
		const known = await post("/api/skills/updates/check", { names: ["alpha"] });
		assert(known.status === 200, `a known name passes, got ${known.status}`);
	});

	// The repository moves: each skill's case, in one commit.
	const libWork = (rel: string) => path.join(lib.work, rel);
	const before = new Map<string, Snapshot>();
	let libSecond = "";
	let libChecked = new Map<string, any>();
	await row("8 a moved repository: one fetch, each skill's state, and every skill as it was", async () => {
		writeSkill(lib.work, "skills/gamma", "gamma", "Gamma, second.", "The gamma skill.", 'version: "2.0"\n');
		fs.writeFileSync(libWork("skills/gamma/notes.md"), "second notes\n");
		fs.rmSync(libWork("skills/gamma/old.md"));
		fs.writeFileSync(libWork("skills/gamma/run.py"), "print('run')\n");
		fs.mkdirSync(libWork("moved"), { recursive: true });
		fs.renameSync(libWork("skills/delta"), libWork("moved/delta"));
		for (const copy of ["a", "b"]) fs.cpSync(libWork("skills/epsilon"), libWork(`${copy}/epsilon`), { recursive: true });
		fs.rmSync(libWork("skills/epsilon"), { recursive: true });
		writeSkill(lib.work, "skills/zeta", "zeta-two", "The zeta instructions.", "The zeta skill.");
		fs.rmSync(libWork("skills/eta"), { recursive: true });
		writeSkill(lib.work, "skills/theta", "theta", "The theta instructions,\u200b second.");
		for (const name of ["iota", "mu", "nu", "xi", "omicron"]) writeSkill(lib.work, `skills/${name}`, name, `The ${name} instructions, second.`);
		fs.writeFileSync(libWork("skills/kappa/big.bin"), Buffer.alloc(9 * 1024 * 1024, 0x61));
		libSecond = lib.commit("second");
		lib.push();
		// iota is changed on this computer.
		const iota = path.join(store, "iota", "SKILL.md");
		fs.writeFileSync(iota, fs.readFileSync(iota, "utf-8").replace("The iota instructions.", "The iota instructions, edited here."));
		for (const name of LIB) before.set(name, snapshot(name));
		gitRequests.length = 0;
		libChecked = await checkUpdates(LIB);
		const states = Object.fromEntries(LIB.map((name) => [name, libChecked.get(name)?.state]));
		const wanted = { alpha: "current", beta: "current", gamma: "available", delta: "current", epsilon: "gone", zeta: "renamed", eta: "gone", theta: "available", iota: "available", kappa: "available", mu: "available", nu: "available", xi: "available", omicron: "available" };
		assert(JSON.stringify(states) === JSON.stringify(wanted), `each skill's state: ${JSON.stringify(wanted)}, got ${JSON.stringify(states)}`);
		assert(countFor("lib").fetches === 1, `one fetch for the whole repository, got ${JSON.stringify(countFor("lib"))}`);
		assert(libChecked.get("zeta").renamedTo === "zeta-two", `zeta is there as zeta-two, got ${JSON.stringify(libChecked.get("zeta"))}`);
		for (const name of LIB) {
			const now = snapshot(name);
			assert(now.files === before.get(name)!.files, `${name}'s files are as they were`);
			// A skill whose files didn't change takes the new commit (and a moved folder) quietly; every other record is as it was.
			const quiet = name === "alpha" || name === "beta" || name === "delta";
			const was = before.get(name)!.record;
			const wantedRecord = quiet ? { ...was, repository: { ...was.repository, ...(name === "delta" ? { path: "moved/delta" } : {}), commit: libSecond } } : was;
			assert(JSON.stringify(now.record) === JSON.stringify(wantedRecord), `${name}'s record: ${JSON.stringify(wantedRecord)}, got ${JSON.stringify(now.record)}`);
		}
	});

	await row("9 different files are available, with what changes, the versions and the two flags", async () => {
		const candidate = libChecked.get("gamma")?.candidate;
		assert(candidate, "gamma has a candidate");
		const wantedChanges = { added: [{ path: "run.py", kind: "scripts" }], removed: [{ path: "old.md", kind: "documents" }], changed: [{ path: "SKILL.md", kind: "instructions" }, { path: "notes.md", kind: "documents" }] };
		assert(JSON.stringify(candidate.changes) === JSON.stringify(wantedChanges), `gamma's changes: ${JSON.stringify(wantedChanges)}, got ${JSON.stringify(candidate.changes)}`);
		assert(JSON.stringify(candidate.versions) === JSON.stringify({ from: "1.0", to: "2.0" }), `gamma's versions, got ${JSON.stringify(candidate.versions)}`);
		assert(candidate.commit === libSecond && candidate.path === "skills/gamma", `the new commit and folder, got ${candidate.commit} ${candidate.path}`);
		assert(candidate.hiddenCharacters === false && candidate.changedHere === false, `gamma: no hidden characters, not changed here, got ${candidate.hiddenCharacters} ${candidate.changedHere}`);
		assert(libChecked.get("theta").candidate.hiddenCharacters === true && libChecked.get("theta").candidate.scanFindings.length > 0, "theta's new version has hidden characters");
		assert(libChecked.get("iota").candidate.changedHere === true && libChecked.get("iota").candidate.hiddenCharacters === false, "iota was changed on this computer");
		const listed = await skillView("gamma");
		assert(listed?.update?.state === "available" && listed.update.candidate?.commit === libSecond, `GET /api/skills shows the update, got ${JSON.stringify(listed?.update)}`);
	});

	let featureToken = "";
	await row("10 a branch follows its latest commit", async () => {
		await addMany(`${skills.url}#feature`, ["skills/notes"]);
		assert(record("notes").repository.refKind === "branch" && record("notes").repository.ref === "feature", `notes is added from the branch, got ${JSON.stringify(record("notes").repository)}`);
		git(skills.work, ["checkout", "-q", "feature"]);
		writeSkill(skills.work, "skills/notes", "notes", "Take notes, on the branch.");
		const moved = skills.commit("notes on the branch");
		skills.push("HEAD:feature");
		git(skills.work, ["checkout", "-q", "main"]);
		gitRequests.length = 0;
		const found = (await checkUpdates(["notes", "pdf"])).get("notes");
		assert(found?.state === "available" && found.candidate.commit === moved, `notes follows the branch to ${moved}, got ${JSON.stringify(found)}`);
		// The branch and the default branch are asked apart (two listings), and only the branch, which moved, is cloned (one more).
		assert(JSON.stringify(countFor("skills")) === JSON.stringify({ asks: 3, fetches: 1 }), `the branch and the default branch are asked apart, got ${JSON.stringify(countFor("skills"))}`);
		featureToken = found.candidate.id;
	});

	await row("11 a tag that moves is followed, an annotated tag that didn't is not fetched", async () => {
		const tagged = makeRepo("tagged");
		writeSkill(tagged.work, "skills/omega", "omega", "Omega, first.");
		const first = tagged.commit("first");
		git(tagged.work, ["tag", "-a", "v1", "-m", "v1"]);
		tagged.push();
		git(tagged.work, ["push", "-q", "--force", "origin", "refs/tags/v1"]);
		await addMany(`${tagged.url}#v1`, ["skills/omega"]);
		const kept = record("omega").repository;
		assert(kept.refKind === "tag" && kept.ref === "v1" && kept.commit === first, `omega keeps the tag and its commit, got ${JSON.stringify(kept)}`);
		gitRequests.length = 0;
		const still = (await checkUpdates(["omega"])).get("omega");
		assert(still?.state === "current" && countFor("tagged").fetches === 0, `the tag didn't move: current, nothing fetched, got ${JSON.stringify(still)} ${JSON.stringify(countFor("tagged"))}`);
		writeSkill(tagged.work, "skills/omega", "omega", "Omega, second.");
		const second = tagged.commit("second");
		git(tagged.work, ["tag", "-a", "-f", "v1", "-m", "v1 again"]);
		tagged.push();
		git(tagged.work, ["push", "-q", "--force", "origin", "refs/tags/v1"]);
		const moved = (await checkUpdates(["omega"])).get("omega");
		assert(moved?.state === "available" && moved.candidate.commit === second, `the tag moved to ${second}, got ${JSON.stringify(moved)}`);
	});

	await row("12 a skill fixed to a commit is pinned, and its repository isn't asked", async () => {
		handMade("rho", { source: `${lib.url}#${libFirst}`, repository: { address: lib.url, ref: libFirst, refKind: "commit", path: "skills/rho", commit: libFirst, filesSha256: "" } });
		gitRequests.length = 0;
		const found = (await checkUpdates(["rho"])).get("rho");
		assert(found?.state === "pinned" && gitRequests.length === 0, `pinned, nothing asked, got ${JSON.stringify(found)} after ${gitRequests.length} requests`);
		assert((await skillView("rho"))?.update?.state === "pinned", "the page says it is fixed to a commit");
	});

	await row("13 a repository that can't be reached is unreachable, and the skill is as it was", async () => {
		const closed = await freePort();
		handMade("sigma", { source: `http://127.0.0.1:${closed}/team/none.git`, repository: { address: `http://127.0.0.1:${closed}/team/none.git`, refKind: "default", path: "skills/sigma", commit: "2".repeat(40), filesSha256: "" } });
		const was = snapshot("sigma");
		const found = (await checkUpdates(["sigma"])).get("sigma");
		assert(found?.state === "unreachable" && found.failure?.reason === "offline", `offline, got ${JSON.stringify(found)}`);
		assert(JSON.stringify(snapshot("sigma")) === JSON.stringify(was), "sigma is as it was");
	});

	await row("13b a server that doesn't take the connection on its SSH port is named, on the check and on the skill's page", async () => {
		// Added as git@127.0.0.1:<port>/team/none.git, the record keeps the ssh:// form; ssh itself is refused on this computer.
		const closed = await freePort();
		const address = recordedAddress((resolveRepoSource(`git@127.0.0.1:${closed}/team/none.git`) as any).value);
		assert(address === `ssh://git@127.0.0.1:${closed}/team/none.git`, `the record keeps the port, got ${address}`);
		handMade("upsilon", { source: address, repository: { address, refKind: "default", path: "skills/upsilon", commit: "2".repeat(40), filesSha256: "" } });
		const was = snapshot("upsilon");
		const found = (await checkUpdates(["upsilon"])).get("upsilon");
		assert(found?.state === "unreachable" && found.failure?.reason === "connect-failed" && found.failure.host === `127.0.0.1:${closed}`, `the server is named, got ${JSON.stringify(found)}`);
		const page = (await skillView("upsilon"))?.update;
		assert(page?.failure?.reason === "connect-failed" && page.failure.host === `127.0.0.1:${closed}`, `the skill's page reads the same reason and host, got ${JSON.stringify(page)}`);
		const line = skillUpdatesFailedLine(page.failure, ["upsilon"]);
		assert(line === `Couldn't connect to 127.0.0.1:${closed} to check “upsilon” for updates. If it needs your company's VPN, turn it on and try again.`, `the page's line names the server, got ${line}`);
		assert(JSON.stringify(snapshot("upsilon")) === JSON.stringify(was), "upsilon is as it was");
	});

	await row("13c a skill recorded from git@host:<digits>/group/repo is checked at that address, the digits a group's name", async () => {
		// A record in this form holds a group named in digits: an add records a port in the ssh:// form.
		// git runs a stand-in for ssh here, set in this throwaway home's git settings, so nothing reaches port 22.
		const address = "git@gitlab.example:2024/team/tools.git";
		const sshLog = path.join(tempRoot, "recorded-ssh.log");
		// A folder with a space, as Node's own on Windows ("C:/Program Files/nodejs").
		const fakeSsh = path.join(tempRoot, "stand in", "recorded-ssh.cjs");
		fs.mkdirSync(path.dirname(fakeSsh), { recursive: true });
		fs.writeFileSync(fakeSsh, `require("fs").appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stderr.write("ssh: connect to host gitlab.example port 22: Connection refused\\n");\nprocess.exit(255);\n`);
		const gitConfig = path.join(home, ".gitconfig");
		assert(!fs.existsSync(gitConfig), "the throwaway home has no git settings of its own yet");
		try {
			// git config writes the value with its quotes kept; a hand-written file would lose them to git's own unquoting.
			git(tempRoot, ["config", "--file", gitConfig, "core.sshCommand", `"${process.execPath.replace(/\\/g, "/")}" "${fakeSsh.replace(/\\/g, "/")}"`]);
			git(tempRoot, ["config", "--file", gitConfig, "ssh.variant", "ssh"]);
			handMade("digits-group", { source: address, repository: { address, refKind: "default", path: "skills/digits-group", commit: "2".repeat(40), filesSha256: "" } });
			const was = snapshot("digits-group");
			const found = (await checkUpdates(["digits-group"])).get("digits-group");
			const sent = fs.readFileSync(sshLog, "utf-8").trim().split("\n").map((entry) => JSON.parse(entry) as string[]);
			assert(sent.length > 0 && sent.every((args) => !args.includes("-p") && args.includes("git@gitlab.example") && args.join(" ").includes("'2024/team/tools.git'")), `git is sent the address as recorded, on ssh's own port, got ${JSON.stringify(sent)}`);
			assert(found?.state === "unreachable" && found.failure?.reason === "connect-failed" && found.failure.host === "gitlab.example", `the check names the recorded host, got ${JSON.stringify(found)}`);
			assert(JSON.stringify(snapshot("digits-group")) === JSON.stringify(was), "digits-group is as it was");
		} finally {
			fs.rmSync(gitConfig, { force: true });
		}
	});

	await row("14 a repository that turns the request down is unreachable, with today's sign-in advice", async () => {
		const locked = makeRepo("locked");
		writeSkill(locked.work, "skills/phi", "phi", "The phi instructions.");
		locked.commit("first");
		locked.push();
		await addMany(locked.url, ["skills/phi"]);
		const was = snapshot("phi");
		signedOut.add("locked");
		try {
			const found = (await checkUpdates(["phi"])).get("phi");
			assert(found?.state === "unreachable" && found.failure?.reason === "sign-in", `signed out, got ${JSON.stringify(found)}`);
			assert(String(found.failure.message).includes(`This computer has no sign-in for 127.0.0.1:${gitPort}, or the address is wrong.`), `the add's sign-in advice, got ${found.failure.message}`);
		} finally {
			signedOut.delete("locked");
		}
		assert(JSON.stringify(snapshot("phi")) === JSON.stringify(was), "phi is as it was");
	});

	await row("15 a skill added from a repository before this change is untracked, never matched by a guess", async () => {
		handMade("tau", { source: lib.url });
		const found = (await checkUpdates(["tau"])).get("tau");
		assert(found?.state === "untracked" && !found.candidate, `untracked, got ${JSON.stringify(found)}`);
		const listed = await skillView("tau");
		assert(listed?.update?.state === "untracked" && listed.repository === undefined, `the page says how to get updates, got ${JSON.stringify(listed)}`);
	});

	// --- Update -------------------------------------------------------------------

	await row("16 Update of a skill that isn't there is 404", async () => {
		const answer = await updateOf("no-such-skill", { candidate: "x", installedFilesSha256: "y" });
		assert(answer.status === 404, `404, got ${answer.status} ${JSON.stringify(answer.body)}`);
	});

	await row("17 Update with no update, or of a skill renamed in its repository, is refused and writes nothing", async () => {
		const current = await updateOf("alpha", { candidate: "x", installedFilesSha256: filesHash(path.join(store, "alpha")) });
		assert(current.status === 409 && current.body?.code === "no-update", `no-update, got ${current.status} ${JSON.stringify(current.body)}`);
		const renamed = await updateOf("zeta", { candidate: "x", installedFilesSha256: filesHash(path.join(store, "zeta")) });
		assert(renamed.status === 409 && renamed.body?.code === "skill-renamed-upstream", `skill-renamed-upstream, got ${renamed.status} ${JSON.stringify(renamed.body)}`);
		assert(JSON.stringify(snapshot("zeta")) === JSON.stringify(before.get("zeta")), "zeta is as it was");
	});

	await row("18 hidden characters stop Update until the person's yes, which counts only for that candidate and installation", async () => {
		const found = libChecked.get("theta");
		const was = snapshot("theta");
		const stopped = await updateOf("theta", askFor(found));
		assert(stopped.status === 409 && stopped.body?.code === "skill-update-hidden-characters", `the stop, got ${stopped.status} ${JSON.stringify(stopped.body)}`);
		const otherCandidate = await updateOf("theta", { ...askFor(found), candidate: featureToken, confirm: { hiddenCharacters: true } });
		assert(otherCandidate.status === 409 && otherCandidate.body?.code === "skill-changed-since-check", `a yes for another candidate, got ${otherCandidate.status} ${JSON.stringify(otherCandidate.body)}`);
		const otherHash = await updateOf("theta", { ...askFor(found), installedFilesSha256: found.candidate.filesSha256, confirm: { hiddenCharacters: true } });
		assert(otherHash.status === 409 && otherHash.body?.code === "skill-changed-since-check", `a yes for another installation, got ${otherHash.status} ${JSON.stringify(otherHash.body)}`);
		assert(JSON.stringify(snapshot("theta")) === JSON.stringify(was), "theta is as it was after each refusal");
		const yes = await updateOf("theta", { ...askFor(found), confirm: { hiddenCharacters: true } });
		assert(yes.status === 200 && fs.readFileSync(path.join(store, "theta", "SKILL.md"), "utf-8").includes("\u200b second"), `with the yes it updates, got ${yes.status} ${JSON.stringify(yes.body)}`);
	});

	await row("19 a skill changed on this computer warns once before its changes are replaced", async () => {
		const found = libChecked.get("iota");
		const was = snapshot("iota");
		const stopped = await updateOf("iota", askFor(found));
		assert(stopped.status === 409 && stopped.body?.code === "skill-changed-here", `the stop, got ${stopped.status} ${JSON.stringify(stopped.body)}`);
		const otherHash = await updateOf("iota", { ...askFor(found), installedFilesSha256: was.record.repository.filesSha256, confirm: { replaceMyChanges: true } });
		assert(otherHash.status === 409 && otherHash.body?.code === "skill-changed-since-check", `a yes for the files as they were given, got ${otherHash.status} ${JSON.stringify(otherHash.body)}`);
		assert(JSON.stringify(snapshot("iota")) === JSON.stringify(was), "iota keeps the change made here after each refusal");
		const yes = await updateOf("iota", { ...askFor(found), confirm: { replaceMyChanges: true } });
		assert(yes.status === 200, `with the yes it updates, got ${yes.status} ${JSON.stringify(yes.body)}`);
		assert(filesHash(path.join(store, "iota")) === found.candidate.filesSha256 && record("iota").repository.filesSha256 === found.candidate.filesSha256, "the new version is in place, its hash stored");
	});

	await row("20 one click swaps the folder, keeps the identity and the room's switch, and stores the new commit and hash", async () => {
		await switchOn("gamma");
		const identity = record("gamma").identity;
		const found = libChecked.get("gamma");
		const answer = await updateOf("gamma", askFor(found));
		assert(answer.status === 200, `the update works, got ${answer.status} ${JSON.stringify(answer.body)}`);
		const wanted = { address: lib.url, refKind: "default", path: "skills/gamma", commit: libSecond, filesSha256: filesHash(path.join(store, "gamma")) };
		assert(JSON.stringify(record("gamma").repository) === JSON.stringify(wanted), `the record: ${JSON.stringify(wanted)}, got ${JSON.stringify(record("gamma").repository)}`);
		assert(wanted.filesSha256 === found.candidate.filesSha256 && fs.existsSync(path.join(store, "gamma", "run.py")) && !fs.existsSync(path.join(store, "gamma", "old.md")), "the new files are in place");
		assert(record("gamma").identity === identity, "the identity is kept");
		assert((await roomsOf("gamma")).includes(room), "the room keeps it on");
		const listed = await skillView("gamma");
		assert(listed?.update?.state === "current" && JSON.stringify(listed.update.updated?.changes) === JSON.stringify(found.candidate.changes) && listed.update.updated?.versions?.to === "2.0", `the page says what changed, got ${JSON.stringify(listed?.update)}`);
		const again = await updateOf("gamma", askFor(found));
		assert(again.status === 409 && again.body?.code === "no-update", `the same Update again finds no update, got ${again.status} ${JSON.stringify(again.body)}`);
	});

	await row("21 a skill deleted and added again between the check and Update is not overwritten", async () => {
		const found = libChecked.get("mu");
		assert((await json("/api/skills/mu", { method: "DELETE" })).status < 300, "mu deleted");
		await addMany(lib.url, ["skills/mu"]);
		const was = snapshot("mu");
		const answer = await updateOf("mu", askFor(found));
		assert(answer.status === 409 && answer.body?.code === "skill-changed-since-check", `skill-changed-since-check, got ${answer.status} ${JSON.stringify(answer.body)}`);
		assert(JSON.stringify(snapshot("mu")) === JSON.stringify(was), "the skill added again is as it was");
	});

	await row("22 a skill replaced by an upload between the check and Update is not overwritten", async () => {
		const found = libChecked.get("nu");
		const uploaded = await post("/api/skills/upload", { filename: "SKILL.md", contentBase64: Buffer.from("---\nname: nu\ndescription: The uploaded nu.\n---\n\nUploaded.\n").toString("base64") });
		assert(uploaded.status === 200 && uploaded.body?.replaces === true, `the upload asks to replace nu, got ${uploaded.status} ${JSON.stringify(uploaded.body)}`);
		const accepted = await post("/api/skills/accept", { id: "nu", displayName: uploaded.body.name, description: uploaded.body.description, instructions: uploaded.body.body, source: "upload", replace: true });
		assert(accepted.status < 300, `the Replace works, got ${accepted.status} ${JSON.stringify(accepted.body)}`);
		const was = snapshot("nu");
		const answer = await updateOf("nu", askFor(found));
		assert(answer.status === 409 && answer.body?.code === "skill-changed-since-check", `skill-changed-since-check, got ${answer.status} ${JSON.stringify(answer.body)}`);
		assert(JSON.stringify(snapshot("nu")) === JSON.stringify(was), "the uploaded skill is as it was");
	});

	await row("23 an edit keeps the record, and a skill edited between the check and Update is not overwritten", async () => {
		const found = libChecked.get("xi");
		const kept = record("xi").repository;
		const edited = await json("/api/skills/xi", { method: "PUT", body: JSON.stringify({ displayName: "xi", description: "The xi skill.", instructions: "Edited in the app." }) });
		assert(edited.status === 200, `the edit works, got ${edited.status} ${JSON.stringify(edited.body)}`);
		assert(JSON.stringify(record("xi").repository) === JSON.stringify(kept), `the edit keeps the record's repository, got ${JSON.stringify(record("xi").repository)}`);
		const was = snapshot("xi");
		const answer = await updateOf("xi", askFor(found));
		assert(answer.status === 409 && answer.body?.code === "skill-changed-since-check", `skill-changed-since-check, got ${answer.status} ${JSON.stringify(answer.body)}`);
		assert(JSON.stringify(snapshot("xi")) === JSON.stringify(was), "the edited skill is as it was");
	});

	await row("24 a new version past the limits is refused with 413 and writes nothing", async () => {
		const answer = await updateOf("kappa", askFor(libChecked.get("kappa")));
		assert(answer.status === 413, `413, got ${answer.status} ${JSON.stringify(answer.body)}`);
		assert(JSON.stringify(snapshot("kappa")) === JSON.stringify(before.get("kappa")), "kappa is as it was");
	});

	await row("25 a fill that fails keeps the old folder", async () => {
		const held = checkoutsHolding("skills/omicron/SKILL.md").filter((dir) => fs.readFileSync(path.join(dir, "skills/omicron/SKILL.md"), "utf-8").includes("second"));
		assert(held.length > 0, "the check's checkout is held");
		for (const dir of held) fs.appendFileSync(path.join(dir, "skills/omicron/SKILL.md"), "Changed after the check.\n");
		const answer = await updateOf("omicron", askFor(libChecked.get("omicron")));
		assert(answer.status === 502, `502, got ${answer.status} ${JSON.stringify(answer.body)}`);
		assert(JSON.stringify(snapshot("omicron")) === JSON.stringify(before.get("omicron")), "omicron is as it was");
		assert(!fs.readdirSync(agentDir).some((name) => name.startsWith(".skill-replace-")), "nothing is left beside the store");
	});

	await row("26 after a held version could not be read, the next press fetches it again and goes through", async () => {
		gitRequests.length = 0;
		const answer = await updateOf("omicron", askFor(libChecked.get("omicron")));
		assert(answer.status === 200 && countFor("lib").fetches === 1, `omicron, whose held files row 25 changed, is fetched again and updated, got ${answer.status} ${JSON.stringify(answer.body)} ${JSON.stringify(countFor("lib"))}`);
		assert(fs.readFileSync(path.join(store, "omicron", "SKILL.md"), "utf-8").includes("second") && !fs.readFileSync(path.join(store, "omicron", "SKILL.md"), "utf-8").includes("Changed after the check."), "the files are the repository's");
	});

	await row("26b a held version whose folder is gone is 502 and writes nothing", async () => {
		const held = checkoutsHolding("skills/kappa/big.bin");
		assert(held.length > 0, "row 26's fetch is held");
		for (const dir of held) fs.rmSync(dir, { recursive: true, force: true });
		gitRequests.length = 0;
		const answer = await updateOf("kappa", askFor(libChecked.get("kappa")));
		assert(answer.status === 502 && countFor("lib").fetches === 0, `502, and nothing fetched by this press, got ${answer.status} ${JSON.stringify(answer.body)}`);
		assert(JSON.stringify(snapshot("kappa")) === JSON.stringify(before.get("kappa")), "kappa is as it was");
	});

	await row("27 a swap cut halfway is put back at the next start, and an update found before it is fetched again", async () => {
		try { ws?.close(); } catch {}
		const was = snapshot("alpha");
		await stopSmokeServer(serverProcess);
		const staging = path.join(agentDir, ".skill-replace-alpha-cut");
		fs.mkdirSync(path.join(staging, "new"), { recursive: true });
		fs.writeFileSync(path.join(staging, "new", "SKILL.md"), "---\nname: alpha\ndescription: Half written.\n---\n");
		fs.renameSync(path.join(store, "alpha"), path.join(staging, "old"));
		await startServer();
		assert(JSON.stringify(snapshot("alpha")) === JSON.stringify(was), "alpha is back as it was");
		assert(!fs.existsSync(staging), "nothing of the cut swap is left");
		gitRequests.length = 0;
		const answer = await updateOf("kappa", askFor(libChecked.get("kappa")));
		assert(answer.status === 413 && countFor("lib").fetches === 1, `kappa is fetched again, and is still too big, got ${answer.status} ${JSON.stringify(answer.body)} ${JSON.stringify(countFor("lib"))}`);
		assert(JSON.stringify(snapshot("kappa")) === JSON.stringify(before.get("kappa")), "kappa is as it was");
	});

	// --- The routes from a phone ----------------------------------------------------

	await row("28 both routes are this computer's only: a phone is refused, and still reads the version and the source", async () => {
		assert(classifyRemoteRoute("POST", "/api/skills/updates/check") === "local" && classifyRemoteRoute("POST", "/api/skills/:id/update") === "local", "both routes are local");
		assert((await post("/api/remote/enable", {})).status === 200, "remote access on");
		const device = await pairDevice(port, "Update phone");
		for (const pathname of ["/api/skills/updates/check", "/api/skills/gamma/update"]) {
			const answer = await remoteRequest(port, pathname, { method: "POST", headers: { Cookie: device.cookie, "content-type": "application/json" }, body: "{}" });
			assert(answer.status === 403 && JSON.parse(answer.body)?.code === "remote_local_only", `${pathname} from a phone: 403, got ${answer.status} ${answer.body}`);
		}
		const listed = await remoteRequest(port, "/api/skills", { headers: { Cookie: device.cookie } });
		const gamma = (JSON.parse(listed.body) as any[]).find((skill) => skill.name === "gamma");
		assert(listed.status === 200 && gamma?.repository?.commit === libSecond, `a phone reads the source and the version, got ${listed.status} ${JSON.stringify(gamma?.repository)}`);
	});

	// --- A check and an Update at the same time, and a store that refuses its write -------

	const race = makeRepo("race");
	await row("29 a check that ends after an Update keeps what the Update stored", async () => {
		writeSkill(race.work, "skills/chi", "chi", "Chi, first.");
		race.commit("first");
		race.push();
		await addMany(race.url, ["skills/chi"]);
		writeSkill(race.work, "skills/chi", "chi", "Chi, second.");
		race.commit("second");
		race.push();
		const found = (await checkUpdates(["chi"])).get("chi");
		assert(found?.state === "available", `chi has an update, got ${JSON.stringify(found)}`);
		let release = () => {};
		held.set("race", new Promise<void>((resolve) => { release = resolve; }));
		gitRequests.length = 0;
		const slowCheck = checkUpdates(["chi"]);
		await waitUntil(() => gitRequests.some((request) => request.repo === "race"), "the check is asking the repository");
		const updated = await updateOf("chi", askFor(found));
		held.delete("race");
		release();
		await slowCheck;
		assert(updated.status === 200, `the update works, got ${updated.status} ${JSON.stringify(updated.body)}`);
		const listed = await skillView("chi");
		assert(listed?.update?.state === "current" && listed.update.updated?.changes?.changed?.[0]?.path === "SKILL.md", `the skill's page still says what the update changed, got ${JSON.stringify(listed?.update)}`);
	});

	// A folder made read-only refuses a write only off Windows and when not root.
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (!canForceFsRefusal) console.log("skipped 30: a read-only folder can't refuse a write here");
	else await row("30 an update whose result can't be stored is still an update", async () => {
		writeSkill(race.work, "skills/psi", "psi", "Psi, first.");
		race.commit("psi first");
		race.push();
		await addMany(race.url, ["skills/psi"]);
		writeSkill(race.work, "skills/psi", "psi", "Psi, second.");
		race.commit("psi second");
		race.push();
		const found = (await checkUpdates(["psi"])).get("psi");
		assert(found?.state === "available", `psi has an update, got ${JSON.stringify(found)}`);
		fs.chmodSync(appRoot, 0o500);
		let answer: { status: number; body: any };
		try {
			answer = await updateOf("psi", askFor(found));
		} finally {
			fs.chmodSync(appRoot, 0o700);
		}
		assert(answer.status === 200, `the swap happened, so the answer is the update's, got ${answer.status} ${JSON.stringify(answer.body)}`);
		assert(fs.readFileSync(path.join(store, "psi", "SKILL.md"), "utf-8").includes("Psi, second.") && record("psi").repository.filesSha256 === found.candidate.filesSha256, "the new version is in place, its record written");
	});

	await row("31 a clone whose version its files don't tell still scans", async () => {
		// An empty repository's clone has HEAD on a branch with no ref file, so its commit can't be read from it.
		const empty = makeRepo("empty");
		const scan = await post("/api/skills/repo/scan", { source: empty.url });
		assert(scan.status === 200 && Array.isArray(scan.body.skills) && scan.body.skills.length === 0, `the scan finds no skills rather than failing, got ${scan.status} ${JSON.stringify(scan.body)}`);
	});

	await row("32 a file the system writes by itself in a skill's folder is not a change by the person", async () => {
		writeSkill(race.work, "skills/finder", "finder", "Finder, first.");
		race.commit("finder first");
		race.push();
		await addMany(race.url, ["skills/finder"]);
		writeSkill(race.work, "skills/finder", "finder", "Finder, second.");
		race.commit("finder second");
		race.push();
		fs.writeFileSync(path.join(store, "finder", ".DS_Store"), "Finder");
		const found = (await checkUpdates(["finder"])).get("finder");
		assert(found?.state === "available" && found.candidate.changedHere === false, `a .DS_Store leaves the skill unchanged here, got ${JSON.stringify(found)}`);
		assert(!JSON.stringify(found.candidate.changes).includes(".DS_Store"), `and is no file the update adds, removes or changes, got ${JSON.stringify(found.candidate.changes)}`);
		fs.writeFileSync(path.join(store, "finder", "notes.md"), "mine");
		const edited = (await checkUpdates(["finder"])).get("finder");
		assert(edited?.state === "available" && edited.candidate.changedHere === true, `a file the person adds is a change here, got ${JSON.stringify(edited)}`);
	});

	await row("33 hidden characters in the new description alone: the stop gets the new description to review", async () => {
		writeSkill(race.work, "skills/quiet", "quiet", "Quiet instructions.");
		race.commit("quiet first");
		race.push();
		await addMany(race.url, ["skills/quiet"]);
		writeSkill(race.work, "skills/quiet", "quiet", "Quiet instructions.", "The quiet skill,​ changed.");
		race.commit("quiet second");
		race.push();
		const found = (await checkUpdates(["quiet"])).get("quiet");
		assert(found?.state === "available" && found.candidate.hiddenCharacters === true, `the description's hidden character stops the update, got ${JSON.stringify(found)}`);
		assert(found.candidate.description === "The quiet skill,​ changed." && found.candidate.body === "Quiet instructions.", `the candidate carries the new description and instructions, got ${JSON.stringify(found.candidate)}`);
		const clean = (await checkUpdates(["finder"])).get("finder");
		assert(clean?.candidate && clean.candidate.description === undefined && clean.candidate.body === undefined, `a clean update carries neither, got ${JSON.stringify(clean?.candidate)}`);
	});

	await row("34 a system-named file the repository ships is installed, so the update lists it with the scripts", async () => {
		writeSkill(race.work, "skills/shipper", "shipper", "Shipper, first.");
		race.commit("shipper first");
		race.push();
		await addMany(race.url, ["skills/shipper"]);
		writeSkill(race.work, "skills/shipper", "shipper", "Shipper, second.");
		fs.mkdirSync(path.join(race.work, "skills/shipper/scripts"), { recursive: true });
		fs.writeFileSync(path.join(race.work, "skills/shipper/scripts/._run.py"), "print('run')\n");
		race.commit("shipper second");
		race.push();
		const found = (await checkUpdates(["shipper"])).get("shipper");
		assert(found?.state === "available", `the new instructions are an update, got ${JSON.stringify(found)}`);
		const added = found.candidate.changes.added;
		assert(added.some((file: { path: string; kind: string }) => file.path === "scripts/._run.py" && file.kind === "scripts"), `the shipped file is listed as an added script, got ${JSON.stringify(found.candidate.changes)}`);
	});

	await row("35 a rename gives the new written name, one that doesn't fit included, since the add takes it under its fitted name", async () => {
		writeSkill(race.work, "skills/oldname", "oldname", "Old name.");
		writeSkill(race.work, "skills/goodname", "goodname", "Good name.");
		race.commit("names first");
		race.push();
		await addMany(race.url, ["skills/oldname", "skills/goodname"]);
		writeSkill(race.work, "skills/oldname", "Old Name", "Old name.");
		writeSkill(race.work, "skills/goodname", "good-name", "Good name.");
		race.commit("names second");
		race.push();
		const checked = await checkUpdates(["oldname", "goodname"]);
		const bad = checked.get("oldname");
		assert(bad?.state === "renamed" && bad.renamedTo === "Old Name", `a written name that doesn't fit is given, got ${JSON.stringify(bad)}`);
		const good = checked.get("goodname");
		assert(good?.state === "renamed" && good.renamedTo === "good-name", `a valid new name is given, got ${JSON.stringify(good)}`);
	});

	await row("36 a skill added again with the same files and record between the check and Update is not overwritten: only its identity differs", async () => {
		const again = makeRepo("again");
		writeSkill(again.work, "skills/rebound", "rebound", "Rebound, first.");
		const first = again.commit("first");
		again.push();
		await addMany(again.url, ["skills/rebound"]);
		const identity = record("rebound").identity;
		writeSkill(again.work, "skills/rebound", "rebound", "Rebound, second.");
		again.commit("second");
		again.push();
		const found = (await checkUpdates(["rebound"])).get("rebound");
		assert(found?.state === "available", `rebound has an update, got ${JSON.stringify(found)}`);
		git(again.work, ["reset", "-q", "--hard", first]);
		again.push();
		assert((await json("/api/skills/rebound", { method: "DELETE" })).status < 300, "rebound deleted");
		await addMany(again.url, ["skills/rebound"]);
		const was = snapshot("rebound");
		assert(was.record.identity !== identity, "the skill added again has a new identity");
		assert(was.record.repository.commit === first && was.files === found.installedFilesSha256, `the skill added again has the files and commit the check saw, got ${JSON.stringify(was)}`);
		const answer = await updateOf("rebound", askFor(found));
		assert(answer.status === 409 && answer.body?.code === "skill-changed-since-check", `skill-changed-since-check, got ${answer.status} ${JSON.stringify(answer.body)}`);
		assert(JSON.stringify(snapshot("rebound")) === JSON.stringify(was), "the skill added again is as it was");
	});

	await row("37 a rename to a name of 48 characters gives it, and so does one of 49, which the add takes cut to 48", async () => {
		const lengths = makeRepo("lengths");
		const name48 = `renamed-${"x".repeat(40)}`;
		const name49 = `renamed-${"y".repeat(41)}`;
		writeSkill(lengths.work, "skills/fits", "fits", "Fits.");
		writeSkill(lengths.work, "skills/overlong", "overlong", "Overlong.");
		lengths.commit("first");
		lengths.push();
		await addMany(lengths.url, ["skills/fits", "skills/overlong"]);
		writeSkill(lengths.work, "skills/fits", name48, "Fits.");
		writeSkill(lengths.work, "skills/overlong", name49, "Overlong.");
		lengths.commit("second");
		lengths.push();
		const checked = await checkUpdates(["fits", "overlong"]);
		const fits = checked.get("fits");
		assert(fits?.state === "renamed" && fits.renamedTo === name48, `a 48-character new name is given, got ${JSON.stringify(fits)}`);
		const overlong = checked.get("overlong");
		assert(overlong?.state === "renamed" && overlong.renamedTo === name49, `a 49-character new name is given, got ${JSON.stringify(overlong)}`);
		const { added } = await addFromRepository(lengths.url, "skills/fits");
		assert(added.status === 201 && fs.existsSync(path.join(store, name48, "SKILL.md")), `the 48-character name the line gives is added, got ${added.status} ${JSON.stringify(added.body)}`);
		const cut = await addFromRepository(lengths.url, "skills/overlong");
		assert(cut.added.status === 201 && fs.existsSync(path.join(store, name49.slice(0, 48), "SKILL.md")), `the 49-character name is added cut to 48, got ${cut.added.status} ${JSON.stringify(cut.added.body)}`);
	});

	await row("38 a skill at a repository's root comes in whole, and its update brings the whole checkout, a file added runnable and one that only gains the mark listed with the scripts", async () => {
		const rooted = makeRepo("rooted");
		writeSkill(rooted.work, "", "rooted", "Rooted, first.");
		fs.writeFileSync(path.join(rooted.work, "README.md"), "# part of the skill\n");
		fs.writeFileSync(path.join(rooted.work, "tool"), "echo first\n", { mode: 0o644 });
		rooted.commit("first");
		rooted.push();
		await addMany(rooted.url, [""]);
		const files = () => (fs.readdirSync(path.join(store, "rooted"), { recursive: true }) as string[]).map(String).filter((file) => file !== "provenance.json").sort().join(",");
		assert(files() === "README.md,SKILL.md,tool", `the root skill comes with the checkout's files, got ${files()}`);
		writeSkill(rooted.work, "", "rooted", "Rooted, second.");
		fs.mkdirSync(path.join(rooted.work, "bin"), { recursive: true });
		fs.writeFileSync(path.join(rooted.work, "bin", "run"), "echo run\n", { mode: 0o755 });
		// Its bytes as they were: only the mark changes.
		fs.chmodSync(path.join(rooted.work, "tool"), 0o755);
		rooted.commit("second");
		rooted.push();
		const found = (await checkUpdates(["rooted"])).get("rooted");
		assert(found?.state === "available", `the root skill has an update, got ${JSON.stringify(found)}`);
		if (process.platform !== "win32") {
			const wanted = { added: [{ path: "bin/run", kind: "scripts" }], removed: [], changed: [{ path: "SKILL.md", kind: "instructions" }, { path: "tool", kind: "scripts" }] };
			assert(JSON.stringify(found.candidate.changes) === JSON.stringify(wanted), `a file added runnable, and one that only gains the mark, are listed with the scripts: ${JSON.stringify(wanted)}, got ${JSON.stringify(found.candidate.changes)}`);
		}
		const answer = await updateOf("rooted", askFor(found));
		assert(answer.status === 200, `the update works, got ${answer.status}: ${JSON.stringify(answer.body)}`);
		assert(files() === ["README.md", "SKILL.md", "bin", path.join("bin", "run"), "tool"].sort().join(","), `the update brings the whole checkout, got ${files()}`);
		if (process.platform !== "win32") {
			const mode = (file: string) => fs.statSync(path.join(store, "rooted", file)).mode & 0o777;
			assert(mode("bin/run") === 0o700 && mode("tool") === 0o700 && mode("README.md") === 0o600, `runnable files are runnable after the update, the others 0600, got ${mode("bin/run").toString(8)} ${mode("tool").toString(8)} ${mode("README.md").toString(8)}`);
		}
	});

	await row("39 a skill under a dot folder, and one added from inside another skill's folder, update from where they were added", async () => {
		const dotted = makeRepo("dotted");
		writeSkill(dotted.work, ".claude/skills/dotskill", "dotskill", "Dot, first.");
		writeSkill(dotted.work, "outer", "outer", "Outer.");
		writeSkill(dotted.work, "outer/inner", "inner", "Inner, first.");
		dotted.commit("first");
		dotted.push();
		// The inner one isn't offered any more, but one added from there before is still that skill.
		await addMany(dotted.url, [".claude/skills/dotskill", "outer/inner"]);
		writeSkill(dotted.work, ".claude/skills/dotskill", "dotskill", "Dot, second.");
		writeSkill(dotted.work, "outer/inner", "inner", "Inner, second.");
		dotted.commit("second");
		dotted.push();
		const checked = await checkUpdates(["dotskill", "inner"]);
		for (const [name, folder] of [["dotskill", ".claude/skills/dotskill"], ["inner", "outer/inner"]]) {
			const found = checked.get(name);
			assert(found?.state === "available" && found.candidate.path === folder, `${name} has an update from ${folder}, got ${JSON.stringify(found)}`);
			const answer = await updateOf(name, askFor(found));
			assert(answer.status === 200 && fs.readFileSync(path.join(store, name, "SKILL.md"), "utf-8").includes("second."), `${name} is updated, got ${answer.status}: ${JSON.stringify(answer.body)}`);
		}
	});

	await row("40 a written name that doesn't fit is added byte for byte under its fitted name, stays current, and updates by its folder", async () => {
		const odd = makeRepo("odd");
		writeSkill(odd.work, "skills/odd", "Odd_Skill", "Odd, first.");
		odd.commit("first");
		odd.push();
		await addMany(odd.url, ["skills/odd"]);
		assert(fs.readFileSync(path.join(store, "odd-skill", "SKILL.md"), "utf-8") === fs.readFileSync(path.join(odd.work, "skills", "odd", "SKILL.md"), "utf-8"), "its SKILL.md is the repository's, byte for byte");
		fs.writeFileSync(path.join(odd.work, "README.md"), "# a change outside the skill\n");
		odd.commit("outside");
		odd.push();
		const quiet = (await checkUpdates(["odd-skill"])).get("odd-skill");
		assert(quiet?.state === "current", `no update fires from its own name, got ${JSON.stringify(quiet)}`);
		writeSkill(odd.work, "skills/odd", "Odd_Skill", "Odd, second.");
		odd.commit("second");
		odd.push();
		const found = (await checkUpdates(["odd-skill"])).get("odd-skill");
		assert(found?.state === "available", `the new version is found by its folder, got ${JSON.stringify(found)}`);
		const answer = await updateOf("odd-skill", askFor(found));
		assert(answer.status === 200 && fs.readFileSync(path.join(store, "odd-skill", "SKILL.md"), "utf-8").includes("Odd, second."), `it is updated, got ${answer.status}: ${JSON.stringify(answer.body)}`);
	});

	await row("41 a new version that adds an emoji's ordinary form has no hidden character, so it updates without the person's yes", async () => {
		const emoji = makeRepo("emoji");
		writeSkill(emoji.work, "skills/warns", "warns", "Warning: keep props few.");
		emoji.commit("first");
		emoji.push();
		await addMany(emoji.url, ["skills/warns"]);
		writeSkill(emoji.work, "skills/warns", "warns", "\u{26a0}\u{fe0f} Warning: keep props few.");
		emoji.commit("second");
		emoji.push();
		const found = (await checkUpdates(["warns"])).get("warns");
		assert(found?.state === "available" && found.candidate.hiddenCharacters === false && found.candidate.scanFindings.length === 0, `"\u{26a0}\u{fe0f}" is no hidden character, got ${JSON.stringify(found)}`);
		const answer = await updateOf("warns", askFor(found));
		assert(answer.status === 200 && fs.readFileSync(path.join(store, "warns", "SKILL.md"), "utf-8").includes("\u{26a0}\u{fe0f} Warning"), `it updates with no yes asked, got ${answer.status}: ${JSON.stringify(answer.body)}`);
	});

	await row("42 a skill added from a coding tool's copy updates from that copy after the scan stops offering it", async () => {
		const copies = makeRepo("copies");
		writeSkill(copies.work, ".claude/skills/copied", "copied", "Copy, first.");
		copies.commit("first");
		copies.push();
		await addMany(copies.url, [".claude/skills/copied"]);
		writeSkill(copies.work, "skills/copied", "copied", "Its own folder.");
		writeSkill(copies.work, ".claude/skills/copied", "copied", "Copy, second.");
		copies.commit("second");
		copies.push();
		const found = (await checkUpdates(["copied"])).get("copied");
		assert(found?.state === "available" && found.candidate.path === ".claude/skills/copied", `the update comes from the copy it was added from, got ${JSON.stringify(found)}`);
		const answer = await updateOf("copied", askFor(found));
		assert(answer.status === 200 && fs.readFileSync(path.join(store, "copied", "SKILL.md"), "utf-8").includes("Copy, second."), `it is updated from that copy, got ${answer.status}: ${JSON.stringify(answer.body)}`);
		// Last, so the update's answers above are checked on code that still offers the copy too.
		const scan = await post("/api/skills/repo/scan", { source: copies.url });
		const offered = (scan.body?.skills as any[] | undefined)?.map((skill) => skill.path).join(",");
		assert(offered === "skills/copied", `the scan offers the skill's own folder alone, got ${offered}`);
	});

	await row("43 a new version with no description reads its body's first line after the update, and the SKILL.md stays as written", async () => {
		const plain = makeRepo("plain");
		writeSkill(plain.work, "skills/plain", "plain", "Plain, first.");
		plain.commit("first");
		plain.push();
		await addMany(plain.url, ["skills/plain"]);
		const second = ["---", "name: plain", "---", "", "## Plan the week's posts from the brief.", "", "Plain, second.", ""].join("\n");
		fs.writeFileSync(path.join(plain.work, "skills", "plain", "SKILL.md"), second);
		plain.commit("second");
		plain.push();
		const found = (await checkUpdates(["plain"])).get("plain");
		assert(found?.state === "available", `the new version is found, got ${JSON.stringify(found)}`);
		const answer = await updateOf("plain", askFor(found));
		assert(answer.status === 200 && fs.readFileSync(path.join(store, "plain", "SKILL.md"), "utf-8") === second, `it updates to the SKILL.md as written, got ${answer.status}: ${JSON.stringify(answer.body)}`);
		const description = (await skillView("plain"))?.description;
		assert(description === "Plan the week's posts from the brief.", `the library reads the body's first line, got ${JSON.stringify(description)}`);
	});

	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
	if (process.platform !== "win32") {
		await row("44 an update that adds a picture and a font committed runnable lists them as files and stores them without the mark; one named a picture that starts with #! stays a script", async () => {
			const pictured = makeRepo("pictured");
			writeSkill(pictured.work, "skills/pictured", "pictured", "Pictured.");
			pictured.commit("first");
			pictured.push();
			await addMany(pictured.url, ["skills/pictured"]);
			const folder = path.join(pictured.work, "skills", "pictured");
			fs.mkdirSync(path.join(folder, "fonts"), { recursive: true });
			fs.writeFileSync(path.join(folder, "logo.png"), PNG, { mode: 0o755 });
			fs.writeFileSync(path.join(folder, "fonts", "Sans.woff"), Buffer.concat([Buffer.from("wOFF"), Buffer.alloc(12)]), { mode: 0o755 });
			fs.writeFileSync(path.join(folder, "fake.png"), "#!/bin/sh\necho fake\n", { mode: 0o755 });
			pictured.commit("second");
			pictured.push();
			const found = (await checkUpdates(["pictured"])).get("pictured");
			assert(found?.state === "available", `the new version is found, got ${JSON.stringify(found)}`);
			const wanted = { added: [{ path: "fake.png", kind: "scripts" }, { path: "fonts/Sans.woff", kind: "other" }, { path: "logo.png", kind: "templates" }], removed: [], changed: [] };
			assert(JSON.stringify(found.candidate.changes) === JSON.stringify(wanted), `the picture and font are listed as files, the #! one as a script: ${JSON.stringify(wanted)}, got ${JSON.stringify(found.candidate.changes)}`);
			const answer = await updateOf("pictured", askFor(found));
			assert(answer.status === 200, `the update works, got ${answer.status}: ${JSON.stringify(answer.body)}`);
			const modes = ["logo.png", "fonts/Sans.woff", "fake.png"].map((file) => (fs.statSync(path.join(store, "pictured", file)).mode & 0o777).toString(8)).join(" ");
			assert(modes === "600 600 700", `the picture and font are stored without the mark, the script with it, got ${modes}`);
		});

		await row("45 a skill stored with a marked picture lists it as a file, and its marks alone are no update and no change", async () => {
			const stored = makeRepo("stored");
			writeSkill(stored.work, "skills/stored", "stored", "Stored.");
			const folder = path.join(stored.work, "skills", "stored");
			fs.writeFileSync(path.join(folder, "logo.png"), PNG, { mode: 0o755 });
			fs.writeFileSync(path.join(folder, "notes.md"), "first\n");
			stored.commit("first");
			stored.push();
			await addMany(stored.url, ["skills/stored"]);
			// As a skill added before pictures lost the mark holds it.
			fs.chmodSync(path.join(store, "stored", "logo.png"), 0o700);
			const page = await json("/api/skills/stored");
			assert(JSON.stringify(page.body?.files) === JSON.stringify([{ path: "SKILL.md", kind: "instructions" }, { path: "logo.png", kind: "templates" }, { path: "notes.md", kind: "documents" }]), `its page lists the marked picture as a file, got ${JSON.stringify(page.body?.files)}`);
			// The repository drops the mark: the same bytes, so no update.
			fs.chmodSync(path.join(folder, "logo.png"), 0o644);
			stored.commit("unmark");
			stored.push();
			const quiet = (await checkUpdates(["stored"])).get("stored");
			assert(quiet?.state === "current", `a mark alone is no update, got ${JSON.stringify(quiet)}`);
			fs.writeFileSync(path.join(folder, "notes.md"), "second\n");
			stored.commit("second");
			stored.push();
			const found = (await checkUpdates(["stored"])).get("stored");
			const wanted = { added: [], removed: [], changed: [{ path: "notes.md", kind: "documents" }] };
			assert(found?.state === "available" && JSON.stringify(found.candidate.changes) === JSON.stringify(wanted), `the update lists the note alone, never the picture for its mark: ${JSON.stringify(wanted)}, got ${JSON.stringify(found)}`);
		});
	}
} catch (error) {
	failed.push((error as Error).stack ?? String(error));
} finally {
	try { ws?.close(); } catch {}
	try { gateway.close(); } catch {}
	try { standIn.close(); } catch {}
	await stopSmokeServer(serverProcess);
	if (failed.length > 0) {
		const output = serverOutput.join("").trim();
		if (output) console.error(output.split("\n").slice(-40).join("\n"));
		console.error(failed.join("\n"));
		console.error(`temp folder kept for inspection: ${tempRoot}`);
		process.exitCode = 1;
	} else {
		fs.rmSync(tempRoot, { recursive: true, force: true });
		console.log("skills-repo-update-smoke: OK");
	}
}
