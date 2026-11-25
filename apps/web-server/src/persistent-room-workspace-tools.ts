import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Type, type Static } from "typebox";
import { applyEditsToNormalizedContent, detectLineEnding, detectSupportedImageMimeTypeFromFile, ensureTool, formatDimensionNote, getToolPath, imageOmittedNote, MAX_SPREADSHEET_BYTES, normalizeToLF, renderSpreadsheetPreview, resizeImage, restoreLineEndings, SpreadsheetPreviewError, stripBom, getAgentDir, type ToolDefinition, withFileMutationQueue, writeFileAtomic } from "@exxeta/exxperts-runtime";
import { isPersistentRoomWorkspaceToolBundleEnabled, persistentRoomWorkspaceToolNamesForPolicy } from "./persistent-room-tool-policy.js";
import { PersistentRoomShelfError } from "./persistent-room-shelf.js";
import { SHELF_READ_MAX_FILE_BYTES, runShelfParseWorker, shelfPdfExtractionIsBlank, sniffShelfFileBuffer } from "./persistent-room-shelf-reading.js";
import type { PersistentRoomCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { IN_FLIGHT_TEMPORARY_MARK, roomFilesAreTheFolder } from "./room-files-folder.js";
import { PERSISTENT_ROOM_APP_SIBLING_GLOBS, PERSISTENT_ROOM_APP_STATE_SEGMENTS, PERSISTENT_ROOM_SECRET_FILENAME_TEMPLATES, PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS } from "./persistent-room-workspace-policy.js";
import { BeyondNotHeld, type ClosedKeys, closedRefusal, type DataRead, type FenceAccess, type FencedPath, type FenceRoot, fencePath, foldPart, globToRegExp, linkRefused, matchesGlob, normalizeSlashes, RoomFilesError, roomFence as fenceWith, type RoomFence, roomFilesFence, showPath } from "./room-files.js";
import { BoundedPattern, oneSearchAtATime, SearchTooSlow } from "./room-files-search.js";
import { BoxFiles, boxedCommandSinceStart, FILES_STOPPED_LINE, notEnoughSpace, READ_LIMIT_BYTES, type SearchMatch, tooLargeForTool } from "./room-box/box-files.js";
import { BoxFault } from "./room-box/box-process.js";
import type { RoomBox } from "./room-box/box-session.js";
import { readOnlyNextLine, type ReadOnlyNext } from "./room-box/card-text.js";
import { readAlsoAllowed } from "./room-box/also-allowed.js";
import type { AnswerFolders } from "./room-box/folder-question.js";
import type { FolderWait } from "./room-box/windows/folder-wait.js";
import { roomSkillFolders } from "./skills-executable.js";
import { agentSkillsDir } from "./skills-store.js";

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
// The room's own files on a shared server: one plain name, no folder.
const FILES_PATH_RULE = "a file's name in this room's files, such as notes-plan.md; no folders, absolute paths or ~";

/** The tools' inputs, with the path rule the room's fence keeps. */
function workspaceSchemas(pathRule: string, where: string) {
	const workspaceReadSchema = Type.Object({
		path: Type.String({ description: `Path to the file to read: ${pathRule}.` }),
		offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed). For .xlsx files: row to start the preview from (1-indexed)." })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read. For .xlsx files: rows to preview (default 30, hard cap 100)." })),
		sheet: Type.Optional(Type.Union([Type.String(), Type.Number()], {
			description: "Sheet name or 1-based sheet index to preview (.xlsx files only)",
		})),
		columns: Type.Optional(Type.Number({ description: "Maximum columns to preview (default 12, hard cap 30) (.xlsx files only)" })),
	});

	const workspaceLsSchema = Type.Object({
		path: Type.Optional(Type.String({ description: `Folder to list: ${pathRule}. Defaults to '.', ${where}.` })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)." })),
	});

	const workspaceFindSchema = Type.Object({
		pattern: Type.String({ description: "Glob pattern for files under the folder searched, e.g. '*.md', '**/*.json', or 'src/**/*.ts'." }),
		path: Type.Optional(Type.String({ description: `Folder to search in: ${pathRule}. Defaults to '.', ${where}.` })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of matching files to return (default: 1000)." })),
	});

	const workspaceGrepSchema = Type.Object({
		pattern: Type.String({ description: "Search pattern as JavaScript regular expression source, e.g. 'TODO' or 'export (function|const)', or a plain string with literal." }),
		path: Type.Optional(Type.String({ description: `File or folder to search in: ${pathRule}. Defaults to '.', ${where}.` })),
		glob: Type.Optional(Type.String({ description: "Search only files matching this glob, e.g. '*.ts' or 'src/**/*.spec.ts'." })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a plain string instead of a regular expression (default: false)." })),
		context: Type.Optional(Type.Number({ description: `Lines to show before and after each match (default: 0, at most ${MAX_GREP_CONTEXT}).` })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 200, hard cap 1000)." })),
	});

	const workspaceWriteSchema = Type.Object({
		path: Type.String({ description: `Path for the file to create or explicitly overwrite: ${pathRule}.` }),
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
			path: Type.String({ description: `Path to the existing file to edit: ${pathRule}.` }),
			edits: Type.Array(workspaceEditReplaceSchema, {
				description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
			}),
		},
		{ additionalProperties: false },
	);
	return { read: workspaceReadSchema, ls: workspaceLsSchema, find: workspaceFindSchema, grep: workspaceGrepSchema, write: workspaceWriteSchema, edit: workspaceEditSchema };
}

const FOLDER_SCHEMAS = workspaceSchemas(PATH_RULE, "the room's folder");
const FILES_SCHEMAS = workspaceSchemas(FILES_PATH_RULE, "the room's files");
const workspaceReadSchema = FOLDER_SCHEMAS.read;
const workspaceLsSchema = FOLDER_SCHEMAS.ls;
const workspaceFindSchema = FOLDER_SCHEMAS.find;
const workspaceGrepSchema = FOLDER_SCHEMAS.grep;
const workspaceWriteSchema = FOLDER_SCHEMAS.write;
const workspaceEditSchema = FOLDER_SCHEMAS.edit;

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

/**
 * The folders of the skills on in the room that it may open (`roomSkillFolders`), opened for reading only.
 * A shared-folder skill's opens at the real folder its walk found, never resolved again here.
 */
function onSkillFolders(roomId: string): DataRead[] {
	return roomSkillFolders(roomId).flatMap((skill) => {
		if (skill.shared) return [{ path: skill.skillDir, shared: true as const }];
		try {
			return [{ path: fs.realpathSync.native(skill.skillDir) }];
		} catch {
			return [];
		}
	});
}

/** The app's skills folder by its real path, so a refusal there can say what it is (`skillsFolderRefusal`); undefined when it isn't there. */
function skillsFolderReal(): string | undefined {
	try {
		return fs.realpathSync.native(agentSkillsDir());
	} catch {
		return undefined;
	}
}

/** Whether a folder is at or inside what a call that waited holds (`folderWait`). */
type Held = (folder: string) => boolean;

/** What one call may reach: with `held`, only what it holds; with `free`, as a room that asks nothing, beyond its folders too. */
interface Reach {
	held?: Held;
	free?: boolean;
	/** The free bytes on a folder's disk (`freeSpace`). */
	freeSpace?: (folder: string) => number;
	/** The running answer's temp for its commands, so a refusal there says what it is (`ownTempRefusal`). */
	temp?: string;
}

/**
 * The room's fence as the file tools see it: its folders and the running answer's own, its skills' folders for reading, and in the box this turn's long output.
 * With `held`, it opens only the folders the call holds: one given later waits for the next call.
 */
function roomFence(policy: PersistentRoomCapabilityPolicy, box?: RoomBox, answer?: AnswerFolders, { held, free = false, temp }: Reach = {}): RoomFence {
	// On a shared server the room's own files, found from the room: never a stored folder, list or skill.
	if (roomFilesAreTheFolder()) return roomFilesFence(policy.agentId);
	const opened = fenceWith(policy, (roomId) => [...onSkillFolders(roomId), ...(box?.spills() ?? []).map((spill) => ({ path: spill }))], answer, free, skillsFolderReal());
	const fence = temp ? { ...opened, ownTemp: temp } : opened;
	return held ? { ...fence, roots: () => fence.roots().filter((root) => held(root.path)), beyond: fence.beyond && { ...fence.beyond, held } } : fence;
}

/** Where a call reads and writes: the room's box, or null for the server's own reads behind the fence. */
type Files = BoxFiles | null;

/** One call's fence, and the box it reads and writes through when there is one. */
function callFence(policy: PersistentRoomCapabilityPolicy, box?: RoomBox, answer?: AnswerFolders, reach: Reach = {}): { fence: RoomFence; files: Files } {
	const fence = roomFence(policy, box, answer, reach);
	return { fence, files: box ? new BoxFiles(box, fence) : null };
}

/** The box opens only the room's folders: a path beyond them, in a room that asks nothing, is the server's to open. */
const filesFor = (fenced: FencedPath, files: Files): Files => (fenced.root.beyond ? null : files);

/**
 * Where a room that asks nothing would open a folder now, the fence's refusal
 * or a missing folder thrown as a file call's: ask_for_folder says only what a call would find.
 * A Keynote deck's name is judged here by the file's bytes, as the Mac's box judges it on a read.
 */
export function openedWithoutAsking(policy: PersistentRoomCapabilityPolicy, rawPath: string, access: FenceAccess, answer?: AnswerFolders): FencedPath {
	const fenced = fencePath(roomFence(policy, undefined, answer, { free: true }), rawPath, access);
	if (!fenced.exists) throw new RoomFilesError("path_not_found", `Path not found: ${String(rawPath).trim()}`);
	return fenced;
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

async function executeWorkspaceLs(policy: PersistentRoomCapabilityPolicy, input: WorkspaceLsInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, reach: Reach = {}): Promise<TextToolResult> {
	return inTheBox(box, async (box) => {
		const { fence, files } = callFence(policy, box, answer, reach);
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
	files = filesFor(guarded, files);
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

async function executeWorkspaceFind(policy: PersistentRoomCapabilityPolicy, input: WorkspaceFindInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, reach: Reach = {}): Promise<TextToolResult> {
	return inTheBox(box, async (box) => {
		const { fence, files } = callFence(policy, box, answer, reach);
		const call = newCall(fence);
		const found = fence.kind === "files" ? await findInFiles(call, input, policy.agentId, signal) : await findWorkspace(call, input, files, signal);
		return withLeftOutLine(found, call.leftOut.size, LEFT_OUT);
	});
}

/** The path a find pattern is matched against: relative to the place that opened it, or beyond the room's folders to the folder searched. */
function matchedPath(real: string, guarded: PersistentRoomWorkspaceToolGuardResult): string {
	return normalizeSlashes(path.relative(guarded.root.beyond ? guarded.real : guarded.root.path, real));
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
		if (matches(matchedPath(entryPath, guarded))) found.results.push(entry.kind === "dir" ? `${showPath(entryPath, guarded.root)}/` : showPath(entryPath, guarded.root));
	}
	return found;
}

async function findWorkspace(call: FenceCall, input: WorkspaceFindInput, files: Files, signal: AbortSignal | undefined): Promise<TextToolResult> {
	const raw = input.path ?? ".";
	const guarded = guard(call.fence, raw, "find", files);
	files = filesFor(guarded, files);
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
				if (matches(matchedPath(entryPath, guarded))) results.push(`${showPath(entryPath, guarded.root)}/`);
				if (skips.has(foldPart(entry.name))) skippedFolders = true;
				else await walk(entryPath);
			} else if (lstat.isFile()) {
				if (matches(matchedPath(entryPath, guarded))) results.push(showPath(entryPath, guarded.root));
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

function ripgrepDenyGlobArgs(skips: ReadonlySet<string>, keys: ClosedKeys): string[] {
	// These globs keep ripgrep from reading most closed content; the fence's
	// check on every result stays the guarantee.
	const args: string[] = [];
	for (const segment of [...PERSISTENT_ROOM_APP_STATE_SEGMENTS, ...skips]) {
		const literal = escapeRipgrepGlobLiteral(segment);
		for (const glob of [`!**/${literal}/**`, `!${literal}/**`, `!**/${literal}`]) args.push("--glob", glob);
	}
	for (const filenameGlob of keys.filenames) {
		// ripgrep cannot re-open a template its skip covers: a later positive glob
		// would turn into an include list. A Keynote deck shares its name with a
		// key and opens, so the fence alone tells them apart.
		if (PERSISTENT_ROOM_SECRET_FILENAME_TEMPLATES.some((template) => matchesGlob(template, filenameGlob))) continue;
		if ((PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS as readonly string[]).includes(filenameGlob)) continue;
		for (const glob of [`!**/${filenameGlob}`, `!${filenameGlob}`]) args.push("--glob", glob);
	}
	for (const credentialPath of keys.credentials) {
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
		args.push(...ripgrepDenyGlobArgs(skips, call.fence.keys));
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
			// Beyond the room's folders the file is judged on what was opened, and its context comes from these same bytes.
			content = guarded.root.beyond ? (await readOpened({ real, shown: real })).toString("utf-8") : await fs.promises.readFile(real, "utf-8");
		} catch (error) {
			if (error instanceof RoomFilesError && error.code === "blocked_by_policy") call.leftOut.add(real);
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
			const start = Math.max(0, index - request.context);
			matches.push({ real, shown: showPath(real, guarded.root), line: index + 1, text: shown.text, ...(guarded.root.beyond && request.context > 0 ? { around: { start: start + 1, lines: lines.slice(start, index + request.context + 1) } } : {}) });
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

async function executeWorkspaceGrep(policy: PersistentRoomCapabilityPolicy, input: WorkspaceGrepInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, reach: Reach = {}): Promise<TextToolResult> {
	stopSearchIfAborted(signal);
	return inTheBox(box, async (box) => {
		const { fence, files } = callFence(policy, box, answer, reach);
		const call = newCall(fence);
		const guarded = guard(call.fence, input.path ?? ".", "find", files);
		const inBox = filesFor(guarded, files);
		if (inBox) return withLeftOutLine(await grepInBox(call, guarded, input, inBox, signal), call.leftOut.size, LEFT_OUT);
		return grepHere(call, guarded, input, signal, policy.agentId);
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

async function grepHere(call: FenceCall, guarded: PersistentRoomWorkspaceToolGuardResult, input: WorkspaceGrepInput, signal: AbortSignal | undefined, roomId: string): Promise<TextToolResult> {
	const result = call.fence.kind === "files" ? await grepInFiles(call, guarded, input, signal, roomId) : await grepWorkspace(call, guarded, input, signal);
	// ripgrep never walks into what its deny globs name, so the closed entries
	// right under the search folder are counted here.
	try {
		for (const entry of fs.readdirSync(guarded.real)) entryClosed(call, guarded.root, path.join(guarded.real, entry));
	} catch {}
	return withLeftOutLine(result, call.leftOut.size, LEFT_OUT);
}

async function grepWorkspace(call: FenceCall, guarded: PersistentRoomWorkspaceToolGuardResult, input: WorkspaceGrepInput, signal: AbortSignal | undefined): Promise<TextToolResult> {
	const request = grepRequest(guarded, input, signal);
	// Beyond the room's folders the walk reads each file itself, so it leaves out one that is a closed file under another name.
	const rgPath = guarded.root.beyond ? null : await resolveRipgrepBinary(request.deadline);
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

async function executeWorkspaceRead(policy: PersistentRoomCapabilityPolicy, input: WorkspaceReadInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, reach: Reach = {}): Promise<TextToolResult> {
	return inTheBox(box, async (box) => {
		const { fence, files } = callFence(policy, box, answer, reach);
		const guarded = guard(fence, input.path, "read", files);
		if (!guarded.stat.isFile()) {
			throw new RoomFilesError("not_file", "Path is not a file.");
		}
		if (fence.kind === "files") {
			// What the parsers read is what the open read, and that open follows no link.
			const { bytes } = await openNoFollow(guarded);
			return withPrivateCopy(path.basename(guarded.real), bytes, (copy) => readFile({ real: copy, shown: guarded.shown, size: bytes.length }, input));
		}
		const inBox = filesFor(guarded, files);
		if (!inBox && guarded.root.beyond) {
			const opened = await readOpened(guarded);
			return withPrivateCopy(path.basename(guarded.real), opened, (copy) => readFile({ real: copy, shown: guarded.shown, size: opened.length }, input));
		}
		if (!inBox) return readFile({ real: guarded.real, shown: guarded.shown, size: guarded.stat.size }, input);
		const bytes = await inBox.read(guarded, input.path, signal);
		return withPrivateCopy(path.basename(guarded.real), bytes, (copy) => readFile({ real: copy, shown: guarded.shown, size: bytes.length }, input));
	});
}

/**
 * Runs the parsers on a copy of bytes already read, by the box or, beyond a
 * room's folders, by the server itself, in a folder of the server's own temp,
 * made fresh for this call and removed after; a boxed command can't reach it.
 * The copy keeps the file's name, so its kind reads the same.
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
// `roomFile`: the name of the room's own file the call changed, so the page shows the new bytes in its Attachments.
function written(shown: string, bytes: number, existed: boolean, roomFile?: string): TextToolResult {
	return toolResult(existed ? `file overwritten at ${shown} (${bytes} bytes)` : `file generated to ${shown} (${bytes} bytes)`, {
		ok: true,
		path: shown,
		bytes,
		created: !existed,
		overwritten: existed,
		...(roomFile ? { roomFile } : {}),
	});
}

// The box's program keeps the same margin before it replaces a file (room-box/file-worker.mjs).
const SPACE_MARGIN_BYTES = 16 * 1024 * 1024;
// Windows has neither: there a link at the last part is refused by the fence's walk, and the open doesn't wait.
const NO_LINK_AT_END = fs.constants.O_NOFOLLOW ?? 0;
const NO_WAIT = fs.constants.O_NONBLOCK ?? 0;

function diskFreeBytes(folder: string): number {
	const disk = fs.statfsSync(folder);
	return disk.bavail * disk.bsize;
}

/**
 * Whether a file is the sign-in file or a connector settings file under another
 * name, by its device and inode: the server never opens them for a room. A
 * closed file that can't be looked up is one the server can't open either.
 */
function sameAsClosedFile(stat: fs.BigIntStats): boolean {
	return [path.join(getAgentDir(), "auth.json"), path.join(getAgentDir(), "mcp.json"), path.join(os.homedir(), ".config", "mcp", "mcp.json")].some((place) => {
		try {
			const closed = fs.statSync(place, { bigint: true, throwIfNoEntry: false });
			return closed !== undefined && closed.dev === stat.dev && closed.ino === stat.ino;
		} catch {
			return false;
		}
	});
}

/** A file the server opens itself: no link at the last part, a regular file, and judged on what it opened. */
async function openedFile(target: { real: string; shown: string }, flags: number, failed: RoomFilesError): Promise<fs.promises.FileHandle> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(target.real, flags | NO_LINK_AT_END | NO_WAIT);
	} catch {
		throw failed;
	}
	try {
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile()) throw new RoomFilesError("not_file", `${target.shown} is not a file.`);
		if (sameAsClosedFile(stat)) throw new RoomFilesError("blocked_by_policy", closedRefusal(target.shown));
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function readOpened(target: { real: string; shown: string }): Promise<Buffer> {
	const handle = await openedFile(target, fs.constants.O_RDONLY, new RoomFilesError("not_readable", `${target.shown} can't be read.`));
	try {
		// The largest file a call takes, as in the box.
		if ((await handle.stat()).size > READ_LIMIT_BYTES) throw new RoomFilesError("file_too_large", tooLargeForTool(target.shown));
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

/**
 * The server's own write behind the fence, as the box's program writes: a new
 * file by an open that refuses one already there; one already there replaced
 * in place, and only when the new bytes fit on its disk, so a full disk leaves
 * it as it was. Says whether a file was there.
 */
async function writeHere(target: { real: string; shown: string }, content: string, overwrite: boolean, freeSpace: (folder: string) => number = diskFreeBytes): Promise<boolean> {
	const bytes = Buffer.from(content, "utf-8");
	try {
		const created = await fs.promises.open(target.real, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_LINK_AT_END, 0o644);
		try {
			await created.writeFile(bytes);
		} finally {
			await created.close();
		}
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !overwrite) throw error;
	}
	const handle = await openedFile(target, fs.constants.O_WRONLY, new RoomFilesError("not_writable", `${target.shown} can't be written.`));
	try {
		if (freeSpace(path.dirname(target.real)) < bytes.length + SPACE_MARGIN_BYTES) throw new RoomFilesError("no_space", notEnoughSpace(target.shown));
		await handle.truncate(0);
		await handle.writeFile(bytes);
	} finally {
		await handle.close();
	}
	return true;
}

async function executeWorkspaceWrite(policy: PersistentRoomCapabilityPolicy, input: WorkspaceWriteInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, reach: Reach = {}): Promise<TextToolResult> {
	stopIfAborted(signal);
	if (typeof input.content !== "string") {
		throw new RoomFilesError("invalid_content", "Content is required.");
	}
	const rawPath = String(input.path ?? "").trim();
	if (/[\\/]$/.test(rawPath)) throw new RoomFilesError("not_file", `${rawPath} is not a file.`);
	return inTheBox(box, (box) => writeFile(policy, input, rawPath, box, signal, answer, reach));
}

async function writeFile(policy: PersistentRoomCapabilityPolicy, input: WorkspaceWriteInput & { content: string }, rawPath: string, box: RoomBox | undefined, signal: AbortSignal | undefined, answer: AnswerFolders | undefined, reach: Reach): Promise<TextToolResult> {
	const { fence, files: boxFiles } = callFence(policy, box, answer, reach);
	const target = fencePath(fence, rawPath, "write", { decksInBox: boxFiles !== null });
	const files = filesFor(target, boxFiles);
	if (target.root.room && target.shown === ".") throw new RoomFilesError("not_file", `${rawPath} is not a file.`);
	if (fence.kind === "files") return writeInFiles(target, input, signal);
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
			return written(checked.shown, bytes, await writeHere(checked, input.content, input.overwrite === true, reach.freeSpace));
		} catch (error) {
			if (error instanceof RoomFilesError) throw error;
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new RoomFilesError("file_exists", `File already exists in selected workspace. Set overwrite=true to replace ${checked.shown}.`);
			}
			throw new RoomFilesError("not_writable", `${checked.shown} can't be written.`);
		}
	});
}

async function executeWorkspaceEdit(policy: PersistentRoomCapabilityPolicy, input: WorkspaceEditInput, box?: RoomBox, signal?: AbortSignal, answer?: AnswerFolders, reach: Reach = {}): Promise<TextToolResult> {
	stopIfAborted(signal);
	return inTheBox(box, async (box) => {
		const { fence, files } = callFence(policy, box, answer, reach);
		const guarded = guard(fence, input.path, "write", files);
		if (!guarded.stat.isFile()) {
			throw new RoomFilesError("not_file", `${guarded.shown} is not a file.`);
		}
		if (!Array.isArray(input.edits) || input.edits.length === 0) {
			throw new RoomFilesError("invalid_edits", "edits must contain at least one replacement.");
		}
		const edits = input.edits.map((edit) => ({ oldText: String(edit?.oldText ?? ""), newText: String(edit?.newText ?? "") }));
		// Read, change and write back as one step per file, so an edit at the same time works from this one's result.
		if (fence.kind === "files") return editInFiles(guarded, edits, signal);
		return withFileMutationQueue(guarded.real, () => editFile(guarded, input.path, edits, filesFor(guarded, files), signal, reach.freeSpace));
	});
}

async function editFile(guarded: PersistentRoomWorkspaceToolGuardResult, raw: string, edits: Array<{ oldText: string; newText: string }>, files: Files, signal: AbortSignal | undefined, freeSpace: Reach["freeSpace"]): Promise<TextToolResult> {
	const buffer = files ? await files.read(guarded, raw, signal) : await readOpened(guarded);
	const nextContent = editedContent(buffer, edits, guarded.shown);
	const bytes = Buffer.byteLength(nextContent, "utf-8");
	stopIfAborted(signal);
	if (files) {
		await files.write(guarded, raw, nextContent, true, signal);
	} else {
		try {
			await writeHere(guarded, nextContent, true, freeSpace);
		} catch (error) {
			if (error instanceof RoomFilesError) throw error;
			throw new RoomFilesError("not_writable", `${guarded.shown} can't be written.`);
		}
	}
	return editedResult(guarded.shown, edits.length, bytes);
}

/** A file's text with the edits made, its BOM and line endings kept. */
function editedContent(buffer: Buffer, edits: Array<{ oldText: string; newText: string }>, shown: string): string {
	const content = buffer.toString("utf-8");
	if (!Buffer.from(content, "utf-8").equals(buffer)) {
		throw new RoomFilesError("not_utf8", "File is not valid UTF-8 text and cannot be edited with this tool.");
	}
	const { bom, text } = stripBom(content);
	const lineEnding = detectLineEnding(text);
	const normalized = normalizeToLF(text);
	let newContent: string;
	try {
		newContent = applyEditsToNormalizedContent(normalized, edits, shown).newContent;
	} catch (error) {
		throw new RoomFilesError("edit_failed", error instanceof Error ? error.message : String(error));
	}
	return bom + restoreLineEndings(newContent, lineEnding);
}

function editedResult(shown: string, editCount: number, bytes: number, roomFile?: string): TextToolResult {
	return toolResult(`file edited at ${shown} (${editCount} ${editCount === 1 ? "edit" : "edits"}, ${bytes} bytes)`, {
		ok: true,
		path: shown,
		edits: editCount,
		bytes,
		...(roomFile ? { roomFile } : {}),
	});
}

// ── The room's own files on a shared server (room-files.ts, roomFilesFence) ──
// No box and no command there, so the server's own reads and writes are the
// only ones: each read opens with no link followed, each change lands by a
// rename, and each search's patterns run where a runaway one is cut.

/** The most the room's files hold, and the disk the server keeps free. */
const FILES_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const FILES_MAX_COUNT = 10_000;
const FILES_DISK_FLOOR_BYTES = 1024 * 1024 * 1024;
const FILES_FULL = "This room's files are full (2 GB or 10,000 files). Ask the person to delete files they no longer need.";
const FILES_DISK_SHORT = "The server is short of disk space, so this room can't save files now. Tell the person.";
const filesTooLarge = (shown: string): string => `${shown} would be over ${SHELF_READ_MAX_FILE_BYTES / (1024 * 1024)} MB, the most a file in this room's files can be.`;

/** A file's bytes through an open that follows no link, with what the open saw. */
async function openNoFollow(target: Pick<FencedPath, "real" | "shown">): Promise<{ bytes: Buffer; seen: fs.Stats }> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(target.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP") throw new RoomFilesError("link", linkRefused(target.shown));
		if (code === "ENOENT") throw new RoomFilesError("file_not_found", `Path not found: ${target.shown}`);
		throw new RoomFilesError("not_readable", `${target.shown} can't be read.`);
	}
	try {
		const seen = await handle.stat();
		if (!seen.isFile()) throw new RoomFilesError("not_file", `${target.shown} is not a file.`);
		if (seen.size > SHELF_READ_MAX_FILE_BYTES) throw new RoomFilesError("file_too_large", `${target.shown} is over ${SHELF_READ_MAX_FILE_BYTES / (1024 * 1024)} MB, so it can't be read here.`);
		return { bytes: await handle.readFile(), seen };
	} finally {
		await handle.close();
	}
}

/** Refuses a change that would leave a file over 25 MB, the room's files over 2 GB or 10,000 files, or the disk under its floor. */
async function filesHaveRoom(target: FencedPath, bytes: number): Promise<void> {
	if (bytes > SHELF_READ_MAX_FILE_BYTES) throw new RoomFilesError("file_too_large", filesTooLarge(target.shown));
	let used = 0;
	let count = 0;
	let replaced: fs.Stats | null = null;
	for (const name of await fs.promises.readdir(target.root.path)) {
		const place = path.join(target.root.path, name);
		const entry = await fs.promises.lstat(place).catch(() => null);
		if (!entry) continue;
		count += 1;
		if (entry.isFile()) used += entry.size;
		if (place === target.real) replaced = entry;
	}
	if (used - (replaced?.size ?? 0) + bytes > FILES_MAX_BYTES || count + (replaced ? 0 : 1) > FILES_MAX_COUNT) throw new RoomFilesError("files_full", FILES_FULL);
	const disk = await fs.promises.statfs(target.root.path);
	if (disk.bavail * disk.bsize - bytes < FILES_DISK_FLOOR_BYTES) throw new RoomFilesError("disk_full", FILES_DISK_SHORT);
}

const filesExists = (shown: string): string => `${shown} already exists in this room's files. To replace it, write it again with overwrite set to true.`;

async function writeInFiles(target: FencedPath, input: WorkspaceWriteInput & { content: string }, signal: AbortSignal | undefined): Promise<TextToolResult> {
	if (target.exists && input.overwrite !== true) throw new RoomFilesError("file_exists", filesExists(target.shown));
	const bytes = Buffer.byteLength(input.content, "utf-8");
	// One change at a time in a room: the room-wide limits are checked and kept by the same change, never by two at once.
	return withFileMutationQueue(target.root.path, async () => {
		stopIfAborted(signal);
		await filesHaveRoom(target, bytes);
		stopIfAborted(signal);
		const existed = fs.existsSync(target.real);
		try {
			// A temporary dot file, then a rename: a link put at the name is replaced, never written through. Without overwrite it lands only on a free name.
			writeFileAtomic(target.real, input.content, { hiddenTemp: true, ...(input.overwrite === true ? {} : { exclusive: true }) });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RoomFilesError("file_exists", filesExists(target.shown));
			throw new RoomFilesError("not_writable", `${target.shown} can't be written.`);
		}
		return written(target.shown, bytes, existed, target.shown);
	});
}

/** The same file, by what an open saw: a delete, an upload under its name or a change since then reads as another. */
function sameFile(now: fs.Stats, seen: fs.Stats): boolean {
	return now.isFile() && now.dev === seen.dev && now.ino === seen.ino && now.size === seen.size && now.mtimeMs === seen.mtimeMs && now.ctimeMs === seen.ctimeMs;
}

/**
 * An edit is a change to the file it read: it takes the room's queue, but a
 * person's delete or upload under the same name doesn't wait in it, so the
 * rename lands only on the file the edit read, checked with nothing awaited
 * between.
 */
async function editInFiles(guarded: PersistentRoomWorkspaceToolGuardResult, edits: Array<{ oldText: string; newText: string }>, signal: AbortSignal | undefined): Promise<TextToolResult> {
	return withFileMutationQueue(guarded.root.path, async () => {
		const { bytes: buffer, seen } = await openNoFollow(guarded);
		const nextContent = editedContent(buffer, edits, guarded.shown);
		const bytes = Buffer.byteLength(nextContent, "utf-8");
		await filesHaveRoom(guarded, bytes);
		stopIfAborted(signal);
		// A short name of its own, so a long file name still has room under the disk's limit, with this server start's
		// mark: an upload's clean-up of temporary files leaves this one, which is in flight.
		const temporary = path.join(path.dirname(guarded.real), `.edit${IN_FLIGHT_TEMPORARY_MARK}${randomBytes(6).toString("hex")}`);
		try {
			await fs.promises.writeFile(temporary, nextContent, { encoding: "utf-8", flag: "wx", mode: 0o600, flush: true });
			// A Stop while the temporary file was written ends the edit here; from here to the rename nothing waits.
			stopIfAborted(signal);
			const now = fs.lstatSync(guarded.real, { throwIfNoEntry: false });
			if (!now || !sameFile(now, seen)) throw new RoomFilesError("file_changed", `${guarded.shown} changed while it was being edited. Read it again, then edit.`);
			fs.renameSync(temporary, guarded.real);
		} catch (error) {
			fs.rmSync(temporary, { force: true });
			if (error instanceof RoomFilesError) throw error;
			throw new RoomFilesError("not_writable", `${guarded.shown} can't be written.`);
		}
		return editedResult(guarded.shown, edits.length, bytes, guarded.shown);
	});
}

/** The entries right in the room's files a search looks at: open, and no link. */
async function filesEntries(call: FenceCall, root: FenceRoot): Promise<Array<{ name: string; real: string; stat: fs.Stats }>> {
	const entries: Array<{ name: string; real: string; stat: fs.Stats }> = [];
	for (const name of (await fs.promises.readdir(root.path)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
		const real = path.join(root.path, name);
		if (entryClosed(call, root, real)) continue;
		const stat = await fs.promises.lstat(real).catch(() => null);
		if (stat && !stat.isSymbolicLink()) entries.push({ name, real, stat });
	}
	return entries;
}

const GREP_TIME_LINE = `Search stopped after ${GREP_TIME_BUDGET_MS / 1000}s. Refine pattern or path and try again.`;

/** A pattern the model gave, compiled where a runaway one is cut. */
function boundedPattern(source: string, flags: string, invalid: string): BoundedPattern {
	try {
		return new BoundedPattern(source, flags);
	} catch (error) {
		if (error instanceof SearchTooSlow) throw new RoomFilesError("invalid_pattern", error.message);
		throw new RoomFilesError("invalid_pattern", invalid);
	}
}

/** The indexes of the names a glob matches, in order, or the line the search stopped with. */
async function namesMatching(glob: BoundedPattern, names: readonly string[], deadline: number, signal: AbortSignal | undefined): Promise<{ indexes: number[]; stoppedWith?: string }> {
	// No names would be one empty line to the matcher, which a glob like * matches.
	if (names.length === 0) return { indexes: [] };
	try {
		const { hits, ended } = await glob.matchLines(names.join("\n"), { maxHits: names.length, probeChars: Number.MAX_SAFE_INTEGER, deadline, stopped: () => signal?.aborted === true });
		stopSearchIfAborted(signal);
		return { indexes: hits, ...(ended === "deadline" ? { stoppedWith: GREP_TIME_LINE } : {}) };
	} catch (error) {
		if (error instanceof SearchTooSlow) return { indexes: [], stoppedWith: error.message };
		throw error;
	}
}

/** find in the room's files: the names right there, matched by the glob, within the search's time. */
async function findInFiles(call: FenceCall, input: WorkspaceFindInput, roomId: string, signal: AbortSignal | undefined): Promise<TextToolResult> {
	const deadline = Date.now() + GREP_TIME_BUDGET_MS;
	const guarded = guard(call.fence, input.path ?? ".", "find");
	if (!guarded.stat.isDirectory()) throw new RoomFilesError("not_directory", `${guarded.shown} is not a folder.`);
	const pattern = normalizeSlashes(String(input.pattern ?? "").trim());
	if (!pattern) throw new RoomFilesError("missing_pattern", "Find pattern is required.");
	const glob = boundedPattern(globToRegExp(pattern).source, "", "Find pattern is not a valid glob.");
	const limit = normalizeLimit(input.limit, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
	return oneSearchAtATime(roomId, async () => {
		const entries = (await filesEntries(call, guarded.root)).filter((entry) => entry.stat.isFile() || entry.stat.isDirectory());
		const shown = entries.map((entry) => (entry.stat.isDirectory() ? `${entry.name}/` : entry.name));
		const matched = await namesMatching(glob, entries.map((entry) => entry.name), deadline, signal);
		const results = matched.indexes.map((index) => shown[index]);
		const notices: string[] = [];
		const details: Record<string, unknown> = {};
		if (results.length > limit) {
			results.length = limit;
			details.resultLimitReached = limit;
			notices.push(`${limit} results limit reached. Refine pattern or path for more.`);
		}
		if (matched.stoppedWith) notices.push(matched.stoppedWith);
		const text = results.length === 0 ? "No files found matching pattern" : results.join("\n");
		return toolResult(notices.length > 0 ? `${text}\n\n[${notices.join(" ")}]` : text, details);
	});
}

/** grep in the room's files: the files right there, or the one named, each searched within the search's time. */
async function grepInFiles(call: FenceCall, guarded: PersistentRoomWorkspaceToolGuardResult, input: WorkspaceGrepInput, signal: AbortSignal | undefined, roomId: string): Promise<TextToolResult> {
	const request = grepRequest(guarded, input, signal);
	const source = request.literal ? request.patternSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : request.patternSource;
	const pattern = boundedPattern(source, request.ignoreCase ? "i" : "", "Grep pattern is not a valid JavaScript regular expression.");
	const glob = request.globText ? boundedPattern(globToRegExp(request.globText).source, "", "Glob is not a valid glob.") : null;
	return oneSearchAtATime(roomId, async () => {
		const notices: string[] = [];
		const details: Record<string, unknown> = {};
		const matches: GrepMatch[] = [];
		let candidates = guarded.stat.isFile() ? [{ name: guarded.shown, real: guarded.real, stat: guarded.stat }] : (await filesEntries(call, guarded.root)).filter((entry) => entry.stat.isFile());
		let stoppedWith: string | undefined;
		if (glob) {
			const matched = await namesMatching(glob, candidates.map((entry) => entry.name), request.deadline, signal);
			const kept = new Set(matched.indexes);
			candidates = candidates.filter((_, index) => kept.has(index));
			stoppedWith = matched.stoppedWith;
		}
		let skippedLargeFiles = 0;
		let longLinesClipped = false;
		for (const entry of stoppedWith ? [] : candidates) {
			if (entry.stat.size > MAX_GREP_FILE_BYTES) {
				skippedLargeFiles += 1;
				continue;
			}
			let content: string;
			try {
				content = (await openNoFollow({ real: entry.real, shown: entry.name })).bytes.toString("utf-8");
			} catch {
				continue;
			}
			let found;
			try {
				found = await pattern.matchLines(content, { maxHits: request.limit - matches.length, probeChars: MAX_GREP_SCAN_LINE_CHARS, deadline: request.deadline, stopped: () => signal?.aborted === true });
			} catch (error) {
				if (!(error instanceof SearchTooSlow)) throw error;
				stoppedWith = error.message;
				break;
			}
			stopSearchIfAborted(signal);
			// Lines as the matcher saw them: a Windows line's \r is not part of it, as in the desktop's walk.
			const lines = content.split("\n").map((line) => line.replace(/\r$/, ""));
			longLinesClipped ||= lines.some((line) => line.length > MAX_GREP_SCAN_LINE_CHARS);
			for (const index of found.hits) {
				const shown = clippedLine(lines[index] ?? "");
				if (shown.clipped) details.linesTruncated = true;
				matches.push({ real: entry.real, shown: entry.name, line: index + 1, text: shown.text });
			}
			if (found.ended === "limit") {
				details.matchLimitReached = request.limit;
				notices.push(`${request.limit} matches limit reached. Use limit=${Math.min(request.limit * 2, MAX_GREP_LIMIT)} for more, or refine pattern.`);
				break;
			}
			if (found.ended === "deadline") {
				details.timeBudgetReached = GREP_TIME_BUDGET_MS;
				stoppedWith = GREP_TIME_LINE;
				break;
			}
		}
		if (skippedLargeFiles > 0) {
			details.skippedLargeFiles = skippedLargeFiles;
			notices.push(`${skippedLargeFiles} file(s) larger than ${MAX_GREP_FILE_BYTES / (1024 * 1024)} MiB were skipped.`);
		}
		if (details.linesTruncated) notices.push(`Some lines truncated to ${MAX_GREP_LINE_CHARS} chars. Use read to see full lines.`);
		if (longLinesClipped) {
			details.longLinesClipped = true;
			notices.push(`Lines longer than ${MAX_GREP_SCAN_LINE_CHARS} chars were matched on their first ${MAX_GREP_SCAN_LINE_CHARS} chars only.`);
		}
		if (stoppedWith) notices.push(stoppedWith);
		return buildGrepResult("walk", { matches, details, notices }, request.context);
	});
}

/**
 * The folders a call's fence may open: the room's folder as it was chosen, its
 * list and the running answer's own, by the names stored for them, read before
 * anything on disk is, so nothing is resolved through a folder a command holds;
 * and the folders of its skills that are on, as `roomSkillFolders` judged them:
 * a shared-folder skill's may lie in another room's folder, where that room's
 * commands write.
 */
function namedFolders(policy: PersistentRoomCapabilityPolicy, answer: AnswerFolders | undefined): string[] {
	const room = policy.roots[0];
	const listed = readAlsoAllowed(policy.agentId).folders;
	return [...(room ? [room.realpath, room.path] : []), ...(answer?.over(listed) ?? listed).map((entry) => entry.path), ...roomSkillFolders(policy.agentId).map((skill) => skill.skillDir)];
}

/**
 * What a session passes. `box` is the turn's box on a person's Mac: each call
 * then reads and writes inside it. The live bind still passes `localFilesCwd`
 * and `terminalOn`; the fence reads the room's folder, its list and the folders
 * of its skills that are on itself, so neither is used.
 */
export interface PersistentRoomWorkspaceToolsOptions {
	box?: RoomBox;
	localFilesCwd?: string;
	terminalOn?: () => boolean;
	/** The running answer's own folders, read at each call. Only a live answer at the computer has any. */
	answer?: () => AnswerFolders;
	/** Whether the room's folder ask is offered with someone there to answer it, read at each refused write. */
	asks?: () => boolean;
	/** For a Windows room whose commands run in the box: each call waits for every boxed command on its folders, and holds them while it runs. */
	folderWait?: FolderWait;
	/** Whether the room asks nothing now (Auto with protection off), read at each call: its paths beyond its folders open too. */
	asksNothing?: () => boolean;
	/** The free bytes on a folder's disk, read before a file is replaced; the disk's own count unless a smoke sets it. */
	freeSpace?: (folder: string) => number;
	/** Where the file tools run without the box (Windows): the box's running answer's temp for its commands, read at each call. A Mac's comes from `box`. */
	commandsTemp?: () => string | undefined;
}

/** A write refused for a folder the room can only read says what the model does next. */
function sayingWhatNext<T>(change: () => Promise<T>, next: () => ReadOnlyNext): Promise<T> {
	return change().catch((error: unknown) => {
		if (error instanceof RoomFilesError && error.code === "read_only_folder") throw new RoomFilesError(error.code, `${error.message} ${readOnlyNextLine(next())}`);
		throw error;
	});
}

const FENCE_LINE = "Paths may be relative to this room's folder, absolute, or start with ~; only this room's folder and the folders allowed for it open, links are not followed, and secret files and the app's own data stay closed.";
const FILES_FENCE_LINE = "Paths are names in this room's files, its Attachments, such as notes-plan.md: no folders, absolute paths or ~. Links are not followed, and names that start with a dot stay closed. What you write or edit shows in the room's Attachments.";

/** What each tool tells the model, for a folder the person chose or for the room's own files on a shared server. */
function toolWords(inFiles: boolean) {
	const fence = inFiles ? FILES_FENCE_LINE : FENCE_LINE;
	const walks = inFiles ? "" : " Results include files .gitignore would hide; folders named .git and node_modules are searched only when the path is inside one.";
	return {
		schemas: inFiles ? FILES_SCHEMAS : FOLDER_SCHEMAS,
		// A shared server sends tool descriptions outside the messages, where no @ may stand.
		ls: `List files and folders. ${fence} Closed entries are left out and counted. ${inFiles ? "Links end with an at sign and are not followed." : "Links are marked with @ and not followed."}`,
		find: inFiles
			? `Find files in this room's files by a glob pattern on their names. ${fence}`
			: `Find files and folders by a glob pattern (folders end with /), matched against paths relative to the room's folder, or to the allowed folder searched. ${fence}${walks}`,
		read: `Read a file. ${fence} Supports text files (output is truncated safely; use offset/limit to continue large files), images (jpg, png, gif, webp; sent as attachments), PDF and Word (.docx) documents (extracted as text and paged with offset/limit; scanned PDFs without a text layer are called out honestly), and .xlsx spreadsheets previewed as a markdown table (default 30 rows and 12 columns of the first sheet; use sheet, offset, limit, and columns to control the previewed window).`,
		grep: `Search file contents line by line; matching lines come back as 'path:line: text', and with context the lines around them as 'path-line- text'. ${fence} Use glob to search only some files and literal for a plain string. Output is bounded by match, line-length, file-size, and total-output limits; refine pattern or path for more focused results.${walks}`,
		write: inFiles
			? `Create or explicitly overwrite a file in this room's files; any file type. ${fence} A file can be up to ${SHELF_READ_MAX_FILE_BYTES / (1024 * 1024)} MB, and the room's files hold at most 2 GB and 10,000 files. Existing files are rejected unless overwrite=true. Ask before overwriting unless the user explicitly requested it. After success, tell the user the file's name and that it is in the room's Attachments; do not paste the full written content.`
			: `Create or explicitly overwrite a file; any file type. ${fence} Only folders this room can change take a write, and files other programs run, such as git settings and editor folders, can be read but not changed. Parent folders are created as needed. Existing files are rejected unless overwrite=true. Ask before overwriting unless the user explicitly requested it. After success, tell the user the file's path and do not paste the full written content.`,
		edit: `Edit an existing file by replacing exact text. Each edits[].oldText is matched against the original file, must be unique in it, and must not overlap another edit in the same call; if two changes touch the same block or nearby lines, merge them into one edit. ${fence}${inFiles ? "" : " Only folders this room can change take an edit."} Only UTF-8 text files can be edited.`,
	};
}

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
	const words = toolWords(roomFilesAreTheFolder());
	// A call waits for every boxed command on the folders its fence may open, and holds them to its end.
	// A read of whether the room asks nothing that throws reads as no.
	const free = (): boolean => {
		try {
			return options?.asksNothing?.() === true;
		} catch {
			return false;
		}
	};
	// A room that asks nothing shows no card, and asking again there gives the same refusal.
	const readOnlyNext = (): ReadOnlyNext => (free() ? "tell" : options?.asks?.() === true ? "ask" : "ask-later");
	const waited = async <T>(signal: AbortSignal | undefined, stopped: string, call: (answer: AnswerFolders | undefined, reach: Reach) => Promise<T>): Promise<T> => {
		const answer = options?.answer?.();
		const wait = options?.folderWait;
		const temp = box?.ownTemp() ?? options?.commandsTemp?.();
		if (!wait) return call(answer, { free: free(), freeSpace: options?.freeSpace, temp });
		let folders = namedFolders(policy, answer);
		for (;;) {
			const holding = folders;
			const held: Held = (folder) => holding.some((each) => wait.inside(folder, each));
			const ran = await wait.hold<{ result: T } | { more: string[] }>("file", holding, signal, async () => {
				const now = namedFolders(policy, answer);
				// A folder given while it waited is held too before the fence looks.
				if (!now.every(held)) return { more: now };
				try {
					return { result: await call(answer, { held, free: free(), freeSpace: options?.freeSpace, temp }) };
				} catch (error) {
					// A path beyond the room's folders is held like any other before it opens.
					if (error instanceof BeyondNotHeld) return { more: [...now, error.real] };
					throw error;
				}
			}, () => new RoomFilesError("aborted", stopped));
			if ("result" in ran) return ran.result;
			folders = [...new Set([...holding, ...ran.more])];
		}
	};
	const lsTool: ToolDefinition<typeof workspaceLsSchema, Record<string, unknown> | undefined> = {
		name: "ls",
		label: "ls",
		description: words.ls,
		promptSnippet: "List the files and folders in a folder this room can open",
		parameters: words.schemas.ls,
		execute: async (_toolCallId, params, signal) => waited(signal, TOOL_STOPPED, (answer, reach) => executeWorkspaceLs(policy, params, box, signal, answer, reach)),
	};
	const findTool: ToolDefinition<typeof workspaceFindSchema, Record<string, unknown> | undefined> = {
		name: "find",
		label: "find",
		description: words.find,
		promptSnippet: "Find files by name in the folders this room can open",
		parameters: words.schemas.find,
		execute: async (_toolCallId, params, signal) => waited(signal, SEARCH_STOPPED, (answer, reach) => executeWorkspaceFind(policy, params, box, signal, answer, reach)),
	};
	const readTool: ToolDefinition<typeof workspaceReadSchema, Record<string, unknown> | undefined> = {
		name: "read",
		label: "read",
		description: words.read,
		promptSnippet: "Read files (text, images, pdf/docx extraction, .xlsx previews) in the folders this room can open",
		parameters: words.schemas.read,
		execute: async (_toolCallId, params, signal) => waited(signal, TOOL_STOPPED, (answer, reach) => executeWorkspaceRead(policy, params, box, signal, answer, reach)),
	};
	const grepTool: ToolDefinition<typeof workspaceGrepSchema, Record<string, unknown> | undefined> = {
		name: "grep",
		label: "grep",
		description: words.grep,
		promptSnippet: "Search file contents in the folders this room can open",
		parameters: words.schemas.grep,
		execute: async (_toolCallId, params, signal) => waited(signal, SEARCH_STOPPED, (answer, reach) => executeWorkspaceGrep(policy, params, box, signal, answer, reach)),
	};
	const writeTool: ToolDefinition<typeof workspaceWriteSchema, Record<string, unknown> | undefined> = {
		name: "write",
		label: "write",
		description: words.write,
		promptSnippet: "Create or explicitly overwrite files in the folders this room can change",
		parameters: words.schemas.write,
		// A read beside it would start before the file is there, so a message with a write runs its calls in the model's order.
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => sayingWhatNext(() => waited(signal, CHANGE_STOPPED, (answer, reach) => executeWorkspaceWrite(policy, params, box, signal, answer, reach)), readOnlyNext),
	};
	const editTool: ToolDefinition<typeof workspaceEditSchema, Record<string, unknown> | undefined> = {
		name: "edit",
		label: "edit",
		description: words.edit,
		promptSnippet: "Edit files by exact text replacement in the folders this room can change",
		parameters: words.schemas.edit,
		// As the write: a read beside it would see the file before the edit.
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => sayingWhatNext(() => waited(signal, CHANGE_STOPPED, (answer, reach) => executeWorkspaceEdit(policy, params, box, signal, answer, reach)), readOnlyNext),
	};
	return [lsTool, findTool, grepTool, readTool, writeTool, editTool].filter((tool) => selectedToolNames.has(String(tool.name)));
}
