// Skills MR-6 smoke (spec §5 D-const, §7 must 6): the checkpoint-compression
// constitution carries the skills line — skill bodies read via read_skill are
// re-derivable and compress to a provenance reference, never retained verbatim,
// never laundered into the room's own voice — and the line rides every real
// compression prompt assembly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-const-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { checkpointCompressionConstitution, buildCheckpointCompressionPrompt } = await import("../src/checkpoint-compression.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const constitution = checkpointCompressionConstitution();

// The skills rule exists, in the Recoverable-vs-Ephemeral provenance section,
// with its load-bearing elements: the tool name, re-derivability, the
// reference-with-provenance shape (sha256), the never-retain rule, and the
// anti-laundering rule.
assert(constitution.includes("read_skill"), "constitution must name the read_skill tool");
assert(/skill[\s\S]{0,120}re-derivable/i.test(constitution), "constitution must state skill bodies are re-derivable");
assert(constitution.includes("used skill cite-sources (sha256:"), "constitution must show the reference-with-provenance shape");
assert(/never retain the instruction text/i.test(constitution), "constitution must forbid retaining the body text");
assert(/do not launder them into the room's own voice or memory/i.test(constitution), "constitution must carry the anti-laundering rule");
const skillsRuleIndex = constitution.indexOf("read_skill");
const recoverableIndex = constitution.indexOf("## Recoverable vs. Ephemeral Signal");
const nextSectionIndex = constitution.indexOf("## Fidelity Marking");
assert(recoverableIndex !== -1 && nextSectionIndex !== -1 && skillsRuleIndex > recoverableIndex && skillsRuleIndex < nextSectionIndex, "the skills rule must live in the Recoverable vs. Ephemeral provenance section");

// The rule reaches the real compression prompt (what the worker actually sees),
// including when a skill body sits in the transcript being compressed.
const l1b = `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Persistent agent id: skills-const-smoke
- Last checkpoint: none

## Deep Memory

Smoke deep memory.

## Active Items

Smoke active item.

## Recent Context

No checkpointed sessions yet.
`;
const assembly = buildCheckpointCompressionPrompt({
	agentId: "skills-const-smoke",
	conversationId: "c_skills",
	model: { provider: "openai-codex", model: "gpt-5.5" },
	density: "rich",
	items: [
		{ kind: "user", text: "apply the cite-sources skill to this answer" },
		{ kind: "assistant", text: "Skill \"cite-sources\" (sha256 abc123def456…, adopted by the user into this room's library). Always cite sources before answering." },
	],
	l1b,
} as any);
assert(assembly.prompt.includes("read_skill"), "assembled compression prompt must carry the skills constitution line");
assert(/never retain the instruction text/i.test(assembly.prompt), "assembled compression prompt must carry the never-retain rule");

fs.rmSync(tempHome, { recursive: true, force: true });
console.log("checkpoint-skills-constitution-smoke: OK");
