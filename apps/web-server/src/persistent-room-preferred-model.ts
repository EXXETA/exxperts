import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

/**
 * Per-room preferred model: the model this room's picker last settled on,
 * remembered even while the room has no conversation thread.
 *
 * A room with a standby thread already remembers its model through the thread
 * lock; an empty room used to forget its pick the moment the AI profile
 * switched, reverting to whatever the new profile recommends. This file gives
 * empty rooms the same memory: the launcher seeds the room's picker from it,
 * and when the preferred model belongs to a non-active profile the card offers
 * the same switch-and-enter path a stranded standby room offers.
 *
 * This is display and seeding state only. It never routes credentials and
 * never decides what answers a message — at send time everything still goes
 * through the single active profile, gated by the same approval checks as
 * before. The stored pair is deliberately not validated against any profile
 * catalog: a preference pointing at a signed-out provider must survive so the
 * room can offer the way back once that provider is ready again.
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

// Provider ids never contain "/", model ids may ("moonshotai/kimi-k2" via a
// gateway) — so both fields stay free-form apart from being non-empty,
// single-line, and bounded.
function safePreferredModelField(raw: unknown, label: string): string {
	if (typeof raw !== "string") throw new Error(`${label} must be a string`);
	const value = raw.trim();
	if (!value) throw new Error(`${label} is required`);
	if (value.length > 200) throw new Error(`${label} is too long`);
	if (/[\r\n\t]/.test(value)) throw new Error(`${label} must be a single line`);
	return value;
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
		// An unreadable file reads as "no preference": the picker falls back to
		// the recommendation, and the next pick rewrites the file cleanly.
		return null;
	}
}

export function writePersistentRoomPreferredModel(agentIdRaw: string, input: { provider?: unknown; model?: unknown }, options: PersistentRoomPreferredModelStorageOptions = {}, now = new Date()): PersistentRoomPreferredModel {
	const provider = safePreferredModelField(input?.provider, "provider");
	const model = safePreferredModelField(input?.model, "model");
	const file = persistentRoomPreferredModelPath(agentIdRaw, options);
	const record: PersistentRoomPreferredModel = {
		schemaVersion: 1,
		provider,
		model,
		updatedAt: now.toISOString(),
	};
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
	return record;
}
