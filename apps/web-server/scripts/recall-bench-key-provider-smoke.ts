// The recall bench on a key provider, offline: no server, no provider, no
// network, and no real record.
//
// A key provider (the Claude API key, say) has no built-in profile: the app
// offers its models to rooms only once Approve models has written a custom
// profile, and a bench run's temp home has none, so every thread write stopped
// with "model is not offered to rooms". This smoke pins, against a synthetic
// agent dir with a dummy auth.json and no models.json:
//   - before the run's records are written, the key's model is not offered;
//   - after, the custom profile is the product's own (its reader takes it with
//     no error), it is the active profile, and it offers the room model to
//     rooms and the fold model for memory;
//   - a Remember's thread write, the floor that refused the model, takes it;
//   - a named memory model is offered for memory and is Memorize's model,
//     unless a fold model is named too;
//   - a built-in provider's model off its curated list stops the run before
//     anything is spent;
//   - a model id the runtime does not know stops it too, before the profile
//     is written;
//   - the named dir is left as it was.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as engine from "./memory-bench/recall-engine.mjs";
import { buildRecallFixture } from "./memory-bench/recall-fixtures.mjs";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const pass = (message: string) => console.log(`ok ${message}`);

const ROOM = { provider: "anthropic-api-key", model: "claude-opus-5-5" };
const FOLD = { provider: "anthropic-api-key", model: "claude-sonnet-5-5" };

const shared = fs.mkdtempSync(path.join(os.tmpdir(), "recall-bench-key-agent-"));
fs.writeFileSync(path.join(shared, "auth.json"), "{\"dummy\":{\"type\":\"api_key\",\"key\":\"not-a-key\"}}\n", { mode: 0o600 });
const before = fs.readdirSync(shared).map((name) => [name, fs.readFileSync(path.join(shared, name), "utf-8")]);
process.env.RECALL_BENCH_AGENT_DIR = shared;
process.env.RECALL_BENCH_FOLD_MODEL = `${FOLD.provider}/${FOLD.model}`;
const { home } = engine.prepareBenchHome("recall-bench-key-provider-smoke");

try {
	const { isRoomModelOffered } = await import("../src/room-models.js");
	const { readCustomAiProfiles } = await import("../src/custom-ai-profiles.js");
	assert(!isRoomModelOffered(ROOM, "conversation"), "a fresh bench home offers the key's model to no room: nothing here would fail without the fix");

	const lock = await engine.useRealProviderRecords({ spec: `${ROOM.provider}/${ROOM.model}`, signInFromHome: false });
	assert(lock.provider === ROOM.provider && lock.model === ROOM.model, `the lock is the spec, got ${JSON.stringify(lock)}`);
	assert(!fs.existsSync(path.join(home, ".exxperts", "agent", "models.json")), "no models.json is made up for the run");
	const read = readCustomAiProfiles();
	assert(read.errors.length === 0, `the product reads the bench's custom profile with no error, got ${JSON.stringify(read.errors)}`);
	assert(read.entries.length === 1 && read.entries[0]!.id === "custom-anthropic-api-key", `one custom profile, the key provider's, got ${JSON.stringify(read.entries)}`);
	const entry = read.entries[0]!;
	assert(JSON.stringify(entry.roomModels) === JSON.stringify([ROOM.model, FOLD.model]) && entry.learnModel === FOLD.model && entry.reviewMemoryModel === FOLD.model, `rooms get both named models and Memorize and Review the fold model, got ${JSON.stringify(entry)}`);
	const state = JSON.parse(fs.readFileSync(path.join(home, ".exxperts", "app", "persistent-agent-ai-profile.json"), "utf-8"));
	assert(state.profileId === "custom-anthropic-api-key", `the key's profile is the active one, got ${JSON.stringify(state)}`);
	assert(isRoomModelOffered(ROOM, "conversation"), "the key's room model is offered to rooms");
	assert(isRoomModelOffered(FOLD, "memory"), "the key's fold model is offered for memory");
	pass("a key provider's models are offered through the product's own custom profile");

	engine.setBenchModel(lock);
	const room = await engine.createBenchRoom({ home, name: "Key Provider Room", backHistoryTokens: 0 });
	const session = buildRecallFixture({ language: "en", sessions: 4, questionsPerAbility: 1, conversationQuestions: 1 }).sessions[0]!;
	const remembered = await engine.scriptedRemember({ roomId: room.roomId, session, now: new Date() });
	assert(typeof remembered.rcId === "string" && remembered.rcId.length > 0, "the Remember wrote its entry");
	pass("a thread write takes the key's model");

	const MEMORY = { provider: "anthropic-api-key", model: "claude-haiku-5-5" };
	process.env.RECALL_BENCH_MEMORY_MODEL = `${MEMORY.provider}/${MEMORY.model}`;
	delete process.env.RECALL_BENCH_FOLD_MODEL;
	await engine.useRealProviderRecords({ spec: `${ROOM.provider}/${ROOM.model}`, signInFromHome: false });
	const memoryOnly = readCustomAiProfiles().entries[0]!;
	assert(JSON.stringify(memoryOnly.roomModels) === JSON.stringify([ROOM.model, MEMORY.model]) && memoryOnly.learnModel === MEMORY.model, `with a memory model alone, Memorize and Review get it, got ${JSON.stringify(memoryOnly)}`);
	assert(isRoomModelOffered(MEMORY, "memory"), "the key's memory model is offered for memory");
	process.env.RECALL_BENCH_FOLD_MODEL = `${FOLD.provider}/${FOLD.model}`;
	await engine.useRealProviderRecords({ spec: `${ROOM.provider}/${ROOM.model}`, signInFromHome: false });
	const both = readCustomAiProfiles().entries[0]!;
	assert(JSON.stringify(both.roomModels) === JSON.stringify([ROOM.model, MEMORY.model, FOLD.model]) && both.learnModel === FOLD.model, `with both named, the fold model is Memorize's, got ${JSON.stringify(both)}`);
	pass("a named memory model is offered for memory, and the fold model wins Memorize when both are named");

	delete process.env.RECALL_BENCH_MEMORY_MODEL;
	delete process.env.RECALL_BENCH_FOLD_MODEL;
	let refused = "";
	// A model the runtime knows that the release's curated list leaves out.
	try { await engine.useRealProviderRecords({ spec: "anthropic/claude-opus-4-6", signInFromHome: false }); } catch (error) { refused = (error as Error).message; }
	assert(/not offered to rooms/.test(refused), `a built-in provider's uncurated model stops the run up front, got ${JSON.stringify(refused)}`);
	assert(readCustomAiProfiles().entries.every((candidate) => candidate.providerId !== "anthropic"), "no custom profile is written for a built-in provider");
	pass("a built-in provider's model off its list stops the run before anything is spent");

	const UNKNOWN = { provider: "anthropic-api-key", model: "claude-opus-9" };
	let unknownRoom = "";
	try { await engine.useRealProviderRecords({ spec: `${UNKNOWN.provider}/${UNKNOWN.model}`, signInFromHome: false }); } catch (error) { unknownRoom = (error as Error).message; }
	assert(unknownRoom.includes(`model not found: ${UNKNOWN.provider}/${UNKNOWN.model}`), `a key provider's model the runtime does not know stops the run up front, got ${JSON.stringify(unknownRoom)}`);
	process.env.RECALL_BENCH_MEMORY_MODEL = `${UNKNOWN.provider}/${UNKNOWN.model}`;
	let unknownMemory = "";
	try { await engine.useRealProviderRecords({ spec: `${ROOM.provider}/${ROOM.model}`, signInFromHome: false }); } catch (error) { unknownMemory = (error as Error).message; }
	delete process.env.RECALL_BENCH_MEMORY_MODEL;
	assert(unknownMemory.includes(`model not found: ${UNKNOWN.provider}/${UNKNOWN.model}`), `an unknown memory model stops the run up front, got ${JSON.stringify(unknownMemory)}`);
	assert(readCustomAiProfiles().entries.every((candidate) => !candidate.roomModels.includes(UNKNOWN.model)), "no custom profile offers a model the runtime does not know");
	pass("a model id the runtime does not know stops the run before anything is written or spent");

	const after = fs.readdirSync(shared).map((name) => [name, fs.readFileSync(path.join(shared, name), "utf-8")]);
	assert(JSON.stringify(after) === JSON.stringify(before), "the named agent dir is left as it was");
	pass("the named agent dir is left as it was");
} finally {
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(shared, { recursive: true, force: true });
}
console.log("recall-bench key-provider smoke passed");
