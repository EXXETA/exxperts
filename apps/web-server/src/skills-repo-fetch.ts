/**
 * Immutable repository snapshots for discovery, explicit file review and import.
 * Git fetches trees without a working checkout; public APIs are the anonymous fallback.
 * Repository programs are never executed and only selected, permitted blobs are read.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, parseDocument } from "yaml";
import { scanInvisibleUnicode, type InvisibleUnicodeScan } from "./skills-import.js";
import { classifyReferencePath, normalizeRepoPath, normalizeRepositoryFilePolicy, referenceBytesSha256, referenceLocalPath, referencePathPermission, repositoryPathWithin, REFERENCE_ASSET_MAX_BYTES, REFERENCE_PACKAGE_MAX_BYTES, REFERENCE_PACKAGE_MAX_FILES, REFERENCE_TEXT_MAX_BYTES, validateReferenceBuffer, validatedReferenceText, type ReferenceKind, type RepoReference, type RepositoryFilePolicy } from "./skills-file-policy.js";
import type { SkillProvenance, SkillRepoProvenance } from "./skills-store.js";
import { skillMarkdownReferences } from "./skills-markdown-references.js";
import { skillFilePreview } from "./skills-file-preview.js";
import { reportRepositoryProgress } from "./skills-repository-progress.js";
import { assertRepositoryAccess, gitMissingMessage, onRepositoryAccessRevoked, repositoryAccessError, repositoryGitAvailable, repositoryTokenGit, resolveGitCommand, resolveRepositoryAccess, type RepositoryAccessContext, type RepositoryAccessSettings } from "./skills-repository-access.js";
import { loadPublicRepository, type PublicRepository } from "./skills-repo-public-api.js";

/** A skill discovered in a cloned repo (the multi-select list row, spec §3). */
export interface RepoFoundSkill {
	originalName?: string;
	/** Paths mentioned in Markdown; no file contents or automatic selection. */
	referencePaths?: string[];
	/** Repo-relative POSIX path of the skill's directory ("" for a root SKILL.md). */
	path: string;
	/** Frontmatter `name`, falling back to the directory basename. */
	name: string;
	description: string;
	/** License from frontmatter, else detected from the repo's LICENSE file, else null. */
	license: string | null;
	/** True when the skill dir carries any non-.md file (spec §3 bundled-scripts flag). */
	hasBundledScripts: boolean;
}

/** The review-screen candidate (the MR-3 seam contract shape). */
export interface RepoSkillCandidate {
	originalName?: string;
	name: string;
	description: string;
	body: string;
	/** Display source (the repo the user pasted / a featured entry). */
	source: string;
	license: string | null;
	/** Invisible-unicode findings surfaced at review (spec §7 must 1). */
	scanFindings: InvisibleUnicodeScan;
	/** Relative filenames of the non-.md files bundled with the skill ("scripts will not run"). */
	bundledScripts: string[];
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
 * error otherwise. Never throws.
 */
export function resolveRepoSource(rawInput: string, opts: { allowLocal?: boolean } = {}): { ok: true; value: ResolvedRepoSource } | { ok: false; error: string } {
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
	if (parsed.search) return { ok: false, error: "repository addresses must not contain query parameters; use the sign-in stored by git" };
	if (parsed.hostname.startsWith("-") || SHELL_META.test(parsed.hostname) || parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean).length < 2) {
		return { ok: false, error: "expected a git URL with a user/repo path" };
	}
	return { ok: true, value: { kind: "git", cloneArg, ref, display: shownAddress(parsed, cloneArg), host: parsed.host } };
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

// --- Hardened Git processes --------------------------------------------------

const CLONE_TIMEOUT_MS = 90_000;
const CONFIG_READ_TIMEOUT_MS = 5_000;

// Hardened environment: no credential prompts, no system config, no hooks or
// templates, transports allow-listed (file: included for local smoke repos).
// Hooks are never fetched from a remote, but a poisoned template dir is closed
// off too, belt-and-braces.
function isolateGitHome(env: NodeJS.ProcessEnv, directory: string): void {
	// libcurl also reads .netrc independently of Git's credential helpers.
	const empty = path.join(directory, ".git", "exxperts-empty-home");
	for (const key of ["HOME", "USERPROFILE", "CURL_HOME", "XDG_CONFIG_HOME"]) env[key] = empty;
	delete env.NETRC;
}

function hardenedGitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "/dev/null" : os.devNull,
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TEMPLATE_DIR: "",
		GIT_ALLOW_PROTOCOL: "https:http:ssh:git:file",
		GCM_INTERACTIVE: "never",
		GCM_GUI_PROMPT: "false",
		GIT_SSL_NO_VERIFY: "false",
	};
	for (const key of Object.keys(env)) if (key.startsWith("GIT_TRACE") || key.startsWith("GCM_TRACE") || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete env[key];
	for (const key of ["GIT_CURL_VERBOSE", "SSLKEYLOGFILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "EXXPERTS_REPOSITORY_TOKEN", "GIT_SSH_COMMAND", "GIT_SSH"]) delete env[key];
	return env;
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

function runGit(args: string[], what: string, timeoutMs: number, env: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			// Its own process group off Windows, so the timeout can end the whole tree.
			child = spawn(resolveGitCommand(process.platform, env), args, { stdio: ["ignore", "pipe", "pipe"], env, cwd, detached: process.platform !== "win32" });
		} catch (err) {
			reject(err);
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
			if (stdout.length < 262_144) stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			if (stderr.length < 8192) stderr += String(chunk);
		});
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`git ${what} timed out after ${timeoutMs}ms`));
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
//   - get only: a helper is never told to `store` or `erase` a sign-in;
//     OAuth helpers may internally refresh their own stored tokens;
//   - encrypted transport only: helpers answer for https, and for http on this
//     machine's own loopback (nothing leaves it; the smoke's test server);
//   - the clone gets no other system/global configuration; only its helper
//     can read global OAuth settings.

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
export async function readGitConfigListing(): Promise<string> {
	let cwd: string | undefined;
	try {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-git-config-"));
		const res = await runGit(["config", "--list", "--show-scope", "--includes", "--null"], "config", Math.min(CONFIG_READ_TIMEOUT_MS, remainingRepositoryBudget()), { ...process.env, GIT_TERMINAL_PROMPT: "0" }, cwd);
		return res.code === 0 ? res.stdout : "";
	} catch {
		return "";
	} finally {
		if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
	}
}

/** Does a `credential.<pattern>.*` section apply to this remote? Scheme and host must agree; a user or path in the pattern must too. */
export function credentialSectionApplies(pattern: string, remote: URL): boolean {
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
	// Only the helper reads the user's OAuth configuration; fetching stays hardened.
	const restoreGlobal = process.env.GIT_CONFIG_GLOBAL === undefined ? "unset GIT_CONFIG_GLOBAL;" : `export GIT_CONFIG_GLOBAL='${process.env.GIT_CONFIG_GLOBAL.replace(/'/g, "'\\''") }';`;
	return `!f() { test "$1" = get || return 0; ${restoreGlobal} ${command} get; }; f`;
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
export async function storedSignInArgs(cloneArg: string): Promise<string[]> {
	if (!signInRemote(cloneArg)) return ["-c", "credential.helper="];
	return signInArgsFromConfigListing(await readGitConfigListing(), cloneArg);
}

/** What to do about a sign-in failure, by what the host answered; null when the failure is something else. */
function signInAdvice(stderr: string, host: string): string | null {
	if (/Permission denied \(publickey/i.test(stderr)) {
		return `${host} did not accept your SSH key. Add the key to your account there, or use the repository's https address.`;
	}
	if (/Authentication failed|HTTP Basic: Access denied/i.test(stderr)) {
		return `${host} turned down the sign-in provided for it; it may have expired. Choose a valid sign-in in Repository access, then retry.`;
	}
	if (/returned error: 403/i.test(stderr)) {
		return `${host} refused access to this repository. Your sign-in there may not include it, or an access token may lack the right to read repositories.`;
	}
	if (/could not read (?:Username|Password)|terminal prompts disabled/i.test(stderr)) {
		return `this repository needs a sign-in to ${host}, or the address is wrong. Check the address and choose Repository access to permit a local sign-in or use a session token.`;
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

export function repositoryFetchFailure(stderr: string, source: ResolvedRepoSource, hideDetails = false): RepositoryFetchError {
	if (/rate.?limit|too many requests|returned error: 429/i.test(stderr)) return Object.assign(new RepositoryFetchError("The repository host rate-limited the request. Retry later; no additional sign-in was started."), { code: "REPOSITORY_RATE_LIMIT", statusCode: 429 });
	const error = new RepositoryFetchError(describeCloneFailure(stderr, source) || "Repository operation failed.");
	if (signInRemote(source.cloneArg) && (signInAdvice(stderr, source.host ?? "this host") || /repository.*not found|returned error: 404/i.test(stderr))) {
		Object.assign(error, { code: "REPOSITORY_AUTH_REQUIRED", statusCode: 403 });
	}
	if (hideDetails) error.message = (error as Error & { code?: string }).code === "REPOSITORY_AUTH_REQUIRED" ? "The repository could not be read with this session token. Check its read permissions, expiry and the repository address." : /filter.*not supported|filtering not recognized/i.test(stderr) ? "This host does not support filtered fetching." : "Repository download failed. Check the repository address, network and token permissions, then retry.";
	return error;
}

// --- Skill manifest metadata ------------------------------------------------

const WALK_MAX_FILES = 20_000;

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
 * escapes + line folding), or a block scalar (`|`, `>` and their chomping variants). A value
 * that is a nested map/list is treated as "". Never throws (falls back to the lenient parse on
 * any trouble). NOTE: the skill fingerprint is sha256 of the RAW SKILL.md bytes elsewhere
 * (index.ts `sha256(manifest)`), so this only shapes derived display/stored metadata.
 */
export function parseSkillFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
	// Normalize CRLF/CR to LF up front: the fence regex is LF-only, so a CRLF (or
	// lone-CR) SKILL.md would otherwise miss its frontmatter entirely — the `---`
	// block would leak into the body and every key/value/body line would keep a
	// trailing `\r`. After this a CRLF file parses identically to its LF twin.
	const normalized = raw.replace(/\r\n?/g, "\n");
	const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!m) return { fm: {}, body: normalized };
	const fm: Record<string, string> = {};
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
				fm[key] = ""; // empty scalar or a nested map/list (its indented lines are skipped)
				i++;
			} else {
				[fm[key], i] = readPlainScalar(rest, lines, i);
			}
		}
	} catch {
		// Malformed frontmatter: keep whatever parsed cleanly (lenient, never throws).
	}
	return { fm, body: m[2] };
}

const LICENSE_FILENAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.md"];

/** Normalize only import identity; retain instructions and source commit for review. */
export function normalizedRepositorySkill(raw: string, skillPath: string): { name: string; originalName?: string; manifest: string } {
	const { fm } = parseSkillFrontmatter(raw);
	const original = (fm.name || path.posix.basename(skillPath) || "skill").trim();
	const name = original.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "") || "skill";
	if (original === name) return { name, manifest: raw };
	const normalized = raw.replace(/\r\n?/g, "\n");
	const front = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	let manifest: string;
	if (front) {
		const document = parseDocument(front[1]);
		if (document.errors.length || !isMap(document.contents)) throw new Error("Skill metadata cannot be safely normalized; correct its YAML frontmatter at the source.");
		document.set("name", name);
		manifest = `---\n${document.toString()}---\n${front[2]}`;
	} else manifest = `---\nname: ${name}\n---\n${normalized}`;
	return { name, originalName: original, manifest };
}

// --- Checkout cache (scan → review → accept continuity) ----------------------
//
// A scan clones once and hands back a token; the review + accept steps reuse that
// same checkout via the token, so the body the user accepts is byte-identical to
// the body they reviewed (no re-clone, no upstream drift mid-flow). Entries
// expire after idle time and are removed from disk; a process-exit hook clears the rest.

const CHECKOUT_TTL_MS = 15 * 60_000;

interface CachedCheckout {
	dir: string;
	source: string;
	lastUsedAt: number;
	snapshot?: RepositorySnapshot;
}

const checkoutCache = new Map<string, CachedCheckout>();

export function removeCheckout(token: string): void {
	const entry = checkoutCache.get(token);
	if (!entry) return;
	checkoutCache.delete(token);
	const remaining = [...checkoutCache.entries()].find(([, candidate]) => candidate.dir === entry.dir);
	for (const [key, cachedToken] of sourceSnapshots) {
		if (cachedToken === token) {
			if (remaining?.[1].snapshot) sourceSnapshots.set(key, remaining[0]);
			else sourceSnapshots.delete(key);
		}
	}
	if (!remaining) fs.rmSync(entry.dir, { recursive: true, force: true });
}

/** Drop and delete expired checkouts. Called before each cache op. */
function sweepCheckouts(): void {
	const now = Date.now();
	for (const [token, entry] of checkoutCache) {
		if (now - entry.lastUsedAt > CHECKOUT_TTL_MS) removeCheckout(token);
	}
}

/** Register a fresh checkout and return its token. */
export function registerCheckout(dir: string, source: string): string {
	sweepCheckouts();
	const token = crypto.randomUUID();
	checkoutCache.set(token, { dir, source, lastUsedAt: Date.now() });
	return token;
}

/** Resolve a token to its live checkout dir + source, or null when expired/unknown. */
export function getCheckout(token: string): { dir: string; source: string } | null {
	sweepCheckouts();
	const entry = checkoutCache.get(String(token ?? ""));
	if (entry) entry.lastUsedAt = Date.now();
	return entry ? { dir: entry.dir, source: entry.source } : null;
}

/** Remove every cached checkout from disk (process-exit cleanup). */
export function disposeAllCheckouts(): void {
	for (const child of snapshotChildren) killProcessTree(child);
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
	missingTool?: boolean;
	source: string;
	author: string;
	token: string | null;
	skills: RepoFoundSkill[];
	revision?: string;
	files?: RepositoryFileEntry[];
	policy?: RepositoryFilePolicy;
	error?: string;
}

interface CachedFeatured {
	result: FeaturedSourceResult;
	fetchedAt: number;
}

const featuredCache = new Map<string, CachedFeatured>();
const featuredFetches = new Map<string, Promise<FeaturedSourceResult>>();

/**
 * Fetch + scan one featured source, memoised for `FEATURED_TTL_MS`. Any clone/scan
 * failure is captured as a per-card `error` rather than failing the whole pane.
 */
export async function loadFeaturedSource(entry: FeaturedSource): Promise<FeaturedSourceResult> {
	const running = featuredFetches.get(entry.source);
	if (running) return running;
	const operation = fetchFeaturedSource(entry);
	featuredFetches.set(entry.source, operation);
	try { return await operation; }
	finally { featuredFetches.delete(entry.source); }
}

async function fetchFeaturedSource(entry: FeaturedSource): Promise<FeaturedSourceResult> {
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
	// An older token may still serve an open review; its own idle TTL cleans it up.
	// Featured sources are config-controlled, not user input; local paths still ride
	// the same env gate as the scan endpoint so a smoke can override to a fixture.
	const resolved = resolveRepoSource(entry.source, { allowLocal: process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO === "1" });
	if (!resolved.ok) {
		const result: FeaturedSourceResult = { source: entry.source, author: entry.author, token: null, skills: [], error: resolved.error };
		featuredCache.set(entry.source, { result, fetchedAt: Date.now() });
		return result;
	}
	try {
		const scan = await scanRepository(entry.source, {}, undefined, process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO === "1", { forceRefresh: true });
		const result: FeaturedSourceResult = { ...scan, author: entry.author };
		featuredCache.set(entry.source, { result, fetchedAt: Date.now() });
		return result;
	} catch (err) {
		const missingTool = (err as { code?: string })?.code === "GIT_REQUIRED";
		const result: FeaturedSourceResult = { source: entry.source, author: entry.author, token: null, skills: [], error: err instanceof Error ? err.message : String(err), ...(missingTool ? { missingTool: true } : {}) };
		if (missingTool) featuredCache.delete(entry.source);
		else featuredCache.set(entry.source, { result, fetchedAt: Date.now() });
		return result;
	}
}

// Repository libraries use immutable Git objects instead of a checkout. The old
// helpers remain for local/upload callers; every HTTP repository import uses these.
interface RepositoryTreeFile { path: string; oid: string; mode: string }
interface RepositorySnapshot {
	access: RepositoryAccessContext;
	api?: PublicRepository;
	transport: "git" | "api";
	dir: string;
	observedAt: number;
	source: ResolvedRepoSource;
	signInArgs?: Promise<string[]>;
	revision: string;
	policy: RepositoryFilePolicy;
	libraryId?: string;
	files: RepositoryTreeFile[];
	bytes: RepositoryBlobCache;
	skills: RepoFoundSkill[];
}

/** Evicted bytes remain immutable Git objects in the same leased clone. */
export class RepositoryBlobCache extends Map<string, Buffer> {
	private byteSize = 0;
	constructor(private readonly maxBytes = 128 * 1024 * 1024) { super(); }
	override get(key: string): Buffer | undefined {
		const bytes = super.get(key);
		if (bytes) { super.delete(key); super.set(key, bytes); }
		return bytes;
	}
	override set(key: string, bytes: Buffer): this {
		this.delete(key);
		if (bytes.length > this.maxBytes) return this;
		while (this.byteSize + bytes.length > this.maxBytes) this.delete(this.keys().next().value!);
		super.set(key, bytes);
		this.byteSize += bytes.length;
		return this;
	}
	override delete(key: string): boolean {
		const bytes = super.get(key);
		if (bytes) this.byteSize -= bytes.length;
		return super.delete(key);
	}
	override clear(): void { super.clear(); this.byteSize = 0; }
}

const sourceSnapshots = new Map<string, string>();
const sourceScanOperations = new Map<string, Promise<RepositoryScan>>();
export interface RepositoryFileEntry {
	path: string;
	kind: ReferenceKind | null;
	allowed: boolean;
	reason?: string;
}
export interface RepositoryScan {
	transport: "git" | "api";
	accessId: string;
	token: string;
	source: string;
	ref?: string;
	libraryId?: string;
	revision: string;
	skills: RepoFoundSkill[];
	files: RepositoryFileEntry[];
	policy: RepositoryFilePolicy;
}
export interface ReviewedRepoSkillCandidate extends RepoSkillCandidate {
	/** Raw manifest is escaped by the local review UI, never interpreted as HTML. */
	manifest: string;
	revision: string;
	skillPath: string;
	references: Array<RepoReference & { preview?: string }>;
	reviewSha256: string;
}
const snapshotChildren = new Set<ChildProcess>();
let snapshotShutdown = false;
const repositoryBudget = new AsyncLocalStorage<number>();
const REPOSITORY_BUDGET_MS = 180_000;

export class RepositoryBudgetError extends Error {
	readonly statusCode = 504;
	constructor() { super("Repository operation exceeded its total time budget. The installed copy was preserved; retry the check or narrow the source."); }
}

/** Transport/process failures are source errors, not reviewable content changes. */
export class RepositoryFetchError extends Error {
	readonly statusCode = 502;
}

function remainingRepositoryBudget(): number {
	const deadline = repositoryBudget.getStore();
	const remaining = deadline === undefined ? REPOSITORY_BUDGET_MS : deadline - Date.now();
	if (remaining <= 0) throw new RepositoryBudgetError();
	return remaining;
}

export function assertRepositoryBudget(): void { remainingRepositoryBudget(); }

/** A nested operation shares its caller's deadline; parallel requests have independent scopes. */
export function withRepositoryBudget<T>(work: () => Promise<T>, budgetMs = REPOSITORY_BUDGET_MS): Promise<T> {
	if (!Number.isFinite(budgetMs) || budgetMs <= 0) return Promise.reject(new RepositoryBudgetError());
	const deadline = Math.min(repositoryBudget.getStore() ?? Infinity, Date.now() + budgetMs);
	return repositoryBudget.run(deadline, async () => {
		assertRepositoryBudget();
		const result = await work();
		assertRepositoryBudget();
		return result;
	});
}

/** Shutdown prevents queued lazy fetches from starting after cleanup. */
export function stopRepositoryFetches(): void {
	snapshotShutdown = true;
	for (const child of snapshotChildren) killProcessTree(child);
	disposeAllCheckouts();
}

const UNSUPPORTED_FILTER = /filtering not recognized|filter.*not supported|ignoring.*filter/i;
function unsupportedFilter(): Error {
	return Object.assign(new RepositoryFetchError("This host does not support filtered fetching. No full clone is downloaded."), { code: "REPOSITORY_FILTER_UNSUPPORTED", statusCode: 422 });
}

async function snapshotGit(snapshot: RepositorySnapshot, args: string[], maxBytes: number, timeoutMs = CLONE_TIMEOUT_MS, probeFilter = false): Promise<{ stdout: Buffer; stderr: string; filterSupported?: boolean }> {
	if (snapshotShutdown) throw new Error("repository fetching has stopped");
	assertRepositoryAccess(snapshot.access);
	assertRepositoryBudget();
	const token = snapshot.access.settings.mode === "session-token" ? repositoryTokenGit(snapshot.access) : null;
	const signIn = token?.args ?? await (snapshot.signInArgs ??= snapshot.source.kind === "git" && snapshot.access.settings.mode === "local-git" ? storedSignInArgs(snapshot.source.cloneArg) : Promise.resolve(["-c", "credential.helper="]));
	if (snapshotShutdown) throw new Error("repository fetching has stopped");
	const remaining = remainingRepositoryBudget();
	const effectiveTimeout = Math.min(timeoutMs, remaining);
	const env = hardenedGitEnv();
	Object.assign(env, token?.env);
	if (snapshot.access.settings.mode !== "local-git") isolateGitHome(env, snapshot.dir);
	if (/^(ssh:|git@)/i.test(snapshot.source.cloneArg)) env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes";
	// The person's config contributes credentials above, not executable filters or hooks.
	const gitNull = process.platform === "win32" ? "/dev/null" : os.devNull;
	env.GIT_CONFIG_GLOBAL = gitNull;
	delete env.GIT_CONFIG_PARAMETERS;
	delete env.GIT_CONFIG_COUNT;
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	// Capability traces stay in private memory; never include them in log files or API errors.
	// Git for Windows cannot inherit Node's extra pipe as a C-runtime file descriptor.
	if (probeFilter) env.GIT_TRACE_PACKET = process.platform === "win32" ? "2" : "3";
	return new Promise((resolve, reject) => {
		const child = spawn(resolveGitCommand(process.platform, env), [...signIn, ...(snapshot.access.settings.mode !== "anonymous" ? ["-c", "http.followRedirects=false"] : []), "-c", `core.hooksPath=${gitNull}`, "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=user", "-c", "core.symlinks=false", ...args], {
			cwd: snapshot.dir, env, stdio: probeFilter ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
		});
		snapshotChildren.add(child);
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = "";
		let stderrPending = "";
		let packetPending = "";
		let packetBytes = 0;
		let filterSupported = false;
		let failure: Error | undefined;
		const abort = (error: Error) => {
			if (failure) return;
			failure = error;
			killProcessTree(child);
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.stdio[3]?.destroy();
		};
		const timer = setTimeout(() => abort(effectiveTimeout === remaining ? new RepositoryBudgetError() : new RepositoryFetchError(`repository operation timed out after ${timeoutMs}ms`)), effectiveTimeout);
		const revoked = () => abort(repositoryAccessError("Repository access was removed."));
		snapshot.access.controller.signal.addEventListener("abort", revoked, { once: true });
		if (snapshot.access.controller.signal.aborted) revoked();
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) abort(new Error("repository output exceeds its safe limit"));
			else chunks.push(chunk);
		});
		const absorbPacket = (line: string) => {
			if (filterSupported) return;
			packetBytes += Buffer.byteLength(line);
			if (packetBytes > 64 * 1024) { abort(unsupportedFilter()); return; }
			const received = line.match(/packet:\s+\S+< (.*)$/)?.[1];
			const capabilities = received?.startsWith("fetch=") ? received.slice(6) : received?.match(/^[a-f0-9]{40,64} [^ ]+\\0(.*)$/)?.[1];
			filterSupported = capabilities?.split(" ").includes("filter") ?? false;
		};
		child.stdio[3]?.on("data", (chunk: Buffer) => {
			if (filterSupported) return;
			const lines = (packetPending + chunk.toString()).split("\n");
			packetPending = lines.pop()!;
			for (const line of lines) absorbPacket(line);
			if (filterSupported) packetPending = "";
			else if (packetBytes + Buffer.byteLength(packetPending) > 64 * 1024) abort(unsupportedFilter());
		});
		const absorbStderr = (line: string) => {
			if (probeFilter && /packet:/.test(line)) {
				absorbPacket(line);
				return;
			}
			stderr = (stderr + line + "\n").slice(-8192);
			if (snapshot.access.token) stderr = stderr.split(snapshot.access.token).join("[redacted]");
			if (args.includes("--filter=blob:none") && UNSUPPORTED_FILTER.test(stderr)) abort(unsupportedFilter());
		};
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrPending += chunk.toString();
			const lines = stderrPending.split("\n");
			stderrPending = lines.pop()!;
			for (const line of lines) absorbStderr(line);
			if (Buffer.byteLength(stderrPending) > 64 * 1024) abort(new RepositoryFetchError("Repository diagnostics exceed the safe limit."));
		});
		child.once("error", (error) => { clearTimeout(timer); snapshot.access.controller.signal.removeEventListener("abort", revoked); snapshotChildren.delete(child); reject(Object.assign(new RepositoryFetchError(error.message), { code: (error as NodeJS.ErrnoException).code })); });
		child.once("close", (code) => {
			if (stderrPending) absorbStderr(stderrPending);
			if (packetPending) absorbPacket(packetPending);
			clearTimeout(timer);
			snapshot.access.controller.signal.removeEventListener("abort", revoked);
			snapshotChildren.delete(child);
			try { assertRepositoryBudget(); } catch (error) { reject(error); return; }
			if (failure) reject(failure);
			else if (code !== 0) reject(repositoryFetchFailure(stderr, snapshot.source, snapshot.access.settings.mode === "session-token"));
			else resolve({ stdout: Buffer.concat(chunks), stderr, ...(probeFilter ? { filterSupported } : {}) });
		});
	});
}

async function readSnapshotBlob(snapshot: RepositorySnapshot, file: RepositoryTreeFile, maxBytes: number): Promise<Buffer> {
	assertRepositoryAccess(snapshot.access);
	assertRepositoryBudget();
	if (file.mode !== "100644" && file.mode !== "100755") throw new Error("symlinks, submodules and special entries are not permitted");
	normalizeRepoPath(file.path);
	const cached = snapshot.bytes.get(file.oid);
	if (cached) {
		if (cached.length > maxBytes) throw new Error("selected repository file exceeds its size limit");
		return cached;
	}
	const sizeText = snapshot.api ? undefined : (await snapshotGit(snapshot, ["cat-file", "-s", file.oid], 100)).stdout.toString().trim();
	if (sizeText !== undefined && (!/^\d+$/.test(sizeText) || Number(sizeText) > maxBytes)) throw new Error("selected repository file exceeds its size limit");
	const bytes = snapshot.api ? await snapshot.api.readBlob(file, maxBytes, AbortSignal.any([snapshot.access.controller.signal, AbortSignal.timeout(remainingRepositoryBudget())])) : (await snapshotGit(snapshot, ["cat-file", "blob", file.oid], maxBytes)).stdout;
	assertRepositoryAccess(snapshot.access);
	if (bytes.length > maxBytes || sizeText !== undefined && bytes.length !== Number(sizeText)) throw new Error("repository object size changed unexpectedly or exceeds its limit");
	// Hashing raw Git bytes also detects incomplete output before it can be reviewed.
	const algorithm = file.oid.length === 64 ? "sha256" : "sha1";
	if (crypto.createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.oid) throw new Error("repository object failed its integrity check");
	snapshot.bytes.set(file.oid, bytes);
	return bytes;
}

/** Fetch only approved object IDs together instead of one network round trip per file. */
async function prefetchSnapshotFiles(snapshot: RepositorySnapshot, files: RepositoryTreeFile[]): Promise<void> {
	assertRepositoryAccess(snapshot.access);
	if (snapshot.api) return;
	const oids = [...new Set(files.filter((file) => !snapshot.bytes.has(file.oid)).map((file) => {
		if ((file.mode !== "100644" && file.mode !== "100755") || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.oid)) throw new Error("invalid repository object");
		normalizeRepoPath(file.path);
		return file.oid;
	}))];
	// Keep Git's argument list comfortably below Windows' command-line limit.
	for (let offset = 0; offset < oids.length; offset += 100) {
		reportRepositoryProgress("Fetching selected Git objects", offset, oids.length);
		await snapshotGit(snapshot, ["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "origin", ...oids.slice(offset, offset + 100)], 4096);
		reportRepositoryProgress("Fetching selected Git objects", Math.min(offset + 100, oids.length), oids.length);
	}
}

function snapshotFile(snapshot: RepositorySnapshot, repoPath: string): RepositoryTreeFile {
	const normalized = normalizeRepoPath(repoPath);
	const file = snapshot.files.find((entry) => entry.path === normalized);
	if (!file) throw new Error(`selected reference is not present: ${normalized}`);
	return file;
}

async function snapshotLicense(snapshot: RepositorySnapshot): Promise<string | null> {
	for (const name of LICENSE_FILENAMES) {
		const file = snapshot.files.find((entry) => entry.path === name && (entry.mode === "100644" || entry.mode === "100755"));
		if (!file) continue;
		try {
			const head = validatedReferenceText(await readSnapshotBlob(snapshot, file, REFERENCE_TEXT_MAX_BYTES)).slice(0, 2048).toUpperCase();
			if (/\bAPACHE LICENSE\b/.test(head) && head.includes("2.0")) return "Apache-2.0";
			if (/\bMIT LICENSE\b|PERMISSION IS HEREBY GRANTED, FREE OF CHARGE/.test(head)) return "MIT";
			if (/\bISC LICENSE\b/.test(head)) return "ISC";
			if (/\bMOZILLA PUBLIC LICENSE\b/.test(head)) return "MPL-2.0";
			if (/GNU GENERAL PUBLIC LICENSE/.test(head)) return head.includes("VERSION 3") ? "GPL-3.0" : "GPL-2.0";
			return "see LICENSE";
		} catch (error) {
			if (error instanceof RepositoryFetchError || error instanceof RepositoryBudgetError || String((error as any)?.code ?? "").startsWith("REPOSITORY_")) throw error;
			return null;
		}
	}
	return null;
}

function snapshotFileEntry(snapshot: RepositorySnapshot, entry: RepositoryTreeFile): RepositoryFileEntry {
	const permission = referencePathPermission(entry.path, snapshot.policy);
	if (entry.mode !== "100644" && entry.mode !== "100755") return { path: entry.path, kind: permission.kind, allowed: false, reason: "symlink, submodule or special entry" };
	if (!repositoryPathWithin(entry.path, snapshot.policy.skillRoot) && !snapshot.policy.referenceRoots.some((root) => repositoryPathWithin(entry.path, root))) return { path: entry.path, kind: permission.kind, allowed: false, reason: "outside approved repository directories" };
	return { path: entry.path, ...permission };
}

function filesForSnapshot(snapshot: RepositorySnapshot): RepositoryFileEntry[] {
	return snapshot.files.map((entry) => snapshotFileEntry(snapshot, entry));
}

/** Clone without a checkout, discover only manifests and leave all reference contents unread. */
export interface RepositoryScanOptions { forceRefresh?: boolean; token?: string; accessId?: string; repositoryAccess?: RepositoryAccessSettings }

function resolvedSnapshotSource(source: string, allowLocal: boolean): ResolvedRepoSource {
	const localWithRef = allowLocal && looksLikeLocalPath(source.split("#")[0]) && source.includes("#");
	const resolved = resolveRepoSource(localWithRef ? source.split("#")[0] : source, { allowLocal });
	if (!resolved.ok) throw new Error(resolved.error);
	if (localWithRef) {
		const ref = source.slice(source.indexOf("#") + 1);
		if (!ref || ref.startsWith("-") || SHELL_META.test(ref)) throw new Error("invalid git ref");
		resolved.value.ref = ref;
	}
	return resolved.value;
}

function sourceSnapshotKey(source: ResolvedRepoSource): string {
	let address = source.cloneArg;
	if (source.kind === "local") address = process.platform === "win32" ? path.resolve(address).toLowerCase() : path.resolve(address);
	else if (address.startsWith("git@")) address = address.replace(/^(git@[^:]+)/, (host) => host.toLowerCase()).replace(/\/+$/, "").replace(/\.git$/, "");
	else {
		const url = new URL(address);
		url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
		address = url.href;
	}
	return JSON.stringify([source.kind, address, source.ref ?? null]);
}

export async function scanRepository(source: string, policyRaw: unknown = {}, libraryId?: string, allowLocal = false, options: RepositoryScanOptions = {}): Promise<RepositoryScan> {
	return withRepositoryBudget(async () => {
		const policy = normalizeRepositoryFilePolicy(policyRaw);
		const resolved = resolvedSnapshotSource(source, allowLocal);
		if (resolved.kind === "git" && resolved.cloneArg !== resolved.display) throw new Error("Repository addresses must not contain credentials; choose repository access separately.");
		const access = resolveRepositoryAccess(resolved.cloneArg, libraryId, options.repositoryAccess, options.accessId);
		if (/^(ssh:|git@)/i.test(resolved.cloneArg) && access.settings.mode !== "local-git") throw repositoryAccessError("SSH needs permission to use local Git/SSH access. Use HTTPS for anonymous access.");
		const key = JSON.stringify([sourceSnapshotKey(resolved), access.id]);
		if (options.token && !options.forceRefresh) {
			reportRepositoryProgress("Using saved repository structure");
			const snapshot = getRepositorySnapshot(options.token);
			if (sourceSnapshotKey(snapshot.source) !== sourceSnapshotKey(resolved) || snapshot.access.id !== access.id) throw new Error("The cached snapshot belongs to another source, branch or access context.");
			return reconfigureRepositoryScan(options.token, policy, libraryId, resolved.display);
		}
		sweepCheckouts();
		let running = sourceScanOperations.get(key);
		const cached = sourceSnapshots.get(key);
		if (!running && cached && !options.forceRefresh) { reportRepositoryProgress("Using saved repository structure"); return reconfigureRepositoryScan(cached, policy, libraryId, resolved.display); }
		if (running) reportRepositoryProgress("Waiting for the repository scan already running");
		if (!running) {
			running = scanRepositorySnapshot(resolved, policy, libraryId, access);
			sourceScanOperations.set(key, running);
			void running.then((scan) => { sourceSnapshots.set(key, scan.token); }, () => {}).finally(() => { if (sourceScanOperations.get(key) === running) sourceScanOperations.delete(key); });
		}
		const scan = await running;
		return reconfigureRepositoryScan(scan.token, policy, libraryId, resolved.display);
	});
}

async function scanRepositorySnapshot(source: ResolvedRepoSource, policyRaw: unknown, libraryId: string | undefined, access: RepositoryAccessContext): Promise<RepositoryScan> {
	const policy = normalizeRepositoryFilePolicy(policyRaw);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skill-repo-"));
	const snapshot: RepositorySnapshot = { dir, observedAt: Date.now(), source, access, transport: "git", revision: "", policy, libraryId, files: [], bytes: new RepositoryBlobCache(), skills: [] };
	try {
		reportRepositoryProgress("Connecting and reading repository structure");
		const args = ["clone", "--depth", "1", "--no-tags", "--single-branch", "--no-recurse-submodules", "--no-checkout", "--filter=blob:none"];
		if (source.kind === "local") args.push("--no-local");
		if (source.ref) args.push("--branch", source.ref);
		args.push("--", source.cloneArg, dir);
		let fallback = false;
		const gitMissing = !await repositoryGitAvailable();
		if (gitMissing) fallback = true;
		else {
			try {
				const capabilities = await snapshotGit(snapshot, ["-c", "protocol.version=2", "ls-remote", "--symref", "--", source.cloneArg, "HEAD"], 4096, CLONE_TIMEOUT_MS, true);
				if (!capabilities.filterSupported) fallback = true;
				else await snapshotGit(snapshot, args, 4096);
			} catch (error) {
				if ((error as any)?.code === "ENOENT" || (error as any)?.code === "REPOSITORY_FILTER_UNSUPPORTED") fallback = true;
				else throw error;
			}
		}
		if (fallback) {
			if (source.kind !== "git" || access.settings.mode !== "anonymous") throw Object.assign(new Error(gitMissing ? gitMissingMessage() : "This host does not support filtered fetching. Private API fallback is not available; no full clone is downloaded."), { code: gitMissing ? "GIT_REQUIRED" : "REPOSITORY_FILTER_UNSUPPORTED", statusCode: 422 });
			reportRepositoryProgress("Reading repository through the anonymous public API");
			snapshot.api = await loadPublicRepository(source, access.settings, AbortSignal.any([access.controller.signal, AbortSignal.timeout(remainingRepositoryBudget())]));
			snapshot.transport = "api"; snapshot.revision = snapshot.api.revision; snapshot.files = snapshot.api.files;
			snapshot.observedAt = Date.now();
		} else {
		snapshot.revision = (await snapshotGit(snapshot, ["rev-parse", "HEAD"], 100)).stdout.toString().trim();
		snapshot.observedAt = Date.now();
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.revision)) throw new Error("repository returned an invalid commit");
		const tree = (await snapshotGit(snapshot, ["ls-tree", "-r", "-z", snapshot.revision], 4 * 1024 * 1024)).stdout;
		const records = new TextDecoder("utf-8", { fatal: true }).decode(tree).split("\0").filter(Boolean);
		if (records.length > WALK_MAX_FILES) throw new Error("repository tree exceeds the 20000-file limit; use a dedicated skill repository");
		snapshot.files = records.map((record) => {
			const match = record.match(/^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/);
			if (!match) throw new Error("repository returned an invalid tree entry");
			return { mode: match[1], oid: match[2], path: match[3] };
		});
		}
		assertRepositoryAccess(access);
		reportRepositoryProgress("Repository entries found", snapshot.files.length, snapshot.files.length);
		snapshot.skills = await discoverSnapshotSkills(snapshot);
		assertRepositoryBudget();
		assertRepositoryAccess(access);
		const token = registerCheckout(dir, source.display);
		checkoutCache.get(token)!.snapshot = snapshot;
		return repositoryScanFromToken(token);
	} catch (error) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
		throw error;
	}
}

async function discoverSnapshotSkills(snapshot: RepositorySnapshot): Promise<RepoFoundSkill[]> {
	const manifests = snapshot.files.filter((entry) => (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")) && repositoryPathWithin(entry.path, snapshot.policy.skillRoot) && !entry.path.split("/").includes("node_modules") && (entry.mode === "100644" || entry.mode === "100755"));
	if (manifests.length > REFERENCE_PACKAGE_MAX_FILES) throw new Error("repository contains too many skill manifests; narrow the skill directory");
	const safeManifests = manifests.filter((file) => { try { normalizeRepoPath(file.path); return true; } catch { return false; } });
	const licensePath = LICENSE_FILENAMES.find((name) => snapshot.files.some((entry) => entry.path === name && (entry.mode === "100644" || entry.mode === "100755")));
	await prefetchSnapshotFiles(snapshot, licensePath ? [...safeManifests, snapshotFile(snapshot, licensePath)] : safeManifests);
	const repoLicense = await snapshotLicense(snapshot);
	const repositoryPaths = new Set(snapshot.files.map((file) => file.path));
	const skills: RepoFoundSkill[] = [];
	reportRepositoryProgress("Reading skill instructions", 0, safeManifests.length);
	for (const file of safeManifests) {
		const raw = validatedReferenceText(await readSnapshotBlob(snapshot, file, REFERENCE_TEXT_MAX_BYTES));
		const { fm } = parseSkillFrontmatter(raw);
		const skillPath = path.posix.dirname(file.path) === "." ? "" : path.posix.dirname(file.path);
		const identity = normalizedRepositorySkill(raw, skillPath);
		skills.push({ path: skillPath, name: identity.name, ...(identity.originalName ? { originalName: identity.originalName } : {}), description: (fm.description || "").trim(), license: fm.license?.trim() || repoLicense, hasBundledScripts: snapshot.files.some((entry) => repositoryPathWithin(entry.path, skillPath) && !classifyReferencePath(entry.path)), referencePaths: skillMarkdownReferences(raw, skillPath, repositoryPaths) });
		reportRepositoryProgress("Reading skill instructions", skills.length, safeManifests.length);
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function getRepositorySnapshot(token: string): RepositorySnapshot {
	sweepCheckouts();
	const entry = checkoutCache.get(token);
	if (!entry?.snapshot) {
		const error = new Error("repository snapshot expired; scan the repository again");
		(error as Error & { statusCode: number }).statusCode = 404;
		(error as Error & { code: string }).code = "REPOSITORY_SNAPSHOT_EXPIRED";
		throw error;
	}
	entry.lastUsedAt = Date.now();
	assertRepositoryAccess(entry.snapshot.access);
	return entry.snapshot;
}

export function repositorySnapshotObservedAt(token: string): number { return getRepositorySnapshot(token).observedAt; }

export function repositoryScanFromToken(token: string): RepositoryScan {
	const snapshot = getRepositorySnapshot(token);
	return { token, source: snapshot.source.display, ref: snapshot.source.ref, libraryId: snapshot.libraryId, revision: snapshot.revision, skills: snapshot.skills, files: filesForSnapshot(snapshot), policy: snapshot.policy, transport: snapshot.transport, accessId: snapshot.access.id };
}

onRepositoryAccessRevoked((context) => {
	for (const [token, cached] of [...checkoutCache]) if (cached.snapshot?.access.id === context.id) { try { removeCheckout(token); } catch {} }
	for (const [source, cached] of featuredCache) if (!getCheckout(cached.result.token ?? "")) featuredCache.delete(source);
});

/** A new permission context keeps earlier reviews bound to their original policy. */
export async function reconfigureRepositoryScan(token: string, policyRaw: unknown, libraryId?: string, display?: string): Promise<RepositoryScan> {
	const current = getRepositorySnapshot(token);
	const policy = normalizeRepositoryFilePolicy(policyRaw);
	// Every consumer owns a token: a background check must not revoke an open browser's lease.
	const snapshot = { ...current, source: { ...current.source, display: display ?? current.source.display }, policy, libraryId };
	if (policy.skillRoot !== current.policy.skillRoot) snapshot.skills = await discoverSnapshotSkills(snapshot);
	const derived = registerCheckout(snapshot.dir, snapshot.source.display);
	checkoutCache.get(derived)!.snapshot = snapshot;
	return repositoryScanFromToken(derived);
}

function permittedMaterialFile(snapshot: RepositorySnapshot, rawPath: string): RepositoryTreeFile {
	const file = snapshotFile(snapshot, rawPath);
	if (file.path.split("/").at(-1)?.toLowerCase() === "skill.md") throw new Error("skill manifests are separate instructions, not source materials");
	const permission = referencePathPermission(file.path, snapshot.policy);
	if (!permission.allowed) throw new Error(permission.reason ?? "reference type is not permitted");
	if (!repositoryPathWithin(file.path, snapshot.policy.skillRoot) && !snapshot.policy.referenceRoots.some((root) => repositoryPathWithin(file.path, root))) throw new Error("reference is outside approved repository directories");
	if (file.mode !== "100644" && file.mode !== "100755") throw new Error("symlinks, submodules and special entries are not permitted");
	return file;
}

export async function prefetchRepositoryMaterials(token: string, paths: string[]): Promise<void> {
	return withRepositoryBudget(async () => {
		if (!Array.isArray(paths) || paths.length > 2000) throw new Error("invalid source material selection");
		const snapshot = getRepositorySnapshot(token);
		const files = paths.map((entry) => permittedMaterialFile(snapshot, entry));
		let total = 0;
		let completed = 0;
		reportRepositoryProgress("Reading selected references", completed, files.length);
		// Git trees contain no sizes; inspecting each object avoids eagerly fetching the whole selection.
		for (const file of files) {
			const material = await readRepositoryMaterial(token, file.path);
			total += material.bytes.length;
			if (total > 128 * 1024 * 1024) throw new Error("selected source materials exceed the 128 MiB limit");
			reportRepositoryProgress("Reading selected references", ++completed, files.length);
		}
	});
}

/** Only permitted inert materials; immutable object hashes remain authoritative after eviction. */
export async function readRepositoryMaterial(token: string, repoPath: string): Promise<{ path: string; bytes: Buffer; kind: ReferenceKind; mimeType: string; preview?: string }> {
	return withRepositoryBudget(async () => {
		const snapshot = getRepositorySnapshot(token);
		const file = permittedMaterialFile(snapshot, repoPath);
		const kind = classifyReferencePath(file.path)!;
		const max = ["markdown", "text", "styles", "html", "svg"].includes(kind) ? REFERENCE_TEXT_MAX_BYTES : REFERENCE_ASSET_MAX_BYTES;
		const bytes = await readSnapshotBlob(snapshot, file, max);
		const validated = await validateReferenceBuffer(file.path, bytes, snapshot.policy);
		return { path: file.path, bytes: Buffer.from(bytes), ...validated };
	});
}

async function prepareSnapshotSkill(snapshot: RepositorySnapshot, skillPathRaw: string, referencesRaw: string[]): Promise<{ candidate: ReviewedRepoSkillCandidate; files: Array<{ localPath: string; bytes: Buffer }>; repo: SkillRepoProvenance }> {
	assertRepositoryBudget();
	const skillPath = normalizeRepoPath(skillPathRaw, true);
	const discovered = snapshot.skills.find((skill) => skill.path === skillPath);
	if (!discovered) throw new Error("skill not found in the reviewed snapshot");
	if (!Array.isArray(referencesRaw) || referencesRaw.length >= REFERENCE_PACKAGE_MAX_FILES || referencesRaw.some((entry) => typeof entry !== "string")) throw new Error("invalid reference selection");
	const references = referencesRaw.map((entry) => normalizeRepoPath(entry));
	if (new Set(references).size !== references.length) throw new Error("duplicate reference selection");
	const manifestPath = skillPath ? `${skillPath}/SKILL.md` : "SKILL.md";
	const identity = normalizedRepositorySkill(validatedReferenceText(await readSnapshotBlob(snapshot, snapshotFile(snapshot, manifestPath), REFERENCE_TEXT_MAX_BYTES)), skillPath);
	const raw = identity.manifest;
	const manifest = Buffer.from(raw);
	const { fm, body } = parseSkillFrontmatter(raw);
	const files: Array<{ localPath: string; bytes: Buffer }> = [{ localPath: "SKILL.md", bytes: manifest }];
	const selected: Array<RepoReference & { preview?: string }> = [];
	const targets = new Set(["skill.md", "provenance.json"]);
	let total = manifest.length;
	const chosen = references.sort().map((repoPath) => {
		if (repoPath === manifestPath || snapshot.skills.some((skill) => skill.path !== skillPath && skill.path !== "" && repositoryPathWithin(repoPath, skill.path) && repositoryPathWithin(`${skill.path}/SKILL.md`, skillPath))) throw new Error("nested skills cannot be imported as references");
		if (!repositoryPathWithin(repoPath, skillPath) && !snapshot.policy.referenceRoots.some((root) => repositoryPathWithin(repoPath, root))) throw new Error("reference is outside the skill and approved reference directories");
		const permission = referencePathPermission(repoPath, snapshot.policy);
		if (!permission.allowed) throw new Error(permission.reason ?? "reference type is not permitted");
		const file = snapshotFile(snapshot, repoPath);
		const max = ["markdown", "text", "styles", "html", "svg"].includes(permission.kind ?? "") ? REFERENCE_TEXT_MAX_BYTES : REFERENCE_ASSET_MAX_BYTES;
		return { repoPath, file, max };
	});
	await prefetchSnapshotFiles(snapshot, chosen.map(({ file }) => file));
	reportRepositoryProgress("Checking skill reference files", 0, chosen.length);
	for (const { repoPath, file, max } of chosen) {
		const bytes = await readSnapshotBlob(snapshot, file, max);
		const validated = await validateReferenceBuffer(repoPath, bytes, snapshot.policy);
		const localPath = referenceLocalPath(repoPath, skillPath);
		normalizeRepoPath(localPath);
		const folded = localPath.toLowerCase();
		if (targets.has(folded) || Array.from(targets).some((target) => target.startsWith(`${folded}/`) || folded.startsWith(`${target}/`))) throw new Error("reference paths collide inside the package");
		targets.add(folded);
		total += bytes.length;
		if (total > REFERENCE_PACKAGE_MAX_BYTES) throw new Error("selected skill package exceeds the 64 MiB limit");
		selected.push({ path: repoPath, localPath, kind: validated.kind, size: bytes.length, sha256: referenceBytesSha256(bytes), ...(validated.preview !== undefined ? { preview: validated.preview } : {}) });
		files.push({ localPath, bytes });
		reportRepositoryProgress("Checking skill reference files", selected.length, chosen.length);
	}
	const repo: SkillRepoProvenance = { ...(snapshot.libraryId ? { libraryId: snapshot.libraryId } : {}), source: snapshot.source.display, ...(snapshot.source.ref ? { ref: snapshot.source.ref } : {}), revision: snapshot.revision, skillPath, policy: snapshot.policy, references: selected.map(({ preview: _preview, ...entry }) => entry) };
	const reviewSha256 = referenceBytesSha256(Buffer.from(JSON.stringify({ repo, manifestSha256: referenceBytesSha256(manifest) })));
	return { candidate: { name: identity.name, originalName: identity.originalName, description: (fm.description || "").trim(), body: body.trim(), manifest: raw, source: snapshot.source.display, license: fm.license?.trim() || discovered.license, scanFindings: scanInvisibleUnicode([body, fm.description || "", ...selected.map((entry) => entry.preview ?? "")].join("\n")), bundledScripts: [], revision: snapshot.revision, skillPath, references: selected, reviewSha256 }, files, repo };
}

export async function fetchRepoCandidate(token: string, skillPath: string, references: string[] = []): Promise<ReviewedRepoSkillCandidate> {
	return withRepositoryBudget(async () => (await prepareSnapshotSkill(getRepositorySnapshot(token), skillPath, references)).candidate);
}

export async function importReviewedRepoSkill(token: string, skillPath: string, references: string[], reviewSha256: string, destDir: string): Promise<{ provenance: SkillProvenance; bundledCopied: number; body: string; license: string | null }> {
	const prepared = await withRepositoryBudget(() => prepareSnapshotSkill(getRepositorySnapshot(token), skillPath, references));
	if (!reviewSha256 || prepared.candidate.reviewSha256 !== reviewSha256) throw new Error("the selected package must be reviewed again before import");
	const existingDestination = fs.existsSync(destDir);
	if (existingDestination && (!fs.lstatSync(destDir).isDirectory() || fs.lstatSync(destDir).isSymbolicLink() || fs.readdirSync(destDir).length > 0)) throw new Error("skill destination already exists");
	fs.mkdirSync(path.dirname(destDir), { recursive: true, mode: 0o700 });
	// HTTP callers already supply private staging; replacing that fresh directory can fail on Windows.
	const staging = existingDestination ? destDir : fs.mkdtempSync(path.join(path.dirname(destDir), ".skill-import-"));
	let completed = false;
	try {
		for (const file of prepared.files) {
			const target = path.join(staging, file.localPath);
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			fs.writeFileSync(target, file.bytes, { mode: 0o600, flag: "wx" });
		}
		const provenance: SkillProvenance = { source: prepared.repo.source, importedAt: new Date().toISOString(), license: prepared.candidate.license, sha256: referenceBytesSha256(prepared.files[0].bytes), repo: prepared.repo };
		if (!existingDestination) fs.renameSync(staging, destDir);
		completed = true;
		return { provenance, bundledCopied: prepared.candidate.references.length, body: prepared.candidate.body, license: prepared.candidate.license };
	} finally {
		if (!completed && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
	}
}

/** Metadata-only provenance for an update review, produced from its live immutable token. */
export async function repoCandidateProvenance(token: string, skillPath: string, references: string[]): Promise<SkillRepoProvenance> {
	return withRepositoryBudget(async () => (await prepareSnapshotSkill(getRepositorySnapshot(token), skillPath, references)).repo);
}

/** Human-initiated inspection only; never selects, imports or executes a file. */
export async function previewRepoFile(token: string, reference: string) {
	return withRepositoryBudget(async () => {
		const snapshot = getRepositorySnapshot(token);
		const file = snapshotFile(snapshot, reference);
		const manifest = snapshot.skills.some((skill) => file.path === (skill.path ? `${skill.path}/SKILL.md` : "SKILL.md"));
		const permission = snapshotFileEntry(snapshot, file);
		if (!manifest && !permission.allowed) throw new Error(permission.reason ?? "File is not permitted.");
		const kind = permission.kind;
		const max = kind && ["images", "pdf", "word", "excel", "fonts"].includes(kind) ? REFERENCE_ASSET_MAX_BYTES : REFERENCE_TEXT_MAX_BYTES;
		return skillFilePreview(file.path, await readSnapshotBlob(snapshot, file, max));
	});
}

/** Human preview/download only; returns validated bytes from the same review snapshot. */
export async function readRepoReference(token: string, skillPath: string, reference: string): Promise<{ bytes: Buffer; name: string; mimeType: string }> {
	return withRepositoryBudget(async () => {
		const snapshot = getRepositorySnapshot(token);
		const prepared = await prepareSnapshotSkill(snapshot, skillPath, [reference]);
		const file = prepared.files[1];
		const validation = await validateReferenceBuffer(reference, file.bytes, snapshot.policy);
		return { bytes: file.bytes, name: path.posix.basename(reference), mimeType: validation.mimeType };
	});
}
