import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-checkpoint-event-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-checkpoint-event-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	buildPersistentAgentCheckpointTranscriptSource,
	fingerprintL1bSource,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const agentId = "checkpoint-event-smoke-room";
const { CHECKPOINT_COMPRESSION_WORKER_TYPE } = await import("../src/checkpoint-compression.js");

const agentRoot = path.join(root, agentId);
const l1bPath = path.join(agentRoot, "L1b", "current.md");
const archiveDir = path.join(agentRoot, "L1b", "archive");
const checkpointEventDir = path.join(agentRoot, "events", "checkpoint");

const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const APPROVED_RC_SENTINEL = "UNIQUE_APPROVED_RC_BODY_SENTINEL_MUST_NOT_APPEAR_IN_EVENT";
const PROPOSED_RC_SENTINEL = "UNIQUE_PROPOSED_RC_BODY_SENTINEL_MUST_NOT_APPEAR_IN_EVENT";
const TRANSCRIPT_SENTINEL = "UNIQUE_TRANSCRIPT_SENTINEL_MUST_NOT_APPEAR_IN_EVENT";
const L1B_BODY_SENTINEL = "UNIQUE_L1B_BODY_SENTINEL_MUST_NOT_APPEAR_IN_EVENT";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function archiveCount(): number {
	return fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((name) => name.endsWith(".md")).length : 0;
}

function checkpointEventCount(): number {
	return fs.existsSync(checkpointEventDir) ? fs.readdirSync(checkpointEventDir).filter((name) => name.endsWith(".json")).length : 0;
}

function sourceL1b(): string {
	return `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Current scaffold timestamp: 2026-05-27T10:00:00.000Z
- Persistent agent id: checkpoint-event-smoke-room
- Lifecycle state: ready
- Last checkpoint: none
- Last consolidation: none

## Deep Memory

- ${L1B_BODY_SENTINEL}
- Synthetic user is validating checkpoint lifecycle sidecar telemetry.

## Active Items

- Keep MR6a focused on checkpoint sidecar events only.

## Recent Context

No checkpointed sessions yet.
`;
}

function approvedRecentContext(): string {
	return `### RC-DRAFT | CLOSED | 2026-05-27 | Checkpoint event smoke

**Session arc:** A short smoke session validates checkpoint sidecar event creation.

**Body:**
- ${APPROVED_RC_SENTINEL}
- Approved checkpoint event smoke signal should be durable in L1b but redacted from event JSON.

**Parked:**
None
`;
}

function proposedRecentContext(): string {
	return `### RC-DRAFT | OPEN | 2026-05-27 | Proposed checkpoint event smoke

**Session arc:** Proposed checkpoint sidecar event smoke draft.

**Body:**
- ${PROPOSED_RC_SENTINEL}

**Parked:**
Continue validating MR6a checkpoint telemetry.
`;
}

function checkpointSource(conversationId: string) {
	writePersistentAgentThread(agentId, conversationId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "u1", text: TRANSCRIPT_SENTINEL }],
	});
	return buildPersistentAgentCheckpointTranscriptSource({
		agentId: agentId,
		conversationId,
		l1b: readL1b(),
		legacyItems: [{ kind: "user", id: "u1", text: TRANSCRIPT_SENTINEL }],
	}).source;
}

function acceptedRequest(conversationId: string) {
	return parseCheckpointApprovalRequest({
		conversationId,
		model,
		density: "standard",
		proposal: {
			agentId: agentId,
			conversationId,
			sessionId: null,
			writesMemory: false,
			density: "standard",
			source: checkpointSource(conversationId),
			proposedRecentContext: proposedRecentContext(),
			transcriptSentinel: TRANSCRIPT_SENTINEL,
		},
		approvedRecentContext: approvedRecentContext(),
	}, agentId);
}

function invalidRequest(conversationId: string) {
	return parseCheckpointApprovalRequest({
		conversationId,
		model,
		density: "standard",
		proposal: {
			agentId: agentId,
			conversationId,
			sessionId: null,
			writesMemory: false,
			source: checkpointSource(conversationId),
		},
		// A part marker typed after the page's own: the one-string form cannot tell the parts apart.
		approvedRecentContext: `${approvedRecentContext()}\n**Parked:**\nTyped again.\n`,
	}, agentId);
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

function isRelativePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.startsWith("..");
}

function assertFingerprint(raw: any, label: string): void {
	assert(raw?.algorithm === "sha256", `${label} should use sha256`);
	assert(/^[a-f0-9]{64}$/i.test(String(raw?.value ?? "")), `${label} should contain a sha256 value`);
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Checkpoint Event Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
	assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");
	assert(archiveCount() === 0, "fresh scaffold should have no archives");
	assert(checkpointEventCount() === 0, "fresh scaffold should have no checkpoint event records");

	const conversationId = "c_checkpoint_event_smoke";
	const sourceBeforeApproval = readL1b();
	const parsed = acceptedRequest(conversationId);
	const result = writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-05-27T20:00:00.000Z"));
	const updatedL1b = readL1b();

	assert(result.writesMemory === true, "checkpoint approval should report memory write");
	assert(typeof result.eventRecordPath === "string" && result.eventRecordPath.length > 0, "checkpoint approval should return eventRecordPath");
	assert(result.eventRelPath === `events/checkpoint/${result.checkpointId}.json`, "checkpoint approval should return canonical relative event path");
	assert(result.eventRecordPath === path.join(checkpointEventDir, `${result.checkpointId}.json`), "checkpoint approval should return canonical event path");
	assert(fs.existsSync(result.eventRecordPath), "checkpoint event record should exist");
	assert(fs.existsSync(path.join(agentRoot, result.eventRelPath)), "checkpoint event should exist at returned relative path");
	assert(archiveCount() === 1, "checkpoint approval should archive previous L1b");
	assert(checkpointEventCount() === 1, "checkpoint approval should create one event record");
	assert(fs.readFileSync(result.archivedL1bPath, "utf-8") === sourceBeforeApproval, "archive should contain pre-checkpoint L1b");

	const eventRecord = JSON.parse(fs.readFileSync(result.eventRecordPath, "utf-8"));
	assert(eventRecord.schemaVersion === 1, "event should use schema version 1");
	assert(eventRecord.operation === "checkpoint", "event should identify checkpoint operation");
	assert(eventRecord.mutation?.target === "l1b", "event mutation should target L1b");
	assert(eventRecord.mutation?.kind === "recent_context_append", "event mutation should identify Recent Context append");
	assert(Array.isArray(eventRecord.mutation.sectionsAffected), "event should include affected sections");
	assert(eventRecord.mutation.sectionsAffected.includes("Recent Context"), "event should mark Recent Context affected");
	assert(eventRecord.mutation.sectionsAffected.includes("Chronos"), "event should mark Chronos affected");
	assert(eventRecord.mutation.sectionsPreserved.includes("Deep Memory"), "event should mark Deep Memory preserved");
	assert(eventRecord.mutation.sectionsPreserved.includes("Active Items"), "event should mark Active Items preserved");
	assert(eventRecord.agentId === agentId, "event should include agent id");
	assert(eventRecord.conversationId === conversationId, "event should include conversation id");
	assert(eventRecord.sessionId === result.sessionId, "event should match response session id");
	assert(eventRecord.checkpointId === result.checkpointId, "event should match response checkpoint id");
	assert(eventRecord.recentContextId === "RC-0001", "event should include created Recent Context id");
	assert(eventRecord.approvedAt === "2026-05-27T20:00:00.000Z", "event should include approval timestamp");

	assert(eventRecord.process?.type === CHECKPOINT_COMPRESSION_WORKER_TYPE, "event should include checkpoint worker type");
	assert(eventRecord.process?.density === "standard", "event should include checkpoint density");
	assert(eventRecord.process?.model?.provider === "openai-compatible", "event should include process model provider");
	assert(eventRecord.process?.model?.model === "gpt-5.5", "event should include process model id");

	assert(isRelativePath(eventRecord.paths?.archivedL1bRelPath), "archive path in event should be relative");
	assert(isRelativePath(eventRecord.paths?.updatedL1bRelPath), "updated L1b path in event should be relative");
	assert(isRelativePath(eventRecord.paths?.eventRelPath), "event path in event should be relative");
	assert(eventRecord.paths.archivedL1bRelPath === path.relative(agentRoot, result.archivedL1bPath).split(path.sep).join("/"), "event archive path should be agent-root relative");
	assert(eventRecord.paths.updatedL1bRelPath === "L1b/current.md", "event updated L1b path should be agent-root relative");
	assert(eventRecord.paths.eventRelPath === result.eventRelPath, "event relative path should match response relative path");

	assertFingerprint(eventRecord.source?.l1bFingerprint, "source L1b fingerprint");
	assertFingerprint(eventRecord.result?.l1bFingerprint, "result L1b fingerprint");
	assert(eventRecord.source.l1bFingerprint.value === fingerprintL1bSource(sourceBeforeApproval.trimEnd() + "\n").value, "event should capture source L1b fingerprint");
	assert(eventRecord.result.l1bFingerprint.value === fingerprintL1bSource(updatedL1b.trimEnd() + "\n").value, "event should capture result L1b fingerprint");
	assert(eventRecord.source.bytes === Buffer.byteLength(sourceBeforeApproval.trimEnd() + "\n", "utf-8"), "event should capture source bytes");
	assert(eventRecord.result.bytes === Buffer.byteLength(updatedL1b.trimEnd() + "\n", "utf-8"), "event should capture result bytes");
	assert(eventRecord.source.estimatedTokens > 0, "event should capture source token estimate");
	assert(eventRecord.result.estimatedTokens > 0, "event should capture result token estimate");
	assert(eventRecord.source.recentContextEntryCount === 0, "event should capture source RC count");
	assert(eventRecord.result.recentContextEntryCount === 1, "event should capture result RC count");
	assert(eventRecord.source.sections?.recentContext?.entryCount === 0, "event should capture source RC section count");
	assert(eventRecord.result.sections?.recentContext?.entryCount === 1, "event should capture result RC section count");
	const sourceSectionTitles = eventRecord.source.sections.topLevel.map((section: { title: string }) => section.title);
	const resultSectionTitles = eventRecord.result.sections.topLevel.map((section: { title: string }) => section.title);
	assert(["Chronos", "Deep Memory", "Active Items", "Recent Context"].every((title) => sourceSectionTitles.includes(title)), "event should capture source top-level section metrics");
	assert(["Chronos", "Deep Memory", "Active Items", "Recent Context"].every((title) => resultSectionTitles.includes(title)), "event should capture result top-level section metrics");

	assert(eventRecord.checkpoint?.recentContextEntryCountBefore === 0, "event should capture checkpoint RC count before");
	assert(eventRecord.checkpoint?.recentContextEntryCountAfter === 1, "event should capture checkpoint RC count after");
	assert(eventRecord.checkpoint?.approvedEntry?.chars > 0, "event should capture approved entry chars");
	assert(eventRecord.checkpoint.approvedEntry.bytes > 0, "event should capture approved entry bytes");
	assert(eventRecord.checkpoint.approvedEntry.estimatedTokens > 0, "event should capture approved entry tokens");
	assert(eventRecord.checkpoint.approvedEntry.status === "CLOSED", "event should capture approved entry status");
	assertFingerprint(eventRecord.checkpoint.approvedEntry.hash, "approved entry hash");
	assert(eventRecord.checkpoint?.proposedEntry?.chars > 0, "event should capture proposed entry chars");
	assert(eventRecord.checkpoint.proposedEntry.bytes > 0, "event should capture proposed entry bytes");
	assert(eventRecord.checkpoint.proposedEntry.estimatedTokens > 0, "event should capture proposed entry tokens");
	assertFingerprint(eventRecord.checkpoint.proposedEntry.hash, "proposed entry hash");
	assert(eventRecord.validation?.valid === true, "event should capture validation success");
	assert(Array.isArray(eventRecord.validation?.warnings), "event should capture validation warnings");
	assert(Array.isArray(eventRecord.validation?.errors), "event should capture validation errors array");
	assert(Array.isArray(eventRecord.warnings), "event should include top-level warnings array");

	const serializedEvent = JSON.stringify(eventRecord);
	assert(!serializedEvent.includes(root), "event JSON should not include temp absolute root");
	assert(!serializedEvent.includes(agentRoot), "event JSON should not include temp absolute agent root");
	assert(!serializedEvent.includes(APPROVED_RC_SENTINEL), "event JSON should not include raw approved Recent Context sentinel");
	assert(!serializedEvent.includes(PROPOSED_RC_SENTINEL), "event JSON should not include raw proposed Recent Context sentinel");
	assert(!serializedEvent.includes(TRANSCRIPT_SENTINEL), "event JSON should not include raw transcript sentinel");
	assert(!serializedEvent.includes(L1B_BODY_SENTINEL), "event JSON should not include raw L1b body sentinel");

	const archiveCountBeforeInvalid = archiveCount();
	const eventCountBeforeInvalid = checkpointEventCount();
	expectThrows(
		() => invalidRequest("c_checkpoint_event_invalid"),
		/Reload the page, then save again/,
		"invalid approved Recent Context should reject before write",
	);
	assert(archiveCount() === archiveCountBeforeInvalid, "invalid checkpoint should not create archive");
	assert(checkpointEventCount() === eventCountBeforeInvalid, "invalid checkpoint should not create event record");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("checkpoint event smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
