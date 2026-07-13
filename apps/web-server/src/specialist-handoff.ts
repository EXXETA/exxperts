/**
 * Specialist handoff block (Delegation contract spec §2.2) — the ONE canonical
 * grammar for the text a specialist-task transfer leaves in the requesting
 * room's context (and therefore its future checkpoints). Sibling of
 * consult-handoff.ts: deliberately pure, ZERO node/server imports (no fs, no
 * path), so the web UI can import this source directly (vite bundles it) and the
 * UI transfer + the server-side checkpoint formatter agree on the text exactly.
 *
 * GOVERNANCE (identical to consult): a transfer never writes memory. This block
 * is text that rides the user's NEXT normal prompt (composeOutgoingPromptWithHandoffs
 * in consult-handoff.ts — specialist blocks ride the same pending-transfer queue,
 * whose 12k per-entry bound is CONSULT_HANDOFF_BLOCK_MAX_CHARS) and becomes durable
 * only if a future checkpoint compresses it. The block carries its own provenance
 * (the "ephemeral specialist session — no memory access" Source lines) so the
 * checkpoint compressor cannot launder the specialist's output into this room's
 * own voice, and it never claims `**must-keep**` (reserved for explicit user
 * remember-requests). Every user/model-controlled string is neutralised against
 * the same structural forges consult-handoff defends: envelope-marker forgery and
 * the must-keep durability signal — plus the specialist envelope's own markers.
 */

import { neutralizeBlockContent } from "./consult-handoff.js";

/** The distilled summary is capped before it enters the block (§2.2). */
export const SPECIALIST_HANDOFF_SUMMARY_MAX_CHARS = 4_000;

/**
 * The one-line task title is capped at the consult question cap (CONSULT MR-1's
 * CONSULT_QUESTION_MAX_CHARS = 4,000): the same "one user/model-authored line"
 * bound, so both delegation surfaces cap authored text identically.
 */
export const SPECIALIST_HANDOFF_TASK_TITLE_MAX_CHARS = 4_000;

/** Appended when the summary is capped, so the block is honest about the trim (§2.2). */
export const SPECIALIST_HANDOFF_TRIM_MARKER = "[summary trimmed at 4,000 characters; full text was visible in the task card]";

/** At most this many artifact paths are listed; the rest collapse to a `(+N more)` line. */
export const SPECIALIST_HANDOFF_ARTIFACTS_MAX = 8;

/** A path that is absolute / traversing / not store-relative is replaced with this literal. */
export const SPECIALIST_HANDOFF_INVALID_PATH = "(invalid path omitted)";

/** Shown in the Artifacts section when a task reported no artifact paths. */
export const SPECIALIST_HANDOFF_NO_ARTIFACTS = "(none)";

/**
 * The block MUST never exceed this — it rides the SAME pending-transfer queue as
 * consult blocks, and validateConsultHandoffQueue rejects any entry over
 * CONSULT_HANDOFF_BLOCK_MAX_CHARS (12,000). An over-cap block would brick every
 * subsequent save of the thread, so ≤12,000 is an INVARIANT of the builder: the
 * summary trims first, then — only if authored-elsewhere fields (title/paths) are
 * themselves pathological — an absolute truncation that ALWAYS keeps the closing
 * fence intact (the fence is what the defang makes un-forgeable).
 */
export const SPECIALIST_HANDOFF_BLOCK_MAX_CHARS = 12_000;

/**
 * The specialist envelope's own markers — the §2.2 sibling of consult-handoff's
 * HANDOFF_MARKER_LIKE. A distilled summary (specialist-authored, the real forge
 * vector) could emit a literal `[/SPECIALIST RESULT: deck]` to close the real
 * envelope early and open forged text that escapes the provenance framing into
 * room A's voice. We strip the brackets off any marker-like token so the words
 * survive but the fence cannot be reproduced — exactly consult-handoff's defang.
 */
const SPECIALIST_MARKER_LIKE = /\[\s*\/?\s*SPECIALIST\s+RESULT\b[^\]\n]*\]/gi;

/**
 * Neutralise untrusted (specialist-authored) content: first the consult defang
 * (CONSULT-HANDOFF envelope markers + the `**must-keep**` durability signal, all
 * variants) via the shared neutralizeBlockContent, then this envelope's own
 * SPECIALIST-RESULT markers. Both defangs keep the words, remove the fence.
 */
export function neutralizeSpecialistBlockContent(text: string): string {
	return neutralizeBlockContent(text).replace(SPECIALIST_MARKER_LIKE, (marker) => marker.replace(/[[\]]/g, ""));
}

export interface SpecialistHandoffInput {
	/** The specialist template id, e.g. "deck" / "diagram-svg" — trusted (registry slug), on both fences. */
	templateId: string;
	/** The template version → rendered `v<version>` on the Template line. */
	templateVersion: number;
	/** The one-line task title (from the brief); flattened to one line, capped, neutralised. */
	taskTitle: string;
	/** ISO-8601 time the specialist ran → the Template line's `ran <ISO>`. */
	ranAtIso: string;
	/** Artifact-store-relative paths (`tasks/<taskId>/…`); each validated + neutralised. */
	artifactPaths: string[];
	/** The distilled result summary; capped at 4,000 chars, neutralised. */
	summary: string;
}

/** Flatten to a single physical line so authored newlines can't inject grammar lines. */
function flattenToLine(text: string): string {
	return String(text ?? "").replace(/[\r\n]+/g, " ");
}

/**
 * Validate ONE artifact path to store-relative form. A path that is absolute,
 * contains a `..` traversal segment, carries a newline, or does not start with
 * the `tasks/` store prefix is REPLACED with the literal invalid-path marker —
 * never emitted, so a poisoned path can neither point outside the store nor
 * inject a grammar line. A valid path is still defensively neutralised.
 */
function sanitizeArtifactPath(raw: string): string {
	const path = String(raw ?? "");
	if (!path) return SPECIALIST_HANDOFF_INVALID_PATH;
	if (/[\r\n]/.test(path)) return SPECIALIST_HANDOFF_INVALID_PATH;
	if (path.startsWith("/")) return SPECIALIST_HANDOFF_INVALID_PATH; // absolute
	if (path.includes("..")) return SPECIALIST_HANDOFF_INVALID_PATH; // traversal
	if (!path.startsWith("tasks/")) return SPECIALIST_HANDOFF_INVALID_PATH; // not store-relative
	return neutralizeSpecialistBlockContent(path);
}

/** The artifact path lines: first ARTIFACTS_MAX sanitized paths, then a `(+N more)` overflow line. */
function buildArtifactLines(paths: string[]): string[] {
	const sanitized = (paths ?? []).map(sanitizeArtifactPath);
	if (sanitized.length === 0) return [SPECIALIST_HANDOFF_NO_ARTIFACTS];
	const shown = sanitized.slice(0, SPECIALIST_HANDOFF_ARTIFACTS_MAX);
	const overflow = sanitized.length - SPECIALIST_HANDOFF_ARTIFACTS_MAX;
	return overflow > 0 ? [...shown, `(+${overflow} more)`] : shown;
}

/**
 * Fit the summary within `budget` chars (the room left for the summary element
 * after the fixed skeleton + closing fence). Primary behaviour matches
 * consult-handoff's capConsultHandoffAnswer: keep the first 4,000 chars of
 * content and append the trim marker on a new line. Only when the budget is
 * itself below that (a pathological title/paths payload) is the content trimmed
 * harder so the whole block still fits — the absolute fallback in the builder is
 * the final backstop.
 */
function fitSummary(summary: string, budget: number): string {
	const text = String(summary ?? "");
	// No content trim needed, and it already fits the budget.
	if (text.length <= SPECIALIST_HANDOFF_SUMMARY_MAX_CHARS && text.length <= budget) return text;
	// Primary cap: first 4,000 chars + marker (consult parity).
	if (text.length > SPECIALIST_HANDOFF_SUMMARY_MAX_CHARS) {
		const capped = `${text.slice(0, SPECIALIST_HANDOFF_SUMMARY_MAX_CHARS)}\n${SPECIALIST_HANDOFF_TRIM_MARKER}`;
		if (capped.length <= budget) return capped;
	}
	// Budget forces a harder trim (rare): keep as much content as fits + marker.
	const room = Math.max(0, budget - (SPECIALIST_HANDOFF_TRIM_MARKER.length + 1));
	return `${text.slice(0, room)}\n${SPECIALIST_HANDOFF_TRIM_MARKER}`;
}

/**
 * Build the canonical specialist handoff block (§2.2). The line structure — the
 * two Source lines especially — is the spec grammar verbatim; do not restyle.
 * The templateId is the trusted registry slug (parity with consult-handoff's
 * raw slug on the markers); every other string is neutralised. The block is
 * guaranteed ≤ SPECIALIST_HANDOFF_BLOCK_MAX_CHARS.
 */
export function buildSpecialistHandoffBlock(input: SpecialistHandoffInput): string {
	const templateId = String(input.templateId ?? "");
	const version = Number(input.templateVersion);
	const ranAt = String(input.ranAtIso ?? "");
	const count = Array.isArray(input.artifactPaths) ? input.artifactPaths.length : 0;
	const task = neutralizeSpecialistBlockContent(flattenToLine(input.taskTitle)).slice(0, SPECIALIST_HANDOFF_TASK_TITLE_MAX_CHARS);
	const artifactLines = buildArtifactLines(input.artifactPaths);

	// The fixed skeleton (everything but the summary) and the closing fence.
	const skeleton: string[] = [
		`[SPECIALIST RESULT: ${templateId}]`,
		`Task: ${task}`,
		`Template: ${templateId} v${version} · ran ${ranAt} · ${count} artifacts`,
		`Artifacts:`,
		...artifactLines,
		`Source: ephemeral specialist session, no memory access; this room only knows this`,
		`distilled result and the artifact paths. Full transcript viewable in the task card only.`,
	];
	const closing = `[/SPECIALIST RESULT: ${templateId}]`;

	// Budget for the summary element: total cap minus the skeleton, the closing
	// fence, and the two newlines that join the summary between them.
	const fixedLength = skeleton.join("\n").length + closing.length + 2;
	const budget = SPECIALIST_HANDOFF_BLOCK_MAX_CHARS - fixedLength;
	const summary = fitSummary(neutralizeSpecialistBlockContent(input.summary), budget);

	const block = [...skeleton, summary, closing].join("\n");
	if (block.length <= SPECIALIST_HANDOFF_BLOCK_MAX_CHARS) return block;

	// Absolute backstop (title/paths pathologically large): truncate the body but
	// ALWAYS keep the closing fence intact — the fence is security-relevant (it is
	// what the defang makes un-forgeable). ≤12k is an invariant, never emit over.
	const closingWithNewline = `\n${closing}`;
	return block.slice(0, SPECIALIST_HANDOFF_BLOCK_MAX_CHARS - closingWithNewline.length) + closingWithNewline;
}
