import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

/** Ordered rules for live room skill and bash calls; these never enable a disabled capability. */
export type RoomPermissionAction = "ask" | "allow" | "deny";
export type RoomPermissionCategory = "skill" | "bash";
export type RoomPermissionRule = RoomPermissionAction | Record<string, RoomPermissionAction>;
export interface RoomPermissionDocument {
	permission: RoomPermissionAction | Partial<Record<RoomPermissionCategory, RoomPermissionRule>>;
}
export interface RoomPermissionsView {
	exists: boolean;
	document: RoomPermissionDocument | null;
	error: string | null;
}
export interface RoomPermissionMatch {
	action: RoomPermissionAction;
	pattern: string | null;
}

const ACTIONS = new Set(["ask", "allow", "deny"]);
const CATEGORIES = new Set(["skill", "bash"]);

export function roomPermissionsPath(roomIdRaw: string, options: { persistentAgentsRoot?: string } = {}): string {
	const roomId = String(roomIdRaw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(roomId)) throw new Error("invalid persistent-room agent id");
	return path.join(persistentAgentRootPath(roomId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "permissions.json");
}

export function validateRoomPermissions(input: unknown): RoomPermissionDocument {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("permissions must be an object with a \"permission\" key");
	const keys = Object.keys(input);
	if (keys.length !== 1 || keys[0] !== "permission") throw new Error("only the \"permission\" key is supported");
	const permission = (input as Record<string, unknown>).permission;
	if (typeof permission === "string") {
		if (!ACTIONS.has(permission)) throw new Error(`invalid action "${permission}"`);
		return { permission: permission as RoomPermissionAction };
	}
	if (!permission || typeof permission !== "object" || Array.isArray(permission)) throw new Error("\"permission\" must be an action or an object");
	for (const [category, rule] of Object.entries(permission)) {
		if (!CATEGORIES.has(category)) throw new Error(`unsupported permission category "${category}"`);
		if (typeof rule === "string") {
			if (!ACTIONS.has(rule)) throw new Error(`invalid action "${rule}" for ${category}`);
			continue;
		}
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`${category} must be an action or a pattern object`);
		for (const [pattern, action] of Object.entries(rule)) {
			if (pattern.length === 0) throw new Error(`${category} has an empty pattern`);
			if (typeof action !== "string" || !ACTIONS.has(action)) throw new Error(`invalid action for ${category} pattern "${pattern}"`);
		}
	}
	return { permission } as RoomPermissionDocument;
}

function orderedStoredPermissions(raw: string, document: RoomPermissionDocument): RoomPermissionDocument {
	if (typeof document.permission === "string") return document;
	// JSON.parse has already checked JSON syntax and supplies values; only use
	// ordered map keys here, since JS object enumeration reorders integer keys.
	const source = parseDocument(raw, { uniqueKeys: false });
	if (source.errors.length || !isMap(source.contents)) throw new Error("permissions.json has no rule object");
	const permissionNode = source.contents.items.filter((item) => isScalar(item.key) && item.key.value === "permission").at(-1)?.value;
	if (!isMap(permissionNode)) throw new Error("permissions.json has no permission object");
	const permission: RoomPermissionDocument["permission"] = { ...document.permission };
	for (const category of CATEGORIES) {
		const rule = document.permission[category as RoomPermissionCategory];
		if (!rule || typeof rule === "string") continue;
		const categoryNode = permissionNode.items.filter((item) => isScalar(item.key) && item.key.value === category).at(-1)?.value;
		if (!isMap(categoryNode)) throw new Error(`permissions.json has no ${category} pattern object`);
		const order = [...new Set(categoryNode.items.map((item) => {
			if (!isScalar(item.key) || typeof item.key.value !== "string") throw new Error(`invalid ${category} pattern`);
			return item.key.value;
		}))];
		// JSON.parse supplies the values (including duplicate-key last-value wins);
		// the source map supplies first-occurrence key order.
		const orderedRule = new Proxy(rule, { ownKeys: () => order });
		permission[category as RoomPermissionCategory] = orderedRule;
	}
	return { permission };
}

export function readRoomPermissions(roomId: string, options: { persistentAgentsRoot?: string } = {}): RoomPermissionsView {
	const file = roomPermissionsPath(roomId, options);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			try {
				fs.lstatSync(file);
				return { exists: true, document: null, error: "permissions.json could not be read" };
			} catch (statError: any) {
				if (statError?.code === "ENOENT") {
					try {
						if (fs.statSync(path.dirname(file)).isDirectory()) return { exists: false, document: null, error: null };
					} catch {
						// A missing or unreadable runtime directory is not an absent rule file.
					}
				}
			}
		}
		return { exists: true, document: null, error: "permissions.json could not be read" };
	}
	try {
		const document = validateRoomPermissions(JSON.parse(raw));
		return { exists: true, document: orderedStoredPermissions(raw, document), error: null };
	} catch (error: any) {
		return { exists: true, document: null, error: `permissions.json is invalid: ${error?.message ?? "parse error"}` };
	}
}

export function parseRoomPermissionsInput(input: unknown): RoomPermissionDocument {
	const raw = typeof input === "string" ? input : JSON.stringify(input);
	const document = validateRoomPermissions(typeof input === "string" ? JSON.parse(input) : input);
	return orderedStoredPermissions(raw, document);
}

export function writeRoomPermissions(roomId: string, input: unknown, options: { persistentAgentsRoot?: string } = {}): RoomPermissionsView {
	const ordered = parseRoomPermissionsInput(input);
	const file = roomPermissionsPath(roomId, options);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temp, JSON.stringify(ordered, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		fs.renameSync(temp, file);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
	return { exists: true, document: ordered, error: null };
}

function globMatches(pattern: string, input: string): boolean {
	let patternIndex = 0;
	let inputIndex = 0;
	let starIndex = -1;
	let starInputIndex = 0;
	while (inputIndex < input.length) {
		const char = pattern[patternIndex];
		if (char === "*") {
			starIndex = patternIndex++;
			starInputIndex = inputIndex;
		} else if (patternIndex < pattern.length && (char === "?" || char === input[inputIndex])) {
			patternIndex++;
			inputIndex++;
		} else if (starIndex !== -1) {
			patternIndex = starIndex + 1;
			inputIndex = ++starInputIndex;
		} else {
			return false;
		}
	}
	while (pattern[patternIndex] === "*") patternIndex++;
	return patternIndex === pattern.length;
}

/** null means no rule applies; the caller keeps its existing behavior. */
export function resolveRoomPermission(view: RoomPermissionsView, category: RoomPermissionCategory, input: string): RoomPermissionMatch | null {
	if (view.error) return { action: "deny", pattern: null };
	const permission = view.document?.permission;
	if (!permission) return null;
	if (typeof permission === "string") return { action: permission, pattern: null };
	const rule = permission[category];
	if (!rule) return null;
	if (typeof rule === "string") return { action: rule, pattern: null };
	let match: RoomPermissionMatch | null = null;
	for (const [pattern, action] of Object.entries(rule)) {
		if (globMatches(pattern, input)) match = { action, pattern };
	}
	return match;
}
