import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-skill-manual-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const { buildEnabledSkillsIndexSection, createReadSkillTool } = await import("../src/persistent-room-skill-tool.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// The lookup the room wires into read_skill: a normal skill and one whose author
// disabled model invocation. Both are "enabled" (a user can adopt either); the
// difference is whether the model may reach it.
const MANIFEST_NORMAL = "---\nname: cite-sources\ndescription: Cite sources\n---\n\nCite your sources.\n";
const MANIFEST_MANUAL = "---\nname: grill-me\ndescription: Grill the plan\ndisable-model-invocation: true\n---\n\nGrill relentlessly.\n";
const library = new Map<string, { manifest: string; body: string; description: string; disableModelInvocation: boolean }>([
	["cite-sources", { manifest: MANIFEST_NORMAL, body: "Cite your sources.", description: "Cite sources", disableModelInvocation: false }],
	["grill-me", { manifest: MANIFEST_MANUAL, body: "Grill relentlessly.", description: "Grill the plan", disableModelInvocation: true }],
]);

const { sha256 } = await import("../src/skills-store.js");
const { enablePersistentRoomSkill } = await import("../src/persistent-room-skill-settings.js");
const agentId = "manual-only-smoke-room";
// Enablement pins sha256(manifest) server-side (the fingerprint resolver is the
// manifest), and read_skill re-checks against the manifest, so the enable
// resolver here must return the manifest too, matching the real wiring.
const resolveManifest = (name: string): string | null => library.get(name)?.manifest ?? null;

try {
	// Index section: a manual-only skill is simply not the caller's job to include
	// (the room builds entries by filtering it out before calling this), so verify
	// the section renders only what it is handed and the room's filter is what
	// withholds it. Here we prove the read_skill refusal, which is the hard gate.
	enablePersistentRoomSkill(agentId, "cite-sources", resolveManifest);
	enablePersistentRoomSkill(agentId, "grill-me", resolveManifest);

	// Same cast the sibling skill-tool smoke uses: the tool's full execute
	// signature carries harness-only parameters this smoke never exercises.
	const readTool = createReadSkillTool({ agentId, lookupSkill: (name) => library.get(name) ?? null }) as unknown as {
		execute(toolCallId: string, params: { name: string }): Promise<{ content: Array<{ text: string }>; details?: { outcome?: string } }>;
	};

	// A normal enabled skill reads fine.
	const ok = await readTool.execute("t1", { name: "cite-sources" });
	assert(ok.details?.outcome === "ok", "a normal enabled skill should read");
	assert(ok.content[0].text.includes("Cite your sources."), "the normal body should be served");

	// The manual-only skill is refused even though it is enabled and unchanged.
	const refused = await readTool.execute("t2", { name: "grill-me" });
	assert(refused.details?.outcome === "manual-only", `manual-only skill must be refused with the manual-only outcome, got ${refused.details?.outcome}`);
	assert(!refused.content[0].text.includes("Grill relentlessly."), "the manual-only body must NOT be served");
	assert(/manual invocation only/i.test(refused.content[0].text), "the refusal must explain it is manual-only");

	// The index section helper itself is content-agnostic: it renders exactly the
	// entries passed. The room's filter (tested via the server) is what withholds
	// the manual-only one, so here we just confirm the section shape is unchanged
	// for a normal entry and empty for none.
	assert(buildEnabledSkillsIndexSection([]) === "", "no entries renders empty");
	assert(buildEnabledSkillsIndexSection([{ name: "cite-sources", description: "Cite sources" }]).includes("cite-sources"), "a normal entry renders");

	console.log("skills-manual-only-smoke: OK");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
