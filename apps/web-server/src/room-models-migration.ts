// The one-time move to a model per room (0.14), run at every server start and
// doing nothing once done.
//
// Before, one AI profile decided every room's models: a room remembered its
// last pick in runtime/preferred-model.json, the app remembered its last pick
// for new rooms in web-chat-model.json, and each profile named the model that
// ran Memorize and the one that ran Review. The move keeps every one of those
// choices:
//
// - the defaults for new rooms are written next to the saved profile pointer:
//   the conversation default is the app's last pick when the saved profile
//   offers it, else the profile's recommended room model; the memory default
//   is the profile's Memorize model. When the profile ran Review on a
//   different model the two collapse into the memory row (Memorize wins) and
//   the report says so;
// - each room's preferred-model.json becomes its models.json conversation
//   pick, written and read back before the old file is removed;
// - a conversation already open keeps its own lock: nothing here touches a
//   thread.
// - a default a later release moved (room-models.ts, DEFAULT_MOVES) follows
//   it once, unless something on disk shows the person chose it: this
//   migration took the conversation default from their last pick, or they
//   changed the row after this migration wrote it. The move is recorded so
//   it is made once, and so a Remember page written before a memory move
//   still saves.
//
// Nothing is removed before its replacement is written and read back. With no
// provider signed in there is nothing to take the defaults from, so they are
// left for a later start (the derived default covers the time between). The
// report lists what moved, what collapsed, and which rooms' stored picks
// cannot run right now.

import fs from "node:fs";
import path from "node:path";
import { persistentAgentModelLocksEqual, type PersistentAgentModelLock } from "./persistent-agent-ai-profiles.js";
import { readPersistentAgentAiProfileState } from "./persistent-agent-ai-profile-state.js";
import { readPersistentRoomPreferredModel, persistentRoomPreferredModelPath } from "./persistent-room-preferred-model.js";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT } from "./persistent-room-workspace-policy.js";
import { createRoomModelCatalog, derivedAiDefault, DEFAULT_MOVES, LEGACY_ROOM_MODEL_SELECTION_FILE, readDefaultMove, readRoomModels, readStoredAiDefaults, ROOM_MODEL_TASKS, writeAiDefaults, writeDefaultMove, writeRoomModels, type RoomModelCatalog, type RoomModelTask, type RoomModelUnavailableReason } from "./room-models.js";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

export const ROOM_MODELS_MIGRATION_REPORT_FILE = productAppStatePath("room-models-migration.json");

export interface RoomModelsMigrationReport {
	schemaVersion: 1;
	migratedAt: string;
	defaults: {
		written: boolean;
		conversation?: PersistentAgentModelLock;
		memory?: PersistentAgentModelLock;
		conversationFrom?: "last-pick" | "recommended";
		/** Why the defaults were not written this time. */
		skipped?: string;
		/** The app's old last pick for new rooms (web-chat-model.json), removed once the defaults hold it. */
		lastPickRemoved?: boolean;
	};
	/** A profile whose Review model differed from its Memorize model: both now run on the memory row, Memorize's model. */
	collapsed: Array<{ profileId: string; memorize: PersistentAgentModelLock; review: PersistentAgentModelLock }>;
	/** Rooms whose preferred model became their conversation pick. */
	rooms: Array<{ agentId: string; conversation: PersistentAgentModelLock }>;
	/** Stored picks that cannot run right now; the room waits until they can, or another is chosen. */
	unavailable: Array<{ agentId: string; task: RoomModelTask; lock: PersistentAgentModelLock; reason: RoomModelUnavailableReason }>;
	errors: string[];
}

export interface RoomModelsMigrationOptions {
	persistentAgentsRoot?: string;
	catalog?: RoomModelCatalog;
	log?: (message: string) => void;
	now?: Date;
}

function listRoomIds(root: string): string[] {
	try {
		return fs.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,160}$/.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

export function migrateRoomModels(options: RoomModelsMigrationOptions = {}): RoomModelsMigrationReport {
	const root = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	const log = options.log ?? (() => {});
	const now = options.now ?? new Date();
	const catalog = options.catalog ?? createRoomModelCatalog();
	// What an earlier start wrote, read before this one may write its own.
	let previous: Partial<RoomModelsMigrationReport> | null = null;
	try { previous = JSON.parse(fs.readFileSync(ROOM_MODELS_MIGRATION_REPORT_FILE, "utf-8")); } catch { /* none yet */ }
	const report: RoomModelsMigrationReport = { schemaVersion: 1, migratedAt: now.toISOString(), defaults: { written: false }, collapsed: [], rooms: [], unavailable: [], errors: [] };

	// 1. The defaults for new rooms, once.
	try {
		const stored = readStoredAiDefaults();
		if (ROOM_MODEL_TASKS.every((task) => stored[task])) {
			report.defaults.skipped = "already written";
		} else {
			const state = readPersistentAgentAiProfileState();
			if (state.source === "default" || state.source === "invalid") {
				report.defaults.skipped = "no provider is signed in yet";
			} else {
				const derivedConversation = stored.conversation ? null : derivedAiDefault("conversation");
				const conversation = stored.conversation ?? derivedConversation?.lock;
				const memory = stored.memory ?? derivedAiDefault("memory").lock;
				if (!conversation || !memory) throw new Error(`the ${state.profile.label} profile names no room model or no Memorize model`);
				const written = writeAiDefaults({ conversation, memory });
				if (!written.conversation || !persistentAgentModelLocksEqual(written.conversation, conversation) || !written.memory || !persistentAgentModelLocksEqual(written.memory, memory)) {
					throw new Error("the defaults did not read back as written");
				}
				const conversationFrom = derivedConversation?.from === "last-pick" || derivedConversation?.from === "recommended" ? derivedConversation.from : undefined;
				report.defaults = { written: true, conversation: written.conversation, memory: written.memory, ...(conversationFrom ? { conversationFrom } : {}) };
				const review = state.profile.processes.structuralReview;
				if (!persistentAgentModelLocksEqual(review, state.profile.processes.absorb)) {
					report.collapsed.push({ profileId: state.profile.id, memorize: { ...state.profile.processes.absorb }, review: { ...review } });
				}
				log(`room models migration: defaults for new rooms written (conversation ${written.conversation.provider}/${written.conversation.model}, memory ${written.memory.provider}/${written.memory.model})`);
				for (const collapsed of report.collapsed) log(`room models migration: the ${collapsed.profileId} profile ran Review on ${collapsed.review.model} and Memorize on ${collapsed.memorize.model}; both now run on the memory row, ${collapsed.memorize.model}`);
			}
		}
		// The old last pick is read by nothing once the defaults are stored, so
		// it goes, only now that they read back.
		const complete = readStoredAiDefaults();
		if (ROOM_MODEL_TASKS.every((task) => complete[task]) && fs.existsSync(LEGACY_ROOM_MODEL_SELECTION_FILE)) {
			fs.rmSync(LEGACY_ROOM_MODEL_SELECTION_FILE, { force: true });
			report.defaults.lastPickRemoved = true;
		}
	} catch (error) {
		report.errors.push(`defaults: ${(error as Error).message}`);
	}

	// 1b. A default a release moved, once, unless something on disk shows the
	// person chose it. The record of what the migration wrote is this start's,
	// or the earlier start's that wrote the defaults: a conversation default
	// it took from the person's last pick stays, and so does a row the person
	// changed since it was written. With no such record (none, or one that
	// wrote nothing) nothing shows a choice, and the default moves. A room's
	// own pick and a conversation's lock are never touched.
	const proof = report.defaults.written ? report.defaults : previous?.defaults?.written === true ? previous.defaults : undefined;
	for (const task of ROOM_MODEL_TASKS) {
		try {
			const stored = readStoredAiDefaults()[task];
			const written = proof?.[task];
			const chosen = (task === "conversation" && proof?.conversationFrom === "last-pick") || Boolean(stored && written && !persistentAgentModelLocksEqual(stored, written));
			// A move whose last record did not save, though the default did, is made.
			const cut = readDefaultMove(task);
			if (cut && !cut.done && stored && persistentAgentModelLocksEqual(stored, cut.to)) writeDefaultMove(task, { ...cut, done: true });
			const made = readDefaultMove(task);
			const move = DEFAULT_MOVES[task].find((candidate) => stored && !chosen && persistentAgentModelLocksEqual(stored, candidate.from)
				&& !(made?.done && persistentAgentModelLocksEqual(made.from, candidate.from) && persistentAgentModelLocksEqual(made.to, candidate.to)));
			if (move) {
				const record = { from: { ...move.from }, to: { ...move.to }, at: now.toISOString() };
				writeDefaultMove(task, record);
				const moved = writeAiDefaults({ [task]: { ...move.to } })[task];
				if (!moved || !persistentAgentModelLocksEqual(moved, move.to)) throw new Error(`the moved ${task} default did not read back as written`);
				writeDefaultMove(task, { ...record, done: true });
				log(`room models migration: the ${task} default moved from ${move.from.model} to ${move.to.model}`);
			}
		} catch (error) {
			report.errors.push(`${task} default: ${(error as Error).message}`);
		}
	}

	// 2. Each room's preferred model becomes its conversation pick.
	for (const agentId of listRoomIds(root)) {
		try {
			const legacyFile = persistentRoomPreferredModelPath(agentId, { persistentAgentsRoot: root });
			if (fs.existsSync(legacyFile)) {
				const preferred = readPersistentRoomPreferredModel(agentId, { persistentAgentsRoot: root });
				const current = readRoomModels(agentId, { persistentAgentsRoot: root });
				if (preferred && !current?.conversation) {
					const lock = { provider: preferred.provider, model: preferred.model };
					const written = writeRoomModels(agentId, { conversation: lock }, { persistentAgentsRoot: root }, now);
					const readBack = readRoomModels(agentId, { persistentAgentsRoot: root });
					if (!readBack?.conversation || !persistentAgentModelLocksEqual(readBack.conversation, lock) || !written.conversation) throw new Error("models.json did not read back as written");
					report.rooms.push({ agentId, conversation: lock });
				}
				// Only now, with the pick safe in models.json (or none to keep):
				// an unreadable preferred-model.json held nothing a room used.
				fs.rmSync(legacyFile, { force: true });
			}
			const record = readRoomModels(agentId, { persistentAgentsRoot: root });
			for (const task of ROOM_MODEL_TASKS) {
				const lock = record?.[task];
				if (!lock) continue;
				const available = catalog.availability(lock, task);
				if (!available.ok) report.unavailable.push({ agentId, task, lock, reason: available.reason });
			}
		} catch (error) {
			report.errors.push(`room ${agentId}: ${(error as Error).message}`);
		}
	}
	for (const room of report.rooms) log(`room models migration: ${room.agentId} keeps ${room.conversation.provider}/${room.conversation.model} as its conversation model`);
	for (const error of report.errors) log(`room models migration: ${error}`);

	// The report is kept only when something moved, so a start with nothing to
	// do never overwrites the record of the start that did the work. A start
	// that did not write the defaults (a room's move, an error, a default move
	// that failed) keeps that start's record of them, so a later start can
	// still tell which defaults the person chose.
	if (report.defaults.written || report.defaults.lastPickRemoved || report.rooms.length > 0 || report.errors.length > 0) {
		const kept = !report.defaults.written && previous?.defaults?.written === true
			? { ...report, defaults: { ...previous.defaults, ...(report.defaults.lastPickRemoved ? { lastPickRemoved: true } : {}) } }
			: report;
		try {
			fs.mkdirSync(path.dirname(ROOM_MODELS_MIGRATION_REPORT_FILE), { recursive: true, mode: 0o700 });
			fs.writeFileSync(ROOM_MODELS_MIGRATION_REPORT_FILE, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
		} catch (error) {
			log(`room models migration: the report could not be written: ${(error as Error).message}`);
		}
	}
	return report;
}
