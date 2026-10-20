import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import {
	anonymousRepositoryAccess, assertRepositoryAccess, clearRepositoryAccess, grantRepositoryAccess,
	normalizeRepositoryAccess, onRepositoryAccessRevoked, repositoryAccessSource, repositoryGitAvailable,
	repositoryTokenGit, resolveRepositoryAccess, revokeRepositoryAccess,
	type RepositoryAccessContext,
} from "../src/skills-repository-access.js";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-repository-access-"));
const previousProfile = process.env.EXXPERTS_STATE_HOME;
const previousConfigParameters = process.env.GIT_CONFIG_PARAMETERS;
const previousConfigCount = process.env.GIT_CONFIG_COUNT;
const originalSpawn = childProcess.spawn;
const originalFetch = globalThis.fetch;
const source = "https://github.com/synthetic/private";
const otherSource = "https://github.com/synthetic/other";
const token = "synthetic-session-token-not-a-real-credential";
const local = { mode: "local-git", consentVersion: 1 } as const;
const session = { mode: "session-token", consentVersion: 1 } as const;
const revoked: RepositoryAccessContext[] = [];
onRepositoryAccessRevoked((context) => revoked.push(context));
const accessRequired = (error: unknown): boolean => error instanceof Error && (error as Error & { code?: string; statusCode?: number }).code === "REPOSITORY_ACCESS_REQUIRED" && (error as Error & { statusCode?: number }).statusCode === 403;

try {
	process.env.EXXPERTS_STATE_HOME = path.join(temporaryRoot, "profile-a");
	clearRepositoryAccess();
	assert.deepEqual(anonymousRepositoryAccess(), { mode: "anonymous", rememberLocalAccess: false, checkOnStartup: false, consentVersion: 1 });
	assert.equal(normalizeRepositoryAccess(undefined), undefined);
	for (const input of [null, {}, "local-git", { mode: "unsupported", consentVersion: 1 }, { ...local, consentVersion: 2 }, { ...local, checkOnStartup: "true" }, { ...local, rememberLocalAccess: 1 }, { ...local, provider: "other" }]) {
		assert.throws(() => normalizeRepositoryAccess(input), "invalid access choices are rejected");
	}
	for (const apiBaseUrl of ["http://gitlab.example.invalid/api/v4", "https://user:secret@gitlab.example.invalid/api/v4", "https://gitlab.example.invalid/api/v4?token=secret", "https://gitlab.example.invalid/api/v4#fragment", "https://gitlab.example.invalid/other"]) {
		assert.throws(() => normalizeRepositoryAccess({ ...local, apiBaseUrl }));
	}
	assert.equal(normalizeRepositoryAccess({ ...local, provider: "gitlab", apiBaseUrl: "https://gitlab.example.invalid/company/api/v4/" })!.apiBaseUrl, "https://gitlab.example.invalid/company/api/v4");
	assert.equal(normalizeRepositoryAccess({ ...session, rememberLocalAccess: true })!.rememberLocalAccess, false);
	assert(!JSON.stringify(normalizeRepositoryAccess({ ...session, token })).includes(token), "access settings cannot retain token input");
	assert.equal(repositoryAccessSource(`${source}.git/#main`), repositoryAccessSource(source));

	const anonymous = resolveRepositoryAccess(source, "library-a");
	assert.equal(anonymous.settings.mode, "anonymous");
	assert.equal(anonymous.token, undefined);
	assert.throws(() => resolveRepositoryAccess(source, "library-a", normalizeRepositoryAccess(local)), accessRequired);
	assert.throws(() => repositoryTokenGit(anonymous), accessRequired);
	const granted = grantRepositoryAccess(source, "library-a", local);
	assert(granted.id !== anonymous.id && anonymous.controller.signal.aborted, "granting a different access mode invalidates the previous context");
	assert.equal(resolveRepositoryAccess(`${source}.git#next`, "library-a", granted.settings, granted.id), granted);
	assert.equal(resolveRepositoryAccess(source, "library-a", granted.settings), granted);
	for (const [candidate, libraryId] of [[otherSource, "library-a"], [source, "library-b"], [source, undefined]] as const) {
		assert.throws(() => resolveRepositoryAccess(candidate, libraryId, granted.settings, granted.id), accessRequired, "access IDs cannot cross source/import/library boundaries");
	}
	revokeRepositoryAccess(otherSource, "library-a");
	assertRepositoryAccess(granted);
	revokeRepositoryAccess(source, "library-b");
	assertRepositoryAccess(granted);
	revokeRepositoryAccess(source, "library-a");
	assert(granted.controller.signal.aborted && revoked.includes(granted));
	assert.throws(() => assertRepositoryAccess(granted), accessRequired);
	assert.throws(() => resolveRepositoryAccess(source, "library-a", granted.settings, granted.id), accessRequired);
	assert.throws(() => resolveRepositoryAccess(source, "library-a", granted.settings), accessRequired, "session local permission cannot recreate itself");

	const remembered = grantRepositoryAccess(source, "library-a", { ...local, rememberLocalAccess: true, checkOnStartup: true });
	const persisted = JSON.parse(JSON.stringify(remembered.settings));
	clearRepositoryAccess();
	assert(remembered.controller.signal.aborted);
	const restored = resolveRepositoryAccess(source, "library-a", persisted);
	assert.equal(restored.settings.mode, "local-git");
	assert.equal(restored.settings.checkOnStartup, true);
	assert.notEqual(restored.id, remembered.id, "only remembered settings can create a fresh local context after server memory is cleared");

	for (const badToken of [undefined, null, "", "   ", "bad\ntoken", "bad\rtoken", "bad\0token", "x".repeat(8193)]) {
		assert.throws(() => grantRepositoryAccess(source, "library-a", session, badToken));
		assertRepositoryAccess(restored);
	}
	assert.throws(() => grantRepositoryAccess("git@github.com:synthetic/private", "library-a", session, token), /HTTPS/);
	const tokenContext = grantRepositoryAccess(source, "library-a", session, ` ${token} `);
	for (let attempt = 0; attempt < 3; attempt++) {
		const reused = resolveRepositoryAccess(source, "library-a", tokenContext.settings);
		assert.equal(reused, tokenContext, "a valid session token is reused for several checks");
		const helper = repositoryTokenGit(reused);
		assert.equal(helper.env.EXXPERTS_REPOSITORY_TOKEN, token);
		assert(!JSON.stringify(helper.args).includes(token), "the token never enters Git arguments");
		assert(helper.args.includes("credential.helper="), "other helpers are disabled");
		assert(helper.args.some((value) => value.includes('test "$1" = get || return 0')), "the helper refuses store and erase operations");
		assert(!JSON.stringify(reused.settings).includes(token));
	}
	const boundHelper = repositoryTokenGit(tokenContext);
	assert(boundHelper.args.includes("credential.useHttpPath=true"));
	assert(boundHelper.args.includes("http.followRedirects=false"), "authenticated redirects cannot move the token to another host");
	const helperEnv: NodeJS.ProcessEnv = { ...process.env, ...boundHelper.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "/dev/null" : os.devNull, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never", GCM_TRACE: "0", GCM_TRACE_SECRETS: "0", GIT_CURL_VERBOSE: "0" };
	for (const key of Object.keys(helperEnv)) if (key.startsWith("GIT_TRACE")) delete helperEnv[key];
	delete helperEnv.GIT_CONFIG_PARAMETERS; delete helperEnv.GIT_CONFIG_COUNT;
	const credential = (operation: string, protocol = "https", host = "github.com", repoPath = "synthetic/private") => childProcess.spawnSync("git", [...boundHelper.args, "credential", operation], {
		cwd: temporaryRoot, env: helperEnv, input: `protocol=${protocol}\nhost=${host}\npath=${repoPath}\n${operation === "fill" ? "" : "username=synthetic-user\npassword=synthetic-ignored\n"}\n`, encoding: "utf8", timeout: 5000, windowsHide: true,
	});
	for (const repoPath of ["synthetic/private", "synthetic/private.git"]) {
		const response = credential("fill", "https", "github.com", repoPath);
		assert.equal(response.status, 0, response.stderr);
		assert(response.stdout.includes(`password=${token}`), "the bound repository receives its synthetic token");
	}
	for (const [protocol, host, repoPath] of [["http", "github.com", "synthetic/private"], ["https", "other.example.invalid", "synthetic/private"], ["https", "github.com:444", "synthetic/private"], ["https", "github.com", "synthetic/other"], ["https", "github.com", "synthetic/private/nested"]]) {
		const response = credential("fill", protocol, host, repoPath);
		assert.notEqual(response.status, 0, "unbound credential requests remain unanswered with terminal prompting disabled");
		assert(!response.stdout.includes(token) && !response.stderr.includes(token));
	}
	for (const operation of ["approve", "reject"]) {
		const response = credential(operation);
		assert.equal(response.status, 0, response.stderr);
		assert.equal(response.stdout, "", "store and erase never emit a credential");
	}
	const gitlab = grantRepositoryAccess("https://gitlab.example.invalid/group/private", "library-b", { ...session, provider: "gitlab" }, token);
	assert(repositoryTokenGit(gitlab).args.some((value) => value.includes("username=oauth2")));
	const direct = grantRepositoryAccess(source, undefined, session, token);
	assert.equal(resolveRepositoryAccess(source, undefined, direct.settings, direct.id), direct);
	assert.throws(() => resolveRepositoryAccess(source, undefined, direct.settings), accessRequired, "direct private imports require their explicit access ID");
	revokeRepositoryAccess(source, "library-a");
	assert.equal(tokenContext.token, undefined);
	assert(tokenContext.controller.signal.aborted);
	assert.throws(() => repositoryTokenGit(tokenContext), accessRequired);
	assertRepositoryAccess(direct);
	assert.throws(() => resolveRepositoryAccess(source, "library-a", tokenContext.settings), accessRequired);
	process.env.EXXPERTS_STATE_HOME = path.join(temporaryRoot, "profile-b");
	assert.throws(() => resolveRepositoryAccess(source, undefined, direct.settings, direct.id), accessRequired, "a profile change clears previous grants");
	assert.equal(direct.token, undefined);
	assert.equal(gitlab.token, undefined);
	process.env.EXXPERTS_STATE_HOME = path.join(temporaryRoot, "profile-a");
	assert.throws(() => resolveRepositoryAccess(source, undefined, direct.settings, direct.id), accessRequired, "switching back cannot resurrect a session token");
	const shutdown = grantRepositoryAccess(source, "library-a", session, token);
	clearRepositoryAccess();
	assert.equal(shutdown.token, undefined);
	assert(shutdown.controller.signal.aborted);
	assert.throws(() => resolveRepositoryAccess(source, "library-a", shutdown.settings), accessRequired);
	assert.deepEqual(fs.readdirSync(temporaryRoot), [], "access grants and tokens write no profile data");

	let exitCode: number | null = 0;
	let missing = false;
	let probes = 0;
	process.env.GIT_CONFIG_PARAMETERS = "'credential.helper=synthetic-helper'";
	process.env.GIT_CONFIG_COUNT = "1";
	childProcess.spawn = ((file: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: string; cwd: string }) => {
		probes++;
		assert.equal(file, "git");
		assert.deepEqual(args, ["--version"], "availability only probes a version; no configuration or credential command runs");
		assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
		assert([os.devNull, "/dev/null"].includes(options.env.GIT_CONFIG_GLOBAL!), "global configuration is redirected to a null device");
		assert.equal(options.env.GIT_CONFIG_PARAMETERS, undefined);
		assert.equal(options.env.GIT_CONFIG_COUNT, undefined);
		assert.equal(options.stdio, "ignore");
		const child = Object.assign(new EventEmitter(), { kill: () => true });
		queueMicrotask(() => missing ? child.emit("error", new Error("spawn git ENOENT")) : child.emit("close", exitCode));
		return child;
	}) as typeof childProcess.spawn;
	syncBuiltinESMExports();
	assert.equal(await repositoryGitAvailable(), true);
	exitCode = 1;
	assert.equal(await repositoryGitAvailable(), false);
	missing = true;
	assert.equal(await repositoryGitAvailable(), false);
	assert.equal(probes, 3);

	const { checkAllSkillLibraries, deleteSkillLibrary, readSkillLibraries, resetSkillLibraryAccess, saveSkillLibrary } = await import("../src/skills-libraries.js");
	const stateRoot = path.join(temporaryRoot, "profile-a", ".exxperts");
	const libraryFile = path.join(stateRoot, "app", "skill-libraries.json");
	const savedSkill = path.join(stateRoot, "agent", "skills", "kept", "SKILL.md");
	const savedRoom = path.join(stateRoot, "app", "personalized-agents", "kept", "skill-settings.json");
	for (const file of [libraryFile, savedSkill, savedRoom]) fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(savedSkill, "synthetic reviewed instructions\n");
	fs.writeFileSync(savedRoom, '{"enabledSkills":["kept"]}\n');
	const oldLibraryBytes = JSON.stringify([{ id: "legacy-library", name: "Legacy", source, status: "current" }]);
	fs.writeFileSync(libraryFile, oldLibraryBytes);
	assert.equal(readSkillLibraries()[0].repositoryAccess, undefined, "legacy libraries retain the explicit-confirmation state");
	let requests = 0;
	globalThis.fetch = (async () => { requests++; throw new Error("Unexpected network access in repository-access fixture"); }) as typeof fetch;
	assert.deepEqual(await checkAllSkillLibraries(), []);
	assert.equal(requests, 0);
	assert.equal(probes, 3, "legacy startup never probes Git or credentials");
	assert.equal(fs.readFileSync(libraryFile, "utf8"), oldLibraryBytes, "legacy startup does not rewrite saved data");
	const publicLibrary = saveSkillLibrary({ source: otherSource, repositoryAccess: anonymousRepositoryAccess() });
	assert.equal(publicLibrary.repositoryAccess?.checkOnStartup, false);
	assert.deepEqual(await checkAllSkillLibraries(), [], "new libraries do not check at startup by default");
	const privateLibrary = saveSkillLibrary({ source: "https://github.com/synthetic/session", repositoryAccess: normalizeRepositoryAccess({ ...session, checkOnStartup: true, token }) });
	const startup = await checkAllSkillLibraries();
	assert.equal(startup.length, 1);
	assert.equal(startup[0].id, privateLibrary.id);
	assert.equal(startup[0].status, "error");
	assert.equal(startup[0].errorCode, "REPOSITORY_ACCESS_REQUIRED", "missing private access is not reported as current");
	assert.equal(requests, 0);
	assert.equal(probes, 3, "missing session access skips transport altogether");
	assert(!fs.readFileSync(libraryFile, "utf8").includes(token), "persisted library choices contain no session token");
	const privateGrant = grantRepositoryAccess(privateLibrary.source, privateLibrary.id, privateLibrary.repositoryAccess, token);
	const reset = resetSkillLibraryAccess(privateLibrary.id);
	assert.equal(reset.repositoryAccess, undefined);
	assert.equal(privateGrant.token, undefined);
	assert(privateGrant.controller.signal.aborted);
	const localLibrary = saveSkillLibrary({ source: "https://github.com/synthetic/local", repositoryAccess: normalizeRepositoryAccess({ ...local, rememberLocalAccess: true }) });
	const localGrant = grantRepositoryAccess(localLibrary.source, localLibrary.id, localLibrary.repositoryAccess);
	const moved = saveSkillLibrary({ ...localLibrary, source: "https://github.com/synthetic/moved" });
	assert.equal(moved.repositoryAccess, undefined, "a changed repository address discards remembered access");
	assert(localGrant.controller.signal.aborted);
	const deleteGrant = grantRepositoryAccess(publicLibrary.source, publicLibrary.id, session, token);
	assert(deleteSkillLibrary(publicLibrary.id));
	assert.equal(deleteGrant.token, undefined);
	assert(deleteGrant.controller.signal.aborted);
	assert.equal(fs.readFileSync(savedSkill, "utf8"), "synthetic reviewed instructions\n");
	assert.equal(fs.readFileSync(savedRoom, "utf8"), '{"enabledSkills":["kept"]}\n', "access changes preserve reviewed local skill and room data");
	console.log("skills-repository-access-smoke: OK (synthetic profiles, grants, isolated Git helper and mocked probes; no real credentials or browser)");
} finally {
	clearRepositoryAccess();
	childProcess.spawn = originalSpawn;
	syncBuiltinESMExports();
	globalThis.fetch = originalFetch;
	if (previousProfile === undefined) delete process.env.EXXPERTS_STATE_HOME; else process.env.EXXPERTS_STATE_HOME = previousProfile;
	if (previousConfigParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS; else process.env.GIT_CONFIG_PARAMETERS = previousConfigParameters;
	if (previousConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = previousConfigCount;
	fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
