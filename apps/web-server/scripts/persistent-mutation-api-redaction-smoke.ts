import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-mutation-api-redaction-"));
const tempHome = path.join(tempRoot, "home");
const persistentAgentsRoot = path.join(tempRoot, "persistent-agents");
fs.mkdirSync(tempHome, { recursive: true });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = persistentAgentsRoot;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");

const {
	createPersistentAgentFromScaffoldInput,
	buildPersistentAgentCheckpointTranscriptSource,
	fingerprintL1bSource,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const agentId = "mutation-redaction-smoke-room";
const { ABSORB_CONSOLIDATION_WORKER_TYPE, ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER } = await import("../src/absorb-consolidation.js");

const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const agentRoot = path.join(persistentAgentsRoot, agentId);
const l1bPath = path.join(agentRoot, "L1b", "current.md");
const port = 23000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function writeL1b(body: string): void {
	fs.writeFileSync(l1bPath, body.trimEnd() + "\n", "utf-8");
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function checkpointSourceL1b(): string {
	return `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Current scaffold timestamp: 2026-05-30T10:00:00.000Z
- Persistent agent id: mutation-redaction-smoke-room
- Lifecycle state: ready
- Last checkpoint: none
- Last consolidation: none

## Deep Memory

- Route-level approval response redaction should preserve internal writes.

## Active Items

- Validate browser-safe checkpoint approval responses.

## Recent Context

No checkpointed sessions yet.
`;
}

function checkpointApprovalBody() {
	const conversationId = "c_api_redaction_checkpoint";
	const transcriptItem = { kind: "user", id: "api-redaction-user", text: "API redaction checkpoint source." };
	writePersistentAgentThread(agentId, conversationId, {
		state: "active",
		origin: "home",
		model,
		items: [transcriptItem],
	});
	const source = buildPersistentAgentCheckpointTranscriptSource({
		agentId: agentId,
		conversationId,
		l1b: readL1b(),
		legacyItems: [transcriptItem],
	}).source;
	return {
		conversationId,
		model,
		density: "standard",
		proposal: {
			agentId: agentId,
			conversationId,
			sessionId: null,
			writesMemory: false,
			density: "standard",
			source,
			proposedRecentContext: `### RC-DRAFT | CLOSED | 2026-05-30 | API redaction checkpoint\n\n**Session arc:** Validate API response redaction.\n\n**Body:**\n- Proposed checkpoint signal.\n\n**Parked:**\nNone\n`,
		},
		approvedRecentContext: `### RC-DRAFT | CLOSED | 2026-05-30 | API redaction checkpoint\n\n**Session arc:** Validate API response redaction.\n\n**Body:**\n- Approved checkpoint signal.\n\n**Parked:**\nNone\n`,
	};
}

function absorbRcEntry(index: number): string {
	return `### RC-${String(index).padStart(4, "0")} | OPEN | 2026-05-30 | API redaction absorb ${index}\n\n**Session arc:** Absorb redaction session ${index}.\n\n**Body:**\n- Durable signal ${index} should be consolidated.\n\n**Parked:**\nNone\n`;
}

function absorbSourceL1b(): string {
	const entries = Array.from({ length: 5 }, (_, index) => absorbRcEntry(index + 1)).join("\n");
	return `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Current scaffold timestamp: 2026-05-30T11:00:00.000Z
- Persistent agent id: mutation-redaction-smoke-room
- Lifecycle state: ready
- Last checkpoint: cp_api_redaction
- Last consolidation: none

## Deep Memory

- API redaction smoke source memory.

## Active Items

- Validate browser-safe absorb approval responses.

## Recent Context

${entries}
`;
}

function absorbCandidateL1b(): string {
	return `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Current scaffold timestamp: 2026-05-30T11:00:00.000Z
- Persistent agent id: mutation-redaction-smoke-room
- Lifecycle state: ready
- Last checkpoint: cp_api_redaction
- Last consolidation: none

## Deep Memory

- API redaction smoke source memory.
- Absorb approval consolidated the five temporary Recent Context entries.

## Active Items

- Validate browser-safe absorb approval responses.

## Recent Context

${ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}
`;
}

function absorbApprovalBody(sourceL1b: string) {
	return {
		proposal: {
			agentId: agentId,
			writesMemory: false,
			process: {
				type: ABSORB_CONSOLIDATION_WORKER_TYPE,
				model: { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5" },
			},
			availability: { recentContextEntryCount: 5 },
			source: {
				l1bFingerprint: fingerprintL1bSource(sourceL1b),
				generatedAt: "2026-05-30T11:30:00.000Z",
			},
			fields: { candidateL1b: absorbCandidateL1b() },
			review: {
				keyMetrics: {
					recentContextEntriesBefore: 5,
					recentContextEntriesAfter: 0,
					stableMemoryDeltaBytes: 100,
					stableMemoryDeltaTokens: 25,
				},
			},
		},
		approvedCandidateL1b: absorbCandidateL1b(),
	};
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 15000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

/** A route that is expected to refuse: the status is the assertion, and the body carries the sentence. */
async function postJsonExpectingStatus(pathname: string, body: unknown, status: number): Promise<any> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status !== status) throw new Error(`${pathname} should have answered ${status}, got ${response.status}: ${text}`);
	return text ? JSON.parse(text) : null;
}

async function postJson(pathname: string, body: unknown): Promise<any> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${pathname} failed with ${response.status}: ${text}`);
	return JSON.parse(text);
}

function assertBrowserSafeApprovalResponse(label: string, response: any, expectedEventPrefix: string): void {
	const serialized = JSON.stringify(response);
	for (const key of ["archivedL1bPath", "updatedL1bPath", "eventRecordPath"]) {
		assert(!(key in response), `${label} response should omit ${key}`);
		assert(!serialized.includes(key), `${label} response JSON should not include ${key}`);
	}
	for (const unsafePath of [tempRoot, tempHome, persistentAgentsRoot, agentRoot]) {
		assert(!serialized.includes(unsafePath), `${label} response JSON should not include local absolute path ${unsafePath}`);
	}
	assert(typeof response.eventRelPath === "string" && response.eventRelPath.startsWith(expectedEventPrefix), `${label} response should include canonical eventRelPath`);
	assert(!path.isAbsolute(response.eventRelPath), `${label} eventRelPath should be relative`);
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Mutation Redaction Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: persistentAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	writeL1b(checkpointSourceL1b());
	const checkpointResponse = await postJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/checkpoint/approve`, checkpointApprovalBody());
	assert(checkpointResponse.writesMemory === true, "checkpoint response should report memory write");
	assert(checkpointResponse.agentId === agentId, "checkpoint response should include agent id");
	assert(checkpointResponse.conversationId === "c_api_redaction_checkpoint", "checkpoint response should include conversation id");
	assertBrowserSafeApprovalResponse("checkpoint", checkpointResponse, "events/checkpoint/");

	// Memorize is a RUN now (memory v2): its approval names the run the server
	// built and folded, never a whole memory the client hands back. The retired
	// body is refused here rather than dropped, because a client that still
	// sends it must be told what to do instead of having its memory rewritten
	// from something the server never produced. The browser-safety of the run's
	// own approval response is pinned by absorb-run-route-smoke, which drives
	// the route that exists.
	writeL1b(absorbSourceL1b());
	const sourceAbsorbL1b = readL1b();
	const retiredAbsorb = await postJsonExpectingStatus(`/api/persistent-agents/${encodeURIComponent(agentId)}/absorb/approve`, absorbApprovalBody(sourceAbsorbL1b), 400);
	assert(/runId is required/.test(String(retiredAbsorb?.error ?? "")), `the retired whole-document approval should be refused with what to do instead, got ${JSON.stringify(retiredAbsorb)}`);
	assert(readL1b() === sourceAbsorbL1b, "a refused approval writes nothing");

	// Review is a RUN now too, and the route that took a whole rewritten memory
	// from the client is gone rather than retired: a client that still posts one
	// meets a 404 and writes nothing. The browser-safety of the run's own
	// approval response is pinned by review-run-route-smoke.
	const beforeRetiredReview = readL1b();
	await postJsonExpectingStatus(`/api/persistent-agents/${encodeURIComponent(agentId)}/structural-review/approve`, { proposal: { agentId } }, 404);
	assert(readL1b() === beforeRetiredReview, "a route that no longer exists writes nothing");

	console.log("persistent mutation API redaction smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-40).join("\n"));
	console.error(error);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
}
