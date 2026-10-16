// Missing Git uses the active snapshot pipeline; public API coverage is in repository-transport-smoke.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { disposeAllCheckouts, loadFeaturedSource, scanRepository } from "../src/skills-repo-fetch.js";
import { anonymousRepositoryAccess, clearRepositoryAccess, gitMissingMessage, grantRepositoryAccess, repositoryGitAvailable, resolveGitCommand } from "../src/skills-repository-access.js";

const files = new Set(["C:\\Tools\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\cmd\\git.exe"]);
const exists = (file: string) => files.has(file);
assert.equal(resolveGitCommand("win32", { PATH: "C:\\Windows;C:\\Tools\\Git\\cmd" }, exists), "git");
assert.equal(resolveGitCommand("win32", { Path: "C:\\Windows", ProgramFiles: "C:\\Program Files" }, exists), "C:\\Program Files\\Git\\cmd\\git.exe");
assert.equal(resolveGitCommand("win32", { PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" }, exists), "C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\cmd\\git.exe");
assert.equal(resolveGitCommand("win32", { PATH: "C:\\Windows" }, () => false), "git");
assert.equal(resolveGitCommand("darwin", {}, () => false), "git");
assert.match(gitMissingMessage("win32"), /gitforwindows\.org/);
assert.match(gitMissingMessage("darwin"), /Apple's command line tools/);
assert(!/has just offered|separate window/.test(gitMissingMessage("darwin")), "missing tools do not imply an installer was opened");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-git-missing-"));
const names = ["PATH", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "EXXPERTS_STATE_HOME", "EXXETA_SKILLS_ALLOW_LOCAL_REPO", "EXXPERTS_DEVTOOLS_INSTALL_COMMAND"];
const original = new Map(names.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const git = resolveGitCommand();
const installed = await repositoryGitAvailable();
const repository = path.join(work, "repository");
const noGit = path.join(work, "empty");
const asked = path.join(work, "install-asked");
fs.mkdirSync(repository); fs.mkdirSync(noGit);

try {
	if (installed) {
		fs.writeFileSync(path.join(repository, "SKILL.md"), "---\nname: retry-tool\n---\nSynthetic missing-tool retry fixture.\n");
		for (const args of [["init", "-q", "-b", "main"], ["config", "uploadpack.allowFilter", "true"], ["add", "-A"], ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]]) {
			const result = spawnSync(git, args, { cwd: repository, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
	}
	process.env.EXXPERTS_STATE_HOME = path.join(work, "profile");
	process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO = "1";
	process.env.PATH = noGit;
	for (const name of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) delete process.env[name];
	if (process.platform !== "win32") {
		const installer = path.join(work, "installer.sh");
		fs.writeFileSync(installer, `#!/bin/sh\necho asked > '${asked}'\n`, { mode: 0o755 });
		process.env.EXXPERTS_DEVTOOLS_INSTALL_COMMAND = installer;
	}
	let apiRequests = 0;
	globalThis.fetch = async () => { apiRequests++; throw new Error("No private API or archive request is authorized."); };
	assert.equal(await repositoryGitAvailable(), false, "the fixture hides PATH and standard Windows install folders");
	const source = "https://github.com/fixture/private";
	const access = grantRepositoryAccess(source, undefined, { ...anonymousRepositoryAccess(), mode: "local-git" });
	await assert.rejects(scanRepository(source, {}, undefined, false, { accessId: access.id }), (error: unknown) => {
		assert.equal((error as { code?: string }).code, "GIT_REQUIRED");
		assert.equal((error as Error).message, gitMissingMessage());
		assert(!/ENOENT|spawn/.test((error as Error).message));
		return true;
	});
	assert.equal(apiRequests, 0, "private mode never falls back to public API or full archives");
	const featured = await loadFeaturedSource({ source: repository, author: "fixture" });
	assert.equal(featured.missingTool, true);
	assert.equal(featured.error, gitMissingMessage());
	assert(!fs.existsSync(asked), "missing Git never opens a developer-tools installer");
	for (const name of ["PATH", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
		const value = original.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value;
	}
	if (installed) {
		const retried = await loadFeaturedSource({ source: repository, author: "fixture" });
		assert(!retried.error && !retried.missingTool && retried.skills[0]?.name === "retry-tool", "a missing-tool result is not cached after Git becomes available");
	} else console.log("skills git missing smoke skipped retry after installation (Git is unavailable)");
	if (process.platform !== "win32") {
		const bin = path.join(work, "stand-in"); fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, "git"), '#!/bin/sh\nif [ "$1" = --version ]; then echo "git version fixture"; exit 0; fi\necho "fatal: Could not resolve host fixture.invalid" >&2\nexit 128\n', { mode: 0o755 });
		process.env.PATH = bin;
		await assert.rejects(scanRepository("https://github.com/fixture/ordinary-error"), /Could not resolve host fixture\.invalid/);
		assert.equal(apiRequests, 0, "ordinary Git failures preserve their error without an implicit transport switch");
	}
	console.log("skills git missing smoke: ok");
} finally {
	clearRepositoryAccess(); disposeAllCheckouts(); globalThis.fetch = originalFetch;
	for (const [name, value] of original) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
	fs.rmSync(work, { recursive: true, force: true });
}
