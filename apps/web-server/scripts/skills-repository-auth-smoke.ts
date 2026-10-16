import assert from "node:assert/strict";
import { RepositorySignIn } from "../src/skills-repository-auth.js";
import { repositoryFetchFailure, resolveRepoSource, signInArgsFromConfigListing } from "../src/skills-repo-fetch.js";
import { classifyRemoteRoute } from "../src/remote-route-policy.js";

const manager = "global\0credential.helper\nmanager\0global\0credential.credentialstore\nsecretservice\0";
const custom = manager + "global\0credential.https://gitlab.example.invalid.provider\ngitlab\0global\0credential.https://gitlab.example.invalid.gitlabdevclientid\nsynthetic-client\0global\0credential.https://gitlab.example.invalid.gitlabdevclientsecret\nsynthetic-not-a-real-secret\0";
const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal }> = [];
const previousStore = process.env.GCM_CREDENTIAL_STORE;
delete process.env.GCM_CREDENTIAL_STORE;
try {
	for (const endpoint of ["status", "login"]) assert.equal(classifyRemoteRoute("POST", `/api/skills/repo/auth/${endpoint}`), "local");
	let configReads = 0;
	const service = new RepositorySignIn(async (command) => { calls.push(command); return true; }, async () => { configReads++; return manager; });
	for (const consent of [undefined, false]) {
		await assert.rejects(service.login("https://github.com/fixture/private", "github", undefined, consent), (error: unknown) => error instanceof Error && (error as Error & { code?: string; statusCode?: number }).code === "REPOSITORY_ACCESS_REQUIRED" && (error as Error & { statusCode?: number }).statusCode === 403);
	}
	assert.equal(configReads, 0, "missing storage consent cannot inspect local authentication configuration");
	assert.equal(calls.length, 0, "missing storage consent cannot reach Git Credential Manager");
	const status = await service.status("https://github.com/fixture/private#main");
	assert(status.ready && status.provider === "github");
	assert(calls.every((command) => command.args.join() === "--version"), "setup inspection cannot start authentication");
	await service.login("https://github.com/fixture/private", "github", undefined, true);
	assert.deepEqual(calls.at(-1)!.args, ["github", "login", "--url", "https://github.com", "--browser", "--force"]);
	assert.equal(calls.at(-1)!.env?.GCM_INTERACTIVE, "true");
	const count = calls.length;
	for (const source of ["http://github.com/fixture/private", "https://token@github.com/fixture/private", "file:///private/repo", "https://github.com/fixture/repo?token=bad"]) await assert.rejects(service.status(source));
	await assert.rejects(service.status("https://github.com/fixture/private", "gitlab"), /does not match/);
	assert.equal(calls.length, count, "invalid login targets never reach GCM");
	const setup = await service.status("https://gitlab.example.invalid/group/repo", "gitlab");
	assert(!setup.ready && setup.setupCommands.some((command) => command.includes("gitLabDevClientId")));
	const before = calls.length;
	await assert.rejects(service.login("https://gitlab.example.invalid/group/repo", "gitlab", undefined, true), /OAuth application/);
	assert(calls.slice(before).every((command) => command.args[0] === "--version"));
	const corporate = new RepositorySignIn(async (command) => { calls.push(command); return true; }, async () => custom);
	const corporateStatus = await corporate.status("https://gitlab.example.invalid/group/repo");
	assert(corporateStatus.ready);
	const wrongProvider = new RepositorySignIn(async () => true, async () => custom.replace("provider\ngitlab", "provider\ngeneric"));
	assert(!(await wrongProvider.status("https://gitlab.example.invalid/group/repo")).ready, "the retry must use the same provider as the explicit browser sign-in");
	assert(!JSON.stringify(corporateStatus).includes("synthetic-not-a-real-secret"), "configuration secrets never enter the API response");
	await corporate.login("https://gitlab.example.invalid/group/repo", "gitlab", undefined, true);
	assert.deepEqual(calls.at(-1)!.args, ["get"]);
	assert.equal(calls.at(-1)!.input, "protocol=https\nhost=gitlab.example.invalid\npath=group/repo\nusername=oauth2\n\n");
	assert.equal(calls.at(-1)!.env?.GCM_GITLAB_AUTHMODES, "browser");
	assert(!(await corporate.status("https://gitlab.other.invalid/group/repo", "gitlab")).ready, "OAuth settings stay scoped to their configured host");
	process.env.GCM_CREDENTIAL_STORE = "plaintext";
	assert(!(await corporate.status("https://gitlab.example.invalid/group/repo")).ready, "an insecure environment override cannot bypass the protected-store requirement");
	delete process.env.GCM_CREDENTIAL_STORE;
	const absent = new RepositorySignIn(async () => false, async () => "");
	assert(!(await absent.status("https://github.com/fixture/private")).ready);
	let release: (() => void) | undefined;
	const cancellable = new RepositorySignIn(async (command) => {
		if (command.args[0] === "--version") return true;
		return new Promise((resolve, reject) => { release = () => resolve(true); command.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); });
	}, async () => manager);
	const pending = cancellable.login("https://github.com/fixture/private", "github", undefined, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert(release);
	await assert.rejects(cancellable.login("https://github.com/fixture/other", "github", undefined, true), /already in progress/);
	cancellable.cancel(); await assert.rejects(pending, /cancelled/);
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(cancellable.login("https://github.com/fixture/private", "github", aborted.signal, true), /cancelled/);
	const failed = new RepositorySignIn(async (command) => command.args[0] === "--version", async () => manager);
	await assert.rejects(failed.login("https://github.com/fixture/private", "github", undefined, true), /did not complete/);
	const resolved = resolveRepoSource("https://github.com/fixture/private"); assert(resolved.ok);
	for (const message of ["Authentication failed", "fatal: could not read Username: terminal prompts disabled", "repository not found", "returned error: 403"]) {
		const error = repositoryFetchFailure(message, resolved.value) as Error & { code?: string; statusCode?: number };
		assert.equal(error.code, "REPOSITORY_AUTH_REQUIRED"); assert.equal(error.statusCode, 403);
	}
	assert.equal((repositoryFetchFailure("SSL certificate problem", resolved.value) as Error & { code?: string }).code, undefined);
	assert.equal((repositoryFetchFailure("returned error: 403; rate limit exceeded", resolved.value) as Error & { code?: string }).code, "REPOSITORY_RATE_LIMIT");
	assert(!repositoryFetchFailure("remote: synthetic-session-token-not-for-logs", resolved.value, true).message.includes("synthetic-session-token"), "session-token failures never return provider stderr");
	const background = signInArgsFromConfigListing(manager, resolved.value.cloneArg).join(" ");
	assert(background.includes('test "$1" = get || return 0'), "background imports still use read-only helper operations");
	console.log("skills-repository-auth-smoke: OK (synthetic commands only; no real credentials or browser login)");
} finally { if (previousStore === undefined) delete process.env.GCM_CREDENTIAL_STORE; else process.env.GCM_CREDENTIAL_STORE = previousStore; }
