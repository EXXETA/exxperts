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
	fingerprintL1bSource,
	getAbsorbAvailability,
	getStructuralReviewAvailability,
	parseAbsorbApprovalRequest,
	parseStructuralReviewApprovalRequest,
	writeApprovedAbsorb,
	writeApprovedStructuralReview,
} = await import("../src/persistent-agents.js");
const { ABSORB_CONSOLIDATION_WORKER_TYPE, ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER } = await import("../src/absorb-consolidation.js");
const { extractStructuralReviewSourceParts, STRUCTURAL_REVIEW_MODE, STRUCTURAL_REVIEW_WORKER_TYPE } = await import("../src/structural-review.js");

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
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n- Current scaffold timestamp: 2026-05-30T10:00:00.000Z\n- Persistent agent id: ${agentId}\n- Lifecycle state: ready\n- Last checkpoint: cp_selected_maintenance_smoke\n- Last consolidation: none\n\n## Deep Memory\n\n### Collaboration\n\n- This selected room validates non-default maintenance targeting.\n- Stable memory should change only under the selected room root.\n\n## Active Items\n\n### Current Focus\n\n- Prove selected Absorb and Structural Review write boundaries.\n\n### Parked\n\n- Keep provider-dependent workflows out of this smoke.\n\n## Recent Context\n\n${Array.from({ length: 5 }, (_, i) => rcEntry(i + 1)).join("\n")}\n`;
}

function absorbCandidateL1b(agentId: string): string {
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n- Current scaffold timestamp: 2026-05-30T10:00:00.000Z\n- Persistent agent id: ${agentId}\n- Lifecycle state: ready\n- Last checkpoint: cp_selected_maintenance_smoke\n- Last consolidation: absorb_selected_maintenance_smoke\n\n## Deep Memory\n\n### Collaboration\n\n- This selected room validates non-default maintenance targeting.\n- Selected Absorb consolidated durable insight into stable memory without touching the control room.\n\n### Maintenance Boundaries\n\n- Persistent-agent maintenance writes must target the route-selected room root.\n\n## Active Items\n\n### Current Focus\n\n- Prove selected Absorb and Structural Review write boundaries.\n- Review the selected room structural-review candidate after absorb.\n\n### Parked\n\n- Keep provider-dependent workflows out of this smoke.\n\n## Recent Context\n\n${ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n`;
}

const structuralCandidateReviewTarget = `## Deep Memory\n\n### Collaboration\n\n- This selected room validates non-default maintenance targeting and selected Absorb consolidated durable insight into stable memory.\n\n### Maintenance Boundaries\n\n- Persistent-agent maintenance writes must target the route-selected room root.\n\n## Active Items\n\n### Current Focus\n\n- Prove selected Absorb and Structural Review write boundaries.\n\n### Parked\n\n- Keep provider-dependent workflows out of this smoke.\n`;

function absorbProposal(agentId: string, sourceL1b = readText(path.join(tempAgentsRoot, agentId, "L1b", "current.md"))) {
	return {
		agentId,
		writesMemory: false,
		process: {
			type: ABSORB_CONSOLIDATION_WORKER_TYPE,
			model: { provider: "fixture-provider", model: "fixture-absorb", label: "Fixture Absorb" },
		},
		availability: { recentContextEntryCount: 5 },
		source: {
			l1bFingerprint: fingerprintL1bSource(sourceL1b),
			generatedAt: "2026-05-30T11:00:00.000Z",
		},
		fields: { candidateL1b: absorbCandidateL1b(agentId) },
		review: {
			keyMetrics: {
				recentContextEntriesBefore: 5,
				recentContextEntriesAfter: 0,
				stableMemoryDeltaBytes: 64,
				stableMemoryDeltaTokens: 16,
			},
		},
		absorbTelemetry: {
			l1bChars: sourceL1b.length,
			stableL1bChars: 100,
			recentContextChars: 200,
			recentContextEntryCount: 5,
			recentContextEntryIds: ["RC-0001", "RC-0002", "RC-0003", "RC-0004", "RC-0005"],
			promptChars: 300,
			promptEstimatedTokens: 75,
			sectionPurposeCount: 4,
		},
		absorbUsage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
	};
}

function structuralReviewProposal(agentId: string, sourceL1b = readText(path.join(tempAgentsRoot, agentId, "L1b", "current.md"))) {
	const parts = extractStructuralReviewSourceParts(sourceL1b);
	return {
		agentId,
		writesMemory: false,
		process: {
			type: STRUCTURAL_REVIEW_WORKER_TYPE,
			mode: STRUCTURAL_REVIEW_MODE,
			model: { provider: "fixture-provider", model: "fixture-structural-review", label: "Fixture Structural Review" },
		},
		source: {
			l1bFingerprint: fingerprintL1bSource(sourceL1b),
			reviewTargetFingerprint: fingerprintL1bSource(parts.sourceReviewTargetL1b),
			chronosFingerprint: fingerprintL1bSource(parts.preservedChronos),
			recentContextFingerprint: fingerprintL1bSource(parts.preservedRecentContext),
			generatedAt: "2026-05-30T12:00:00.000Z",
		},
		fields: {
			summary: "Tighten selected-room maintenance boundary signal.",
			candidateReviewTargetL1b: structuralCandidateReviewTarget,
		},
		review: {
			metrics: {
				reviewTargetWordsBefore: 60,
				reviewTargetWordsAfter: 45,
				reviewTargetEstimatedTokensBefore: 90,
				reviewTargetEstimatedTokensAfter: 70,
				reviewTargetEstimatedTokenDelta: -20,
			},
		},
		structuralReviewTelemetry: {
			chars: parts.sourceReviewTargetL1b.length,
			bytes: Buffer.byteLength(parts.sourceReviewTargetL1b, "utf-8"),
			words: 60,
			estimatedTokens: 90,
			memoryMap: [{ area: "Deep Memory", words: 30, estimatedTokens: 45 }],
			promptChars: 400,
			promptEstimatedTokens: 100,
			sectionDescriptionCount: 4,
		},
		structuralReviewUsage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
	};
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

	const beforeAbsorbMismatchSelected = snapshot(selectedRoot);
	expectThrows(
		() => parseAbsorbApprovalRequest({ proposal: { ...absorbProposal(agentId), agentId: controlAgentId } }, agentId),
		/proposal agentId does not match/i,
		"absorb proposal/route agentId mismatch should reject",
	);
	assertSnapshotUnchanged(selectedRoot, beforeAbsorbMismatchSelected, "absorb mismatch selected room");
	assertSnapshotUnchanged(controlRoot, controlBaseline, "absorb mismatch control room");

	const parsedAbsorb = parseAbsorbApprovalRequest({ proposal: absorbProposal(agentId) }, agentId);
	const absorbResult = writeApprovedAbsorb(parsedAbsorb.request, parsedAbsorb.warnings, new Date("2026-05-30T11:00:00.000Z"));
	const afterAbsorbSelected = snapshot(selectedRoot);
	assert(absorbResult.agentId === agentId, "absorb approval response should identify selected room");
	assert(afterAbsorbSelected.l1b !== selectedBaseline.l1b, "selected L1b/current.md should change after absorb approval");
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

	const beforeStructuralSnapshot = snapshot(selectedRoot);
	const structuralAvailability = getStructuralReviewAvailability(agentId);
	assert(structuralAvailability.available, "non-default structural-review availability should read selected L1b");
	assert(structuralAvailability.reviewTargetEstimatedTokens > 0, "non-default structural-review availability should compute selected review target");

	expectThrows(
		() => parseStructuralReviewApprovalRequest({ proposal: { ...structuralReviewProposal(agentId), agentId: controlAgentId } }, agentId),
		/proposal agentId does not match/i,
		"structural-review proposal/route agentId mismatch should reject",
	);
	assertSnapshotUnchanged(selectedRoot, beforeStructuralSnapshot, "structural-review mismatch selected room");
	assertSnapshotUnchanged(controlRoot, controlBaseline, "structural-review mismatch control room");

	const selectedRegistryBeforeStructural = registrySnapshot(selectedRoot);
	const defaultRegistryBeforeStructural = registrySnapshot(controlRoot);
	const parsedStructural = parseStructuralReviewApprovalRequest({ proposal: structuralReviewProposal(agentId) }, agentId);
	const structuralResult = writeApprovedStructuralReview(parsedStructural.request, parsedStructural.warnings, new Date("2026-05-30T12:00:00.000Z"));
	const afterStructuralSelected = snapshot(selectedRoot);
	assert(structuralResult.agentId === agentId, "structural-review approval response should identify selected room");
	assert(afterStructuralSelected.l1b !== beforeStructuralSnapshot.l1b, "selected L1b/current.md should change after structural review approval");
	assert(afterStructuralSelected.archiveCount === beforeStructuralSnapshot.archiveCount + 1, "selected archive count should increase after structural review approval");
	assert(afterStructuralSelected.structuralReviewEventCount === beforeStructuralSnapshot.structuralReviewEventCount + 1, "selected structural-review event count should increase");
	assert(structuralResult.eventRelPath, "structural-review approval response should carry eventRelPath");
	assert(structuralResult.eventRecordPath === path.join(selectedRoot, structuralResult.eventRelPath), "structural-review event response path should be selected-root relative");
	const structuralEvent = readJson(structuralResult.eventRecordPath);
	assert(structuralEvent.agentId === agentId, "selected structural-review event should record selected room id");
	assert(structuralEvent.archivedL1bPath == null, "selected structural-review event should not persist top-level archive path");
	assert(structuralEvent.updatedL1bPath == null, "selected structural-review event should not persist top-level updated L1b path");
	assert(isRelativePath(structuralEvent.paths?.archivedL1bRelPath), "selected structural-review event archive path should be relative");
	assert(structuralEvent.paths?.updatedL1bRelPath === "L1b/current.md", "selected structural-review event updated path should be selected-root relative");
	assert(structuralEvent.paths?.eventRelPath === structuralResult.eventRelPath, "selected structural-review event path should be selected-root relative");
	const serializedStructuralEvent = JSON.stringify(structuralEvent);
	assert(!serializedStructuralEvent.includes(tempAgentsRoot), "selected structural-review event JSON must not include temp root");
	assert(!serializedStructuralEvent.includes(selectedRoot), "selected structural-review event JSON must not include selected absolute root");
	assert(!serializedStructuralEvent.includes(controlRoot), "selected structural-review event JSON must not include default absolute root");
	const selectedRegistryAfterStructural = registrySnapshot(selectedRoot);
	const defaultRegistryAfterStructural = registrySnapshot(controlRoot);
	assert(selectedRegistryAfterStructural.content === selectedRegistryBeforeStructural.content, "selected section_registry.json content should remain unchanged by structural review");
	assert(selectedRegistryAfterStructural.mtimeMs === selectedRegistryBeforeStructural.mtimeMs, "selected section_registry.json timestamp should remain unchanged by structural review");
	assert(defaultRegistryAfterStructural.content === defaultRegistryBeforeStructural.content, "default section_registry.json content should remain unchanged by structural review");
	assert(defaultRegistryAfterStructural.mtimeMs === defaultRegistryBeforeStructural.mtimeMs, "default section_registry.json timestamp should remain unchanged by structural review");
	assertSnapshotUnchanged(controlRoot, controlBaseline, "selected structural-review control room");

	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("persistent-agent non-default maintenance smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
}
