import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type PersistentRoomWorkspaceToolSelection,
	normalizePersistentRoomWorkspaceToolSelectionInput,
	normalizeStoredPersistentRoomWorkspaceToolSelection,
	PERSISTENT_ROOM_READONLY_WORKSPACE_TOOL_NAMES,
	persistentRoomFoldedToolSelection,
	persistentRoomWorkspaceToolNamesForPolicy,
	persistentRoomWorkspaceToolNamesForSelection,
	persistentRoomWorkspaceToolSelectionViewForPolicy,
} from "./persistent-room-tool-policy.js";
import { productAppStatePath, productAppStateRoot, stateHome } from "../../../pi-package/product-state-paths.js";
import { readPersistentRoomBashSettings, storeRunWithoutAskingAsOwn } from "./persistent-room-bash-settings.js";
import { type PersistentRoomProtection, persistentRoomProtection, persistentRoomProtectionCanRun } from "./persistent-room-protection.js";
import { serverHooks } from "./server-hooks.js";

export type PersistentRoomWorkspaceAccessMode = "bounded" | "localFiles";
/**
 * How a room's commands stand, in one field. `automatic`: on by the start-on
 * default of a room made where its protection runs, honoured only while it does.
 * `on`: the person turned them on. `off`: never on. `switched-off`: the person
 * switched them off, so the room never asks for them on a card.
 */
export type PersistentRoomCommands = "automatic" | "on" | "off" | "switched-off";
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
	/** Whether `commands` is on or automatic. On disk it is always false, for an older app (`storedPolicyBody`). */
	bashEnabled?: boolean;
	commands?: PersistentRoomCommands;
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
		/** The folder's full path as the person chose it; only in a view for a page on this computer. */
		path?: string;
	}>;
	workspaceAccessMode: PersistentRoomWorkspaceAccessMode;
	modes: { read: boolean; write: boolean };
	allowedToolNames: string[];
	toolSelection: { kind: "standard" | "custom"; allowedToolNames: string[] };
	denySegments: string[];
	pathAccess: "workspace-only" | "local-files";
	writeEnabled: boolean;
	bashEnabled: boolean;
	nativePiFilesystemToolsEnabled: boolean;
}

export type PersistentRoomWorkspaceRootValidationErrorCode =
	| "missing_root"
	| "root_not_absolute"
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
	toolSelection?: PersistentRoomWorkspaceToolSelection;
	bashEnabled?: boolean;
}

export type CreatePersistentRoomDefaultCapabilityPolicyInput = Omit<CreatePersistentRoomCapabilityPolicyInput, "conversationId">;
export type PersistentRoomCapabilityPolicyResolutionSource = "room-default" | "none";
export type PersistentRoomEffectiveWorkspacePolicySource = "room-default" | "none";

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
	/** Commands can change files whatever Can change files says: they run, and nothing holds them to the room's access. */
	commandsChangeFiles: boolean;
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
// `.pi` holds tool settings, not documents: no room opens it.
export const PERSISTENT_ROOM_APP_STATE_SEGMENTS = [".exxeta", ".exxperts", ".pi"] as const;
// What a new policy stores. The file fence (room-files.ts) closes only what a
// stored policy lists beyond these, so `.git` and `node_modules` read and
// `.mcp.json` reads but never changes, in policies stored before too.
export const PERSISTENT_ROOM_DEFAULT_DENY_SEGMENTS = [".git", ...PERSISTENT_ROOM_APP_STATE_SEGMENTS, "node_modules"] as const;
export const PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS = [".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_ed25519", ".mcp.json"] as const;
// Keynote saves a deck as a folder or a zip named `*.key`: rooms open such a
// folder, and a file of that name only when it is a zip.
export const PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS = ["*.key"] as const;
// Committed templates that hold no secrets, although `.env.*` matches them.
export const PERSISTENT_ROOM_SECRET_FILENAME_TEMPLATES = [".env.example", ".env.sample", ".env.template", ".env.dist"] as const;
// Closed both ways in every room, matched as a run of parts anywhere in the
// real path, so a folder granted inside `.aws` still hides its `credentials`.
// A `**` part matches any run of parts.
export const PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS = [
	".netrc", ".git-credentials", ".aws/credentials", ".docker/config.json", ".kube/config", ".config/gh/hosts.yml",
	".ssh", ".gnupg", "id_ecdsa", "id_dsa", "id_ecdsa_sk", "id_ed25519_sk",
	".pypirc", ".envrc", ".config/gcloud", "AppData/Roaming/gcloud",
	".config/mcp/mcp.json",
	"proc/**/environ", "proc/**/cmdline",
] as const;
// Read but never written, matched the same way: git hooks and config (and the
// files that point git at them), launch agents and `.mcp.json` run code later.
export const PERSISTENT_ROOM_READ_ONLY_PATHS = [
	"Library/LaunchAgents", ".gitconfig", ".config/git/config", ".git/hooks", ".git/config", ".git/**/config.worktree",
	".git/modules/**/hooks", ".git/modules/**/config", ".git/**/commondir", ".husky", ".mcp.json",
] as const;
// Startup and package-manager files: closed both ways in the login home folder
// (and wherever its entries really live), read but never written anywhere else.
export const PERSISTENT_ROOM_HOME_CLOSED_PATHS = [
	".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".config/fish",
	".npmrc", ".yarnrc", ".yarnrc.yml",
] as const;
// Every `~/.exxperts-<name>` folder is another data profile's own tree, and the
// `~/.exxperts.*` files beside the tree say where it lives and order its moves.
export const PERSISTENT_ROOM_APP_SIBLING_GLOBS = [".exxperts-*", ".exxperts.*"] as const;

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
	// With a data profile active the roots above point inside the profile, so
	// the REAL ~/.exxperts (the standard profile's tokens, wallet, rooms) must
	// stay forbidden too, or a room could be granted it as a workspace. Three
	// homes are asked, and a machine without any of this dedupes them into one:
	// the state home (the folder this server's own tree sits in: the profile
	// dir while a profile is loaded, the moved folder after a move), the home
	// the supervisor named, and the login home. The login home matters even
	// when the data moved: it can still hold a dormant ~/.exxperts from before
	// the relocation (old wallet, provider keys). os.userInfo() resolves it
	// from the OS account, so it answers even where HOME is unusual.
	let loginHome: string | undefined;
	try {
		loginHome = os.userInfo().homedir || undefined;
	} catch {
		// No account record (some containers): nothing extra to forbid.
	}
	// The forbidden area is the WHOLE state tree, not just its app folder:
	// ~/.exxperts also holds the coding agent's auth.json and provider tokens.
	// And every sibling ~/.exxperts-<name> is another data profile's tree with
	// its own tokens and wallet. To a server running under one profile's HOME
	// the others are ordinary folders, so they are listed and forbidden by
	// name. Deny segments cannot do this: ".exxperts" matches that segment
	// exactly and never ".exxperts-demo".
	const realHomeRoots: PersistentRoomWorkspaceForbiddenRootInput[] = [];
	const seenHomes = new Set<string>();
	for (const home of [stateHome(), process.env.EXXPERTS_REAL_HOME?.trim(), loginHome, os.homedir()]) {
		if (!home || seenHomes.has(home)) continue;
		seenHomes.add(home);
		realHomeRoots.push(
			{ kind: "exxeta-state-root", path: path.join(home, ".exxperts") },
			{ kind: "persistent-agents-root", path: path.join(home, ".exxperts", "app", "personalized-agents") },
		);
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(home);
		} catch {
			// No readable home: the standard tree above is still forbidden.
		}
		for (const entry of entries) {
			if (!entry.startsWith(".exxperts-") || entry.length === ".exxperts-".length) continue;
			const profileDir = path.join(home, entry);
			try {
				if (!fs.statSync(profileDir).isDirectory()) continue;
			} catch {
				continue;
			}
			realHomeRoots.push({ kind: "exxeta-state-root", path: profileDir });
		}
	}
	return [
		{ kind: "repo-root", path: input.repoRoot },
		{ kind: "exxeta-state-root", path: exxetaStateRoot },
		...realHomeRoots,
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
			message: "Choose a folder for this room.",
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

/**
 * The room's access as stored: `access` is this version's own field, and an
 * older app drops it when it saves the room, so its `workspaceAccessMode` is
 * read then, on every read. An unknown old value drops the folder either way.
 */
function storedPersistentRoomWorkspaceAccessMode(raw: { access?: unknown; workspaceAccessMode?: unknown }): PersistentRoomWorkspaceAccessMode | null {
	const older = normalizeStoredPersistentRoomWorkspaceAccessMode(raw.workspaceAccessMode);
	if (older === null) return null;
	return raw.access === "bounded" || raw.access === "localFiles" ? raw.access : older;
}

/**
 * How the room's commands stand as stored, read leniently. This version keeps
 * them in `commands` and never sets `bashEnabled`; an older app writes
 * `bashEnabled` and drops `commands`, so its Bash on reads as on, every time.
 */
function storedPersistentRoomCommands(rawCommands: unknown, rawBashEnabled: unknown, workspaceAccessMode: PersistentRoomWorkspaceAccessMode): PersistentRoomCommands {
	if (workspaceAccessMode === "localFiles" && (rawBashEnabled === true || rawCommands === "on" || rawCommands === "automatic")) return rawCommands === "automatic" ? "automatic" : "on";
	return rawCommands === "switched-off" ? "switched-off" : "off";
}

/**
 * A policy as it goes to disk. An older app reads only `workspaceAccessMode`
 * and `bashEnabled`, so they say Bounded and off: there its file tools keep to
 * the folder and no command runs. This version reads `access` and `commands`.
 */
function storedPolicyBody(policy: PersistentRoomCapabilityPolicy): string {
	const stored = { ...policy, workspaceAccessMode: "bounded", access: policy.workspaceAccessMode, bashEnabled: false, commands: persistentRoomCommandsOf(policy) };
	return JSON.stringify(stored, null, 2) + "\n";
}

function writePolicyFile(file: string, policy: PersistentRoomCapabilityPolicy): void {
	ensurePrivateDir(path.dirname(file));
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, storedPolicyBody(policy), { mode: 0o600 });
	fs.renameSync(temporary, file);
}

/** Whether a stored policy is in this version's shape, as `storedPolicyBody` writes it. */
function storedForOlderApp(raw: any): boolean {
	return raw?.workspaceAccessMode === "bounded" && raw.bashEnabled === false && (raw.access === "bounded" || raw.access === "localFiles");
}

/**
 * A room an older app saved keeps its old fields in every file this version
 * hasn't written since. Any write or removal here rewrites the room's other settings in
 * this version's fields, each as it reads now: the room's own, each
 * conversation's and how commands are answered. So a room changed here, by
 * whichever control, never runs commands or reaches past its folder in an
 * older app. A cut halfway leaves old fields, which every read still maps.
 */
export function storeRoomInOwnFields(agentIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): void {
	const agentId = safePolicyFileId(agentIdRaw, "agent id");
	const conversationFiles = fs.existsSync(workspacePolicyDir(agentId, options)) ? fs.readdirSync(workspacePolicyDir(agentId, options)).filter((name) => name.endsWith(".json")) : [];
	const places: Array<[string, string]> = [
		[persistentRoomWorkspaceDefaultPath(agentId, options), PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID],
		...conversationFiles.map((name): [string, string] => [path.join(workspacePolicyDir(agentId, options), name), name.slice(0, -".json".length)]),
	];
	for (const [file, conversationId] of places) {
		const raw = fs.existsSync(file) ? readJson(file) : null;
		if (raw === null || storedForOlderApp(raw)) continue;
		const policy = normalizePersistentRoomCapabilityPolicy(raw, agentId, conversationId);
		if (policy) writePolicyFile(file, policy);
	}
	storeRunWithoutAskingAsOwn(agentId, options);
}

/** Whether the room's commands run on this computer: an automatic yes holds only where the room's protection can run, turned off by the person or not. */
export function persistentRoomCommandsRun(commands: PersistentRoomCommands, agentId: string): boolean {
	return commands === "on" || (commands === "automatic" && persistentRoomProtectionCanRun(agentId));
}

/** Whether a room's commands could run at all: on a computer with no box only while the room can change files, since there a command can change any file. */
export function persistentRoomCommandsCanRun(policy: PersistentRoomCapabilityPolicy): boolean {
	const protection = persistentRoomProtection(policy.agentId);
	return policy.modes.write || !(protection.state === "off" && protection.cause === "computer");
}

/** Whether a policy's commands run now: as stored, where they could run at all. */
function persistentRoomPolicyCommandsRun(policy: PersistentRoomCapabilityPolicy): boolean {
	return persistentRoomCommandsRun(persistentRoomCommandsOf(policy), policy.agentId) && persistentRoomCommandsCanRun(policy);
}

/** How a stored policy's commands stand. */
export function persistentRoomCommandsOf(policy: PersistentRoomCapabilityPolicy): PersistentRoomCommands {
	return storedPersistentRoomCommands(policy.commands, policy.bashEnabled, policy.workspaceAccessMode ?? PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE);
}

function withCommands(commands: PersistentRoomCommands): { bashEnabled: boolean; commands: PersistentRoomCommands } {
	return { bashEnabled: commands === "on" || commands === "automatic", commands };
}

/**
 * The Commands switch as the page sends it with every save, against how they
 * stood: on as it was keeps an automatic yes automatic, and only on to off in
 * Full access is the person switching them off; Bounded turns them off with it.
 * A switched-off room stays so until she turns them on.
 */
function commandsAfterSwitch(agentId: string, before: PersistentRoomCommands, bashEnabled: boolean, workspaceAccessMode: PersistentRoomWorkspaceAccessMode): PersistentRoomCommands {
	const running = persistentRoomCommandsRun(before, agentId);
	if (bashEnabled) return before === "automatic" && running ? "automatic" : "on";
	return running && workspaceAccessMode === "localFiles" ? "switched-off" : before;
}

/**
 * A commands card's yes: where the room is protected it was given under the
 * card's promise that commands stay inside the room, so it holds only where
 * the protection can run; elsewhere it was Turn on anyway, the person's own.
 */
export function withCommandsFromCard(policy: PersistentRoomCapabilityPolicy, now = new Date()): PersistentRoomCapabilityPolicy {
	const workspaceAccessMode = policy.workspaceAccessMode ?? PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE;
	const automatic = persistentRoomProtection(policy.agentId).state === "on";
	return { ...policy, ...withCommands(storedPersistentRoomCommands(automatic ? "automatic" : "on", true, workspaceAccessMode)), updatedAt: now.toISOString() };
}

/** Whether the person switched the room's commands off, which every conversation of it follows. */
export function persistentRoomCommandsSwitchedOff(agentId: string, _conversationId: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): boolean {
	const policy = readPersistentRoomDefaultCapabilityPolicy(agentId, options);
	return policy !== null && persistentRoomCommandsOf(policy) === "switched-off";
}

/** Present in a room made where its protection runs, until its first folder is saved: that folder's commands start on. */
function commandsStartOnPath(agentId: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): string {
	return path.join(workspaceRuntimeDir(safePolicyFileId(agentId, "agent id"), options), "commands-start-on.json");
}

/**
 * Whether a room with no folder will run commands without asking once one is
 * chosen with the switch untouched: a new room's start-on default, or how Clear
 * kept them. Never where that folder will only
 * read: protected, its commands only read too, and elsewhere they don't run.
 */
export function persistentRoomCommandsStartOn(agentId: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): boolean {
	if (readPersistentRoomDefaultCapabilityPolicy(agentId, options) !== null) return false;
	const kept = readKeptForNextFolder(agentId, options);
	if (!untouchedCanChangeFiles(null, kept.canChangeFiles)) return false;
	const commands = untouchedCommands(kept.commands, fs.existsSync(commandsStartOnPath(agentId, options)));
	return persistentRoomCommandsRun(commands, agentId) && readPersistentRoomBashSettings(agentId, options).autoApprove;
}

/** A folder's commands when the save leaves the switch untouched: as they stood, or for a room's first folder its start-on default. */
function untouchedCommands(before: PersistentRoomCommands | null, startsOn: boolean): PersistentRoomCommands {
	return before ?? (startsOn ? "automatic" : "off");
}

/** Whether a folder saved without a tool choice can change files: as the room's folder can, else as Clear kept it, else yes (a new room's first folder, or a kept file from before the field). */
function untouchedCanChangeFiles(previous: PersistentRoomCapabilityPolicy | null, kept: boolean | null): boolean {
	return previous ? previous.modes.write : kept !== false;
}

/** Present after Clear: how the room's commands stood and whether it could change files, which its next folder keeps. Removed when that folder is saved. */
function keptCommandsPath(agentId: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): string {
	return path.join(workspaceRuntimeDir(safePolicyFileId(agentId, "agent id"), options), "commands-kept.json");
}

type KeptForNextFolder = { commands: PersistentRoomCommands | null; canChangeFiles: boolean | null };

function readKeptForNextFolder(agentId: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): KeptForNextFolder {
	const raw = readJson(keptCommandsPath(agentId, options));
	const commands = raw?.commands;
	return {
		commands: commands === "automatic" || commands === "on" || commands === "off" || commands === "switched-off" ? commands : null,
		canChangeFiles: typeof raw?.canChangeFiles === "boolean" ? raw.canChangeFiles : null,
	};
}

/** The file a new room is made with where its protection runs, relative to the room's folder. */
export const PERSISTENT_ROOM_COMMANDS_START_ON_FILE = "runtime/commands-start-on.json";

/** The single source of truth for "this room can make changes": a writer tool
 * is in the selection. Everything that reports or stores a write capability
 * derives from this — there is no separate stored write switch. */
export function persistentRoomWorkspaceWriterToolsEnabled(allowedToolNames: readonly string[]): boolean {
	return allowedToolNames.includes("write") || allowedToolNames.includes("edit");
}

function normalizePersistentRoomCapabilityPolicy(raw: any, agentId: string, conversationId: string): PersistentRoomCapabilityPolicy | null {
	if (serverHooks().ignoresStoredWorkspaceSettings?.()) return null;
	if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
	if (raw.agentId !== agentId || raw.conversationId !== conversationId) return null;
	const roots: Array<PersistentRoomWorkspaceRootGrant | null> = Array.isArray(raw.roots) ? raw.roots.map(normalizePersistentRoomWorkspaceRootGrant) : [];
	const deniedRoots: Array<PersistentRoomDeniedRootView | null> = Array.isArray(raw.deniedRoots) ? raw.deniedRoots.map(normalizePersistentRoomDeniedRootView) : [];
	if (roots.some((root) => !root) || deniedRoots.some((root) => !root)) return null;
	const createdAt = String(raw.createdAt ?? "").trim();
	const updatedAt = String(raw.updatedAt ?? "").trim();
	const policyId = String(raw.policyId ?? "").trim();
	const workspaceAccessMode = storedPersistentRoomWorkspaceAccessMode(raw);
	const toolSelection = workspaceAccessMode === null ? null : normalizeStoredPersistentRoomWorkspaceToolSelection(raw.toolSelection, workspaceAccessMode);
	if (!policyId || !createdAt || !updatedAt || workspaceAccessMode === null || toolSelection === null) return null;
	const commands = storedPersistentRoomCommands(raw.commands, raw.bashEnabled, workspaceAccessMode);
	const policy: PersistentRoomCapabilityPolicy = {
		schemaVersion: 1,
		policyId,
		agentId,
		conversationId,
		workspaceAccessMode,
		roots: roots as PersistentRoomWorkspaceRootGrant[],
		modes: { read: raw.modes?.read === true, write: false },
		allowedToolNames: Array.isArray(raw.allowedToolNames) ? raw.allowedToolNames.map(String).filter(Boolean) : [],
		...(toolSelection ? { toolSelection } : {}),
		...withCommands(commands),
		deniedRoots: deniedRoots as PersistentRoomDeniedRootView[],
		denySegments: Array.isArray(raw.denySegments) ? raw.denySegments.map(String).filter(Boolean) : [],
		denyFilenameGlobs: Array.isArray(raw.denyFilenameGlobs) ? raw.denyFilenameGlobs.map(String).filter(Boolean) : [],
		createdAt,
		updatedAt,
	};
	// The stored write flag is ignored: write capability is derived from the
	// record's effective tool names, using the same resolution the views use.
	// This runs after every field that resolution reads is normalized.
	policy.modes.write = persistentRoomWorkspaceWriterToolsEnabled(persistentRoomWorkspaceToolNamesForPolicy(policy));
	return policy;
}

/**
 * A stored policy as this version runs it, on every read: one access, where
 * commands alone differ, and the Folder pane's file tools. A Bounded room's
 * file tools stopped where every room's stop (room-files.ts), and its commands
 * never ran: they read switched off, so the room never asks for them until the
 * person turns them on. Nothing is stored until the person changes the room.
 */
function foldedPersistentRoomPolicy(policy: PersistentRoomCapabilityPolicy): PersistentRoomCapabilityPolicy | null {
	const toolSelection = persistentRoomFoldedToolSelection(persistentRoomWorkspaceToolNamesForPolicy(policy));
	if (toolSelection === null) return null;
	const allowedToolNames = persistentRoomWorkspaceToolNamesForSelection(toolSelection, "localFiles");
	const commands = policy.workspaceAccessMode === "bounded" ? "switched-off" : persistentRoomCommandsOf(policy);
	return { ...policy, workspaceAccessMode: "localFiles", allowedToolNames, toolSelection, modes: { read: true, write: persistentRoomWorkspaceWriterToolsEnabled(allowedToolNames) }, ...withCommands(commands) };
}

/**
 * A conversation's own settings, which only older versions wrote, give way to
 * the room's: none is read. Its file is kept, so that going back can still
 * find it; the room's next save rewrites it in this version's fields with the
 * same meaning (`storeRoomInOwnFields`).
 */
export function readPersistentRoomCapabilityPolicy(_agentIdRaw: string, _conversationIdRaw: string, _options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomCapabilityPolicy | null {
	return null;
}

export function writePersistentRoomCapabilityPolicy(policy: PersistentRoomCapabilityPolicy, options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomCapabilityPolicy {
	const agentId = safePolicyFileId(policy.agentId, "agent id");
	const conversationId = safePolicyFileId(policy.conversationId, "conversation id");
	writePolicyFile(persistentRoomWorkspacePolicyPath(agentId, conversationId, options), policy);
	storeRoomInOwnFields(agentId, options);
	return policy;
}

export function deletePersistentRoomCapabilityPolicy(agentIdRaw: string, conversationIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): { deleted: boolean } {
	const file = persistentRoomWorkspacePolicyPath(agentIdRaw, conversationIdRaw, options);
	if (!fs.existsSync(file)) return { deleted: false };
	fs.rmSync(file, { force: true });
	storeRoomInOwnFields(agentIdRaw, options);
	return { deleted: true };
}

export function readPersistentRoomDefaultCapabilityPolicy(agentIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomCapabilityPolicy | null {
	const agentId = safePolicyFileId(agentIdRaw, "agent id");
	const file = persistentRoomWorkspaceDefaultPath(agentId, options);
	if (!fs.existsSync(file)) return null;
	const stored = normalizePersistentRoomCapabilityPolicy(readJson(file), agentId, PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID);
	return stored && foldedPersistentRoomPolicy(stored);
}

export function missingPersistentRoomWorkspaceRootWarnings(policy: PersistentRoomCapabilityPolicy | null): string[] {
	if (!policy) return [];
	const warnings: string[] = [];
	for (const root of policy.roots) {
		if (fs.existsSync(root.realpath) || fs.existsSync(root.path)) continue;
		// Label only — full paths stay redacted on every UI surface.
		warnings.push(`The saved workspace folder "${root.displayLabel || root.basename}" was not found on this computer. Pick it again in Edit workspace, or another folder, to give the room its tools back.`);
	}
	return warnings;
}

export function writePersistentRoomDefaultCapabilityPolicy(policy: PersistentRoomCapabilityPolicy, options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomCapabilityPolicy {
	const agentId = safePolicyFileId(policy.agentId, "agent id");
	if (policy.conversationId !== PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID) throw new Error("room-default workspace policy must use the room-default conversation id");
	// An older app's yes moves by the room's commands as they stood, before this save changes them.
	storeRunWithoutAskingAsOwn(agentId, options);
	writePolicyFile(persistentRoomWorkspaceDefaultPath(agentId, options), policy);
	storeRoomInOwnFields(agentId, options);
	// The first folder took the start-on default, or the commands Clear kept; after a cut here the next save takes them again, which gives the same.
	fs.rmSync(commandsStartOnPath(agentId, options), { force: true });
	fs.rmSync(keptCommandsPath(agentId, options), { force: true });
	return policy;
}

/** Clear: the folder goes, and how the room's commands stood and whether it could change files are kept, first, for its next folder. */
export function deletePersistentRoomDefaultCapabilityPolicy(agentIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): { deleted: boolean } {
	const file = persistentRoomWorkspaceDefaultPath(agentIdRaw, options);
	if (!fs.existsSync(file)) return { deleted: false };
	storeRunWithoutAskingAsOwn(agentIdRaw, options);
	const policy = readPersistentRoomDefaultCapabilityPolicy(agentIdRaw, options);
	if (policy) {
		const kept = keptCommandsPath(agentIdRaw, options);
		const temporary = `${kept}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, commands: persistentRoomCommandsOf(policy), canChangeFiles: policy.modes.write }, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(temporary, kept);
	}
	fs.rmSync(file, { force: true });
	storeRoomInOwnFields(agentIdRaw, options);
	return { deleted: true };
}

/** Every conversation of a room runs on the room's own settings. */
export function resolvePersistentRoomCapabilityPolicy(agentIdRaw: string, _conversationIdRaw: string, options: PersistentRoomWorkspacePolicyStorageOptions = {}): PersistentRoomCapabilityPolicyResolution {
	const defaultPolicy = readPersistentRoomDefaultCapabilityPolicy(agentIdRaw, options);
	if (defaultPolicy) return { policy: defaultPolicy, source: "room-default" };
	return { policy: null, source: "none" };
}

// The words a person reads for a folder rooms may not work in, by what the folder is.
function forbiddenRootRefusal(kind: PersistentRoomForbiddenRootKind, holdsIt: boolean): string {
	const what = kind === "repo-root" ? "the exxperts app itself" : "exxperts' own data";
	return holdsIt
		? `This folder contains ${what}, so a room can't work in it. Choose a project folder instead, such as one in Documents.`
		: `This folder is ${what}, which rooms never open. Choose another folder.`;
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
				message: forbiddenRootRefusal(forbiddenRoot.kind, false),
				forbiddenRoot: redactedDeniedRoot(forbiddenRoot),
			});
		}
	}
	for (const forbiddenRoot of input.forbiddenRoots) {
		const forbiddenCandidates = [forbiddenRoot.realpath, forbiddenRoot.path];
		if (workspaceCandidates.some((workspace) => forbiddenCandidates.some((forbidden) => sameOrDescendant(workspace, forbidden)))) {
			throw new PersistentRoomWorkspacePolicyError({
				code: "under_forbidden_root",
				message: forbiddenRootRefusal(forbiddenRoot.kind, false),
				forbiddenRoot: redactedDeniedRoot(forbiddenRoot),
			});
		}
	}
	for (const forbiddenRoot of input.forbiddenRoots) {
		const forbiddenCandidates = [forbiddenRoot.realpath, forbiddenRoot.path];
		if (workspaceCandidates.some((workspace) => forbiddenCandidates.some((forbidden) => strictAncestor(workspace, forbidden)))) {
			throw new PersistentRoomWorkspacePolicyError({
				code: "ancestor_of_forbidden_root",
				message: forbiddenRootRefusal(forbiddenRoot.kind, true),
				forbiddenRoot: redactedDeniedRoot(forbiddenRoot),
			});
		}
	}
}

// Windows' "Copy as path" wraps the path in double quotes.
function unquotedWorkspaceRoot(root: string): string {
	const trimmed = String(root ?? "").trim();
	const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed[trimmed.length - 1] === trimmed[0];
	return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

const FULL_PATH_EXAMPLE = process.platform === "win32" ? "C:\\Users\\you\\Projects" : process.platform === "darwin" ? "/Users/you/Projects" : "/home/you/projects";

/** A folder named from the top: on Windows a drive letter or a network share,
 * since "\Projects" alone lands on whatever drive the app runs from. */
export function isFullWorkspacePath(input: string, platform: NodeJS.Platform = process.platform): boolean {
	if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(input) || /^[\\/]{2}[^\\/]/.test(input);
	return path.posix.isAbsolute(input);
}

export function validatePersistentRoomWorkspaceRoot(root: string, context: PersistentRoomWorkspaceValidationContext): PersistentRoomWorkspaceRootGrant {
	const requestedRoot = validateRequiredWorkspaceRoot(unquotedWorkspaceRoot(root));
	// A relative path would be read from the app's own folder, not the person's.
	if (!isFullWorkspacePath(expandWorkspaceRootInput(requestedRoot))) {
		throw new PersistentRoomWorkspacePolicyError({
			code: "root_not_absolute",
			message: `Use the folder's full path, for example ${FULL_PATH_EXAMPLE}.`,
		});
	}
	const resolvedPath = canonicalAbsolutePath(requestedRoot);
	const rootRealpath = existingRealpath(resolvedPath);
	if (!rootRealpath) {
		throw new PersistentRoomWorkspacePolicyError({
			code: "root_not_found",
			message: "There is no folder at that path. Check it and save again.",
		});
	}
	let stats: fs.Stats;
	try {
		stats = fs.statSync(rootRealpath);
	} catch {
		throw new PersistentRoomWorkspacePolicyError({
			code: "root_not_found",
			message: "There is no folder at that path. Check it and save again.",
		});
	}
	if (!stats.isDirectory()) {
		throw new PersistentRoomWorkspacePolicyError({
			code: "root_not_directory",
			message: "That is a file, not a folder. Choose the folder it is in.",
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
	// Left out, a new room's first folder takes the start-on default; sent, it is the person's own choice.
	// Another folder for the room, or its next one after Clear, keeps how its commands stood, the switched-off mark included,
	// and, with no tool choice sent, whether it could change files.
	const isRoomDefault = input.conversationId === PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID;
	const previous = isRoomDefault ? readPersistentRoomDefaultCapabilityPolicy(agentId, input) : null;
	const kept: KeptForNextFolder = isRoomDefault ? readKeptForNextFolder(agentId, input) : { commands: null, canChangeFiles: null };
	const toolSelection: PersistentRoomWorkspaceToolSelection = input.toolSelection === undefined && isRoomDefault
		? (untouchedCanChangeFiles(previous, kept.canChangeFiles) ? { kind: "standard" } : { kind: "custom", allowedToolNames: [...PERSISTENT_ROOM_READONLY_WORKSPACE_TOOL_NAMES] })
		: normalizePersistentRoomWorkspaceToolSelectionInput(input.toolSelection, { defaultToStandard: true, workspaceAccessMode });
	const selectedToolNames = persistentRoomWorkspaceToolNamesForSelection(toolSelection, workspaceAccessMode);
	const before = previous ? persistentRoomCommandsOf(previous) : kept.commands;
	const startsOn = isRoomDefault && fs.existsSync(commandsStartOnPath(agentId, input));
	// Before a new room's first folder the switch shows on: turned off there, the person switched them off.
	const chosen: PersistentRoomCommands = input.bashEnabled === undefined ? untouchedCommands(before, startsOn)
		: before !== null ? commandsAfterSwitch(agentId, before, input.bashEnabled, workspaceAccessMode)
		: input.bashEnabled ? "on" : startsOn && workspaceAccessMode === "localFiles" ? "switched-off" : "off";
	const commands = storedPersistentRoomCommands(chosen, chosen === "on" || chosen === "automatic", workspaceAccessMode);
	return {
		schemaVersion: 1,
		policyId: `prcp_${crypto.randomUUID()}`,
		agentId,
		conversationId: input.conversationId,
		workspaceAccessMode,
		roots: [rootGrant],
		modes: {
			read: true,
			write: persistentRoomWorkspaceWriterToolsEnabled(selectedToolNames),
		},
		allowedToolNames: selectedToolNames,
		toolSelection,
		...withCommands(commands),
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
	const before = persistentRoomCommandsOf(policy);
	const switched = Object.prototype.hasOwnProperty.call(input, "bashEnabled") ? commandsAfterSwitch(policy.agentId, before, input.bashEnabled === true, workspaceAccessMode) : before;
	const commands = storedPersistentRoomCommands(switched, switched === "on" || switched === "automatic", workspaceAccessMode);
	return {
		...policy,
		workspaceAccessMode,
		allowedToolNames: persistentRoomWorkspaceToolNamesForSelection(toolSelection, workspaceAccessMode),
		toolSelection,
		...withCommands(commands),
		updatedAt: now.toISOString(),
	};
}

/** The view the page and the tools read. It names each folder without its
 * path unless `withPaths` is set, which the server does only for a page on
 * this computer: a remote device or a shared server never gets the path. */
export function persistentRoomCapabilityPolicyView(policy: PersistentRoomCapabilityPolicy, options: { withPaths?: boolean } = {}): PersistentRoomCapabilityPolicyView {
	const workspaceAccessMode = policy.workspaceAccessMode ?? PERSISTENT_ROOM_LEGACY_WORKSPACE_ACCESS_MODE;
	const workspaceToolNames = persistentRoomWorkspaceToolNamesForPolicy(policy);
	const writeEnabled = persistentRoomWorkspaceWriterToolsEnabled(workspaceToolNames);
	const bashEnabled = persistentRoomPolicyCommandsRun(policy);
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
			...(options.withPaths ? { path: root.path } : {}),
		})),
		modes: { read: policy.modes.read, write: writeEnabled },
		allowedToolNames: workspaceToolNames,
		toolSelection: persistentRoomWorkspaceToolSelectionViewForPolicy(policy),
		denySegments: [...policy.denySegments],
		pathAccess: persistentRoomPathAccessForMode(workspaceAccessMode),
		writeEnabled,
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
	protection: PersistentRoomProtection;
}): PersistentRoomPathHash {
	return hashPersistentRoomPath(JSON.stringify({
		source: input.source,
		// Turn off or on, or a cause that comes or goes, rebinds the next message: the box is handed out at the bind.
		protection: input.protection,
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
		writeEnabled: persistentRoomWorkspaceWriterToolsEnabled(allowedToolNames),
		bashEnabled,
		// Where protection runs it holds commands to the room's access; off, by the person or for the folder, nothing does.
		commandsChangeFiles: bashEnabled && persistentRoomProtection(policy.agentId).state === "off",
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
	const policyBashEnabled = input.policy ? persistentRoomPolicyCommandsRun(input.policy) : false;
	const workspaceToolsEnabled = Boolean(input.policy && (allowedToolNames.length > 0 || policyBashEnabled) && input.policy.modes.read === true && workspacePolicyRootCurrentlyUsable(input.policy));
	const effectiveAllowedToolNames = workspaceToolsEnabled ? allowedToolNames : [];
	const effectiveBashEnabled = workspaceToolsEnabled ? policyBashEnabled : false;
	const fingerprint = fingerprintEffectiveWorkspacePolicy({
		source: input.source,
		policy: input.policy,
		allowedToolNames: effectiveAllowedToolNames,
		workspaceToolsEnabled,
		bashEnabled: effectiveBashEnabled,
		protection: persistentRoomProtection(input.agentId),
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

/** The one boundary a live workspace-default mutation still respects: a turn
 * actually in flight finishes under the rules it started with. */
export function assertPersistentRoomWorkspaceDefaultMutable(activeThread: { inFlight: boolean; cancelling: boolean } | null | undefined, action: "Save" | "Clear" = "Save"): void {
	if (!activeThread?.inFlight) return;
	const error = new Error(`The room is answering right now. ${action} again when it has finished; nothing was changed.`);
	(error as any).statusCode = 409;
	(error as any).code = "active_turn_in_flight";
	throw error;
}

/** The line for a next message the room could not rebuild for after a settings
 * change. The raw text can name a full path, so it goes only to details, and
 * only when `withDetails` says the page is on this computer. */
export function persistentRoomSettingsNotAppliedFrame(error: unknown, sharedServer: boolean, withDetails: boolean): { code: "room_settings_not_applied"; message: string; details?: string } {
	const next = sharedServer ? "Try again in a moment; if it repeats, tell your admin." : "Try again; if it repeats, restart exxperts.";
	const message = `The room could not apply its new settings, so your message was not sent. Nothing was lost. ${next}`;
	return withDetails ? { code: "room_settings_not_applied", message, details: error instanceof Error ? error.message : String(error) } : { code: "room_settings_not_applied", message };
}

export function persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectivePolicy: PersistentRoomEffectiveWorkspacePolicy | null | undefined, fallbackCwd: string): string {
	const fallback = String(fallbackCwd || "").trim() || process.cwd();
	// Bounded and Full-access rooms alike sit in their granted workspace; only
	// a room without a usable grant falls back (bounded tools never consult the
	// cwd, but the session claiming to run from the repo root was a lie).
	const root = effectivePolicy?.policy?.roots[0];
	if (!root) return fallback;
	const rootRealpath = existingRealpath(root.realpath) ?? existingRealpath(root.path);
	if (!rootRealpath) return fallback;
	try {
		return fs.statSync(rootRealpath).isDirectory() ? rootRealpath : fallback;
	} catch {
		return fallback;
	}
}
