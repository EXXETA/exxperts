// Update automatically, for a skill added from a repository: its switch (saved
// in the skill's record, kept by an edit, an update, a Replace from its
// repository and a check's quiet store, gone with a delete), and the daily pass:
// a look at every skill that follows a branch or a tag, which stores what it
// finds and stops there when the switch is off; and, where it is on, new
// versions taken by itself: only a version
// a check first saw 12 hours ago, never one with hidden characters or a skill
// changed on this computer, never over an installation that changed while it
// asked, a failure leaving everything as it was, one ask per repository and
// ref, its timer (2 to 10 minutes after the start, then every 24 hours, never
// two at once, none after the stop), what the page is told and when the
// notice is closed, and nothing at all on a shared server.
// The routes run on a real server; the pass runs here, in this process, on the
// same throwaway home, with its own clock. The repositories are served by git's
// own http-backend on this machine; nothing reaches a real host.
//
// Run: node scripts/run-smokes.mjs skills-auto-update

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRemoteRoute } from "../src/remote-route-policy.js";
import { pairDevice, remoteRequest } from "./smoke-pairing.js";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { gitServesHttp, startStandInGitServer, writeSkill } from "./stand-in-git-server.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

if (!gitServesHttp()) {
	console.log("SKIPPED: this git has no http-backend to serve the stand-in repositories");
	process.exit(0);
}

// The git commands a check for updates runs, each under the same hardening: the ask, the fetch (a clone, or
// init, fetch and checkout for a full commit id), the list of what it checked out, and git's own config.
const CHECK_GIT_COMMANDS = ["ls-remote", "clone", "init", "fetch", "checkout", "ls-files", "config"];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-auto-update-"));
const home = path.join(tempRoot, "home");
const store = path.join(home, ".exxperts", "agent", "skills");
const appState = path.join(home, ".exxperts", "app");
const serveRoot = path.join(tempRoot, "serve");
const workRoot = path.join(tempRoot, "work");
for (const dir of [store, appState, serveRoot, workRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

// This process works on the same home as the server it starts: the pass runs here.
Object.assign(process.env, smokeHomeEnv(home, { EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1" }));
for (const name of ["EXXPERTS_DATA_DIR", "EXXPERTS_STATE_HOME", "EXXPERTS_CODING_AGENT_DIR"]) delete process.env[name];

// Every program this process starts while `counting`, but the stand-in server's own.
const starts: string[][] = [];
let counting = false;
{
	const childProcess = createRequire(import.meta.url)("node:child_process") as Record<string, (...args: unknown[]) => unknown>;
	for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
		const original = childProcess[fn];
		childProcess[fn] = (...args: unknown[]) => {
			const argv = [String(args[0]), ...(Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [])];
			if (counting && argv[1] !== "http-backend") starts.push(argv);
			return original.apply(childProcess, args);
		};
	}
	syncBuiltinESMExports();
}

const updates = await import("../src/skill-updates.js");
const { disposeAllCheckouts } = await import("../src/skills-repo-fetch.js");
const standIn = await startStandInGitServer(serveRoot, workRoot);
const { requests: gitRequests, signedOut, held, makeRepo, countFor } = standIn;

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
async function api(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Adds the skills at `skillPaths` of `address` from one scan, the way the page does; with `replace`, as a Replace. */
async function addFrom(address: string, skillPaths: string[], replace = false): Promise<void> {
	const scan = await api("POST", "/api/skills/repo/scan", { source: address });
	assert(scan.status === 200, `the scan of ${address} works, got ${scan.status}: ${JSON.stringify(scan.body)}`);
	for (const skillPath of skillPaths) {
		const added = await api("POST", "/api/skills/repo/import", { token: scan.body.token, path: skillPath, ...(replace ? { replace: true } : {}) });
		assert(added.status === (replace ? 200 : 201), `${skillPath} is added, got ${added.status}: ${JSON.stringify(added.body)}`);
	}
}
const setSwitch = (name: string, on: unknown) => api("PUT", `/api/skills/${encodeURIComponent(name)}/auto-update`, { on });
const skillView = async (name: string): Promise<any> => ((await api("GET", "/api/skills")).body as any[]).find((skill) => skill.name === name);
async function personCheck(names: string[]): Promise<Map<string, any>> {
	const answer = await api("POST", "/api/skills/updates/check", { names });
	assert(answer.status === 200, `the check works, got ${answer.status}: ${JSON.stringify(answer.body)}`);
	return new Map((answer.body.results as any[]).map((result) => [result.name, result]));
}
const record = (name: string) => JSON.parse(fs.readFileSync(path.join(store, name, "provenance.json"), "utf-8"));
const entries = (): Record<string, any> => {
	try {
		return JSON.parse(fs.readFileSync(path.join(appState, "skill-updates.json"), "utf-8")).skills ?? {};
	} catch {
		return {};
	}
};
/** The files' hash of a skill folder, worked out here by hand: every file but the record, in code point order, path, NUL, size, NUL, bytes. */
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
const snapshot = (name: string) => JSON.stringify({ files: filesHash(path.join(store, name)), record: record(name), entry: entries()[name] ?? null });
const instructions = (name: string) => fs.readFileSync(path.join(store, name, "SKILL.md"), "utf-8");

const HOUR = 60 * 60_000;
/** The asks of one stand-in repository among the counted program starts (a clone lists the refs again, as part of its fetch). */
const lsRemotes = (repo: string) => starts.filter((argv) => argv.includes("ls-remote") && argv.some((arg) => arg.includes(`/team/${repo}.git`))).length;
const logs: string[] = [];
const logger = { info: (line: string) => logs.push(`info ${line}`), warn: (line: string) => logs.push(`warn ${line}`) };
/** One pass, as the timer runs it, at `at` on the pass's clock. */
async function passAt(at: number): Promise<any> {
	return updates.runSkillAutoUpdatePass({ now: () => new Date(at), logger });
}
/** A repository with one skill per name under skills/, pushed. */
function repoWith(name: string, skills: string[]): ReturnType<typeof makeRepo> {
	const repo = makeRepo(name);
	for (const skill of skills) writeSkill(repo.work, `skills/${skill}`, skill, `The ${skill} instructions, first.`);
	repo.commit("first");
	repo.push();
	return repo;
}
function newVersion(repo: ReturnType<typeof makeRepo>, skill: string, body: string): void {
	writeSkill(repo.work, `skills/${skill}`, skill, body);
	repo.commit(body);
	repo.push();
}
/** Holds the stand-in's answers for `repo` until the returned release is called. */
function hold(repo: string): () => void {
	let release = () => {};
	held.set(repo, new Promise<void>((resolve) => { release = resolve; }));
	return () => {
		held.delete(repo);
		release();
	};
}
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		assert(Date.now() < deadline, `timed out waiting until ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
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

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(home, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1", EXXPERTS_REMOTE_TEST_ADDRESS: "::1" }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, { tries: 100 });

	// --- The switch ---------------------------------------------------------------

	const lib = repoWith("lib", ["alpha", "beta", "gamma", "delta"]);
	await addFrom(lib.url, ["skills/alpha", "skills/beta", "skills/gamma", "skills/delta"]);

	await row("1 the switch is saved, and the library shows it", async () => {
		const answer = await setSwitch("alpha", true);
		assert(answer.status === 200, `the switch is saved, got ${answer.status}: ${JSON.stringify(answer.body)}`);
		assert(record("alpha").autoUpdate === true, `the record keeps it, got ${JSON.stringify(record("alpha"))}`);
		assert((await skillView("alpha"))?.repository?.autoUpdate === true, `GET /api/skills shows it on, got ${JSON.stringify((await skillView("alpha"))?.repository)}`);
		assert((await api("GET", "/api/skills/alpha")).body?.repository?.autoUpdate === true, "and the skill's page reads it");
	});

	await row("2 off until turned on; off again; unknown 404, fixed to a commit or without a repository refused, a bad body 400", async () => {
		assert((await skillView("beta"))?.repository?.autoUpdate === false && record("beta").autoUpdate === undefined, `off by default, got ${JSON.stringify((await skillView("beta"))?.repository)}`);
		assert((await setSwitch("alpha", false)).status === 200 && record("alpha").autoUpdate === undefined && (await skillView("alpha"))?.repository?.autoUpdate === false, "turned off, the record has no switch");
		assert((await setSwitch("no-such-skill", true)).status === 404, "an unknown skill is 404");
		fs.mkdirSync(path.join(store, "rho"), { recursive: true });
		writeSkill(store, "rho", "rho", "The rho instructions.");
		fs.writeFileSync(path.join(store, "rho", "provenance.json"), JSON.stringify({ source: lib.url, importedAt: new Date().toISOString(), license: null, sha256: "0".repeat(64), repository: { address: lib.url, ref: "a".repeat(40), refKind: "commit", path: "skills/rho", commit: "a".repeat(40), filesSha256: "" } }));
		const pinned = await setSwitch("rho", true);
		assert(pinned.status === 409 && pinned.body?.code === "auto-update-unavailable" && record("rho").autoUpdate === undefined, `fixed to a commit: refused, got ${pinned.status} ${JSON.stringify(pinned.body)}`);
		assert((await api("POST", "/api/skills", { id: "by-hand", displayName: "by-hand", description: "Written here", instructions: "By hand." })).status === 201, "a skill written here");
		const local = await setSwitch("by-hand", true);
		assert(local.status === 409 && local.body?.code === "auto-update-unavailable" && record("by-hand").autoUpdate === undefined, `without a repository: refused, got ${local.status} ${JSON.stringify(local.body)}`);
		for (const body of [{}, { on: "yes" }, { on: 1 }]) {
			const bad = await api("PUT", "/api/skills/beta/auto-update", body);
			assert(bad.status === 400, `${JSON.stringify(body)} is 400, got ${bad.status}`);
		}
		assert(record("beta").autoUpdate === undefined, "and nothing was saved");
	});

	await row("3 an edit, an update and a Replace from its repository keep the switch; a delete takes it away", async () => {
		assert((await setSwitch("beta", true)).status === 200, "beta on");
		assert((await api("PUT", "/api/skills/beta", { displayName: "beta", description: "The beta skill.", instructions: "Edited here." })).status === 200, "beta edited");
		assert(record("beta").autoUpdate === true, "an edit keeps it");
		await addFrom(lib.url, ["skills/beta"], true);
		assert(record("beta").autoUpdate === true, `a Replace from its repository keeps it, got ${JSON.stringify(record("beta"))}`);
		newVersion(lib, "beta", "The beta instructions, second.");
		const found = (await personCheck(["beta"])).get("beta");
		assert(found?.state === "available", `beta has an update, got ${JSON.stringify(found)}`);
		const updated = await api("POST", "/api/skills/beta/update", { candidate: found.candidate.id, installedFilesSha256: found.installedFilesSha256 });
		assert(updated.status === 200 && instructions("beta").includes("second"), `beta updated, got ${updated.status} ${JSON.stringify(updated.body)}`);
		assert(record("beta").autoUpdate === true, "an update keeps it");
		assert((await api("DELETE", "/api/skills/beta")).status === 200, "beta deleted");
		await addFrom(lib.url, ["skills/beta"]);
		assert(record("beta").autoUpdate === undefined && (await skillView("beta"))?.repository?.autoUpdate === false, "added again, it starts off");
	});

	await row("4 a check's quiet store keeps the switch as it was turned while the check asked", async () => {
		assert((await setSwitch("gamma", true)).status === 200, "gamma on");
		// A commit that changes no file of gamma's: the check stores the new commit quietly.
		fs.writeFileSync(path.join(lib.work, "README.md"), "unrelated\n");
		const moved = lib.commit("unrelated");
		lib.push();
		const release = hold("lib");
		const checking = personCheck(["gamma"]);
		await waitUntil(() => gitRequests.some((request) => request.repo === "lib"), "the check is asking");
		assert((await setSwitch("gamma", false)).status === 200, "gamma turned off while the check asks");
		release();
		const found = (await checking).get("gamma");
		assert(found?.state === "current", `gamma is current, got ${JSON.stringify(found)}`);
		assert(record("gamma").repository.commit === moved, "the new commit was stored quietly");
		assert(record("gamma").autoUpdate === undefined, `the switch stays off, as it was turned, got ${JSON.stringify(record("gamma"))}`);
	});

	// --- The pass -------------------------------------------------------------------

	await row("5 the pass updates a skill whose switch is on and whose new version a check first saw 12 hours ago", async () => {
		assert((await setSwitch("alpha", true)).status === 200, "alpha on");
		newVersion(lib, "alpha", "The alpha instructions, second.");
		const seen = Date.now();
		assert((await personCheck(["alpha"])).get("alpha")?.state === "available", "a person's check sees the new version");
		const result = await passAt(seen + 12 * HOUR + 60_000);
		assert(instructions("alpha").includes("second"), `alpha has the new version, got ${instructions("alpha")}; the pass said ${JSON.stringify(result)}`);
		assert(record("alpha").repository.filesSha256 === filesHash(path.join(store, "alpha")) && record("alpha").autoUpdate === true, "its record names the new files and keeps the switch");
		const view = await skillView("alpha");
		assert(view?.update?.updated?.automatic === true && !view.update.updated.noticeClosed, `the page is told the pass made it, got ${JSON.stringify(view?.update)}`);
		assert(view.update.updated.changes.changed.some((file: any) => file.path === "SKILL.md"), "with what changed");
		assert(logs.some((line) => line.startsWith("info") && line.includes("alpha") && /updated/.test(line)), `a log line says so, got ${JSON.stringify(logs)}`);
	});

	await row("6 a skill whose switch is off is looked at: its update shows, and it is neither installed nor named in a notice; its neighbour with the switch on is", async () => {
		const other = repoWith("other", ["omega", "wide", "taken"]);
		await addFrom(other.url, ["skills/omega", "skills/wide", "skills/taken"]);
		assert((await setSwitch("taken", true)).status === 200, "taken on");
		for (const name of ["omega", "taken"]) newVersion(other, name, `The ${name} instructions, second.`);
		newVersion(other, "wide", "The wide instructions,\u200b second.");
		const was = new Map(["omega", "wide"].map((name) => [name, filesHash(path.join(store, name))]));
		const recordWas = JSON.stringify(record("omega"));
		const seen = Date.now();
		gitRequests.length = 0;
		await passAt(seen);
		assert(JSON.stringify(countFor("other").fetches) === "1", `one fetch for the three, got ${JSON.stringify(countFor("other"))}`);
		const row = await skillView("omega");
		assert(row?.update?.state === "available" && row.update.candidate?.changes.changed.some((file: any) => file.path === "SKILL.md"), `omega's row has its update, got ${JSON.stringify(row?.update)}`);
		const later = await passAt(seen + 13 * HOUR);
		assert(instructions("taken").includes("second"), "taken, whose switch is on, has the new version");
		for (const name of ["omega", "wide"]) {
			assert(filesHash(path.join(store, name)) === was.get(name), `${name} is as it was`);
			const update = (await skillView(name))?.update;
			assert(update?.state === "available" && !update.updated && !update.autoSkipped, `${name} keeps its update, in no notice, got ${JSON.stringify(update)}`);
			assert(!Object.values(later).some((names) => (names as string[]).includes(name)), `${name} is only looked at, got ${JSON.stringify(later)}`);
		}
		assert(JSON.stringify(record("omega")) === recordWas, "omega's record is as it was");
		assert(entries().rho === undefined, "rho, fixed to a commit, is not looked at");
		// A repository that doesn't answer leaves omega's earlier result.
		const entryWas = JSON.stringify(entries().omega);
		signedOut.add("other");
		try {
			await passAt(seen + 37 * HOUR);
		} finally {
			signedOut.delete("other");
		}
		assert(JSON.stringify(entries().omega) === entryWas, "omega's earlier result stays");
		// The switch turned on: the version was first seen long ago, so the next pass takes it.
		assert((await setSwitch("omega", true)).status === 200, "omega on");
		await passAt(seen + 38 * HOUR);
		assert(instructions("omega").includes("second"), "omega has the new version once its switch is on");
	});

	await row("7 a switch turned off while the pass asks stops it", async () => {
		assert((await setSwitch("delta", true)).status === 200, "delta on");
		newVersion(lib, "delta", "The delta instructions, second.");
		const seen = Date.now();
		assert((await personCheck(["delta"])).get("delta")?.state === "available", "delta has an update");
		const was = filesHash(path.join(store, "delta"));
		const release = hold("lib");
		gitRequests.length = 0;
		const passing = passAt(seen + 13 * HOUR);
		await waitUntil(() => gitRequests.some((request) => request.repo === "lib"), "the pass is asking");
		assert((await setSwitch("delta", false)).status === 200, "delta turned off");
		release();
		await passing;
		assert(filesHash(path.join(store, "delta")) === was && !instructions("delta").includes("second"), "delta is as it was");
	});

	await row("8 12 hours: nothing at 11, the update at 12; another version starts the 12 hours again; a person's check counts", async () => {
		const timed = repoWith("timed", ["kappa"]);
		await addFrom(timed.url, ["skills/kappa"]);
		assert((await setSwitch("kappa", true)).status === 200, "kappa on");
		newVersion(timed, "kappa", "The kappa instructions, second.");
		assert((await personCheck(["kappa"])).get("kappa")?.state === "available", "a person's check is the first sight");
		const seen = Date.now();
		const was = filesHash(path.join(store, "kappa"));
		await passAt(seen + 11 * HOUR);
		assert(filesHash(path.join(store, "kappa")) === was, "at 11 hours nothing changes");
		await passAt(seen + 12 * HOUR);
		assert(instructions("kappa").includes("second"), "at 12 hours it updates");
		const start = seen + 13 * HOUR;
		newVersion(timed, "kappa", "The kappa instructions, third.");
		await passAt(start);
		assert(instructions("kappa").includes("second"), "a version first seen now waits");
		newVersion(timed, "kappa", "The kappa instructions, fourth.");
		await passAt(start + 12 * HOUR);
		assert(instructions("kappa").includes("second"), `another version 12 hours after the first one's sight starts the 12 hours again, got ${instructions("kappa")}`);
		await passAt(start + 24 * HOUR);
		assert(instructions("kappa").includes("fourth"), "12 hours after its own first sight it updates");
	});

	await row("9 the two skips: hidden characters and a skill changed here are left as they were; the person's Update still stops", async () => {
		const skips = repoWith("skips", ["hidden", "edited"]);
		await addFrom(skips.url, ["skills/hidden", "skills/edited"]);
		for (const name of ["hidden", "edited"]) assert((await setSwitch(name, true)).status === 200, `${name} on`);
		writeSkill(skips.work, "skills/hidden", "hidden", "The hidden instructions,​ second.");
		writeSkill(skips.work, "skills/edited", "edited", "The edited instructions, second.");
		skips.commit("second");
		skips.push();
		const manifest = path.join(store, "edited", "SKILL.md");
		fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf-8").replace("first.", "first, changed here."));
		const seen = Date.now();
		await personCheck(["hidden", "edited"]);
		const was = { hidden: filesHash(path.join(store, "hidden")), edited: filesHash(path.join(store, "edited")) };
		logs.length = 0;
		await passAt(seen + 13 * HOUR);
		assert(filesHash(path.join(store, "hidden")) === was.hidden && filesHash(path.join(store, "edited")) === was.edited, "both are as they were");
		assert(fs.readFileSync(manifest, "utf-8").includes("changed here"), "the change made here stays");
		for (const name of ["hidden", "edited"]) {
			const view = await skillView(name);
			assert(view?.update?.state === "available" && view.update.autoSkipped && !view.update.autoSkipped.noticeClosed, `${name} keeps its Update and is named for the notice, got ${JSON.stringify(view?.update)}`);
			assert(logs.some((line) => line.includes(name)), `a log line names ${name}, got ${JSON.stringify(logs)}`);
		}
		// The pass ran in this process, so its held versions are here: the person's page checks again, as it does after a refusal.
		await personCheck(["hidden", "edited"]);
		const hidden = await skillView("hidden");
		assert(hidden?.update?.autoSkipped && !hidden.update.autoSkipped.noticeClosed, "a person's check of the same version keeps it named");
		const stop = await api("POST", "/api/skills/hidden/update", { candidate: hidden.update.candidate.id, installedFilesSha256: hidden.update.installedFilesSha256 });
		assert(stop.status === 409 && stop.body?.code === "skill-update-hidden-characters", `the person's Update stops at the warning, got ${stop.status} ${JSON.stringify(stop.body)}`);
		const edited = await skillView("edited");
		const ask = await api("POST", "/api/skills/edited/update", { candidate: edited.update.candidate.id, installedFilesSha256: edited.update.installedFilesSha256 });
		assert(ask.status === 409 && ask.body?.code === "skill-changed-here", `the person's Update warns once, got ${ask.status} ${JSON.stringify(ask.body)}`);
	});

	await row("10 bound to one installation: deleted and added again, replaced by an upload or edited while the pass asks is not overwritten; a person's Update then stands", async () => {
		const bound = repoWith("bound", ["readd", "upload", "edit", "mine"]);
		await addFrom(bound.url, ["skills/readd", "skills/upload", "skills/edit", "skills/mine"]);
		for (const name of ["readd", "upload", "edit", "mine"]) assert((await setSwitch(name, true)).status === 200, `${name} on`);
		for (const name of ["readd", "upload", "edit", "mine"]) writeSkill(bound.work, `skills/${name}`, name, `The ${name} instructions, second.`);
		bound.commit("second");
		bound.push();
		const seen = Date.now();
		const person = await personCheck(["mine"]);
		await personCheck(["readd", "upload", "edit"]);
		const release = hold("bound");
		gitRequests.length = 0;
		const passing = passAt(seen + 13 * HOUR);
		await waitUntil(() => gitRequests.some((request) => request.repo === "bound"), "the pass is asking");
		// While it asks: one deleted and added again (from the first version, served by a copy), one replaced by an upload, one edited, and a person's Update.
		const copy = makeRepo("bound-first");
		writeSkill(copy.work, "skills/readd", "readd", "The readd instructions, first.");
		copy.commit("first");
		copy.push();
		assert((await api("DELETE", "/api/skills/readd")).status === 200, "readd deleted");
		await addFrom(copy.url, ["skills/readd"]);
		const upload = await api("POST", "/api/skills/upload", { filename: "SKILL.md", contentBase64: Buffer.from("---\nname: upload\ndescription: The upload skill.\n---\n\nUploaded here.\n").toString("base64") });
		assert(upload.status === 200 && upload.body?.replaces === true, `the upload offers Replace, got ${upload.status} ${JSON.stringify(upload.body)}`);
		assert((await api("POST", "/api/skills/accept", { ...upload.body, id: "upload", displayName: "upload", instructions: upload.body.body, replace: true })).status === 200, "upload replaced by an upload");
		assert((await api("PUT", "/api/skills/edit", { displayName: "edit", description: "The edit skill.", instructions: "Edited in the app." })).status === 200, "edit edited");
		const mine = person.get("mine");
		assert((await api("POST", "/api/skills/mine/update", { candidate: mine.candidate.id, installedFilesSha256: mine.installedFilesSha256 })).status === 200, "the person's Update of mine");
		const mineAfter = snapshot("mine");
		release();
		await passing;
		assert(instructions("readd").includes("first") && record("readd").autoUpdate === undefined, `readd added again is not overwritten, got ${instructions("readd")}`);
		assert(instructions("upload").includes("Uploaded here."), `upload replaced by an upload is not overwritten, got ${instructions("upload")}`);
		assert(instructions("edit").includes("Edited in the app."), `edit edited is not overwritten, got ${instructions("edit")}`);
		assert(snapshot("mine") === mineAfter && (await skillView("mine"))?.update?.updated?.automatic !== true, "the person's Update stands as theirs");
	});

	await row("11 failures leave the skill and its earlier result as they were, with a log line, and nothing asks to sign in", async () => {
		const fails = repoWith("fails", ["offline", "locked", "gone", "moved", "big"]);
		await addFrom(fails.url, ["skills/offline", "skills/locked", "skills/gone", "skills/moved", "skills/big"]);
		for (const name of ["offline", "locked", "gone", "moved", "big"]) assert((await setSwitch(name, true)).status === 200, `${name} on`);
		for (const name of ["offline", "locked", "gone", "moved"]) writeSkill(fails.work, `skills/${name}`, name, `The ${name} instructions, second.`);
		fs.mkdirSync(path.join(fails.work, "skills", "big", "many"), { recursive: true });
		for (let i = 0; i < 2100; i += 1) fs.writeFileSync(path.join(fails.work, "skills", "big", "many", `f${i}.md`), `${i}\n`);
		fails.commit("second");
		fails.push();
		const seen = Date.now();
		await personCheck(["offline", "locked", "gone", "moved", "big"]);
		// Each of the four first ones now reaches its repository another way that fails.
		const closed = await freePort();
		const repoint = (name: string, address: string) => {
			const was = record(name);
			fs.writeFileSync(path.join(store, name, "provenance.json"), JSON.stringify({ ...was, source: address, repository: { ...was.repository, address } }));
			// The earlier result speaks of this record, as a check of it would have stored it.
			const file = path.join(appState, "skill-updates.json");
			const all = JSON.parse(fs.readFileSync(file, "utf-8"));
			all.skills[name].repository = { ...all.skills[name].repository, address };
			fs.writeFileSync(file, JSON.stringify(all));
		};
		const lockedRepo = makeRepo("fails-locked");
		lockedRepo.commit("first");
		lockedRepo.push();
		repoint("offline", `http://127.0.0.1:${closed}/team/fails.git`);
		repoint("locked", lockedRepo.url);
		repoint("gone", `http://127.0.0.1:${standIn.port()}/team/no-such.git`);
		repoint("moved", `http://127.0.0.1:${standIn.port()}/team/fails-renamed.git`);
		signedOut.add("fails-locked");
		const was = Object.fromEntries(["offline", "locked", "gone", "moved", "big"].map((name) => [name, snapshot(name)]));
		// The too-big version is asked as any other, so its result is found again: the same version, with a new time and hold.
		const found = (name: string) => JSON.stringify({ files: filesHash(path.join(store, name)), record: record(name), state: entries()[name]?.state, version: entries()[name]?.candidate?.filesSha256 });
		const bigWas = found("big");
		logs.length = 0;
		starts.length = 0;
		counting = true;
		try {
			await passAt(seen + 13 * HOUR);
		} finally {
			counting = false;
			signedOut.delete("fails-locked");
		}
		assert(found("big") === bigWas && entries().big?.state === "available", "big is as it was, and its update is still found");
		for (const name of ["offline", "locked", "gone", "moved", "big"]) {
			if (name !== "big") assert(snapshot(name) === was[name], `${name} and its earlier result are as they were`);
			assert(logs.some((line) => line.startsWith("warn") && line.includes(`“${name}”`)), `a log line names ${name}, got ${JSON.stringify(logs)}`);
		}
		assert(!logs.some((line) => line.includes("127.0.0.1") || line.includes("http")), `no log line names an address, got ${JSON.stringify(logs)}`);
		const prompts = starts.filter((argv) => !/git(\.exe)?$/.test(argv[0]) || !argv.some((arg) => CHECK_GIT_COMMANDS.includes(arg)));
		assert(prompts.length === 0, `only the check's own git starts, nothing that asks to sign in, got ${JSON.stringify(prompts)}`);
	});

	await row("11b on a Mac without Apple's command line tools neither the pass nor the page's own check opens an install window; a person's own check still does", async () => {
		if (process.platform !== "darwin") {
			console.log("  11b skipped: only a Mac has Apple's stand-in git");
			return;
		}
		const tools = repoWith("tools", ["upsilon"]);
		await addFrom(tools.url, ["skills/upsilon"]);
		assert((await setSwitch("upsilon", true)).status === 200, "upsilon on");
		const stub = path.join(tempRoot, "stub-git");
		fs.mkdirSync(stub);
		// portability-ok: the row runs only on a Mac, whose stand-in git without the tools is a program that answers like this one
		fs.writeFileSync(path.join(stub, "git"), "#!/bin/sh\necho 'xcode-select: note: No developer tools were found, requesting install.' >&2\nexit 1\n", { mode: 0o755 });
		// Never the real window: a start of this path is counted, and it fails.
		const installWindow = path.join(tempRoot, "install-window");
		const was = { path: process.env.PATH, install: process.env.EXXPERTS_DEVTOOLS_INSTALL_COMMAND };
		const opened = () => starts.filter((argv) => argv[0] === installWindow).length;
		process.env.PATH = stub;
		process.env.EXXPERTS_DEVTOOLS_INSTALL_COMMAND = installWindow;
		logs.length = 0;
		starts.length = 0;
		counting = true;
		try {
			const done = await passAt(Date.now());
			assert(done.failed.includes("upsilon") && logs.some((line) => line.startsWith("warn") && line.includes("“upsilon”")), `the pass couldn't ask, with a log line, got ${JSON.stringify(done)} ${JSON.stringify(logs)}`);
			assert(opened() === 0, `the pass opens no install window, got ${JSON.stringify(starts)}`);
			await updates.checkSkillLibrary(["upsilon"], { allowLocal: true, for: "page" });
			assert(entries().upsilon?.missed && opened() === 0, `the page's own check tried and opens none, got ${JSON.stringify(entries().upsilon)} ${JSON.stringify(starts)}`);
			assert(!(await skillView("upsilon"))?.update?.missed, "and the skill's page says nothing of it");
			await updates.checkSkillUpdates(["upsilon"], { allowLocal: true });
			assert(opened() === 1, `a person's check asks macOS for it, got ${JSON.stringify(starts)}`);
		} finally {
			counting = false;
			process.env.PATH = was.path;
			if (was.install === undefined) delete process.env.EXXPERTS_DEVTOOLS_INSTALL_COMMAND;
			else process.env.EXXPERTS_DEVTOOLS_INSTALL_COMMAND = was.install;
		}
	});

	await row("12 how often: one ask per repository and ref, a fetch only for a ref that moved, and no other program start", async () => {
		const often = repoWith("often", ["nu", "xi", "pi"]);
		await addFrom(often.url, ["skills/nu", "skills/xi", "skills/pi"]);
		for (const name of ["nu", "xi", "pi"]) assert((await setSwitch(name, true)).status === 200, `${name} on`);
		for (const name of ["nu", "xi", "pi"]) {
			const skill = path.join(often.work, "skills", name, "run.sh");
			// portability-ok: the script is only installed, never run; the row proves it never runs
			fs.writeFileSync(skill, `#!/bin/sh\ntouch ${JSON.stringify(path.join(tempRoot, `ran-${name}`))}\n`, { mode: 0o755 });
		}
		often.commit("scripts");
		often.push();
		gitRequests.length = 0;
		starts.length = 0;
		counting = true;
		try {
			await passAt(Date.now());
		} finally {
			counting = false;
		}
		assert(lsRemotes("often") === 1 && countFor("often").fetches === 1, `three skills of a moved repository: one ask and one fetch, got ${lsRemotes("often")} asks, ${JSON.stringify(countFor("often"))}`);
		const programs = starts.map((argv) => argv.find((arg) => CHECK_GIT_COMMANDS.includes(arg)) ?? argv.join(" "));
		assert(programs.every((program) => CHECK_GIT_COMMANDS.includes(program)), `only the check's own git commands, got ${JSON.stringify(starts)}`);
		// As 12 hours on, nothing is held any more.
		disposeAllCheckouts();
		gitRequests.length = 0;
		await passAt(Date.now() + 13 * HOUR);
		assert(countFor("often").fetches === 1 && ["nu", "xi", "pi"].every((name) => fs.existsSync(path.join(store, name, "run.sh"))), `12 hours on, one fetch updates all three, got ${JSON.stringify(countFor("often"))}`);
		gitRequests.length = 0;
		starts.length = 0;
		counting = true;
		try {
			await passAt(Date.now() + 26 * HOUR);
		} finally {
			counting = false;
		}
		assert(lsRemotes("often") === 1 && countFor("often").fetches === 0, `a ref that didn't move is asked once and not fetched, got ${lsRemotes("often")} asks, ${JSON.stringify(countFor("often"))}`);
		assert(["nu", "xi", "pi"].every((name) => !fs.existsSync(path.join(tempRoot, `ran-${name}`))), "the installed scripts never ran");
	});

	await row("12b a page opened while the pass runs asks nothing again, and asks what the pass couldn't reach", async () => {
		const names = ["nu", "xi", "pi"];
		const openPage = () => updates.checkSkillLibrary(names, { allowLocal: true, for: "page" });
		const due = async () => (await skillView("nu")).repository.checkDue;
		assert(await due(), "the skills' check is due");
		starts.length = 0;
		gitRequests.length = 0;
		counting = true;
		try {
			const release = hold("often");
			const pass = passAt(Date.now());
			await waitUntil(() => gitRequests.some((request) => request.repo === "often"), "the pass is asking");
			const opened = openPage();
			release();
			const [, answer] = await Promise.all([pass, opened]);
			assert(lsRemotes("often") === 1 && answer.results.length === 0 && !(await due()), `one ask for both, got ${lsRemotes("often")}`);

			// The pass meets a repository that refuses; the page, after it, asks for itself.
			const stored = entries();
			for (const name of names) stored[name].checkedAt = new Date(Date.now() - 2 * HOUR).toISOString();
			fs.writeFileSync(path.join(appState, "skill-updates.json"), JSON.stringify({ skills: stored }));
			starts.length = 0;
			gitRequests.length = 0;
			signedOut.add("often");
			const releaseRefused = hold("often");
			const refused = passAt(Date.now());
			await waitUntil(() => gitRequests.some((request) => request.repo === "often"), "the pass is asking");
			const after = openPage();
			releaseRefused();
			await Promise.all([refused, after]);
			assert(lsRemotes("often") === 2, `the page asks what the pass missed, got ${lsRemotes("often")}`);
		} finally {
			counting = false;
			signedOut.delete("often");
		}
	});

	await row("13 the timer: first 2 to 10 minutes after the start, then 24 hours after each pass, never two at once, none after the stop", async () => {
		for (const [random, wanted] of [[0, 2 * 60_000], [0.999999, 10 * 60_000]] as const) {
			const armed: number[] = [];
			const loop = updates.startSkillAutoUpdates({ logger, random: () => random, timers: { set: (_run: () => void, ms: number) => { armed.push(ms); return armed.length; }, clear: () => {} } });
			loop.stop();
			assert(armed.length === 1 && Math.abs(armed[0] - wanted) < 1000, `the first pass is armed ${wanted} ms after the start, got ${JSON.stringify(armed)}`);
		}
		const pending = new Map<number, () => void>();
		const armed: number[] = [];
		let next = 0;
		const timers = { set: (run: () => void, ms: number) => { armed.push(ms); pending.set(++next, run); return next; }, clear: (handle: unknown) => { pending.delete(handle as number); } };
		const fire = () => {
			const [handle, run] = [...pending.entries()].at(-1)!;
			pending.delete(handle);
			run();
		};
		gitRequests.length = 0;
		starts.length = 0;
		counting = true;
		const release = hold("often");
		const loop = updates.startSkillAutoUpdates({ logger, random: () => 0.5, timers });
		fire();
		await waitUntil(() => gitRequests.some((request) => request.repo === "often"), "the first pass is asking");
		assert(pending.size === 0, "while a pass runs, no next one is armed");
		const second = updates.runSkillAutoUpdatePass({ logger });
		release();
		await second;
		await waitUntil(() => pending.size === 1, "the next pass is armed once this one ends");
		counting = false;
		assert(lsRemotes("often") === 1, `a pass asked to run while one runs joins it, got ${lsRemotes("often")} asks`);
		assert(armed.at(-1) === 24 * HOUR, `the next pass 24 hours later, got ${JSON.stringify(armed)}`);
		loop.stop();
		assert(pending.size === 0, "the stop clears the armed pass");
		const stopRelease = hold("often");
		gitRequests.length = 0;
		const late = updates.startSkillAutoUpdates({ logger, random: () => 0.5, timers });
		fire();
		await waitUntil(() => gitRequests.some((request) => request.repo === "often"), "a pass is asking");
		late.stop();
		stopRelease();
		await waitUntil(() => !late.isRunning(), "the pass ends");
		assert(pending.size === 0, "after the stop, no pass is armed again");
	});

	// --- Told -------------------------------------------------------------------------

	await row("14 told: the page names what the pass updated and skipped until the notice is closed, and a later update shows again", async () => {
		const shown = async (name: string) => {
			const update = (await skillView(name))?.update;
			return Boolean((update?.updated?.automatic && !update.updated.noticeClosed) || (update?.autoSkipped && !update.autoSkipped.noticeClosed));
		};
		assert((await shown("alpha")) && (await shown("hidden")) && (await shown("kappa")), "alpha and kappa updated, hidden skipped, are shown");
		const close = (notices: unknown) => api("POST", "/api/skills/updates/seen", { notices });
		for (const body of [{}, { names: ["alpha"] }, { notices: "alpha" }, { notices: [1] }, { notices: [{ name: 1 }] }, { notices: [{ name: "alpha", updatedAt: 3 }] }]) assert((await api("POST", "/api/skills/updates/seen", body)).status === 400, `${JSON.stringify(body)} is 400`);
		// What the notice showed: each update's time, each left version's files.
		const updatedShown = async (name: string) => ({ name, updatedAt: (await skillView(name)).update.updated.at as string });
		const leftShown = async (name: string) => ({ name, skippedVersion: (await skillView(name)).update.candidate.filesSha256 as string });
		const alphaSecond = await updatedShown("alpha");
		const seen = await close([alphaSecond, await leftShown("hidden")]);
		assert(seen.status === 200, `closed, got ${seen.status} ${JSON.stringify(seen.body)}`);
		assert(!(await shown("alpha")) && !(await shown("hidden")) && (await shown("kappa")), "only what was sent is closed");
		assert(entries().alpha?.updated?.noticeClosed === true, "and it is stored, so it stays closed after a reload");
		assert((await close([{ name: "kappa" }, { name: "kappa", updatedAt: "2000-01-01T00:00:00.000Z" }])).status === 200 && (await shown("kappa")), "a name alone, or another update's time, closes nothing");
		newVersion(lib, "alpha", "The alpha instructions, third.");
		await passAt(Date.now());
		await passAt(Date.now() + 13 * HOUR);
		assert(instructions("alpha").includes("third") && (await shown("alpha")), "a later pass's update shows again");
		assert((await close([alphaSecond])).status === 200 && (await shown("alpha")), "a notice that showed the earlier update leaves the later one named");
		// A version left for the person after a notice showed the update: closing that notice leaves it named.
		const alphaThird = await updatedShown("alpha");
		const alphaManifest = path.join(store, "alpha", "SKILL.md");
		fs.writeFileSync(alphaManifest, fs.readFileSync(alphaManifest, "utf-8").replace("third.", "third, changed here."));
		newVersion(lib, "alpha", "The alpha instructions, fourth.");
		await personCheck(["alpha"]);
		await passAt(Date.now() + 13 * HOUR);
		const alpha = (await skillView("alpha"))?.update;
		assert(alpha?.autoSkipped && !alpha.autoSkipped.noticeClosed && alpha.updated?.at === alphaThird.updatedAt, `alpha's fourth version is left for the person, got ${JSON.stringify(alpha)}`);
		assert((await close([{ name: "alpha", skippedVersion: "0".repeat(64) }])).status === 200 && !(await skillView("alpha"))?.update?.autoSkipped?.noticeClosed, "another version's files close nothing");
		assert((await close([alphaThird])).status === 200, "the notice that showed the update is closed");
		const after = (await skillView("alpha"))?.update;
		assert(after?.updated?.noticeClosed && after.autoSkipped && !after.autoSkipped.noticeClosed, `the update it showed is closed and the version left after it stays named, got ${JSON.stringify(after)}`);
		const hidden = await skillView("hidden");
		await passAt(Date.now() + 14 * HOUR);
		assert(!(await shown("hidden")) && (await skillView("hidden"))?.update?.candidate?.filesSha256 === hidden.update.candidate.filesSha256, "a skipped version once closed is not named again");
	});

	await row("15 both routes are this computer's only: a phone is refused at each", async () => {
		assert(classifyRemoteRoute("PUT", "/api/skills/:id/auto-update") === "local" && classifyRemoteRoute("POST", "/api/skills/updates/seen") === "local", "both routes are local");
		assert((await api("POST", "/api/remote/enable", {})).status === 200, "remote access on");
		const device = await pairDevice(port, "Auto update phone");
		for (const [method, pathname, body] of [["PUT", "/api/skills/kappa/auto-update", { on: false }], ["POST", "/api/skills/updates/seen", { notices: [{ name: "kappa", updatedAt: entries().kappa?.updated?.at }] }]] as const) {
			const answer = await remoteRequest(port, pathname, { method, headers: { Cookie: device.cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
			assert(answer.status === 403 && JSON.parse(answer.body)?.code === "remote_local_only", `${method} ${pathname} from a phone: 403, got ${answer.status} ${answer.body}`);
		}
		assert(record("kappa").autoUpdate === true && !entries().kappa?.updated?.noticeClosed, "and nothing changed");
	});

	// --- A shared server: last, since this process then stays one --------------------

	await row("16 on a shared server the start arms no timer, and the pass's entry changes nothing", async () => {
		const shared = repoWith("shared", ["sigma"]);
		await addFrom(shared.url, ["skills/sigma"]);
		assert((await setSwitch("sigma", true)).status === 200, "sigma on");
		newVersion(shared, "sigma", "The sigma instructions, second.");
		const seen = Date.now();
		assert((await personCheck(["sigma"])).get("sigma")?.state === "available", "sigma has an update");
		const { registerServerHooks } = await import("../src/server-hooks.js");
		registerServerHooks({});
		const armed: number[] = [];
		const loop = updates.startSkillAutoUpdates({ logger, random: () => 0.5, timers: { set: (_run: () => void, ms: number) => { armed.push(ms); return 1; }, clear: () => {} } });
		loop.stop();
		assert(armed.length === 0, `no timer is armed, got ${JSON.stringify(armed)}`);
		const stateBefore = fs.readFileSync(path.join(appState, "skill-updates.json"), "utf-8");
		const was = snapshot("sigma");
		gitRequests.length = 0;
		starts.length = 0;
		counting = true;
		try {
			await passAt(seen + 13 * HOUR);
		} finally {
			counting = false;
		}
		assert(gitRequests.length === 0 && starts.length === 0, `no repository asked and no program started, got ${gitRequests.length} requests, ${JSON.stringify(starts)}`);
		assert(snapshot("sigma") === was && fs.readFileSync(path.join(appState, "skill-updates.json"), "utf-8") === stateBefore, "no file written, sigma as it was");
	});
} catch (error) {
	failed.push((error as Error).stack ?? String(error));
} finally {
	try { standIn.close(); } catch {}
	await stopSmokeServer(server);
	if (failed.length > 0) {
		const output = serverOutput.join("").trim();
		if (output) console.error(output.split("\n").slice(-30).join("\n"));
		console.error(failed.join("\n"));
		console.error(`temp folder kept for inspection: ${tempRoot}`);
		process.exitCode = 1;
	} else {
		fs.rmSync(tempRoot, { recursive: true, force: true });
		console.log("skills-auto-update smoke: ok");
	}
}
