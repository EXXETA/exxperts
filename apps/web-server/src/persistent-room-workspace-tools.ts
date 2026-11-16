import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Type, type Static } from "typebox";
import { applyEditsToNormalizedContent, detectLineEnding, detectSupportedImageMimeTypeFromFile, ensureTool, formatDimensionNote, getToolPath, imageOmittedNote, MAX_SPREADSHEET_BYTES, normalizeToLF, renderSpreadsheetPreview, resizeImage, restoreLineEndings, SpreadsheetPreviewError, stripBom, type ToolDefinition, withFileMutationQueue } from "@exxeta/exxperts-runtime";
import { isPersistentRoomWorkspaceToolBundleEnabled, persistentRoomWorkspaceToolNamesForPolicy } from "./persistent-room-tool-policy.js";
import { PersistentRoomShelfError } from "./persistent-room-shelf.js";
import { SHELF_READ_MAX_FILE_BYTES, runShelfParseWorker, shelfPdfExtractionIsBlank, sniffShelfFileBuffer } from "./persistent-room-shelf-reading.js";
import type { PersistentRoomCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { PERSISTENT_ROOM_APP_SIBLING_GLOBS, PERSISTENT_ROOM_APP_STATE_SEGMENTS, PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS, PERSISTENT_ROOM_SECRET_FILENAME_TEMPLATES, PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS } from "./persistent-room-workspace-policy.js";
import { type FencedPath, type FenceRoot, fencePath, foldPart, globToRegExp, matchesGlob, normalizeSlashes, RoomFilesError, roomFence as fenceWith, type RoomFence, SECRET_FILENAME_GLOBS, showPath } from "./room-files.js";
import { BoxFiles, boxedCommandSinceStart, FILES_STOPPED_LINE, type SearchMatch } from "./room-box/box-files.js";
import { BoxFault } from "./room-box/box-process.js";
import type { RoomBox } from "./room-box/box-session.js";
import { readOnlyNextLine } from "./room-box/card-text.js";
import { readAlsoAllowed } from "./room-box/also-allowed.js";
import type { AnswerFolders } from "./room-box/folder-question.js";
import type { FolderWait } from "./room-box/windows/folder-wait.js";
import { approvedSkills } from "./skills-executable.js";

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
const MAX_GREP_CONTEXT = 20;
// Large and rarely what a search is after: a walk goes into these only when it starts inside one.
const WALK_SKIPPED_FOLDERS = [".git", "node_modules"] as const;

const PATH_RULE = "relative to this room's folder, absolute, or starting with ~; only this room's folder and the folders allowed for it open";

const workspaceReadSchema = Type.Object({
	path: Type.String({ description: `Path to the file to read: ${PATH_RULE}.` }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed). For .xlsx files: row to start the preview from (1-indexed)." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read. For .xlsx files: rows to preview (default 30, hard cap 100)." })),
	sheet: Type.Optional(Type.Union([Type.String(), Type.Number()], {
		description: "Sheet name or 1-based sheet index to preview (.xlsx files only)",
	})),
	columns: Type.Optional(Type.Number({ description: "Maximum columns to preview (default 12, hard cap 30) (.xlsx files only)" })),
});

const workspaceLsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: `Folder to list: ${PATH_RULE}. Defaults to '.', the room's folder.` })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)." })),
});

const workspaceFindSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern for files under the folder searched, e.g. '*.md', '**/*.json', or 'src/**/*.ts'." }),
	path: Type.Optional(Type.String({ description: `Folder to search in: ${PATH_RULE}. Defaults to '.', the room's folder.` })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matching files to return (default: 1000)." })),
});

const workspaceGrepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern as JavaScript regular expression source, e.g. 'TODO' or 'export (function|const)', or a plain string with literal." }),
	path: Type.Optional(Type.String({ description: `File or folder to search in: ${PATH_RULE}. Defaults to '.', the room's folder.` })),
	glob: Type.Optional(Type.String({ description: "Search only files matching this glob, e.g. '*.ts' or 'src/**/*.spec.ts'." })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a plain string instead of a regular expression (default: false)." })),
	context: Type.Optional(Type.Number({ description: `Lines to show before and after each match (default: 0, at most ${MAX_GREP_CONTEXT}).` })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 200, hard cap 1000)." })),
});

const workspaceWriteSchema = Type.Object({
	path: Type.String({ description: `Path for the file to create or explicitly overwrite: ${PATH_RULE}.` }),
	content: Type.String({ description: "Content to write." }),
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
		path: Type.String({ description: `Path to the existing file to edit: ${PATH_RULE}.` }),
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

/** The tools' error: a code, and a line the model can pass on. */
export { RoomFilesError as PersistentRoomWorkspaceToolError };

type GuardPurpose = "read" | "list" | "find" | "write";

/** A path through the fence that is there now, with its stat. */
export interface PersistentRoomWorkspaceToolGuardResult extends FencedPath {
	stat: fs.Stats;
}

/** One call: the fence as it stands now, and what the call's listing left out. */
interface FenceCall {
	fence: RoomFence;
	leftOut: Set<string>;
}

function toolResult(text: string, details?: Record<string, unknown>): TextToolResult {
	return { content: [{ type: "text", text }], details: details && Object.keys(details).length > 0 ? details : undefined };
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined || Number.isNaN(value)) return fallback;
	if (!Number.isFinite(value) || value < 1) return fallback;
	return Math.min(Math.floor(value), max);
}

/** Approved skills' folders: a skill whose files still match the person's approval to run them. Opened for reading only. */
function approvedSkillFolders(roomId: string): string[] {
	return approvedSkills(roomId).flatMap((skill) => {
		try {
			return [fs.realpathSync.native(skill.skillDir)];
		} catch {
			return [];
		}
	});
}

/** Whether a folder is at or inside what a call that waited holds (`folderWait`). */
type Held = (folder: string) => boolean;

/**
 * The room's fence as the file tools see it: its folders and the running answer's own, its approved skills' folders for reading, and in the box this turn's long output.
 * With `held`, it opens only the folders the call holds: one given later waits for the next call.
 */
function roomFence(policy: PersistentRoomCapabilityPolicy, box?: RoomBox, answer?: AnswerFolders, held?: Held): RoomFence {
	const fence = fenceWith(policy, (roomId) => [...approvedSkillFolders(roomId), ...(box?.spills() ?? [])], answer);
	return held ? { ...fence, roots: () => fence.roots().filter((root) => held(root.path)) } : fence;
}

/** Where a call reads and writes: the room's box, or null for the server's own reads behind the fence. */
type Files = BoxFiles | null;

/** One call's fence, and the box it reads and writes through when there is one. */
function callFence(policy: PersistentRoomCapabilityPolicy, box?: RoomBox, answer?: AnswerFolders, held?: Held): { fence: RoomFence; files: Files } {
	const fence = roomFence(policy, box, answer, held);
	return { fence, files: box ? new BoxFiles(box, fence) : null };
}

/**
 * Runs a call in the room's box. A box that doesn't start leaves the server's
 * own reads behind the fence only while no boxed command has run since the
 * computer started: after one, a job it left could race them, so file tools stop.
 */
async function inTheBox<T>(box: RoomBox | undefined, run: (box: RoomBox | undefined) => Promise<T>): Promise<T> {
	if (!box) return run(undefined);
	try {
		return await run(box);
	} catch (error) {
		if (!(error instanceof BoxFault)) throw error;
		if (boxedCommandSinceStart()) throw new RoomFilesError("box_failed", FILES_STOPPED_LINE);
		return run(undefined);
	}
}

// A missing path and a file already there start with sentences the step cards know (web-ui step-lines.ts), so the card says it plainly.
function guard(fence: RoomFence, rawPath: string, purpose: GuardPurpose, files: Files = null): PersistentRoomWorkspaceToolGuardResult {
	const fenced = fencePath(fence, rawPath, purpose === "write" ? "write" : "read", { decksInBox: files !== null });
	try {
		return { ...fenced, stat: fs.statSync(fenced.real) };
	} catch {
		throw new RoomFilesError(purpose === "read" ? "file_not_found" : "path_not_found", `Path not found: ${String(rawPath).trim()}`);
	}
}

/** A path as a tool would take it, checked against the room's fence as it stands now. */
export function resolvePersistentRoomWorkspacePath(policy: PersistentRoomCapabilityPolicy, rawPath: string, purpose: GuardPurpose): PersistentRoomWorkspaceToolGuardResult {
	return guard(roomFence(policy), rawPath, purpose);
}

function newCall(fence: RoomFence): FenceCall {
	return { fence, leftOut: new Set() };
}

/** Whether a walk leaves this entry out, and notes it when it does. `deck` is what the box found at a deck's name. */
function entryClosed(call: FenceCall, root: FenceRoot, real: string, deck?: boolean): boolean {
	const closed = call.fence.refusal(real, root, "read", deck) !== null;
	if (closed) call.leftOut.add(real);
	return closed;
}

/** The folders a walk from here skips: none once it starts inside one of them. */
function walkSkips(guarded: FencedPath): ReadonlySet<string> {
	const below = path.relative(guarded.root.path, guarded.real).split(path.sep).map(foldPart);
	return new Set(WALK_SKIPPED_FOLDERS.filter((name) => !below.includes(name)));
}

const WALK_SKIPPED_LINE = `Folders named ${WALK_SKIPPED_FOLDERS.join(" and ")} were not searched; give one as the path to search inside it.`;

// Never "(empty directory)" or "No matches found" alone when something was
// left out: asked whether a file is there, the room would wrongly say no.
function withLeftOutLine(result: TextToolResult, count: number, why: string): TextToolResult {
	if (count === 0) return result;
	const line = `${count} ${count === 1 ? "entry" : "entries"} left out: ${why}.`;
	const text = result.content.find((part) => part.type === "text");
	if (text) text.text = `${text.text}\n\n${line}`;
	else result.content.push({ type: "text", text: line });
	return result;
}

const LEFT_OUT = "secret files or the app's own data";

async function executeWorkspaceLs(policy: PersistentRoomCapabilityPolicy, input: WorkspaceLsInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, held?: Held): Promise<TextToolResult> {
	return inTheBox(box, async (box) => {
		const { fence, files } = callFence(policy, box, answer, held);
		const call = newCall(fence);
		return withLeftOutLine(await listWorkspace(call, input, files, signal), call.leftOut.size, LEFT_OUT);
	});
}

type Listed = { name: string; kind: "file" | "dir" | "link" | "other"; deck?: boolean };

function kindOf(entry: fs.Dirent): Listed["kind"] {
	if (entry.isSymbolicLink()) return "link";
	if (entry.isDirectory()) return "dir";
	return entry.isFile() ? "file" : "other";
}

async function listWorkspace(call: FenceCall, input: WorkspaceLsInput, files: Files, signal: AbortSignal | undefined): Promise<TextToolResult> {
	const raw = input.path ?? ".";
	const guarded = guard(call.fence, raw, "list", files);
	if (!guarded.stat.isDirectory()) {
		throw new RoomFilesError("not_directory", `${guarded.shown} is not a folder.`);
	}
	const limit = normalizeLimit(input.limit, DEFAULT_LS_LIMIT, 2000);
	let entries: Listed[];
	if (files) {
		entries = await files.list(guarded, raw, signal);
	} else {
		try {
			entries = (await fs.promises.readdir(guarded.real, { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
		} catch {
			throw new RoomFilesError("not_readable", `${guarded.shown} can't be read.`);
		}
	}
	entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	const output: string[] = [];
	let limitReached = false;
	for (const entry of entries) {
		if (output.length >= limit) {
			limitReached = true;
			break;
		}
		if (entryClosed(call, guarded.root, path.join(guarded.real, entry.name), entry.deck)) continue;
		if (entry.kind === "link") {
			output.push(`${entry.name}@`);
			continue;
		}
		if (entry.kind === "dir") output.push(`${entry.name}/`);
		else if (entry.kind === "file") output.push(entry.name);
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
	if (!normalizedPattern) throw new RoomFilesError("missing_pattern", "Find pattern is required.");
	const hasPathSeparator = normalizedPattern.includes("/");
	const regex = globToRegExp(normalizedPattern);
	return (relativeFilePath: string) => {
		const normalizedPath = normalizeSlashes(relativeFilePath);
		const value = hasPathSeparator ? normalizedPath : path.posix.basename(normalizedPath);
		return regex.test(value);
	};
}

async function executeWorkspaceFind(policy: PersistentRoomCapabilityPolicy, input: WorkspaceFindInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, held?: Held): Promise<TextToolResult> {
	return inTheBox(box, async (box) => {
		const { fence, files } = callFence(policy, box, answer, held);
		const call = newCall(fence);
		return withLeftOutLine(await findWorkspace(call, input, files, signal), call.leftOut.size, LEFT_OUT);
	});
}

/** The path a find pattern is matched against: relative to the place that opened it. */
function rootRelative(real: string, root: FenceRoot): string {
	return normalizeSlashes(path.relative(root.path, real));
}

interface Found {
	results: string[];
	resultLimitReached: boolean;
	traversalLimitReached: boolean;
	skippedFolders: boolean;
}

/** The same walk in the box: the program lists, the fence leaves out what it closes, and what a closed folder holds goes with it. */
async function findInBox(call: FenceCall, guarded: PersistentRoomWorkspaceToolGuardResult, raw: string, files: BoxFiles, matches: (relative: string) => boolean, limit: number, signal: AbortSignal | undefined): Promise<Found> {
	const walked = await files.walk(guarded, raw, { skips: [...walkSkips(guarded)], maxFolders: MAX_FIND_VISITED }, signal);
	const found: Found = { results: [], resultLimitReached: false, traversalLimitReached: walked.folderLimit || walked.entryLimit, skippedFolders: walked.skipped };
	const closedFolders: string[] = [];
	for (const entry of walked.entries) {
		if (found.results.length >= limit) {
			found.resultLimitReached = true;
			break;
		}
		if (closedFolders.some((folder) => entry.rel.startsWith(`${folder}/`))) continue;
		const entryPath = path.join(guarded.real, ...entry.rel.split("/"));
		if (entryClosed(call, guarded.root, entryPath, entry.deck)) {
			if (entry.kind === "dir") closedFolders.push(entry.rel);
			continue;
		}
		if (matches(rootRelative(entryPath, guarded.root))) found.results.push(entry.kind === "dir" ? `${showPath(entryPath, guarded.root)}/` : showPath(entryPath, guarded.root));
	}
	return found;
}

async function findWorkspace(call: FenceCall, input: WorkspaceFindInput, files: Files, signal: AbortSignal | undefined): Promise<TextToolResult> {
	const raw = input.path ?? ".";
	const guarded = guard(call.fence, raw, "find", files);
	if (!guarded.stat.isDirectory()) {
		throw new RoomFilesError("not_directory", `${guarded.shown} is not a folder.`);
	}
	const matches = findPatternMatcher(input.pattern);
	const limit = normalizeLimit(input.limit, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
	const { results, resultLimitReached, traversalLimitReached, skippedFolders } = files ? await findInBox(call, guarded, raw, files, matches, limit, signal) : await findHere(call, guarded, matches, limit);
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		details.resultLimitReached = limit;
		notices.push(`${limit} results limit reached. Refine pattern or path for more.`);
	}
	if (traversalLimitReached) {
		details.traversalLimitReached = MAX_FIND_VISITED;
		notices.push("Folder walk limit reached. Refine pattern or path for more.");
	}
	if (skippedFolders) notices.push(WALK_SKIPPED_LINE);
	const text = results.length === 0 ? "No files found matching pattern" : results.join("\n");
	return toolResult(notices.length > 0 ? `${text}\n\n[${notices.join(" ")}]` : text, details);
}

async function findHere(call: FenceCall, guarded: PersistentRoomWorkspaceToolGuardResult, matches: (relative: string) => boolean, limit: number): Promise<Found> {
	const skips = walkSkips(guarded);
	const results: string[] = [];
	let visited = 0;
	let resultLimitReached = false;
	let traversalLimitReached = false;
	let skippedFolders = false;

	const walk = async (directory: string): Promise<void> => {
		if (resultLimitReached || traversalLimitReached) return;
		visited += 1;
		if (visited > MAX_FIND_VISITED) {
			traversalLimitReached = true;
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
		for (const entry of entries) {
			if (results.length >= limit) {
				resultLimitReached = true;
				return;
			}
			const entryPath = path.join(directory, entry.name);
			if (entryClosed(call, guarded.root, entryPath)) continue;
			let lstat: fs.Stats;
			try {
				lstat = await fs.promises.lstat(entryPath);
			} catch {
				continue;
			}
			if (lstat.isSymbolicLink()) continue;
			if (lstat.isDirectory()) {
				// A folder that matches is a result too, as a Keynote deck saved as a folder is one file to the person.
				if (matches(rootRelative(entryPath, guarded.root))) results.push(`${showPath(entryPath, guarded.root)}/`);
				if (skips.has(foldPart(entry.name))) skippedFolders = true;
				else await walk(entryPath);
			} else if (lstat.isFile()) {
				if (matches(rootRelative(entryPath, guarded.root))) results.push(showPath(entryPath, guarded.root));
			}
		}
	};

	await walk(guarded.real);
	return { results, resultLimitReached, traversalLimitReached, skippedFolders };
}

interface BoundedGrepRequest {
	patternSource: string;
	ignoreCase: boolean;
	literal: boolean;
	/** Files to search, matched against the path below the folder searched. */
	glob: ((below: string) => boolean) | null;
	globText: string | null;
	context: number;
	limit: number;
	deadline: number;
	signal: AbortSignal | undefined;
}

interface GrepMatch {
	real: string;
	shown: string;
	line: number;
	text: string;
	/** The lines around it, as the box's program read them. */
	around?: SearchMatch["around"];
}

interface BoundedGrepCollected {
	matches: GrepMatch[];
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

function ripgrepDenyGlobArgs(skips: ReadonlySet<string>): string[] {
	// These globs keep ripgrep from reading most closed content; the fence's
	// check on every result stays the guarantee.
	const args: string[] = [];
	for (const segment of [...PERSISTENT_ROOM_APP_STATE_SEGMENTS, ...skips]) {
		const literal = escapeRipgrepGlobLiteral(segment);
		for (const glob of [`!**/${literal}/**`, `!${literal}/**`, `!**/${literal}`]) args.push("--glob", glob);
	}
	for (const filenameGlob of SECRET_FILENAME_GLOBS) {
		// ripgrep cannot re-open a template its skip covers: a later positive glob
		// would turn into an include list. A Keynote deck shares its name with a
		// key and opens, so the fence alone tells them apart.
		if (PERSISTENT_ROOM_SECRET_FILENAME_TEMPLATES.some((template) => matchesGlob(template, filenameGlob))) continue;
		if ((PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS as readonly string[]).includes(filenameGlob)) continue;
		for (const glob of [`!**/${filenameGlob}`, `!${filenameGlob}`]) args.push("--glob", glob);
	}
	for (const credentialPath of PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS) {
		const literal = credentialPath.split("/").map((part) => (part === "**" ? part : escapeRipgrepGlobLiteral(part))).join("/");
		for (const glob of [`!**/${literal}/**`, `!**/${literal}`, `!${literal}`]) args.push("--glob", glob);
	}
	for (const siblingGlob of PERSISTENT_ROOM_APP_SIBLING_GLOBS) {
		for (const glob of [`!**/${siblingGlob}/**`, `!${siblingGlob}/**`, `!**/${siblingGlob}`]) args.push("--glob", glob);
	}
	return args;
}

function clippedLine(line: string): { text: string; clipped: boolean } {
	const text = line.replace(/\r$/, "");
	return text.length > MAX_GREP_LINE_CHARS ? { text: text.slice(0, MAX_GREP_LINE_CHARS), clipped: true } : { text, clipped: false };
}

/** The matches as lines, each with the lines around it when context was asked for. */
async function grepOutputLines(matches: readonly GrepMatch[], context: number): Promise<{ lines: string[]; clipped: boolean }> {
	if (context === 0) return { lines: matches.map((match) => `${match.shown}:${match.line}: ${match.text}`), clipped: false };
	const files = new Map<string, string[]>();
	const lines: string[] = [];
	let clipped = false;
	for (const match of matches) {
		let fileLines = files.get(match.real);
		if (match.around) {
			for (const [index, text] of match.around.lines.entries()) {
				const line = match.around.start + index;
				const shown = clippedLine(text);
				clipped ||= shown.clipped;
				lines.push(line === match.line ? `${match.shown}:${line}: ${shown.text}` : `${match.shown}-${line}- ${shown.text}`);
			}
			continue;
		}
		if (!fileLines) {
			try {
				fileLines = (await fs.promises.readFile(match.real, "utf-8")).split("\n");
			} catch {
				fileLines = [];
			}
			files.set(match.real, fileLines);
		}
		if (fileLines.length === 0) {
			lines.push(`${match.shown}:${match.line}: ${match.text}`);
			continue;
		}
		for (let line = Math.max(1, match.line - context); line <= Math.min(fileLines.length, match.line + context); line += 1) {
			const shown = clippedLine(fileLines[line - 1] ?? "");
			clipped ||= shown.clipped;
			lines.push(line === match.line ? `${match.shown}:${line}: ${shown.text}` : `${match.shown}-${line}- ${shown.text}`);
		}
	}
	return { lines, clipped };
}

async function buildGrepResult(engine: "ripgrep" | "walk" | "box", collected: BoundedGrepCollected, context: number): Promise<TextToolResult> {
	const { matches, details, notices } = collected;
	details.engine = engine;
	if (matches.length === 0) {
		const emptyText = notices.length > 0 ? `No matches found\n\n[${notices.join(" ")}]` : "No matches found";
		return toolResult(emptyText, details);
	}
	const output = await grepOutputLines(matches, context);
	if (output.clipped && !details.linesTruncated) {
		details.linesTruncated = true;
		notices.push(`Some lines truncated to ${MAX_GREP_LINE_CHARS} chars. Use read to see full lines.`);
	}
	let text = output.lines.join("\n");
	if (text.length > MAX_GREP_OUTPUT_CHARS) {
		details.outputTruncated = true;
		text = text.slice(0, MAX_GREP_OUTPUT_CHARS);
		notices.push(`Output truncated at ${MAX_GREP_OUTPUT_CHARS / 1024}KB. Refine pattern or path for more.`);
	}
	if (notices.length > 0) text += `\n\n[${notices.join(" ")}]`;
	return toolResult(text, details);
}

/** Whether a file found under the path searched is one to search: open, and matching the call's glob. One file is matched by its name. */
function grepWants(call: FenceCall, guarded: PersistentRoomWorkspaceToolGuardResult, request: BoundedGrepRequest, real: string): boolean {
	if (entryClosed(call, guarded.root, real)) return false;
	const below = guarded.stat.isFile() ? path.basename(real) : normalizeSlashes(path.relative(guarded.real, real));
	return !request.glob || request.glob(below);
}

function grepWithRipgrep(
	rgPath: string,
	call: FenceCall,
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
		if (request.literal) args.push("--fixed-strings");
		// A glob with no slash means a file's name for both engines; one with a slash is held by the check on each result alone.
		if (request.globText && !request.globText.includes("/")) args.push("--glob", request.globText);
		const skips = walkSkips(guarded);
		args.push(...ripgrepDenyGlobArgs(skips));
		const searched = path.relative(guarded.root.path, guarded.real) || ".";
		args.push("-e", request.patternSource, "--", searched);
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(rgPath, args, { cwd: guarded.root.path, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolve(null);
			return;
		}
		const matches: GrepMatch[] = [];
		// Each file is judged once, however many of its lines match.
		const wanted = new Map<string, boolean>();
		let matchLimitReached = false;
		let linesTruncated = false;
		let timeBudgetReached = false;
		let settled = false;
		const timer = setTimeout(() => {
			timeBudgetReached = true;
			child.kill();
		}, remainingMs);
		timer.unref();
		// Stop ends the search; the caller then says it stopped.
		const stop = () => child.kill();
		request.signal?.addEventListener("abort", stop, { once: true });
		const settle = (result: TextToolResult | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", stop);
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
			const real = path.join(guarded.root.path, rawPath);
			let open = wanted.get(real);
			if (open === undefined) wanted.set(real, (open = grepWants(call, guarded, request, real)));
			if (!open) return;
			const shown = clippedLine(rawText.replace(/\r?\n$/, ""));
			linesTruncated ||= shown.clipped;
			matches.push({ real, shown: showPath(real, guarded.root), line: lineNumber, text: shown.text });
			if (matches.length >= request.limit) {
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
			if (request.signal?.aborted || (!timeBudgetReached && !matchLimitReached && code !== 0 && code !== 1)) {
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
			if (skips.size > 0) notices.push(WALK_SKIPPED_LINE);
			buildGrepResult("ripgrep", { matches, details, notices }, request.context).then(settle, () => settle(null));
		});
	});
}

async function grepWithWalk(
	call: FenceCall,
	guarded: PersistentRoomWorkspaceToolGuardResult,
	request: BoundedGrepRequest,
): Promise<TextToolResult> {
	let regex: RegExp;
	try {
		regex = new RegExp(request.literal ? request.patternSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : request.patternSource, request.ignoreCase ? "i" : "");
	} catch {
		throw new RoomFilesError("invalid_pattern", "Grep pattern is not a valid JavaScript regular expression.");
	}
	const limit = request.limit;
	const deadline = request.deadline;
	const skips = walkSkips(guarded);
	const matches: GrepMatch[] = [];
	let visited = 0;
	let matchLimitReached = false;
	let traversalLimitReached = false;
	let linesTruncated = false;
	let skippedLargeFiles = 0;
	let longLinesClipped = false;
	let timeBudgetReached = false;
	let skippedFolders = false;

	const scanFile = async (real: string, size: number): Promise<void> => {
		if (size > MAX_GREP_FILE_BYTES) {
			skippedLargeFiles += 1;
			return;
		}
		let content: string;
		try {
			content = await fs.promises.readFile(real, "utf-8");
		} catch {
			return;
		}
		const lines = content.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			if ((index & 255) === 0 && (Date.now() > deadline || request.signal?.aborted)) {
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
			const shown = clippedLine(line);
			linesTruncated ||= shown.clipped;
			matches.push({ real, shown: showPath(real, guarded.root), line: index + 1, text: shown.text });
			if (matches.length >= limit) {
				matchLimitReached = true;
				return;
			}
		}
	};

	const walk = async (directory: string): Promise<void> => {
		if (matchLimitReached || traversalLimitReached || timeBudgetReached || request.signal?.aborted) return;
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
			entries = await fs.promises.readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
		for (const entry of entries) {
			if (matchLimitReached || traversalLimitReached || timeBudgetReached) return;
			const entryPath = path.join(directory, entry.name);
			if (entryClosed(call, guarded.root, entryPath)) continue;
			let lstat: fs.Stats;
			try {
				lstat = await fs.promises.lstat(entryPath);
			} catch {
				continue;
			}
			if (lstat.isSymbolicLink()) continue;
			if (lstat.isDirectory()) {
				if (skips.has(foldPart(entry.name))) skippedFolders = true;
				else await walk(entryPath);
			} else if (lstat.isFile() && grepWants(call, guarded, request, entryPath)) {
				await scanFile(entryPath, lstat.size);
			}
		}
	};

	if (!guarded.stat.isFile()) await walk(guarded.real);
	else if (grepWants(call, guarded, request, guarded.real)) await scanFile(guarded.real, guarded.stat.size);
	stopSearchIfAborted(request.signal);
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (matchLimitReached) {
		details.matchLimitReached = limit;
		notices.push(`${limit} matches limit reached. Use limit=${Math.min(limit * 2, MAX_GREP_LIMIT)} for more, or refine pattern.`);
	}
	if (traversalLimitReached) {
		details.traversalLimitReached = MAX_FIND_VISITED;
		notices.push("Folder walk limit reached. Refine pattern or path for more.");
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
	if (skippedFolders) notices.push(WALK_SKIPPED_LINE);
	return buildGrepResult("walk", { matches, details, notices }, request.context);
}

const SEARCH_STOPPED = "Stopped before the search finished.";

function stopSearchIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new RoomFilesError("aborted", SEARCH_STOPPED);
}

async function executeWorkspaceGrep(policy: PersistentRoomCapabilityPolicy, input: WorkspaceGrepInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, held?: Held): Promise<TextToolResult> {
	stopSearchIfAborted(signal);
	return inTheBox(box, async (box) => {
		const { fence, files } = callFence(policy, box, answer, held);
		const call = newCall(fence);
		const guarded = guard(call.fence, input.path ?? ".", "find", files);
		if (files) return withLeftOutLine(await grepInBox(call, guarded, input, files, signal), call.leftOut.size, LEFT_OUT);
		return grepHere(call, guarded, input, signal);
	});
}

/**
 * The walk's search, run by the box's program: a pattern that takes too long
 * holds only the program, which is killed at the deadline. The fence leaves out
 * what it closes, and counts what the program couldn't open.
 */
async function grepInBox(call: FenceCall, guarded: PersistentRoomWorkspaceToolGuardResult, input: WorkspaceGrepInput, files: BoxFiles, signal: AbortSignal | undefined): Promise<TextToolResult> {
	const request = grepRequest(guarded, input, signal);
	const isFile = guarded.stat.isFile();
	const real = (rel: string) => (isFile ? guarded.real : path.join(guarded.real, ...rel.split("/")));
	let answer;
	try {
		answer = await files.search({ ...guarded, isFile }, input.path ?? ".", {
			pattern: request.patternSource,
			ignoreCase: request.ignoreCase,
			literal: request.literal,
			glob: request.globText ? { source: globToRegExp(request.globText).source, slash: request.globText.includes("/") } : null,
			context: request.context,
			limit: request.limit,
			deadline: request.deadline,
			skips: [...walkSkips(guarded)],
			maxFolders: MAX_FIND_VISITED,
			maxFileBytes: MAX_GREP_FILE_BYTES,
			maxScanLineChars: MAX_GREP_SCAN_LINE_CHARS,
			maxLineChars: MAX_GREP_LINE_CHARS,
		}, signal);
	} catch (error) {
		if (error instanceof RoomFilesError && error.code === "timeout") {
			return buildGrepResult("box", { matches: [], details: { timeBudgetReached: GREP_TIME_BUDGET_MS }, notices: [`Search stopped after ${GREP_TIME_BUDGET_MS / 1000}s. Refine pattern or path and try again.`] }, 0);
		}
		throw error;
	}
	const matches: GrepMatch[] = [];
	const open = new Map<string, boolean>();
	let linesTruncated = false;
	for (const match of answer.matches) {
		const place = real(match.rel);
		// The program searched a deck's name only where it found a deck.
		if (!open.has(place)) open.set(place, !entryClosed(call, guarded.root, place, true));
		if (!open.get(place)) continue;
		const shown = clippedLine(match.text);
		linesTruncated ||= shown.clipped;
		matches.push({ real: place, shown: showPath(place, guarded.root), line: match.line, text: shown.text, around: match.around });
	}
	// The box read none of these; a deck's name on one it couldn't open as a deck is a key's.
	for (const rel of answer.unreadable) entryClosed(call, guarded.root, real(rel), false);
	for (const entry of answer.top) entryClosed(call, guarded.root, path.join(guarded.real, entry.name), entry.deck);
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (answer.matchLimit) {
		details.matchLimitReached = request.limit;
		notices.push(`${request.limit} matches limit reached. Use limit=${Math.min(request.limit * 2, MAX_GREP_LIMIT)} for more, or refine pattern.`);
	}
	if (answer.folderLimit) {
		details.traversalLimitReached = MAX_FIND_VISITED;
		notices.push("Folder walk limit reached. Refine pattern or path for more.");
	}
	if (answer.largeFiles > 0) {
		details.skippedLargeFiles = answer.largeFiles;
		notices.push(`${answer.largeFiles} file(s) larger than ${MAX_GREP_FILE_BYTES / (1024 * 1024)} MiB were skipped.`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push(`Some lines truncated to ${MAX_GREP_LINE_CHARS} chars. Use read to see full lines.`);
	}
	if (answer.longLines) {
		details.longLinesClipped = true;
		notices.push(`Lines longer than ${MAX_GREP_SCAN_LINE_CHARS} chars were matched on their first ${MAX_GREP_SCAN_LINE_CHARS} chars only.`);
	}
	if (answer.timeLimit) {
		details.timeBudgetReached = GREP_TIME_BUDGET_MS;
		notices.push(`Search stopped after ${GREP_TIME_BUDGET_MS / 1000}s. Refine pattern or path and try again.`);
	}
	if (answer.skipped) notices.push(WALK_SKIPPED_LINE);
	return buildGrepResult("box", { matches, details, notices }, request.context);
}

async function grepHere(call: FenceCall, guarded: PersistentRoomWorkspaceToolGuardResult, input: WorkspaceGrepInput, signal: AbortSignal | undefined): Promise<TextToolResult> {
	const result = await grepWorkspace(call, guarded, input, signal);
	// ripgrep never walks into what its deny globs name, so the closed entries
	// right under the search folder are counted here.
	try {
		for (const entry of fs.readdirSync(guarded.real)) entryClosed(call, guarded.root, path.join(guarded.real, entry));
	} catch {}
	return withLeftOutLine(result, call.leftOut.size, LEFT_OUT);
}

async function grepWorkspace(call: FenceCall, guarded: PersistentRoomWorkspaceToolGuardResult, input: WorkspaceGrepInput, signal: AbortSignal | undefined): Promise<TextToolResult> {
	const request = grepRequest(guarded, input, signal);
	const rgPath = await resolveRipgrepBinary(request.deadline);
	if (rgPath) {
		try {
			const ripgrepResult = await grepWithRipgrep(rgPath, call, guarded, request);
			if (ripgrepResult) return ripgrepResult;
			stopSearchIfAborted(signal);
		} catch {
			// The fence must not depend on ripgrep working; the walk engine
			// answers whenever the ripgrep path fails for any reason.
		}
	}
	return grepWithWalk(call, guarded, request);
}

/** A search's inputs, checked once for both engines and the box. */
function grepRequest(guarded: PersistentRoomWorkspaceToolGuardResult, input: WorkspaceGrepInput, signal: AbortSignal | undefined): BoundedGrepRequest {
	if (!guarded.stat.isDirectory() && !guarded.stat.isFile()) {
		throw new RoomFilesError("not_file", `${guarded.shown} is not a file or a folder.`);
	}
	const patternSource = String(input.pattern ?? "");
	if (!patternSource) throw new RoomFilesError("missing_pattern", "Grep pattern is required.");
	if (patternSource.length > MAX_GREP_PATTERN_CHARS) {
		throw new RoomFilesError("invalid_pattern", `Grep pattern is too long (${MAX_GREP_PATTERN_CHARS} character limit).`);
	}
	const globText = typeof input.glob === "string" && input.glob.trim() ? normalizeSlashes(input.glob.trim()) : null;
	return {
		patternSource,
		ignoreCase: input.ignoreCase === true,
		literal: input.literal === true,
		glob: globText ? findPatternMatcher(globText) : null,
		globText,
		context: input.context === undefined ? 0 : normalizeLimit(input.context, 0, MAX_GREP_CONTEXT),
		limit: normalizeLimit(input.limit, DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT),
		deadline: Date.now() + GREP_TIME_BUDGET_MS,
		signal,
	};
}

function sliceReadLines(text: string, offset: number | undefined, limit: number | undefined): { text: string; nextOffset?: number; totalLines: number; startLine: number; endLine: number } {
	const lines = text.split("\n");
	const totalLines = lines.length;
	const startLine = offset === undefined ? 1 : Math.max(1, Math.floor(offset));
	if (!Number.isFinite(startLine) || startLine < 1 || startLine > totalLines) {
		throw new RoomFilesError("invalid_offset", "Offset is outside the selected file.");
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

/** What a read works on: a file, or in the box the private copy of its bytes, and how the tools show it. */
interface ReadTarget {
	real: string;
	shown: string;
	size: number;
}

async function executeWorkspaceReadXlsx(guarded: ReadTarget, input: WorkspaceReadInput): Promise<TextToolResult> {
	if (guarded.size > MAX_SPREADSHEET_BYTES) {
		throw new RoomFilesError("file_too_large", "Workbook is too large for this tool.");
	}
	let buffer: Buffer;
	try {
		buffer = await fs.promises.readFile(guarded.real);
	} catch {
		throw new RoomFilesError("not_readable", "Workbook cannot be read.");
	}
	let preview: { text: string; details: Record<string, unknown> };
	try {
		preview = renderSpreadsheetPreview(buffer, path.posix.basename(normalizeSlashes(guarded.shown)), {
			sheet: input.sheet,
			startRow: input.offset,
			maxRows: input.limit,
			maxColumns: input.columns,
		});
	} catch (error) {
		if (error instanceof SpreadsheetPreviewError) {
			if (error.code === "not_readable") {
				throw new RoomFilesError("not_readable", "Workbook cannot be read.");
			}
			throw new RoomFilesError(error.code, error.message);
		}
		throw error;
	}
	return toolResult(preview.text, { path: guarded.shown, ...preview.details });
}

async function executeWorkspaceReadImage(guarded: ReadTarget, mimeType: string): Promise<TextToolResult> {
	let buffer: Buffer;
	try {
		buffer = await fs.promises.readFile(guarded.real);
	} catch {
		throw new RoomFilesError("not_readable", "File cannot be read.");
	}
	const resized = await resizeImage({ type: "image", data: buffer.toString("base64"), mimeType });
	if ("failure" in resized) {
		return toolResult(`Read image file [${mimeType}]\n${imageOmittedNote(resized)}`, { path: guarded.shown });
	}
	const dimensionNote = formatDimensionNote(resized);
	let textNote = `Read image file [${resized.mimeType}]`;
	if (dimensionNote) textNote += `\n${dimensionNote}`;
	return {
		content: [
			{ type: "text", text: textNote },
			{ type: "image", data: resized.data, mimeType: resized.mimeType },
		],
		details: { path: guarded.shown },
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

const WORKSPACE_DOCUMENT_SCANNED_PDF_NOTE = "This PDF has no extractable text (likely a scanned document). Add it to this room's Attachments to read its pages visually.";

/**
 * The shared pdf/docx read path: the shelf's isolated extraction worker, then
 * the read tool's own line windowing so offset/limit page documents exactly
 * like text files. No reading cache here: the shelf cache is keyed per room+name and
 * does not fit room folder paths, and extraction is fast enough for typical
 * documents — correctness over cleverness.
 *
 * Throws RoomFilesError (file_too_large, invalid_offset) and
 * lets the worker's PersistentRoomShelfError (timeout/crash/parse failure)
 * pass through — each caller maps that to its own surface's honest phrasing.
 */
export async function executeWorkspaceDocumentRead(
	target: { absolutePath: string; sizeBytes: number; kind: "pdf" | "docx"; displayPath: string },
	offset: number | undefined,
	limit: number | undefined,
): Promise<TextToolResult> {
	if (target.sizeBytes > SHELF_READ_MAX_FILE_BYTES) {
		throw new RoomFilesError("file_too_large", "Document is too large for this tool.");
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

async function executeWorkspaceRead(policy: PersistentRoomCapabilityPolicy, input: WorkspaceReadInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, held?: Held): Promise<TextToolResult> {
	return inTheBox(box, async (box) => {
		const { fence, files } = callFence(policy, box, answer, held);
		const guarded = guard(fence, input.path, "read", files);
		if (!guarded.stat.isFile()) {
			throw new RoomFilesError("not_file", "Path is not a file.");
		}
		if (!files) return readFile({ real: guarded.real, shown: guarded.shown, size: guarded.stat.size }, input);
		const bytes = await files.read(guarded, input.path, signal);
		return withPrivateCopy(path.basename(guarded.real), bytes, (copy) => readFile({ real: copy, shown: guarded.shown, size: bytes.length }, input));
	});
}

/**
 * Runs the parsers on a copy of what the box handed back, in a folder of the
 * server's own temp, which commands can't reach, made fresh for this call and
 * removed after. The copy keeps the file's name, so its kind reads the same.
 */
async function withPrivateCopy<T>(name: string, bytes: Buffer, use: (copy: string) => Promise<T>): Promise<T> {
	const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), "exxperts-file-copy-"));
	try {
		const copy = path.join(folder, name);
		await fs.promises.writeFile(copy, bytes, { flag: "wx", mode: 0o600 });
		return await use(copy);
	} finally {
		await fs.promises.rm(folder, { recursive: true, force: true });
	}
}

async function readFile(guarded: ReadTarget, input: WorkspaceReadInput): Promise<TextToolResult> {
	if (extensionLowercase(guarded.real) === ".xlsx") {
		return executeWorkspaceReadXlsx(guarded, input);
	}
	const imageMimeType = await detectImageMimeTypeSafe(guarded.real);
	if (imageMimeType) {
		return executeWorkspaceReadImage(guarded, imageMimeType);
	}
	const documentKind = sniffWorkspaceDocumentKind(guarded.real, path.posix.basename(normalizeSlashes(guarded.shown)));
	if (documentKind) {
		try {
			return await executeWorkspaceDocumentRead({ absolutePath: guarded.real, sizeBytes: guarded.size, kind: documentKind, displayPath: guarded.shown }, input.offset, input.limit);
		} catch (error) {
			// Worker failures (timeout, crash, hostile document) stay generic here:
			// the bounded surface never relays parser internals.
			if (error instanceof PersistentRoomShelfError) {
				throw new RoomFilesError("not_readable", "File cannot be read.");
			}
			throw error;
		}
	}
	let raw: string;
	try {
		raw = await fs.promises.readFile(guarded.real, "utf-8");
	} catch {
		throw new RoomFilesError("not_readable", "File cannot be read.");
	}
	const sliced = sliceReadLines(raw, input.offset, input.limit);
	const truncated = truncateReadBytes(sliced.text);
	const notices: string[] = [];
	if (truncated.truncated) notices.push(`${DEFAULT_READ_MAX_BYTES / 1024}KB limit reached. Use offset to continue.`);
	if (sliced.nextOffset !== undefined) notices.push(`Showing lines ${sliced.startLine}-${sliced.endLine} of ${sliced.totalLines}. Use offset=${sliced.nextOffset} to continue.`);
	const output = notices.length > 0 ? `${truncated.text}\n\n[${notices.join(" ")}]` : truncated.text;
	return toolResult(output, { path: guarded.shown, truncated: truncated.truncated || sliced.nextOffset !== undefined });
}

function extensionLowercase(displayPath: string): string {
	return path.posix.extname(normalizeSlashes(displayPath)).toLowerCase();
}

export const CHANGE_STOPPED = "Stopped before the file was changed.";
// The same words as the box's own for a file tool stopped (room-box/box-files.ts).
const TOOL_STOPPED = "Stopped before the file tool finished.";

/** A Stop that came before the file is touched leaves it as it was. */
function stopIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new RoomFilesError("aborted", CHANGE_STOPPED);
}

/** The line for a file the program wrote. */
function written(shown: string, bytes: number, existed: boolean): TextToolResult {
	return toolResult(existed ? `file overwritten at ${shown} (${bytes} bytes)` : `file generated to ${shown} (${bytes} bytes)`, {
		ok: true,
		path: shown,
		bytes,
		created: !existed,
		overwritten: existed,
	});
}

async function executeWorkspaceWrite(policy: PersistentRoomCapabilityPolicy, input: WorkspaceWriteInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, held?: Held): Promise<TextToolResult> {
	stopIfAborted(signal);
	if (typeof input.content !== "string") {
		throw new RoomFilesError("invalid_content", "Content is required.");
	}
	const rawPath = String(input.path ?? "").trim();
	if (/[\\/]$/.test(rawPath)) throw new RoomFilesError("not_file", `${rawPath} is not a file.`);
	return inTheBox(box, (box) => writeFile(policy, input, rawPath, box, signal, answer, held));
}

async function writeFile(policy: PersistentRoomCapabilityPolicy, input: WorkspaceWriteInput & { content: string }, rawPath: string, box: RoomBox | undefined, signal: AbortSignal | undefined, answer: AnswerFolders | undefined, held: Held | undefined): Promise<TextToolResult> {
	const { fence, files } = callFence(policy, box, answer, held);
	const target = fencePath(fence, rawPath, "write", { decksInBox: files !== null });
	if (target.root.room && target.shown === ".") throw new RoomFilesError("not_file", `${rawPath} is not a file.`);
	if (target.exists && input.overwrite !== true) {
		throw new RoomFilesError("file_exists", `File already exists in selected workspace. Set overwrite=true to replace ${target.shown}.`);
	}
	// One change at a time to a file, as the edit tool does, so two calls at once never both decide on what was there before.
	return withFileMutationQueue(target.real, async () => {
		stopIfAborted(signal);
		if (files) {
			// The program makes the folders and opens the file in the box, which refuses a closed name on the way, whenever it came.
			const { existed } = await files.write(target, rawPath, input.content, input.overwrite === true, signal);
			return written(target.shown, Buffer.byteLength(input.content, "utf-8"), existed);
		}
		try {
			await fs.promises.mkdir(path.dirname(target.real), { recursive: true });
		} catch {
			throw new RoomFilesError("not_writable", `${target.shown} can't be written.`);
		}
		// The folders just made are checked again: the fence decides on what is there now.
		const checked = fencePath(fence, rawPath, "write");
		const bytes = Buffer.byteLength(input.content, "utf-8");
		try {
			let existing: fs.Stats | null = null;
			try {
				existing = await fs.promises.lstat(checked.real);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (existing && !existing.isFile()) throw new RoomFilesError("not_file", `${checked.shown} is not a file.`);
			stopIfAborted(signal);
			// Without overwrite the open itself refuses a file that is there, whenever it came.
			await fs.promises.writeFile(checked.real, input.content, { encoding: "utf-8", flag: input.overwrite === true ? "w" : "wx" });
			return written(checked.shown, bytes, Boolean(existing));
		} catch (error) {
			if (error instanceof RoomFilesError) throw error;
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new RoomFilesError("file_exists", `File already exists in selected workspace. Set overwrite=true to replace ${checked.shown}.`);
			}
			throw new RoomFilesError("not_writable", `${checked.shown} can't be written.`);
		}
	});
}

async function executeWorkspaceEdit(policy: PersistentRoomCapabilityPolicy, input: WorkspaceEditInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, held?: Held): Promise<TextToolResult> {
	stopIfAborted(signal);
	return inTheBox(box, async (box) => {
		const { fence, files } = callFence(policy, box, answer, held);
		const guarded = guard(fence, input.path, "write", files);
		if (!guarded.stat.isFile()) {
			throw new RoomFilesError("not_file", `${guarded.shown} is not a file.`);
		}
		if (!Array.isArray(input.edits) || input.edits.length === 0) {
			throw new RoomFilesError("invalid_edits", "edits must contain at least one replacement.");
		}
		const edits = input.edits.map((edit) => ({ oldText: String(edit?.oldText ?? ""), newText: String(edit?.newText ?? "") }));
		// Read, change and write back as one step per file, so an edit at the same time works from this one's result.
		return withFileMutationQueue(guarded.real, () => editFile(guarded, input.path, edits, files, signal));
	});
}

async function editFile(guarded: PersistentRoomWorkspaceToolGuardResult, raw: string, edits: Array<{ oldText: string; newText: string }>, files: Files, signal: AbortSignal | undefined): Promise<TextToolResult> {
	let buffer: Buffer;
	if (files) {
		buffer = await files.read(guarded, raw, signal);
	} else {
		try {
			buffer = await fs.promises.readFile(guarded.real);
		} catch {
			throw new RoomFilesError("not_readable", `${guarded.shown} can't be read.`);
		}
	}
	const content = buffer.toString("utf-8");
	if (!Buffer.from(content, "utf-8").equals(buffer)) {
		throw new RoomFilesError("not_utf8", "File is not valid UTF-8 text and cannot be edited with this tool.");
	}
	const { bom, text } = stripBom(content);
	const lineEnding = detectLineEnding(text);
	const normalized = normalizeToLF(text);
	let newContent: string;
	try {
		newContent = applyEditsToNormalizedContent(normalized, edits, guarded.shown).newContent;
	} catch (error) {
		throw new RoomFilesError("edit_failed", error instanceof Error ? error.message : String(error));
	}
	const nextContent = bom + restoreLineEndings(newContent, lineEnding);
	const bytes = Buffer.byteLength(nextContent, "utf-8");
	stopIfAborted(signal);
	if (files) {
		await files.write(guarded, raw, nextContent, true, signal);
	} else {
		try {
			await fs.promises.writeFile(guarded.real, nextContent, { encoding: "utf-8", flag: "w" });
		} catch {
			throw new RoomFilesError("not_writable", `${guarded.shown} can't be written.`);
		}
	}
	const editCount = edits.length;
	return toolResult(`file edited at ${guarded.shown} (${editCount} ${editCount === 1 ? "edit" : "edits"}, ${bytes} bytes)`, {
		ok: true,
		path: guarded.shown,
		edits: editCount,
		bytes,
	});
}

/**
 * The folders a call's fence may open, by the names stored for them: the room's
 * folder as it was chosen, its list and the running answer's own. Read before
 * anything on disk is, so nothing is resolved through a folder a command holds.
 */
function namedFolders(policy: PersistentRoomCapabilityPolicy, answer: AnswerFolders | undefined): string[] {
	const room = policy.roots[0];
	const listed = readAlsoAllowed(policy.agentId).folders;
	return [...(room ? [room.realpath, room.path] : []), ...(answer?.over(listed) ?? listed).map((entry) => entry.path)];
}

/**
 * What a session passes. `box` is the turn's box on a person's Mac: each call
 * then reads and writes inside it. The live bind still passes the other three;
 * the fence reads the room's folder, its list and its approved skills itself,
 * so none of those is used.
 */
export interface PersistentRoomWorkspaceToolsOptions {
	box?: RoomBox;
	localFilesCwd?: string;
	skillsFolder?: () => string | null;
	terminalOn?: () => boolean;
	/** The running answer's own folders, read at each call. Only a live answer at the computer has any. */
	answer?: () => AnswerFolders;
	/** Whether the room's folder ask is offered with someone there to answer it, read at each refused write. */
	asks?: () => boolean;
	/** For a Windows room whose commands run in the box: each call waits for every boxed command on its folders, and holds them while it runs. */
	folderWait?: FolderWait;
}

/** A write refused for a folder the room can only read says what the model does next. */
function sayingWhatNext<T>(change: () => Promise<T>, asks: PersistentRoomWorkspaceToolsOptions["asks"]): Promise<T> {
	return change().catch((error: unknown) => {
		if (error instanceof RoomFilesError && error.code === "read_only_folder") throw new RoomFilesError(error.code, `${error.message} ${readOnlyNextLine(asks?.() === true)}`);
		throw error;
	});
}

const FENCE_LINE = "Paths may be relative to this room's folder, absolute, or start with ~; only this room's folder and the folders allowed for it open, links are not followed, and secret files and the app's own data stay closed.";

/**
 * Every room's six file tools, Full access and Bounded alike: each call stops
 * at the room's fence (room-files.ts) as it stands at that call. A room whose
 * folder moved still gets its tools, and each call says so.
 */
export function createPersistentRoomWorkspaceTools(policy: PersistentRoomCapabilityPolicy, options?: PersistentRoomWorkspaceToolsOptions): Array<ToolDefinition<any, any>> {
	const box = options?.box;
	const selectedToolNames = new Set(persistentRoomWorkspaceToolNamesForPolicy(policy));
	if (!isPersistentRoomWorkspaceToolBundleEnabled(policy) || policy.roots.length < 1) return [];
	box?.serveFiles();
	// A call waits for every boxed command on the folders its fence may open, and holds them to its end.
	const waited = async <T>(signal: AbortSignal | undefined, stopped: string, call: (answer: AnswerFolders | undefined, held?: Held) => Promise<T>): Promise<T> => {
		const answer = options?.answer?.();
		const wait = options?.folderWait;
		if (!wait) return call(answer);
		let folders = namedFolders(policy, answer);
		for (;;) {
			const holding = folders;
			const held: Held = (folder) => holding.some((each) => wait.inside(folder, each));
			const ran = await wait.hold<{ result: T } | { more: string[] }>("file", holding, signal, async () => {
				const now = namedFolders(policy, answer);
				// A folder given while it waited is held too before the fence looks.
				if (!now.every(held)) return { more: now };
				return { result: await call(answer, held) };
			}, () => new RoomFilesError("aborted", stopped));
			if ("result" in ran) return ran.result;
			folders = [...new Set([...holding, ...ran.more])];
		}
	};
	const lsTool: ToolDefinition<typeof workspaceLsSchema, Record<string, unknown> | undefined> = {
		name: "ls",
		label: "ls",
		description: `List files and folders. ${FENCE_LINE} Closed entries are left out and counted. Links are marked with @ and not followed.`,
		promptSnippet: "List the files and folders in a folder this room can open",
		parameters: workspaceLsSchema,
		execute: async (_toolCallId, params, signal) => waited(signal, TOOL_STOPPED, (answer, held) => executeWorkspaceLs(policy, params, box, signal, answer, held)),
	};
	const findTool: ToolDefinition<typeof workspaceFindSchema, Record<string, unknown> | undefined> = {
		name: "find",
		label: "find",
		description: `Find files and folders by a glob pattern (folders end with /), matched against paths relative to the room's folder, or to the allowed folder searched. ${FENCE_LINE} Results include files .gitignore would hide; folders named .git and node_modules are searched only when the path is inside one.`,
		promptSnippet: "Find files by name in the folders this room can open",
		parameters: workspaceFindSchema,
		execute: async (_toolCallId, params, signal) => waited(signal, SEARCH_STOPPED, (answer, held) => executeWorkspaceFind(policy, params, box, signal, answer, held)),
	};
	const readTool: ToolDefinition<typeof workspaceReadSchema, Record<string, unknown> | undefined> = {
		name: "read",
		label: "read",
		description: `Read a file. ${FENCE_LINE} Supports text files (output is truncated safely; use offset/limit to continue large files), images (jpg, png, gif, webp; sent as attachments), PDF and Word (.docx) documents (extracted as text and paged with offset/limit; scanned PDFs without a text layer are called out honestly), and .xlsx spreadsheets previewed as a markdown table (default 30 rows and 12 columns of the first sheet; use sheet, offset, limit, and columns to control the previewed window).`,
		promptSnippet: "Read files (text, images, pdf/docx extraction, .xlsx previews) in the folders this room can open",
		parameters: workspaceReadSchema,
		execute: async (_toolCallId, params, signal) => waited(signal, TOOL_STOPPED, (answer, held) => executeWorkspaceRead(policy, params, box, signal, answer, held)),
	};
	const grepTool: ToolDefinition<typeof workspaceGrepSchema, Record<string, unknown> | undefined> = {
		name: "grep",
		label: "grep",
		description: `Search file contents line by line; matching lines come back as 'path:line: text', and with context the lines around them as 'path-line- text'. ${FENCE_LINE} Use glob to search only some files and literal for a plain string. Output is bounded by match, line-length, file-size, and total-output limits; refine pattern or path for more focused results. Results include files .gitignore would hide; folders named .git and node_modules are searched only when the path is inside one.`,
		promptSnippet: "Search file contents in the folders this room can open",
		parameters: workspaceGrepSchema,
		execute: async (_toolCallId, params, signal) => waited(signal, SEARCH_STOPPED, (answer, held) => executeWorkspaceGrep(policy, params, box, signal, answer, held)),
	};
	const writeTool: ToolDefinition<typeof workspaceWriteSchema, Record<string, unknown> | undefined> = {
		name: "write",
		label: "write",
		description: `Create or explicitly overwrite a file; any file type. ${FENCE_LINE} Only folders this room can change take a write, and files other programs run, such as git settings and editor folders, can be read but not changed. Parent folders are created as needed. Existing files are rejected unless overwrite=true. Ask before overwriting unless the user explicitly requested it. After success, tell the user the file's path and do not paste the full written content.`,
		promptSnippet: "Create or explicitly overwrite files in the folders this room can change",
		parameters: workspaceWriteSchema,
		execute: async (_toolCallId, params, signal) => sayingWhatNext(() => waited(signal, CHANGE_STOPPED, (answer, held) => executeWorkspaceWrite(policy, params, box, signal, answer, held)), options?.asks),
	};
	const editTool: ToolDefinition<typeof workspaceEditSchema, Record<string, unknown> | undefined> = {
		name: "edit",
		label: "edit",
		description: `Edit an existing file by replacing exact text. Each edits[].oldText is matched against the original file, must be unique in it, and must not overlap another edit in the same call; if two changes touch the same block or nearby lines, merge them into one edit. ${FENCE_LINE} Only folders this room can change take an edit. Only UTF-8 text files can be edited.`,
		promptSnippet: "Edit files by exact text replacement in the folders this room can change",
		parameters: workspaceEditSchema,
		execute: async (_toolCallId, params, signal) => sayingWhatNext(() => waited(signal, CHANGE_STOPPED, (answer, held) => executeWorkspaceEdit(policy, params, box, signal, answer, held)), options?.asks),
	};
	return [lsTool, findTool, grepTool, readTool, writeTool, editTool].filter((tool) => selectedToolNames.has(String(tool.name)));
}
