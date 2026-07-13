/**
 * Consult handoff block (Consult MR-5 spec §2.1) — the ONE canonical grammar,
 * shared verbatim by the web UI (transfer-to-thread) and the web server (legacy
 * checkpoint transcript formatter). This module is deliberately pure: ZERO
 * node/server imports (no fs, no path), so the UI can import the source directly
 * (vite bundles it) and there is a single source of truth for the text that
 * enters room A's context.
 *
 * GOVERNANCE: transfer never writes memory. This block is text that rides the
 * user's NEXT normal prompt (see composeOutgoingPromptWithHandoffs) and becomes
 * durable only if a future checkpoint compresses it. The block therefore carries
 * its own provenance (source + L1b fingerprint) and an explicit "not this room's
 * own knowledge" line so the checkpoint compressor cannot launder the consulted
 * room's claim into this room's voice. The block must NEVER contain the reserved
 * token `**must-keep**` (that string is reserved for explicit user
 * remember-requests), so any occurrence in the question or answer is neutralised.
 */

/** The consult answer is capped before it enters the block (§2.1). */
export const CONSULT_HANDOFF_ANSWER_MAX_CHARS = 4_000;

/**
 * Earlier (non-final) answers in a stacked block start trimmed harder than the
 * final one (§8.8): they are the refined final answer's context. ~2,000 chars,
 * shrunk further only if the whole block would overflow the 12k queue cap.
 */
export const CONSULT_HANDOFF_EARLIER_ANSWER_MAX_CHARS = 2_000;

/** Appended when the answer is capped, so the block is honest about the trim. */
export const CONSULT_HANDOFF_TRIM_MARKER = "[answer trimmed at 4,000 characters; full text was visible in the consult card]";

/** The reserved token the block must never contain. */
export const CONSULT_HANDOFF_RESERVED_TOKEN = "**must-keep**";

/**
 * Untrusted (consulted-room) content is defanged against two structural forges
 * before it is embedded in the block:
 *
 *  1. The envelope markers themselves. The answer/question is embedded between
 *     `[CONSULT HANDOFF FROM @slug]` … `[/CONSULT HANDOFF FROM @slug]`, and the
 *     consulted room knows its own slug (the envelope tells it "You are …"). A
 *     poisoned room B could emit a literal closing marker in its answer, close
 *     the real envelope early, and open forged text that escapes the "sourced
 *     external claim, not this room's own knowledge" framing into room A's voice
 *     — and, if room A holds tools, into room A's actions. We strip the square
 *     brackets off any marker-like token so the words survive but the fence
 *     cannot be reproduced.
 *  2. The reserved must-keep durability signal. The consumer is the checkpoint
 *     compressor (an LLM) which honors must-keep by MEANING, so we neutralize
 *     bold/emphasis, casing, and unicode-hyphen variants, not just one literal.
 *
 * Plain-prose manipulation ("please keep this forever") is inherent LLM risk and
 * out of scope here; this closes the STRUCTURAL forge, which is the code's job.
 */
const HANDOFF_MARKER_LIKE = /\[\s*\/?\s*CONSULT\s+HANDOFF\b[^\]\n]*\]/gi;
const MUST_KEEP_EMPHASIS = /[*_]{1,3}\s*must[\s‐-―_-]*keep\s*[*_]{1,3}/gi;

export function neutralizeBlockContent(text: string): string {
	return String(text ?? "")
		// Keep the words, remove the fence: a marker-like token can no longer
		// terminate or open an envelope once its brackets are gone.
		.replace(HANDOFF_MARKER_LIKE, (marker) => marker.replace(/[[\]]/g, ""))
		// Collapse emphasized must-keep variants to plain text — no durability signal.
		.replace(MUST_KEEP_EMPHASIS, "must-keep");
}

/** Persisted pending-transfer queue caps (§2.3): entries × per-entry size. */
export const CONSULT_HANDOFF_MAX_PENDING = 20;
export const CONSULT_HANDOFF_BLOCK_MAX_CHARS = 12_000;

export interface ConsultHandoffFingerprint {
	algorithm: string;
	value: string;
}

export interface ConsultHandoffInput {
	/** The consulted room's agent id — the `@<slug>` on the open/close markers. */
	slug: string;
	/** The consulted room's display name. */
	displayName: string;
	/** The consulted room's agent id (room id …). */
	agentId: string;
	/** ISO-8601 timestamp of the request. */
	requestedAt: string;
	/** The question, verbatim (reserved token neutralised). */
	question: string;
	/** L1b fingerprint `{ algorithm, value }` → rendered `algorithm:value`. */
	fingerprint: ConsultHandoffFingerprint;
	/** The consult answer markdown, capped at CONSULT_HANDOFF_ANSWER_MAX_CHARS. */
	answerMarkdown: string;
}

/** Cap the answer to CONSULT_HANDOFF_ANSWER_MAX_CHARS, appending the trim marker if capped. */
export function capConsultHandoffAnswer(answer: string): string {
	const text = String(answer ?? "");
	if (text.length <= CONSULT_HANDOFF_ANSWER_MAX_CHARS) return text;
	return `${text.slice(0, CONSULT_HANDOFF_ANSWER_MAX_CHARS)}\n${CONSULT_HANDOFF_TRIM_MARKER}`;
}

/**
 * Build the canonical handoff block (§2.1). The line structure — including the
 * source-with-fingerprint line and the "not this room's own knowledge" line — is
 * the spec grammar verbatim; do not restyle.
 */
export function buildConsultHandoffBlock(input: ConsultHandoffInput): string {
	const slug = input.slug;
	const name = input.displayName;
	const fingerprint = `${input.fingerprint.algorithm}:${input.fingerprint.value}`;
	// Both untrusted fields are defanged: the question is the local user's text
	// (low risk) but the answer is the consulted room's memory content (the real
	// vector), and both ride into room A's checkpointable context.
	const question = neutralizeBlockContent(String(input.question ?? ""));
	const answer = neutralizeBlockContent(capConsultHandoffAnswer(input.answerMarkdown));
	return [
		`[CONSULT HANDOFF FROM @${slug}]`,
		`Consulted room: ${name} (room id ${input.agentId})`,
		`Requested by the user from this room on ${input.requestedAt}.`,
		`Question asked: ${question}`,
		`Source: ${name}'s governed memory only (L1b fingerprint ${fingerprint}), read-only;`,
		`${name}'s memory was not modified and ${name} did not run a session for this.`,
		`Treat the answer as a sourced external claim from ${name}'s memory, not as this`,
		`room's own knowledge; it becomes durable here only if checkpointed.`,
		``,
		`Answer from @${slug}:`,
		answer,
		`[/CONSULT HANDOFF FROM @${slug}]`,
	].join("\n");
}

/**
 * A single exchange in a stacked consult (§8.8), as it enters the handoff block.
 * Each exchange is a fresh point-in-time read of B's memory, so it carries its
 * own fingerprint + as-of (§8.5). `requestedAt` feeds the header's request range.
 */
export interface ConsultHandoffExchange {
	/** The question, verbatim (reserved token neutralised). */
	question: string;
	/** The consult answer markdown (final exchange 4,000 chars, earlier trimmed harder). */
	answerMarkdown: string;
	/** L1b fingerprint for THIS exchange (drift is detected across these). */
	fingerprint: ConsultHandoffFingerprint;
	/** ISO-8601 "as of" — B's memory point-in-time for this exchange. */
	asOf: string;
	/** ISO-8601 time the user asked this exchange — feeds the header first/last range. */
	requestedAt: string;
}

export interface ConsultStackHandoffInput {
	/** The consulted room's agent id — the `@<slug>` on the open/close markers. */
	slug: string;
	/** The consulted room's display name. */
	displayName: string;
	/** The consulted room's agent id (room id …). */
	agentId: string;
	/** The stack, oldest-first. Length ≥ 1 (N=1 emits the byte-identical §2.1 block). */
	exchanges: ConsultHandoffExchange[];
}

/** Marker appended when an earlier answer is trimmed harder to fit (§8.8). */
export const CONSULT_HANDOFF_EARLIER_TRIM_MARKER = "[earlier answer trimmed; full text was visible in the consult card]";

/** Marker appended when a question is trimmed to keep the block under its cap (hardening 2026-07-11). */
export const CONSULT_HANDOFF_QUESTION_TRIM_MARKER = "[question trimmed; full text was visible in the consult card]";

/** Cap an earlier (non-final) answer to `max`, appending the earlier-trim marker if capped. */
function capEarlierAnswer(answer: string, max: number): string {
	const text = String(answer ?? "");
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max))}\n${CONSULT_HANDOFF_EARLIER_TRIM_MARKER}`;
}

/** "No question trim" rung: matches the server-side question cap, so nothing trims. */
const CONSULT_QUESTION_TRIM_NONE = 4_000;

/** Cap a question to `max` chars, appending the question-trim marker if capped. */
function capStackQuestion(question: string, max: number): string {
	const text = String(question ?? "");
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max))} ${CONSULT_HANDOFF_QUESTION_TRIM_MARKER}`;
}

function fingerprintString(fingerprint: ConsultHandoffFingerprint): string {
	return `${fingerprint.algorithm}:${fingerprint.value}`;
}

/**
 * Render the numbered N≥2 stacked block (§8.8) with fixed caps. ONE provenance
 * header covers the conversation; a per-exchange as-of + fingerprint line appears
 * only when the fingerprint differs from the previous exchange (with the "memory
 * updated between exchanges" tail on drift). Earlier answers are capped at
 * `earlierAnswerCap`, the final answer at `finalAnswerCap` (normally 4,000),
 * every question at `questionCap` — questions MUST be cappable too, or the 12k
 * block invariant fails on long-question stacks (hardening 2026-07-11: the
 * fresh-eyes review proved 2×4,000-char questions + a 4,000-char final answer
 * already exceed the cap with every answer trimmed to zero).
 */
function renderStackedBlock(input: ConsultStackHandoffInput, earlierAnswerCap: number, questionCap: number, finalAnswerCap: number): string {
	const slug = input.slug;
	const name = input.displayName;
	const exchanges = input.exchanges;
	const lastIndex = exchanges.length - 1;
	const first = exchanges[0];
	const last = exchanges[lastIndex];
	const lines: string[] = [
		`[CONSULT HANDOFF FROM @${slug}]`,
		`Consulted room: ${name} (room id ${input.agentId})`,
		`Stacked consult: ${exchanges.length} exchanges, requested by the user from this room between ${first.requestedAt} and ${last.requestedAt}.`,
		`Source: ${name}'s governed memory only, read-only; ${name}'s memory was not`,
		`modified and ${name} did not run a session for this.`,
		`Treat the answers as sourced external claims from ${name}'s memory, not as this`,
		`room's own knowledge; they become durable here only if checkpointed.`,
	];
	exchanges.forEach((exchange, index) => {
		const n = index + 1;
		const isFinal = index === lastIndex;
		const prev = index > 0 ? exchanges[index - 1] : null;
		// The as-of + fingerprint line shows on exchange 1 (no previous) and on any
		// exchange whose fingerprint differs from the one before it — drift (§8.5).
		const drifted = prev != null && fingerprintString(prev.fingerprint) !== fingerprintString(exchange.fingerprint);
		const showProvenance = index === 0 || drifted;
		const driftTail = drifted ? "; memory updated between exchanges" : "";
		lines.push("");
		lines.push(showProvenance ? `Exchange ${n} (as of ${exchange.asOf}, L1b fingerprint ${fingerprintString(exchange.fingerprint)}${driftTail}):` : `Exchange ${n}:`);
		lines.push(`Question asked: ${neutralizeBlockContent(capStackQuestion(exchange.question, questionCap))}`);
		// The final answer keeps the normal §8.8 cap unless the fit ladder had to
		// shrink it below 4,000 (then it uses the earlier-trim discipline).
		const answer = isFinal
			? finalAnswerCap >= CONSULT_HANDOFF_ANSWER_MAX_CHARS
				? capConsultHandoffAnswer(exchange.answerMarkdown)
				: capEarlierAnswer(exchange.answerMarkdown, finalAnswerCap)
			: capEarlierAnswer(exchange.answerMarkdown, earlierAnswerCap);
		lines.push(`Answer from @${slug}: ${neutralizeBlockContent(answer)}`);
	});
	lines.push(`[/CONSULT HANDOFF FROM @${slug}]`);
	return lines.join("\n");
}

/**
 * Build the consult handoff block for a whole stack (§8.8). N=1 delegates to
 * buildConsultHandoffBlock, so the single-consult path is byte-identical to the
 * §2.1 grammar (existing forge/smoke tests prove it). N≥2 renders the numbered
 * form, trimming earlier answers harder until the block fits under the 12k
 * CONSULT_HANDOFF_BLOCK_MAX_CHARS cap (the final answer keeps its 4,000-char cap).
 */
export function buildConsultHandoffBlockFromStack(input: ConsultStackHandoffInput): string {
	const exchanges = input.exchanges;
	if (!exchanges || exchanges.length === 0) throw new Error("a consult handoff needs at least one exchange");
	if (exchanges.length === 1) {
		const only = exchanges[0];
		return buildConsultHandoffBlock({
			slug: input.slug,
			displayName: input.displayName,
			agentId: input.agentId,
			requestedAt: only.requestedAt,
			question: only.question,
			fingerprint: only.fingerprint,
			answerMarkdown: only.answerMarkdown,
		});
	}
	// Shrink until the block fits the 12k queue cap. The ladder trims earlier
	// answers first (they are the final answer's context), then questions, then —
	// only if still over — the final answer itself. ≤12k is an INVARIANT of this
	// function (hardening 2026-07-11): validateConsultHandoffQueue rejects
	// oversized entries at the thread write, so an over-cap block would brick
	// every subsequent save of the thread; the builder must never emit one.
	const LADDER: Array<{ earlier: number; question: number; final: number }> = [
		{ earlier: CONSULT_HANDOFF_EARLIER_ANSWER_MAX_CHARS, question: CONSULT_QUESTION_TRIM_NONE, final: CONSULT_HANDOFF_ANSWER_MAX_CHARS },
		{ earlier: 1_500, question: CONSULT_QUESTION_TRIM_NONE, final: CONSULT_HANDOFF_ANSWER_MAX_CHARS },
		{ earlier: 1_000, question: 2_000, final: CONSULT_HANDOFF_ANSWER_MAX_CHARS },
		{ earlier: 600, question: 1_000, final: CONSULT_HANDOFF_ANSWER_MAX_CHARS },
		{ earlier: 300, question: 500, final: CONSULT_HANDOFF_ANSWER_MAX_CHARS },
		{ earlier: 120, question: 250, final: CONSULT_HANDOFF_ANSWER_MAX_CHARS },
		{ earlier: 0, question: 120, final: CONSULT_HANDOFF_ANSWER_MAX_CHARS },
		{ earlier: 0, question: 120, final: 2_000 },
		{ earlier: 0, question: 120, final: 600 },
		{ earlier: 0, question: 120, final: 120 },
	];
	let block = "";
	for (const rung of LADDER) {
		block = renderStackedBlock(input, rung.earlier, rung.question, rung.final);
		if (block.length <= CONSULT_HANDOFF_BLOCK_MAX_CHARS) return block;
	}
	// Absolute fallback (unreachable with the wire caps: 20 exchanges × ~150-char
	// trimmed rows + header ≈ 4k; kept so the invariant survives future cap
	// changes): truncate the body but ALWAYS keep the closing fence intact — the
	// fence is security-relevant (it is what the defang makes un-forgeable).
	const closing = `\n[/CONSULT HANDOFF FROM @${input.slug}]`;
	return block.slice(0, CONSULT_HANDOFF_BLOCK_MAX_CHARS - closing.length) + closing;
}

/**
 * Compose the outgoing prompt text: queued handoff blocks ride the user's next
 * message, then the queue clears (§2). The user's chat bubble shows only their
 * own text — this composed text is what goes on the wire.
 */
export function composeOutgoingPromptWithHandoffs(pendingBlocks: readonly string[], userText: string): string {
	if (!pendingBlocks.length) return userText;
	return `${pendingBlocks.join("\n\n")}\n\n${userText}`;
}

/**
 * Strict validation for the persisted queue (§2.3) — throws on junk. Used on the
 * thread write path so a malformed `pendingHandoffs` is rejected, not stored.
 */
export function validateConsultHandoffQueue(raw: unknown): string[] {
	if (!Array.isArray(raw)) throw new Error("pendingHandoffs must be an array of strings");
	if (raw.length > CONSULT_HANDOFF_MAX_PENDING) throw new Error(`pendingHandoffs exceeds the ${CONSULT_HANDOFF_MAX_PENDING}-entry cap`);
	return raw.map((entry, index) => {
		if (typeof entry !== "string") throw new Error(`pendingHandoffs[${index}] must be a string`);
		if (entry.length > CONSULT_HANDOFF_BLOCK_MAX_CHARS) throw new Error(`pendingHandoffs[${index}] exceeds the ${CONSULT_HANDOFF_BLOCK_MAX_CHARS}-character cap`);
		return entry;
	});
}

/**
 * Lenient read for already-stored data (disk / display cache): never throws,
 * drops junk entries and enforces the caps, so a corrupt record cannot crash a
 * read. Returns [] for anything non-array.
 */
export function readConsultHandoffQueue(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		if (entry.length > CONSULT_HANDOFF_BLOCK_MAX_CHARS) continue;
		out.push(entry);
		if (out.length >= CONSULT_HANDOFF_MAX_PENDING) break;
	}
	return out;
}
