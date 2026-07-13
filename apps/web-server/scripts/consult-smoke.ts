import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-consult-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-consult-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	buildConsultAnswer,
	createPersistentAgentFromScaffoldInput,
	fingerprintL1bSource,
	persistentAgentPlatformKernel,
} = await import("../src/persistent-agents.js");
const {
	buildConsultPrompt,
	CONSULT_QUESTION_MAX_CHARS,
	CONSULT_WORKER_TYPE,
	ConsultPromptOverflowError,
	consultEnvelope,
} = await import("../src/consult.js");
const { getConsultModelLock } = await import("../src/persistent-agent-ai-profiles.js");

const CONSULT_MODEL = getConsultModelLock("openai-compatible");

const targetAgentId = "consult-smoke-euler";
const askerAgentId = "consult-smoke-asker";
const targetRoot = path.join(root, targetAgentId);
const askerRoot = path.join(root, askerAgentId);
const DISTINCTIVE_MEMORY = "The pricing model decision is X-42, locked on 2026-05-18.";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function expectError(run: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
	try {
		await run();
	} catch (error) {
		assert(pattern.test((error as Error).message), `${message} (got: ${(error as Error).message})`);
		return;
	}
	throw new Error(message);
}

// Recursive byte-level snapshot of a room directory: relative path -> sha256.
function snapshotTree(dir: string): Map<string, string> {
	const entries = new Map<string, string>();
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else entries.set(path.relative(dir, full), crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
		}
	};
	walk(dir);
	return entries;
}

function assertTreesIdentical(before: Map<string, string>, after: Map<string, string>, label: string): void {
	assert(before.size === after.size, `${label}: file count changed (${before.size} -> ${after.size})`);
	for (const [rel, hash] of before) {
		assert(after.get(rel) === hash, `${label}: file changed or missing after consult: ${rel}`);
	}
}

try {
	createPersistentAgentFromScaffoldInput({ displayName: "Consult Smoke Euler", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	createPersistentAgentFromScaffoldInput({ displayName: "Consult Smoke Asker", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const targetL1bPath = path.join(targetRoot, "L1b", "current.md");
	assert(fs.existsSync(targetL1bPath), "scaffold should create target L1b/current.md");

	// Seed the target's memory with content the consult must answer from.
	fs.writeFileSync(targetL1bPath, fs.readFileSync(targetL1bPath, "utf-8").replace(/^## Deep Memory\s*$/m, `## Deep Memory\n\n- ${DISTINCTIVE_MEMORY}`), "utf-8");
	const targetL1b = fs.readFileSync(targetL1bPath, "utf-8");

	// --- Prompt assembly unit checks ---
	const l0 = persistentAgentPlatformKernel();
	const targetL1a = fs.readFileSync(path.join(targetRoot, "L1a.md"), "utf-8");
	const assembly = buildConsultPrompt({
		targetAgentId,
		targetDisplayName: "Consult Smoke Euler",
		fromRoomDisplayName: "Consult Smoke Asker",
		question: "What did we decide about the pricing model?",
		l0,
		l1a: targetL1a,
		l1b: targetL1b,
		model: CONSULT_MODEL,
	});
	assert(assembly.prompt.includes(l0.trim().slice(0, 80)), "consult prompt should start from the platform kernel (L0)");
	assert(assembly.prompt.includes("# Consult Smoke Euler Constitution"), "consult prompt should include the target's L1a constitution");
	assert(assembly.prompt.includes(DISTINCTIVE_MEMORY), "consult prompt should include the target's L1b memory");
	assert(assembly.prompt.includes("# Consult Envelope"), "consult prompt should include the consult envelope");
	assert(!assembly.prompt.includes("Session Runtime Envelope"), "consult prompt must not include the normal L2 session envelope");
	assert(assembly.prompt.includes("Writes memory: false"), "consult envelope should declare writes-memory false");
	assert(assembly.prompt.includes("leaves no trace in your room"), "consult envelope should declare the no-trace property");
	assert(assembly.prompt.includes("Asked from room Consult Smoke Asker."), "consult prompt should attribute the asking room");
	assert(assembly.prompt.includes("What did we decide about the pricing model?"), "consult prompt should include the question");
	assert(assembly.telemetry.promptEstimatedTokens > 0, "consult telemetry should estimate prompt tokens");

	const envelope = consultEnvelope({ targetDisplayName: "Euler", model: CONSULT_MODEL, now: new Date("2026-07-07T18:00:00Z") });
	assert(envelope.includes(`Process type: ${CONSULT_WORKER_TYPE}`), "envelope should carry the worker type");
	assert(envelope.includes("from the local user"), "envelope without a from-room should attribute the local user");

	// Overflow guard: refuses with guidance instead of eliding memory.
	try {
		buildConsultPrompt({ targetAgentId, targetDisplayName: "Euler", question: "q", l0, l1a: targetL1a, l1b: targetL1b, model: CONSULT_MODEL, promptTokenBudget: 10 });
		throw new Error("tiny prompt budget should overflow");
	} catch (error) {
		assert(error instanceof ConsultPromptOverflowError, "overflow should raise ConsultPromptOverflowError");
		assert((error as any).statusCode === 413, "overflow error should carry HTTP 413");
		assert(/run Review Memory/.test((error as Error).message), "overflow guidance should point at Review Memory");
	}

	// --- Orchestration: the consult answers from memory and leaves no trace ---
	const targetBefore = snapshotTree(targetRoot);
	const askerBefore = snapshotTree(askerRoot);

	const response = await buildConsultAnswer(
		{ targetAgentId, fromRoomId: askerAgentId, question: "What did we decide about the pricing model?" },
		CONSULT_MODEL,
		async (prompt, model) => {
			assert(prompt.includes(DISTINCTIVE_MEMORY), "worker prompt should carry the target's memory");
			assert(prompt.includes("# Consult Envelope"), "worker prompt should carry the consult envelope");
			assert(model.provider === CONSULT_MODEL.provider && model.model === CONSULT_MODEL.model, "consult should use the profile consult model lock");
			return { text: "From my memory: the pricing model decision was X-42, locked on 2026-05-18.", usage: { input: 10, output: 20, totalTokens: 30, cost: 0 } };
		},
	);
	assert(response.writesMemory === false, "consult response must be non-mutating");
	assert(response.process.type === "consult-worker", "consult response should identify the worker type");
	assert(response.target.displayName === "Consult Smoke Euler", "consult response should carry the target display name");
	assert(response.source.l1bFingerprint.value === fingerprintL1bSource(targetL1b).value, "consult response should fingerprint the exact L1b it answered from");
	assert(response.answerMarkdown.includes("X-42"), "consult response should carry the worker answer");
	assert(response.warnings.includes("no memory has been written"), "consult response should warn no memory was written");
	assert(response.warnings.some((warning: string) => /no trace/.test(warning)), "consult response should state the no-trace property");

	assertTreesIdentical(targetBefore, snapshotTree(targetRoot), "target room");
	assertTreesIdentical(askerBefore, snapshotTree(askerRoot), "asking room");

	// Overflow wire (MR-2): resolveModelWindow arms the same guard through
	// buildConsultAnswer — refusal happens before the worker ever runs.
	let overflowGenerateCalls = 0;
	await expectError(
		() =>
			buildConsultAnswer(
				{ targetAgentId, question: "q".repeat(3000) },
				CONSULT_MODEL,
				async () => {
					overflowGenerateCalls++;
					return { text: "x" };
				},
				{ resolveModelWindow: () => ({ contextWindow: 40, maxOutputTokens: 1_000 }) },
			),
		/too large for the locked consult model/,
		"a tiny model window should overflow through buildConsultAnswer",
	);
	assert(overflowGenerateCalls === 0, "overflow must refuse before the worker runs");
	// A window without metadata (NaN) must not arm the guard.
	const unguardedResponse = await buildConsultAnswer(
		{ targetAgentId, question: "q" },
		CONSULT_MODEL,
		async () => ({ text: "unguarded ok" }),
		{ resolveModelWindow: () => ({ contextWindow: Number.NaN, maxOutputTokens: Number.NaN }) },
	);
	assert(unguardedResponse.answerMarkdown === "unguarded ok", "non-finite window metadata should leave the consult unguarded, not broken");

	// needs_absorb rooms stay consultable, with a lag warning.
	const laggingResponse = await buildConsultAnswer(
		{ targetAgentId, question: "Anything on pricing?", targetLifecycleStatus: "needs_absorb" },
		CONSULT_MODEL,
		async () => ({ text: "Yes: X-42." }),
	);
	assert(laggingResponse.warnings.some((warning: string) => /awaiting Learn/.test(warning)), "needs_absorb consult should warn that stable memory may lag");

	// --- Rejections ---
	await expectError(() => buildConsultAnswer({ targetAgentId, question: "" }, CONSULT_MODEL, async () => ({ text: "x" })), /question is required/, "empty question should be rejected");
	await expectError(
		() => buildConsultAnswer({ targetAgentId, question: "q".repeat(CONSULT_QUESTION_MAX_CHARS + 1) }, CONSULT_MODEL, async () => ({ text: "x" })),
		/question is too long/,
		"over-cap question should be rejected",
	);
	await expectError(
		() => buildConsultAnswer({ targetAgentId, fromRoomId: targetAgentId, question: "q" }, CONSULT_MODEL, async () => ({ text: "x" })),
		/cannot consult itself/,
		"self-consult should be rejected",
	);
	await expectError(
		() => buildConsultAnswer({ targetAgentId: "consult-smoke-missing", question: "q" }, CONSULT_MODEL, async () => ({ text: "x" })),
		/agent\.json is missing/,
		"consulting a missing room should be rejected",
	);
	await expectError(() => buildConsultAnswer({ targetAgentId, question: "q" }, CONSULT_MODEL, async () => ({ text: "   " })), /produced no text/, "empty worker output should be rejected");

	// Stacked-consult trust boundary (§8.1/§8.6 + hardening 2026-07-11): the wire
	// caps are enforced BEFORE the worker runs — 20-exchange backstop (20 priors
	// would make a 21st exchange), per-question length, junk shapes.
	const prior = { question: "earlier q", answerMarkdown: "earlier a" };
	await expectError(
		() => buildConsultAnswer({ targetAgentId, question: "q", priorExchanges: Array.from({ length: 20 }, () => prior) }, CONSULT_MODEL, async () => ({ text: "x" })),
		/stack cap/,
		"20 prior exchanges (a 21st ask) should be rejected at the boundary",
	);
	await expectError(
		() => buildConsultAnswer({ targetAgentId, question: "q", priorExchanges: [{ question: "Q".repeat(CONSULT_QUESTION_MAX_CHARS + 1), answerMarkdown: "a" }] }, CONSULT_MODEL, async () => ({ text: "x" })),
		/too long/,
		"an over-length prior question should be rejected at the boundary",
	);
	await expectError(
		() => buildConsultAnswer({ targetAgentId, question: "q", priorExchanges: "junk" }, CONSULT_MODEL, async () => ({ text: "x" })),
		/must be an array/,
		"non-array priorExchanges should be rejected at the boundary",
	);
	// 19 priors (the 20th exchange) is legal and reaches the worker.
	const stackedOk = await buildConsultAnswer(
		{ targetAgentId, question: "q", priorExchanges: Array.from({ length: 19 }, () => prior) },
		CONSULT_MODEL,
		async (prompt) => {
			if (!prompt.includes("## Prior exchanges in this consult")) throw new Error("prior exchanges missing from the worker prompt");
			return { text: "stacked ok" };
		},
	);
	if (stackedOk.answerMarkdown !== "stacked ok") throw new Error("stacked consult should reach the worker with 19 priors");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("consult smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
