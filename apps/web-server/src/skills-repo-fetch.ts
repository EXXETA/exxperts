/**
 * Skills MR-4 — import-from-repo + featured-sources fetch/scan (spec §3 path 3 +
 * Browse). Server-side ONLY: this module clones a git/GitHub repo SHALLOWLY,
 * discovers its true `SKILL.md` manifests (MR-1's SKILL.md-only filter, so a
 * repo's README/docs are never ingested), and turns a chosen skill into the
 * review-screen candidate. Nothing here EVER executes fetched repo content — the
 * checkout is clone/read only (spec §0 D-exec, §7 must 1):
 *
 *   - `git clone --depth 1 --no-tags --single-branch` via a child_process ARGS
 *     ARRAY (never a shell string), so a hostile URL cannot inject a command;
 *   - hooks neutralized (`core.hooksPath=/dev/null`, empty `GIT_TEMPLATE_DIR`),
 *     submodules never recursed, credential prompts disabled (a private repo
 *     authenticates only through a sign-in git already stored, which the clone
 *     reads and never stores or erases), transports allow-listed;
 *   - temp checkouts live under the OS temp dir, are traversal-guarded on read,
 *     and are swept on TTL / cleaned on process exit;
 *   - nothing enters the library here — vendoring happens only on review-accept.
 */

import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { parseFrontmatter as parseYamlFrontmatter } from "@exxeta/exxperts-runtime";
import { frontmatterFlagTrue } from "./skills-executable.js";
import { SKILL_ID_MAX_LENGTH, SKILL_PROVENANCE_FILENAME, type SkillRefKind } from "./skills-store.js";
import { filterRepoScanSkillFiles, isSkillScript, keepsRunMark, keptFileMode, nameFoldsOnto, outsidePath, scanInvisibleUnicode, SCRIPT_HEAD_BYTES, skillFileKind, skillFileList, skillOverLimit, SkillTooBigError, type InvisibleUnicodeScan, type SkillFile } from "./skills-import.js";
import { repositoryFailedLine, type SkillTooBig } from "../../web-ui/src/skill-source-copy.js";

/** A skill discovered in a cloned repo (the multi-select list row, spec §3). */
export interface RepoFoundSkill {
	/** Repo-relative POSIX path of the skill's directory ("" for a root SKILL.md). */
	path: string;
	/** Frontmatter `name`, falling back to its folder's name, or the repository's for a root SKILL.md. */
	name: string;
	/** The name the library keeps it under and a room's "/" picks it by: `name` fitted (`fitSkillName`). */
	id: string;
	description: string;
	/** License from frontmatter, else the skill folder's LICENSE file, else the repo's, else null. */
	license: string | null;
	/** True when the skill dir carries any non-.md file (spec §3 bundled-scripts flag). */
	hasBundledScripts: boolean;
	/** The author marked it `disable-model-invocation`: the list shows the tag. */
	disableModelInvocation: boolean;
	/** Past the size limit, with its real count or size: it can't be added. */
	tooBig?: SkillTooBig;
}

/** The review-screen candidate (the MR-3 seam contract shape). */
export interface RepoSkillCandidate {
	name: string;
	/** The name the library keeps it under and a room's "/" picks it by (`RepoFoundSkill.id`). */
	id: string;
	/** Its front matter's name, when that isn't the "/" name: Replace tells a different skill by it. */
	writtenName?: string;
	description: string;
	body: string;
	/** Display source (the repo the user pasted / a featured entry). */
	source: string;
	license: string | null;
	/** The version its front matter states, or null. */
	version: string | null;
	/** Invisible-unicode findings surfaced at review (spec §7 must 1). */
	scanFindings: InvisibleUnicodeScan;
	/** Every file an import writes, SKILL.md included, with its kind, which the review lists. */
	files: SkillFile[];
	/** The author marked it `disable-model-invocation`: the review tags it as one that starts only when picked. */
	disableModelInvocation: boolean;
	/** The first path, as written, its Markdown reaches above its folder by (`outsidePath`): adding copies the folder alone. */
	outsidePath?: string;
}

/** A curated Browse source (spec §3 featured-sources v1). */
export interface FeaturedSource {
	source: string;
	author: string;
}

/**
 * Featured Browse sources v1 (spec §3, locked). Extending Browse is a CONFIG
 * change only — add an entry here (or via the `EXXPERTS_SKILLS_FEATURED_SOURCES`
 * JSON override), no code change. Anthropic's document skills are
 * source-available: importable by the user, never vendored as builtins (D-license).
 */
export const FEATURED_SKILL_SOURCES: readonly FeaturedSource[] = [
	{ source: "https://github.com/anthropics/skills", author: "anthropics" },
	{ source: "https://github.com/obra/superpowers", author: "obra" },
];

/** Resolve the featured list, honouring the `EXXPERTS_SKILLS_FEATURED_SOURCES` JSON override (testability / ops). */
export function resolveFeaturedSources(env: NodeJS.ProcessEnv = process.env): FeaturedSource[] {
	const raw = env.EXXPERTS_SKILLS_FEATURED_SOURCES;
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				const cleaned = parsed
					.map((e) => ({ source: String(e?.source ?? "").trim(), author: String(e?.author ?? "").trim() }))
					.filter((e) => e.source);
				if (cleaned.length > 0) return cleaned;
			}
		} catch {
			// Fall through to the built-in list on a malformed override.
		}
	}
	return FEATURED_SKILL_SOURCES.map((e) => ({ ...e }));
}

// --- URL / source validation -------------------------------------------------
//
// git is spawned with an args array, so shell-injection is structurally
// impossible; validation is about (a) refusing non-repo junk early with a clear
// message, and (b) argument-injection defence — a source or ref that begins with
// "-" must never reach git as a flag (we also pass `--` before the repo arg).

const SHELL_META = /[\s;|&`$<>()\\]/;

export interface ResolvedRepoSource {
	kind: "git" | "local";
	/** The exact argument handed to `git clone` (a URL, or an absolute local path). */
	cloneArg: string;
	/** Optional branch/ref to check out shallowly. */
	ref?: string;
	/** Human-readable source recorded in provenance and shown in the UI; never carries a user name. */
	display: string;
	/** The remote's host, named in a sign-in failure. Absent for a local source. */
	host?: string;
}

function looksLikeLocalPath(input: string): boolean {
	return input.startsWith("/") || input.startsWith("./") || input.startsWith("../") || /^[a-zA-Z]:[\\/]/.test(input);
}

/**
 * Validate a pasted source into something safe to clone. Accepts git/GitHub-shaped
 * URLs (https/http/ssh/git, `git@host:user/repo`, and `host/user/repo`
 * shorthand), plus `file://` URLs and absolute local paths (the fetch path must
 * accept a local repo for smoke testability — spec §3/smokes). Returns a clear
 * error otherwise. Never throws. `recorded` marks an address read back from a
 * skill's record: it is taken as it was recorded, so a `git@host:<digits>/a/b`
 * there stays a folder named in digits (see `sshPortOf`).
 */
export function resolveRepoSource(rawInput: string, opts: { allowLocal?: boolean; recorded?: boolean } = {}): { ok: true; value: ResolvedRepoSource } | { ok: false; error: string } {
	const input = String(rawInput ?? "").trim();
	if (!input) return { ok: false, error: "a repository URL is required" };
	if (input.length > 2048) return { ok: false, error: "repository URL is too long" };
	if (input.includes("\0") || /[\r\n]/.test(input)) return { ok: false, error: "repository URL contains invalid characters" };

	// file:// URL or local filesystem path (smokes / local repos).
	if (input.startsWith("file://")) {
		let local: string;
		try {
			local = fileURLToPath(input);
		} catch {
			return { ok: false, error: "invalid file:// URL" };
		}
		return finishLocal(local, opts.allowLocal);
	}
	if (looksLikeLocalPath(input)) return finishLocal(path.resolve(input), opts.allowLocal);

	// git URL. Strip an optional `#ref` suffix; the rest must be a recognisable
	// git remote and must not begin with "-" (argument-injection guard).
	const hashAt = input.indexOf("#");
	const urlPart = hashAt >= 0 ? input.slice(0, hashAt) : input;
	const ref = hashAt >= 0 ? input.slice(hashAt + 1).trim() : undefined;
	if (ref !== undefined && (ref === "" || ref.startsWith("-") || SHELL_META.test(ref))) return { ok: false, error: "invalid git ref" };
	if (urlPart.startsWith("-")) return { ok: false, error: "invalid repository URL" };

	const scpLike = urlPart.match(/^git@([^:\s]+):([^\s]+)$/);
	const port = scpLike && !opts.recorded && !/[/@]/.test(scpLike[1]) ? sshPortOf(scpLike[2]) : null;
	if (scpLike && port) return resolveRepoSource(`ssh://git@${scpLike[1]}:${port.port}/${port.path}${ref === undefined ? "" : `#${ref}`}`, opts);
	if (scpLike) {
		// Reject a leading-dash host independently of git's own CVE-2017-1000117
		// fix — a `git@-oProxyCommand=…:x/y` host must never reach ssh as an option.
		if (scpLike[1].startsWith("-")) return { ok: false, error: "invalid git host" };
		const repoPath = scpLike[2].replace(/\.git$/, "");
		if (repoPath.split("/").filter(Boolean).length < 2) return { ok: false, error: "expected a git@host:user/repo URL" };
		return { ok: true, value: { kind: "git", cloneArg: urlPart, ref, display: urlPart, host: scpLike[1] } };
	}

	const protoMatch = urlPart.match(/^(https?|ssh|git):\/\//i);
	let cloneArg = urlPart;
	if (!protoMatch) {
		// `host/user/repo` shorthand → assume https. Require a dotted host and at least user/repo.
		const slash = urlPart.indexOf("/");
		const host = slash < 0 ? "" : urlPart.slice(0, slash);
		const rest = slash < 0 ? "" : urlPart.slice(slash + 1);
		if (!host.includes(".") || rest.replace(/\.git$/, "").split("/").filter(Boolean).length < 2) {
			return { ok: false, error: "expected a git URL (e.g. https://github.com/user/repo)" };
		}
		cloneArg = `https://${urlPart}`;
	}
	// Structural sanity + no stray shell metacharacters in the clone arg.
	let parsed: URL;
	try {
		parsed = new URL(cloneArg);
	} catch {
		return { ok: false, error: "invalid repository URL" };
	}
	if (addressHasPassword(cloneArg)) return { ok: false, error: PASSWORD_IN_ADDRESS };
	if (parsed.hostname.startsWith("-") || SHELL_META.test(parsed.hostname) || parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean).length < 2) {
		return { ok: false, error: "expected a git URL with a user/repo path" };
	}
	return { ok: true, value: { kind: "git", cloneArg, ref, display: shownAddress(parsed, cloneArg), host: parsed.host } };
}

/**
 * The port in the path of a `git@host:<port>/group/repo` address, as a GitLab
 * on its own SSH port gives it, with the path after it; null for any other
 * path. git reads that form as port 22 and a folder named for the digits, so it
 * is sent as `ssh://git@host:<port>/group/repo`. One part after the digits
 * (`git@host:2024/repo`) stays a folder. Only a typed address is read so: an
 * add records the `ssh://` form, so a recorded `git@host:<digits>/a/b` is a
 * group named in digits and goes to git as recorded. A person adding such a
 * group from a typed address uses its https or `ssh://` address.
 */
function sshPortOf(scpPath: string): { port: string; path: string } | null {
	const match = scpPath.match(/^([1-9]\d{0,4})\/(.+)$/);
	if (!match || Number(match[1]) > 65535 || match[2].replace(/\.git$/, "").split("/").filter(Boolean).length < 2) return null;
	return { port: match[1], path: match[2] };
}

/**
 * The address a skill's record keeps to reach the repository again, without the
 * `#ref`: the shown one, except that an SSH address keeps its login (`git@`):
 * SSH signs in with a key, so that user name is never a secret, while any other
 * may be a token.
 */
export function recordedAddress(source: ResolvedRepoSource): string {
	if (source.kind === "local") return source.cloneArg;
	try {
		return new URL(source.cloneArg).protocol === "ssh:" ? source.cloneArg : source.display;
	} catch {
		return source.cloneArg; // `git@host:user/repo`
	}
}

/** A stored repository address as the app shows it: without the login an SSH address keeps. */
export function shownRepositoryAddress(address: string): string {
	try {
		return shownAddress(new URL(address), address);
	} catch {
		return address;
	}
}

/**
 * A password in the address would be kept as the skill's source, shown in the app
 * and written into its provenance file, so it is refused: the sign-in git already
 * stores is the way in. An address with only a user name stays allowed.
 */
const PASSWORD_IN_ADDRESS = "This address contains a password. Sign in with git once instead, then import again.";

/**
 * The address as the app shows it and the skill's provenance keeps it. A user name
 * can be a token (GitHub accepts one there), so it is left out; the clone itself
 * keeps the address as typed.
 */
function shownAddress(parsed: URL, cloneArg: string): string {
	if (!parsed.username) return cloneArg;
	const shown = new URL(parsed.href);
	shown.username = "";
	shown.password = "";
	return shown.href;
}

function addressHasPassword(cloneArg: string): boolean {
	try {
		return new URL(cloneArg).password !== "";
	} catch {
		return false;
	}
}

function finishLocal(localPath: string, allowLocal?: boolean): { ok: true; value: ResolvedRepoSource } | { ok: false; error: string } {
	if (!allowLocal) return { ok: false, error: "local repository paths are not permitted" };
	if (localPath.startsWith("-")) return { ok: false, error: "invalid local path" };
	if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) return { ok: false, error: "local path is not a directory" };
	return { ok: true, value: { kind: "local", cloneArg: localPath, display: localPath } };
}

// --- Shallow clone -----------------------------------------------------------

const CLONE_TIMEOUT_MS = 90_000;
const CONFIG_READ_TIMEOUT_MS = 5_000;

/** What a check or a fetch that the person didn't press for leaves out. */
export interface RepoAskOptions {
	/** False keeps a Mac's install window for Apple's tools shut. */
	askForDeveloperTools?: boolean;
	/**
	 * False uses no sign-in of the person's: no credential helper and no SSH key
	 * or agent, since any of them may open a window or wait for a touch that git
	 * can't be told to skip. A repository that needs one fails as "sign-in". What
	 * git sends without asking anyone (a ~/.netrc, a header in the git config) stays.
	 */
	signIns?: boolean;
}

// Hardened environment: no credential prompts, no system config, no hooks or
// templates, transports allow-listed (file: included for local smoke repos).
// Hooks are never fetched from a remote, but a poisoned template dir is closed
// off too, belt-and-braces.
// Without the person's sign-ins ssh is no transport either, so a rewrite of the
// address in their git config can't bring it back.
function hardenedGitEnv(options: RepoAskOptions = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TEMPLATE_DIR: "",
		GIT_ALLOW_PROTOCOL: options.signIns === false ? "https:http:git:file" : "https:http:ssh:git:file",
		GCM_INTERACTIVE: "never",
		// A clone's commit is read from its ref files (cloneOrigin): keep them files, whatever git's default.
		GIT_DEFAULT_REF_FORMAT: "files",
	};
}

/**
 * Kill a git child together with everything it started. git hands the transfer
 * to `git-remote-http` and the sign-in to a credential helper; killing only the
 * parent leaves those holding the output pipes, so a helper that waits (a
 * keychain dialog nobody answers) would outlast the timeout.
 */
function killProcessTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).once("error", () => {});
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

// What a person reads when this machine cannot run git at all, in place of
// "spawn git ENOENT": which tool is missing, where to get it, and no command
// to type. Git for Windows is found in its install folder even when the app
// was opened before the install changed PATH, so "try again" is enough there.
export function gitMissingMessage(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") {
		return "Importing skills from a repository needs Git, which isn't installed on this computer. Install Git for Windows from gitforwindows.org, then try again. If it still says this, restart exxperts.";
	}
	return "Importing skills from a repository needs Git, which isn't installed on this computer. Install it with your system's software manager, then try again.";
}

// A Mac without Apple's command line tools has /usr/bin/git, but only as a
// stand-in that fails with xcode-select's text. The app then asks macOS for
// its install window itself (below), so the sentence's promise holds however
// git was started.
export const MAC_DEVELOPER_TOOLS_MISSING = "Importing skills from a repository needs Apple's command line tools, which this Mac doesn't have yet. macOS has just offered to install them in a separate window. Install them (it takes a few minutes), then try again.";

/** One of the two sentences above: the machine lacks a tool, the repository is fine. */
export function isMissingToolMessage(message: string): boolean {
	return message === MAC_DEVELOPER_TOOLS_MISSING || message === gitMissingMessage();
}

// Asking for the install opens Apple's own window, where the person decides;
// nothing installs by itself. Once per few minutes, so the featured sources,
// which fail together, open one window between them. The command can be named
// for a test, which must never open the real window.
let lastDeveloperToolsRequest = 0;
export function requestMacDeveloperToolsInstall(now = Date.now()): void {
	if (now - lastDeveloperToolsRequest < 5 * 60_000) return;
	lastDeveloperToolsRequest = now;
	const command = process.env.EXXPERTS_DEVTOOLS_INSTALL_COMMAND?.trim() || "/usr/bin/xcode-select";
	try {
		spawn(command, ["--install"], { stdio: "ignore", detached: true }).once("error", () => {}).unref();
	} catch {}
}

// Only the stand-in's own first words count: a line a server sends back
// arrives as "remote: ..." and must not be taken for this Mac's state.
export function isMacDeveloperToolsStub(stderr: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "darwin" && /^xcode-select: note: No developer tools were found/im.test(stderr);
}

/**
 * The git to run: "git" from PATH, else on Windows the standard install
 * folders, where Git for Windows lands even when the running app's PATH
 * predates the install (an app keeps the PATH it was started with).
 */
export function resolveGitCommand(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
	if (platform !== "win32") return "git";
	const pathValue = env.PATH ?? env.Path ?? "";
	const onPath = pathValue.split(";").some((dir) => dir.trim() && exists(path.win32.join(dir.trim(), "git.exe")));
	if (onPath) return "git";
	const candidates = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs")]
		.filter((root): root is string => Boolean(root))
		.map((root) => path.win32.join(root, "Git", "cmd", "git.exe"));
	return candidates.find((candidate) => exists(candidate)) ?? "git";
}

/** How much of a git command's output is kept by default; an answer that reaches its bound may be cut. */
const RUN_GIT_STDOUT_MAX = 262_144;
/** The bound for git's list of a checkout's files: far past what a repository within the scan's 20,000 files lists. */
const LS_FILES_STDOUT_MAX = 32 * 1024 * 1024;

/** Runs git and answers its exit code and output; a git that is missing, can't start or runs past `timeoutMs` rejects as a `RepoReachFailure` naming why. */
function runGit(args: string[], what: string, timeoutMs: number, env: NodeJS.ProcessEnv, cwd?: string, stdoutMax = RUN_GIT_STDOUT_MAX): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		// A missing git is a missing tool, not a broken repository: say so in
		// words, and keep the system's own text for whoever reads the log.
		const missing = (err: unknown) => {
			if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return new RepoReachFailure("failed", err instanceof Error ? err.message : String(err), { cause: err });
			console.warn(`[skills] git is not available: ${(err as Error).message}`);
			return new RepoReachFailure("missing-tool", gitMissingMessage(), { cause: err });
		};
		try {
			// Its own process group off Windows, so the timeout can end the whole tree.
			child = spawn(resolveGitCommand(), args, { stdio: ["ignore", "pipe", "pipe"], env, cwd, detached: process.platform !== "win32" });
		} catch (err) {
			reject(missing(err));
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(child);
			// On Windows a helper that Git for Windows started through its own shell
			// can fall outside the tree taskkill sees and keep the output pipes open.
			// Let go of them, so the call ends once git itself has gone.
			child.stdout?.destroy();
			child.stderr?.destroy();
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => {
			if (stdout.length < stdoutMax) stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			if (stderr.length < 8192) stderr += String(chunk);
		});
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(missing(err));
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new RepoReachFailure("timeout", `git ${what} timed out after ${timeoutMs}ms`));
				return;
			}
			resolve({ code: code ?? -1, stdout, stderr: stderr.trim() });
		});
	});
}

// --- Stored sign-ins ---------------------------------------------------------
//
// A private repo authenticates through the sign-in git already holds for its
// host, the one a `git clone` in a terminal would use. The hardened clone shuts
// the system config out, and that is where git installs register the credential
// helper (osxkeychain, manager, libsecret; Apple's own git keeps osxkeychain in
// a file of its own that git lists with the scope "unknown"), so the helpers are
// resolved here the way git itself resolves them and handed to the clone
// explicitly. Three rules:
//
//   - read only: a helper is asked for a sign-in (`get`) and never told to
//     `store` or `erase` one, so an import cannot write a sign-in into the
//     person's credential store or delete one the host turned down;
//   - encrypted transport only: helpers answer for https, and for http on this
//     machine's own loopback (nothing leaves it; the smoke's test server);
//   - nothing else of the system config comes along.

/**
 * The scopes whose helpers a `git clone` in a terminal would use, outside any
 * repository: the system file, Apple git's own file ("unknown") and the person's
 * global file. Never a repository's, a worktree's or the command line's.
 */
const SIGN_IN_SCOPES = new Set(["system", "unknown", "global"]);

/**
 * git's whole config as ONE scoped listing (`scope NUL key LF value NUL`), in
 * git's own order, includes followed. Run in an empty folder, so no repository's
 * config joins; the environment is the person's own, so a git that ignores the
 * system file in their terminal ignores it here too. Empty when unreadable.
 */
async function readGitConfigListing(): Promise<string> {
	let cwd: string | undefined;
	try {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-git-config-"));
		const res = await runGit(["config", "--list", "--show-scope", "--includes", "--null"], "config", CONFIG_READ_TIMEOUT_MS, { ...process.env, GIT_TERMINAL_PROMPT: "0" }, cwd);
		return res.code === 0 ? res.stdout : "";
	} catch {
		return "";
	} finally {
		if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
	}
}

/** Does a `credential.<pattern>.*` section apply to this remote? Scheme and host must agree; a user or path in the pattern must too. */
function credentialSectionApplies(pattern: string, remote: URL): boolean {
	let wanted: URL;
	try {
		wanted = new URL(pattern);
	} catch {
		return false;
	}
	if (wanted.protocol !== remote.protocol || wanted.host !== remote.host) return false;
	if (wanted.username && wanted.username !== remote.username) return false;
	const wantedPath = wanted.pathname.replace(/^\/+|\/+$/g, "");
	if (!wantedPath) return true;
	const remotePath = remote.pathname.replace(/^\/+|\/+$/g, "");
	return remotePath === wantedPath || remotePath.startsWith(`${wantedPath}/`);
}

/** A helper as git would run it, answering `get` only: `store` and `erase` end before they reach it. */
function readOnlyHelper(helper: string): string {
	// git's own three forms: `!shell snippet`, an absolute path, or the short name of a `git credential-<name>`.
	const command = helper.startsWith("!") ? helper.slice(1) : path.isAbsolute(helper) ? helper : `git credential-${helper}`;
	return `!f() { test "$1" = get || return 0; ${command} get; }; f`;
}

/** The remote a stored sign-in may be used for, or null: https, or http on this machine's loopback. */
function signInRemote(cloneArg: string): URL | null {
	let remote: URL;
	try {
		remote = new URL(cloneArg);
	} catch {
		return null; // scp-style `git@host:user/repo`: ssh, no credential helper involved
	}
	if (remote.protocol === "https:") return remote;
	const loopback = remote.hostname === "localhost" || remote.hostname === "127.0.0.1" || remote.hostname === "[::1]";
	return remote.protocol === "http:" && loopback ? remote : null;
}

/**
 * The `-c credential.*` args of a clone, from a scoped config listing. They
 * always begin by clearing the helper list, so no helper reaches the clone in its
 * writing form; then, for a remote a stored sign-in may be used for, come the
 * helpers of the sign-in scopes in git's own order (an empty `helper =` resets
 * what came before it), each read-only.
 */
export function signInArgsFromConfigListing(listing: string, cloneArg: string): string[] {
	const args = ["-c", "credential.helper="];
	const remote = signInRemote(cloneArg);
	if (!remote) return args;
	const fields = listing.split("\0");
	let helpers: string[] = [];
	const settings = new Map<string, string>();
	for (let i = 0; i + 1 < fields.length; i += 2) {
		if (!SIGN_IN_SCOPES.has(fields[i])) continue;
		// `key\nvalue`; a key written without `=` has no value part at all.
		const at = fields[i + 1].indexOf("\n");
		const key = at < 0 ? fields[i + 1] : fields[i + 1].slice(0, at);
		const value = at < 0 ? undefined : fields[i + 1].slice(at + 1);
		const parts = key.match(/^credential\.(?:(.+)\.)?([^.]+)$/);
		if (!parts || (parts[1] !== undefined && !credentialSectionApplies(parts[1], remote))) continue;
		if (parts[2] === "helper") helpers = value ? [...helpers, value] : [];
		else if (parts[2] === "usehttppath" || parts[2] === "username") settings.set(parts[2], value ?? "true");
	}
	for (const helper of helpers) args.push("-c", `credential.helper=${readOnlyHelper(helper)}`);
	for (const [name, value] of settings) args.push("-c", `credential.${name}=${value}`);
	return args;
}

/**
 * The `-c credential.*` args of a clone, read fresh on every clone, so a sign-in
 * made after a failed attempt counts on the retry. Never throws.
 */
export async function storedSignInArgs(cloneArg: string, options: RepoAskOptions = {}): Promise<string[]> {
	if (options.signIns === false || !signInRemote(cloneArg)) return ["-c", "credential.helper="];
	return signInArgsFromConfigListing(await readGitConfigListing(), cloneArg);
}

/** The source is reached over SSH: an `ssh://` address, or `git@host:user/repo`. */
function reachedOverSsh(source: ResolvedRepoSource): boolean {
	if (source.kind !== "git") return false;
	try {
		return new URL(source.cloneArg).protocol === "ssh:";
	} catch {
		return true;
	}
}

/** git's answer when `GIT_ALLOW_PROTOCOL` leaves out the ssh that the person's own config sends an address to. */
const SSH_NOT_ALLOWED_STDERR = /transport 'ssh' not allowed/i;

/** The failure of a repository that only answers a sign-in, asked without the person's (`signIns: false`); null for any other answer. */
function signInNotUsed(source: ResolvedRepoSource, options: RepoAskOptions, stderr?: string): RepoReachFailure | null {
	if (options.signIns !== false || !(stderr === undefined ? reachedOverSsh(source) : SSH_NOT_ALLOWED_STDERR.test(stderr))) return null;
	return new RepoReachFailure("sign-in", "this repository is reached over SSH, which this check doesn't use");
}

/** What to do about a sign-in failure, by what the host answered; null when the failure is something else. */
function signInAdvice(stderr: string, host: string): string | null {
	if (/Permission denied \(publickey/i.test(stderr)) {
		return `${host} did not accept your SSH key. Add the key to your account there, or use the repository's https address.`;
	}
	if (/Authentication failed|HTTP Basic: Access denied/i.test(stderr)) {
		return `${host} turned down the sign-in git has stored for it; it may have expired. Sign in to ${host} again with git in a terminal, then retry.`;
	}
	if (/returned error: 403/i.test(stderr)) {
		return `${host} refused access to this repository. Your sign-in there may not include it, or an access token may lack the right to read repositories.`;
	}
	if (/could not read (?:Username|Password)|terminal prompts disabled/i.test(stderr)) {
		return `This computer has no sign-in for ${host}, or the address is wrong. Sign in there with git in a terminal, then try again.`;
	}
	return null;
}

/**
 * Turn git's sign-in failure into words that say what to do; other failures pass
 * through. Any user name or password in an address is taken out first: newer git
 * hides them itself, older git prints the address as typed, and `remote:` lines
 * are the server's own text.
 */
export function describeCloneFailure(rawStderr: string, source: ResolvedRepoSource): string {
	const stderr = rawStderr.replace(/:\/\/[^/@\s]+@/g, "://");
	const advice = source.kind === "git" && source.host ? signInAdvice(stderr, source.host) : null;
	return advice ? `${advice} (${stderr})` : stderr;
}

/**
 * The options every git command that fetches a repository's files runs with, in
 * one place: the stored sign-in, read-only; no hooks; no `ext::` transport, and
 * `file:` only as typed by the person; and no symlinks made.
 */
async function hardenedFetchArgs(source: ResolvedRepoSource, options: RepoAskOptions): Promise<string[]> {
	return [
		...(source.kind === "git" ? await storedSignInArgs(source.cloneArg, options) : []),
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"protocol.ext.allow=never",
		"-c",
		"protocol.file.allow=user",
		"-c",
		// Do not materialize symlinks — a committed symlink could otherwise point
		// SKILL.md (or a vendored file) at an out-of-checkout path and turn import
		// into an arbitrary local-file read.
		"core.symlinks=false",
	];
}

/** A full commit id after `#`: fetched by id, since `clone --branch` takes only a branch or a tag. */
function isFullCommitId(ref: string | undefined): ref is string {
	return ref !== undefined && COMMIT_RE.test(ref.toLowerCase());
}

/**
 * The git commands that fill an empty folder with one version of a source, each
 * run in that folder. A full commit id is fetched by id into a new repository
 * (git's protocol v2 lets a client ask for any commit); anything else is a
 * shallow clone of its branch or tag. Depth 1, no tags, submodules NOT recursed.
 * `--` ends the options: neither the repo arg nor the target can be read as a
 * git flag even if it somehow began with "-".
 */
function fetchCommands(source: ResolvedRepoSource, dir: string): Array<{ what: string; args: string[] }> {
	if (isFullCommitId(source.ref)) {
		return [
			{ what: "init", args: ["init", "-q"] },
			{ what: "fetch", args: ["fetch", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", source.cloneArg, source.ref] },
			{ what: "checkout", args: ["checkout", "-q", "--detach", "FETCH_HEAD"] },
		];
	}
	return [{ what: "clone", args: ["clone", "--depth", "1", "--no-tags", "--single-branch", "--no-recurse-submodules", ...(source.ref ? ["--branch", source.ref] : []), "--", source.cloneArg, dir] }];
}

/** git's answer when the branch, tag or commit asked for is not in the repository. */
const REF_MISSING_STDERR = /Remote branch .+ not found|couldn't find remote ref|not our ref|no such remote ref/i;

/**
 * Why git could not fetch a source, as a `RepoReachFailure`: a sign-in carries
 * only its advice, every other reason git's own text, which only the server's
 * log shows (the person reads one plain sentence per reason).
 */
function gitFetchFailure(stderr: string, code: number, what: string, source: ResolvedRepoSource): RepoReachFailure {
	const message = describeCloneFailure(stderr, source) || `git ${what} exited with code ${code}`;
	console.warn(`[skills] git ${what} of ${source.display} failed: ${message}`);
	const advice = source.kind === "git" && source.host ? signInAdvice(stderr, source.host) : null;
	if (advice) return new RepoReachFailure("sign-in", advice);
	return reachFailure(stderr, message, source) ?? new RepoReachFailure(REF_MISSING_STDERR.test(stderr) ? "ref-missing" : "failed", message);
}

/**
 * With `core.symlinks=false` git writes a committed link as a plain file holding
 * its target's path, which would come in as one of the skill's files. git's own
 * list of what it checked out names each link (mode 120000); those files are
 * removed, as GitHub's zip leaves its links out (`unpackArchive`). A list that
 * can't be read fails the fetch: a link is never taken for a file.
 */
async function dropCommittedLinks(dir: string, hardening: string[], timeoutMs: number): Promise<void> {
	const listed = await runGit([...hardening, "ls-files", "--stage", "-z"], "ls-files", timeoutMs, hardenedGitEnv(), dir, LS_FILES_STDOUT_MAX);
	if (listed.code !== 0) throw new RepoReachFailure("failed", `git ls-files exited with code ${listed.code}: ${listed.stderr}`);
	if (listed.stdout.length >= LS_FILES_STDOUT_MAX) throw new RepoReachFailure("failed", "git's list of the checkout's files is too long to read");
	const root = path.resolve(dir);
	for (const entry of listed.stdout.split("\0")) {
		const tab = entry.indexOf("\t");
		if (tab < 0 || !entry.startsWith("120000 ")) continue;
		const file = path.resolve(root, entry.slice(tab + 1));
		if (!file.startsWith(root + path.sep)) continue;
		fs.rmSync(file, { force: true });
	}
}

/**
 * Fetch a validated source into a fresh temp directory and return its path
 * (`fetchCommands`), hooks and templates neutralized. On any failure the temp
 * dir is removed and a `RepoReachFailure` is thrown. `askForDeveloperTools:
 * false` keeps a Mac's install window shut when git is only a fallback that a
 * missing tool does not explain.
 */
export async function cloneRepoShallow(source: ResolvedRepoSource, timeoutMs = CLONE_TIMEOUT_MS, options: RepoAskOptions = {}): Promise<string> {
	if (source.kind === "git" && addressHasPassword(source.cloneArg)) throw new RepoReachFailure("failed", PASSWORD_IN_ADDRESS);
	const unused = signInNotUsed(source, options);
	if (unused) throw unused;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skill-repo-"));
	try {
		const hardening = await hardenedFetchArgs(source, options);
		for (const { what, args } of fetchCommands(source, dir)) {
			const result = await runGit([...hardening, ...args], what, timeoutMs, hardenedGitEnv(options), dir);
			if (result.code !== 0 && isMacDeveloperToolsStub(result.stderr)) {
				console.warn("[skills] git is Apple's stand-in: the command line tools are not installed");
				if (options.askForDeveloperTools !== false) requestMacDeveloperToolsInstall();
				throw new RepoReachFailure("missing-tool", MAC_DEVELOPER_TOOLS_MISSING);
			}
			if (result.code !== 0) throw signInNotUsed(source, options, result.stderr) ?? gitFetchFailure(result.stderr, result.code, what, source);
		}
		await dropCommittedLinks(dir, hardening, timeoutMs);
		return dir;
	} catch (err) {
		// Best effort: such a leftover helper can still hold the folder on Windows,
		// and the person should see why the import failed, not the cleanup.
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		throw err instanceof Error ? err : new Error(String(err));
	}
}

// --- GitHub archive ----------------------------------------------------------
//
// A public GitHub repository needs no git: GitHub serves every branch and tag
// as a zip, so the featured directory and most imports work on a computer with
// nothing installed (Windows has no git, and a fresh Mac has only Apple's
// stand-in). The zip is read, never run, like a clone. Private repositories
// (GitHub answers 404 without a sign-in), other hosts and SSH addresses stay
// with git, which knows the person's stored sign-in.

const ARCHIVE_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const ARCHIVE_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const ARCHIVE_MAX_REDIRECTS = 3;
// GitHub answers in well under a second. A network where only a proxy reaches
// the internet (which git honours and this download does not) must not eat
// git's time, so the download gets this long to start.
const ARCHIVE_ANSWER_TIMEOUT_MS = 15_000;

/** Why a download failed: git may sign in, the repository is too big, GitHub could not be reached or didn't answer in time, or anything else. */
type ArchiveFailureKind = "not-found" | "too-large" | "unreachable" | "timed-out" | "failed";

class ArchiveFailure extends Error {
	constructor(readonly kind: ArchiveFailureKind, message: string, options?: { cause?: unknown }) {
		super(message, options);
	}
}

/**
 * The zip address of a public GitHub source, or null when git must fetch it.
 * Only `https://github.com/owner/repo` (optionally `.git`, a trailing slash, a
 * `#branch` or `#tag`) qualifies: an SSH address or a user name in it is a
 * deliberate sign-in, and any other shape is left to git to accept or refuse.
 * The base can be pointed at a stand-in on this machine for a test, never
 * anywhere else.
 */
export function githubArchiveUrl(source: ResolvedRepoSource, base = archiveBase()): string | null {
	const repo = githubRepoUrl(source, base);
	if (!repo) return null;
	return `${repo}/archive/${(source.ref ?? "HEAD").split("/").map(encodeURIComponent).join("/")}.zip`;
}

/** `<base>/<owner>/<repo>` of a source `githubArchiveUrl` takes, or null. */
function githubRepoUrl(source: ResolvedRepoSource, base: string): string | null {
	if (source.kind !== "git") return null;
	let parsed: URL;
	try {
		parsed = new URL(source.cloneArg);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.port || parsed.username || parsed.search || parsed.hash) return null;
	const repo = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
	const ref = (source.ref ?? "HEAD").split("/");
	if (repo.length !== 2 || [...repo, ...ref].some((segment) => !segment || segment === "." || segment === "..")) return null;
	return `${base.replace(/\/+$/, "")}/${repo.map(encodeURIComponent).join("/")}`;
}

function archiveBase(): string {
	const override = process.env.EXXPERTS_GITHUB_ARCHIVE_BASE?.trim();
	try {
		if (override && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(override).hostname)) return override;
	} catch {}
	return "https://github.com";
}

/** A download that ran past its time, or that couldn't reach GitHub at all. */
function notAnswered(err: unknown): ArchiveFailure {
	if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return new ArchiveFailure("timed-out", "GitHub did not answer in time", { cause: err });
	const cause = (err as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
	const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : err instanceof Error ? err.message : String(err);
	return new ArchiveFailure("unreachable", `GitHub could not be reached (${detail})`, { cause: err });
}

/** Download the zip, following GitHub's own redirects only, capped in size. */
async function downloadArchive(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
	const answered = new AbortController();
	const answerTimer = setTimeout(() => answered.abort(new DOMException("GitHub did not answer", "TimeoutError")), Math.min(timeoutMs, ARCHIVE_ANSWER_TIMEOUT_MS));
	const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), answered.signal]);
	try {
		return await downloadFollowing(url, signal, maxBytes, () => clearTimeout(answerTimer));
	} finally {
		clearTimeout(answerTimer);
	}
}

async function downloadFollowing(url: string, signal: AbortSignal, maxBytes: number, onAnswer: () => void): Promise<Buffer> {
	const start = new URL(url);
	let current = start;
	for (let hop = 0; ; hop++) {
		let res: Response;
		try {
			res = await fetch(current, { redirect: "manual", signal, headers: { "user-agent": "exxperts" } });
		} catch (err) {
			throw notAnswered(err);
		}
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			const next = location ? new URL(location, current) : null;
			const github = next && ((next.protocol === start.protocol && next.host === start.host) || (next.protocol === "https:" && next.host === "codeload.github.com"));
			if (!next || !github || hop >= ARCHIVE_MAX_REDIRECTS) throw new ArchiveFailure("failed", "GitHub sent the download to an unexpected address");
			await res.body?.cancel().catch(() => {});
			current = next;
			continue;
		}
		if (res.status === 404 || res.status === 401 || res.status === 403) throw new ArchiveFailure("not-found", `GitHub has no public download at this address (${res.status})`);
		if (!res.ok || !res.body) throw new ArchiveFailure("failed", `GitHub answered ${res.status}`);
		onAnswer();
		if (Number(res.headers.get("content-length")) > maxBytes) throw new ArchiveFailure("too-large", "the repository is too large to download as a zip");
		const chunks: Buffer[] = [];
		let total = 0;
		try {
			for await (const chunk of res.body) {
				total += chunk.byteLength;
				if (total > maxBytes) throw new ArchiveFailure("too-large", "the repository is too large to download as a zip");
				chunks.push(Buffer.from(chunk));
			}
		} catch (err) {
			if (err instanceof ArchiveFailure) throw err;
			throw notAnswered(err);
		}
		return Buffer.concat(chunks);
	}
}

/** One entry's bytes, aborted the moment they pass the cap (a zip bomb never unpacks). */
function readEntryCapped(entry: JSZip.JSZipObject, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let aborted = false;
		const stream = entry.nodeStream();
		stream.on("data", (chunk: Buffer | string) => {
			if (aborted) return;
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf-8");
			total += buf.length;
			if (total > maxBytes) {
				aborted = true;
				reject(new ArchiveFailure("too-large", "the repository is too large to unpack"));
				(stream as unknown as { destroy?: () => void }).destroy?.();
				return;
			}
			chunks.push(buf);
		});
		stream.on("error", (err: Error) => {
			if (!aborted) reject(err);
		});
		stream.on("end", () => {
			if (!aborted) resolve(Buffer.concat(chunks));
		});
	});
}

/**
 * Unpack GitHub's zip into `dir` as plain files, dropping the one folder GitHub
 * wraps everything in, and return the commit it holds: GitHub writes it as the
 * zip's comment. Like the clone (`core.symlinks=false`), no symlink is made; a
 * name that could leave the folder, or that a file system or the skill digest
 * would misread, is skipped.
 */
async function unpackArchive(buffer: Buffer, dir: string, maxBytes: number): Promise<string> {
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(buffer);
	} catch (err) {
		throw new ArchiveFailure("failed", "GitHub's download was not a readable zip", { cause: err });
	}
	const commit = String((zip as JSZip & { comment?: unknown }).comment ?? "").trim().toLowerCase();
	if (!COMMIT_RE.test(commit)) throw new ArchiveFailure("failed", "GitHub's download did not say which commit it holds");
	const entries = Object.values(zip.files).filter((entry) => !entry.dir);
	if (entries.length > WALK_MAX_FILES) throw new ArchiveFailure("too-large", "the repository has too many files to unpack");
	const root = path.resolve(dir);
	let remaining = maxBytes;
	for (const entry of entries) {
		const rel = entry.name.slice(entry.name.indexOf("/") + 1);
		const segments = rel.split("/");
		if (!rel || entry.name.indexOf("/") < 0 || rel.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) continue;
		// Stricter than a clone on purpose: names Windows reserves for devices
		// or silently trims, and names the skill digest or a file system would
		// misread, are left out; no skill needs one.
		if (/[\p{Cc}\p{Cf}:]/u.test(rel) || segments.some((segment) => /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(segment) || /[. ]$/.test(segment))) continue;
		if (((Number(entry.unixPermissions) || 0) & 0o170000) === 0o120000) continue;
		const dest = path.join(root, ...segments);
		if (!dest.startsWith(root + path.sep)) continue;
		let bytes: Buffer;
		try {
			bytes = await readEntryCapped(entry, remaining);
		} catch (err) {
			if (err instanceof ArchiveFailure) throw err;
			throw new ArchiveFailure("failed", "GitHub's download was not a readable zip", { cause: err });
		}
		remaining -= bytes.length;
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, bytes, { mode: keptFileMode(segments.join("/"), Number(entry.unixPermissions) || 0, bytes.subarray(0, SCRIPT_HEAD_BYTES)) });
	}
	return commit;
}

/** A full commit id: SHA-1, or SHA-256 for a repository that uses it. */
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Which version of a repository a checkout holds, as a skill's record keeps it. */
export interface RepoOrigin {
	address: string;
	ref?: string;
	refKind: SkillRefKind;
	commit: string;
}

/** A checkout, and the version it holds when that could be told: without it a skill is still added, only not kept up to date. */
export interface RepoCheckout {
	dir: string;
	origin?: RepoOrigin;
}

function originOf(source: ResolvedRepoSource, refKind: SkillRefKind, commit: string): RepoOrigin {
	return { address: recordedAddress(source), ...(source.ref ? { ref: source.ref } : {}), refKind, commit };
}

/**
 * The version a clone holds, read from its own files (no git is run): the commit
 * of HEAD, and how its ref moves. `--branch` with a branch leaves HEAD on that
 * branch; with a tag, HEAD holds the tag's commit itself; a commit fetched by its
 * full id is that commit.
 */
function cloneOrigin(dir: string, source: ResolvedRepoSource): RepoOrigin {
	const gitDir = path.join(dir, ".git");
	const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim();
	const symbolic = head.match(/^ref: (refs\/heads\/\S+)$/);
	let commit = symbolic ? null : head.toLowerCase();
	if (symbolic) {
		const loose = path.join(gitDir, ...symbolic[1].split("/"));
		if (fs.existsSync(loose)) commit = fs.readFileSync(loose, "utf-8").trim().toLowerCase();
		else {
			const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf-8").split("\n").map((line) => line.trim().split(" "));
			commit = packed.find((fields) => fields[1] === symbolic[1])?.[0]?.toLowerCase() ?? null;
		}
	}
	if (!commit || !COMMIT_RE.test(commit)) throw new Error("could not tell which commit of the repository was fetched");
	return originOf(source, !source.ref ? "default" : symbolic ? "branch" : isFullCommitId(source.ref) ? "commit" : "tag", commit);
}

/** A shallow clone (`cloneRepoShallow`) with the version it holds, when its files tell it (an empty repository's do not). */
async function cloneCheckout(source: ResolvedRepoSource, timeoutMs: number, options: RepoAskOptions = {}): Promise<RepoCheckout> {
	const dir = await cloneRepoShallow(source, timeoutMs, options);
	try {
		return { dir, origin: cloneOrigin(dir, source) };
	} catch (err) {
		console.warn(`[skills] could not tell which version of ${source.display} was fetched: ${err instanceof Error ? err.message : String(err)}`);
		return { dir };
	}
}

/**
 * A checkout of the source to scan: GitHub's zip for a public GitHub address,
 * else a shallow git clone. When the zip fails, git tries: a private
 * repository needs its sign-in, and a very big one is git's job. When GitHub
 * could not be reached, git may still get through (it uses the system's proxy
 * and certificates), but if git is missing too, the reason shown is GitHub's,
 * and a Mac is not asked to install tools that would not have helped.
 */
export async function fetchRepoCheckout(source: ResolvedRepoSource, timeoutMs = CLONE_TIMEOUT_MS, limits: { downloadBytes?: number; unpackedBytes?: number } = {}, options: RepoAskOptions = {}): Promise<RepoCheckout> {
	const url = githubArchiveUrl(source);
	if (!url) return cloneCheckout(source, timeoutMs, options);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skill-repo-"));
	let failure: ArchiveFailure;
	try {
		const commit = await unpackArchive(await downloadArchive(url, timeoutMs, limits.downloadBytes ?? ARCHIVE_MAX_DOWNLOAD_BYTES), dir, limits.unpackedBytes ?? ARCHIVE_MAX_UNPACKED_BYTES);
		// The zip is good whatever GitHub says of its ref: a kind that can't be told only leaves the skill without updates.
		const refKind = await archiveRefKind(source, commit).catch((err: unknown) => {
			console.warn(`[skills] could not tell what ${source.display}'s ref is: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		});
		return { dir, ...(refKind ? { origin: originOf(source, refKind, commit) } : {}) };
	} catch (err) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		failure = err instanceof ArchiveFailure ? err : new ArchiveFailure("failed", err instanceof Error ? err.message : String(err), { cause: err });
	}
	console.warn(`[skills] GitHub's zip of ${source.display} failed (${failure.message}); trying git`);
	return withGitAfterGitHub(failure, (fallback) => cloneCheckout(source, timeoutMs, fallback ? { ...options, askForDeveloperTools: false } : options));
}

/**
 * git's turn after GitHub's own answer failed. A private repository (GitHub's
 * 404) or one too big for a zip is git's job, so git's failure is the one shown.
 * When GitHub could not be reached or answered something else, git may still get
 * through; if git is missing too, GitHub's reason is shown, and a Mac is not asked
 * to install tools that would not have helped.
 */
async function withGitAfterGitHub<T>(failure: ArchiveFailure, run: (fallback: boolean) => Promise<T>): Promise<T> {
	if (failure.kind === "not-found" || failure.kind === "too-large") return run(false);
	try {
		return await run(true);
	} catch (err) {
		if (err instanceof Error && isMissingToolMessage(err.message)) throw new RepoReachFailure(failure.kind === "unreachable" ? "offline" : failure.kind === "timed-out" ? "timeout" : "failed", failure.message, { cause: err });
		throw err;
	}
}

/**
 * How the ref of a GitHub zip moves: none is the default branch; a ref the
 * commit begins with is that commit; else GitHub's own list of branches and tags
 * says which it is.
 */
async function archiveRefKind(source: ResolvedRepoSource, commit: string): Promise<SkillRefKind> {
	if (!source.ref) return "default";
	if (/^[0-9a-f]{7,64}$/i.test(source.ref) && commit.startsWith(source.ref.toLowerCase())) return "commit";
	const refs = await githubRefs(source);
	if (refs.refs.has(`refs/heads/${source.ref}`)) return "branch";
	if (refs.refs.has(`refs/tags/${source.ref}`)) return "tag";
	throw new ArchiveFailure("failed", "GitHub does not list this branch or tag");
}

// --- A repository's refs -----------------------------------------------------
//
// Whether a skill's repository has moved is asked of its refs alone, which is a
// small answer, before anything is fetched: `git ls-remote`, or for a public
// GitHub repository GitHub's own list, so no git is needed there either.

/** A repository's refs: each ref's commit (a tag's peeled commit when it has one), and HEAD's. */
export interface RemoteRefs {
	head: string | null;
	refs: Map<string, string>;
}

/**
 * Why a repository could not be reached: the network, a server that was found
 * but didn't take the connection on its port, no answer in time, a sign-in, a
 * tool this machine lacks, a branch, tag or commit it doesn't have, or anything else.
 */
export type RepoReachReason = "offline" | "connect-failed" | "timeout" | "sign-in" | "missing-tool" | "ref-missing" | "failed";

export class RepoReachFailure extends Error {
	/** The host git was sent to, without a login: named when the server didn't take the connection. */
	readonly host?: string;
	constructor(readonly reason: RepoReachReason, message: string, options?: { cause?: unknown; host?: string }) {
		super(message, options);
		if (options?.host) this.host = options.host;
	}
}

/** Any failure to fetch a source as a reason and the message behind it (the server's log keeps the message; the person reads `repositoryFailedLine`). */
export function repoFailureOf(err: unknown): { reason: RepoReachReason; message: string; host?: string } {
	const message = err instanceof Error ? err.message : String(err);
	if (!(err instanceof RepoReachFailure)) return { reason: "failed", message };
	return { reason: err.reason, message, ...(err.host ? { host: err.host } : {}) };
}

const LS_REMOTE_TIMEOUT_MS = 30_000;
const REFS_MAX_BYTES = 1024 * 1024;
const OFFLINE_STDERR = /Could not resolve host|Failed to connect|Couldn't connect|Could not connect|Connection refused|Connection timed out|Operation timed out|Network is unreachable|No route to host/i;
/**
 * ssh's own lines for a server it found by name that didn't take the connection:
 * nothing answered on its port, it refused it, or it cut the handshake (a server
 * reached outside a company's VPN often does). OpenSSH words them the same on a
 * Mac, Linux and Git for Windows; a name it can't resolve or a network it can't
 * reach stays offline.
 */
const SSH_CONNECT_FAILED_STDERR = /ssh: connect to host \S+ port \d+: (?:Connection refused|Operation timed out|Connection timed out)|kex_exchange_identification|Connection reset by \S+ port \d+/i;

/** A failure to reach the source's server, by git's text, or null when the text says something else. */
function reachFailure(stderr: string, message: string, source: ResolvedRepoSource): RepoReachFailure | null {
	if (SSH_CONNECT_FAILED_STDERR.test(stderr) && source.kind === "git" && source.host) return new RepoReachFailure("connect-failed", message, { host: source.host });
	return OFFLINE_STDERR.test(stderr) ? new RepoReachFailure("offline", message) : null;
}

/** The commit a skill's ref points at in `refs`, or null when the ref is gone. A commit never moves. */
export function refCommit(refs: RemoteRefs, refKind: SkillRefKind, ref: string | undefined): string | null {
	if (refKind === "default") return refs.head;
	if (refKind === "branch") return refs.refs.get(`refs/heads/${ref}`) ?? null;
	if (refKind === "tag") return refs.refs.get(`refs/tags/${ref}`) ?? null;
	return ref ?? null;
}

/**
 * A repository's refs: GitHub's list for a public GitHub address (git when that
 * fails, as for a download), else `git ls-remote --symref` with the clone's
 * hardened environment and read-only sign-in. Throws `RepoReachFailure`.
 */
export async function listRemoteRefs(source: ResolvedRepoSource, options: RepoAskOptions = {}): Promise<RemoteRefs> {
	if (!githubRepoUrl(source, archiveBase())) return gitRemoteRefs(source, options);
	try {
		return await githubRefs(source);
	} catch (err) {
		const failure = err instanceof ArchiveFailure ? err : new ArchiveFailure("failed", err instanceof Error ? err.message : String(err), { cause: err });
		console.warn(`[skills] GitHub's list of refs of ${source.display} failed (${failure.message}); trying git`);
		return withGitAfterGitHub(failure, (fallback) => gitRemoteRefs(source, fallback ? { ...options, askForDeveloperTools: false } : options));
	}
}

/** GitHub's list of a public repository's refs (git's smart http answer), under the zip's redirect rules, in 15 seconds and 1 MB. */
async function githubRefs(source: ResolvedRepoSource): Promise<RemoteRefs> {
	const repo = githubRepoUrl(source, archiveBase());
	if (!repo) throw new ArchiveFailure("failed", "not a GitHub address");
	const answer = await downloadArchive(`${repo}.git/info/refs?service=git-upload-pack`, ARCHIVE_ANSWER_TIMEOUT_MS, REFS_MAX_BYTES);
	const lines = pktLines(answer);
	if (!lines || lines[0] !== "# service=git-upload-pack") throw new ArchiveFailure("failed", "GitHub's list of branches and tags could not be read");
	const refs: RemoteRefs = { head: null, refs: new Map() };
	for (const line of lines.slice(1)) {
		const [entry] = line.split("\0");
		const [commit, name] = entry.split(" ");
		if (!name || !COMMIT_RE.test(commit)) continue;
		addRef(refs, name, commit);
	}
	return refs;
}

/** The payloads of git's pkt-lines (flushes dropped, each without its newline), or null when they don't parse. */
function pktLines(answer: Buffer): string[] | null {
	const lines: string[] = [];
	for (let at = 0; at < answer.length; ) {
		const size = Number.parseInt(answer.subarray(at, at + 4).toString("latin1"), 16);
		if (!Number.isInteger(size) || !/^[0-9a-f]{4}$/i.test(answer.subarray(at, at + 4).toString("latin1"))) return null;
		if (size === 0) {
			at += 4;
			continue;
		}
		if (size < 4 || at + size > answer.length) return null;
		lines.push(answer.subarray(at + 4, at + size).toString("utf-8").replace(/\n$/, ""));
		at += size;
	}
	return lines;
}

/** One listed ref; a tag's peeled line (`^{}`) names the commit the tag points at, which wins. */
function addRef(refs: RemoteRefs, name: string, commit: string): void {
	const sha = commit.toLowerCase();
	if (name === "HEAD") refs.head = sha;
	else if (name.endsWith("^{}")) refs.refs.set(name.slice(0, -3), sha);
	else if (!refs.refs.has(name) || !name.startsWith("refs/tags/")) refs.refs.set(name, sha);
}

async function gitRemoteRefs(source: ResolvedRepoSource, options: RepoAskOptions = {}): Promise<RemoteRefs> {
	if (source.kind === "git" && addressHasPassword(source.cloneArg)) throw new RepoReachFailure("failed", PASSWORD_IN_ADDRESS);
	const unused = signInNotUsed(source, options);
	if (unused) throw unused;
	// Only HEAD and the ref asked for, so a repository with many refs answers in a
	// few lines; `<ref>^{}` too, since a tag's pattern alone leaves out the line
	// with the commit an annotated tag points at.
	const args = [...(source.kind === "git" ? await storedSignInArgs(source.cloneArg, options) : []), "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=user", "ls-remote", "--symref", "--", source.cloneArg, "HEAD", ...(source.ref ? [source.ref, `${source.ref}^{}`] : [])];
	const result = await runGit(args, "ls-remote", LS_REMOTE_TIMEOUT_MS, hardenedGitEnv(options));
	if (result.code !== 0 && isMacDeveloperToolsStub(result.stderr)) {
		// The line says macOS has offered the tools, as the clone's does: ask for that window the same way.
		if (options.askForDeveloperTools !== false) requestMacDeveloperToolsInstall();
		throw new RepoReachFailure("missing-tool", MAC_DEVELOPER_TOOLS_MISSING);
	}
	if (result.code !== 0) {
		const unusedSsh = signInNotUsed(source, options, result.stderr);
		if (unusedSsh) throw unusedSsh;
		const message = describeCloneFailure(result.stderr, source) || `git ls-remote exited with code ${result.code}`;
		if (source.kind === "git" && source.host && signInAdvice(result.stderr, source.host)) throw new RepoReachFailure("sign-in", message);
		throw reachFailure(result.stderr, message, source) ?? new RepoReachFailure("failed", message);
	}
	const refs: RemoteRefs = { head: null, refs: new Map() };
	for (const line of result.stdout.split("\n")) {
		const [commit, name] = line.trim().split("\t");
		if (name && COMMIT_RE.test(commit.toLowerCase())) addRef(refs, name, commit);
	}
	return refs;
}

// --- Discovery / scan --------------------------------------------------------

const WALK_MAX_FILES = 20_000;

/** List repo-relative POSIX file paths under `root`, skipping `.git`, symlinks and `node_modules`. */
function walkFiles(root: string): string[] {
	const out: string[] = [];
	const stack: string[] = [""];
	while (stack.length > 0 && out.length < WALK_MAX_FILES) {
		const rel = stack.pop() as string;
		const abs = rel ? path.join(root, rel) : root;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(abs, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue; // never follow links out of the checkout
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				stack.push(childRel);
			} else if (entry.isFile()) {
				out.push(childRel);
				if (out.length >= WALK_MAX_FILES) break;
			}
		}
	}
	return out;
}

/**
 * Read a file ONLY if it (and each path component up to the checkout root) is a
 * real, non-symlink regular file, returning null otherwise. `core.symlinks=false`
 * already prevents git from materializing symlinks, but scan tokens can point at
 * any local dir (allowLocal), so this is the defense-in-depth that turns a
 * symlinked SKILL.md/LICENSE into "skill not found" instead of an out-of-checkout
 * file read.
 */
function readRegularFileWithin(root: string, file: string): string | null {
	const resolvedRoot = path.resolve(root);
	const resolvedFile = path.resolve(file);
	if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(resolvedRoot + path.sep)) return null;
	try {
		if (!fs.lstatSync(resolvedFile).isFile()) return null; // symlink/dir/socket → refuse
		// Reject if any parent segment between root and file is a symlink.
		let cursor = path.dirname(resolvedFile);
		while (cursor.length >= resolvedRoot.length && cursor !== resolvedRoot) {
			if (fs.lstatSync(cursor).isSymbolicLink()) return null;
			cursor = path.dirname(cursor);
		}
		return fs.readFileSync(resolvedFile, "utf-8");
	} catch {
		return null;
	}
}

/** Unescape a double-quoted YAML scalar's inner text (`\"`, `\\`, `\n`, `\t`). */
function unescapeDoubleQuoted(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && i + 1 < s.length) {
			const n = s[++i];
			out += n === "n" ? "\n" : n === "t" ? "\t" : n === '"' ? '"' : n === "\\" ? "\\" : n;
		} else out += s[i];
	}
	return out;
}

/** Fold physical line breaks in a flow (quoted) scalar to single spaces, trimming continuation indents. */
function foldFlowNewlines(s: string): string {
	if (!s.includes("\n")) return s;
	return s.split("\n").map((l, i) => (i === 0 ? l.replace(/\s+$/, "") : l.trim())).join(" ");
}

/**
 * Read a single/double-quoted scalar starting at `rest[0]`, folding across lines until
 * the close — but ONLY when the value is ENTIRELY a well-formed quoted scalar (the
 * closing quote is the last non-space/comment content). A value that merely BEGINS with
 * a quote — `"Fast" chart guidance`, or an unterminated `"…` — returns null so the caller
 * treats it as a plain scalar verbatim rather than silently truncating at the first quote.
 */
function tryReadQuotedScalar(rest: string, lines: string[], start: number): [string, number] | null {
	const q = rest[0];
	let i = start;
	let acc = rest.slice(1);
	for (;;) {
		for (let j = 0; j < acc.length; j++) {
			if (q === '"' && acc[j] === "\\") { j++; continue; } // skip an escaped char
			if (acc[j] === q) {
				if (q === "'" && acc[j + 1] === "'") { j++; continue; } // '' is an escaped quote
				// Well-formed only if nothing but whitespace/comment follows the close.
				if (!/^\s*(#.*)?$/.test(acc.slice(j + 1))) return null;
				const inner = foldFlowNewlines(acc.slice(0, j));
				return [q === '"' ? unescapeDoubleQuoted(inner) : inner.replace(/''/g, "'"), i + 1];
			}
		}
		if (++i >= lines.length) return null; // unterminated → not a well-formed quoted scalar
		acc += `\n${lines[i]}`;
	}
}

/** Read a block scalar (`|`/`>` with optional chomping) — the indented lines below the key. */
function readBlockScalar(lines: string[], start: number, folded: boolean, chomp: string): [string, number] {
	const collected: string[] = [];
	let i = start;
	let indent = -1;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*$/.test(line)) { collected.push(""); continue; } // blank interior line
		const lead = line.match(/^\s*/)![0].length;
		if (lead === 0) break; // dedent to key level ends the block
		if (indent < 0) indent = lead; // first content line sets the block indent
		else if (lead < indent) break;
		collected.push(line.slice(indent));
	}
	while (collected.length && collected[collected.length - 1] === "") collected.pop(); // clip/strip trailing blanks
	let value = folded
		? collected.join("\n").split(/\n{2,}/).map((p) => p.split("\n").join(" ").trim()).join("\n")
		: collected.join("\n");
	if (chomp === "-") value = value.replace(/\n+$/, "");
	return [value, i];
}

/** Read a plain scalar, folding more-indented continuation lines into it with single spaces. */
function readPlainScalar(rest: string, lines: string[], start: number): [string, number] {
	const segments = [rest.trim()];
	let i = start + 1;
	for (; i < lines.length; i++) {
		if (/^\s*$/.test(lines[i]) || /^\S/.test(lines[i])) break; // blank or a zero-indent line ends it
		segments.push(lines[i].trim());
	}
	return [segments.join(" ").trim(), i];
}

/**
 * Parse a SKILL.md's `---` frontmatter into a flat `key → string` map plus the body.
 * A dependency-free YAML SUBSET covering what skill frontmatter actually uses: top-level
 * (zero-indent) `key:` entries whose value is a scalar — plain, single/double-quoted (with
 * escapes + line folding), or a block scalar (`|`, `>` and their chomping variants). A key
 * with nothing on its line takes what YAML reads below it when that is a string, as in a
 * description written on the indented lines below its key; the runtime's YAML parser reads
 * the front matter once, and only for such a key. `name` is the exception and stays "": a
 * skill already in the library is listed, and switched on in rooms, by the name read before
 * (`libraryKey` in skills-executable.ts). A nested map/list stays "" (`skillVersion`
 * reads the one nested field it needs), and front matter YAML can't read keeps the subset's
 * result for every key. Never throws (falls back to the lenient parse on any trouble).
 * The import record's sha256 is of the raw SKILL.md bytes (skill-routes.ts), so this only
 * shapes the fields shown and stored. A missing or blank description reads as the body's
 * first line with text (`descriptionFromBody`), as the leading tools read it, so every
 * reader (the scan, a review, the library, an update, the model's list) shows the same.
 */
export function parseSkillFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
	const parsed = readFrontmatter(raw);
	if (!parsed.fm.description?.trim()) {
		const line = descriptionFromBody(parsed.body);
		if (line) parsed.fm.description = line;
	}
	return parsed;
}

/** The longest description a skill may have (`validateSkillWritePayload` in skills-library.ts). */
const SKILL_DESCRIPTION_MAX = 1024;

/**
 * A skill's description when its front matter has none: the body's first line
 * with text once a heading's or a list item's mark is taken off, cut to the
 * longest a description may have; "" when no line has text.
 */
function descriptionFromBody(body: string): string {
	for (const line of body.split("\n")) {
		const text = line.trim().replace(/^(?:#{1,6}|[-*+]|\d{1,9}[.)])(?:\s+|$)/, "").trim();
		if (!text) continue;
		if (text.length <= SKILL_DESCRIPTION_MAX) return text;
		const cut = text.slice(0, SKILL_DESCRIPTION_MAX);
		// Never half a character: a cut between a surrogate pair drops its first half.
		return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
	}
	return "";
}

/** The front matter's fields as written, and the body (`parseSkillFrontmatter`). */
function readFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
	// Normalize CRLF/CR to LF up front: the fence regex is LF-only, so a CRLF (or
	// lone-CR) SKILL.md would otherwise miss its frontmatter entirely — the `---`
	// block would leak into the body and every key/value/body line would keep a
	// trailing `\r`. After this a CRLF file parses identically to its LF twin.
	const normalized = raw.replace(/\r\n?/g, "\n");
	const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!m) return { fm: {}, body: normalized };
	const fm: Record<string, string> = {};
	const readBelow: string[] = [];
	try {
		const lines = m[1].split("\n");
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			// Only a zero-indent `key:` starts an entry; blanks, comments and stray
			// indented lines (nested-value leftovers) are skipped by their owning key or here.
			const kv = /^\s/.test(line) ? null : line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
			if (!kv) { i++; continue; }
			const key = kv[1];
			const rest = kv[2];
			const block = rest.match(/^([|>])([+-]?)\d*\s*(?:#.*)?$/);
			if (block) {
				[fm[key], i] = readBlockScalar(lines, i + 1, block[1] === ">", block[2]);
			} else if (rest[0] === '"' || rest[0] === "'") {
				const quoted = tryReadQuotedScalar(rest, lines, i);
				if (quoted) [fm[key], i] = quoted;
				else [fm[key], i] = readPlainScalar(rest, lines, i); // begins with a quote but isn't one → verbatim
			} else if (rest.trim() === "") {
				fm[key] = ""; // empty, a nested map/list or a plain value below: YAML decides, after the loop
				if (key !== "name") readBelow.push(key);
				i++;
			} else {
				[fm[key], i] = readPlainScalar(rest, lines, i);
			}
		}
	} catch {
		// Malformed frontmatter: keep whatever parsed cleanly (lenient, never throws).
	}
	if (readBelow.length > 0) {
		let yaml: unknown;
		try {
			yaml = parseYamlFrontmatter(`---\n${m[1]}\n---\n`).frontmatter;
		} catch {
			yaml = undefined;
		}
		if (yaml && typeof yaml === "object" && !Array.isArray(yaml)) {
			for (const key of readBelow) {
				const value = (yaml as Record<string, unknown>)[key];
				if (typeof value === "string") fm[key] = value;
			}
		}
	}
	return { fm, body: m[2] };
}

/**
 * The version a skill states in its front matter, or null. Read with the runtime's YAML
 * parser, so a comment, quotes, a blank line or a flow map is read as YAML reads it; a
 * top-level version YAML would turn into a number (1.10 into 1.1) keeps its text as
 * written, less a comment. Front matter that isn't valid YAML (old files written by hand)
 * keeps its top-level version as written, as every other field, and states no nested one.
 */
export function skillVersion(manifest: string): string | null {
	const written = parseSkillFrontmatter(manifest).fm.version?.trim();
	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = parseYamlFrontmatter(manifest).frontmatter as Record<string, unknown>;
	} catch {
		return written || null;
	}
	const top = frontmatter.version;
	if (typeof top === "string" && top.trim()) return top.trim();
	// A plain scalar can't hold " #", so what follows one is a comment.
	if (typeof top === "number" && written) return written.replace(/\s+#.*$/, "");
	const metadata = frontmatter.metadata;
	const nested = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).version : undefined;
	return (typeof nested === "string" || typeof nested === "number") && String(nested).trim() ? String(nested).trim() : null;
}

const LICENSE_FILENAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.md"];

/**
 * Best-effort SPDX-ish label from the LICENSE file directly in `dir` (a skill's
 * folder or a repository's root), or null. Read only when it is a plain file
 * with no link between `root` and it.
 */
export function detectLicense(dir: string, root: string = dir): string | null {
	for (const name of LICENSE_FILENAMES) {
		const raw = readRegularFileWithin(root, path.join(dir, name));
		if (raw == null) continue;
		const head = raw.slice(0, 2048);
		const upper = head.toUpperCase();
		if (/\bAPACHE LICENSE\b/.test(upper) && upper.includes("2.0")) return "Apache-2.0";
		if (/\bMIT LICENSE\b/.test(upper) || /PERMISSION IS HEREBY GRANTED, FREE OF CHARGE/.test(upper)) return "MIT";
		if (/\bISC LICENSE\b/.test(upper)) return "ISC";
		if (/\bMOZILLA PUBLIC LICENSE\b/.test(upper)) return "MPL-2.0";
		if (/GNU GENERAL PUBLIC LICENSE/.test(upper)) return upper.includes("VERSION 3") ? "GPL-3.0" : "GPL-2.0";
		if (/\bBSD\b/.test(upper) && /REDISTRIBUTION AND USE/.test(upper)) return "BSD";
		return "see LICENSE"; // present but unrecognised
	}
	return null;
}

/**
 * The files an import of the skill in `skillDir` writes, relative to it, SKILL.md
 * included, and the refusal when they are past the limit (their sizes as the
 * checkout holds them; nothing is read). A root SKILL.md ("") takes the
 * checkout's whole folder, as the leading tools do; the size limit bounds it like
 * any other skill.
 */
function skillFilesFor(root: string, skillDir: string): { files: string[]; tooBig: SkillTooBig | null } {
	const dir = path.join(root, skillDir);
	const files = walkFiles(dir).filter((file) => file !== path.basename(file) || !nameFoldsOnto(file, SKILL_PROVENANCE_FILENAME));
	let bytes = 0;
	for (const file of files) bytes += fs.lstatSync(path.join(dir, file)).size;
	return { files, tooBig: skillOverLimit(files.length, bytes) };
}

/** A skill's scripts (`isSkillScript`), each with whether it keeps its run mark (`keepsRunMark`). */
export type SkillScripts = ReadonlyMap<string, boolean>;

/**
 * A plain file's mode and its first `headBytes` (`SCRIPT_HEAD_BYTES`), or null
 * when it is no plain file or can't be read; with no bytes asked, its mode alone,
 * from a look that opens nothing. It never follows a link or waits on a named
 * pipe put there: the open refuses the one and the fstat the other.
 */
export function fileModeAndHead(file: string, headBytes = SCRIPT_HEAD_BYTES): { mode: number; head: Buffer } | null {
	try {
		if (headBytes === 0) {
			const stat = fs.lstatSync(file);
			return stat.isFile() ? { mode: stat.mode, head: Buffer.alloc(0) } : null;
		}
		const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
		try {
			const stat = fs.fstatSync(fd);
			if (!stat.isFile()) return null;
			const head = Buffer.alloc(headBytes);
			return { mode: stat.mode, head: head.subarray(0, fs.readSync(fd, head, 0, headBytes, 0)) };
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** Of a skill's files in `dir`, its scripts by their mode and first bytes on disk (`SkillScripts`); a file that can't be read is none. */
export function scriptFiles(dir: string, files: readonly string[]): SkillScripts {
	const scripts = new Map<string, boolean>();
	for (const file of files) {
		// A script's name alone makes it one, so only its mode is needed.
		const read = fileModeAndHead(path.join(dir, file), skillFileKind(file) === "scripts" ? 0 : SCRIPT_HEAD_BYTES);
		if (read && isSkillScript(file, read.mode, read.head)) scripts.set(file, keepsRunMark(file, read.mode, read.head));
	}
	return scripts;
}

/** The first path a skill's SKILL.md (`manifest`) or other Markdown file in `dir` writes that reaches above its folder (`outsidePath`); a file that can't be read is passed over. */
export function skillOutsidePath(dir: string, files: readonly string[], manifest: string): string | null {
	const others = files.filter((file) => file !== "SKILL.md" && file.toLowerCase().endsWith(".md")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const read = others.flatMap((file) => {
		const text = readRegularFileWithin(dir, path.join(dir, file));
		return text === null ? [] : [{ path: file, text }];
	});
	return outsidePath([{ path: "SKILL.md", text: manifest }, ...read]);
}

/** The repository's own name, from its shown address or local path: its last part, without `.git`. */
function repositoryName(source: string): string {
	return source.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()?.replace(/\.git$/i, "") ?? "";
}

/** The name a skill is listed under (its front matter's, else its folder's, else, at a repository's root, the repository's) and the name the library keeps it under (`skillIdFor`, the repository's name after its folder's). */
function repoSkillNames(fm: Record<string, string>, skillDir: string, source: string): { name: string; id: string } {
	const folder = path.posix.basename(skillDir);
	const repository = repositoryName(source);
	return { name: (fm.name?.trim() || folder || repository).trim(), id: skillIdFor(fm.name, folder, repository) };
}

/**
 * A skill's name as the standard allows one, the way the library keeps it and a
 * room's "/" picks it: lower case; spaces, underscores and dots as hyphens; any
 * other character dropped; one hyphen at a time, none at either end; cut to the
 * length limit. A name that already fits stays as it is. Empty when nothing fits.
 */
export function fitSkillName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[\s_.]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, SKILL_ID_MAX_LENGTH)
		.replace(/-$/, "");
}

/**
 * The name the library keeps a skill under: the first of `names` (its written
 * name, then the ones a skill with no name falls back on) of which anything fits
 * (`fitSkillName`), else "skill". Never empty, so never refused.
 */
export function skillIdFor(...names: Array<string | undefined>): string {
	for (const name of names) {
		const fitted = fitSkillName(name ?? "");
		if (fitted) return fitted;
	}
	return "skill";
}

/**
 * Discover the true `SKILL.md` skills in a checkout (spec §3): loader discovery
 * rules MINUS the root-`.md`-as-skill rule (MR-1 `filterRepoScanSkillFiles`), so
 * obra/superpowers yields exactly its skills and README/docs are excluded.
 */
export function scanRepoSkills(checkoutDir: string, source: string): RepoFoundSkill[] {
	const repoLicense = detectLicense(checkoutDir);
	const manifests = filterRepoScanSkillFiles(walkFiles(checkoutDir).map((p) => p.replace(/\\/g, "/")));
	const found: RepoFoundSkill[] = [];
	for (const manifest of manifests) {
		const skillDir = path.posix.dirname(manifest) === "." ? "" : path.posix.dirname(manifest);
		let raw = "";
		try {
			raw = fs.readFileSync(path.join(checkoutDir, manifest), "utf-8");
		} catch {
			continue;
		}
		const { fm } = parseSkillFrontmatter(raw);
		const { name, id } = repoSkillNames(fm, skillDir, source);
		const { files, tooBig } = skillFilesFor(checkoutDir, skillDir);
		found.push({
			path: skillDir,
			name,
			id,
			description: (fm.description || "").trim(),
			license: fm.license?.trim() || detectLicense(path.join(checkoutDir, skillDir), checkoutDir) || repoLicense,
			hasBundledScripts: files.some((rel) => !rel.toLowerCase().endsWith(".md")),
			disableModelInvocation: frontmatterFlagTrue(fm["disable-model-invocation"]),
			...(tooBig ? { tooBig } : {}),
		});
	}
	return found.sort((a, b) => a.name.localeCompare(b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A coding tool's copy of a skill: a folder on its path starts with a dot and
 * sits anywhere but right inside a `skills` folder (`.claude/skills/x`,
 * `.github/plugins/p/skills/x`; never `skills/.curated/x`).
 */
function isToolCopy(skillPath: string): boolean {
	const parts = skillPath.split("/");
	return parts.some((part, i) => part.startsWith(".") && parts[i - 1] !== "skills");
}

/** Which tool copy is offered when a name has no other: one anywhere below the folder several tools share, then below Claude's, then the first by path. */
function toolCopyRank(skillPath: string): number {
	const above = `/${path.posix.dirname(skillPath)}/`;
	if (above.includes("/.agents/skills/")) return 0;
	if (above.includes("/.claude/skills/")) return 1;
	return 2;
}

/**
 * The skills a scan or Browse offers to add: every found one but a SKILL.md
 * inside another found skill's folder, which belongs to that skill and comes in
 * with it; when that skill is too big to add, the one inside is offered on its
 * own. Then one row per name (case ignored) among coding tools' copies: none
 * when the name has an ordinary folder left that can be added, else the one
 * `toolCopyRank` puts first, as the common installer keeps the first of each
 * name. Two ordinary folders of one name both stay. An update still finds a
 * skill in any of these folders (`scanRepoSkills`).
 */
export function offeredRepoSkills(found: readonly RepoFoundSkill[]): RepoFoundSkill[] {
	const holds = (outer: RepoFoundSkill, inner: string) => !outer.tooBig && outer.path !== inner && (outer.path === "" || inner.startsWith(`${outer.path}/`));
	const rows = found.filter((skill) => !found.some((other) => holds(other, skill.path)));
	const nameOf = (skill: RepoFoundSkill) => skill.name.toLowerCase();
	const ordinary = new Set(rows.filter((skill) => !isToolCopy(skill.path) && !skill.tooBig).map(nameOf));
	const comesFirst = (a: RepoFoundSkill, b: RepoFoundSkill) => toolCopyRank(a.path) < toolCopyRank(b.path) || (toolCopyRank(a.path) === toolCopyRank(b.path) && a.path < b.path);
	const keptCopy = new Map<string, RepoFoundSkill>();
	for (const skill of rows) {
		if (!isToolCopy(skill.path) || ordinary.has(nameOf(skill))) continue;
		const kept = keptCopy.get(nameOf(skill));
		if (!kept || comesFirst(skill, kept)) keptCopy.set(nameOf(skill), skill);
	}
	return rows.filter((skill) => !isToolCopy(skill.path) || keptCopy.get(nameOf(skill)) === skill);
}

/** Resolve a repo-relative skill dir path INSIDE the checkout, or null on traversal. */
function resolveSkillDir(checkoutDir: string, skillPath: string): string | null {
	const cleaned = String(skillPath ?? "").replace(/\\/g, "/");
	const resolved = path.resolve(checkoutDir, cleaned);
	const root = path.resolve(checkoutDir);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
	// The SKILL.md must be a real regular file inside the checkout — a symlinked
	// manifest is refused (would otherwise read an out-of-checkout file).
	if (readRegularFileWithin(root, path.join(resolved, "SKILL.md")) == null) return null;
	return resolved;
}

/** Build the review-screen candidate for a chosen skill (runs the invisible-unicode scan).
 *  Throws `SkillTooBigError` for a skill past the limit: it never reaches the review. */
export function readRepoCandidate(checkoutDir: string, skillPath: string, source: string): RepoSkillCandidate | null {
	const dir = resolveSkillDir(checkoutDir, skillPath);
	if (!dir) return null;
	const raw = readRegularFileWithin(path.resolve(checkoutDir), path.join(dir, "SKILL.md"));
	if (raw == null) return null;
	const { fm, body } = parseSkillFrontmatter(raw);
	const trimmedBody = body.trim();
	const rel = path.relative(checkoutDir, dir).replace(/\\/g, "/");
	const { files, tooBig } = skillFilesFor(checkoutDir, rel);
	if (tooBig) throw new SkillTooBigError(tooBig);
	const pointsOutside = skillOutsidePath(dir, files, raw);
	const names = repoSkillNames(fm, rel, source);
	const writtenName = fm.name?.trim();
	return {
		...names,
		...(writtenName && writtenName !== names.id ? { writtenName } : {}),
		description: (fm.description || "").trim(),
		body: trimmedBody,
		source,
		license: fm.license?.trim() || detectLicense(dir, checkoutDir) || detectLicense(checkoutDir),
		version: skillVersion(raw),
		scanFindings: scanInvisibleUnicode(`${trimmedBody}\n${(fm.description || "").trim()}`),
		files: skillFileList(files, scriptFiles(dir, files)),
		disableModelInvocation: frontmatterFlagTrue(fm["disable-model-invocation"]),
		...(pointsOutside ? { outsidePath: pointsOutside } : {}),
	};
}

/**
 * The skill at `skillPath` of a checkout: its folder and the files an add or an
 * update writes from it (`skillFilesFor`), with the refusal when they are past
 * the limit; null when there is no skill there.
 */
export function repoSkillFiles(checkoutDir: string, skillPath: string): { dir: string; files: string[]; tooBig: SkillTooBig | null } | null {
	const dir = resolveSkillDir(checkoutDir, skillPath);
	if (!dir) return null;
	return { dir, ...skillFilesFor(checkoutDir, path.relative(checkoutDir, dir)) };
}

export interface VendorResult {
	/** SKILL.md body persisted (what the sha256 provenance hashes). */
	body: string;
	license: string | null;
	/** Count of bundled non-.md files copied alongside SKILL.md. */
	bundledCopied: number;
}

/**
 * Copy a repo skill dir into a destination store dir (`destSkillDir`, already
 * `<store>/<id>`): SKILL.md and its bundled files, byte for byte, each runnable
 * only when it is a script the checkout marks so (`keptFileMode`). Importing only copies them;
 * whether a room may run them is the room's switch (`roomSkillFolders` in
 * skills-executable.ts). Symlinks and `.git` are skipped; total size/file count
 * are capped. The caller writes the import record. Returns the persisted body so
 * the caller can hash exactly what landed on disk.
 */
export function vendorRepoSkill(checkoutDir: string, skillPath: string, destSkillDir: string): VendorResult {
	const found = repoSkillFiles(checkoutDir, skillPath);
	if (!found) throw new Error("skill not found in checkout");
	const { dir: srcDir, files, tooBig } = found;
	if (tooBig) throw new SkillTooBigError(tooBig);
	fs.mkdirSync(destSkillDir, { recursive: true, mode: 0o700 });
	let bundledCopied = 0;
	for (const f of files) {
		const dest = path.join(destSkillDir, f);
		fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
		fs.copyFileSync(path.join(srcDir, f), dest);
		const source = fileModeAndHead(path.join(srcDir, f));
		fs.chmodSync(dest, source ? keptFileMode(f, source.mode, source.head) : 0o600);
		if (f !== "SKILL.md") bundledCopied += 1;
	}
	const raw = fs.readFileSync(path.join(destSkillDir, "SKILL.md"), "utf-8");
	const { fm, body } = parseSkillFrontmatter(raw);
	return { body: body.trim(), license: fm.license?.trim() || detectLicense(srcDir, checkoutDir) || detectLicense(checkoutDir), bundledCopied };
}

// --- Checkout cache (scan → review → accept continuity) ----------------------
//
// A scan clones once and hands back a token; the review + accept steps reuse that
// same checkout via the token, so the body the user accepts is byte-identical to
// the body they reviewed (no re-clone, no upstream drift mid-flow). Entries
// expire on a TTL and are removed from disk; a process-exit hook clears the rest.

const CHECKOUT_TTL_MS = 15 * 60_000;

interface CachedCheckout {
	dir: string;
	source: string;
	/** The repository's version it holds; absent for an upload's files. */
	origin?: RepoOrigin;
	createdAt: number;
}

const checkoutCache = new Map<string, CachedCheckout>();

export function removeCheckout(token: string): void {
	const entry = checkoutCache.get(token);
	if (!entry) return;
	checkoutCache.delete(token);
	fs.rmSync(entry.dir, { recursive: true, force: true });
}

/** Drop and delete expired checkouts. Called before each cache op. */
function sweepCheckouts(): void {
	const now = Date.now();
	for (const [token, entry] of checkoutCache) {
		if (now - entry.createdAt > CHECKOUT_TTL_MS) removeCheckout(token);
	}
}

/** Register a fresh checkout and return its token. */
export function registerCheckout(dir: string, source: string, origin?: RepoOrigin): string {
	sweepCheckouts();
	const token = crypto.randomUUID();
	checkoutCache.set(token, { dir, source, ...(origin ? { origin } : {}), createdAt: Date.now() });
	return token;
}

/** Resolve a token to its live checkout dir + source (and the repository's version it holds), or null when expired/unknown. */
export function getCheckout(token: string): { dir: string; source: string; origin?: RepoOrigin } | null {
	sweepCheckouts();
	const entry = checkoutCache.get(String(token ?? ""));
	return entry ? { dir: entry.dir, source: entry.source, ...(entry.origin ? { origin: entry.origin } : {}) } : null;
}

/** Remove every cached checkout from disk (process-exit cleanup). */
export function disposeAllCheckouts(): void {
	for (const token of Array.from(checkoutCache.keys())) removeCheckout(token);
}

let exitHookInstalled = false;
/** Install a best-effort process-exit cleanup for all cached checkouts (idempotent). */
export function installCheckoutCleanup(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", disposeAllCheckouts);
}

// --- Featured Browse cache ---------------------------------------------------
//
// Browse fetches each featured source on demand and caches the scan result +
// token with a TTL, so opening the pane repeatedly does not re-clone. The token
// feeds the same review/accept endpoints as the paste-a-URL flow.

const FEATURED_TTL_MS = 10 * 60_000;

export interface FeaturedSourceResult {
	source: string;
	author: string;
	token: string | null;
	skills: RepoFoundSkill[];
	error?: string;
	/** The error is a tool this machine lacks, the same for every source. */
	missingTool?: boolean;
}

interface CachedFeatured {
	result: FeaturedSourceResult;
	fetchedAt: number;
}

const featuredCache = new Map<string, CachedFeatured>();

/**
 * Fetch + scan one featured source, memoised for `FEATURED_TTL_MS`. Any clone/scan
 * failure is captured as a per-card `error` rather than failing the whole pane.
 */
export async function loadFeaturedSource(entry: FeaturedSource): Promise<FeaturedSourceResult> {
	const cached = featuredCache.get(entry.source);
	if (cached && Date.now() - cached.fetchedAt < FEATURED_TTL_MS) {
		// A cached ERROR result carries no token/checkout, so the checkout freshness
		// check below can never pass for it — serving it straight off the timestamp is
		// what stops a dead/offline source from re-cloning (and blocking the pane up to
		// the 90s clone timeout) on every request. A fresh attempt runs after the TTL.
		if (cached.result.error) return cached.result;
		// Success entries still require their live checkout (token reuse for review/accept).
		if (getCheckout(cached.result.token ?? "")) return cached.result;
	}
	// Re-fetching a stale/gone entry: drop the previous checkout now instead of
	// leaking it until its own TTL sweep.
	if (cached?.result.token) removeCheckout(cached.result.token);
	// Featured sources are config-controlled, not user input; local paths still ride
	// the same env gate as the scan endpoint so a smoke can override to a fixture.
	const resolved = resolveRepoSource(entry.source, { allowLocal: process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO === "1" });
	if (!resolved.ok) {
		const result: FeaturedSourceResult = { source: entry.source, author: entry.author, token: null, skills: [], error: resolved.error };
		featuredCache.set(entry.source, { result, fetchedAt: Date.now() });
		return result;
	}
	try {
		const { dir, origin } = await fetchRepoCheckout(resolved.value);
		const token = registerCheckout(dir, resolved.value.display, origin);
		const result: FeaturedSourceResult = { source: entry.source, author: entry.author, token, skills: offeredRepoSkills(scanRepoSkills(dir, resolved.value.display)) };
		featuredCache.set(entry.source, { result, fetchedAt: Date.now() });
		return result;
	} catch (err) {
		const failure = repoFailureOf(err);
		const missingTool = failure.reason === "missing-tool";
		const error = repositoryFailedLine(failure, resolved.value.ref, "browse");
		const result: FeaturedSourceResult = { source: entry.source, author: entry.author, token: null, skills: [], error, ...(missingTool ? { missingTool: true } : {}) };
		// A missing tool fails in milliseconds, so there is no slow clone to
		// spare, and the sentence says "try again" once it is installed: that
		// must not meet a remembered failure.
		if (!missingTool) featuredCache.set(entry.source, { result, fetchedAt: Date.now() });
		return result;
	}
}
