import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated HOME too: the profile-switch leg writes the global AI-profile state
// file, which must never touch the developer's real product state.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-preferred-model-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-preferred-model-root-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	persistentRoomPreferredModelPath,
	readPersistentRoomPreferredModel,
	writePersistentRoomPreferredModel,
} = await import("../src/persistent-room-preferred-model.js");
const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
const { createPersistentAgentFromScaffoldInput, getPersistentAgentStatus } = await import("../src/persistent-agents.js");

const agentId = "preferred-model-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

try {
	// Absent preference: reads null, and reading never creates the file — the
	// launcher falls back to the recommendation exactly as before the feature.
	assert(readPersistentRoomPreferredModel(agentId) === null, "absent preference must read as null");
	assert(!fs.existsSync(persistentRoomPreferredModelPath(agentId)), "read must not create the preference file");

	// Write/read round-trip, including a gateway-style model id with a slash.
	const written = writePersistentRoomPreferredModel(agentId, { provider: "openrouter", model: "moonshotai/kimi-k2" }, {}, new Date("2026-08-01T12:00:00.000Z"));
	assert(written.provider === "openrouter" && written.model === "moonshotai/kimi-k2", "write should return the stored pair");
	assert(written.updatedAt === "2026-08-01T12:00:00.000Z", "write should stamp updatedAt");
	const reread = readPersistentRoomPreferredModel(agentId);
	assert(reread?.provider === "openrouter" && reread.model === "moonshotai/kimi-k2", "reread should see the persisted pair");

	// A rewrite replaces the pair.
	writePersistentRoomPreferredModel(agentId, { provider: "anthropic", model: "claude-sonnet-5" });
	assert(readPersistentRoomPreferredModel(agentId)?.model === "claude-sonnet-5", "rewrite should replace the stored pair");

	// The preference survives profile switches: it is keyed by agentId alone,
	// so flipping the global active profile back and forth changes nothing.
	writePersistentAgentAiProfileState("anthropic");
	assert(readPersistentRoomPreferredModel(agentId)?.model === "claude-sonnet-5", "preference must survive a switch to anthropic");
	writePersistentAgentAiProfileState("chatgpt-codex");
	assert(readPersistentRoomPreferredModel(agentId)?.model === "claude-sonnet-5", "preference must survive a switch back");

	// A preference pointing at a provider no configured profile serves is still
	// returned verbatim: the server stores honestly, the launcher decides
	// whether it can offer a switch or must fall back to the recommendation.
	writePersistentRoomPreferredModel(agentId, { provider: "some-deleted-gateway", model: "phantom-model" });
	const orphaned = readPersistentRoomPreferredModel(agentId);
	assert(orphaned?.provider === "some-deleted-gateway" && orphaned.model === "phantom-model", "orphaned preference must still read back");

	// Bad input is rejected before anything is written.
	for (const [input, label] of [
		[{ provider: "", model: "m" }, "empty provider"],
		[{ provider: "p", model: "   " }, "blank model"],
		[{ provider: "p" }, "missing model"],
		[{ provider: 42, model: "m" }, "non-string provider"],
		[{ provider: "p", model: "two\nlines" }, "multi-line model"],
		[{ provider: "x".repeat(201), model: "m" }, "oversized provider"],
	] as Array<[Record<string, unknown>, string]>) {
		let threw = false;
		try {
			writePersistentRoomPreferredModel(agentId, input);
		} catch {
			threw = true;
		}
		assert(threw, `${label} should be rejected`);
	}
	assert(readPersistentRoomPreferredModel(agentId)?.provider === "some-deleted-gateway", "rejected writes must not clobber the stored preference");

	// Path-escaping agent ids are rejected.
	let threwId = false;
	try {
		persistentRoomPreferredModelPath("../escape");
	} catch {
		threwId = true;
	}
	assert(threwId, "path-escaping agent ids should be rejected");

	// A corrupt file reads as "no preference" so the picker falls back cleanly.
	fs.writeFileSync(persistentRoomPreferredModelPath(agentId), "not json", "utf-8");
	assert(readPersistentRoomPreferredModel(agentId) === null, "corrupt preference should read as null");

	// The launcher's feed: the room status carries the preference, so the cards
	// need no per-room fetch. Absent preference means an absent field.
	const scaffolded = createPersistentAgentFromScaffoldInput({ displayName: "Prefroom", userName: "Smoke User" });
	const bare = getPersistentAgentStatus(scaffolded.agent.agentId);
	assert(bare.preferredModel === undefined, "a room without a preference must not carry preferredModel");
	writePersistentRoomPreferredModel(scaffolded.agent.agentId, { provider: "anthropic", model: "claude-opus-5" });
	const carrying = getPersistentAgentStatus(scaffolded.agent.agentId);
	assert(carrying.preferredModel?.provider === "anthropic" && carrying.preferredModel.model === "claude-opus-5", "room status must carry the recorded preference");

	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("room preferred model smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
