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
 *     submodules never recursed, credential prompts disabled, transports
 *     allow-listed;
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
import { filterRepoScanSkillFiles, scanInvisibleUnicode, type InvisibleUnicodeScan } from "./skills-import.js";

/** A skill discovered in a cloned repo (the multi-select list row, spec §3). */
export interface RepoFoundSkill {
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
	/** Human-readable source recorded in provenance and shown in the UI. */
	display: string;
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
		return { ok: true, value: { kind: "git", cloneArg: urlPart, ref, display: urlPart } };
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
	if (parsed.hostname.startsWith("-") || SHELL_META.test(parsed.hostname) || parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean).length < 2) {
		return { ok: false, error: "expected a git URL with a user/repo path" };
	}
	return { ok: true, value: { kind: "git", cloneArg, ref, display: cloneArg } };
}

function finishLocal(localPath: string, allowLocal?: boolean): { ok: true; value: ResolvedRepoSource } | { ok: false; error: string } {
	if (!allowLocal) return { ok: false, error: "local repository paths are not permitted" };
	if (localPath.startsWith("-")) return { ok: false, error: "invalid local path" };
	if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) return { ok: false, error: "local path is not a directory" };
	return { ok: true, value: { kind: "local", cloneArg: localPath, display: localPath } };
}

// --- Shallow clone -----------------------------------------------------------

const CLONE_TIMEOUT_MS = 90_000;

function runGit(args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		// Hardened environment: no credential prompts, no system/global config, no
		// hooks or templates, transports allow-listed (file: included for local
		// smoke repos). Hooks are never fetched from a remote, but a poisoned
		// template dir is closed off too, belt-and-braces.
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TEMPLATE_DIR: "",
			GIT_ALLOW_PROTOCOL: "https:http:ssh:git:file",
			GCM_INTERACTIVE: "never",
		};
		let child: ChildProcess;
		try {
			child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], env });
		} catch (err) {
			reject(err);
			return;
		}
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
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
				reject(new Error(`git clone timed out after ${timeoutMs}ms`));
				return;
			}
			resolve({ code: code ?? -1, stderr: stderr.trim() });
		});
	});
}

/**
 * Shallow-clone a validated source into a fresh temp directory and return its
 * path. Depth 1, no tags, single branch, submodules NOT recursed, hooks/templates
 * neutralized. On any failure the temp dir is removed and an Error is thrown.
 */
export async function cloneRepoShallow(source: ResolvedRepoSource): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skill-repo-"));
	const args = [
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
		"clone",
		"--depth",
		"1",
		"--no-tags",
		"--single-branch",
		"--no-recurse-submodules",
	];
	if (source.ref) args.push("--branch", source.ref);
	// `--` terminates option parsing: neither the repo arg nor the target can be
	// read as a git flag even if it somehow began with "-".
	args.push("--", source.cloneArg, dir);
	try {
		const result = await runGit(args, CLONE_TIMEOUT_MS);
		if (result.code !== 0) throw new Error(result.stderr || `git clone exited with code ${result.code}`);
		return dir;
	} catch (err) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw err instanceof Error ? err : new Error(String(err));
	}
}

// --- Discovery / scan --------------------------------------------------------

const WALK_MAX_FILES = 20_000;
const VENDOR_MAX_BYTES = 8 * 1024 * 1024;
const VENDOR_MAX_FILES = 500;

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

/** Best-effort SPDX-ish label from a repo's root LICENSE file, or null. */
function detectRepoLicense(root: string): string | null {
	for (const name of LICENSE_FILENAMES) {
		const raw = readRegularFileWithin(root, path.join(root, name));
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
 * Non-.md files bundled inside a skill's OWN dir (relative to that dir). A
 * root-level SKILL.md (skillDir === "") has no bounded package — the "skill dir"
 * would be the whole repository — so it reports (and vendors) no bundled files;
 * only sub-directory skills carry a real, scoped bundle.
 */
function bundledScriptsFor(root: string, skillDir: string): string[] {
	if (skillDir === "" || skillDir === ".") return [];
	return walkFiles(path.join(root, skillDir)).filter((rel) => !rel.toLowerCase().endsWith(".md"));
}

/** True when the resolved skill dir is the checkout root (a root-level SKILL.md). */
function isRootSkillDir(checkoutDir: string, srcDir: string): boolean {
	return path.resolve(srcDir) === path.resolve(checkoutDir);
}

/**
 * Discover the true `SKILL.md` skills in a checkout (spec §3): loader discovery
 * rules MINUS the root-`.md`-as-skill rule (MR-1 `filterRepoScanSkillFiles`), so
 * obra/superpowers yields exactly its skills and README/docs are excluded.
 */
export function scanRepoSkills(checkoutDir: string): RepoFoundSkill[] {
	const repoLicense = detectRepoLicense(checkoutDir);
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
		const name = (fm.name || path.posix.basename(skillDir) || "skill").trim();
		const scripts = bundledScriptsFor(checkoutDir, skillDir);
		found.push({
			path: skillDir,
			name,
			description: (fm.description || "").trim(),
			license: fm.license?.trim() || repoLicense,
			hasBundledScripts: scripts.length > 0,
		});
	}
	return found.sort((a, b) => a.name.localeCompare(b.name));
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

/** Build the review-screen candidate for a chosen skill (runs the invisible-unicode scan). */
export function readRepoCandidate(checkoutDir: string, skillPath: string, source: string): RepoSkillCandidate | null {
	const dir = resolveSkillDir(checkoutDir, skillPath);
	if (!dir) return null;
	const raw = readRegularFileWithin(path.resolve(checkoutDir), path.join(dir, "SKILL.md"));
	if (raw == null) return null;
	const { fm, body } = parseSkillFrontmatter(raw);
	const trimmedBody = body.trim();
	const rel = path.relative(checkoutDir, dir).replace(/\\/g, "/");
	return {
		name: (fm.name || path.posix.basename(rel) || "skill").trim(),
		description: (fm.description || "").trim(),
		body: trimmedBody,
		source,
		license: fm.license?.trim() || detectRepoLicense(checkoutDir),
		scanFindings: scanInvisibleUnicode(`${trimmedBody}\n${(fm.description || "").trim()}`),
		bundledScripts: bundledScriptsFor(checkoutDir, rel),
	};
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
 * `<store>/<id>`). Copies SKILL.md plus any bundled files — as INERT files:
 * D-exec guarantees they never run, but keeping them lets the prose reference its
 * own assets and makes the multi-file skill dir the delete path must handle real.
 * Symlinks and `.git` are skipped; total size/file count are capped. Caller writes
 * the provenance sidecar (via MR-1 machinery). Returns the persisted body so the
 * caller can hash exactly what landed on disk.
 */
export function vendorRepoSkill(checkoutDir: string, skillPath: string, destSkillDir: string): VendorResult {
	const srcDir = resolveSkillDir(checkoutDir, skillPath);
	if (!srcDir) throw new Error("skill not found in checkout");
	// A root-level SKILL.md has no bounded package dir (the "dir" is the whole
	// repo), so vendor ONLY the manifest — never copy the entire repository.
	const files = isRootSkillDir(checkoutDir, srcDir) ? ["SKILL.md"] : walkFiles(srcDir);
	if (files.length > VENDOR_MAX_FILES) throw new Error(`skill directory has too many files (${files.length})`);
	let total = 0;
	for (const f of files) {
		const stat = fs.statSync(path.join(srcDir, f));
		total += stat.size;
		if (total > VENDOR_MAX_BYTES) throw new Error("skill directory is too large to import");
	}
	fs.mkdirSync(destSkillDir, { recursive: true, mode: 0o700 });
	let bundledCopied = 0;
	for (const f of files) {
		const dest = path.join(destSkillDir, f);
		fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
		fs.copyFileSync(path.join(srcDir, f), dest);
		fs.chmodSync(dest, 0o600);
		if (f !== "SKILL.md") bundledCopied += 1;
	}
	const raw = fs.readFileSync(path.join(destSkillDir, "SKILL.md"), "utf-8");
	const { fm, body } = parseSkillFrontmatter(raw);
	return { body: body.trim(), license: fm.license?.trim() || detectRepoLicense(checkoutDir), bundledCopied };
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
export function registerCheckout(dir: string, source: string): string {
	sweepCheckouts();
	const token = crypto.randomUUID();
	checkoutCache.set(token, { dir, source, createdAt: Date.now() });
	return token;
}

/** Resolve a token to its live checkout dir + source, or null when expired/unknown. */
export function getCheckout(token: string): { dir: string; source: string } | null {
	sweepCheckouts();
	const entry = checkoutCache.get(String(token ?? ""));
	return entry ? { dir: entry.dir, source: entry.source } : null;
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
		const dir = await cloneRepoShallow(resolved.value);
		const token = registerCheckout(dir, resolved.value.display);
		const result: FeaturedSourceResult = { source: entry.source, author: entry.author, token, skills: scanRepoSkills(dir) };
		featuredCache.set(entry.source, { result, fetchedAt: Date.now() });
		return result;
	} catch (err) {
		const result: FeaturedSourceResult = { source: entry.source, author: entry.author, token: null, skills: [], error: err instanceof Error ? err.message : String(err) };
		featuredCache.set(entry.source, { result, fetchedAt: Date.now() });
		return result;
	}
}
