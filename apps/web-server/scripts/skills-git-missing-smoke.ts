// Importing skills on a machine that cannot run git.
//
// Importing from a repository clones it with git. On Windows without Git the
// person read "spawn git ENOENT"; on a Mac without Apple's command line tools,
// /usr/bin/git is a stand-in whose xcode-select text came through word for
// word. Both now say which tool is missing and where to get it, with no command
// to type, while every other git failure keeps its own words. This drives the
// real clone with git hidden, then with a stand-in that answers like Apple's,
// then with one that fails for an ordinary reason, and checks that Git for
// Windows is found in its install folders when PATH does not have it.
//
// Run: node scripts/run-smokes.mjs skills-git-missing

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
	cloneRepoShallow,
	gitMissingMessage,
	isMacDeveloperToolsStub,
	isMissingToolMessage,
	loadFeaturedSource,
	MAC_DEVELOPER_TOOLS_MISSING,
	resolveGitCommand,
	resolveRepoSource,
} from "../src/skills-repo-fetch.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// Git for Windows found on PATH, in its install folders, or not at all.
{
	const files = new Set([
		"C:\\Tools\\Git\\cmd\\git.exe",
		"C:\\Program Files\\Git\\cmd\\git.exe",
		"C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\cmd\\git.exe",
	]);
	const exists = (p: string) => files.has(p);
	assert(resolveGitCommand("win32", { PATH: "C:\\Windows;C:\\Tools\\Git\\cmd" }, exists) === "git", "git on PATH runs as git");
	assert(resolveGitCommand("win32", { Path: "C:\\Windows", ProgramFiles: "C:\\Program Files" }, exists) === "C:\\Program Files\\Git\\cmd\\git.exe", "an install PATH has not caught up with is found in Program Files");
	assert(resolveGitCommand("win32", { PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" }, exists) === "C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\cmd\\git.exe", "a per-user install is found too");
	assert(resolveGitCommand("win32", { PATH: "C:\\Windows" }, () => false) === "git", "with no git anywhere, plain git (and the plain message)");
	assert(resolveGitCommand("darwin", {}, () => false) === "git", "other systems always use PATH");
}

if (process.platform === "win32") {
	console.log("skills git missing smoke: the clone half skipped, its stand-in git is a shell script");
	process.exit(0);
}

// GitHub's zip would spare these sources git; a stand-in that answers 404
// (as GitHub does for a private repository) keeps them on the git path.
const github = http.createServer((_req, res) => res.writeHead(404).end("Not Found"));
await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
process.env.EXXPERTS_GITHUB_ARCHIVE_BASE = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

const resolved = resolveRepoSource("https://github.com/anthropics/skills");
// Never the real xcode-select: a stand-in records that the install was asked for.
const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-devtools-"));
const installAsked = path.join(installDir, "asked");
const installStandIn = `${installAsked}.sh`;
fs.writeFileSync(installStandIn, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${installAsked}'\n`, { mode: 0o755 });
process.env.EXXPERTS_DEVTOOLS_INSTALL_COMMAND = installStandIn;
assert(resolved.ok, "a GitHub address resolves");
const source = resolved.value;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-git-missing-"));
const originalPath = process.env.PATH;

async function cloneError(binDir: string): Promise<string> {
	process.env.PATH = binDir;
	try {
		await cloneRepoShallow(source, 10_000);
		return "";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	} finally {
		process.env.PATH = originalPath;
	}
}

function standIn(name: string, stderr: string): string {
	const dir = path.join(tempRoot, name);
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' '${stderr}' >&2\nexit 1\n`, { mode: 0o755 });
	return dir;
}

try {
	const empty = path.join(tempRoot, "empty");
	fs.mkdirSync(empty);
	const missing = await cloneError(empty);
	assert(missing === gitMissingMessage(), `no git at all reads as the missing tool, got: ${missing}`);
	assert(!/ENOENT|spawn/.test(missing), "and no system error text reaches the screen");

	// Apple's stand-in exists only on a Mac; elsewhere its text is just a failure.
	if (process.platform === "darwin") {
		const mac = await cloneError(standIn("mac", "xcode-select: note: No developer tools were found, requesting install."));
		assert(mac === MAC_DEVELOPER_TOOLS_MISSING, `Apple's stand-in reads as the missing tools, got: ${mac}`);
		assert(!/xcode-select|sudo/.test(mac), "with no command to type");
		for (let i = 0; i < 40 && !fs.existsSync(installAsked); i++) await new Promise((r) => setTimeout(r, 50));
		assert(fs.existsSync(installAsked) && fs.readFileSync(installAsked, "utf8").trim() === "--install", "the app asks macOS for the install window itself");

		// The featured directory marks it, so the page says it once, not per source,
		// and does not remember it: "try again" after installing must really try.
		process.env.PATH = path.join(tempRoot, "mac");
		try {
			const featured = await loadFeaturedSource({ source: "https://github.com/anthropics/skills", author: "anthropics" });
			assert(featured.missingTool === true && featured.error === MAC_DEVELOPER_TOOLS_MISSING, `a featured source marks the missing tool: ${JSON.stringify(featured)}`);
			const other = standIn("other-featured", "fatal: unable to access 'https://github.com/anthropics/skills/': Could not resolve host");
			process.env.PATH = other;
			const retried = await loadFeaturedSource({ source: "https://github.com/anthropics/skills", author: "anthropics" });
			assert(retried.error?.includes("Could not resolve host") && !retried.missingTool, `a retry after the tool appears runs again, not from memory: ${JSON.stringify(retried)}`);
		} finally {
			process.env.PATH = originalPath;
		}
		assert(!isMacDeveloperToolsStub("remote: xcode-select: note: No developer tools were found", "darwin"), "a server's remote: line is not this Mac's state");
		assert(!isMacDeveloperToolsStub("xcode-select: note: No developer tools were found", "linux"), "and only a Mac has Apple's stand-in");
		assert(isMissingToolMessage(gitMissingMessage()) && isMissingToolMessage(MAC_DEVELOPER_TOOLS_MISSING), "both sentences read as a missing tool");
		await new Promise((r) => setTimeout(r, 300));
		assert(fs.readFileSync(installAsked, "utf8").trim().split("\n").length === 1, "and asks once, not once per failing source");
	}

	const other = await cloneError(standIn("other", "fatal: repository 'https://github.com/anthropics/skills/' not found"));
	assert(/repository .* not found/.test(other), `any other git failure keeps its own words, got: ${other}`);
	assert(!isMissingToolMessage(other), "and is not mistaken for a missing tool");

	console.log("skills git missing smoke: ok");
} finally {
	process.env.PATH = originalPath;
	github.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
	fs.rmSync(installDir, { recursive: true, force: true });
}
