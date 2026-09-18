import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PersistentRoomWorkspacePolicyStorageOptions, PersistentRoomCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { resolvePersistentRoomEffectiveWorkspacePolicy } from "./persistent-room-workspace-policy.js";
import {
	PersistentRoomWorkspaceToolError,
	resolvePersistentRoomWorkspaceExistingFile,
} from "./persistent-room-workspace-tools.js";
import { persistentRoomWorkspaceToolNamesForPolicy } from "./persistent-room-tool-policy.js";

export const MAX_WORKSPACE_MARKDOWN_EDITOR_BYTES = 128 * 1024;

export interface WorkspaceMarkdownFileResponse {
	path: string;
	content: string;
	encoding: "utf-8";
	bytes: number;
	revision: string;
	readOnly: boolean;
}

export class PersistentRoomWorkspaceMarkdownError extends Error {
	readonly code: string;
	readonly statusCode: number;
	readonly currentRevision?: string;

	constructor(code: string, statusCode: number, message: string, currentRevision?: string) {
		super(message);
		this.name = "PersistentRoomWorkspaceMarkdownError";
		this.code = code;
		this.statusCode = statusCode;
		this.currentRevision = currentRevision;
	}
}

interface WorkspaceMarkdownPolicyContext {
	policy: PersistentRoomCapabilityPolicy;
}

function revisionFor(bytes: Buffer): string {
	return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function invalidPath(message: string): PersistentRoomWorkspaceMarkdownError {
	return new PersistentRoomWorkspaceMarkdownError("invalid_path", 400, message);
}

function normalizeMarkdownPath(rawPath: unknown): string {
	const raw = String(rawPath ?? "").trim();
	if (!raw) throw invalidPath("Markdown file path is required.");
	if (raw.includes("\0") || raw.startsWith("~")) throw invalidPath("Markdown file path must stay inside the workspace.");
	const normalized = raw.replaceAll("\\", "/");
	if (path.isAbsolute(raw) || normalized.startsWith("/") || /^\/\/[^/]/.test(normalized) || /^[A-Za-z]:\//.test(normalized)) {
		throw invalidPath("Markdown file path must be relative to the workspace.");
	}
	const segments = normalized.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
		throw invalidPath("Markdown file path contains an invalid segment.");
	}
	const relativePath = segments.join("/");
	if (path.extname(relativePath).toLowerCase() !== ".md") {
		throw new PersistentRoomWorkspaceMarkdownError("unsupported_file_type", 400, "Only .md files can be edited.");
	}
	return relativePath;
}

function toMarkdownError(error: unknown): PersistentRoomWorkspaceMarkdownError {
	if (error instanceof PersistentRoomWorkspaceMarkdownError) return error;
	if (error instanceof PersistentRoomWorkspaceToolError) {
		if (error.code === "workspace_unavailable") return new PersistentRoomWorkspaceMarkdownError(error.code, 503, "The workspace folder is not readable. Check OneDrive permissions or make the folder available offline.");
		if (error.code === "file_not_found") return new PersistentRoomWorkspaceMarkdownError("file_not_found", 404, "Markdown file not found in the selected workspace.");
		if (error.code === "blocked_by_policy") return new PersistentRoomWorkspaceMarkdownError(error.code, 403, "Path is blocked by workspace policy.");
		if (error.code === "outside_workspace") return new PersistentRoomWorkspaceMarkdownError(error.code, 403, "Path is outside the selected workspace.");
		if (error.code === "not_file") return new PersistentRoomWorkspaceMarkdownError(error.code, 400, "Path is not a regular Markdown file.");
		return new PersistentRoomWorkspaceMarkdownError(error.code, 400, error.message);
	}
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "EACCES" || code === "EPERM") return new PersistentRoomWorkspaceMarkdownError("workspace_unavailable", 503, "The workspace folder is not readable. Check OneDrive permissions or make the folder available offline.");
	if (code === "ENOENT") return new PersistentRoomWorkspaceMarkdownError("file_not_found", 404, "Markdown file not found in the selected workspace.");
	return new PersistentRoomWorkspaceMarkdownError("workspace_file_error", 500, error instanceof Error ? error.message : String(error));
}

function requirePolicy(agentId: string, conversationId: string, options: PersistentRoomWorkspacePolicyStorageOptions): WorkspaceMarkdownPolicyContext {
	const effective = resolvePersistentRoomEffectiveWorkspacePolicy(agentId, conversationId, options);
	if (!effective.policy) throw new PersistentRoomWorkspaceMarkdownError("workspace_not_found", 404, "No workspace is configured for this room.");
	if (!effective.workspaceToolsEnabled || effective.policy.modes.read !== true) {
		throw new PersistentRoomWorkspaceMarkdownError("workspace_read_forbidden", 403, "Workspace reading is not enabled for this room.");
	}
	return { policy: effective.policy };
}

function markdownWriteEnabled(policy: PersistentRoomCapabilityPolicy): boolean {
	const selectedTools = new Set(persistentRoomWorkspaceToolNamesForPolicy(policy));
	return policy.modes.write === true && (selectedTools.has("write") || selectedTools.has("edit") || policy.allowedToolNames.includes("write_markdown_file"));
}

function requireWritePolicy(policy: PersistentRoomCapabilityPolicy): void {
	if (!markdownWriteEnabled(policy)) {
		throw new PersistentRoomWorkspaceMarkdownError("markdown_write_forbidden", 403, "Markdown writing is not enabled for this room.");
	}
}

function decodeMarkdown(bytes: Buffer): string {
	if (bytes.length > MAX_WORKSPACE_MARKDOWN_EDITOR_BYTES) {
		throw new PersistentRoomWorkspaceMarkdownError("file_too_large", 413, "Markdown file is too large to edit (128 KiB maximum).");
	}
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new PersistentRoomWorkspaceMarkdownError("invalid_encoding", 415, "Markdown file is not valid UTF-8.");
	}
	if (content.includes("\0")) throw new PersistentRoomWorkspaceMarkdownError("binary_content", 415, "Markdown file contains binary data.");
	return content;
}

function readWithPolicy(context: WorkspaceMarkdownPolicyContext, rawPath: unknown): WorkspaceMarkdownFileResponse {
	const relativePath = normalizeMarkdownPath(rawPath);
	try {
		const guarded = resolvePersistentRoomWorkspaceExistingFile(context.policy, relativePath);
		const bytes = fs.readFileSync(guarded.absolutePath);
		const content = decodeMarkdown(bytes);
		return { path: relativePath, content, encoding: "utf-8", bytes: bytes.byteLength, revision: revisionFor(bytes), readOnly: !markdownWriteEnabled(context.policy) };
	} catch (error) {
		throw toMarkdownError(error);
	}
}

export function readWorkspaceMarkdownFile(
	agentId: string,
	conversationId: string,
	rawPath: unknown,
	options: PersistentRoomWorkspacePolicyStorageOptions = {},
): WorkspaceMarkdownFileResponse {
	return readWithPolicy(requirePolicy(agentId, conversationId, options), rawPath);
}

export function readWorkspaceMarkdownFileWithPolicy(
	policy: PersistentRoomCapabilityPolicy,
	rawPath: unknown,
): WorkspaceMarkdownFileResponse {
	if (policy.modes.read !== true || persistentRoomWorkspaceToolNamesForPolicy(policy).length === 0) throw new PersistentRoomWorkspaceMarkdownError("workspace_read_forbidden", 403, "Workspace reading is not enabled for this room.");
	return readWithPolicy({ policy }, rawPath);
}

function encodeMarkdown(content: unknown): Buffer {
	if (typeof content !== "string") throw new PersistentRoomWorkspaceMarkdownError("invalid_body", 400, "Markdown content must be a string.");
	if (content.includes("\0")) throw new PersistentRoomWorkspaceMarkdownError("binary_content", 415, "Markdown content contains binary data.");
	const bytes = Buffer.from(content, "utf8");
	try {
		const roundTripped = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		if (roundTripped !== content) throw new Error("not a stable UTF-8 string");
	} catch {
		throw new PersistentRoomWorkspaceMarkdownError("invalid_encoding", 415, "Markdown content must be valid UTF-8.");
	}
	if (bytes.byteLength > MAX_WORKSPACE_MARKDOWN_EDITOR_BYTES) {
		throw new PersistentRoomWorkspaceMarkdownError("file_too_large", 413, "Markdown file is too large to edit (128 KiB maximum).");
	}
	return bytes;
}

function assertRevision(revision: unknown): string {
	if (typeof revision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(revision)) {
		throw new PersistentRoomWorkspaceMarkdownError("invalid_body", 400, "A valid file revision is required.");
	}
	return revision;
}

function fsyncDirectory(directory: string): void {
	try {
		const fd = fs.openSync(directory, "r");
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	} catch {
		// The rename is still atomic when a platform does not allow directory fsync.
	}
}

function atomicallyReplaceMarkdown(
	policy: PersistentRoomCapabilityPolicy,
	relativePath: string,
	contentBytes: Buffer,
	expectedRevision: string,
): void {
	const initial = resolvePersistentRoomWorkspaceExistingFile(policy, relativePath);
	const currentBytes = fs.readFileSync(initial.absolutePath);
	if (revisionFor(currentBytes) !== expectedRevision) {
		throw new PersistentRoomWorkspaceMarkdownError("revision_conflict", 409, "The Markdown file changed outside the editor.", revisionFor(currentBytes));
	}
	const parent = path.dirname(initial.absolutePath);
	const tempPath = path.join(parent, `.${path.basename(initial.absolutePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
	let tempFd: number | null = null;
	try {
		tempFd = fs.openSync(tempPath, "wx", 0o600);
		fs.writeFileSync(tempFd, contentBytes);
		fs.fsyncSync(tempFd);
		fs.closeSync(tempFd);
		tempFd = null;
		const beforeRename = resolvePersistentRoomWorkspaceExistingFile(policy, relativePath);
		const beforeRenameBytes = fs.readFileSync(beforeRename.absolutePath);
		const beforeRenameRevision = revisionFor(beforeRenameBytes);
		if (beforeRenameRevision !== expectedRevision) {
			throw new PersistentRoomWorkspaceMarkdownError("revision_conflict", 409, "The Markdown file changed outside the editor.", beforeRenameRevision);
		}
		fs.renameSync(tempPath, beforeRename.absolutePath);
		fsyncDirectory(parent);
	} finally {
		if (tempFd !== null) {
			try { fs.closeSync(tempFd); } catch {}
		}
		try { fs.rmSync(tempPath, { force: true }); } catch {}
	}
}

export function writeWorkspaceMarkdownFileWithPolicy(
	policy: PersistentRoomCapabilityPolicy,
	rawPath: unknown,
	content: unknown,
	revision: unknown,
): WorkspaceMarkdownFileResponse {
	requireWritePolicy(policy);
	const relativePath = normalizeMarkdownPath(rawPath);
	const expectedRevision = assertRevision(revision);
	const contentBytes = encodeMarkdown(content);
	try {
		atomicallyReplaceMarkdown(policy, relativePath, contentBytes, expectedRevision);
		return readWithPolicy({ policy }, relativePath);
	} catch (error) {
		throw toMarkdownError(error);
	}
}

export function writeWorkspaceMarkdownFile(
	agentId: string,
	conversationId: string,
	rawPath: unknown,
	content: unknown,
	revision: unknown,
	options: PersistentRoomWorkspacePolicyStorageOptions = {},
): WorkspaceMarkdownFileResponse {
	const context = requirePolicy(agentId, conversationId, options);
	return writeWorkspaceMarkdownFileWithPolicy(context.policy, rawPath, content, revision);
}
