// Skills from a public GitHub repository without git.
//
// Importing skills used to clone with git, so on Windows without Git and on a
// Mac without Apple's command line tools even the featured directory failed.
// A public GitHub address is now downloaded as GitHub's zip and unpacked as
// plain files; git stays for private repositories (GitHub answers 404 without
// a sign-in), very big ones, other hosts and SSH addresses. This drives the
// real download against a stand-in GitHub on this machine: which addresses
// qualify, the unpack (no symlink, no name that leaves the folder), the size
// and file limits, the redirects GitHub may send, and what happens when the
// zip fails and git is missing too.
//
// Run: node scripts/run-smokes.mjs skills-github-archive

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
	fetchRepoCheckout,
	githubArchiveUrl,
	gitMissingMessage,
	isMissingToolMessage,
	loadFeaturedSource,
	removeCheckout,
	MAC_DEVELOPER_TOOLS_MISSING,
	resolveRepoSource,
	scanRepoSkills,
} from "../src/skills-repo-fetch.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function source(address: string) {
	const resolved = resolveRepoSource(address);
	assert(resolved.ok, `${address} resolves`);
	return resolved.value;
}

// Which addresses go to GitHub's zip, and which stay with git.
{
	const base = "https://github.com";
	const url = (address: string) => githubArchiveUrl(source(address), base);
	assert(url("https://github.com/anthropics/skills") === "https://github.com/anthropics/skills/archive/HEAD.zip", "a plain GitHub address downloads its default branch");
	assert(url("github.com/obra/superpowers.git/") === "https://github.com/obra/superpowers/archive/HEAD.zip", "the shorthand, .git and a trailing slash download the same");
	assert(url("https://github.com/o/r#feature/x") === "https://github.com/o/r/archive/feature/x.zip", "a branch with a slash keeps its path");
	assert(url("https://github.com/o/r#v1.0") === "https://github.com/o/r/archive/v1.0.zip", "a tag downloads too");
	for (const address of ["git@github.com:o/r.git", "ssh://git@github.com/o/r", "https://gitlab.com/o/r", "https://me@github.com/o/r", "https://github.com/o/r/tree/main", "http://github.com/o/r", "https://github.com:8443/o/r", "https://github.com/o/r#a/../b"]) {
		assert(url(address) === null, `${address} stays with git`);
	}
	// The test stand-in may only live on this machine: any other override is ignored.
	process.env.EXXPERTS_GITHUB_ARCHIVE_BASE = "http://example.com";
	assert(githubArchiveUrl(source("https://github.com/o/r")) === "https://github.com/o/r/archive/HEAD.zip", "an override off this machine is ignored");
}

// A stand-in GitHub: zips made like GitHub's (one wrapping folder), its 404
// for a private repository, and the misbehaviours the download must survive.
async function zipOf(files: Record<string, string | Buffer | { link: string }>): Promise<Buffer> {
	const zip = new JSZip();
	for (const [name, content] of Object.entries(files)) {
		if (typeof content === "object" && !Buffer.isBuffer(content)) zip.file(name, content.link, { unixPermissions: 0o120777 });
		else zip.file(name, content, { unixPermissions: 0o100644 });
	}
	return zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
}

const skill = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nDo ${name} things.\n`;
const good = await zipOf({
	"good-abc123/README.md": "# Skills\n",
	"good-abc123/LICENSE": "MIT License\n",
	"good-abc123/skills/alpha/SKILL.md": skill("alpha"),
	"good-abc123/skills/alpha/notes.md": "notes\n",
	"good-abc123/skills/alpha/link": { link: "/etc/passwd" },
	"good-abc123/../escaped-by-zip.txt": "out\n",
	"good-abc123/skills/alpha/hidden​name.md": "x\n",
	"good-abc123/skills/alpha/stream:x.md": "x\n",
	"good-abc123/skills/alpha/NUL.txt": "x\n",
	"good-abc123/skills/alpha/trailing.": "x\n",
	"/abs-abc123/skills/beta/SKILL.md": skill("beta"),
	"loose.txt": "no wrapping folder\n",
});
const big = await zipOf({ "big-1/SKILL.md": skill("big"), "big-1/blob.bin": crypto.randomBytes(1_500_000) });
const bomb = await zipOf({ "bomb-1/SKILL.md": skill("bomb"), "bomb-1/zeros.txt": Buffer.alloc(3_000_000) });
assert(bomb.length < 100_000, "the bomb is small packed");
const many = await zipOf(Object.fromEntries(Array.from({ length: 20_001 }, (_, i) => [`many-1/f${i}.txt`, "x"])));

const requests: string[] = [];
const server = http.createServer((req, res) => {
	const url = req.url ?? "";
	requests.push(url);
	const zip = (body: Buffer) => res.writeHead(200, { "content-type": "application/zip", "content-length": body.length }).end(body);
	if (url === "/o/good/archive/HEAD.zip") res.writeHead(302, { location: "/download/good.zip" }).end();
	else if (url === "/download/good.zip" || url === "/o/good/archive/feature/x.zip") zip(good);
	else if (url === "/o/big/archive/HEAD.zip") zip(big);
	else if (url === "/o/bomb/archive/HEAD.zip") zip(bomb);
	else if (url === "/o/many/archive/HEAD.zip") zip(many);
	else if (url === "/o/away/archive/HEAD.zip") res.writeHead(302, { location: "http://example.invalid/o/away.zip" }).end();
	else if (url === "/o/loop/archive/HEAD.zip") res.writeHead(302, { location: "/o/loop/archive/HEAD.zip" }).end();
	else if (url === "/o/html/archive/HEAD.zip") res.writeHead(200, { "content-type": "text/html" }).end("<html>sign in</html>");
	else if (url === "/o/slow/archive/HEAD.zip") {
		/* never answers */
	} else res.writeHead(404).end("Not Found");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.EXXPERTS_GITHUB_ARCHIVE_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-github-archive-"));
const originalPath = process.env.PATH;
const checkouts: string[] = [];
const escaped = path.join(os.tmpdir(), "escaped-by-zip.txt");
fs.rmSync(escaped, { force: true });

// No git at all: an empty folder as PATH, and on Windows no install folders
// either (the app looks there too, and CI's Windows has Git in one).
const noGit = path.join(tempRoot, "no-git");
fs.mkdirSync(noGit);

async function attempt(address: string, binDir: string, opts: { timeoutMs?: number; downloadBytes?: number; unpackedBytes?: number } = {}): Promise<{ dir: string | null; error: string }> {
	const saved = { PATH: process.env.PATH, ProgramFiles: process.env.ProgramFiles, "ProgramFiles(x86)": process.env["ProgramFiles(x86)"], LOCALAPPDATA: process.env.LOCALAPPDATA };
	process.env.PATH = binDir;
	for (const name of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) delete process.env[name];
	try {
		const dir = await fetchRepoCheckout(source(address), opts.timeoutMs, { downloadBytes: opts.downloadBytes, unpackedBytes: opts.unpackedBytes });
		checkouts.push(dir);
		return { dir, error: "" };
	} catch (err) {
		return { dir: null, error: err instanceof Error ? err.message : String(err) };
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

try {
	// The promise: a public repository imports with no git on the machine.
	const ok = await attempt("https://github.com/o/good", noGit);
	assert(ok.dir, `a public GitHub repository needs no git, got: ${ok.error}`);
	const found = scanRepoSkills(ok.dir);
	assert(found.length === 2 && found[0].license === "MIT" && found.map((s) => s.name).sort().join() === "alpha,beta", `its skills are found with the license: ${JSON.stringify(found)}`);
	const beta = found.find((s) => s.name === "beta");
	assert(beta && fs.existsSync(path.join(ok.dir, beta.path, "SKILL.md")) && !fs.existsSync("/abs-abc123"), `an absolute name lands inside the folder: ${beta?.path}`);
	assert(!fs.readdirSync(ok.dir).includes("loose.txt"), "an entry outside the wrapping folder is skipped");
	assert(fs.readFileSync(path.join(ok.dir, "skills", "alpha", "notes.md"), "utf8") === "notes\n", "a bundled file is unpacked as it was");
	assert(!fs.existsSync(path.join(ok.dir, "skills", "alpha", "link")), "a symlink is never made, nor written as a file");
	assert(!fs.existsSync(escaped) && !fs.readdirSync(ok.dir).includes("escaped-by-zip.txt"), "a name that climbs out of the folder is skipped");
	assert(!fs.readdirSync(path.join(ok.dir, "skills", "alpha")).some((name) => /hidden|stream|NUL|trailing/.test(name)), "invisible characters, colons, Windows device names and trailing dots are skipped");
	assert(requests.includes("/o/good/archive/HEAD.zip") && requests.includes("/download/good.zip"), "GitHub's redirect to its download is followed");

	const ref = await attempt("https://github.com/o/good#feature/x", noGit);
	assert(ref.dir && requests.includes("/o/good/archive/feature/x.zip"), `a #branch downloads that branch: ${ref.error}`);

	// The featured directory too: no git, no "Could not load".
	process.env.PATH = noGit;
	try {
		const featured = await loadFeaturedSource({ source: "https://github.com/o/good", author: "o" });
		assert(!featured.error && featured.skills.length === 2, `the featured directory works without git: ${JSON.stringify(featured)}`);
		if (featured.token) removeCheckout(featured.token);
	} finally {
		process.env.PATH = originalPath;
	}

	// When the zip fails, and git is missing too.
	const unexpected = await attempt("https://github.com/o/away", noGit);
	assert(unexpected.error === "GitHub sent the download to an unexpected address", `a redirect off GitHub is refused, got: ${unexpected.error}`);
	assert(!requests.some((url) => url.includes("away.zip")), "and never followed");
	assert((await attempt("https://github.com/o/loop", noGit)).error === "GitHub sent the download to an unexpected address", "a redirect loop ends");
	const html = await attempt("https://github.com/o/html", noGit);
	assert(html.error === "GitHub's download was not a readable zip" && !isMissingToolMessage(html.error), `a page that is not a zip says so, not that git is missing: ${html.error}`);
	const slow = await attempt("https://github.com/o/slow", noGit, { timeoutMs: 1_500 });
	assert(slow.error === "GitHub did not answer in time", `a silent GitHub times out: ${slow.error}`);
	// A private repository, and those too big for a zip, are git's job: a
	// missing git then reads as the missing tool, as before.
	assert((await attempt("https://github.com/o/private", noGit)).error === gitMissingMessage(), "a private repository needs git, and says so");
	assert((await attempt("https://github.com/o/big", noGit, { downloadBytes: 1_000_000 })).error === gitMissingMessage(), "a download over the limit goes to git");
	assert((await attempt("https://github.com/o/bomb", noGit, { unpackedBytes: 1_000_000 })).error === gitMissingMessage(), "a zip that unpacks over the limit goes to git");
	assert((await attempt("https://github.com/o/many", noGit)).error === gitMissingMessage(), "a zip with too many files goes to git");

	if (process.platform !== "win32") {
		// git present: a private repository reaches it (here a stand-in that
		// records the call and answers like GitHub for a missing repository).
		const gitDir = path.join(tempRoot, "git");
		const called = path.join(tempRoot, "git-called");
		fs.mkdirSync(gitDir);
		fs.writeFileSync(path.join(gitDir, "git"), `#!/bin/sh\necho "$@" >> '${called}'\necho "fatal: repository 'https://github.com/o/private/' not found" >&2\nexit 128\n`, { mode: 0o755 });
		const viaGit = await attempt("https://github.com/o/private", gitDir);
		assert(fs.existsSync(called) && /repository .* not found/.test(viaGit.error), `a private repository is handed to git: ${viaGit.error}`);
	}

	if (process.platform === "darwin") {
		// A Mac without Apple's tools: GitHub unreachable is not a reason to
		// open the install window, a private repository is.
		const installDir = path.join(tempRoot, "install");
		const installAsked = path.join(installDir, "asked");
		fs.mkdirSync(installDir);
		fs.writeFileSync(path.join(installDir, "ask.sh"), `#!/bin/sh\necho "$*" >> '${installAsked}'\n`, { mode: 0o755 });
		process.env.EXXPERTS_DEVTOOLS_INSTALL_COMMAND = path.join(installDir, "ask.sh");
		const stub = path.join(tempRoot, "apple");
		fs.mkdirSync(stub);
		fs.writeFileSync(path.join(stub, "git"), `#!/bin/sh\necho "xcode-select: note: No developer tools were found, requesting install." >&2\nexit 1\n`, { mode: 0o755 });
		const offline = await attempt("https://github.com/o/html", stub);
		await new Promise((r) => setTimeout(r, 300));
		assert(offline.error === "GitHub's download was not a readable zip" && !fs.existsSync(installAsked), `GitHub's own failure is shown and no install window is asked for: ${offline.error}`);
		const privateOnMac = await attempt("https://github.com/o/private", stub);
		for (let i = 0; i < 40 && !fs.existsSync(installAsked); i++) await new Promise((r) => setTimeout(r, 50));
		assert(privateOnMac.error === MAC_DEVELOPER_TOOLS_MISSING && fs.existsSync(installAsked), `a private repository on such a Mac asks for the tools: ${privateOnMac.error}`);
	}

	console.log("skills github archive smoke: ok");
} finally {
	process.env.PATH = originalPath;
	server.closeAllConnections();
	server.close();
	for (const dir of checkouts) fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(tempRoot, { recursive: true, force: true });
	fs.rmSync(escaped, { force: true });
}
