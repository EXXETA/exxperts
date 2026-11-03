import fs from "node:fs";
import { renderMemoryContext, parseMemoryDocument, listAreas } from "./memory-entries.js";
import { summaryPageHead } from "./absorb-summary.js";
import { ABSORB_CONSOLIDATION_WORKER_TYPE, type AbsorbAvailability, absorbAvailabilityFromL1b, type AbsorbDiscussionMessage, recentContextSessions, extractRecentContextForAbsorb, type AbsorbModelLock, buildSectionPurposeMap, buildAbsorbAssessmentPrompt, type AbsorbAssessmentFields, parseAbsorbAssessment, buildAbsorbAssessmentRetryPrompt, ABSORB_DISCUSSION_TOKEN_BUDGET, buildAbsorbDiscussionPrompt, ABSORB_DISCUSSION_WORKER_TYPE } from "./absorb-consolidation.js";
import { FIRST_READ_NONE, buildFoldGuidanceSignoffTask, foldGuidanceToWire, parseFoldGuidance } from "./absorb-ops.js";
import { ASSESSMENT_MAX_CHARS, describeTranscriptReduction, fitDiscussionHandoff, ABSORB_HANDOFF_SHED_ORDER, describeHandoffTrim } from "./discussion-handoff.js";
import { writeMaintenanceDiagnosticsRecord } from "./maintenance-diagnostics.js";
import { ModelUnreachableError } from "./model-call-causes.js";
import { fingerprintL1bSource, type PersistentAgentId, type PersistentAgentModelLock } from "./persistent-agent-types.js";
import type { AbsorbAssessmentResponse, AbsorbDiscussionSignoffResponse, AbsorbDiscussionTurnResponse, AbsorbEventRecord, AbsorbFirstReadMissing, AbsorbGenerateResult, CheckpointModelWindow, L1bSourceFingerprint, ReviewEventRecord } from "./persistent-agent-memory-types.js";
import { absorbEventRecordPath, createPersistentAgentInstance, type PersistentAgentInstance, persistentAgentInstanceFrom, readJson, reviewEventRecordPath, validatePersistentAgentId } from "./persistent-agent-store.js";
import { buildL1bMutationEventPaths, deriveL1bMutationSections, l1bStateMetrics, reviewTargetEstimatedTokensFromL1b, sanitizeNumericUsage, stableMemoryAggregateMetrics } from "./persistent-agent-memory-files.js";
import { getPersistentAgentStatus } from "./persistent-agent-status.js";
import { ABSORB_OVERFLOW_GUIDANCE, assembleDiscussionPromptWithinBudget, generateAssessmentWithRetry, maintenanceDiagnosticsRecorder, maintenancePromptTokenBudget, type MaintenanceWorkerOptions, refuseOversizedMaintenancePrompt, refuseTruncatedWorkerOutput, WorkerOutputRefusedError } from "./persistent-agent-maintenance-worker.js";

/**
 * The Memorize v2 event record. The run owns the write (one write through the
 * entry store: snapshot, archive, core), and hands the recording back here so
 * the room's history keeps ONE absorb record shape whatever produced it — the
 * same metrics family, the same paths block, the same id — plus the run's own
 * session-by-session account. Returns where it landed.
 */
export function buildAbsorbRunEventRecord(input: {
	agentId: string;
	absorbId: string;
	now: Date;
	currentL1b: string;
	writtenL1b: string;
	archivedL1bPath: string;
	updatedL1bPath: string;
	model?: PersistentAgentModelLock;
	usage?: AbsorbGenerateResult["usage"];
	run: NonNullable<AbsorbEventRecord["run"]>;
	warnings: string[];
}): { eventRecordPath: string; record: AbsorbEventRecord } {
	const instance = createPersistentAgentInstance(input.agentId);
	const eventRecordPath = absorbEventRecordPath(instance, input.absorbId);
	// Measured on what the room reads (entry metadata stripped), the ONE
	// numerator the status block and the card use — not on the file's bytes.
	const sourceMetrics = l1bStateMetrics(renderMemoryContext(input.currentL1b));
	const resultMetrics = l1bStateMetrics(renderMemoryContext(input.writtenL1b));
	const sourceStableMemory = stableMemoryAggregateMetrics(sourceMetrics);
	const resultStableMemory = stableMemoryAggregateMetrics(resultMetrics);
	const record: AbsorbEventRecord = {
		schemaVersion: 1,
		operation: "absorb",
		mode: "rc_consolidation",
		mutation: { target: "l1b", kind: "recent_context_consolidation", ...deriveL1bMutationSections(sourceMetrics, resultMetrics) },
		paths: buildL1bMutationEventPaths(instance, input.archivedL1bPath, input.updatedL1bPath, eventRecordPath),
		...(input.model ? { process: { type: ABSORB_CONSOLIDATION_WORKER_TYPE, mode: "rc_consolidation" as const, model: input.model, source: "proposal_time" as const } } : {}),
		proposal: {
			sourceL1bFingerprint: fingerprintL1bSource(input.currentL1b),
			usage: sanitizeNumericUsage(input.usage),
		},
		agentId: instance.agentId,
		absorbId: input.absorbId,
		approvedAt: input.now.toISOString(),
		source: sourceMetrics,
		result: resultMetrics,
		absorb: {
			recentContextEntryCountBefore: sourceMetrics.recentContextEntryCount,
			recentContextEntryCountAfter: resultMetrics.recentContextEntryCount,
			recentContextBytesBefore: sourceMetrics.sections.recentContext.bytes,
			recentContextBytesAfter: resultMetrics.sections.recentContext.bytes,
			stableMemoryBytesBefore: sourceStableMemory.bytes,
			stableMemoryBytesAfter: resultStableMemory.bytes,
			stableMemoryDeltaBytes: resultStableMemory.bytes - sourceStableMemory.bytes,
			stableMemoryEstimatedTokensBefore: sourceStableMemory.estimatedTokens,
			stableMemoryEstimatedTokensAfter: resultStableMemory.estimatedTokens,
			stableMemoryEstimatedTokenDelta: resultStableMemory.estimatedTokens - sourceStableMemory.estimatedTokens,
		},
		run: input.run,
		validation: { valid: true, warnings: input.warnings, errors: [] },
		warnings: input.warnings,
	};
	// Built, not written: the memory write puts it down after its core file (memory-commit.ts).
	return { eventRecordPath, record };
}

/**
 * Review v2's approved write, recorded — the same shape and the same
 * measurement the Memorize run's record uses, so the room's history, the undo
 * and the diff read one arithmetic whichever save they are looking at.
 */
export function buildReviewRunEventRecord(input: {
	agentId: string;
	reviewId: string;
	now: Date;
	currentL1b: string;
	writtenL1b: string;
	archivedL1bPath: string;
	updatedL1bPath: string;
	model?: PersistentAgentModelLock;
	usage?: AbsorbGenerateResult["usage"];
	run: NonNullable<ReviewEventRecord["run"]>;
	warnings: string[];
}): { eventRecordPath: string; record: ReviewEventRecord } {
	const instance = createPersistentAgentInstance(input.agentId);
	const eventRecordPath = reviewEventRecordPath(instance, input.reviewId);
	// Measured on what the room reads (note metadata stripped), the ONE
	// numerator the status block and the card use — not on the file's bytes.
	const sourceMetrics = l1bStateMetrics(renderMemoryContext(input.currentL1b));
	const resultMetrics = l1bStateMetrics(renderMemoryContext(input.writtenL1b));
	const before = reviewTargetEstimatedTokensFromL1b(input.currentL1b);
	const after = reviewTargetEstimatedTokensFromL1b(input.writtenL1b);
	const record: ReviewEventRecord = {
		schemaVersion: 1,
		operation: "review",
		mode: "note_review",
		mutation: { target: "l1b", kind: "note_review", ...deriveL1bMutationSections(sourceMetrics, resultMetrics) },
		paths: buildL1bMutationEventPaths(instance, input.archivedL1bPath, input.updatedL1bPath, eventRecordPath),
		...(input.model ? { process: { type: "review-tidy-worker" as const, mode: "note_review" as const, model: input.model, source: "proposal_time" as const } } : {}),
		proposal: {
			sourceL1bFingerprint: fingerprintL1bSource(input.currentL1b),
			usage: sanitizeNumericUsage(input.usage),
		},
		agentId: instance.agentId,
		reviewId: input.reviewId,
		approvedAt: input.now.toISOString(),
		source: sourceMetrics,
		result: resultMetrics,
		review: {
			reviewTargetEstimatedTokensBefore: before,
			reviewTargetEstimatedTokensAfter: after,
			reviewTargetEstimatedTokenDelta: after - before,
			topicsTidied: new Set(input.run.changes.map((change) => change.topic)).size,
			notesChanged: input.run.changes.length,
		},
		run: input.run,
		validation: { valid: true, warnings: input.warnings, errors: [] },
		warnings: input.warnings,
	};
	// Built, not written: the memory write puts it down after its core file (memory-commit.ts).
	return { eventRecordPath, record };
}

function readCurrentL1bAndRegistry(agent: PersistentAgentInstance | string): { l1b: string; sectionRegistry: unknown } {
	const instance = persistentAgentInstanceFrom(agent);
	const meta = instance.readAgentJson();
	const l1bPath = instance.l1bCurrentPath(meta);
	const registryPath = instance.sectionRegistryPath(meta);
	if (!fs.existsSync(l1bPath)) throw new Error("L1b/current.md is missing");
	return {
		l1b: fs.readFileSync(l1bPath, "utf-8"),
		sectionRegistry: fs.existsSync(registryPath) ? readJson(registryPath) : null,
	};
}

function ensureAbsorbReady(agent: PersistentAgentInstance | string): { availability: AbsorbAvailability; l1b: string; sectionRegistry: unknown } {
	const instance = persistentAgentInstanceFrom(agent);
	const status = getPersistentAgentStatus(instance.agentId);
	if (!status.exists || status.status === "error") {
		return {
			availability: {
				available: false,
				reason: status.exists ? "error" : "not_ready",
				recentContextEntryCount: status.recentContext.fullEntries,
				minimumRecentContextEntries: 5,
				message: status.errors[0] ?? "Persistent agent scaffold is not ready.",
			},
			l1b: "",
			sectionRegistry: null,
		};
	}
	const loaded = readCurrentL1bAndRegistry(instance);
	return {
		...loaded,
		availability: absorbAvailabilityFromL1b(loaded.l1b, true),
	};
}

function parseAbsorbSourceFingerprint(raw: any, label = "source"): L1bSourceFingerprint {
	const algorithm = String(raw?.l1bFingerprint?.algorithm ?? raw?.algorithm ?? "").trim();
	const value = String(raw?.l1bFingerprint?.value ?? raw?.value ?? "").trim();
	if (algorithm !== "sha256") throw new Error(`${label} L1b fingerprint algorithm must be sha256`);
	if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} L1b fingerprint is required`);
	return { algorithm: "sha256", value: value.toLowerCase() };
}

export function assertAbsorbSourceFingerprintCurrent(expected: L1bSourceFingerprint, currentL1b: string, label = "source"): L1bSourceFingerprint {
	const current = fingerprintL1bSource(currentL1b);
	if (expected.value.toLowerCase() !== current.value) throw new Error(`${label} is stale: source L1b fingerprint changed`);
	return current;
}

function parseAbsorbDiscussionMessages(raw: any): AbsorbDiscussionMessage[] {
	const messages = Array.isArray(raw) ? raw : [];
	if (messages.length > 40) throw new Error("discussion messages are too large");
	let totalChars = 0;
	return messages.map((message, index) => {
		const role = String(message?.role ?? "").trim();
		if (role !== "user" && role !== "assistant") throw new Error(`discussion message ${index + 1} role must be user or assistant`);
		const content = String(message?.content ?? "").trim();
		if (!content) throw new Error(`discussion message ${index + 1} content is required`);
		if (content.length > 12000) throw new Error(`discussion message ${index + 1} content is too large`);
		totalChars += content.length;
		if (totalChars > 80000) throw new Error("discussion transcript is too large");
		return { role, content };
	});
}

function parseAbsorbDiscussionRequest(raw: any, requireUserMessage: boolean): {
	agentId: PersistentAgentId;
	sourceFingerprint: L1bSourceFingerprint;
	assessmentMarkdown: string;
	messages: AbsorbDiscussionMessage[];
	userMessage?: string;
} {
	const agentId = validatePersistentAgentId(raw?.agentId);
	const sourceFingerprint = parseAbsorbSourceFingerprint(raw?.source, "discussion source");
	const assessmentMarkdown = String(raw?.assessmentMarkdown ?? "").trim();
	if (!assessmentMarkdown) throw new Error("assessmentMarkdown is required");
	if (assessmentMarkdown.length > ASSESSMENT_MAX_CHARS) throw new Error("assessmentMarkdown is too large");
	const messages = parseAbsorbDiscussionMessages(raw?.messages);
	const userMessage = String(raw?.userMessage ?? "").trim();
	if (requireUserMessage && !userMessage) throw new Error("userMessage is required");
	if (userMessage.length > 12000) throw new Error("userMessage is too large");
	return { agentId, sourceFingerprint, assessmentMarkdown, messages, userMessage: userMessage || undefined };
}

export function getAbsorbAvailability(agentId: string): AbsorbAvailability {
	const instance = createPersistentAgentInstance(agentId);
	const status = getPersistentAgentStatus(instance.agentId);
	if (!status.exists || status.status === "error") {
		return {
			available: false,
			reason: status.exists ? "error" : "not_ready",
			recentContextEntryCount: status.recentContext.fullEntries,
			minimumRecentContextEntries: 5,
			message: status.errors[0] ?? "Persistent agent scaffold is not ready.",
		};
	}
	const { l1b } = readCurrentL1bAndRegistry(instance);
	return absorbAvailabilityFromL1b(l1b, true);
}

/**
 * What the assessment reads: the room's memory as ADDRESSES — one line per
 * entry, the same `id · topic · kind · first line` rows the fold addresses —
 * plus the sessions waiting, in full. The assessment's question is which
 * sessions hold what and where it would go; answering it needs every entry's
 * address and every session's content, and none of the entries' full text. On
 * a room the size of the field case this is the difference between an 8k
 * prompt and a 68k one.
 *
 * Given a size in characters, the material is fitted to it: the sessions come
 * first, whole and oldest first, because they are what the first read is
 * about; a session that does not fit is named by its heading line alone, and
 * after them come as many entry rows as fit. Each part says how many it left
 * out. It is never empty, since an empty material would send the whole file.
 */
export function buildAbsorbAssessmentMaterial(l1b: string, maxChars = Number.POSITIVE_INFINITY): string {
	const doc = parseMemoryDocument(l1b);
	const areas = listAreas(doc);
	const sessions = recentContextSessions(extractRecentContextForAbsorb(l1b).recentContext);
	const rowOf = (area: (typeof areas)[number]) => `- ${area.id} · ${area.topic} · ${area.kind}${area.pinned ? " · pinned" : ""} · ${area.firstLine || "(empty)"}`;
	const entriesHead = `### Entries already in memory (${areas.length})\n\nEach row is \`id · topic · kind · first line\`, with pinned entries marked. Their full text is not shown here; the fold reads it one topic at a time.`;
	const sessionsHead = `### Sessions waiting (${sessions.length})`;
	const assemble = (rows: string, blocks: string) => [`${entriesHead}\n\n${rows}`, `${sessionsHead}\n\n${blocks}`].join("\n\n");
	const allRows = areas.length === 0 ? "This room's memory holds no entries yet." : areas.map(rowOf).join("\n");
	const allBlocks = sessions.length === 0 ? "No sessions are waiting." : sessions.map((session) => session.text.trim()).join("\n\n");
	const whole = assemble(allRows, allBlocks);
	if (whole.length <= maxChars) return whole;
	// Every session that fits is shown whole, oldest first, so one long page
	// never pushes out the ones behind it; the rest are named by their heading
	// while those fit, then counted. `room` is what the sessions and rows may
	// take; what the headings, the tails and the joins take is measured on the
	// assembled material, and a material still too long is fitted again with
	// the room short by exactly the overshoot.
	const fitted = (room: number): string => {
		const shown: string[] = [];
		const left: string[] = [];
		for (const session of sessions) {
			const text = session.text.trim();
			// Each block costs its text and the blank line before the next.
			if (text.length + 2 <= room) {
				shown.push(text);
				room -= text.length + 2;
			} else left.push(text.split("\n")[0]!.trim());
		}
		const named: string[] = [];
		for (const heading of left) {
			if (heading.length + 1 > room) break;
			named.push(heading);
			room -= heading.length + 1;
		}
		const unnamed = left.length - named.length;
		const rows: string[] = [];
		for (const area of areas) {
			const row = rowOf(area);
			if (row.length + 1 > room) break;
			rows.push(row);
			room -= row.length + 1;
		}
		const blocks = [
			...shown,
			...(named.length > 0 ? [`${named.length} more ${named.length === 1 ? "session is" : "sessions are"} waiting and too long to show here; their headings:\n${named.join("\n")}`] : []),
			...(unnamed > 0 ? [`${unnamed} more ${unnamed === 1 ? "session is" : "sessions are"} waiting and not shown here.`] : []),
		];
		const leftOut = areas.length - rows.length;
		const rowText = areas.length === 0 ? "This room's memory holds no entries yet." : [...rows, ...(leftOut > 0 ? [`(${leftOut} more ${leftOut === 1 ? "entry is" : "entries are"} in memory and not shown here.)`] : [])].join("\n");
		return assemble(rowText, blocks.length > 0 ? blocks.join("\n\n") : "No sessions are waiting.");
	};
	let room = maxChars - entriesHead.length - sessionsHead.length;
	let material = fitted(room);
	for (let pass = 0; pass < 8 && material.length > maxChars && room > 0; pass++) {
		room -= material.length - maxChars;
		material = fitted(Math.max(0, room));
	}
	return material;
}

/**
 * The waiting conversations as the missing first read lists them. A block with
 * no title of its own is named as the filer would head its note, by its first
 * line, never by its Recent Context id; a block with no date shows none.
 */
function waitingConversationsOf(l1b: string): Array<{ title: string; date?: string }> {
	return recentContextSessions(extractRecentContextForAbsorb(l1b).recentContext).map((session) => {
		const title = session.title !== session.id ? session.title : summaryPageHead({ id: session.id, title: session.title, text: session.text }) || session.id;
		return { title, ...(session.date ? { date: session.date } : {}) };
	});
}

/** What the prompt must leave the first read's retry notice, in characters, when the material is fitted. */
const ASSESSMENT_FIT_RESERVE_CHARS = 2_000;

export async function buildAbsorbAssessment(agentId: string, model: AbsorbModelLock, generate: (prompt: string, model: AbsorbModelLock) => Promise<AbsorbGenerateResult>, options?: MaintenanceWorkerOptions): Promise<AbsorbAssessmentResponse> {
	const instance = createPersistentAgentInstance(agentId);
	const loaded = ensureAbsorbReady(instance);
	if (!loaded.availability.available) throw new Error(loaded.availability.message);
	const baseInput = {
		agentId: instance.agentId,
		l1b: loaded.l1b,
		model,
		sectionPurposeMap: buildSectionPurposeMap(loaded.sectionRegistry),
	};
	// A window lookup that fails reads as unknown: the material is built whole,
	// as it always was, and nothing of the lookup reaches the screen.
	let window: CheckpointModelWindow | undefined;
	try {
		window = options?.resolveModelWindow?.(model);
	} catch {
		window = undefined;
	}
	const budget = maintenancePromptTokenBudget(window, model);
	let promptInput = { ...baseInput, memoryMaterial: buildAbsorbAssessmentMaterial(loaded.l1b) };
	let assembly = buildAbsorbAssessmentPrompt({ ...promptInput, retryFeedback: options?.retryFeedback });
	if (budget !== undefined && assembly.telemetry.promptEstimatedTokens > budget) {
		// The same estimate the check below uses (characters over four), so a
		// material fitted to the characters left is a prompt that passes it.
		const frameChars = assembly.prompt.length - promptInput.memoryMaterial.trim().length;
		promptInput = { ...baseInput, memoryMaterial: buildAbsorbAssessmentMaterial(loaded.l1b, budget * 4 - frameChars - ASSESSMENT_FIT_RESERVE_CHARS) };
		assembly = buildAbsorbAssessmentPrompt({ ...promptInput, retryFeedback: options?.retryFeedback });
	}
	const basePrompt = options?.retryFeedback?.length ? buildAbsorbAssessmentPrompt(promptInput).prompt : assembly.prompt;
	const response = (text: string, fields: AbsorbAssessmentFields, warnings: string[], usage?: AbsorbGenerateResult["usage"], missing?: AbsorbFirstReadMissing): AbsorbAssessmentResponse => ({
		agentId: instance.agentId,
		writesMemory: false,
		process: { type: ABSORB_CONSOLIDATION_WORKER_TYPE, model },
		availability: loaded.availability,
		source: {
			l1bFingerprint: fingerprintL1bSource(loaded.l1b),
			generatedAt: new Date().toISOString(),
		},
		assessmentMarkdown: text,
		fields,
		absorbTelemetry: assembly.telemetry,
		...(usage ? { absorbUsage: usage } : {}),
		warnings: [...warnings, "no memory has been written"],
		...(missing ? { firstReadMissing: missing, waitingConversations: waitingConversationsOf(loaded.l1b) } : {}),
	});
	const diagnostics = maintenanceDiagnosticsRecorder(instance.agentId, "memorize-assessment", generate, { roomText: loaded.l1b });
	// The first read never blocks Memorize. When it cannot be had, the answer
	// is "None." with the one reason why and none of the parser's findings
	// about the missing sections: the screen says there is no first read, and
	// a Read again must not send those findings back as the reasons.
	const missing = (why: AbsorbFirstReadMissing): AbsorbAssessmentResponse => {
		// A call that threw or was cut is already on its record as such.
		diagnostics.annotate({ ...(why === "too-long" ? { outcome: "refused" as const } : {}), validatorErrors: [`first read missing: ${why}`] });
		return response(FIRST_READ_NONE, parseAbsorbAssessment(FIRST_READ_NONE).fields, [], undefined, why);
	};
	if (budget !== undefined && assembly.telemetry.promptEstimatedTokens > budget) {
		// No call is made, so the record is written here: the reason still counts per provider.
		writeMaintenanceDiagnosticsRecord(instance.rootDir, {
			schemaVersion: 1, agentId: instance.agentId, process: "memorize-assessment", at: new Date().toISOString(), attempt: 0, provider: model.provider, model: model.model,
			promptChars: assembly.prompt.length, promptEstimatedTokens: assembly.telemetry.promptEstimatedTokens, replyChars: 0, truncated: false, wallTimeMs: 0,
			parseSignature: { markers: [], unexpectedHeadings: 0, jsonFence: "absent" }, validatorErrors: ["first read missing: too-large"], validatorWarnings: [], outcome: "refused",
		});
		return missing("too-large");
	}
	let generated;
	try {
		generated = await generateAssessmentWithRetry({
			agentId: instance.agentId,
			processLabel: "Memorize assessment",
			model,
			prompt: assembly.prompt,
			basePrompt,
			priorReasons: options?.retryFeedback,
			generate: (prompt) => diagnostics.generate(prompt, model),
			parse: parseAbsorbAssessment,
			buildRetryPrompt: buildAbsorbAssessmentRetryPrompt,
		});
	} catch (error) {
		// An unreachable model is the one notice with its ways out, as on Review; reading again would fail the same way.
		if (error instanceof ModelUnreachableError) throw error;
		return missing(error instanceof WorkerOutputRefusedError ? error.reason : "failed");
	}
	if (!generated.text.trim()) return missing("failed");
	diagnostics.annotate({ outcome: "accepted", validatorWarnings: [...generated.parsed.warnings, ...generated.warnings] });
	return response(generated.text, generated.parsed.fields, [...generated.parsed.warnings, ...generated.warnings], generated.usage);
}

export async function buildAbsorbDiscussionTurn(raw: any, model: AbsorbModelLock, generate: (prompt: string, model: AbsorbModelLock) => Promise<AbsorbGenerateResult>, options?: MaintenanceWorkerOptions): Promise<AbsorbDiscussionTurnResponse> {
	const request = parseAbsorbDiscussionRequest(raw, true);
	const loaded = ensureAbsorbReady(request.agentId);
	if (!loaded.availability.available) throw new Error(loaded.availability.message);
	const currentFingerprint = assertAbsorbSourceFingerprintCurrent(request.sourceFingerprint, loaded.l1b, "discussion source");
	const window = options?.resolveModelWindow?.(model);
	const sectionPurposeMap = buildSectionPurposeMap(loaded.sectionRegistry);
	const { assembly, reduction } = assembleDiscussionPromptWithinBudget({
		messages: request.messages,
		hardStopTokens: ABSORB_DISCUSSION_TOKEN_BUDGET.hardStop,
		window,
		model,
		build: (messages) => buildAbsorbDiscussionPrompt({
			agentId: request.agentId,
			l1b: loaded.l1b,
			model,
			sectionPurposeMap,
			assessmentMarkdown: request.assessmentMarkdown,
			messages,
			userMessage: request.userMessage,
			sourceFingerprint: currentFingerprint,
			mode: "turn",
		}),
	});
	// Window check first: a ladder-exhausted prompt should refuse with the
	// remedy-naming overflow copy, not the generic budget line below it.
	refuseOversizedMaintenancePrompt({ agentId: request.agentId, processLabel: "Memorize discussion", model, promptEstimatedTokens: assembly.telemetry.promptEstimatedTokens, window, guidance: ABSORB_OVERFLOW_GUIDANCE });
	if (!assembly.tokenBudget.canContinue) throw new Error("absorb discussion token budget exceeded");
	const diagnostics = maintenanceDiagnosticsRecorder(request.agentId, "memorize-discussion", generate, { roomText: loaded.l1b });
	const generated = await diagnostics.generate(assembly.prompt, model);
	refuseTruncatedWorkerOutput({ agentId: request.agentId, processLabel: "Memorize discussion", model, generated });
	return {
		agentId: request.agentId,
		writesMemory: false,
		process: { type: ABSORB_DISCUSSION_WORKER_TYPE, model },
		availability: loaded.availability,
		source: { l1bFingerprint: currentFingerprint, checkedAt: new Date().toISOString() },
		message: { role: "assistant", content: generated.text.trim() },
		absorbDiscussionTelemetry: assembly.telemetry,
		absorbDiscussionUsage: generated.usage,
		tokenBudget: assembly.tokenBudget,
		warnings: [assembly.tokenBudget.state === "soft_warning" ? "absorb discussion token budget is approaching the limit" : "", reduction ? describeTranscriptReduction(reduction) ?? "" : "", "no memory has been written"].filter(Boolean),
	};
}

export async function buildAbsorbDiscussionSignoff(raw: any, model: AbsorbModelLock, generate: (prompt: string, model: AbsorbModelLock) => Promise<AbsorbGenerateResult>, options?: MaintenanceWorkerOptions): Promise<AbsorbDiscussionSignoffResponse> {
	const request = parseAbsorbDiscussionRequest(raw, false);
	const loaded = ensureAbsorbReady(request.agentId);
	if (!loaded.availability.available) throw new Error(loaded.availability.message);
	const currentFingerprint = assertAbsorbSourceFingerprintCurrent(request.sourceFingerprint, loaded.l1b, "discussion source");
	const window = options?.resolveModelWindow?.(model);
	const sectionPurposeMap = buildSectionPurposeMap(loaded.sectionRegistry);
	const { assembly, reduction } = assembleDiscussionPromptWithinBudget({
		messages: request.messages,
		hardStopTokens: ABSORB_DISCUSSION_TOKEN_BUDGET.hardStop,
		window,
		model,
		build: (messages) => buildAbsorbDiscussionPrompt({
			agentId: request.agentId,
			l1b: loaded.l1b,
			model,
			sectionPurposeMap,
			assessmentMarkdown: request.assessmentMarkdown,
			messages,
			userMessage: request.userMessage,
			sourceFingerprint: currentFingerprint,
			mode: "signoff",
			// Memory v2: the sign-off is structured, because every fold call
			// carries it and the card lists which of its instructions were
			// applied. Prose cannot be carried that way.
			signoffTask: buildFoldGuidanceSignoffTask(),
		}),
	});
	if (!assembly.tokenBudget.canSignOff) throw new Error("absorb discussion token budget exceeded before signoff");
	refuseOversizedMaintenancePrompt({ agentId: request.agentId, processLabel: "Memorize discussion summary", model, promptEstimatedTokens: assembly.telemetry.promptEstimatedTokens, window, guidance: ABSORB_OVERFLOW_GUIDANCE });
	const diagnostics = maintenanceDiagnosticsRecorder(request.agentId, "memorize-discussion-signoff", generate, { roomText: loaded.l1b });
	const generated = await diagnostics.generate(assembly.prompt, model);
	refuseTruncatedWorkerOutput({ agentId: request.agentId, processLabel: "Memorize discussion summary", model, generated });
	const rawHandoff = generated.text.trim();
	if (!rawHandoff) throw new Error("absorb discussion signoff worker produced no text");
	const handoff = fitDiscussionHandoff(rawHandoff, ABSORB_HANDOFF_SHED_ORDER);
	return {
		agentId: request.agentId,
		writesMemory: false,
		process: { type: ABSORB_DISCUSSION_WORKER_TYPE, model },
		availability: loaded.availability,
		source: { l1bFingerprint: currentFingerprint, checkedAt: new Date().toISOString() },
		assessmentHandoff: { source: "discussion_signoff", text: handoff.text },
		// The same sign-off, read twice: as the text the assessment handoff has
		// always carried, and as the fields every fold call honours.
		guidance: foldGuidanceToWire(parseFoldGuidance(rawHandoff)),
		absorbDiscussionTelemetry: assembly.telemetry,
		absorbDiscussionUsage: generated.usage,
		tokenBudget: assembly.tokenBudget,
		warnings: [
			assembly.tokenBudget.state === "soft_warning" ? "absorb discussion token budget is approaching the limit" : "",
			reduction ? describeTranscriptReduction(reduction) ?? "" : "",
			describeHandoffTrim(handoff) ?? "",
			"no memory has been written",
		].filter(Boolean),
	};
}
