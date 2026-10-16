import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Type, type Static } from "typebox";
import { applyEditsToNormalizedContent, createReadToolDefinition, detectLineEnding, detectSupportedImageMimeTypeFromFile, ensureTool, formatDimensionNote, getToolPath, imageOmittedNote, MAX_SPREADSHEET_BYTES, normalizeToLF, renderSpreadsheetPreview, resizeImage, resolveReadPath, restoreLineEndings, SpreadsheetPreviewError, stripBom, type ToolDefinition } from "@exxeta/exxperts-runtime";
import { isPersistentRoomWorkspaceToolBundleEnabled, persistentRoomWorkspaceToolNamesForPolicy } from "./persistent-room-tool-policy.js";
import { PersistentRoomShelfError } from "./persistent-room-shelf.js";
import { SHELF_READ_MAX_FILE_BYTES, runShelfParseWorker, shelfPdfExtractionIsBlank, sniffShelfFileBuffer } from "./persistent-room-shelf-reading.js";
import type { PersistentRoomCapabilityPolicy, PersistentRoomWorkspaceRootGrant } from "./persistent-room-workspace-policy.js";
import { hashPersistentRoomPath, PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS, PERSISTENT_ROOM_DEFAULT_DENY_SEGMENTS } from "./persistent-room-workspace-policy.js";

const DEFAULT_READ_MAX_BYTES = 50 * 1024;
const DEFAULT_READ_MAX_LINES = 2000;
const DEFAULT_LS_LIMIT = 500;
const DEFAULT_FIND_LIMIT = 1000;
const MAX_FIND_LIMIT = 2000;
const MAX_FIND_VISITED = 10000;
const DEFAULT_GREP_LIMIT = 200;
const MAX_GREP_LIMIT = 1000;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GREP_LINE_CHARS = 500;
const MAX_GREP_OUTPUT_CHARS = 50 * 1024;
// The ripgrep engine matches in linear time; the JavaScript walk fallback does
// not, so a pathological pattern can stall the whole server on one test() call.
// The pattern-length cap, the per-line scan window, and the wall-clock budget
// below bound that exposure for the fallback; they do not eliminate it.
const MAX_GREP_PATTERN_CHARS = 512;
const MAX_GREP_SCAN_LINE_CHARS = 2000;
const GREP_TIME_BUDGET_MS = 10_000;
// Waiting on a first-time ripgrep download is capped so a slow network degrades
// one call to the walk engine instead of hanging it.
const RIPGREP_ENSURE_WAIT_MS = 15_000;
// Test seam and operator escape hatch: forces the walk engine for bounded grep.
const DISABLE_RIPGREP_ENV = "EXXETA_BOUNDED_GREP_DISABLE_RIPGREP";
const MAX_WRITE_BYTES = 128 * 1024;

const workspaceReadSchema = Type.Object({
	path: Type.String({ description: "Workspace-relative path to the file to read. Absolute paths, ~, and .. traversal are not allowed." }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed). For .xlsx files: row to start the preview from (1-indexed)." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read. For .xlsx files: rows to preview (default 30, hard cap 100)." })),
	sheet: Type.Optional(Type.Union([Type.String(), Type.Number()], {
		description: "Sheet name or 1-based sheet index to preview (.xlsx files only)",
	})),
	columns: Type.Optional(Type.Number({ description: "Maximum columns to preview (default 12, hard cap 30) (.xlsx files only)" })),
});

const workspaceLsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Workspace-relative directory to list. Defaults to '.', the selected workspace root." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)." })),
});

const workspaceFindSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern for files under the selected workspace, e.g. '*.md', '**/*.json', or 'src/**/*.ts'." }),
	path: Type.Optional(Type.String({ description: "Workspace-relative directory to search in. Defaults to '.', the selected workspace root." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matching files to return (default: 1000)." })),
});

const workspaceGrepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern as JavaScript regular expression source, e.g. 'TODO' or 'export (function|const)'." }),
	path: Type.Optional(Type.String({ description: "Workspace-relative directory to search in. Defaults to '.', the selected workspace root." })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 200, hard cap 1000)." })),
});

const workspaceWriteSchema = Type.Object({
	path: Type.String({ description: "Workspace-relative path for the file to create or explicitly overwrite. Absolute paths, ~, and .. traversal are not allowed." }),
	content: Type.String({ description: "Content to write. UTF-8 byte length must be <= 128 KiB." }),
	overwrite: Type.Optional(Type.Boolean({ description: "Defaults to false. Existing files are rejected unless overwrite is true." })),
});

const workspaceEditReplaceSchema = Type.Object(
	{
		oldText: Type.String({
			description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{ additionalProperties: false },
);

const workspaceEditSchema = Type.Object(
	{
		path: Type.String({ description: "Workspace-relative path to the existing file to edit. Absolute paths, ~, and .. traversal are not allowed." }),
		edits: Type.Array(workspaceEditReplaceSchema, {
			description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{ additionalProperties: false },
);

type WorkspaceReadInput = Static<typeof workspaceReadSchema>;
type WorkspaceLsInput = Static<typeof workspaceLsSchema>;
type WorkspaceFindInput = Static<typeof workspaceFindSchema>;
type WorkspaceGrepInput = Static<typeof workspaceGrepSchema>;
type WorkspaceWriteInput = Static<typeof workspaceWriteSchema>;
type WorkspaceEditInput = Static<typeof workspaceEditSchema>;

type WorkspaceToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type TextToolResult = { content: WorkspaceToolContent[]; details: Record<string, unknown> | undefined };

type GuardPurpose = "read" | "list" | "find" | "write";

export interface PersistentRoomWorkspaceToolGuardResult {
	root: PersistentRoomWorkspaceRootGrant;
	rootRealpath: string;
	absolutePath: string;
	realpath: string;
	relativePath: string;
	pathForDisplay: string;
	stat: fs.Stats;
	lstat: fs.Stats;
}

interface PersistentRoomWorkspaceWriteTarget {
	root: PersistentRoomWorkspaceRootGrant;
	rootRealpath: string;
	absolutePath: string;
	parentAbsolutePath: string;
	relativePath: string;
	pathForDisplay: string;
	exists: boolean;
}

export class PersistentRoomWorkspaceToolError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PersistentRoomWorkspaceToolError";
		this.code = code;
	}
}

interface WorkspaceToolPolicyRuntime {
	policy: PersistentRoomCapabilityPolicy;
	root: PersistentRoomWorkspaceRootGrant;
	rootRealpath: string;
	denySegments: string[];
	denyFilenameGlobs: string[];
}

function toolResult(text: string, details?: Record<string, unknown>): TextToolResult {
	return { content: [{ type: "text", text }], details: details && Object.keys(details).length > 0 ? details : undefined };
}

function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

function toDisplayPath(relativePath: string): string {
	const normalized = normalizeSlashes(relativePath);
	return normalized === "" ? "." : normalized;
}

function splitWorkspacePath(value: string): string[] {
	return normalizeSlashes(value).split("/").filter((segment) => segment.length > 0 && segment !== ".");
}

function isPortableAbsolutePath(value: string): boolean {
	const normalized = normalizeSlashes(value);
	return path.isAbsolute(value) || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || /^\/\/[^/]/.test(normalized);
}

function sameOrDescendant(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRealpath(input: string): string | null {
	try {
		return fs.realpathSync.native(input);
	} catch {
		return null;
	}
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined || Number.isNaN(value)) return fallback;
	if (!Number.isFinite(value) || value < 1) return fallback;
	return Math.min(Math.floor(value), max);
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
	const normalized = normalizeSlashes(glob.trim());
	let source = "";
	for (let i = 0; i < normalized.length; i += 1) {
		const char = normalized[i];
		if (char === "*") {
			const next = normalized[i + 1];
			const afterNext = normalized[i + 2];
			if (next === "*") {
				if (afterNext === "/") {
					source += "(?:.*/)?";
					i += 2;
				} else {
					source += ".*";
					i += 1;
				}
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += escapeRegex(char);
		}
	}
	return new RegExp(`^${source}$`);
}

function matchesGlob(value: string, glob: string): boolean {
	return globToRegExp(glob).test(normalizeSlashes(value));
}

function isSensitiveFilename(name: string, globs: readonly string[]): boolean {
	return globs.some((glob) => matchesGlob(name, glob));
}

function deniedSegmentIn(relativePath: string, denySegments: readonly string[]): boolean {
	const denied = new Set(denySegments);
	return splitWorkspacePath(relativePath).some((segment) => denied.has(segment));
}

function sensitiveFilenameIn(relativePath: string, denyFilenameGlobs: readonly string[]): boolean {
	return splitWorkspacePath(relativePath).some((segment) => isSensitiveFilename(segment, denyFilenameGlobs));
}

function assertPolicyPathAllowed(relativePath: string, runtime: WorkspaceToolPolicyRuntime): void {
	if (deniedSegmentIn(relativePath, runtime.denySegments) || sensitiveFilenameIn(relativePath, runtime.denyFilenameGlobs)) {
		throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
	}
}

function validateWorkspaceRelativeInput(rawPath: string, purpose: GuardPurpose): string {
	const trimmed = String(rawPath ?? "").trim();
	if (!trimmed) {
		throw new PersistentRoomWorkspaceToolError("missing_path", purpose === "read" || purpose === "write" ? "File path is required." : "Workspace path is required.");
	}
	if (trimmed.startsWith("~")) {
		throw new PersistentRoomWorkspaceToolError("home_path", "Path is outside the selected workspace.");
	}
	if (isPortableAbsolutePath(trimmed)) {
		throw new PersistentRoomWorkspaceToolError("absolute_path", "Path is outside the selected workspace.");
	}
	const normalized = normalizeSlashes(trimmed);
	if (normalized.includes("\0") || splitWorkspacePath(normalized).some((segment) => segment === "..")) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	return normalized || ".";
}

function createRuntime(policy: PersistentRoomCapabilityPolicy): WorkspaceToolPolicyRuntime | null {
	if (!isPersistentRoomWorkspaceToolBundleEnabled(policy) || policy.modes.read !== true || policy.roots.length < 1) return null;
	const root = policy.roots[0];
	if (!root) return null;
	const rootRealpath = safeRealpath(root.realpath) ?? safeRealpath(root.path);
	if (!rootRealpath) return null;
	try {
		if (!fs.statSync(rootRealpath).isDirectory()) return null;
	} catch {
		return null;
	}
	// The grant hashed the native realpath at approval time; if the granted
	// path now resolves somewhere else (renamed dir, symlink swap), refuse
	// instead of silently retargeting the fence.
	const currentPathHash = hashPersistentRoomPath(rootRealpath);
	if (currentPathHash.algorithm !== root.pathHash.algorithm || currentPathHash.value !== root.pathHash.value) return null;
	return {
		policy,
		root,
		rootRealpath,
		denySegments: [...new Set([...PERSISTENT_ROOM_DEFAULT_DENY_SEGMENTS, ...policy.denySegments])],
		denyFilenameGlobs: [...new Set([...PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS, ...policy.denyFilenameGlobs])],
	};
}

export function isPersistentRoomWorkspaceToolPolicyEnabled(policy: PersistentRoomCapabilityPolicy | null | undefined): policy is PersistentRoomCapabilityPolicy {
	return Boolean(policy && createRuntime(policy));
}

export function resolvePersistentRoomWorkspacePath(
	policy: PersistentRoomCapabilityPolicy,
	rawPath: string,
	purpose: GuardPurpose,
): PersistentRoomWorkspaceToolGuardResult {
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	const normalizedInput = validateWorkspaceRelativeInput(rawPath, purpose);
	assertPolicyPathAllowed(normalizedInput, runtime);
	const absolutePath = path.resolve(runtime.rootRealpath, normalizedInput === "." ? "" : normalizedInput);
	if (!sameOrDescendant(absolutePath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}

	let lstat: fs.Stats;
	try {
		lstat = fs.lstatSync(absolutePath);
	} catch {
		throw new PersistentRoomWorkspaceToolError(purpose === "read" ? "file_not_found" : "path_not_found", purpose === "read" ? "File not found in selected workspace." : "Path not found in selected workspace.");
	}

	if ((purpose === "list" || purpose === "find") && lstat.isSymbolicLink()) {
		throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
	}

	const realpath = safeRealpath(absolutePath);
	if (!realpath || !sameOrDescendant(realpath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}

	const relativeRealpath = path.relative(runtime.rootRealpath, realpath);
	if (relativeRealpath.startsWith("..") || path.isAbsolute(relativeRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	assertPolicyPathAllowed(relativeRealpath || ".", runtime);

	let stat: fs.Stats;
	try {
		stat = fs.statSync(realpath);
	} catch {
		throw new PersistentRoomWorkspaceToolError(purpose === "read" ? "file_not_found" : "path_not_found", purpose === "read" ? "File not found in selected workspace." : "Path not found in selected workspace.");
	}

	return {
		root: runtime.root,
		rootRealpath: runtime.rootRealpath,
		absolutePath,
		realpath,
		relativePath: normalizeSlashes(relativeRealpath || "."),
		pathForDisplay: toDisplayPath(relativeRealpath),
		stat,
		lstat,
	};
}

/**
 * Resolve an existing regular file without creating directories or following
 * symlinks. Workspace editors use this narrower guard than the general write
 * tool, whose resolver intentionally supports creating new files.
 */
export function resolvePersistentRoomWorkspaceExistingFile(
	policy: PersistentRoomCapabilityPolicy,
	rawPath: string,
): PersistentRoomWorkspaceToolGuardResult {
	const guarded = resolvePersistentRoomWorkspacePath(policy, rawPath, "read");
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	if (guarded.lstat.isSymbolicLink() || !guarded.lstat.isFile() || !guarded.stat.isFile()) {
		throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a regular file in selected workspace.");
	}
	const parentAbsolutePath = path.dirname(guarded.absolutePath);
	const parentRelativePath = normalizeSlashes(path.relative(runtime.rootRealpath, parentAbsolutePath) || ".");
	assertNoSymlinkAncestors(runtime, parentRelativePath);
	const parentRealpath = safeRealpath(parentAbsolutePath);
	if (!parentRealpath || !sameOrDescendant(parentRealpath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	return guarded;
}

function nearestExistingAncestor(startPath: string, rootRealpath: string): { absolutePath: string; lstat: fs.Stats } {
	let current = startPath;
	while (sameOrDescendant(current, rootRealpath)) {
		try {
			return { absolutePath: current, lstat: fs.lstatSync(current) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
}

function assertNoSymlinkAncestors(runtime: WorkspaceToolPolicyRuntime, parentRelativePath: string): void {
	let current = runtime.rootRealpath;
	for (const segment of splitWorkspacePath(parentRelativePath)) {
		current = path.join(current, segment);
		let lstat: fs.Stats;
		try {
			lstat = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
		}
		if (lstat.isSymbolicLink()) throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
		if (!lstat.isDirectory()) throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
		const realpath = safeRealpath(current);
		if (!realpath || !sameOrDescendant(realpath, runtime.rootRealpath)) {
			throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
		}
	}
}

export function resolvePersistentRoomWorkspaceWriteTarget(
	policy: PersistentRoomCapabilityPolicy,
	rawPath: string,
): PersistentRoomWorkspaceWriteTarget {
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	const rawTrimmed = String(rawPath ?? "").trim();
	if (normalizeSlashes(rawTrimmed).endsWith("/")) {
		throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");
	}
	const normalizedInput = validateWorkspaceRelativeInput(rawTrimmed, "write");
	const normalizedTarget = normalizeSlashes(path.posix.normalize(normalizedInput));
	if (normalizedTarget === ".") {
		throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");
	}
	assertPolicyPathAllowed(normalizedTarget, runtime);

	const absolutePath = path.resolve(runtime.rootRealpath, normalizedTarget);
	if (!sameOrDescendant(absolutePath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	const parentAbsolutePath = path.dirname(absolutePath);
	if (!sameOrDescendant(parentAbsolutePath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	const parentRelativePath = normalizeSlashes(path.relative(runtime.rootRealpath, parentAbsolutePath) || ".");
	assertPolicyPathAllowed(parentRelativePath, runtime);

	const nearestAncestor = nearestExistingAncestor(parentAbsolutePath, runtime.rootRealpath);
	if (nearestAncestor.lstat.isSymbolicLink()) throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
	if (!nearestAncestor.lstat.isDirectory()) throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
	const ancestorRealpath = safeRealpath(nearestAncestor.absolutePath);
	if (!ancestorRealpath || !sameOrDescendant(ancestorRealpath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	assertNoSymlinkAncestors(runtime, parentRelativePath);

	try {
		fs.mkdirSync(parentAbsolutePath, { recursive: true });
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
	}
	assertNoSymlinkAncestors(runtime, parentRelativePath);
	const parentRealpath = safeRealpath(parentAbsolutePath);
	if (!parentRealpath || !sameOrDescendant(parentRealpath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	assertPolicyPathAllowed(normalizeSlashes(path.relative(runtime.rootRealpath, parentRealpath) || "."), runtime);

	let targetLstat: fs.Stats | null = null;
	try {
		targetLstat = fs.lstatSync(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
		}
	}
	if (targetLstat?.isSymbolicLink()) throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
	if (targetLstat && !targetLstat.isFile()) throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");

	return {
		root: runtime.root,
		rootRealpath: runtime.rootRealpath,
		absolutePath,
		parentAbsolutePath,
		relativePath: normalizedTarget,
		pathForDisplay: toDisplayPath(normalizedTarget),
		exists: Boolean(targetLstat),
	};
}

function entryBlockedByPolicy(name: string, relativePath: string, runtime: WorkspaceToolPolicyRuntime): boolean {
	return deniedSegmentIn(relativePath, runtime.denySegments) || sensitiveFilenameIn(relativePath, runtime.denyFilenameGlobs) || isSensitiveFilename(name, runtime.denyFilenameGlobs);
}

async function executeWorkspaceLs(policy: PersistentRoomCapabilityPolicy, input: WorkspaceLsInput): Promise<TextToolResult> {
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	const guarded = resolvePersistentRoomWorkspacePath(policy, input.path ?? ".", "list");
	if (!guarded.stat.isDirectory()) {
		throw new PersistentRoomWorkspaceToolError("not_directory", "Path is not a directory in selected workspace.");
	}
	const limit = normalizeLimit(input.limit, DEFAULT_LS_LIMIT, 2000);
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(guarded.realpath, { withFileTypes: true });
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_readable", "Directory cannot be read in selected workspace.");
	}
	entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	const output: string[] = [];
	let limitReached = false;
	for (const entry of entries) {
		if (output.length >= limit) {
			limitReached = true;
			break;
		}
		const entryRelative = guarded.relativePath === "." ? entry.name : `${guarded.relativePath}/${entry.name}`;
		if (entryBlockedByPolicy(entry.name, entryRelative, runtime)) continue;
		if (entry.isSymbolicLink()) {
			output.push(`${entry.name}@`);
			continue;
		}
		if (entry.isDirectory()) output.push(`${entry.name}/`);
		else if (entry.isFile()) output.push(entry.name);
	}
	if (output.length === 0) return toolResult("(empty directory)");
	let text = output.join("\n");
	const details: Record<string, unknown> = {};
	if (limitReached) {
		text += `\n\n[${limit} entries limit reached. Refine the path or increase limit.]`;
		details.entryLimitReached = limit;
	}
	return toolResult(text, details);
}

function findPatternMatcher(pattern: string): (relativeFilePath: string) => boolean {
	const normalizedPattern = normalizeSlashes(String(pattern ?? "").trim());
	if (!normalizedPattern) throw new PersistentRoomWorkspaceToolError("missing_pattern", "Find pattern is required.");
	const hasPathSeparator = normalizedPattern.includes("/");
	const regex = globToRegExp(normalizedPattern);
	return (relativeFilePath: string) => {
		const normalizedPath = normalizeSlashes(relativeFilePath);
		const value = hasPathSeparator ? normalizedPath : path.posix.basename(normalizedPath);
		return regex.test(value);
	};
}

async function executeWorkspaceFind(policy: PersistentRoomCapabilityPolicy, input: WorkspaceFindInput): Promise<TextToolResult> {
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	const guarded = resolvePersistentRoomWorkspacePath(policy, input.path ?? ".", "find");
	if (!guarded.stat.isDirectory()) {
		throw new PersistentRoomWorkspaceToolError("not_directory", "Path is not a directory in selected workspace.");
	}
	const matches = findPatternMatcher(input.pattern);
	const limit = normalizeLimit(input.limit, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
	const results: string[] = [];
	let visited = 0;
	let resultLimitReached = false;
	let traversalLimitReached = false;

	const walk = async (directoryRealpath: string, directoryRelativePath: string): Promise<void> => {
		if (resultLimitReached || traversalLimitReached) return;
		visited += 1;
		if (visited > MAX_FIND_VISITED) {
			traversalLimitReached = true;
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(directoryRealpath, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
		for (const entry of entries) {
			if (results.length >= limit) {
				resultLimitReached = true;
				return;
			}
			const relativeEntryPath = directoryRelativePath === "." ? entry.name : `${directoryRelativePath}/${entry.name}`;
			if (entryBlockedByPolicy(entry.name, relativeEntryPath, runtime)) continue;
			const absoluteEntryPath = path.join(directoryRealpath, entry.name);
			let lstat: fs.Stats;
			try {
				lstat = await fs.promises.lstat(absoluteEntryPath);
			} catch {
				continue;
			}
			if (lstat.isSymbolicLink()) continue;
			if (lstat.isDirectory()) {
				await walk(absoluteEntryPath, normalizeSlashes(relativeEntryPath));
			} else if (lstat.isFile()) {
				const displayPath = normalizeSlashes(relativeEntryPath);
				if (matches(displayPath)) results.push(displayPath);
			}
		}
	};

	await walk(guarded.realpath, guarded.relativePath);
	if (results.length === 0) return toolResult("No files found matching pattern");
	let text = results.join("\n");
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		details.resultLimitReached = limit;
		notices.push(`${limit} results limit reached. Refine pattern or path for more.`);
	}
	if (traversalLimitReached) {
		details.traversalLimitReached = MAX_FIND_VISITED;
		notices.push("workspace traversal limit reached. Refine pattern or path for more.");
	}
	if (notices.length > 0) text += `\n\n[${notices.join(" ")}]`;
	return toolResult(text, details);
}

interface BoundedGrepRequest {
	patternSource: string;
	ignoreCase: boolean;
	limit: number;
	deadline: number;
}

interface BoundedGrepCollected {
	outputLines: string[];
	details: Record<string, unknown>;
	notices: string[];
}

let ripgrepEnsurePromise: Promise<string | undefined> | null = null;

function ripgrepDisabledByEnv(): boolean {
	const value = process.env[DISABLE_RIPGREP_ENV];
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true";
}

async function resolveRipgrepBinary(deadline: number): Promise<string | null> {
	if (ripgrepDisabledByEnv()) return null;
	try {
		const existing = getToolPath("rg");
		if (existing) return existing;
	} catch {
		return null;
	}
	if (!ripgrepEnsurePromise) ripgrepEnsurePromise = ensureTool("rg", true).catch(() => undefined);
	// Leave the walk engine a slice of the call budget even when the capped
	// download wait is exhausted.
	const waitMs = Math.min(RIPGREP_ENSURE_WAIT_MS, deadline - Date.now() - 2_000);
	if (waitMs <= 0) return null;
	const ensured = await Promise.race([
		ripgrepEnsurePromise,
		new Promise<undefined>((resolve) => {
			const timer = setTimeout(() => resolve(undefined), waitMs);
			timer.unref();
		}),
	]);
	return ensured ?? null;
}

function escapeRipgrepGlobLiteral(value: string): string {
	return value.replace(/[\\*?[\]{}!]/g, "\\$&");
}

function ripgrepDenyGlobArgs(runtime: WorkspaceToolPolicyRuntime): string[] {
	// These globs keep ripgrep from reading denied content at all; the
	// entryBlockedByPolicy post-filter on every result stays the guarantee.
	const args: string[] = [];
	for (const segment of runtime.denySegments) {
		const literal = escapeRipgrepGlobLiteral(segment);
		for (const glob of [`!**/${literal}/**`, `!${literal}/**`, `!**/${literal}`]) args.push("--glob", glob);
	}
	for (const filenameGlob of runtime.denyFilenameGlobs) {
		for (const glob of [`!**/${filenameGlob}`, `!${filenameGlob}`]) args.push("--glob", glob);
	}
	return args;
}

function buildGrepResult(engine: "ripgrep" | "walk", collected: BoundedGrepCollected): TextToolResult {
	const { outputLines, details, notices } = collected;
	details.engine = engine;
	if (outputLines.length === 0) {
		const emptyText = notices.length > 0 ? `No matches found\n\n[${notices.join(" ")}]` : "No matches found";
		return toolResult(emptyText, details);
	}
	let text = outputLines.join("\n");
	if (text.length > MAX_GREP_OUTPUT_CHARS) {
		details.outputTruncated = true;
		text = text.slice(0, MAX_GREP_OUTPUT_CHARS);
		notices.push(`Output truncated at ${MAX_GREP_OUTPUT_CHARS / 1024}KB. Refine pattern or path for more.`);
	}
	if (notices.length > 0) text += `\n\n[${notices.join(" ")}]`;
	return toolResult(text, details);
}

function grepWithRipgrep(
	rgPath: string,
	runtime: WorkspaceToolPolicyRuntime,
	guarded: PersistentRoomWorkspaceToolGuardResult,
	request: BoundedGrepRequest,
): Promise<TextToolResult | null> {
	// A null result means "run the walk engine instead": spawn failure, a
	// pattern the rust regex dialect rejects, or any other ripgrep error.
	return new Promise((resolve) => {
		const remainingMs = request.deadline - Date.now();
		if (remainingMs <= 0) {
			resolve(null);
			return;
		}
		const args = [
			"--json",
			"--no-config",
			"--no-ignore",
			"--hidden",
			"--sort",
			"path",
			"--max-filesize",
			String(MAX_GREP_FILE_BYTES),
		];
		if (request.ignoreCase) args.push("--ignore-case");
		args.push(...ripgrepDenyGlobArgs(runtime));
		args.push("-e", request.patternSource, "--", guarded.relativePath);
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(rgPath, args, { cwd: runtime.rootRealpath, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolve(null);
			return;
		}
		const outputLines: string[] = [];
		let matchCount = 0;
		let matchLimitReached = false;
		let linesTruncated = false;
		let timeBudgetReached = false;
		let settled = false;
		const timer = setTimeout(() => {
			timeBudgetReached = true;
			child.kill();
		}, remainingMs);
		timer.unref();
		const settle = (result: TextToolResult | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const rl = createInterface({ input: child.stdout! });
		rl.on("line", (line) => {
			if (matchLimitReached || timeBudgetReached || !line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event?.type !== "match") return;
			const rawPath = event.data?.path?.text;
			const lineNumber = event.data?.line_number;
			const rawText = event.data?.lines?.text;
			if (typeof rawPath !== "string" || typeof lineNumber !== "number" || typeof rawText !== "string") return;
			const relativeFilePath = normalizeSlashes(rawPath).replace(/^(?:\.\/)+/, "");
			if (entryBlockedByPolicy(path.posix.basename(relativeFilePath), relativeFilePath, runtime)) return;
			let text = rawText.replace(/\r?\n$/, "").replace(/\r$/, "");
			if (text.length > MAX_GREP_LINE_CHARS) {
				text = text.slice(0, MAX_GREP_LINE_CHARS);
				linesTruncated = true;
			}
			outputLines.push(`${relativeFilePath}:${lineNumber}: ${text}`);
			matchCount += 1;
			if (matchCount >= request.limit) {
				matchLimitReached = true;
				child.kill();
			}
		});
		child.on("error", () => {
			rl.close();
			settle(null);
		});
		child.on("close", (code) => {
			rl.close();
			// Exit 0/1 is matches/no matches; a child stopped at the match limit
			// or the time budget still carries its collected results.
			if (!timeBudgetReached && !matchLimitReached && code !== 0 && code !== 1) {
				settle(null);
				return;
			}
			const details: Record<string, unknown> = {};
			const notices: string[] = [];
			if (matchLimitReached) {
				details.matchLimitReached = request.limit;
				notices.push(`${request.limit} matches limit reached. Use limit=${Math.min(request.limit * 2, MAX_GREP_LIMIT)} for more, or refine pattern.`);
			}
			if (linesTruncated) {
				details.linesTruncated = true;
				notices.push(`Some lines truncated to ${MAX_GREP_LINE_CHARS} chars. Use read to see full lines.`);
			}
			if (timeBudgetReached) {
				details.timeBudgetReached = GREP_TIME_BUDGET_MS;
				notices.push(`Search stopped after ${GREP_TIME_BUDGET_MS / 1000}s. Refine pattern or path and try again.`);
			}
			settle(buildGrepResult("ripgrep", { outputLines, details, notices }));
		});
	});
}

async function grepWithWalk(
	runtime: WorkspaceToolPolicyRuntime,
	guarded: PersistentRoomWorkspaceToolGuardResult,
	request: BoundedGrepRequest,
): Promise<TextToolResult> {
	let regex: RegExp;
	try {
		regex = new RegExp(request.patternSource, request.ignoreCase ? "i" : "");
	} catch {
		throw new PersistentRoomWorkspaceToolError("invalid_pattern", "Grep pattern is not a valid JavaScript regular expression.");
	}
	const limit = request.limit;
	const deadline = request.deadline;
	const outputLines: string[] = [];
	let matchCount = 0;
	let visited = 0;
	let matchLimitReached = false;
	let traversalLimitReached = false;
	let linesTruncated = false;
	let skippedLargeFiles = 0;
	let longLinesClipped = false;
	let timeBudgetReached = false;

	const scanFile = async (fileRealpath: string, relativeFilePath: string, size: number): Promise<void> => {
		if (size > MAX_GREP_FILE_BYTES) {
			skippedLargeFiles += 1;
			return;
		}
		let content: string;
		try {
			content = await fs.promises.readFile(fileRealpath, "utf-8");
		} catch {
			return;
		}
		const lines = content.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			if ((index & 255) === 0 && Date.now() > deadline) {
				timeBudgetReached = true;
				return;
			}
			const line = lines[index]!.replace(/\r$/, "");
			let probe = line;
			if (probe.length > MAX_GREP_SCAN_LINE_CHARS) {
				probe = probe.slice(0, MAX_GREP_SCAN_LINE_CHARS);
				longLinesClipped = true;
			}
			if (!regex.test(probe)) continue;
			matchCount += 1;
			let text = line;
			if (text.length > MAX_GREP_LINE_CHARS) {
				text = text.slice(0, MAX_GREP_LINE_CHARS);
				linesTruncated = true;
			}
			outputLines.push(`${relativeFilePath}:${index + 1}: ${text}`);
			if (matchCount >= limit) {
				matchLimitReached = true;
				return;
			}
		}
	};

	const walk = async (directoryRealpath: string, directoryRelativePath: string): Promise<void> => {
		if (matchLimitReached || traversalLimitReached || timeBudgetReached) return;
		visited += 1;
		if (visited > MAX_FIND_VISITED) {
			traversalLimitReached = true;
			return;
		}
		if (Date.now() > deadline) {
			timeBudgetReached = true;
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(directoryRealpath, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
		for (const entry of entries) {
			if (matchLimitReached || traversalLimitReached || timeBudgetReached) return;
			const relativeEntryPath = directoryRelativePath === "." ? entry.name : `${directoryRelativePath}/${entry.name}`;
			if (entryBlockedByPolicy(entry.name, relativeEntryPath, runtime)) continue;
			const absoluteEntryPath = path.join(directoryRealpath, entry.name);
			let lstat: fs.Stats;
			try {
				lstat = await fs.promises.lstat(absoluteEntryPath);
			} catch {
				continue;
			}
			if (lstat.isSymbolicLink()) continue;
			if (lstat.isDirectory()) {
				await walk(absoluteEntryPath, normalizeSlashes(relativeEntryPath));
			} else if (lstat.isFile()) {
				await scanFile(absoluteEntryPath, normalizeSlashes(relativeEntryPath), lstat.size);
			}
		}
	};

	await walk(guarded.realpath, guarded.relativePath);
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (matchLimitReached) {
		details.matchLimitReached = limit;
		notices.push(`${limit} matches limit reached. Use limit=${Math.min(limit * 2, MAX_GREP_LIMIT)} for more, or refine pattern.`);
	}
	if (traversalLimitReached) {
		details.traversalLimitReached = MAX_FIND_VISITED;
		notices.push("workspace traversal limit reached. Refine pattern or path for more.");
	}
	if (skippedLargeFiles > 0) {
		details.skippedLargeFiles = skippedLargeFiles;
		notices.push(`${skippedLargeFiles} file(s) larger than ${MAX_GREP_FILE_BYTES / (1024 * 1024)} MiB were skipped.`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push(`Some lines truncated to ${MAX_GREP_LINE_CHARS} chars. Use read to see full lines.`);
	}
	if (longLinesClipped) {
		details.longLinesClipped = true;
		notices.push(`Lines longer than ${MAX_GREP_SCAN_LINE_CHARS} chars were matched on their first ${MAX_GREP_SCAN_LINE_CHARS} chars only.`);
	}
	if (timeBudgetReached) {
		details.timeBudgetReached = GREP_TIME_BUDGET_MS;
		notices.push(`Search stopped after ${GREP_TIME_BUDGET_MS / 1000}s. Refine pattern or path and try again.`);
	}
	return buildGrepResult("walk", { outputLines, details, notices });
}

async function executeWorkspaceGrep(policy: PersistentRoomCapabilityPolicy, input: WorkspaceGrepInput): Promise<TextToolResult> {
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	const guarded = resolvePersistentRoomWorkspacePath(policy, input.path ?? ".", "find");
	if (!guarded.stat.isDirectory()) {
		throw new PersistentRoomWorkspaceToolError("not_directory", "Path is not a directory in selected workspace.");
	}
	const patternSource = String(input.pattern ?? "");
	if (!patternSource) throw new PersistentRoomWorkspaceToolError("missing_pattern", "Grep pattern is required.");
	if (patternSource.length > MAX_GREP_PATTERN_CHARS) {
		throw new PersistentRoomWorkspaceToolError("invalid_pattern", `Grep pattern is too long (${MAX_GREP_PATTERN_CHARS} character limit).`);
	}
	const request: BoundedGrepRequest = {
		patternSource,
		ignoreCase: input.ignoreCase === true,
		limit: normalizeLimit(input.limit, DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT),
		deadline: Date.now() + GREP_TIME_BUDGET_MS,
	};
	const rgPath = await resolveRipgrepBinary(request.deadline);
	if (rgPath) {
		try {
			const ripgrepResult = await grepWithRipgrep(rgPath, runtime, guarded, request);
			if (ripgrepResult) return ripgrepResult;
		} catch {
			// The fence must not depend on ripgrep working; the walk engine
			// answers whenever the ripgrep path fails for any reason.
		}
	}
	return grepWithWalk(runtime, guarded, request);
}

function sliceReadLines(text: string, offset: number | undefined, limit: number | undefined): { text: string; nextOffset?: number; totalLines: number; startLine: number; endLine: number } {
	const lines = text.split("\n");
	const totalLines = lines.length;
	const startLine = offset === undefined ? 1 : Math.max(1, Math.floor(offset));
	if (!Number.isFinite(startLine) || startLine < 1 || startLine > totalLines) {
		throw new PersistentRoomWorkspaceToolError("invalid_offset", "Offset is outside the selected file.");
	}
	const maxLines = limit === undefined || !Number.isFinite(limit) || limit < 1 ? DEFAULT_READ_MAX_LINES : Math.min(Math.floor(limit), DEFAULT_READ_MAX_LINES);
	const startIndex = startLine - 1;
	const endIndex = Math.min(startIndex + maxLines, totalLines);
	return {
		text: lines.slice(startIndex, endIndex).join("\n"),
		nextOffset: endIndex < totalLines ? endIndex + 1 : undefined,
		totalLines,
		startLine,
		endLine: endIndex,
	};
}

function truncateReadBytes(text: string): { text: string; truncated: boolean } {
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes <= DEFAULT_READ_MAX_BYTES) return { text, truncated: false };
	return { text: Buffer.from(text, "utf-8").subarray(0, DEFAULT_READ_MAX_BYTES).toString("utf-8"), truncated: true };
}

async function detectImageMimeTypeSafe(realpath: string): Promise<string | null> {
	try {
		return await detectSupportedImageMimeTypeFromFile(realpath);
	} catch {
		return null;
	}
}

async function executeWorkspaceReadXlsx(guarded: PersistentRoomWorkspaceToolGuardResult, input: WorkspaceReadInput): Promise<TextToolResult> {
	if (guarded.stat.size > MAX_SPREADSHEET_BYTES) {
		throw new PersistentRoomWorkspaceToolError("file_too_large", "Workbook is too large for this tool.");
	}
	let buffer: Buffer;
	try {
		buffer = await fs.promises.readFile(guarded.realpath);
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_readable", "Workbook cannot be read in selected workspace.");
	}
	let preview: { text: string; details: Record<string, unknown> };
	try {
		preview = renderSpreadsheetPreview(buffer, path.posix.basename(normalizeSlashes(guarded.pathForDisplay)), {
			sheet: input.sheet,
			startRow: input.offset,
			maxRows: input.limit,
			maxColumns: input.columns,
		});
	} catch (error) {
		if (error instanceof SpreadsheetPreviewError) {
			if (error.code === "not_readable") {
				throw new PersistentRoomWorkspaceToolError("not_readable", "Workbook cannot be read in selected workspace.");
			}
			throw new PersistentRoomWorkspaceToolError(error.code, error.message);
		}
		throw error;
	}
	return toolResult(preview.text, { path: guarded.pathForDisplay, ...preview.details });
}

async function executeWorkspaceReadImage(guarded: PersistentRoomWorkspaceToolGuardResult, mimeType: string): Promise<TextToolResult> {
	let buffer: Buffer;
	try {
		buffer = await fs.promises.readFile(guarded.realpath);
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_readable", "File cannot be read in selected workspace.");
	}
	const resized = await resizeImage({ type: "image", data: buffer.toString("base64"), mimeType });
	if ("failure" in resized) {
		return toolResult(`Read image file [${mimeType}]\n${imageOmittedNote(resized)}`, { path: guarded.pathForDisplay });
	}
	const dimensionNote = formatDimensionNote(resized);
	let textNote = `Read image file [${resized.mimeType}]`;
	if (dimensionNote) textNote += `\n${dimensionNote}`;
	return {
		content: [
			{ type: "text", text: textNote },
			{ type: "image", data: resized.data, mimeType: resized.mimeType },
		],
		details: { path: guarded.pathForDisplay },
	};
}

const DOCUMENT_SNIFF_BYTES = 8192;

/**
 * pdf/docx detection for workspace reads: the SAME byte signatures the shelf
 * trusts (sniffShelfFileBuffer), read leniently — any file whose head cannot
 * be read simply is not a document here, and the caller's own read path gets
 * to say why it failed.
 */
export function sniffWorkspaceDocumentKind(absolutePath: string, name: string): "pdf" | "docx" | null {
	let head: Buffer;
	let fd: number | null = null;
	try {
		fd = fs.openSync(absolutePath, "r");
		head = Buffer.alloc(DOCUMENT_SNIFF_BYTES);
		const read = fs.readSync(fd, head, 0, DOCUMENT_SNIFF_BYTES, 0);
		head = head.subarray(0, read);
	} catch {
		return null;
	} finally {
		if (fd !== null) fs.closeSync(fd);
	}
	const sniff = sniffShelfFileBuffer(head, name);
	return sniff.kind === "pdf" || sniff.kind === "docx" ? sniff.kind : null;
}

const WORKSPACE_DOCUMENT_SCANNED_PDF_NOTE = "This PDF has no extractable text (likely a scanned document). Add it to this room's Files to read its pages visually.";

/**
 * The shared pdf/docx read path: the shelf's isolated extraction worker, then
 * the read tool's own line windowing so offset/limit page documents exactly
 * like text files. Used by the bounded workspace read AND the full-access read
 * wrapper. No reading cache here: the shelf cache is keyed per room+name and
 * does not fit workspace paths, and extraction is fast enough for typical
 * documents — correctness over cleverness.
 *
 * Throws PersistentRoomWorkspaceToolError (file_too_large, invalid_offset) and
 * lets the worker's PersistentRoomShelfError (timeout/crash/parse failure)
 * pass through — each caller maps that to its own surface's honest phrasing.
 */
export async function executeWorkspaceDocumentRead(
	target: { absolutePath: string; sizeBytes: number; kind: "pdf" | "docx"; displayPath: string },
	offset: number | undefined,
	limit: number | undefined,
): Promise<TextToolResult> {
	if (target.sizeBytes > SHELF_READ_MAX_FILE_BYTES) {
		throw new PersistentRoomWorkspaceToolError("file_too_large", "Document is too large for this tool.");
	}
	const parsed = await runShelfParseWorker(target.absolutePath, target.kind);
	if (shelfPdfExtractionIsBlank(target.kind, parsed.text)) {
		return toolResult(WORKSPACE_DOCUMENT_SCANNED_PDF_NOTE, { path: target.displayPath, kind: target.kind, scanned: true });
	}
	const sliced = sliceReadLines(parsed.text, offset, limit);
	const truncated = truncateReadBytes(sliced.text);
	const notices: string[] = [];
	if (target.kind === "pdf") {
		notices.push(parsed.pages !== null ? `PDF, ${parsed.pages} page${parsed.pages === 1 ? "" : "s"}; extracted text with [page N] markers.` : "PDF; extracted text.");
	} else {
		notices.push("Word document; extracted text.");
	}
	if (parsed.truncated) notices.push("The extraction itself was capped; the tail of the document is not in the extracted text.");
	if (truncated.truncated) notices.push(`${DEFAULT_READ_MAX_BYTES / 1024}KB limit reached. Use offset to continue.`);
	if (sliced.nextOffset !== undefined) notices.push(`Showing lines ${sliced.startLine}-${sliced.endLine} of ${sliced.totalLines}. Use offset=${sliced.nextOffset} to continue.`);
	return toolResult(`${truncated.text}\n\n[${notices.join(" ")}]`, {
		path: target.displayPath,
		kind: target.kind,
		...(parsed.pages !== null ? { pages: parsed.pages } : {}),
		truncated: truncated.truncated || sliced.nextOffset !== undefined || parsed.truncated,
	});
}

async function executeWorkspaceRead(policy: PersistentRoomCapabilityPolicy, input: WorkspaceReadInput): Promise<TextToolResult> {
	const guarded = resolvePersistentRoomWorkspacePath(policy, input.path, "read");
	if (!guarded.stat.isFile()) {
		throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");
	}
	if (extensionLowercase(guarded.realpath) === ".xlsx") {
		return executeWorkspaceReadXlsx(guarded, input);
	}
	const imageMimeType = await detectImageMimeTypeSafe(guarded.realpath);
	if (imageMimeType) {
		return executeWorkspaceReadImage(guarded, imageMimeType);
	}
	const documentKind = sniffWorkspaceDocumentKind(guarded.realpath, path.posix.basename(normalizeSlashes(guarded.pathForDisplay)));
	if (documentKind) {
		try {
			return await executeWorkspaceDocumentRead({ absolutePath: guarded.realpath, sizeBytes: guarded.stat.size, kind: documentKind, displayPath: guarded.pathForDisplay }, input.offset, input.limit);
		} catch (error) {
			// Worker failures (timeout, crash, hostile document) stay generic here:
			// the bounded surface never relays parser internals.
			if (error instanceof PersistentRoomShelfError) {
				throw new PersistentRoomWorkspaceToolError("not_readable", "File cannot be read in selected workspace.");
			}
			throw error;
		}
	}
	let raw: string;
	try {
		raw = await fs.promises.readFile(guarded.realpath, "utf-8");
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_readable", "File cannot be read in selected workspace.");
	}
	const sliced = sliceReadLines(raw, input.offset, input.limit);
	const truncated = truncateReadBytes(sliced.text);
	const notices: string[] = [];
	if (truncated.truncated) notices.push(`${DEFAULT_READ_MAX_BYTES / 1024}KB limit reached. Use offset to continue.`);
	if (sliced.nextOffset !== undefined) notices.push(`Showing lines ${sliced.startLine}-${sliced.endLine} of ${sliced.totalLines}. Use offset=${sliced.nextOffset} to continue.`);
	const output = notices.length > 0 ? `${truncated.text}\n\n[${notices.join(" ")}]` : truncated.text;
	return toolResult(output, { path: guarded.pathForDisplay, truncated: truncated.truncated || sliced.nextOffset !== undefined });
}

function extensionLowercase(displayPath: string): string {
	return path.posix.extname(normalizeSlashes(displayPath)).toLowerCase();
}

async function executeWorkspaceWrite(policy: PersistentRoomCapabilityPolicy, input: WorkspaceWriteInput): Promise<TextToolResult> {
	if (typeof input.content !== "string") {
		throw new PersistentRoomWorkspaceToolError("invalid_content", "Content is required.");
	}
	const bytes = Buffer.byteLength(input.content, "utf-8");
	if (bytes > MAX_WRITE_BYTES) {
		throw new PersistentRoomWorkspaceToolError("content_too_large", "Content is too large for this tool.");
	}
	const overwrite = input.overwrite === true;
	const target = resolvePersistentRoomWorkspaceWriteTarget(policy, input.path);
	if (target.exists && !overwrite) {
		throw new PersistentRoomWorkspaceToolError("file_exists", "File already exists in selected workspace. Set overwrite=true to replace it.");
	}
	try {
		if (overwrite) {
			let lstat: fs.Stats;
			try {
				lstat = await fs.promises.lstat(target.absolutePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					await fs.promises.writeFile(target.absolutePath, input.content, { encoding: "utf-8", flag: "wx" });
					return toolResult(`file generated to ${target.pathForDisplay} (${bytes} bytes)`, {
						ok: true,
						path: target.pathForDisplay,
						bytes,
						created: true,
						overwritten: false,
					});
				}
				throw error;
			}
			if (lstat.isSymbolicLink()) throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
			if (!lstat.isFile()) throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");
			await fs.promises.writeFile(target.absolutePath, input.content, { encoding: "utf-8", flag: "w" });
			return toolResult(`file overwritten at ${target.pathForDisplay} (${bytes} bytes)`, {
				ok: true,
				path: target.pathForDisplay,
				bytes,
				created: false,
				overwritten: true,
			});
		}
		await fs.promises.writeFile(target.absolutePath, input.content, { encoding: "utf-8", flag: "wx" });
		return toolResult(`file generated to ${target.pathForDisplay} (${bytes} bytes)`, {
			ok: true,
			path: target.pathForDisplay,
			bytes,
			created: true,
			overwritten: false,
		});
	} catch (error) {
		if (error instanceof PersistentRoomWorkspaceToolError) throw error;
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new PersistentRoomWorkspaceToolError("file_exists", "File already exists in selected workspace. Set overwrite=true to replace it.");
		}
		throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
	}
}

async function executeWorkspaceEdit(policy: PersistentRoomCapabilityPolicy, input: WorkspaceEditInput): Promise<TextToolResult> {
	const guarded = resolvePersistentRoomWorkspacePath(policy, input.path, "write");
	if (guarded.lstat.isSymbolicLink()) {
		throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
	}
	if (!guarded.stat.isFile()) {
		throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");
	}
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new PersistentRoomWorkspaceToolError("invalid_edits", "edits must contain at least one replacement.");
	}
	const edits = input.edits.map((edit) => ({ oldText: String(edit?.oldText ?? ""), newText: String(edit?.newText ?? "") }));
	let buffer: Buffer;
	try {
		buffer = await fs.promises.readFile(guarded.realpath);
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_readable", "File cannot be read in selected workspace.");
	}
	const content = buffer.toString("utf-8");
	if (!Buffer.from(content, "utf-8").equals(buffer)) {
		throw new PersistentRoomWorkspaceToolError("not_utf8", "File is not valid UTF-8 text and cannot be edited with this tool.");
	}
	const { bom, text } = stripBom(content);
	const lineEnding = detectLineEnding(text);
	const normalized = normalizeToLF(text);
	let newContent: string;
	try {
		newContent = applyEditsToNormalizedContent(normalized, edits, guarded.pathForDisplay).newContent;
	} catch (error) {
		throw new PersistentRoomWorkspaceToolError("edit_failed", error instanceof Error ? error.message : String(error));
	}
	const nextContent = bom + restoreLineEndings(newContent, lineEnding);
	const bytes = Buffer.byteLength(nextContent, "utf-8");
	if (bytes > MAX_WRITE_BYTES) {
		throw new PersistentRoomWorkspaceToolError("content_too_large", "Edited content is too large for this tool.");
	}
	let targetLstat: fs.Stats;
	try {
		targetLstat = await fs.promises.lstat(guarded.absolutePath);
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
	}
	if (targetLstat.isSymbolicLink()) {
		throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
	}
	if (!targetLstat.isFile()) {
		throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");
	}
	try {
		await fs.promises.writeFile(guarded.absolutePath, nextContent, { encoding: "utf-8", flag: "w" });
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
	}
	const editCount = edits.length;
	return toolResult(`file edited at ${guarded.pathForDisplay} (${editCount} ${editCount === 1 ? "edit" : "edits"}, ${bytes} bytes)`, {
		ok: true,
		path: guarded.pathForDisplay,
		edits: editCount,
		bytes,
	});
}

/**
 * Full-access document support: the runtime's native read, overridden by name
 * for localFiles room sessions only (a customTools entry named like a built-in
 * replaces it in the session's tool registry). pdf/docx heads route through
 * the shared shelf extraction + line windowing; everything else delegates
 * VERBATIM to the native tool — text, images, and .xlsx (sheet/columns
 * included) behave byte-identically to the built-in read.
 */
export function createPersistentRoomLocalFilesReadTool(cwd: string): ToolDefinition<any, any> {
	const native = createReadToolDefinition(cwd);
	return {
		...native,
		description: `${native.description} Also supports PDF and Word (.docx) documents, extracted as text and paged with offset/limit; scanned PDFs without a text layer are called out honestly.`,
		execute: async (toolCallId, params: WorkspaceReadInput, signal?, onUpdate?, ctx?) => {
			const delegate = () => native.execute(toolCallId, params as any, signal, onUpdate as any, ctx as any);
			let absolutePath: string;
			try {
				absolutePath = resolveReadPath(String(params?.path ?? ""), cwd);
			} catch {
				return delegate();
			}
			const documentKind = sniffWorkspaceDocumentKind(absolutePath, path.basename(absolutePath));
			if (!documentKind) return delegate();
			let sizeBytes: number;
			try {
				sizeBytes = fs.statSync(absolutePath).size;
			} catch {
				return delegate();
			}
			try {
				return await executeWorkspaceDocumentRead({ absolutePath, sizeBytes, kind: documentKind, displayPath: String(params?.path ?? "") }, params?.offset, params?.limit);
			} catch (error) {
				// Full access has no fence to keep vague: relay the honest reason
				// (timeout, crash, cap) the way the native tool reports its errors.
				if (error instanceof PersistentRoomShelfError || error instanceof PersistentRoomWorkspaceToolError) throw new Error(error.message);
				throw error;
			}
		},
	} as ToolDefinition<any, any>;
}

export interface PersistentRoomWorkspaceToolsOptions {
	/**
	 * Session cwd for a localFiles (Full access) room. When given and the room's
	 * selection includes read, the document-aware read wrapper is returned so it
	 * overrides the native read at the session bind; without it localFiles rooms
	 * register no curated tools (the native surface stands alone).
	 */
	localFilesReadCwd?: string;
}

export function createPersistentRoomWorkspaceTools(policy: PersistentRoomCapabilityPolicy, options?: PersistentRoomWorkspaceToolsOptions): Array<ToolDefinition<any, any>> {
	if (!createRuntime(policy)) return [];
	const selectedToolNames = new Set(persistentRoomWorkspaceToolNamesForPolicy(policy));
	if (policy.workspaceAccessMode === "localFiles") {
		const localFilesReadCwd = options?.localFilesReadCwd;
		if (localFilesReadCwd && selectedToolNames.has("read")) return [createPersistentRoomLocalFilesReadTool(localFilesReadCwd)];
		return [];
	}
	const lsTool: ToolDefinition<typeof workspaceLsSchema, Record<string, unknown> | undefined> = {
		name: "ls",
		label: "workspace ls",
		description: "List files and folders under the selected persistent-room workspace only. Paths are workspace-relative; '.' means the selected workspace root. Absolute paths, '~', and '..' traversal are rejected. Denied folders/files and secret-looking filenames are omitted. Symlinks are marked without dereferencing.",
		promptSnippet: "List selected-workspace directory contents using workspace-relative paths only",
		parameters: workspaceLsSchema,
		execute: async (_toolCallId, params) => executeWorkspaceLs(policy, params),
	};
	const findTool: ToolDefinition<typeof workspaceFindSchema, Record<string, unknown> | undefined> = {
		name: "find",
		label: "workspace find",
		description: "Find files under the selected persistent-room workspace only. Pattern and path are evaluated with workspace-relative paths; '.' means the selected workspace root. Absolute paths, '~', and '..' traversal are rejected. Denied directories/files are skipped, symlink directories are not followed, and output paths are workspace-relative. Results include files .gitignore would hide; denied folders and secret-looking filenames stay hidden.",
		promptSnippet: "Find selected-workspace files using workspace-relative paths only",
		parameters: workspaceFindSchema,
		execute: async (_toolCallId, params) => executeWorkspaceFind(policy, params),
	};
	const readTool: ToolDefinition<typeof workspaceReadSchema, Record<string, unknown> | undefined> = {
		name: "read",
		label: "workspace read",
		description: "Read a file under the selected persistent-room workspace only. Path must be workspace-relative; absolute paths, '~', and '..' traversal are rejected. Denied directories/files and secret-looking filenames are blocked. Supports text files (output is truncated safely; use offset/limit to continue large files), images (jpg, png, gif, webp; sent as attachments), PDF and Word (.docx) documents (extracted as text and paged with offset/limit; scanned PDFs without a text layer are called out honestly), and .xlsx spreadsheets previewed as a markdown table (default 30 rows and 12 columns of the first sheet; use sheet, offset, limit, and columns to control the previewed window).",
		promptSnippet: "Read selected-workspace files (text, images, pdf/docx extraction, .xlsx previews) using workspace-relative paths only",
		parameters: workspaceReadSchema,
		execute: async (_toolCallId, params) => executeWorkspaceRead(policy, params),
	};
	const grepTool: ToolDefinition<typeof workspaceGrepSchema, Record<string, unknown> | undefined> = {
		name: "grep",
		label: "workspace grep",
		description: "Search file contents under the selected persistent-room workspace only. Pattern is JavaScript regular expression source evaluated line by line; matching lines are returned as 'path:line: text' with workspace-relative paths. Path must be workspace-relative; absolute paths, '~', and '..' traversal are rejected. Denied directories/files are skipped and symlinks are not followed. Output is bounded by match, line-length, file-size, and total-output limits; refine pattern or path for more focused results. Results include files .gitignore would hide; denied folders and secret-looking filenames stay hidden.",
		promptSnippet: "Search selected-workspace file contents using workspace-relative paths only",
		parameters: workspaceGrepSchema,
		execute: async (_toolCallId, params) => executeWorkspaceGrep(policy, params),
	};
	const writeTool: ToolDefinition<typeof workspaceWriteSchema, Record<string, unknown> | undefined> = {
		name: "write",
		label: "workspace write",
		description: "Create or explicitly overwrite a file under the selected persistent-room workspace only. Any file type can be written. Path must be workspace-relative; absolute paths, '~', '..' traversal, denied folders/files, secret-looking filenames, symlink targets, and paths outside the workspace are rejected. Parent directories may be created inside the workspace. Existing files are rejected unless overwrite=true. Ask before overwriting unless the user explicitly requested it. After success, tell the user the workspace-relative file path and do not paste the full written content.",
		promptSnippet: "Create or explicitly overwrite selected-workspace files using workspace-relative paths only",
		parameters: workspaceWriteSchema,
		execute: async (_toolCallId, params) => executeWorkspaceWrite(policy, params),
	};
	const editTool: ToolDefinition<typeof workspaceEditSchema, Record<string, unknown> | undefined> = {
		name: "edit",
		label: "workspace edit",
		description: "Edit an existing file under the selected persistent-room workspace only by replacing exact text. Each edits[].oldText is matched against the original file, must be unique in it, and must not overlap another edit in the same call; if two changes touch the same block or nearby lines, merge them into one edit. Path must be workspace-relative; absolute paths, '~', '..' traversal, denied folders/files, secret-looking filenames, and symlink targets are rejected. Only UTF-8 text files can be edited, and the edited file must stay within the write size limit.",
		promptSnippet: "Edit selected-workspace files by exact text replacement using workspace-relative paths only",
		parameters: workspaceEditSchema,
		execute: async (_toolCallId, params) => executeWorkspaceEdit(policy, params),
	};
	return [lsTool, findTool, grepTool, readTool, writeTool, editTool].filter((tool) => selectedToolNames.has(String(tool.name)));
}
