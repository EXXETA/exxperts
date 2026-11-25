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
// zip fails and git is missing too. The zip's comment is the commit it holds,
// and GitHub's list of refs (its git answer, read without git) says how a
// `#ref` moves and whether a repository moved since.
//
// Run: node scripts/run-smokes.mjs skills-github-archive

import { spawnSync } from "node:child_process";
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
	listRemoteRefs,
	loadFeaturedSource,
	RepoReachFailure,
	removeCheckout,
	MAC_DEVELOPER_TOOLS_MISSING,
	resolveRepoSource,
	scanRepoSkills,
	readRepoCandidate,
	type RepoOrigin,
	vendorRepoSkill,
} from "../src/skills-repo-fetch.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// The rows of a root skill each run, so one run names every answer that is wrong.
const failures: string[] = [];
function check(condition: unknown, message: string): void {
	if (!condition) failures.push(message);
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
/** A made-up commit id, as GitHub writes one as a zip's comment. */
const commitId = () => crypto.randomBytes(20).toString("hex");
const GOOD_COMMIT = commitId();
const FEATURE_COMMIT = commitId();
const TAG_OBJECT = commitId();
const TAG_COMMIT = commitId();
async function zipOf(files: Record<string, string | Buffer | { link: string }>, comment: string | null = commitId()): Promise<Buffer> {
	const zip = new JSZip();
	for (const [name, content] of Object.entries(files)) {
		if (typeof content === "object" && !Buffer.isBuffer(content)) zip.file(name, content.link, { unixPermissions: 0o120777 });
		else zip.file(name, content, { unixPermissions: 0o100644 });
	}
	return zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE", ...(comment ? { comment } : {}) });
}

const skill = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nDo ${name} things.\n`;
const goodFiles = {
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
};
const good = await zipOf(goodFiles, GOOD_COMMIT);
const goodFeature = await zipOf(goodFiles, FEATURE_COMMIT);
const noComment = await zipOf({ "quiet-1/SKILL.md": skill("quiet") }, null);
/** GitHub's list of refs, as git's smart http sends it: pkt-lines, a flush after the service line and at the end. */
const pkt = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}`;
const goodRefs = [
	pkt("# service=git-upload-pack\n"),
	"0000",
	pkt(`${GOOD_COMMIT} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`),
	pkt(`${GOOD_COMMIT} refs/heads/main\n`),
	pkt(`${FEATURE_COMMIT} refs/heads/feature/x\n`),
	pkt(`${TAG_OBJECT} refs/tags/v1\n`),
	pkt(`${TAG_COMMIT} refs/tags/v1^{}\n`),
	"0000",
].join("");
const big = await zipOf({ "big-1/SKILL.md": skill("big"), "big-1/blob.bin": crypto.randomBytes(1_500_000) });
const bomb = await zipOf({ "bomb-1/SKILL.md": skill("bomb"), "bomb-1/zeros.txt": Buffer.alloc(3_000_000) });
assert(bomb.length < 100_000, "the bomb is small packed");
const many = await zipOf(Object.fromEntries(Array.from({ length: 20_001 }, (_, i) => [`many-1/f${i}.txt`, "x"])));

// A repository that is one skill, its SKILL.md at the root, zipped by git as
// GitHub zips it: a file committed runnable, a picture and a font committed
// runnable too, and a link committed by git (`update-index --cacheinfo 120000`,
// so any platform can make one).
const rootRepo = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-github-archive-root-"));
const gitIn = (args: string[], input?: string): string => {
	const res = spawnSync("git", ["-c", "user.email=smoke@test", "-c", "user.name=Smoke", ...args], { cwd: rootRepo, encoding: "utf-8", input });
	assert(res.status === 0, `git ${args.join(" ")}: ${res.stderr}`);
	return res.stdout.trim();
};
gitIn(["init", "-q", "-b", "main"]);
fs.writeFileSync(path.join(rootRepo, "SKILL.md"), skill("rooted"));
fs.writeFileSync(path.join(rootRepo, "README.md"), "# part of the skill\n");
fs.mkdirSync(path.join(rootRepo, "bin"));
fs.writeFileSync(path.join(rootRepo, "bin", "run"), "echo run\n");
fs.writeFileSync(path.join(rootRepo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
fs.mkdirSync(path.join(rootRepo, "fonts"));
fs.writeFileSync(path.join(rootRepo, "fonts", "Sans.ttf"), Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(12)]));
gitIn(["add", "-A"]);
gitIn(["update-index", "--chmod=+x", "bin/run", "logo.png", "fonts/Sans.ttf"]);
gitIn(["update-index", "--add", "--cacheinfo", `120000,${gitIn(["hash-object", "-w", "--stdin"], "../../outside.txt")},committed-link`]);
gitIn(["commit", "-q", "-m", "root skill"]);
const ROOT_COMMIT = gitIn(["rev-parse", "HEAD"]);
const rootZip = spawnSync("git", ["archive", "--format=zip", `--prefix=rooted-${ROOT_COMMIT.slice(0, 7)}/`, "HEAD"], { cwd: rootRepo }).stdout as Buffer;
fs.rmSync(rootRepo, { recursive: true, force: true });

const requests: string[] = [];
const server = http.createServer((req, res) => {
	const url = req.url ?? "";
	requests.push(url);
	const zip = (body: Buffer) => res.writeHead(200, { "content-type": "application/zip", "content-length": body.length }).end(body);
	if (url === "/o/good/archive/HEAD.zip") res.writeHead(302, { location: "/download/good.zip" }).end();
	else if (url === "/download/good.zip") zip(good);
	else if (url === "/o/good/archive/feature/x.zip") zip(goodFeature);
	else if (url === `/o/good/archive/${GOOD_COMMIT.slice(0, 12)}.zip`) zip(good);
	else if (url === "/o/norefs/archive/feature/x.zip") zip(goodFeature);
	else if (url === "/o/norefs.git/info/refs?service=git-upload-pack") res.writeHead(500).end();
	else if (url === "/o/quiet/archive/HEAD.zip") zip(noComment);
	else if (url === "/o/rooted/archive/HEAD.zip") zip(rootZip);
	else if (url === "/o/good.git/info/refs?service=git-upload-pack") res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" }).end(goodRefs);
	else if (url === "/o/hop.git/info/refs?service=git-upload-pack") res.writeHead(302, { location: "/o/good.git/info/refs?service=git-upload-pack" }).end();
	else if (url === "/o/awayrefs.git/info/refs?service=git-upload-pack") res.writeHead(302, { location: "http://example.invalid/o/awayrefs.git/info/refs" }).end();
	else if (url === "/o/hugerefs.git/info/refs?service=git-upload-pack") res.writeHead(200, { "content-length": 1_100_000 }).end(Buffer.alloc(1_100_000, "0"));
	else if (url === "/o/slowrefs.git/info/refs?service=git-upload-pack") {
		/* never answers */
	}
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

/** Runs `run` with only `binDir` to find git in. */
async function withGitFrom<T>(binDir: string, run: () => Promise<T>): Promise<T> {
	const saved = { PATH: process.env.PATH, ProgramFiles: process.env.ProgramFiles, "ProgramFiles(x86)": process.env["ProgramFiles(x86)"], LOCALAPPDATA: process.env.LOCALAPPDATA };
	process.env.PATH = binDir;
	for (const name of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) delete process.env[name];
	try {
		return await run();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

async function attempt(address: string, binDir: string, opts: { timeoutMs?: number; downloadBytes?: number; unpackedBytes?: number } = {}): Promise<{ dir: string | null; origin: RepoOrigin | null; error: string }> {
	return withGitFrom(binDir, async () => {
		try {
			const { dir, origin } = await fetchRepoCheckout(source(address), opts.timeoutMs, { downloadBytes: opts.downloadBytes, unpackedBytes: opts.unpackedBytes });
			checkouts.push(dir);
			return { dir, origin: origin ?? null, error: "" };
		} catch (err) {
			return { dir: null, origin: null, error: err instanceof Error ? err.message : String(err) };
		}
	});
}

/** GitHub's list of refs of `address` with no git to fall back on: the refs, or why they could not be had. */
async function refsWithoutGit(address: string): Promise<{ refs: Awaited<ReturnType<typeof listRemoteRefs>> | null; failure: RepoReachFailure | null }> {
	return withGitFrom(noGit, async () => {
		try {
			return { refs: await listRemoteRefs(source(address)), failure: null };
		} catch (err) {
			assert(err instanceof RepoReachFailure, `a ref list failure is a RepoReachFailure, got ${String(err)}`);
			return { refs: null, failure: err };
		}
	});
}

try {
	// The promise: a public repository imports with no git on the machine.
	const ok = await attempt("https://github.com/o/good", noGit);
	assert(ok.dir, `a public GitHub repository needs no git, got: ${ok.error}`);
	const found = scanRepoSkills(ok.dir, "https://github.com/o/good");
	assert(found.length === 2 && found[0].license === "MIT" && found.map((s) => s.name).sort().join() === "alpha,beta", `its skills are found with the license: ${JSON.stringify(found)}`);
	const beta = found.find((s) => s.name === "beta");
	assert(beta && fs.existsSync(path.join(ok.dir, beta.path, "SKILL.md")) && !fs.existsSync("/abs-abc123"), `an absolute name lands inside the folder: ${beta?.path}`);
	assert(!fs.readdirSync(ok.dir).includes("loose.txt"), "an entry outside the wrapping folder is skipped");
	assert(fs.readFileSync(path.join(ok.dir, "skills", "alpha", "notes.md"), "utf8") === "notes\n", "a bundled file is unpacked as it was");
	assert(!fs.existsSync(path.join(ok.dir, "skills", "alpha", "link")), "a symlink is never made, nor written as a file");
	assert(!fs.existsSync(escaped) && !fs.readdirSync(ok.dir).includes("escaped-by-zip.txt"), "a name that climbs out of the folder is skipped");
	assert(!fs.readdirSync(path.join(ok.dir, "skills", "alpha")).some((name) => /hidden|stream|NUL|trailing/.test(name)), "invisible characters, colons, Windows device names and trailing dots are skipped");
	assert(requests.includes("/o/good/archive/HEAD.zip") && requests.includes("/download/good.zip"), "GitHub's redirect to its download is followed");

	assert(JSON.stringify(ok.origin) === JSON.stringify({ address: "https://github.com/o/good", refKind: "default", commit: GOOD_COMMIT }), `the zip's comment is the commit it holds, got ${JSON.stringify(ok.origin)}`);

	const ref = await attempt("https://github.com/o/good#feature/x", noGit);
	assert(ref.dir && requests.includes("/o/good/archive/feature/x.zip"), `a #branch downloads that branch: ${ref.error}`);
	assert(JSON.stringify(ref.origin) === JSON.stringify({ address: "https://github.com/o/good", ref: "feature/x", refKind: "branch", commit: FEATURE_COMMIT }), `GitHub's list of refs says #feature/x is a branch, got ${JSON.stringify(ref.origin)}`);
	assert(requests.includes("/o/good.git/info/refs?service=git-upload-pack"), "the kind of a #ref is asked of GitHub's list, without git");
	const asksBefore = requests.filter((url) => url.includes("info/refs")).length;
	const pinned = await attempt(`https://github.com/o/good#${GOOD_COMMIT.slice(0, 12)}`, noGit);
	assert(JSON.stringify(pinned.origin) === JSON.stringify({ address: "https://github.com/o/good", ref: GOOD_COMMIT.slice(0, 12), refKind: "commit", commit: GOOD_COMMIT }), `a #commit the zip's commit begins with is fixed to that commit, got ${JSON.stringify(pinned.origin)} ${pinned.error}`);
	assert(requests.filter((url) => url.includes("info/refs")).length === asksBefore, "and GitHub's list of refs is not asked");
	// A #branch whose kind GitHub's list can't tell still adds from its zip, with no git, only without a version to keep up to date.
	const untold = await attempt("https://github.com/o/norefs#feature/x", noGit);
	assert(untold.dir && untold.origin === null, `the zip is kept without a version, got ${JSON.stringify(untold.origin)} ${untold.error}`);
	const quiet = await attempt("https://github.com/o/quiet", noGit);
	assert(quiet.error === "GitHub's download did not say which commit it holds", `a zip without its commit goes to git like any zip failure, got: ${quiet.error}`);

	// A skill at the repository's root comes in with the repository's files, its
	// runnable file still runnable, its picture and font not, and never the link
	// committed beside them.
	const rooted = await attempt("https://github.com/o/rooted", noGit);
	assert(rooted.dir && rooted.origin?.commit === ROOT_COMMIT, `git's own zip downloads, its commit from the comment, got ${JSON.stringify(rooted.origin)} ${rooted.error}`);
	const rootFound = scanRepoSkills(rooted.dir, "https://github.com/o/rooted");
	check(rootFound.length === 1 && rootFound[0].path === "", `the root skill is found, got ${JSON.stringify(rootFound)}`);
	const rootCandidate = readRepoCandidate(rooted.dir, "", "https://github.com/o/rooted")!;
	const scriptKind = process.platform === "win32" ? "other" : "scripts";
	const wantedFiles = [{ path: "README.md", kind: "documents" }, { path: "SKILL.md", kind: "instructions" }, { path: "bin/run", kind: scriptKind }, { path: "fonts/Sans.ttf", kind: "other" }, { path: "logo.png", kind: "templates" }];
	check(JSON.stringify(rootCandidate.files) === JSON.stringify(wantedFiles), `the review lists the repository's files but the link, the runnable one with the scripts: ${JSON.stringify(wantedFiles)}, got ${JSON.stringify(rootCandidate.files)}`);
	const rootDest = path.join(tempRoot, "store", "rooted");
	vendorRepoSkill(rooted.dir, "", rootDest);
	const vendored = (fs.readdirSync(rootDest, { recursive: true }) as string[]).map(String).filter((file) => file !== "provenance.json").sort().join(",");
	check(vendored === ["README.md", "SKILL.md", "bin", path.join("bin", "run"), "fonts", path.join("fonts", "Sans.ttf"), "logo.png"].sort().join(","), `the add copies the repository's files, never the link, got ${vendored}`);
	if (process.platform !== "win32") {
		const mode = (file: string) => (fs.existsSync(path.join(rootDest, file)) ? fs.statSync(path.join(rootDest, file)).mode & 0o777 : 0);
		const modes = ["bin/run", "README.md", "logo.png", "fonts/Sans.ttf"].map((file) => mode(file).toString(8)).join(" ");
		check(modes === "700 600 600 600", `the runnable file stays runnable, the picture, the font and the others 0600, got ${modes}`);
	}

	assert(failures.length === 0, failures.join("\n"));

	// GitHub's list of refs, without git: the default branch, a branch, a tag's commit.
	const listed = await refsWithoutGit("https://github.com/o/good");
	assert(listed.refs?.head === GOOD_COMMIT && listed.refs.refs.get("refs/heads/feature/x") === FEATURE_COMMIT, `the list reads without git, got ${JSON.stringify(listed.failure?.message)}`);
	assert(listed.refs.refs.get("refs/tags/v1") === TAG_COMMIT, "an annotated tag is the commit it points at");
	const hop = await refsWithoutGit("https://github.com/o/hop");
	assert(hop.refs?.head === GOOD_COMMIT, `the list follows a redirect GitHub's own host sends, got ${JSON.stringify(hop.failure?.message)}`);
	const awayRefs = await refsWithoutGit("https://github.com/o/awayrefs");
	assert(awayRefs.failure?.reason === "failed" && awayRefs.failure.message === "GitHub sent the download to an unexpected address", `a redirect off GitHub is refused, got ${JSON.stringify(awayRefs.failure?.message)}`);
	assert(!requests.some((url) => url.includes("example.invalid")), "and never followed");
	const hugeRefs = await refsWithoutGit("https://github.com/o/hugerefs");
	assert(hugeRefs.failure?.reason === "missing-tool" && requests.includes("/o/hugerefs.git/info/refs?service=git-upload-pack"), `a list over 1 MB is left to git, got ${JSON.stringify(hugeRefs.failure)}`);

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

	// A list that never comes is given up after 15 seconds; with no git either, the reason is GitHub's.
	const asked = Date.now();
	const slowRefs = await refsWithoutGit("https://github.com/o/slowrefs");
	const waited = Date.now() - asked;
	assert(slowRefs.failure?.reason === "timeout" && slowRefs.failure.message === "GitHub did not answer in time", `a silent list times out, got ${JSON.stringify(slowRefs.failure)}`);
	assert(waited >= 14_000 && waited < 25_000, `the list is given 15 seconds, waited ${waited} ms`);

	console.log("skills github archive smoke: ok");
} finally {
	process.env.PATH = originalPath;
	server.closeAllConnections();
	server.close();
	for (const dir of checkouts) fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(tempRoot, { recursive: true, force: true });
	fs.rmSync(escaped, { force: true });
}
