import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { computeSkillFilesDigest, sha256, skillPackageDisplayPin, writeSkillProvenance } from "../src/skills-store.js";
import { persistentRoomSkillSettingsPath } from "../src/persistent-room-skill-settings.js";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-summary-perf-"));
const state = path.join(work, "state");
const skills = path.join(state, ".exxperts", "agent", "skills");
const project = path.join(work, "project");
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(serverDir, "..", "..");
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const policy = { designRepo: false, allowedTypes: ["markdown"] as const, skillRoot: "skills", referenceRoots: [] };
const content = "a".repeat(Math.floor(64 * 1024 * 1024 / 500));
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(project, "bin", "lib"), { recursive: true });
for (const name of fs.readdirSync(path.join(repoRoot, "bin", "lib")).filter((name) => name.endsWith(".cjs"))) fs.copyFileSync(path.join(repoRoot, "bin", "lib", name), path.join(project, "bin", "lib", name));
const auditLoader = path.join(work, "audit-reference-reads.mjs");
fs.writeFileSync(auditLoader, `
import fs from "node:fs";
import path from "node:path";
const root = ${JSON.stringify(path.resolve(skills))};
const descriptors = new Map();
const audit = { reads: 0, bytes: 0 };
const open = fs.openSync;
const close = fs.closeSync;
const read = fs.readFileSync;
fs.openSync = function(file, ...args) { const descriptor = open.call(this, file, ...args); if (typeof file === "string") descriptors.set(descriptor, file); return descriptor; };
fs.closeSync = function(descriptor) { descriptors.delete(descriptor); return close.call(this, descriptor); };
fs.readFileSync = function(file, ...args) {
  const bytes = read.call(this, file, ...args);
  const name = typeof file === "number" ? descriptors.get(file) : file;
  if (typeof name === "string" && !path.relative(root, path.resolve(name)).startsWith("..") && /^reference-\\d+\\.md$/.test(path.basename(name))) { audit.reads++; audit.bytes += typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length; }
  return bytes;
};
process.on("message", (message) => { if (message?.type === "summary-perf-audit") process.send?.({ type: "summary-perf-audit", ...audit }); });
`);
for (let index = 0; index < 25; index++) {
	const name = `synthetic-${index}`;
	const dir = path.join(skills, name);
	fs.mkdirSync(dir, { recursive: true });
	const manifest = `---\nname: ${name}\ndisplayName: Synthetic ${index}\ndescription: Synthetic performance fixture\n---\nUse the reviewed references.\n`;
	fs.writeFileSync(path.join(dir, "SKILL.md"), manifest);
	const references = Array.from({ length: 20 }, (_, file) => {
		const localPath = `reference-${file}.md`;
		fs.writeFileSync(path.join(dir, localPath), content);
		return { path: `skills/${name}/${localPath}`, localPath, kind: "markdown" as const, size: content.length, sha256: sha256(content) };
	});
	writeSkillProvenance(dir, { source: "https://example.invalid/synthetic", importedAt: "2026-01-01T00:00:00Z", license: null, sha256: sha256(manifest), filesSha256: computeSkillFilesDigest(dir)!.filesSha256, repo: { source: "https://example.invalid/synthetic", revision: "b".repeat(40), skillPath: `skills/${name}`, policy: { ...policy, allowedTypes: [...policy.allowedTypes] }, references } });
}
let output = "";
const env = smokeHomeEnv(path.join(work, "home"), { ...SMOKE_SERVER_AUTH_ENV, PORT: String(port), EXXETA_HOME: project, EXXETA_PERSISTENT_AGENTS_ROOT: path.join(state, ".exxperts", "app", "personalized-agents") });
env.EXXPERTS_STATE_HOME = state;
env.EXXPERTS_CODING_AGENT_DIR = path.dirname(skills);
const server = spawn(process.execPath, ["--import", pathToFileURL(auditLoader).href, "--import", loader, "src/index.ts"], { ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: serverDir, env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
assert(server.stdout && server.stderr, "performance fixture requires piped output");
server.stdout.on("data", (part) => { output = (output + part).slice(-6000); });
server.stderr.on("data", (part) => { output = (output + part).slice(-6000); });
async function read(route: string) {
	const started = performance.now();
	const response = await authedFetch(base + route);
	assert.equal(response.status, 200, await response.clone().text());
	return { data: await response.json(), elapsed: performance.now() - started };
}
function referenceReads(): Promise<{ reads: number; bytes: number }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Reference-read instrumentation timeout")), 5000);
		server.once("message", (message: any) => { clearTimeout(timer); assert.equal(message.type, "summary-perf-audit"); resolve(message); });
		server.send({ type: "summary-perf-audit" });
	});
}
try {
	const deadline = Date.now() + 60000;
	while (true) {
		if (server.exitCode !== null) throw new Error(output);
		try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
		if (Date.now() > deadline) throw new Error(`Server startup timeout: ${output}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const beforeFull = await referenceReads();
	const baseline = await read("/api/skills");
	const afterFull = await referenceReads();
	assert(afterFull.reads - beforeFull.reads >= 500, "full-list baseline verifies actual reference-byte read instrumentation");
	const first = await read("/api/skills?view=summary");
	const afterFirst = await referenceReads();
	assert.equal(afterFirst.reads, afterFull.reads, "summary never reads selected reference bytes");
	assert.equal(first.data.length, 25);
	assert(first.data.every((skill: any) => skill.fileCount === 20 && skill.packageSha256 === undefined && skill.locallyModified === undefined));
	const created = await authedFetch(base + "/api/persistent-agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Synthetic performance room", userName: "Synthetic", preferredUserAddress: "Synthetic" }) });
	assert.equal(created.status, 201, await created.clone().text());
	const room = (await created.json() as any).agent.id;
	const settingsFile = persistentRoomSkillSettingsPath(room, { persistentAgentsRoot: env.EXXETA_PERSISTENT_AGENTS_ROOT });
	fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
	fs.writeFileSync(settingsFile, JSON.stringify({ schemaVersion: 1, enabledSkills: first.data.map((skill: any) => ({ name: skill.name, ...skillPackageDisplayPin(path.join(skills, skill.name)) })), updatedAt: new Date().toISOString() }));
	const roomRoute = `/api/persistent-agents/${room}/skill-settings?view=summary`;
	const beforeRoom = await referenceReads();
	const roomSummary = await read(roomRoute);
	assert.equal(roomSummary.data.skills.length, 25);
	assert(roomSummary.data.skills.every((skill: any) => skill.displayName === `Synthetic ${skill.name.slice("synthetic-".length)}`), "room summaries preserve upstream skill display names without reading references");
	assert(roomSummary.data.skills.every((skill: any) => skill.status === "ok" && !skill.executable));
	assert.equal((await referenceReads()).reads, beforeRoom.reads, "room metadata must not read package/reference bytes");
	const removeStarted = performance.now();
	const removed = await authedFetch(base + roomRoute, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "disable", name: "synthetic-24" }) });
	assert.equal(removed.status, 200, await removed.clone().text());
	const removedView = await removed.json() as any;
	const removeMs = performance.now() - removeStarted;
	assert.equal(removedView.skills.length, 24);
	assert(removedView.skills.every((skill: any) => skill.displayName === `Synthetic ${skill.name.slice("synthetic-".length)}`), "mutation responses retain skill display names");
	assert(removedView.skills.every((skill: any) => typeof skill.executable === "boolean" && Array.isArray(skill.bundledFiles)), "mutation response replaces the second GET");
	assert.equal((await referenceReads()).reads, beforeRoom.reads, "removing a room skill never reads reference bytes");
	// A broken reference does not stop the metadata list; fresh detail still reports drift.
	fs.writeFileSync(path.join(skills, "synthetic-0", "reference-0.md"), "externally changed");
	assert.equal((await read("/api/skills?view=summary")).data.find((skill: any) => skill.name === "synthetic-0").fileCount, 20);
	assert.equal((await read("/api/skills/synthetic-0")).data.locallyModified, true);
	assert.equal((await read(roomRoute)).data.skills.find((skill: any) => skill.name === "synthetic-0").status, "ok", "display metadata is advisory only");
	const changedSkill = (await read(`/api/persistent-agents/${room}/skill-settings`)).data.skills.find((skill: any) => skill.name === "synthetic-0");
	assert.equal(changedSkill.status, "hash-mismatch", "full integrity view still detects changed references");
	assert.equal(changedSkill.displayName, "Synthetic 0", "a paused skill is still identified by its display name");
	const afterDetail = await referenceReads();
	assert(afterDetail.reads > afterFirst.reads, "fresh detail still performs reference integrity reads");
	const elapsed: number[] = [];
	const roomElapsed: number[] = [];
	for (let sample = 0; sample < 20; sample++) { elapsed.push((await read("/api/skills?view=summary")).elapsed); roomElapsed.push((await read(roomRoute)).elapsed); }
	elapsed.sort((a, b) => a - b);
	roomElapsed.sort((a, b) => a - b);
	const p95 = elapsed[Math.ceil(elapsed.length * 0.95) - 1];
	const roomP95 = roomElapsed[Math.ceil(roomElapsed.length * 0.95) - 1];
	const afterSamples = await referenceReads();
	assert.equal(afterSamples.reads, afterDetail.reads, "all warm summary requests remain metadata-only");
	assert(p95 <= 100, `Summary p95 ${p95.toFixed(1)}ms exceeded 100ms`);
	assert(roomP95 <= 100, `Room summary p95 ${roomP95.toFixed(1)}ms exceeded 100ms`);
	console.log(JSON.stringify({ skills: 25, references: 500, bytes: content.length * 500, fullListMs: Number(baseline.elapsed.toFixed(1)), fullListReferenceReads: afterFull.reads - beforeFull.reads, summaryFirstMs: Number(first.elapsed.toFixed(1)), summaryP95Ms: Number(p95.toFixed(1)), roomSummaryP95Ms: Number(roomP95.toFixed(1)), removeMs: Number(removeMs.toFixed(1)), summaryReferenceReads: 0 }));
} finally {
	await stopSmokeServer(server);
	if (path.dirname(path.resolve(work)) === path.resolve(os.tmpdir()) && path.basename(work).startsWith("exxperts-summary-perf-")) fs.rmSync(work, { recursive: true, force: true });
}
