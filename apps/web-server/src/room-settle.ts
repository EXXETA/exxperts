// Settle this room: the one step that finishes what a crash left half done.
//
// A kill can leave a Remember whose page is written but not finished, a
// Forget that closed a conversation and has not erased its words, or a turn
// that ended with no line saying so. Every reader
// of a room's content calls this step before it reads, so nobody sees either.
// Nothing else calls `settleCommits` or `sweepForgotten`.

import fs from "node:fs";
import path from "node:path";

import { sweepForgotten } from "./forget-erase.js";
import { landKilledTurnLines } from "./killed-turn-line.js";
import { commitIntentPath, settleCommits } from "./memory-commit.js";
import { createPersistentAgentInstance } from "./persistent-agent-store.js";

/** One file call: the commit folder outlives its intents, so finding the folder says nothing about a save. */
function savePending(roomDir: string): boolean {
	try {
		return fs.readdirSync(path.dirname(commitIntentPath(roomDir, "memory"))).some((name) => name.endsWith(".json"));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/**
 * Finishes the room's pending saves, erases what its forgotten conversations
 * left and tells the turns a kill ended. On a settled room this costs one file
 * call, after the room's first touch in this process, which also pays for the
 * sweep and the look for killed turns.
 *
 * Never call it from code a save runs between its intent and its clear
 * (`createPersistentAgentInstance`, `getPersistentAgentThread`, the boot
 * context): it would finish or drop that very save (memory-commit.ts).
 */
export function settleRoom(agentIdRaw: string): void {
	const { agentId, rootDir } = createPersistentAgentInstance(agentIdRaw);
	if (savePending(rootDir)) settleCommits(agentId, rootDir);
	sweepForgotten(agentId, rootDir);
	landKilledTurnLines(agentId, rootDir);
}
