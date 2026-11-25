// Looking for new versions of the person's skills, through the real server:
// the check the page makes by itself as it opens (only skills last asked over an
// hour ago, one check at a time, the earlier result kept where a repository
// couldn't be asked, no sign-in of the person's and no SSH; its install window is
// in skills-auto-update) beside the person's own Check now; at most six repositories asked at once; a
// version already found not downloaded again; and Update in one press after the
// found version is no longer held, only with the version that was shown.
// The repositories are served by git's own http-backend on this machine;
// throwaway HOME, whose git settings name stand-ins for ssh and for a credential
// helper that write down each start. Nothing reaches a real host.
//
// Run: node scripts/run-smokes.mjs skills-quiet-check-smoke

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pairDevice, remoteRequest } from "./smoke-pairing.js";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { git, gitServesHttp, startStandInGitServer, writeSkill, type StandInRepo } from "./stand-in-git-server.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

if (!gitServesHttp()) {
	console.log("SKIPPED: this git has no http-backend to serve the stand-in repositories");
	process.exit(0);
}

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-quiet-check-"));
const home = path.join(tempRoot, "home");
const store = path.join(home, ".exxperts", "agent", "skills");
const resultsFile = path.join(home, ".exxperts", "app", "skill-updates.json");
const serveRoot = path.join(tempRoot, "serve");
const workRoot = path.join(tempRoot, "work");
for (const dir of [store, path.dirname(resultsFile), serveRoot, workRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const standIn = await startStandInGitServer(serveRoot, workRoot);
const { requests: gitRequests, signedOut, held, makeRepo, countFor } = standIn;

/** A program that writes down that it ran, then fails. */
function recorder(name: string): { command: string; ran: () => number } {
	const script = path.join(tempRoot, `${name}.cjs`);
	const log = path.join(tempRoot, `${name}.log`);
	fs.writeFileSync(script, `require("fs").appendFileSync(${JSON.stringify(log)}, "ran\\n");\nprocess.exit(1);\n`);
	return {
		command: `"${process.execPath.replace(/\\/g, "/")}" "${script.replace(/\\/g, "/")}"`,
		ran: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").length : 0),
	};
}
const ssh = recorder("ssh");
const helper = recorder("helper");
const gitConfig = path.join(home, ".gitconfig");
git(tempRoot, ["config", "--file", gitConfig, "core.sshCommand", ssh.command]);
git(tempRoot, ["config", "--file", gitConfig, "ssh.variant", "ssh"]);
git(tempRoot, ["config", "--file", gitConfig, "credential.helper", `!${helper.command}`]);
// An https address that the person's own git settings send over SSH.
git(tempRoot, ["config", "--file", gitConfig, "url.ssh://git@rewritten.example/.insteadOf", "https://rewritten.example/"]);

// --- The server -------------------------------------------------------------------

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
async function startServer(): Promise<void> {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(home, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_REMOTE_TEST_ADDRESS: "::1", GIT_SSH_COMMAND: undefined, GIT_SSH: undefined }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, { tries: 100 });
}
/** A new server process holds no checkout, as one that found its versions over 15 minutes ago. */
async function restart(): Promise<void> {
	await stopSmokeServer(server);
	await startServer();
}
async function api(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const CHECK = "/api/skills/updates/check";
/** What the page asks as it opens, and what Check now asks. */
const quietCheck = () => api("POST", CHECK, { quiet: true });
const checkNow = () => api("POST", CHECK, {});
const askedNames = (answer: { body: any }) => (answer.body.results as any[]).map((result) => result.name).sort();
const view = async (name: string): Promise<any> => ((await api("GET", "/api/skills")).body as any[]).find((skill) => skill.name === name);
const instructions = (name: string) => fs.readFileSync(path.join(store, name, "SKILL.md"), "utf-8");
const readResults = () => JSON.parse(fs.readFileSync(resultsFile, "utf-8"));
const record = (name: string) => JSON.parse(fs.readFileSync(path.join(store, name, "provenance.json"), "utf-8"));

/** Moves the times of every stored check back, as if `minutes` had passed. */
function pass(minutes: number): void {
	const stored = readResults();
	const back = (at: string) => new Date(Date.parse(at) - minutes * 60_000).toISOString();
	for (const entry of Object.values(stored.skills) as any[]) {
		if (entry.checkedAt) entry.checkedAt = back(entry.checkedAt);
		if (entry.missed) entry.missed.at = back(entry.missed.at);
	}
	fs.writeFileSync(resultsFile, JSON.stringify(stored));
}
/** Every skill of the library taken away, so a row asks only its own. */
async function emptyLibrary(): Promise<void> {
	for (const name of fs.readdirSync(store)) fs.rmSync(path.join(store, name), { recursive: true, force: true });
	gitRequests.length = 0;
}
/** A repository with one skill of each name, pushed, its skills added. */
async function added(repoName: string, names: string[]): Promise<StandInRepo> {
	const repo = makeRepo(repoName);
	for (const name of names) writeSkill(repo.work, `skills/${name}`, name, `The ${name} instructions, first.`);
	repo.commit("first");
	repo.push();
	const scan = await api("POST", "/api/skills/repo/scan", { source: repo.url });
	assert(scan.status === 200, `the scan of ${repoName} works, got ${scan.status} ${JSON.stringify(scan.body)}`);
	for (const name of names) assert((await api("POST", "/api/skills/repo/import", { token: scan.body.token, path: `skills/${name}` })).status === 201, `${name} added`);
	gitRequests.length = 0;
	return repo;
}
function newVersion(repo: StandInRepo, name: string, body: string): void {
	writeSkill(repo.work, `skills/${name}`, name, body);
	repo.commit(body);
	repo.push();
}
/** A skill whose record names `address`, with no check's result: the addresses an add can't reach here. */
function handMade(name: string, address: string): void {
	writeSkill(store, name, name, `The ${name} instructions.`);
	fs.writeFileSync(path.join(store, name, "provenance.json"), JSON.stringify({ source: address, importedAt: new Date().toISOString(), license: null, sha256: "0".repeat(64), repository: { address, refKind: "default", path: `skills/${name}`, commit: "1".repeat(40), filesSha256: "0".repeat(64) } }));
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
/** Answers the server gave after what was sent before: a request it has not started by then was not going to start. */
async function settled(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await api("GET", "/api/skills");
}
/** What the page sends for the update a skill shows. */
const updateOf = (name: string, update: any, confirm = {}) => api("POST", `/api/skills/${name}/update`, { candidate: update?.candidate?.id, installedFilesSha256: update?.installedFilesSha256, confirm });

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

try {
	await startServer();

	// --- When ---------------------------------------------------------------------

	await row("1 the page's check asks a skill never asked, then not again within the hour; after it, again", async () => {
		await emptyLibrary();
		const repo = await added("hour", ["alpha"]);
		newVersion(repo, "alpha", "The alpha instructions, second.");
		assert((await view("alpha"))?.repository?.checkDue === true, "a skill never asked is due");
		assert(JSON.stringify(askedNames(await quietCheck())) === JSON.stringify(["alpha"]) && countFor("hour").asks >= 1, `it is asked, got ${JSON.stringify(countFor("hour"))}`);
		const update = await view("alpha");
		assert(update?.update?.state === "available" && update.repository.checkDue === false, `its row has the update, and it is no longer due, got ${JSON.stringify(update)}`);
		for (const minutes of [0, 59]) {
			pass(minutes);
			gitRequests.length = 0;
			const again = await quietCheck();
			assert(again.status === 200 && askedNames(again).length === 0 && countFor("hour").asks === 0, `${minutes} minutes on, nothing is asked, got ${JSON.stringify(again.body)} ${JSON.stringify(countFor("hour"))}`);
		}
		pass(2);
		gitRequests.length = 0;
		assert(askedNames(await quietCheck()).length === 1 && countFor("hour").asks === 1, `over an hour on, it is asked again, got ${JSON.stringify(countFor("hour"))}`);
		// A clock that went back leaves a time still to come: it counts as none.
		pass(-600);
		assert((await view("alpha"))?.repository?.checkDue === true, "a check stored in the future is no reason to wait");
		gitRequests.length = 0;
		await checkNow();
		assert(countFor("hour").asks === 1, "Check now asks whatever the hour");
	});

	await row("2 a second quiet check joins; Check now starts at once and takes the place of a quiet one; a quiet one joins Check now", async () => {
		await emptyLibrary();
		const repo = await added("joins", ["beta"]);
		let release = hold("joins");
		const first = quietCheck();
		await waitUntil(() => countFor("joins").asks === 1, "the quiet check asks");
		const second = quietCheck();
		await settled();
		release();
		const [one, two] = await Promise.all([first, second]);
		assert(countFor("joins").asks === 1 && JSON.stringify(one.body) === JSON.stringify(two.body), `one ask, and the second quiet check has the first one's answer, got ${JSON.stringify(countFor("joins"))}`);

		// A quiet check whose repository holds its answer back: Check now is answered all the same.
		pass(61);
		gitRequests.length = 0;
		release = hold("joins");
		const waiting = quietCheck();
		await waitUntil(() => countFor("joins").asks === 1, "the quiet check asks");
		held.delete("joins");
		newVersion(repo, "beta", "The beta instructions, second.");
		assert(askedNames(await checkNow()).length === 1 && (await view("beta")).update.state === "available", "Check now has its answer while the quiet one still waits");
		const stored = fs.readFileSync(resultsFile, "utf-8");
		const asked = { ...countFor("joins") };
		release();
		const late = await waiting;
		assert(late.status === 200 && late.body.results.length === 0 && fs.readFileSync(resultsFile, "utf-8") === stored, `the quiet one's late answer changes nothing, got ${JSON.stringify(late.body)}`);
		assert(countFor("joins").fetches === asked.fetches, "and it downloads nothing");

		pass(61);
		gitRequests.length = 0;
		release = hold("joins");
		const pressed = checkNow();
		await waitUntil(() => countFor("joins").asks === 1, "Check now asks");
		const [pressedAgain, opened] = [checkNow(), quietCheck()];
		await settled();
		release();
		const answers = await Promise.all([pressed, pressedAgain, opened]);
		assert(countFor("joins").asks === 1 && new Set(answers.map((answer) => JSON.stringify(answer.body))).size === 1, `a second press and a page that opens join it, got ${JSON.stringify(countFor("joins"))}`);
	});

	await row("3 at most six repositories are asked at once", async () => {
		await emptyLibrary();
		const names = Array.from({ length: 8 }, (_, i) => `six-${i}`);
		const releases = new Map<string, () => void>();
		for (const name of names) {
			await added(name, [name]);
			releases.set(name, hold(name));
		}
		const asking = () => names.filter((name) => countFor(name).asks > 0);
		gitRequests.length = 0;
		const check = checkNow();
		for (let answered = 0; answered < names.length; answered += 1) {
			const wanted = Math.min(names.length, answered + 6);
			await waitUntil(() => asking().length >= wanted, `${wanted} repositories are asked`);
			await settled();
			assert(asking().length === wanted, `${answered} answered, so ${wanted} asked in all, got ${asking().length}`);
			releases.get(asking().find((name) => held.has(name))!)!();
		}
		assert((await check).body.results.length === names.length, "each has its result");
	});

	await row("4 the body: quiet is true or false and goes without names", async () => {
		for (const body of [{ quiet: "yes" }, { quiet: 1 }, { quiet: true, names: ["beta"] }, { quiet: false, names: [] }]) assert((await api("POST", CHECK, body)).status === 400, `${JSON.stringify(body)} is 400`);
		assert((await api("POST", CHECK, { quiet: false })).status === 200, "false alone is Check now");
	});

	// --- A repository that can't be asked ----------------------------------------------

	await row("5 a repository that doesn't answer keeps the earlier result; Check now says so as the result", async () => {
		await emptyLibrary();
		const repo = await added("silent", ["gamma"]);
		newVersion(repo, "gamma", "The gamma instructions, second.");
		await checkNow();
		pass(61);
		const closed = `127.0.0.1:${await freePort()}`;
		const repoint = (address: string) => {
			const was = record("gamma");
			fs.writeFileSync(path.join(store, "gamma", "provenance.json"), JSON.stringify({ ...was, repository: { ...was.repository, address } }));
			const stored = readResults();
			stored.skills.gamma.repository.address = address;
			fs.writeFileSync(resultsFile, JSON.stringify(stored));
		};
		repoint(`http://${closed}/team/silent.git`);
		const before = (await view("gamma")).update;
		assert(before.state === "available" && before.checkedAt, `gamma has its update, got ${JSON.stringify(before)}`);
		const answer = await quietCheck();
		assert(answer.status === 200, "the check answers");
		const after = await view("gamma");
		const { missed, ...kept } = after.update;
		assert(JSON.stringify(kept) === JSON.stringify(before), `the earlier result stays, its time too, got ${JSON.stringify(after.update)}`);
		assert(missed?.reason === "offline" && missed.host === closed, `with why it was missed, and its host, got ${JSON.stringify(missed)}`);
		assert(after.repository.checkDue === false, "it isn't asked again within the hour");
		await checkNow();
		const { update: pressed, repository: pressedRepository } = await view("gamma");
		assert(pressed.checkedAt === before.checkedAt && pressedRepository.checkDue === false, `a press nothing answered keeps the time of the last answer, and counts as an ask, got ${JSON.stringify(pressed)}`);
		assert(pressed.state === "unreachable" && pressed.failure?.reason === "offline" && pressed.failure.host === closed && !pressed.missed, `Check now's own failure is its result, got ${JSON.stringify(pressed)}`);
		repoint(repo.url);
		await checkNow();
		const answered = (await view("gamma")).update;
		assert(answered.checkedAt > before.checkedAt, `with its own time, got ${answered.checkedAt}`);
		assert(answered.state === "available" && !answered.failure && !answered.missed, `an answer takes its place, got ${JSON.stringify(answered)}`);
	});

	await row("6 a skill no check ever reached: the quiet check stores when it tried and no result, so there is no \"Last checked\"", async () => {
		await emptyLibrary();
		const closed = `127.0.0.1:${await freePort()}`;
		handMade("never", `http://${closed}/team/never.git`);
		await quietCheck();
		const never = await view("never");
		assert(never.update?.state === "unreachable" && !never.update.checkedAt && never.update.missed?.host === closed && never.repository.checkDue === false, `got ${JSON.stringify(never)}`);
		assert(JSON.stringify(Object.keys(readResults().skills.never).sort()) === JSON.stringify(["identity", "installedFilesSha256", "missed", "repository", "state"]), `what is stored, got ${JSON.stringify(readResults().skills.never)}`);
	});

	// --- It raises nothing ----------------------------------------------------------

	await row("7 the quiet check asks no credential helper and says nothing of a repository that wants a sign-in; Check now asks it", async () => {
		await emptyLibrary();
		const repo = await added("locked", ["delta"]);
		newVersion(repo, "delta", "The delta instructions, second.");
		await checkNow();
		pass(61);
		const before = (await view("delta")).update;
		signedOut.add("locked");
		try {
			const asked = helper.ran();
			gitRequests.length = 0;
			await quietCheck();
			assert(countFor("locked").asks > 0, "the repository is asked");
			assert(helper.ran() === asked, "and no credential helper runs");
			const after = await view("delta");
			assert(JSON.stringify(after.update) === JSON.stringify(before), `the earlier result stays and nothing is said of it, got ${JSON.stringify(after.update)}`);
			assert(after.repository.checkDue === false, "it isn't asked again within the hour");
			await checkNow();
			assert(helper.ran() > asked, "Check now asks the helper");
			assert((await view("delta")).update.failure?.reason === "sign-in", "and says the sign-in is missing");
		} finally {
			signedOut.delete("locked");
		}
	});

	await row("8 the quiet check starts no ssh: not for an SSH address, nor for one the person's git settings send there; Check now does", async () => {
		const addresses = { "by-ssh": "ssh://git@ssh.example:2222/team/tools.git", "by-scp": "git@scp.example:team/tools.git", "by-rewrite": "https://rewritten.example/team/tools.git" };
		for (const [name, address] of Object.entries(addresses)) {
			await emptyLibrary();
			handMade(name, address);
			const started = ssh.ran();
			await quietCheck();
			assert(ssh.ran() === started, `${name}: no ssh`);
			const after = await view(name);
			assert(after.update?.state === "unreachable" && !after.update.missed && !after.update.failure && !after.update.checkedAt, `${name}: nothing is said of it, got ${JSON.stringify(after.update)}`);
			await checkNow();
			assert(ssh.ran() > started, `${name}: Check now starts ssh`);
		}
	});

	// --- No waste -------------------------------------------------------------------

	await row("9 a version already found is not downloaded again; a newer one is, and so is one of a skill changed here", async () => {
		await emptyLibrary();
		const repo = await added("waste", ["zeta", "eta"]);
		newVersion(repo, "zeta", "The zeta instructions, second.");
		await checkNow();
		// eta's files are the repository's, so its record took the new commit; zeta's update is found.
		assert((await view("zeta")).update.state === "available" && (await view("eta")).update.state === "current" && countFor("waste").fetches === 1, `found with one download, got ${JSON.stringify(countFor("waste"))}`);
		const found = JSON.stringify((await view("zeta")).update.candidate);
		gitRequests.length = 0;
		await checkNow();
		pass(61);
		await quietCheck();
		await restart();
		await checkNow();
		assert(countFor("waste").asks === 3 && countFor("waste").fetches === 0, `three more checks, a restart among them, download nothing, got ${JSON.stringify(countFor("waste"))}`);
		assert(JSON.stringify((await view("zeta")).update.candidate) === found, "and the update shown is the same");
		newVersion(repo, "zeta", "The zeta instructions, third.");
		await checkNow();
		assert(countFor("waste").fetches === 1 && JSON.stringify((await view("zeta")).update.candidate) !== found, "a newer version is downloaded and shown");
		fs.appendFileSync(path.join(store, "zeta", "SKILL.md"), "Changed here.\n");
		await checkNow();
		assert(countFor("waste").fetches === 2 && (await view("zeta")).update.candidate.changedHere === true, "a skill changed here since is compared again");
	});

	await row("9b a skill that left its repository, or was renamed there, is not downloaded again until the repository changes", async () => {
		await emptyLibrary();
		const repo = await added("moved", ["nu", "xi"]);
		fs.rmSync(path.join(repo.work, "skills", "nu"), { recursive: true, force: true });
		writeSkill(repo.work, "skills/xi", "omicron", "The xi instructions, under another name.");
		repo.commit("gone and renamed");
		repo.push();
		await checkNow();
		const states = async () => JSON.stringify([(await view("nu")).update.state, (await view("xi")).update.state, (await view("xi")).update.renamedTo]);
		const first = await states();
		assert(first === JSON.stringify(["gone", "renamed", "omicron"]) && countFor("moved").fetches === 1, `found with one download, got ${first} ${JSON.stringify(countFor("moved"))}`);
		gitRequests.length = 0;
		await checkNow();
		pass(61);
		await quietCheck();
		assert(countFor("moved").asks === 2 && countFor("moved").fetches === 0 && (await states()) === first, `two more checks download nothing and say the same, got ${await states()} ${JSON.stringify(countFor("moved"))}`);
		writeSkill(repo.work, "skills/nu", "nu", "The nu instructions, back again.");
		repo.commit("back");
		repo.push();
		await checkNow();
		assert(countFor("moved").fetches === 1 && (await view("nu")).update.state === "available" && (await view("xi")).update.state === "renamed", "a changed repository is looked at again");
	});

	// --- Update ---------------------------------------------------------------------

	await row("10 Update goes through in one press once the version is no longer held", async () => {
		await emptyLibrary();
		const repo = await added("press", ["theta", "iota"]);
		for (const name of ["theta", "iota"]) newVersion(repo, name, `The ${name} instructions, second.`);
		await checkNow();
		const update = (await view("theta")).update;
		await restart();
		gitRequests.length = 0;
		const pressed = await updateOf("theta", update);
		assert(pressed.status === 200 && instructions("theta").includes("second"), `theta has the new version, got ${pressed.status} ${JSON.stringify(pressed.body)}`);
		assert(countFor("press").fetches === 1, `its repository is downloaded once, got ${JSON.stringify(countFor("press"))}`);
		// iota's version came with the same download, so it is held again.
		gitRequests.length = 0;
		assert((await updateOf("iota", (await view("iota")).update)).status === 200 && gitRequests.length === 0, "its neighbour's update then asks nothing");
	});

	await row("11 Update after the hold, when the repository holds another version by then: nothing is installed, the new one is shown, and its own press installs it", async () => {
		await emptyLibrary();
		const repo = await added("between", ["kappa"]);
		newVersion(repo, "kappa", "The kappa instructions, second.");
		await checkNow();
		const shown = (await view("kappa")).update;
		await restart();
		newVersion(repo, "kappa", "The kappa instructions, third.");
		const refused = await updateOf("kappa", shown);
		assert(refused.status === 409 && refused.body?.code === "skill-changed-since-check", `refused, got ${refused.status} ${JSON.stringify(refused.body)}`);
		assert(instructions("kappa").includes("first"), "kappa is as it was");
		const next = (await view("kappa")).update;
		assert(next.state === "available" && next.candidate.id !== shown.candidate.id, `the version there now is shown, got ${JSON.stringify(next)}`);
		assert((await updateOf("kappa", next)).status === 200 && instructions("kappa").includes("third"), "and a press of its own installs it");
	});

	await row("12 the same files with another commit are the version that was shown", async () => {
		await emptyLibrary();
		const repo = await added("recommit", ["lambda"]);
		newVersion(repo, "lambda", "The lambda instructions, second.");
		await checkNow();
		const shown = (await view("lambda")).update;
		await restart();
		fs.writeFileSync(path.join(repo.work, "README.md"), "elsewhere\n");
		const last = repo.commit("elsewhere");
		repo.push();
		const pressed = await updateOf("lambda", shown);
		assert(pressed.status === 200 && instructions("lambda").includes("second") && record("lambda").repository.commit === last, `installed, its record naming the commit it came from, got ${pressed.status} ${JSON.stringify(pressed.body)}`);
	});

	await row("13 the stops stay: hidden characters and a skill changed here wait for the yes, before anything is fetched and after", async () => {
		await emptyLibrary();
		const repo = await added("stops", ["mu", "nu"]);
		newVersion(repo, "mu", "The mu instructions,​ second.");
		newVersion(repo, "nu", "The nu instructions, second.");
		fs.appendFileSync(path.join(store, "nu", "SKILL.md"), "Changed here.\n");
		await checkNow();
		const [mu, nu] = [(await view("mu")).update, (await view("nu")).update];
		await restart();
		gitRequests.length = 0;
		const [stopMu, stopNu] = [await updateOf("mu", mu), await updateOf("nu", nu)];
		assert(stopMu.body?.code === "skill-update-hidden-characters" && stopNu.body?.code === "skill-changed-here" && gitRequests.length === 0, `both stop, and nothing is fetched, got ${JSON.stringify([stopMu.body, stopNu.body])}`);
		assert((await updateOf("mu", mu, { hiddenCharacters: true })).status === 200 && instructions("mu").includes("second"), "with the yes, the fetched version goes in");
		// A version that gains hidden characters between the check and the press is another one: the yes given before doesn't cover it.
		newVersion(repo, "nu", "The nu instructions,​ third.");
		await restart();
		const gained = await updateOf("nu", nu, { hiddenCharacters: true, replaceMyChanges: true });
		assert(gained.status === 409 && gained.body?.code === "skill-changed-since-check" && instructions("nu").includes("Changed here."), `refused, got ${gained.status} ${JSON.stringify(gained.body)}`);
	});

	await row("14 a skill edited while Update fetches is not overwritten", async () => {
		await emptyLibrary();
		const repo = await added("edited", ["xi"]);
		newVersion(repo, "xi", "The xi instructions, second.");
		await checkNow();
		const shown = (await view("xi")).update;
		await restart();
		const release = hold("edited");
		gitRequests.length = 0;
		const pressing = updateOf("xi", shown);
		await waitUntil(() => countFor("edited").asks > 0, "Update asks the repository");
		fs.appendFileSync(path.join(store, "xi", "SKILL.md"), "Edited meanwhile.\n");
		release();
		const pressed = await pressing;
		assert(pressed.status === 409 && pressed.body?.code === "skill-changed-since-check" && instructions("xi").includes("Edited meanwhile."), `refused, got ${pressed.status} ${JSON.stringify(pressed.body)}`);
	});

	await row("15 an Update that can't fetch again says why, with its host, and keeps the skill and its update", async () => {
		await emptyLibrary();
		const repo = await added("unfetched", ["omicron"]);
		newVersion(repo, "omicron", "The omicron instructions, second.");
		await checkNow();
		const shown = (await view("omicron")).update;
		await restart();
		signedOut.add("unfetched");
		try {
			const pressed = await updateOf("omicron", shown);
			assert(pressed.status === 502 && pressed.body?.code === "skill-update-not-fetched" && pressed.body.details?.reason === "sign-in" && pressed.body.details.host === `127.0.0.1:${standIn.port()}`, `502 with why, got ${pressed.status} ${JSON.stringify(pressed.body)}`);
		} finally {
			signedOut.delete("unfetched");
		}
		const after = (await view("omicron")).update;
		assert(instructions("omicron").includes("first") && after.state === "available" && after.candidate.id === shown.candidate.id, `the skill and its update stay, got ${JSON.stringify(after)}`);
		assert((await updateOf("omicron", shown)).status === 200 && instructions("omicron").includes("second"), "and the next press goes through");
	});

	// --- From a phone ----------------------------------------------------------------

	await row("16 the quiet check is this computer's only: a phone is refused", async () => {
		assert((await api("POST", "/api/remote/enable", {})).status === 200, "remote access on");
		const device = await pairDevice(port, "Quiet phone");
		gitRequests.length = 0;
		const answer = await remoteRequest(port, CHECK, { method: "POST", headers: { Cookie: device.cookie, "content-type": "application/json" }, body: JSON.stringify({ quiet: true }) });
		assert(answer.status === 403 && JSON.parse(answer.body)?.code === "remote_local_only" && gitRequests.length === 0, `403 and nothing asked, got ${answer.status} ${answer.body}`);
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
		console.log("skills-quiet-check smoke: ok");
	}
}
