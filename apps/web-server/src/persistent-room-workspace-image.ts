import fs from "node:fs";
import path from "node:path";
import type { PersistentRoomWorkspacePolicyStorageOptions, PersistentRoomCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { resolvePersistentRoomEffectiveWorkspacePolicy } from "./persistent-room-workspace-policy.js";
import { PersistentRoomWorkspaceToolError, resolvePersistentRoomWorkspaceExistingFile } from "./persistent-room-workspace-tools.js";
import { persistentRoomWorkspaceToolNamesForPolicy } from "./persistent-room-tool-policy.js";

export const MAX_WORKSPACE_IMAGE_BYTES = 20 * 1024 * 1024;

const WORKSPACE_IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

export interface WorkspaceImageFileResponse {
	contentType: string;
	bytes: Buffer;
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

function invalidPath(message: string): PersistentRoomWorkspaceMarkdownError {
	return new PersistentRoomWorkspaceMarkdownError("invalid_path", 400, message);
}

function normalizeRelativePath(rawPath: unknown): string {
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
	return segments.join("/");
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
	return new PersistentRoomWorkspaceMarkdownError("workspace_file_error", 500, "Workspace file could not be read.");
}

function requirePolicy(agentId: string, conversationId: string, options: PersistentRoomWorkspacePolicyStorageOptions): WorkspaceMarkdownPolicyContext {
	const effective = resolvePersistentRoomEffectiveWorkspacePolicy(agentId, conversationId, options);
	if (!effective.policy) throw new PersistentRoomWorkspaceMarkdownError("workspace_not_found", 404, "No workspace is configured for this room.");
	if (!effective.workspaceToolsEnabled || !persistentRoomWorkspaceToolNamesForPolicy(effective.policy).includes("read")) {
		throw new PersistentRoomWorkspaceMarkdownError("workspace_read_forbidden", 403, "Workspace reading is not enabled for this room.");
	}
	return { policy: effective.policy };
}

function readImageWithPolicy(context: WorkspaceMarkdownPolicyContext, rawPath: unknown): WorkspaceImageFileResponse {
	const relativePath = normalizeRelativePath(rawPath);
	const contentType = WORKSPACE_IMAGE_TYPES[path.extname(relativePath).toLowerCase()];
	if (!contentType) throw new PersistentRoomWorkspaceMarkdownError("unsupported_file_type", 400, "Only image files can be shown.");
	try {
		const guarded = resolvePersistentRoomWorkspaceExistingFile(context.policy, relativePath);
		if (guarded.stat.size > MAX_WORKSPACE_IMAGE_BYTES) {
			throw new PersistentRoomWorkspaceMarkdownError("file_too_large", 413, "Image is too large to show (20 MiB maximum).");
		}
		return { contentType, bytes: fs.readFileSync(guarded.absolutePath) };
	} catch (error) {
		throw toMarkdownError(error);
	}
}

export function readWorkspaceImageFile(
	agentId: string,
	conversationId: string,
	rawPath: unknown,
	options: PersistentRoomWorkspacePolicyStorageOptions = {},
): WorkspaceImageFileResponse {
	return readImageWithPolicy(requirePolicy(agentId, conversationId, options), rawPath);
}

export function readWorkspaceImageFileWithPolicy(
	policy: PersistentRoomCapabilityPolicy,
	rawPath: unknown,
): WorkspaceImageFileResponse {
	if (policy.modes.read !== true || !persistentRoomWorkspaceToolNamesForPolicy(policy).includes("read")) throw new PersistentRoomWorkspaceMarkdownError("workspace_read_forbidden", 403, "Workspace reading is not enabled for this room.");
	return readImageWithPolicy({ policy }, rawPath);
}

