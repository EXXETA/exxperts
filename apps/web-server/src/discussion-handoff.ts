// Shared by the Memorize and Review discussion signoff paths.
//
// Both signoff workers generate a handoff that the client posts back verbatim
// to /propose, where a hard character cap rejects it. Before this module the
// server generated that text uncapped and then refused its own output, so a
// long discussion ended on a raw "assessmentHandoff.text is too large" with
// no way forward. The handoff is derived text the user never reads (the
// proposal operator does), so it is the one worker output the house trims
// instead of refusing — section-aware, with the low-signal transcript summary
// shed first, and the two sections that carry the user's voice ("User
// guidance") and the unresolved-uncertainty channel ("Needs judgment") never
// on the shed list. Candidate memory is never trimmed; that doctrine is
// unchanged.

export const DISCUSSION_HANDOFF_MAX_CHARS = 8000;
/** Soft targets stated in the signoff prompt — headroom under the hard cap. */
export const DISCUSSION_HANDOFF_TARGET_CHARS = 6000;
export const DISCUSSION_HANDOFF_TARGET_WORDS = 1000;
// The assessment twin of the same idea: the request parsers in
// persistent-agents.ts cap assessmentMarkdown at ASSESSMENT_MAX_CHARS; the
// assessment prompts ask for the soft target so a generated assessment stays
// clear of the cap it will meet on the next request.
export const ASSESSMENT_MAX_CHARS = 12000;
export const ASSESSMENT_TARGET_CHARS = 7000;
export const ASSESSMENT_TARGET_WORDS = 1200;
export const DISCUSSION_HANDOFF_TRIM_MARKER = "_(trimmed to fit the handoff limit)_";

// The shed order, lowest-signal first. It keeps "User guidance" and "Needs
// judgment" off the list: the first is the user's own steer, the second is
// where the worker parks what it could not resolve. If shedding everything
// sheddable still does not fit, the tail cut below is the last resort and the
// disclosure says exactly that.
export const ABSORB_HANDOFF_SHED_ORDER = ["Transcript summary", "Update existing memory", "Clear / forget", "Learn / memorize"] as const;
export const HANDOFF_PROTECTED_SECTIONS = ["User guidance", "Needs judgment"] as const;

export interface DiscussionHandoffFit {
	text: string;
	/** Section headings whose bodies were replaced by the trim marker, in shed order. */
	trimmedSections: string[];
	/** True when even shedding every sheddable section was not enough and the tail was cut. */
	tailCut: boolean;
	/** Protected sections ("User guidance", "Needs judgment") still present and intact in the result. */
	keptProtectedSections: string[];
}

interface HandoffSection {
	/** The heading marker as written (`##`, `###`, `####`) so the rebuilt text keeps the model's levels. */
	marker: string;
	heading: string;
	body: string;
}

// Sections are any `##`–`####` heading: the signoff prompts ask for `###`,
// but a model that writes `##` or `####` carries the same content, and
// reading it as "no sections" used to turn a section-aware trim into a blind
// tail cut. The document title (`## Absorb discussion signoff`) becomes an
// empty-bodied section, which is harmless: it is never on a shed list.
const HEADING = /^(#{2,4})\s+(.+?)\s*$/;

// Fenced code opens with ``` or ~~~ (CommonMark's two fence characters) and
// closes only with a fence of the same character at least as long.
const FENCE = /^\s*(`{3,}|~{3,})/;

interface OpenFence {
	char: "`" | "~";
	len: number;
}

function advanceFenceState(open: OpenFence | null, line: string): OpenFence | null {
	const match = FENCE.exec(line);
	if (!match) return open;
	const char = match[1][0] as OpenFence["char"];
	if (open === null) return { char, len: match[1].length };
	return open.char === char && match[1].length >= open.len ? null : open;
}

function splitHandoffSections(text: string): { head: string; sections: HandoffSection[] } {
	const lines = text.split(/\r?\n/);
	// A heading-shaped line inside a fenced code block is quoted content, not a
	// section boundary: splitting on it would shear the fence across two
	// sections, and shedding either half would strand an orphan fence in the
	// proposal prompt (balanceCodeFences only guards the tail cut).
	const splitOnce = (trackFences: boolean) => {
		const headLines: string[] = [];
		const sections: HandoffSection[] = [];
		let current: { marker: string; heading: string; lines: string[] } | null = null;
		let fence: OpenFence | null = null;
		for (const line of lines) {
			if (trackFences) fence = advanceFenceState(fence, line);
			const match = fence ? null : HEADING.exec(line);
			if (match) {
				if (current) sections.push({ marker: current.marker, heading: current.heading, body: current.lines.join("\n") });
				current = { marker: match[1], heading: match[2], lines: [] };
				continue;
			}
			if (current) current.lines.push(line);
			else headLines.push(line);
		}
		if (current) sections.push({ marker: current.marker, heading: current.heading, body: current.lines.join("\n") });
		return { head: headLines.join("\n"), sections, fenceLeftOpen: fence !== null };
	};
	const fenced = splitOnce(true);
	// A fence still open at end-of-text means the input was never well-fenced:
	// trusting it swallows every section after the opener into one body, a shed
	// then deletes them wholesale, and the disclosure reports the swallowed
	// protected sections as kept. Re-split with fences ignored instead.
	if (!fenced.fenceLeftOpen) return { head: fenced.head, sections: fenced.sections };
	const blind = splitOnce(false);
	return { head: blind.head, sections: blind.sections };
}

function joinHandoffSections(head: string, sections: HandoffSection[]): string {
	const parts = [head.trimEnd()];
	for (const section of sections) parts.push(`${section.marker} ${section.heading}${section.body.trim() ? `\n\n${section.body.trim()}` : ""}`);
	return `${parts.filter((part) => part.trim()).join("\n\n")}\n`;
}

function normalizeHeading(heading: string): string {
	return heading.replace(/[*_`:]/g, "").trim().toLowerCase();
}

function findSection(sections: HandoffSection[], name: string): HandoffSection | undefined {
	const wanted = normalizeHeading(name);
	return sections.find((candidate) => normalizeHeading(candidate.heading).startsWith(wanted));
}

// A tail cut can land inside a fenced code block; the broken fence would then
// be embedded verbatim in the proposal prompt and swallow the output contract
// that follows it. Close it — with the fence character that is actually open.
function balanceCodeFences(text: string): string {
	let fence: OpenFence | null = null;
	for (const line of text.split(/\r?\n/)) fence = advanceFenceState(fence, line);
	return fence ? `${text.trimEnd()}\n${fence.char.repeat(Math.max(3, fence.len))}` : text;
}

// Fence-blind: is a heading-shaped line for this section anywhere in the raw
// text? Used as the ground truth for "the signoff never wrote this section" —
// the split alone cannot be that ground truth, because a section the splitter
// loses (the exact shape of a splitter bug) is absent from both the before and
// after lists and would read as never-written.
function headingPresentAnywhere(text: string, name: string): boolean {
	const wanted = normalizeHeading(name);
	for (const line of text.split(/\r?\n/)) {
		const match = HEADING.exec(line);
		if (match && normalizeHeading(match[2]).startsWith(wanted)) return true;
	}
	return false;
}

function keptProtectedSections(text: string, original: HandoffSection[], originalText: string): string[] {
	const after = splitHandoffSections(text).sections;
	return HANDOFF_PROTECTED_SECTIONS.filter((name) => {
		const before = findSection(original, name);
		// Never written means nothing was lost: counting it as kept stops the
		// disclosure from warning about a section the signoff did not produce.
		// But "never written" is judged against the raw text, not the split —
		// a heading the splitter lost is unknown, and unknown reads pessimistic.
		if (!before) return !headingPresentAnywhere(originalText, name);
		const now = findSection(after, name);
		return !!now && now.body.trim() === before.body.trim();
	});
}

/**
 * Fit a signoff handoff under `maxChars` by shedding section bodies in
 * `shedOrder` (first entry goes first), each replaced by a disclosed marker.
 * Sections not named in `shedOrder` are never shed. If the text still does
 * not fit after every sheddable section is gone, the tail is cut as a last
 * resort so the cap downstream can never reject the server's own output —
 * and `keptProtectedSections` tells the disclosure what survived.
 */
export function fitDiscussionHandoff(text: string, shedOrder: readonly string[], maxChars = DISCUSSION_HANDOFF_MAX_CHARS): DiscussionHandoffFit {
	const trimmed = text.trim();
	const { head, sections } = splitHandoffSections(trimmed);
	const original = sections.map((section) => ({ ...section }));
	if (trimmed.length <= maxChars) return { text: trimmed, trimmedSections: [], tailCut: false, keptProtectedSections: keptProtectedSections(trimmed, original, trimmed) };
	const trimmedSections: string[] = [];
	let current = trimmed;
	for (const name of shedOrder) {
		const section = findSection(sections, name);
		if (!section || section.body === DISCUSSION_HANDOFF_TRIM_MARKER || !section.body.trim()) continue;
		section.body = DISCUSSION_HANDOFF_TRIM_MARKER;
		trimmedSections.push(section.heading);
		current = joinHandoffSections(head, sections);
		if (current.length <= maxChars) return { text: current.trim(), trimmedSections, tailCut: false, keptProtectedSections: keptProtectedSections(current, original, trimmed) };
	}
	const suffix = `\n\n${DISCUSSION_HANDOFF_TRIM_MARKER}`;
	// Leave room for a closing fence so the balanced result still fits. A fence
	// can be longer than the usual three characters (its closer must match its
	// length), so re-cut until the balanced result is actually under the cap.
	let budget = Math.max(0, maxChars - suffix.length - 4);
	let result = "";
	for (;;) {
		const cut = balanceCodeFences(current.slice(0, budget).trimEnd());
		result = `${cut}${suffix}`.trim();
		if (result.length <= maxChars || budget === 0) break;
		budget = Math.max(0, budget - (result.length - maxChars));
	}
	return { text: result, trimmedSections, tailCut: true, keptProtectedSections: keptProtectedSections(result, original, trimmed) };
}

// User-facing (it rides the response warnings and is rendered on the proposal
// screen): product vocabulary only, and every claim derived from the fit —
// "your guidance and open questions were kept" is said only when both
// protected sections are intact.
export function describeHandoffTrim(fit: DiscussionHandoffFit, maxChars = DISCUSSION_HANDOFF_MAX_CHARS): string | null {
	if (fit.trimmedSections.length === 0 && !fit.tailCut) return null;
	const shed = fit.trimmedSections.length
		? `its ${fit.trimmedSections.map((heading) => `"${heading}"`).join(", ")} ${fit.trimmedSections.length === 1 ? "section was" : "sections were"} trimmed`
		: "";
	const tail = fit.tailCut ? "its end was cut off" : "";
	const what = [shed, tail].filter(Boolean).join(" and ");
	const guidanceKept = fit.keptProtectedSections.includes("User guidance");
	const judgmentKept = fit.keptProtectedSections.includes("Needs judgment");
	const kept = guidanceKept && judgmentKept
		? "your guidance and open questions were kept"
		: guidanceKept
			? "your guidance was kept, but the open questions may be incomplete"
			: judgmentKept
				? "the open questions were kept, but your guidance may be incomplete"
				: "parts of your guidance and open questions may be missing — check the draft against the discussion";
	return `the discussion summary handed to the draft ran past its ${maxChars}-character limit, so ${what}; ${kept}`;
}

// --- Discussion prompt transcript ladder -----------------------------------
//
// Discussion prompts carry the room's memory plus the whole transcript. Memory
// cannot be elided honestly (it is the material), but the transcript can:
// older, longer messages are trimmed in stages until the prompt fits the
// target, and the latest turns are kept whole. Only if the tightest stage
// still overflows does the step refuse.

export interface DiscussionTranscriptMessage {
	role: "user" | "assistant";
	content: string;
}

export interface DiscussionTranscriptReductionStage {
	stage: number;
	/** Max characters per message outside the protected tail; Infinity = untouched. */
	perMessageChars: number;
	/** Keep only this many most-recent messages; Infinity = all. */
	keepLast: number;
	/** The most recent N messages (user and assistant turns alike) are never trimmed. */
	protectLast: number;
}

export const DISCUSSION_TRANSCRIPT_REDUCTION_STAGES: readonly DiscussionTranscriptReductionStage[] = [
	{ stage: 0, perMessageChars: Number.POSITIVE_INFINITY, keepLast: Number.POSITIVE_INFINITY, protectLast: 0 },
	{ stage: 1, perMessageChars: 4000, keepLast: Number.POSITIVE_INFINITY, protectLast: 4 },
	{ stage: 2, perMessageChars: 1500, keepLast: Number.POSITIVE_INFINITY, protectLast: 4 },
	{ stage: 3, perMessageChars: 1500, keepLast: 12, protectLast: 4 },
];

export const DISCUSSION_TRANSCRIPT_TRIM_MARKER = "[… trimmed to fit the prompt]";

export interface DiscussionTranscriptReduction<T extends DiscussionTranscriptMessage> {
	stage: number;
	messages: T[];
	trimmedMessageCount: number;
	droppedMessageCount: number;
	protectedMessageCount: number;
}

export function reduceDiscussionTranscript<T extends DiscussionTranscriptMessage>(messages: readonly T[], stage: DiscussionTranscriptReductionStage): DiscussionTranscriptReduction<T> {
	const dropped = Number.isFinite(stage.keepLast) ? Math.max(0, messages.length - stage.keepLast) : 0;
	const kept = messages.slice(dropped);
	const protectedFrom = Math.max(0, kept.length - stage.protectLast);
	let trimmedMessageCount = 0;
	const reduced = kept.map((message, index) => {
		let content = message.content;
		if (index < protectedFrom && Number.isFinite(stage.perMessageChars) && content.length > stage.perMessageChars) {
			content = `${content.slice(0, stage.perMessageChars).trimEnd()}\n\n${DISCUSSION_TRANSCRIPT_TRIM_MARKER}`;
			trimmedMessageCount += 1;
		}
		if (index === 0 && dropped > 0) content = `[${dropped} earlier ${dropped === 1 ? "message" : "messages"} omitted to fit the prompt]\n\n${content}`;
		return content === message.content ? message : { ...message, content };
	});
	return {
		stage: stage.stage,
		messages: reduced,
		trimmedMessageCount,
		droppedMessageCount: dropped,
		protectedMessageCount: Math.min(stage.protectLast, kept.length),
	};
}

// User-facing (rides the response warnings): product vocabulary only.
export function describeTranscriptReduction(reduction: DiscussionTranscriptReduction<DiscussionTranscriptMessage>): string | null {
	if (reduction.trimmedMessageCount === 0 && reduction.droppedMessageCount === 0) return null;
	const parts: string[] = [];
	if (reduction.droppedMessageCount > 0) parts.push(`the ${reduction.droppedMessageCount} oldest ${reduction.droppedMessageCount === 1 ? "message was" : "messages were"} left out`);
	if (reduction.trimmedMessageCount > 0) parts.push(`${reduction.trimmedMessageCount} long ${reduction.trimmedMessageCount === 1 ? "message was" : "messages were"} shortened`);
	const kept = reduction.protectedMessageCount > 0 ? `; the last ${reduction.protectedMessageCount} ${reduction.protectedMessageCount === 1 ? "turn was" : "turns were"} kept in full` : "";
	return `the discussion was trimmed so the model could read it back in one go (${parts.join(" and ")})${kept}`;
}
