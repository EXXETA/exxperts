import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-maint-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-maint-root-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

const {
	createPersistentAgentFromScaffoldInput,
	getAbsorbAvailability,
} = await import("../src/persistent-agents.js");
const { ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER } = await import("../src/absorb-consolidation.js");
const { approveAbsorbRun, getAbsorbRun, startAbsorbRun } = await import("../src/absorb-run.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readText(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

function readJson(file: string): any {
	return JSON.parse(readText(file));
}

function fileCount(dir: string, predicate: (name: string) => boolean): number {
	return fs.existsSync(dir) ? fs.readdirSync(dir).filter(predicate).length : 0;
}

function archiveCount(agentRoot: string): number {
	return fileCount(path.join(agentRoot, "L1b", "archive"), (name) => name.endsWith(".md"));
}

function absorbEventCount(agentRoot: string): number {
	return fileCount(path.join(agentRoot, "events", "absorb"), (name) => name.endsWith(".json"));
}

// Nothing writes here any more — the Review this counted was replaced by the
// run — so a room that gains one of these files has gained it from somewhere
// it should not have.
function structuralReviewEventCount(agentRoot: string): number {
	return fileCount(path.join(agentRoot, "events", "structural-review"), (name) => name.endsWith(".json"));
}

function registrySnapshot(agentRoot: string): { exists: boolean; content: string | null; mtimeMs: number | null } {
	const file = path.join(agentRoot, "section_registry.json");
	if (!fs.existsSync(file)) return { exists: false, content: null, mtimeMs: null };
	const stat = fs.statSync(file);
	return { exists: true, content: readText(file), mtimeMs: stat.mtimeMs };
}

function snapshot(agentRoot: string) {
	return {
		l1b: readText(path.join(agentRoot, "L1b", "current.md")),
		archiveCount: archiveCount(agentRoot),
		absorbEventCount: absorbEventCount(agentRoot),
		structuralReviewEventCount: structuralReviewEventCount(agentRoot),
		registry: registrySnapshot(agentRoot),
	};
}

function assertSnapshotUnchanged(actualRoot: string, expected: ReturnType<typeof snapshot>, label: string): void {
	const actual = snapshot(actualRoot);
	assert(actual.l1b === expected.l1b, `${label}: L1b/current.md changed`);
	assert(actual.archiveCount === expected.archiveCount, `${label}: archive count changed`);
	assert(actual.absorbEventCount === expected.absorbEventCount, `${label}: absorb event count changed`);
	assert(actual.structuralReviewEventCount === expected.structuralReviewEventCount, `${label}: structural-review event count changed`);
	assert(actual.registry.exists === expected.registry.exists, `${label}: section_registry existence changed`);
	assert(actual.registry.content === expected.registry.content, `${label}: section_registry content changed`);
	assert(actual.registry.mtimeMs === expected.registry.mtimeMs, `${label}: section_registry timestamp changed`);
}

function isRelativePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
}

function expectThrows(fn: () => unknown, expected: RegExp, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return;
	}
	throw new Error(`${label}: expected error`);
}

function rcEntry(index: number): string {
	return `### RC-${String(index).padStart(4, "0")} | OPEN | 2026-05-30 | Selected maintenance smoke ${index}\n\n**Session arc:** Synthetic non-control room maintenance smoke ${index}.\n\n**Body:**\n- Durable selected-room insight ${index} should be consolidated without touching the control room.\n- Active selected-room follow-up ${index} should remain accountable.\n\n**Parked:**\nSynthetic parked item ${index}.\n`;
}

function selectedSourceL1b(agentId: string): string {
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n- Current scaffold timestamp: 2026-05-30T10:00:00.000Z\n- Persistent agent id: ${agentId}\n- Lifecycle state: ready\n- Last checkpoint: cp_selected_maintenance_smoke\n- Last consolidation: none\n\n## Deep Memory\n\n### Collaboration\n\n- This selected room validates non-default maintenance targeting.\n- Stable memory should change only under the selected room root.\n\n## Active Items\n\n### Current Focus\n\n- Prove selected Memorize write boundaries.\n\n### Parked\n\n- Keep provider-dependent workflows out of this smoke.\n\n## Recent Context\n\n${Array.from({ length: 5 }, (_, i) => rcEntry(i + 1)).join("\n")}\n`;
}

const FIXTURE_MODEL = { provider: "fixture-provider", model: "fixture-absorb", label: "Fixture Absorb" };

/** Each conversation folds into one note, so the save writes the selected room's memory. */
async function foldAll(prompt: string) {
	const session = /Session being folded: (RC-\d+)/.exec(prompt)?.[1] ?? "RC-0000";
	return { text: `\`\`\`json\n${JSON.stringify({ ops: [{ op: "add", topic: "Selected insights", kind: "fact", text: `- The selected-room insight from ${session} is kept.` }] })}\n\`\`\``, usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } };
}

async function settledRun(agentId: string, runId: string) {
	const deadline = Date.now() + 30_000;
	let run = getAbsorbRun(agentId, runId);
	while (["prepass", "folding", "budget"].includes(run.state)) {
		assert(Date.now() < deadline, `the run was still "${run.state}" after 30 seconds`);
		await new Promise((resolve) => setTimeout(resolve, 5));
		run = getAbsorbRun(agentId, runId);
	}
	return run;
}

try {
	const control = createPersistentAgentFromScaffoldInput({
		displayName: "Maintenance Control Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const controlAgentId = control.agent.agentId;
	const controlRoot = path.join(tempAgentsRoot, controlAgentId);
	const controlBaseline = snapshot(controlRoot);

	const created = createPersistentAgentFromScaffoldInput({
		displayName: "Wolfgang MR10b.2 Smoke",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const agentId = created.agent.agentId;
	assert(agentId !== controlAgentId, "selected room must be distinct from control room");
	const selectedRoot = path.join(tempAgentsRoot, agentId);
	const selectedL1bPath = path.join(selectedRoot, "L1b", "current.md");
	fs.writeFileSync(selectedL1bPath, selectedSourceL1b(agentId), "utf-8");
	const selectedBaseline = snapshot(selectedRoot);

	const absorbAvailability = getAbsorbAvailability(agentId);
	assert(absorbAvailability.available, "non-default absorb availability should be available");
	assert(absorbAvailability.recentContextEntryCount === 5, "non-default absorb availability should read selected Recent Context count");

	const started = startAbsorbRun({ agentId, assessmentMarkdown: "None.", model: FIXTURE_MODEL, generate: foldAll });
	const ready = await settledRun(agentId, started.runId);
	assert(ready.state === "ready", `the selected room's run should be ready, got ${ready.state}`);

	// The run belongs to the room it was started in: approving it under another
	// room's id is refused, and neither room changes.
	const beforeAbsorbMismatchSelected = snapshot(selectedRoot);
	expectThrows(
		() => approveAbsorbRun(controlAgentId, started.runId, new Date("2026-05-30T11:00:00.000Z")),
		/That memory update is no longer open/,
		"approving the selected room's run under the control room's id should reject",
	);
	assertSnapshotUnchanged(selectedRoot, beforeAbsorbMismatchSelected, "absorb mismatch selected room");
	assertSnapshotUnchanged(controlRoot, controlBaseline, "absorb mismatch control room");

	const absorbResult = approveAbsorbRun(agentId, started.runId, new Date("2026-05-30T11:00:00.000Z"));
	const afterAbsorbSelected = snapshot(selectedRoot);
	assert(absorbResult.agentId === agentId, "absorb approval response should identify selected room");
	assert(afterAbsorbSelected.l1b !== selectedBaseline.l1b, "selected L1b/current.md should change after absorb approval");
	assert(/^- Last consolidation: absorb_/m.test(afterAbsorbSelected.l1b), "the system stamps the consolidation into Chronos at absorb apply (the worker carries Chronos unchanged)");
	assert(/^- Last consolidation at: 2026-05-30T11:00:00\.000Z$/m.test(afterAbsorbSelected.l1b), "the consolidation stamp carries the apply time");
	assert(afterAbsorbSelected.archiveCount === selectedBaseline.archiveCount + 1, "selected archive count should increase after absorb approval");
	assert(afterAbsorbSelected.absorbEventCount === selectedBaseline.absorbEventCount + 1, "selected absorb event count should increase");
	assert(absorbResult.eventRelPath, "absorb approval response should carry eventRelPath");
	assert(absorbResult.eventRecordPath === path.join(selectedRoot, absorbResult.eventRelPath), "absorb event response path should be selected-root relative");
	const absorbEvent = readJson(absorbResult.eventRecordPath);
	assert(absorbEvent.agentId === agentId, "selected absorb event should record selected room id");
	assert(absorbEvent.archivedL1bPath == null, "selected absorb event should not persist top-level archive path");
	assert(absorbEvent.updatedL1bPath == null, "selected absorb event should not persist top-level updated L1b path");
	assert(isRelativePath(absorbEvent.paths?.archivedL1bRelPath), "selected absorb event archive path should be relative");
	assert(absorbEvent.paths?.updatedL1bRelPath === "L1b/current.md", "selected absorb event updated path should be selected-root relative");
	assert(absorbEvent.paths?.eventRelPath === absorbResult.eventRelPath, "selected absorb event path should be selected-root relative");
	const serializedAbsorbEvent = JSON.stringify(absorbEvent);
	assert(!serializedAbsorbEvent.includes(tempAgentsRoot), "selected absorb event JSON must not include temp root");
	assert(!serializedAbsorbEvent.includes(selectedRoot), "selected absorb event JSON must not include selected absolute root");
	assert(!serializedAbsorbEvent.includes(controlRoot), "selected absorb event JSON must not include default absolute root");
	assertSnapshotUnchanged(controlRoot, controlBaseline, "selected absorb control room");

	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("persistent-agent non-default maintenance smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
}
