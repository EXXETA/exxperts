// An install with only the Claude API key: the defaults for new rooms come
// from the key's own approved models, so a paid key's memory work runs on
// the model the person chose for it. The sign-in's recommendation only tags
// the key's models in the pickers; it never picks a default.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const KEY_PROVIDER = "anthropic-api-key";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-claude-key-only-"));
const tempHome = path.join(tempRoot, "home");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentDir, appDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(appDir, "personalized-agents");

try {
	// Approve models on the key: Opus 5.5 for rooms, Haiku 5.5 for memory. No sign-in, nothing stored yet.
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: `custom-${KEY_PROVIDER}`, providerId: KEY_PROVIDER, label: "Claude API key", roomModels: ["claude-opus-5-5"], learnModel: "claude-haiku-5-5", reviewMemoryModel: "claude-haiku-5-5" },
	] }, null, 2), { mode: 0o600 });

	const roomModels = await import("../src/room-models.js");
	const memory = roomModels.resolveAiDefault("memory");
	assert(memory.effective?.provider === KEY_PROVIDER && memory.effective.model === "claude-haiku-5-5", `the memory default is the key's own memory model, got ${JSON.stringify(memory.effective)}`);
	const stored = JSON.parse(fs.readFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), "utf-8"))?.defaults;
	assert(stored?.memory?.model === "claude-haiku-5-5", `the stored memory default is Haiku 5.5, got ${JSON.stringify(stored)}`);
	console.log("  ok  a key-only install stores the key's own memory model as the memory default");

	const catalog = roomModels.createRoomModelCatalog();
	const key = catalog.providers.find((provider) => provider.providerId === KEY_PROVIDER);
	assert(key, "the key is in the catalog");
	const tagged = roomModels.taggedRecommendation(key, catalog);
	assert(tagged.memory?.provider === KEY_PROVIDER && tagged.memory.model === "claude-opus-5-5", `the pickers tag the sign-in's recommended memory model on the key, got ${JSON.stringify(tagged.memory)}`);
	console.log("  ok  the key's Memory picker tags the sign-in's recommendation, and only tags it");
	console.log("claude-key-only-defaults smoke: ok");
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
