import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	PERSISTENT_ROOM_MARKDOWN_WRITE_TOOL_NAME,
	type PersistentRoomWorkspaceToolSelection,
	normalizePersistentRoomWorkspaceToolSelectionInput,
	normalizeStoredPersistentRoomWorkspaceToolSelection,
	persistentRoomWorkspaceToolNamesForPolicy,
	persistentRoomWorkspaceToolNamesForSelection,
	persistentRoomWorkspaceToolSelectionViewForPolicy,
} from "./persistent-room-tool-policy.js";
import { productAppStatePath, productAppStateRoot } from "../../../pi-package/product-state-paths.js";

export type PersistentRoomWorkspaceMode = "read" | "write";
export type PersistentRoomWorkspaceAccessMode = "bounded" | "localFiles";
export type PersistentRoomWorkspaceRootSource = "manual" | "query-param" | "runtime-state" | "admin-dev";
export type PersistentRoomForbiddenRootKind = "repo-root" | "persistent-agents-root" | "persistent-agent-root" | "exxeta-state-root";

export interface PersistentRoomPathHash {
	algorithm: "sha256";
	value: string;
}

export interface PersistentRoomWorkspaceRootGrant {
	id: string;
	displayLabel: string;
	path: string;
	realpath: string;
	basename: string;
	pathHash: PersistentRoomPathHash;
	source: PersistentRoomWorkspaceRootSource;
	grantedAt: string;
}

export interface PersistentRoomDeniedRootView {
	kind: PersistentRoomForbiddenRootKind;
	basename: string;
	pathHash: PersistentRoomPathHash;
}

export interface PersistentRoomCapabilityPolicy {
	schemaVersion: 1;
	policyId: string;
	agentId: string;
	conversationId: string;
	workspaceAccessMode: PersistentRoomWorkspaceAccessMode;
	roots: PersistentRoomWorkspaceRootGrant[];
	modes: { read: boolean; write: boolean };
	allowedToolNames: string[];
	toolSelection?: PersistentRoomWorkspaceToolSelection;
	bashEnabled?: boolean;
	deniedRoots: PersistentRoomDeniedRootView[];
	denySegments: string[];
	denyFilenameGlobs: string[];
	createdAt: string;
	updatedAt: string;
}

export interface PersistentRoomCapabilityPolicyView {
	schemaVersion: 1;
	policyId: string;
	agentId: string;
	conversationId: string;
	rootCount: number;
	roots: Array<{
		id: string;
		displayLabel: string;
		basename: string;
		pathHash: PersistentRoomPathHash;
		source: string;
	}>;
	workspaceAccessMode: PersistentRoomWorkspaceAccessMode;
	modes: { read: boolean; write: boolean };
	allowedToolNames: string[];
	toolSelection: { kind: "standard" | "custom"; allowedToolNames: string[] };
	denySegments: string[];
	pathAccess: "workspace-only" | "local-files";
	writeEnabled: boolean;
	markdownWriteEnabled: boolean;
	bashEnabled: boolean;
	nativePiFilesystemToolsEnabled: boolean;
}

export type PersistentRoomWorkspaceRootValidationErrorCode =
	| "missing_root"
	| "root_not_found"
	| "root_not_directory"
	| "forbidden_root"
	| "under_forbidden_root"
	| "ancestor_of_forbidden_root";

export interface PersistentRoomWorkspaceRootValidationErrorDetails {
	code: PersistentRoomWorkspaceRootValidationErrorCode;
	message: string;
	forbiddenRoot?: {
		kind: PersistentRoomForbiddenRootKind;
		basename: string;
		pathHash: PersistentRoomPathHash;
	};
}

export class PersistentRoomWorkspacePolicyError extends Error {
	readonly code: PersistentRoomWorkspaceRootValidationErrorCode;
	readonly forbiddenRoot?: PersistentRoomWorkspaceRootValidationErrorDetails["forbiddenRoot"];

	constructor(details: PersistentRoomWorkspaceRootValidationErrorDetails) {
		super(details.message);
		this.name = "PersistentRoomWorkspacePolicyError";
		this.code = details.code;
		this.forbiddenRoot = details.forbiddenRoot;
	}
}

export interface PersistentRoomWorkspaceForbiddenRootInput {
	kind: PersistentRoomForbiddenRootKind;
	path: string;
}

export interface PersistentRoomWorkspaceValidationContext {
	agentId?: string;
	conversationId: string;
	repoRoot: string;
	persistentAgentsRoot?: string;
	exxetaStateRoot?: string;
	forbiddenRoots?: PersistentRoomWorkspaceForbiddenRootInput[];
	now?: Date;
	source?: PersistentRoomWorkspaceRootSource;
	displayLabel?: string;
}

export interface PersistentRoomWorkspacePolicyStorageOptions {
	persistentAgentsRoot?: string;
}

export interface CreatePersistentRoomCapabilityPolicyInput extends PersistentRoomWorkspaceValidationContext {
	root: string;
	workspaceAccessMode?: PersistentRoomWorkspaceAccessMode;
	mode?: PersistentRoomWorkspaceMode;
	writeEnabled?: boolean;
	toolSelection?: PersistentRoomWorkspaceToolSelection;
	bashEnabled?: boolean;
}

export type CreatePersistentRoomDefaultCapabilityPolicyInput = Omit<CreatePersistentRoomCapabilityPolicyInput, "conversationId">;
export type PersistentRoomCapabilityPolicyResolutionSource = "thread" | "room-default" | "none";
export type PersistentRoomEffectiveWorkspacePolicySource = "thread" | "room-default" | "none";

export interface PersistentRoomCapabilityPolicyResolution {
	policy: PersistentRoomCapabilityPolicy | null;
	source: PersistentRoomCapabilityPolicyResolutionSource;
}

export interface PersistentRoomWorkspaceCapabilitySummary {
	workspaceAccessMode: PersistentRoomWorkspaceAccessMode;
	workspaceLabel: string;
	rootCount: number;
	pathAccess: "workspace-only" | "local-files";
	availableToolNames: string[];
	writeEnabled: boolean;
	bashEnabled: boolean;
	nativePiFilesystemToolsEnabled: boolean;
}

export interface PersistentRoomEffectiveWorkspacePolicy {
	agentId: string;
	conversationId: string;
	source: PersistentRoomEffectiveWorkspacePolicySource;
	policy: PersistentRoomCapabilityPolicy | null;
	policyId: string | null;
	fingerprint: PersistentRoomPathHash;
	workspaceAccessMode: PersistentRoomWorkspaceAccessMode;
	pathAccess: "workspace-only" | "local-files";
	allowedToolNames: string[];
	workspaceToolsEnabled: boolean;
	markdownWriteEnabled: boolean;
	bashEnabled: boolean;
	nativePiFilesystemToolsEnabled: boolean;
	capability?: PersistentRoomWorkspaceCapabilitySummary;
}

export const DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT = process.env.EXXETA_PERSISTENT_AGENTS_ROOT || productAppStatePath("personalized-agents");
export const PERSISTENT_ROOM_WORKSPACE_POLICY_STORAGE_SOURCE = "persistent-agent-runtime-sidecar";
export const PERSISTENT_ROOM_WORKSPACE_DEFAULT_STORAGE_SOURCE = "persistent-agent-runtime-default";
export const PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID = "room_default";
export const PERSISTENT_ROOM_DEFAULT_WORKSPACE_ACCESS_MODE: PersistentRoomWorkspaceAccessMode = "localFiles";
export const PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE: PersistentRoomWorkspaceAccessMode = "bounded";
export const PERSISTENT_ROOM_DEFAULT_DENY_SEGMENTS = [".git", ".exxeta", ".exxperts", "node_modules"] as const;
export const PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS = [".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_ed25519"] as const;

export function defaultExxetaStateRoot(): string {
	return productAppStateRoot();
}

export function persistentAgentRootPath(agentId: string, persistentAgentsRoot = DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT): string {
	return path.join(persistentAgentsRoot, requiredWorkspaceAgentId(agentId));
}

function requiredWorkspaceAgentId(value: string | undefined): string {
	const agentId = String(value ?? "").trim();
	if (!agentId) throw new Error("agentId is required");
	return agentId;
}

export function hashPersistentRoomPath(value: string): PersistentRoomPathHash {
	return {
		algorithm: "sha256",
		value: crypto.createHash("sha256").update(value, "utf-8").digest("hex"),
	};
}

export function expandWorkspaceRootInput(input: string): string {
	// os.homedir() honors HOME on POSIX but reads USERPROFILE on Windows —
	// preferring HOME directly would break under Git Bash, which sets HOME
	// to a POSIX-style path like /c/Users/name.
	if (input === "~") return os.homedir();
	if (input.startsWith(`~${path.sep}`) || input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function canonicalAbsolutePath(input: string): string {
	return path.resolve(expandWorkspaceRootInput(input));
}

function existingRealpath(input: string): string | null {
	try {
		return fs.realpathSync.native(input);
	} catch {
		return null;
	}
}

function sameOrDescendant(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function strictAncestor(candidateAncestor: string, descendant: string): boolean {
	return candidateAncestor !== descendant && sameOrDescendant(descendant, candidateAncestor);
}

function safeBasename(input: string): string {
	return path.basename(input) || input;
}

function safeDisplayLabel(input: { displayLabel?: string; basename: string }): string {
	const fallback = input.basename || "workspace";
	const label = String(input.displayLabel ?? "").trim();
	if (!label) return fallback;
	if (label.includes("/") || label.includes("\\") || label.includes("~")) return fallback;
	return label.slice(0, 80) || fallback;
}

interface NormalizedForbiddenRoot {
	kind: PersistentRoomForbiddenRootKind;
	path: string;
	realpath: string;
	basename: string;
	pathHash: PersistentRoomPathHash;
}

function normalizeForbiddenRoots(inputs: PersistentRoomWorkspaceForbiddenRootInput[]): NormalizedForbiddenRoot[] {
	const roots: NormalizedForbiddenRoot[] = [];
	const seen = new Set<string>();
	for (const input of inputs) {
		const resolved = canonicalAbsolutePath(input.path);
		const realpath = existingRealpath(resolved) ?? resolved;
		const key = `${input.kind}:${realpath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		roots.push({
			kind: input.kind,
			path: resolved,
			realpath,
			basename: safeBasename(realpath),
			pathHash: hashPersistentRoomPath(realpath),
		});
	}
	return roots;
}

function redactedDeniedRoot(root: NormalizedForbiddenRoot): PersistentRoomDeniedRootView {
	return {
		kind: root.kind,
		basename: root.basename,
		pathHash: root.pathHash,
	};
}

export function defaultPersistentRoomForbiddenRoots(input: {
	agentId?: string;
	repoRoot: string;
	persistentAgentsRoot?: string;
	exxetaStateRoot?: string;
}): PersistentRoomWorkspaceForbiddenRootInput[] {
	const agentId = requiredWorkspaceAgentId(input.agentId);
	const persistentAgentsRoot = input.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	const exxetaStateRoot = input.exxetaStateRoot ?? defaultExxetaStateRoot();
	return [
		{ kind: "repo-root", path: input.repoRoot },
		{ kind: "exxeta-state-root", path: exxetaStateRoot },
		{ kind: "persistent-agents-root", path: persistentAgentsRoot },
		{ kind: "persistent-agent-root", path: persistentAgentRootPath(agentId, persistentAgentsRoot) },
	];
}

export function persistentRoomDeniedRootViews(input: PersistentRoomWorkspaceValidationContext): PersistentRoomDeniedRootView[] {
	const forbiddenRoots = input.forbiddenRoots ?? defaultPersistentRoomForbiddenRoots(input);
	return normalizeForbiddenRoots(forbiddenRoots).map(redactedDeniedRoot);
}

function validateRequiredWorkspaceRoot(root: string): string {
	const trimmed = String(root ?? "").trim();
	if (!trimmed) {
		throw new PersistentRoomWorkspacePolicyError({
			code: "missing_root",
			message: "Workspace root is required.",
		});
	}
	return trimmed;
}

function safePolicyFileId(raw: string, label: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error(`invalid persistent-room ${label}`);
	return id;
}

function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson(file: string): any | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function workspacePolicyDir(agentId: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): string {
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "workspace-policies");
}

function workspaceRuntimeDir(agentId: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): string {
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime");
}

export function persistentRoomWorkspacePolicyPath(agentIdRaw: string, conversationIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): string {
	const agentId = safePolicyFileId(agentIdRaw, "agent id");
	const conversationId = safePolicyFileId(conversationIdRaw, "conversation id");
	return path.join(workspacePolicyDir(agentId, options), `${conversationId}.json`);
}

export function persistentRoomWorkspaceDefaultPath(agentIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): string {
	const agentId = safePolicyFileId(agentIdRaw, "agent id");
	return path.join(workspaceRuntimeDir(agentId, options), "workspace-default.json");
}

function normalizePersistentRoomWorkspaceRootGrant(raw: any): PersistentRoomWorkspaceRootGrant | null {
	if (!raw || typeof raw !== "object") return null;
	const id = String(raw.id ?? "").trim();
	const displayLabel = String(raw.displayLabel ?? "").trim();
	const rootPath = String(raw.path ?? "").trim();
	const realpath = String(raw.realpath ?? "").trim();
	const basename = String(raw.basename ?? "").trim();
	const hashValue = String(raw.pathHash?.value ?? "").trim();
	const source = String(raw.source ?? "").trim();
	const grantedAt = String(raw.grantedAt ?? "").trim();
	if (!id || !displayLabel || !rootPath || !realpath || !basename || !/^[a-f0-9]{64}$/.test(hashValue) || !grantedAt) return null;
	if (source !== "manual" && source !== "query-param" && source !== "runtime-state" && source !== "admin-dev") return null;
	return {
		id,
		displayLabel,
		path: rootPath,
		realpath,
		basename,
		pathHash: { algorithm: "sha256", value: hashValue },
		source,
		grantedAt,
	};
}

function normalizePersistentRoomDeniedRootView(raw: any): PersistentRoomDeniedRootView | null {
	if (!raw || typeof raw !== "object") return null;
	const kind = String(raw.kind ?? "").trim();
	const basename = String(raw.basename ?? "").trim();
	const hashValue = String(raw.pathHash?.value ?? "").trim();
	if (kind !== "repo-root" && kind !== "persistent-agents-root" && kind !== "persistent-agent-root" && kind !== "exxeta-state-root") return null;
	if (!basename || !/^[a-f0-9]{64}$/.test(hashValue)) return null;
	return { kind, basename, pathHash: { algorithm: "sha256", value: hashValue } };
}

function normalizeStoredPersistentRoomWorkspaceAccessMode(rawMode: unknown): PersistentRoomWorkspaceAccessMode | null {
	if (rawMode === undefined) return PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE;
	const mode = String(rawMode ?? "").trim();
	if (mode === "bounded" || mode === "localFiles") return mode;
	return null;
}

export function normalizePersistentRoomWorkspaceAccessModeInput(rawMode: unknown, options: { defaultMode?: PersistentRoomWorkspaceAccessMode } = {}): PersistentRoomWorkspaceAccessMode {
	if (rawMode == null || rawMode === "") return options.defaultMode ?? PERSISTENT_ROOM_DEFAULT_WORKSPACE_ACCESS_MODE;
	const mode = String(rawMode).trim();
	if (mode === "bounded" || mode === "localFiles") return mode;
	throw new Error("workspace access mode must be bounded or localFiles");
}

function persistentRoomPathAccessForMode(mode: PersistentRoomWorkspaceAccessMode): "workspace-only" | "local-files" {
	return mode === "localFiles" ? "local-files" : "workspace-only";
}

function persistentRoomNativePiFilesystemToolsEnabledForMode(mode: PersistentRoomWorkspaceAccessMode): boolean {
	return mode === "localFiles";
}

function normalizePersistentRoomBashEnabled(raw: unknown, workspaceAccessMode: PersistentRoomWorkspaceAccessMode): boolean {
	return workspaceAccessMode === "localFiles" && raw === true;
}

function normalizePersistentRoomCapabilityPolicy(raw: any, agentId: string, conversationId: string): PersistentRoomCapabilityPolicy | null {
	if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
	if (raw.agentId !== agentId || raw.conversationId !== conversationId) return null;
	const roots: Array<PersistentRoomWorkspaceRootGrant | null> = Array.isArray(raw.roots) ? raw.roots.map(normalizePersistentRoomWorkspaceRootGrant) : [];
	const deniedRoots: Array<PersistentRoomDeniedRootView | null> = Array.isArray(raw.deniedRoots) ? raw.deniedRoots.map(normalizePersistentRoomDeniedRootView) : [];
	if (roots.some((root) => !root) || deniedRoots.some((root) => !root)) return null;
	const createdAt = String(raw.createdAt ?? "").trim();
	const updatedAt = String(raw.updatedAt ?? "").trim();
	const policyId = String(raw.policyId ?? "").trim();
	const workspaceAccessMode = normalizeStoredPersistentRoomWorkspaceAccessMode(raw.workspaceAccessMode);
	const toolSelection = workspaceAccessMode === null ? null : normalizeStoredPersistentRoomWorkspaceToolSelection(raw.toolSelection, workspaceAccessMode);
	if (!policyId || !createdAt || !updatedAt || workspaceAccessMode === null || toolSelection === null) return null;
	const bashEnabled = normalizePersistentRoomBashEnabled(raw.bashEnabled, workspaceAccessMode);
	return {
		schemaVersion: 1,
		policyId,
		agentId,
		conversationId,
		workspaceAccessMode,
		roots: roots as PersistentRoomWorkspaceRootGrant[],
		modes: { read: raw.modes?.read === true, write: raw.modes?.write === true },
		allowedToolNames: Array.isArray(raw.allowedToolNames) ? raw.allowedToolNames.map(String).filter(Boolean) : [],
		...(toolSelection ? { toolSelection } : {}),
		bashEnabled,
		deniedRoots: deniedRoots as PersistentRoomDeniedRootView[],
		denySegments: Array.isArray(raw.denySegments) ? raw.denySegments.map(String).filter(Boolean) : [],
		denyFilenameGlobs: Array.isArray(raw.denyFilenameGlobs) ? raw.denyFilenameGlobs.map(String).filter(Boolean) : [],
		createdAt,
		updatedAt,
	};
}

export function readPersistentRoomCapabilityPolicy(agentIdRaw: string, conversationIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomCapabilityPolicy | null {
	const agentId = safePolicyFileId(agentIdRaw, "agent id");
	const conversationId = safePolicyFileId(conversationIdRaw, "conversation id");
	const file = persistentRoomWorkspacePolicyPath(agentId, conversationId, options);
	if (!fs.existsSync(file)) return null;
	return normalizePersistentRoomCapabilityPolicy(readJson(file), agentId, conversationId);
}

export function writePersistentRoomCapabilityPolicy(policy: PersistentRoomCapabilityPolicy, options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomCapabilityPolicy {
	const agentId = safePolicyFileId(policy.agentId, "agent id");
	const conversationId = safePolicyFileId(policy.conversationId, "conversation id");
	const file = persistentRoomWorkspacePolicyPath(agentId, conversationId, options);
	ensurePrivateDir(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600, flag: "w" });
	return policy;
}

export function deletePersistentRoomCapabilityPolicy(agentIdRaw: string, conversationIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): { deleted: boolean } {
	const file = persistentRoomWorkspacePolicyPath(agentIdRaw, conversationIdRaw, options);
	if (!fs.existsSync(file)) return { deleted: false };
	fs.rmSync(file, { force: true });
	return { deleted: true };
}

export function readPersistentRoomDefaultCapabilityPolicy(agentIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomCapabilityPolicy | null {
	const agentId = safePolicyFileId(agentIdRaw, "agent id");
	const file = persistentRoomWorkspaceDefaultPath(agentId, options);
	if (!fs.existsSync(file)) return null;
	return normalizePersistentRoomCapabilityPolicy(readJson(file), agentId, PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID);
}

export function missingPersistentRoomWorkspaceRootWarnings(policy: PersistentRoomCapabilityPolicy | null): string[] {
	if (!policy) return [];
	const warnings: string[] = [];
	for (const root of policy.roots) {
		if (fs.existsSync(root.realpath) || fs.existsSync(root.path)) continue;
		// Label only — full paths stay redacted on every UI surface.
		warnings.push(`The saved workspace folder "${root.displayLabel || root.basename}" was not found on this machine. Choose the folder again to restore workspace tools.`);
	}
	return warnings;
}

export function writePersistentRoomDefaultCapabilityPolicy(policy: PersistentRoomCapabilityPolicy, options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomCapabilityPolicy {
	const agentId = safePolicyFileId(policy.agentId, "agent id");
	if (policy.conversationId !== PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID) throw new Error("room-default workspace policy must use the room-default conversation id");
	const file = persistentRoomWorkspaceDefaultPath(agentId, options);
	ensurePrivateDir(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600, flag: "w" });
	return policy;
}

export function deletePersistentRoomDefaultCapabilityPolicy(agentIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): { deleted: boolean } {
	const file = persistentRoomWorkspaceDefaultPath(agentIdRaw, options);
	if (!fs.existsSync(file)) return { deleted: false };
	fs.rmSync(file, { force: true });
	return { deleted: true };
}

export function resolvePersistentRoomCapabilityPolicy(agentIdRaw: string, conversationIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomCapabilityPolicyResolution {
	const threadPolicy = readPersistentRoomCapabilityPolicy(agentIdRaw, conversationIdRaw, options);
	if (threadPolicy) return { policy: threadPolicy, source: "thread" };
	const defaultPolicy = readPersistentRoomDefaultCapabilityPolicy(agentIdRaw, options);
	if (defaultPolicy) return { policy: defaultPolicy, source: "room-default" };
	return { policy: null, source: "none" };
}

function assertAllowedWorkspaceRoot(input: {
	rootPath: string;
	rootRealpath: string;
	forbiddenRoots: NormalizedForbiddenRoot[];
}): void {
	const workspaceCandidates = [input.rootRealpath, input.rootPath];
	for (const forbiddenRoot of input.forbiddenRoots) {
		const forbiddenCandidates = [forbiddenRoot.realpath, forbiddenRoot.path];
		if (workspaceCandidates.some((candidate) => forbiddenCandidates.includes(candidate))) {
			throw new PersistentRoomWorkspacePolicyError({
				code: "forbidden_root",
				message: `Workspace root is blocked by policy (${forbiddenRoot.kind}). Choose a different folder.`,
				forbiddenRoot: redactedDeniedRoot(forbiddenRoot),
			});
		}
	}
	for (const forbiddenRoot of input.forbiddenRoots) {
		const forbiddenCandidates = [forbiddenRoot.realpath, forbiddenRoot.path];
		if (workspaceCandidates.some((workspace) => forbiddenCandidates.some((forbidden) => sameOrDescendant(workspace, forbidden)))) {
			throw new PersistentRoomWorkspacePolicyError({
				code: "under_forbidden_root",
				message: `Workspace root is inside a blocked policy area (${forbiddenRoot.kind}). Choose a different folder.`,
				forbiddenRoot: redactedDeniedRoot(forbiddenRoot),
			});
		}
	}
	for (const forbiddenRoot of input.forbiddenRoots) {
		const forbiddenCandidates = [forbiddenRoot.realpath, forbiddenRoot.path];
		if (workspaceCandidates.some((workspace) => forbiddenCandidates.some((forbidden) => strictAncestor(workspace, forbidden)))) {
			throw new PersistentRoomWorkspacePolicyError({
				code: "ancestor_of_forbidden_root",
				message: `Workspace root contains a blocked policy area (${forbiddenRoot.kind}). Choose a narrower folder.`,
				forbiddenRoot: redactedDeniedRoot(forbiddenRoot),
			});
		}
	}
}

export function validatePersistentRoomWorkspaceRoot(root: string, context: PersistentRoomWorkspaceValidationContext): PersistentRoomWorkspaceRootGrant {
	const requestedRoot = validateRequiredWorkspaceRoot(root);
	const resolvedPath = canonicalAbsolutePath(requestedRoot);
	const rootRealpath = existingRealpath(resolvedPath);
	if (!rootRealpath) {
		throw new PersistentRoomWorkspacePolicyError({
			code: "root_not_found",
			message: "Workspace root was not found.",
		});
	}
	let stats: fs.Stats;
	try {
		stats = fs.statSync(rootRealpath);
	} catch {
		throw new PersistentRoomWorkspacePolicyError({
			code: "root_not_found",
			message: "Workspace root was not found.",
		});
	}
	if (!stats.isDirectory()) {
		throw new PersistentRoomWorkspacePolicyError({
			code: "root_not_directory",
			message: "Workspace root must be a directory.",
		});
	}
	const forbiddenRoots = normalizeForbiddenRoots(context.forbiddenRoots ?? defaultPersistentRoomForbiddenRoots(context));
	assertAllowedWorkspaceRoot({ rootPath: resolvedPath, rootRealpath, forbiddenRoots });
	const basename = safeBasename(rootRealpath);
	const pathHash = hashPersistentRoomPath(rootRealpath);
	const now = (context.now ?? new Date()).toISOString();
	return {
		id: `root_${pathHash.value.slice(0, 16)}`,
		displayLabel: safeDisplayLabel({ displayLabel: context.displayLabel, basename }),
		path: resolvedPath,
		realpath: rootRealpath,
		basename,
		pathHash,
		source: context.source ?? "manual",
		grantedAt: now,
	};
}

export function createPersistentRoomCapabilityPolicy(input: CreatePersistentRoomCapabilityPolicyInput): PersistentRoomCapabilityPolicy {
	const agentId = requiredWorkspaceAgentId(input.agentId);
	const now = (input.now ?? new Date()).toISOString();
	const rootGrant = validatePersistentRoomWorkspaceRoot(input.root, { ...input, agentId, now: new Date(now) });
	const workspaceAccessMode = normalizePersistentRoomWorkspaceAccessModeInput(input.workspaceAccessMode);
	const mode = input.mode ?? "read";
	const toolSelection = normalizePersistentRoomWorkspaceToolSelectionInput(input.toolSelection, { defaultToStandard: true, workspaceAccessMode });
	const selectedToolNames = persistentRoomWorkspaceToolNamesForSelection(toolSelection, workspaceAccessMode);
	const bashEnabled = normalizePersistentRoomBashEnabled(input.bashEnabled, workspaceAccessMode);
	return {
		schemaVersion: 1,
		policyId: `prcp_${crypto.randomUUID()}`,
		agentId,
		conversationId: input.conversationId,
		workspaceAccessMode,
		roots: [rootGrant],
		modes: {
			read: mode === "read" || mode === "write",
			write: mode === "read" || mode === "write",
		},
		allowedToolNames: selectedToolNames,
		toolSelection,
		bashEnabled,
		deniedRoots: persistentRoomDeniedRootViews({ ...input, agentId }),
		denySegments: [...PERSISTENT_ROOM_DEFAULT_DENY_SEGMENTS],
		denyFilenameGlobs: [...PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS],
		createdAt: now,
		updatedAt: now,
	};
}

export function createPersistentRoomDefaultCapabilityPolicy(input: CreatePersistentRoomDefaultCapabilityPolicyInput): PersistentRoomCapabilityPolicy {
	return createPersistentRoomCapabilityPolicy({
		...input,
		conversationId: PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID,
	});
}

export function updatePersistentRoomCapabilityPolicyToolSelection(policy: PersistentRoomCapabilityPolicy, toolSelectionInput: PersistentRoomWorkspaceToolSelection, now = new Date()): PersistentRoomCapabilityPolicy {
	const workspaceAccessMode = policy.workspaceAccessMode ?? PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE;
	const toolSelection = normalizePersistentRoomWorkspaceToolSelectionInput(toolSelectionInput, { defaultToStandard: true, workspaceAccessMode });
	return {
		...policy,
		allowedToolNames: persistentRoomWorkspaceToolNamesForSelection(toolSelection, workspaceAccessMode),
		toolSelection,
		updatedAt: now.toISOString(),
	};
}

export function updatePersistentRoomCapabilityPolicyWorkspaceSettings(policy: PersistentRoomCapabilityPolicy, input: { workspaceAccessMode?: PersistentRoomWorkspaceAccessMode; toolSelection?: PersistentRoomWorkspaceToolSelection; bashEnabled?: boolean }, now = new Date()): PersistentRoomCapabilityPolicy {
	const previousWorkspaceAccessMode = policy.workspaceAccessMode ?? PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE;
	const workspaceAccessMode = input.workspaceAccessMode ?? previousWorkspaceAccessMode;
	const selectionInput = input.toolSelection ?? (workspaceAccessMode === previousWorkspaceAccessMode ? policy.toolSelection : undefined) ?? { kind: "standard" };
	const toolSelection = normalizePersistentRoomWorkspaceToolSelectionInput(selectionInput, { defaultToStandard: true, workspaceAccessMode });
	const bashInput = Object.prototype.hasOwnProperty.call(input, "bashEnabled") ? input.bashEnabled : policy.bashEnabled;
	const bashEnabled = normalizePersistentRoomBashEnabled(bashInput, workspaceAccessMode);
	return {
		...policy,
		workspaceAccessMode,
		allowedToolNames: persistentRoomWorkspaceToolNamesForSelection(toolSelection, workspaceAccessMode),
		toolSelection,
		bashEnabled,
		updatedAt: now.toISOString(),
	};
}

export function persistentRoomCapabilityPolicyView(policy: PersistentRoomCapabilityPolicy): PersistentRoomCapabilityPolicyView {
	const workspaceAccessMode = policy.workspaceAccessMode ?? PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE;
	const workspaceToolNames = persistentRoomWorkspaceToolNamesForPolicy(policy);
	const markdownWriteEnabled = workspaceToolNames.includes("write_markdown_file");
	const writeEnabled = workspaceAccessMode === "localFiles" ? workspaceToolNames.includes("write") : markdownWriteEnabled;
	const bashEnabled = normalizePersistentRoomBashEnabled(policy.bashEnabled, workspaceAccessMode);
	return {
		schemaVersion: policy.schemaVersion,
		policyId: policy.policyId,
		agentId: policy.agentId,
		conversationId: policy.conversationId,
		workspaceAccessMode,
		rootCount: policy.roots.length,
		roots: policy.roots.map((root) => ({
			id: root.id,
			displayLabel: root.displayLabel,
			basename: root.basename,
			pathHash: root.pathHash,
			source: root.source,
		})),
		modes: { read: policy.modes.read, write: writeEnabled },
		allowedToolNames: workspaceToolNames,
		toolSelection: persistentRoomWorkspaceToolSelectionViewForPolicy(policy),
		denySegments: [...policy.denySegments],
		pathAccess: persistentRoomPathAccessForMode(workspaceAccessMode),
		writeEnabled,
		markdownWriteEnabled,
		bashEnabled,
		nativePiFilesystemToolsEnabled: persistentRoomNativePiFilesystemToolsEnabledForMode(workspaceAccessMode),
	};
}

function workspacePolicyRootCurrentlyUsable(policy: PersistentRoomCapabilityPolicy): boolean {
	const root = policy.roots[0];
	if (!root) return false;
	const rootRealpath = existingRealpath(root.realpath) ?? existingRealpath(root.path);
	if (!rootRealpath) return false;
	try {
		return fs.statSync(rootRealpath).isDirectory();
	} catch {
		return false;
	}
}

function fingerprintEffectiveWorkspacePolicy(input: {
	source: PersistentRoomEffectiveWorkspacePolicySource;
	policy: PersistentRoomCapabilityPolicy | null;
	allowedToolNames: string[];
	workspaceToolsEnabled: boolean;
	bashEnabled: boolean;
}): PersistentRoomPathHash {
	return hashPersistentRoomPath(JSON.stringify({
		source: input.source,
		policyId: input.policy?.policyId ?? null,
		agentId: input.policy?.agentId ?? null,
		conversationId: input.policy?.conversationId ?? null,
		rootHashes: input.policy?.roots.map((root) => root.pathHash.value) ?? [],
		workspaceAccessMode: input.policy?.workspaceAccessMode ?? PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE,
		modes: input.policy?.modes ?? null,
		pathAccess: input.policy ? persistentRoomPathAccessForMode(input.policy.workspaceAccessMode) : persistentRoomPathAccessForMode(PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE),
		allowedToolNames: input.allowedToolNames,
		toolSelection: input.policy ? persistentRoomWorkspaceToolSelectionViewForPolicy(input.policy) : null,
		workspaceToolsEnabled: input.workspaceToolsEnabled,
		bashEnabled: input.bashEnabled,
		nativePiFilesystemToolsEnabled: input.policy ? persistentRoomNativePiFilesystemToolsEnabledForMode(input.policy.workspaceAccessMode) : false,
	}));
}

function effectiveWorkspaceCapability(policy: PersistentRoomCapabilityPolicy, allowedToolNames: string[], bashEnabled: boolean): PersistentRoomWorkspaceCapabilitySummary | undefined {
	if (allowedToolNames.length === 0 && !bashEnabled) return undefined;
	const view = persistentRoomCapabilityPolicyView(policy);
	const firstRoot = view.roots[0];
	return {
		workspaceAccessMode: view.workspaceAccessMode,
		workspaceLabel: firstRoot?.displayLabel || firstRoot?.basename || "workspace",
		rootCount: view.rootCount,
		pathAccess: view.pathAccess,
		availableToolNames: [...allowedToolNames],
		writeEnabled: view.workspaceAccessMode === "localFiles" ? allowedToolNames.includes("write") : allowedToolNames.includes(PERSISTENT_ROOM_MARKDOWN_WRITE_TOOL_NAME),
		bashEnabled,
		nativePiFilesystemToolsEnabled: view.nativePiFilesystemToolsEnabled,
	};
}

function effectiveWorkspacePolicyFromResolution(input: {
	agentId: string;
	conversationId: string;
	source: PersistentRoomEffectiveWorkspacePolicySource;
	policy: PersistentRoomCapabilityPolicy | null;
}): PersistentRoomEffectiveWorkspacePolicy {
	const workspaceAccessMode = input.policy?.workspaceAccessMode ?? PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE;
	const allowedToolNames = input.policy ? persistentRoomWorkspaceToolNamesForPolicy(input.policy) : [];
	const policyBashEnabled = input.policy ? normalizePersistentRoomBashEnabled(input.policy.bashEnabled, workspaceAccessMode) : false;
	const workspaceToolsEnabled = Boolean(input.policy && (allowedToolNames.length > 0 || policyBashEnabled) && input.policy.modes.read === true && workspacePolicyRootCurrentlyUsable(input.policy));
	const effectiveAllowedToolNames = workspaceToolsEnabled ? allowedToolNames : [];
	const effectiveBashEnabled = workspaceToolsEnabled ? policyBashEnabled : false;
	const markdownWriteEnabled = effectiveAllowedToolNames.includes(PERSISTENT_ROOM_MARKDOWN_WRITE_TOOL_NAME);
	const fingerprint = fingerprintEffectiveWorkspacePolicy({
		source: input.source,
		policy: input.policy,
		allowedToolNames: effectiveAllowedToolNames,
		workspaceToolsEnabled,
		bashEnabled: effectiveBashEnabled,
	});
	return {
		agentId: input.agentId,
		conversationId: input.conversationId,
		source: input.policy ? input.source : "none",
		policy: input.policy,
		policyId: input.policy?.policyId ?? null,
		fingerprint,
		workspaceAccessMode,
		pathAccess: persistentRoomPathAccessForMode(workspaceAccessMode),
		allowedToolNames: effectiveAllowedToolNames,
		workspaceToolsEnabled,
		markdownWriteEnabled,
		bashEnabled: effectiveBashEnabled,
		nativePiFilesystemToolsEnabled: persistentRoomNativePiFilesystemToolsEnabledForMode(workspaceAccessMode),
		...(input.policy && workspaceToolsEnabled ? { capability: effectiveWorkspaceCapability(input.policy, effectiveAllowedToolNames, effectiveBashEnabled) } : {}),
	};
}

export function resolvePersistentRoomEffectiveWorkspacePolicy(agentIdRaw: string, conversationIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomEffectiveWorkspacePolicy {
	const agentId = safePolicyFileId(agentIdRaw, "agent id");
	const conversationId = safePolicyFileId(conversationIdRaw, "conversation id");
	const resolution = resolvePersistentRoomCapabilityPolicy(agentId, conversationId, options);
	return effectiveWorkspacePolicyFromResolution({ agentId, conversationId, source: resolution.source, policy: resolution.policy });
}

/** Content identity for workspace policies: everything that decides what the
 * room may touch and with which tools, ignoring per-copy bookkeeping (policyId,
 * conversationId, timestamps). Two policies that agree here grant exactly the
 * same capability. */
export function persistentRoomCapabilityPoliciesShareContent(a: PersistentRoomCapabilityPolicy, b: PersistentRoomCapabilityPolicy): boolean {
	const contentKey = (policy: PersistentRoomCapabilityPolicy): string => JSON.stringify({
		workspaceAccessMode: policy.workspaceAccessMode,
		rootHashes: policy.roots.map((root) => root.pathHash.value),
		modes: { read: policy.modes.read === true, write: policy.modes.write === true },
		allowedToolNames: policy.allowedToolNames,
		toolSelection: persistentRoomWorkspaceToolSelectionViewForPolicy(policy),
		bashEnabled: normalizePersistentRoomBashEnabled(policy.bashEnabled, policy.workspaceAccessMode),
		denySegments: policy.denySegments,
		denyFilenameGlobs: policy.denyFilenameGlobs,
	});
	return contentKey(a) === contentKey(b);
}

/** The one boundary a live workspace-default mutation still respects: a turn
 * actually in flight finishes under the rules it started with. */
export function assertPersistentRoomWorkspaceDefaultMutable(activeThread: { inFlight: boolean; cancelling: boolean } | null | undefined): void {
	if (!activeThread?.inFlight) return;
	const error = new Error(activeThread.cancelling
		? "Workspace default cannot change while the room has a cancelling turn in flight. Wait for it to finish, then try again."
		: "Workspace default cannot change while the room has an active turn in flight. Wait for it to finish, then try again.");
	(error as any).statusCode = 409;
	(error as any).code = "active_turn_in_flight";
	throw error;
}

/** Live-workspace healing for threads born under the old snapshot regime: a
 * thread sidecar that grants exactly what the room default grants is an
 * automatic mirror, not a deliberate per-conversation choice — dropping it
 * lets the thread follow the live default from now on. A sidecar that differs
 * from the default is honored as a deliberate override and kept. */
export function releasePersistentRoomThreadWorkspaceMirror(agentIdRaw: string, conversationIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): { released: boolean } {
	const agentId = safePolicyFileId(agentIdRaw, "agent id");
	const conversationId = safePolicyFileId(conversationIdRaw, "conversation id");
	const threadPolicy = readPersistentRoomCapabilityPolicy(agentId, conversationId, options);
	if (!threadPolicy) return { released: false };
	const defaultPolicy = readPersistentRoomDefaultCapabilityPolicy(agentId, options);
	if (!defaultPolicy || !persistentRoomCapabilityPoliciesShareContent(threadPolicy, defaultPolicy)) return { released: false };
	return { released: deletePersistentRoomCapabilityPolicy(agentId, conversationId, options).deleted };
}

export function persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectivePolicy: PersistentRoomEffectiveWorkspacePolicy | null | undefined, fallbackCwd: string): string {
	const fallback = String(fallbackCwd || "").trim() || process.cwd();
	if (effectivePolicy?.workspaceAccessMode !== "localFiles") return fallback;
	const root = effectivePolicy.policy?.roots[0];
	if (!root) return fallback;
	const rootRealpath = existingRealpath(root.realpath) ?? existingRealpath(root.path);
	if (!rootRealpath) return fallback;
	try {
		return fs.statSync(rootRealpath).isDirectory() ? rootRealpath : fallback;
	} catch {
		return fallback;
	}
}
