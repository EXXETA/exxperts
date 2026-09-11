// The RC entry counter is a governance surface: the 10-entry hard cap is what
// bounds Recent Context, and the budget denominator argument (S2) rests on that
// cap actually enforcing. Placeholder ("stub") entries are marked in the entry
// ID, never the title — a session titled "Fixed the API stub" is real memory.
// This smoke pins the shared predicate and all three counting surfaces
// (checkpoint metrics, absorb intake, room status) to the same fixture.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-rc-entries-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-rc-entries-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const { analyzeRecentContextIds, countRecentContextEntries, isStubRecentContextId } = await import("../src/recent-context-entries.js");
const { extractRecentContextSection } = await import("../src/checkpoint-compression.js");
const { extractRecentContextForAbsorb } = await import("../src/absorb-consolidation.js");
const { createPersistentAgentFromScaffoldInput, getPersistentAgentStatus } = await import("../src/persistent-agents.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function rcEntry(id: string, title: string): string {
	return `### ${id} | OPEN | 2026-08-20 | ${title}\n\n**Session arc:** ${title}.\n\n**Body:**\n- Something durable from "${title}".\n`;
}

// --- Predicate: the stub marker lives in the ID, not the title ---

assert(isStubRecentContextId("RC-stub-placeholder"), "an id carrying 'stub' is a placeholder");
assert(isStubRecentContextId("RC-STUB"), "the stub marker is case-insensitive");
assert(!isStubRecentContextId("RC-0007"), "a numeric id is a real entry");

// --- Shared fixture: one stub-titled entry, one stub-ID entry, one duplicate ---

const fixture = `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Lifecycle state: ready

## Deep Memory

- Something durable.

## Active Items

- One item.

## Recent Context

${rcEntry("RC-0001", "Fixed the API stub for testing")}
${rcEntry("RC-0002", "Ordinary session")}
### RC-stub-placeholder | template

Placeholder entry, not a session.

${rcEntry("RC-0002", "Duplicate id session")}
`;

const analysis = analyzeRecentContextIds(fixture);
assert(analysis.count === 3, `a stub TITLE counts, a stub ID does not (got count ${analysis.count})`);
assert(analysis.ids.includes("RC-0001"), "the stub-titled entry must be visible to the counter");
assert(!analysis.ids.includes("RC-stub-placeholder"), "the stub-ID entry must be excluded");
assert(analysis.duplicateIds.length === 1 && analysis.duplicateIds[0] === "RC-0002", `duplicate detection must see every real entry (got ${JSON.stringify(analysis.duplicateIds)})`);
assert(countRecentContextEntries(fixture) === 3, "countRecentContextEntries delegates to the same analysis");

// --- All three counting surfaces agree on the same fixture ---

const checkpointCount = extractRecentContextSection(fixture).entryCount;
assert(checkpointCount === 3, `checkpoint metrics must count exactly the real entries (got ${checkpointCount})`);
const absorbView = extractRecentContextForAbsorb(fixture);
assert(absorbView.entryCount === 2, `absorb intake counts unique real ids (got ${absorbView.entryCount})`);
assert(absorbView.entryIds.join(",") === "RC-0001,RC-0002", `absorb intake ids must include the stub-titled entry and exclude the stub id (got ${absorbView.entryIds.join(",")})`);

// --- The hard cap must see stub-titled sessions: room status probe ---

createPersistentAgentFromScaffoldInput({
	displayName: "RC Entries Smoke Room",
	userName: "Synthetic User",
	preferredUserAddress: "Synthetic User",
});
const agentId = "rc-entries-smoke-room";
const l1bPath = path.join(root, agentId, "L1b", "current.md");
assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");
const scaffold = fs.readFileSync(l1bPath, "utf-8");
const match = /^##\s+Recent Context\s*$/m.exec(scaffold);
assert(match?.index != null, "scaffold L1b should include Recent Context");
const entries = Array.from({ length: 10 }, (_, i) => rcEntry(`RC-${String(i + 1).padStart(4, "0")}`, i % 3 === 0 ? `Session ${i + 1} about the auth stub` : `Session ${i + 1}`)).join("\n");
fs.writeFileSync(l1bPath, `${scaffold.slice(0, match.index + match[0].length)}\n\n${entries}\n`, "utf-8");

const status = getPersistentAgentStatus(agentId);
assert(status.recentContext.fullEntries === 10, `10 real entries must all reach the hard-cap counter even when titles mention "stub" (got ${status.recentContext.fullEntries})`);
assert(status.status === "needs_absorb", `a room at the hard cap must report needs_absorb (got ${status.status})`);

console.log("recent-context-entries smoke passed");
