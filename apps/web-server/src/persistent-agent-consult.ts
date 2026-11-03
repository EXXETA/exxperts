import fs from "node:fs";
import { CONSULT_WORKER_TYPE, type ConsultPromptTelemetry, type ConsultPriorExchange, CONSULT_MAX_STACK_EXCHANGES, CONSULT_PRIOR_ANSWER_BOUNDARY_MAX_CHARS, CONSULT_QUESTION_MAX_CHARS, buildConsultPrompt } from "./consult.js";
import { composePersistentRoomInstructions, buildPersistentRoomInstructionsLayer } from "./persistent-room-instructions.js";
import { fingerprintL1bSource, type PersistentAgentId } from "./persistent-agent-types.js";
import type { CheckpointModelWindow, L1bSourceFingerprint } from "./persistent-agent-memory-types.js";
import { createPersistentAgentInstance, PERSISTENT_AGENTS_ROOT, validatePersistentAgentId } from "./persistent-agent-store.js";
import { persistentAgentPlatformKernel } from "./persistent-agent-constitution.js";
import { checkpointPromptTokenBudget, persistentAgentBootInstructionsParts } from "./persistent-agent-boot.js";
import { maintenanceDiagnosticsRecorder, refuseTruncatedWorkerOutput } from "./persistent-agent-maintenance-worker.js";

export interface ConsultGenerateResult {
	text: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: number };
	/** True when the provider cut the response at its output-token ceiling. */
	truncated?: boolean;
	/** The worker model's declared output-token ceiling, when known. */
	modelMaxOutputTokens?: number;
}

export type ConsultModelLock = { provider: string; model: string; label?: string };

export interface ConsultAnswerOptions {
	/**
	 * When provided, the consult prompt is checked against the locked model's
	 * window (same budget formula as the checkpoint worker) and overflow raises
	 * ConsultPromptOverflowError instead of sending an elided prompt.
	 */
	resolveModelWindow?: (model: ConsultModelLock) => CheckpointModelWindow;
}

export interface ConsultAnswerResponse {
	targetAgentId: PersistentAgentId;
	writesMemory: false;
	process: { type: typeof CONSULT_WORKER_TYPE; model: ConsultModelLock };
	target: { displayName: string };
	source: { l1bFingerprint: L1bSourceFingerprint; generatedAt: string };
	answerMarkdown: string;
	consultTelemetry: ConsultPromptTelemetry;
	consultUsage?: ConsultGenerateResult["usage"];
	warnings: string[];
}

/**
 * Strict validation for the stacked-consult `priorExchanges` wire field (§8.1,
 * §8.6). The server stays stateless — the client holds the history — so this is
 * the trust boundary: reject junk, enforce the 20-exchange backstop cap, and the
 * per-question length limit. A follow-up carries N-1 prior exchanges, so a 20th
 * prior would make a 21st exchange; that (and above) is rejected. Returns [] for
 * an absent field (single-shot consult).
 */
export function normalizeConsultPriorExchanges(raw: unknown): ConsultPriorExchange[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) throw new Error("priorExchanges must be an array");
	if (raw.length >= CONSULT_MAX_STACK_EXCHANGES) throw new Error(`priorExchanges exceeds the ${CONSULT_MAX_STACK_EXCHANGES}-exchange stack cap`);
	return raw.map((entry: any, index) => {
		const question = String(entry?.question ?? "").trim();
		// Defensive length cap on the re-fed answer: without
		// it, 20 multi-MB answers sit in server memory before the prompt-side trim
		// (trimPriorAnswer → 2,000 chars) ever runs. Truncation, not rejection —
		// long legitimate answers are re-fed truncated, matching the prompt's own
		// trim discipline; the question cap stays a hard reject (user-typed, capped
		// at source).
		const answerMarkdown = String(entry?.answerMarkdown ?? "").slice(0, CONSULT_PRIOR_ANSWER_BOUNDARY_MAX_CHARS);
		if (!question) throw new Error(`priorExchanges[${index}].question is required`);
		if (question.length > CONSULT_QUESTION_MAX_CHARS) throw new Error(`priorExchanges[${index}].question is too long`);
		if (!answerMarkdown.trim()) throw new Error(`priorExchanges[${index}].answerMarkdown is required`);
		return { question, answerMarkdown };
	});
}

/**
 * One-shot, read-only consult of a room's memory. Assembles the target room's
 * L0/L1a/L1b with the consult envelope replacing the normal L2, and answers
 * through the injected isolated worker. The consulted room is never activated:
 * no session, no thread record, no runtime-state write, no lock, no memory
 * mutation, and no trace under the room's root.
 */
export async function buildConsultAnswer(raw: any, model: ConsultModelLock, generate: (prompt: string, model: ConsultModelLock) => Promise<ConsultGenerateResult>, options?: ConsultAnswerOptions): Promise<ConsultAnswerResponse> {
	const targetAgentId = validatePersistentAgentId(raw?.targetAgentId);
	const question = String(raw?.question ?? "").trim();
	if (!question) throw new Error("question is required");

	// Stacked consult (§8.1): earlier exchanges in THIS consult, re-fed into the
	// prompt. The WS boundary validates the wire shape + backstop cap (§8.6); here
	// we only normalise into the buildConsultPrompt contract. Absent → single-shot.
	const priorExchanges = normalizeConsultPriorExchanges(raw?.priorExchanges);

	let fromRoomDisplayName: string | undefined;
	let askingRoomId: string | undefined;
	const fromRoomIdRaw = String(raw?.fromRoomId ?? "").trim();
	if (fromRoomIdRaw) {
		const fromRoomId = validatePersistentAgentId(fromRoomIdRaw);
		if (fromRoomId === targetAgentId) throw new Error("a room cannot consult itself");
		askingRoomId = fromRoomId;
		const fromInstance = createPersistentAgentInstance(fromRoomId);
		const fromMeta = fromInstance.readAgentJson();
		if (!fromMeta) throw new Error(`consulting room not found: ${fromRoomId}`);
		fromRoomDisplayName = String(fromMeta.displayName ?? "").trim() || fromRoomId;
	}

	const instance = createPersistentAgentInstance(targetAgentId);
	const meta = instance.readAgentJson();
	if (!meta) throw new Error("agent.json is missing or invalid JSON");
	const l1aPath = instance.l1aPath(meta);
	const l1bPath = instance.l1bCurrentPath(meta);
	if (!fs.existsSync(l1aPath)) throw new Error("L1a.md is missing");
	if (!fs.existsSync(l1bPath)) throw new Error("L1b/current.md is missing");
	const l1a = fs.readFileSync(l1aPath, "utf-8");
	const l1b = fs.readFileSync(l1bPath, "utf-8");
	const targetDisplayName = String(meta.displayName ?? "").trim() || instance.agentId;
	// A consulted room answers as itself, standing instructions included.
	const composedInstructions = composePersistentRoomInstructions(instance.agentId, { persistentAgentsRoot: PERSISTENT_AGENTS_ROOT });
	const instructions = buildPersistentRoomInstructionsLayer({ displayName: targetDisplayName, composed: composedInstructions });
	const instructionsParts = instructions ? persistentAgentBootInstructionsParts(composedInstructions, instructions) : null;

	// Custom gateway models may omit window metadata — the guard only arms on
	// finite numbers; otherwise the consult runs unguarded (pre-MR-2 behavior).
	const window = options?.resolveModelWindow?.(model);
	const windowArmed = window != null && Number.isFinite(window.contextWindow) && Number.isFinite(window.maxOutputTokens);
	const assembly = buildConsultPrompt({
		targetAgentId: instance.agentId,
		targetDisplayName,
		fromRoomDisplayName,
		question,
		...(priorExchanges.length ? { priorExchanges } : {}),
		l0: persistentAgentPlatformKernel(),
		l1a,
		...(instructions ? { instructions } : {}),
		...(instructionsParts?.includesGlobal ? { instructionsParts: { roomEstimatedTokens: instructionsParts.roomEstimatedTokens, globalEstimatedTokens: instructionsParts.globalEstimatedTokens } } : {}),
		l1b,
		model,
		...(windowArmed ? { promptTokenBudget: checkpointPromptTokenBudget(window, model) } : {}),
	});
	// A consult's record belongs to the room that ASKED, never to the room that
	// was read: the consulted room is promised it records no trace of having
	// been consulted, and a diagnostics file in its own events would be one. A
	// consult with no asking room leaves no record at all rather than breaking
	// that promise.
	const diagnostics = askingRoomId ? maintenanceDiagnosticsRecorder(askingRoomId, "consult", generate, { roomText: l1b }) : undefined;
	const generated = await (diagnostics ? diagnostics.generate(assembly.prompt, model) : generate(assembly.prompt, model));
	refuseTruncatedWorkerOutput({ agentId: instance.agentId, processLabel: "consult", model, generated });
	const answerMarkdown = generated.text.trim();
	if (!answerMarkdown) throw new Error("consult worker produced no text");

	const warnings = ["no memory has been written", "the consulted room was not activated and records no trace of this consult"];
	if (String(raw?.targetLifecycleStatus ?? "") === "needs_absorb") {
		warnings.unshift("the consulted room has recent context awaiting Memorize; its stable memory may lag its latest sessions");
	}
	return {
		targetAgentId: instance.agentId,
		writesMemory: false,
		process: { type: CONSULT_WORKER_TYPE, model },
		target: { displayName: targetDisplayName },
		source: { l1bFingerprint: fingerprintL1bSource(l1b), generatedAt: new Date().toISOString() },
		answerMarkdown,
		consultTelemetry: assembly.telemetry,
		consultUsage: generated.usage,
		warnings,
	};
}
