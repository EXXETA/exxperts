import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

/**
 * Per-room preferred model, as versions before the model per room (0.14)
 * stored it: the model an empty room's picker last settled on. Read once, by
 * the room models migration, which turns it into the room's conversation pick
 * (runtime/models.json) and then removes it. Nothing else reads or writes it.
 */
export interface PersistentRoomPreferredModel {
	schemaVersion: 1;
	provider: string;
	model: string;
	updatedAt: string;
}

export interface PersistentRoomPreferredModelStorageOptions {
	persistentAgentsRoot?: string;
}

function safePreferredModelAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

export function persistentRoomPreferredModelPath(agentIdRaw: string, options: PersistentRoomPreferredModelStorageOptions = {}): string {
	const agentId = safePreferredModelAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "preferred-model.json");
}

export function readPersistentRoomPreferredModel(agentIdRaw: string, options: PersistentRoomPreferredModelStorageOptions = {}): PersistentRoomPreferredModel | null {
	const file = persistentRoomPreferredModelPath(agentIdRaw, options);
	try {
		if (!fs.existsSync(file)) return null;
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
		if (typeof raw.provider !== "string" || !raw.provider.trim()) return null;
		if (typeof raw.model !== "string" || !raw.model.trim()) return null;
		return {
			schemaVersion: 1,
			provider: raw.provider.trim(),
			model: raw.model.trim(),
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		};
	} catch {
		// An unreadable file held nothing a room could use: nothing to keep.
		return null;
	}
}
