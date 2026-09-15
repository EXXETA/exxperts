// The Review's FIRST READ and the discussion that follows it.
//
// The first read is one model call over the room's notes as the room itself
// reads them — the context render, every note carrying its own id, every topic
// that has archived notes carrying its pointer line — and it answers in four
// fixed sections. Three of them are for the person: what could be shorter,
// what looks stale or contradicts itself, and what needs their call. The
// fourth, "Topics to tidy", is for the machine: the titles the run works on.
// The screen never shows it.
//
// The discussion is the same pair of calls Memorize has: a turn that talks the
// first read over with the person and can do nothing else, and a sign-off that
// reads the whole transcript back as the six lists the run honours. The turn
// prompt's boundary paragraph is the Memorize one with its noun changed, so
// the two discussions refuse in exactly the same words.
//
// Nothing here reads or writes a file. It takes the render and the topic map it
// is given and returns text, which is what makes it testable without a room.

import { extractAssessmentSection } from "./assessment-parsing.js";
import { duplicateNoteSentence, findDuplicateNotePairs, findLookAlikeTopics, lookAlikeTopicSentence, type LookAlikeTopicPair } from "./memory-duplicates.js";
import type { MemoryDocument } from "./memory-entries.js";
import { emptyReviewGuidance, type ReviewGuidance } from "./review-guidance.js";
import { estimateTokens } from "./token-estimate.js";

export const REVIEW_ASSESSMENT_WORKER_TYPE = "review-first-read-worker" as const;
export const REVIEW_DISCUSSION_WORKER_TYPE = "review-discussion-worker" as const;
export const REVIEW_ASSESSMENT_MODE = "review_first_read" as const;
export const REVIEW_DISCUSSION_MODE = "review_discussion" as const;

/** How far the tidy is allowed to go. The first read recommends one; the person chooses. */
export type ReviewDepth = "wording" | "tidy";

export const REVIEW_DISCUSSION_TOKEN_BUDGET = {
	softWarning: 75000,
	hardStop: 100000,
} as const;

/** At most this many questions come back from a first read; the rest are dropped. */
export const REVIEW_MAX_QUESTIONS = 4;

/** At most this many lines survive per guidance list, the same ceiling the wire reader holds. */
export const REVIEW_GUIDANCE_MAX_LINES = 40;

/**
 * The four headings, in the order the first read writes them. The prompt and
 * the parser both read this map, so a heading can never be changed in one of
 * them alone.
 */
export const REVIEW_ASSESSMENT_HEADINGS = {
	couldBeShorter: "Could be shorter",
	staleOrContradicts: "Looks stale or contradicts itself",
	needsYourCall: "Needs your call",
	topics: "Topics to tidy",
} as const;

/** The six sign-off headings, in the order the sign-off writes them. */
export const REVIEW_GUIDANCE_HEADINGS: Record<keyof ReviewGuidance, string> = {
	keepAsIs: "Keep as is",
	shorten: "Shorten",
	remove: "Remove",
	answers: "Answers",
	instructions: "Instructions",
	topics: "Topics",
};

/**
 * The one wording rule both prompts carry, copied from the Memorize assessment
 * and given the Review's nouns: the person reads topics and notes, never the
 * engine's names for them.
 */
export const REVIEW_BUSINESS_WORDING = `Write for a business user: call each area a topic and name it by its title; do not use the words "Deep Memory", "Active Items", "entry", "entries", "section", "subsection", "token", "tokens", "area" or "L1b" in the bullets, and do not quote sizes in words or tokens.`;

/**
 * The discussion's boundary paragraph: the Memorize one, noun for noun, with
 * "the update" become "the tidy". It is what stops a discussion operator from
 * announcing work it cannot do.
 */
export const REVIEW_CANNOT_ACT_PARAGRAPH = `Write for a business user, in their words: call each area a topic and name it by its title; say "notes" for what the room knows and "open items" for what it still has open, and never use the words "Deep Memory", "Active Items", "entry", "entries", "section", "subsection", "token", "tokens", "area" or "L1b"; do not quote sizes in words or tokens. Call this work "the tidy" and never "the prune". Keep the reply short: confirm what the tidy will do in a few lines, and ask at most one question. You cannot start, draft, generate or save anything yourself, and nothing happens until the person presses Continue: never say you will proceed, generate or hand off. When they have nothing more to add, end with: "Press Continue when you are ready."`;

export interface ReviewModelLock {
	provider: string;
	model: string;
	label?: string;
}

/** One topic of the memory, as the first read is told about it. */
export interface ReviewTopicRow {
	title: string;
	section: string;
	notes: number;
	tokens: number;
}

export interface ReviewPromptTelemetry {
	promptChars: number;
	promptEstimatedTokens: number;
	topicCount: number;
	noteCount: number;
}

export interface ReviewAssessmentPromptInput {
	/** The notes as the room reads them: ids visible, archive pointer lines included. */
	contextRender: string;
	topics: ReviewTopicRow[];
	budgetTokens: number;
	reviewTargetTokens: number;
	/** "Reassess": the previous first read's parse warnings, so this one corrects them. */
	retryFeedback?: string[];
	agentId?: string;
	model?: ReviewModelLock;
	now?: Date;
}

export interface ReviewPromptAssembly {
	prompt: string;
	telemetry: ReviewPromptTelemetry;
}

export interface ReviewAssessmentFields {
	couldBeShorter: string[];
	staleOrContradicts: string[];
	needsYourCall: string[];
	/** The machine's own finding, shown: one sentence per pair of notes that say one thing. */
	saysTheSameTwice: string[];
	/** Machine-read: the pairs behind those sentences, by id and topic. Never shown. */
	duplicateNotes: { ids: [string, string]; topics: [string, string] }[];
	/** The machine's own finding, shown: one sentence per pair of topics that name one subject. */
	topicsThatLookTheSame: string[];
	/** Machine-read: the pairs behind those sentences. Never shown. */
	lookAlikeTopics: LookAlikeTopicPair[];
	/** Machine-read: the titles the run tidies. Never shown. */
	topics: string[];
}

/**
 * What the machine finds in a memory without asking a model: the notes that
 * say one thing and the topics that name one subject. The first read and the
 * discussion both carry it; the run computes the same pairs again at prepass.
 */
export interface ReviewMachineFindings {
	saysTheSameTwice: string[];
	duplicateNotes: { ids: [string, string]; topics: [string, string] }[];
	topicsThatLookTheSame: string[];
	lookAlikeTopics: LookAlikeTopicPair[];
}

export function reviewMachineFindings(doc: MemoryDocument): ReviewMachineFindings {
	const pairs = findDuplicateNotePairs(doc);
	const lookAlike = findLookAlikeTopics(doc);
	return {
		saysTheSameTwice: pairs.map(duplicateNoteSentence),
		duplicateNotes: pairs.map((pair) => ({ ids: [pair.a.id, pair.b.id], topics: [pair.a.topic, pair.b.topic] })),
		topicsThatLookTheSame: lookAlike.map(lookAlikeTopicSentence),
		lookAlikeTopics: lookAlike.map((pair) => ({ a: pair.a, b: pair.b })),
	};
}

/**
 * The model's read with the machine's findings filled in. Every topic a pair
 * names joins "Topics to tidy" (each title once, in the order the memory holds
 * them), so the tidy is handed the pair whether or not the model named it.
 */
export function withMachineFindings(fields: ReviewAssessmentFields, findings: ReviewMachineFindings, knownTopics: readonly string[]): ReviewAssessmentFields {
	const wanted = new Set([...findings.duplicateNotes.flatMap((pair) => pair.topics), ...findings.lookAlikeTopics.flatMap((pair) => [pair.a, pair.b])]);
	const topics = [...fields.topics];
	for (const title of knownTopics) if (wanted.has(title) && !topics.includes(title)) topics.push(title);
	return {
		...fields,
		saysTheSameTwice: [...findings.saysTheSameTwice],
		duplicateNotes: findings.duplicateNotes.map((pair) => ({ ids: [...pair.ids] as [string, string], topics: [...pair.topics] as [string, string] })),
		topicsThatLookTheSame: [...findings.topicsThatLookTheSame],
		lookAlikeTopics: findings.lookAlikeTopics.map((pair) => ({ a: pair.a, b: pair.b })),
		topics,
	};
}

export type ReviewDiscussionRole = "user" | "assistant";

export interface ReviewDiscussionMessage {
	role: ReviewDiscussionRole;
	content: string;
}

export type ReviewDiscussionTokenBudgetState = "ok" | "soft_warning" | "hard_stop";

export interface ReviewDiscussionTokenBudget {
	promptEstimatedTokens: number;
	softWarningTokens: number;
	hardStopTokens: number;
	state: ReviewDiscussionTokenBudgetState;
	canContinue: boolean;
	canSignOff: boolean;
}

export interface ReviewDiscussionPromptInput extends ReviewAssessmentPromptInput {
	assessmentMarkdown: string;
	messages: ReviewDiscussionMessage[];
	userMessage?: string;
	/** The machine's findings, as the first read showed them, so the discussion can talk about them. */
	saysTheSameTwice?: string[];
	topicsThatLookTheSame?: string[];
}

export interface ReviewDiscussionPromptAssembly extends ReviewPromptAssembly {
	tokenBudget: ReviewDiscussionTokenBudget;
}

// --- Whether a review can run at all -----------------------------------------

export type ReviewAvailabilityReason = "available" | "room_busy" | "not_migrated" | "no_notes" | "run_active";

export interface ReviewAvailability {
	available: boolean;
	reason: ReviewAvailabilityReason;
	message: string;
	topics: number;
	notes: number;
	budgetTokens: number;
	reviewTargetTokens: number;
	overBudget: boolean;
	/** Which of the two tidies the screen offers first, before the first read comes back. */
	recommendedDepth: ReviewDepth;
}

export interface ReviewAvailabilityInput {
	/** The room is mid-turn: the notes are being read right now. */
	roomBusy: boolean;
	/** The notes already carry their own ids. */
	migrated: boolean;
	/** A tidy is already running in this room. */
	runActive: boolean;
	topics: ReviewTopicRow[];
	budgetTokens: number;
	reviewTargetTokens: number;
}

const REVIEW_UNAVAILABLE_SENTENCES: Record<Exclude<ReviewAvailabilityReason, "available">, string> = {
	room_busy: "This room is in the middle of a turn. Wait for it to finish, then review its notes.",
	not_migrated: "This room's notes are not ready for a review yet. Open its memory once, then come back.",
	no_notes: "This room has no notes to review yet.",
	run_active: "This room is already tidying its notes. Wait for that to finish.",
};

/** What the screen is told before a single model call is made. */
export function reviewAvailability(input: ReviewAvailabilityInput): ReviewAvailability {
	const overBudget = input.reviewTargetTokens > input.budgetTokens;
	const reason: ReviewAvailabilityReason = input.roomBusy
		? "room_busy"
		: !input.migrated
			? "not_migrated"
			: countNotes(input.topics) === 0
				? "no_notes"
				: input.runActive
					? "run_active"
					: "available";
	return {
		available: reason === "available",
		reason,
		message: reason === "available" ? "Review is available." : REVIEW_UNAVAILABLE_SENTENCES[reason],
		topics: input.topics.length,
		notes: countNotes(input.topics),
		budgetTokens: input.budgetTokens,
		reviewTargetTokens: input.reviewTargetTokens,
		overBudget,
		recommendedDepth: recommendedReviewDepth({ overBudget, staleOrContradicts: [], lookAlikeTopics: false }),
	};
}

// --- Shared prompt parts -----------------------------------------------------

function reviewConstitution(): string {
	return `# exxperts Review Constitution

You are a platform-owned Review worker inside exxperts.

You are not the room's agent and you are not ordinary chat. You are an ephemeral maintenance process, invoked to read the room's notes as an artifact and say what a tidy would do to them.

This operation writes nothing. It does not change the notes, the archive or the room's dates, and it never claims that anything has been saved.

## What a tidy is for

The notes serve the room's future, not its past. The question for every note is whether it still helps the room going forward — never whether it was true once. A tidy makes what is live shorter and clearer, and moves what is finished or stale to the archive, where the room can still reach it. Nothing is ever deleted: the archive is the only way out.

A note the person asked to keep is kept, always. A note that a newer note replaces or contradicts is dead at any age. A finished open item is dead. What happened when, plans, statuses and threads lose their worth with age; who the person is, how they work, the decisions they made and why, and the shape of the work do not — those go only when something newer replaces them.

## What you may read

You are given this room's notes as the room reads them, and nothing else. Do not ask for the room's conversations, its dates or anything outside the notes you were handed.`;
}

function processMetadata(input: ReviewAssessmentPromptInput, workerType: string, mode: string, now: Date): string {
	const lines = [
		`- Agent id: ${input.agentId ?? "unknown"}`,
		`- Process type: ${workerType}`,
		`- Mode: ${mode}`,
		`- Trigger time: ${now.toISOString()}`,
		...(input.model ? [`- System-selected model: ${input.model.provider}/${input.model.model}`] : []),
		`- Writes memory: false`,
		`- Topics: ${input.topics.length}`,
		`- Notes: ${countNotes(input.topics)}`,
	];
	return `## Process Metadata\n\n${lines.join("\n")}`;
}

export function countNotes(topics: ReviewTopicRow[]): number {
	return topics.reduce((total, topic) => total + topic.notes, 0);
}

/**
 * The topic map: the titles exactly as the run knows them, so "Topics to tidy"
 * can be matched back to real topics rather than to prose about them.
 */
function formatTopicMap(topics: ReviewTopicRow[]): string {
	if (topics.length === 0) return "This room has no topics yet.";
	return topics.map((topic) => `- "${topic.title}" — ${topic.notes} ${topic.notes === 1 ? "note" : "notes"}, about ${topic.tokens} tokens`).join("\n");
}

function budgetSection(input: ReviewAssessmentPromptInput): string {
	const over = input.reviewTargetTokens > input.budgetTokens;
	return `## How Much The Room Carries\n\n${over
		? `- These notes cost the room about ${input.reviewTargetTokens} estimated tokens against the ~${input.budgetTokens} the person chose to carry — above the budget. Something has to become shorter or go to the archive; rank what is here by how much it still helps the room going forward.`
		: `- These notes cost the room about ${input.reviewTargetTokens} estimated tokens against the ~${input.budgetTokens} the person chose to carry — within the budget. The budget is a ceiling, never a goal: nothing is added or padded because room is left.`}\n- Never quote these numbers to the person. They see their own meter.`;
}

function retryNotice(retryFeedback: string[] | undefined, label: string): string | null {
	if (!retryFeedback?.length) return null;
	return `## Retry Notice\n\nThe person asked for this ${label} again. The previous one had these problems:\n\n${retryFeedback.map((reason) => `- ${reason}`).join("\n")}\n\nProduce a complete, corrected ${label} that resolves every point above while following the Task structure exactly.`;
}

function notesMaterial(input: ReviewAssessmentPromptInput): string {
	return `## Material: This Room's Notes\n\nThis is every note the room carries, as the room itself reads it. Each note opens with its own id in square brackets: \`- [m-0031] The contract renews annually…\` is the note \`m-0031\`, and \`- [m-0032 · pinned] …\` is one the person pinned. A line reading \`_Archived: 4 older entries…_\` under a topic means that topic already has older material in the archive.\n\n${input.contextRender.trim() || "This room has no notes yet."}`;
}

// --- The first read ----------------------------------------------------------

function assessmentTask(input: ReviewAssessmentPromptInput): string {
	return `## Task: First read of these notes

Read the notes above and say what a tidy would do to them. Do not rewrite a single note here — this is the read the person sees before they decide anything.

${REVIEW_BUSINESS_WORDING}

Use exactly this markdown structure, with all four headings, in this order:

## First read

### ${REVIEW_ASSESSMENT_HEADINGS.couldBeShorter}
- 0-5 bullets: topics whose notes say in many words what they could say in few, or repeat each other. Name the topic by its title and say what is loose about it.

### ${REVIEW_ASSESSMENT_HEADINGS.staleOrContradicts}
- 0-5 bullets: notes that look overtaken by something newer, that contradict each other, or that describe work that is finished. Name the topic by its title and say what makes it look stale.

### ${REVIEW_ASSESSMENT_HEADINGS.needsYourCall}
- At most ${REVIEW_MAX_QUESTIONS} short questions, one per bullet, for the person to answer before the tidy runs — only where their answer would change what the tidy does. If you have none, write: None

### ${REVIEW_ASSESSMENT_HEADINGS.topics}
- One topic title per line, exactly as it is written in the topic map above, for every topic the tidy should work on. This list is read by the system and never shown to the person, so write nothing on these lines but the titles. If every topic you named above covers it, list those; if nothing needs work, write: None

Return only the first read. Do not list what looks healthy, do not propose new wording for any note, and do not claim anything has been saved.`;
}

export function buildReviewAssessmentPrompt(input: ReviewAssessmentPromptInput): ReviewPromptAssembly {
	const now = input.now ?? new Date();
	const notice = retryNotice(input.retryFeedback, "first read");
	const prompt = [
		reviewConstitution().trim(),
		processMetadata(input, REVIEW_ASSESSMENT_WORKER_TYPE, REVIEW_ASSESSMENT_MODE, now),
		`## Material: The Topics Of This Room\n\n${formatTopicMap(input.topics)}`,
		budgetSection(input),
		notesMaterial(input),
		...(notice ? [notice] : []),
		assessmentTask(input),
	].join("\n\n---\n\n") + "\n";
	return { prompt, telemetry: promptTelemetry(prompt, input.topics) };
}

/**
 * The Retry Notice shape every maintenance worker's retry takes: the prompt it
 * was given, the reasons as the parser named them, and the ask again.
 */
export function buildReviewAssessmentRetryPrompt(prompt: string, reasons: string[]): string {
	return `${prompt.trimEnd()}\n\n---\n\n## Retry Notice\n\nYour previous first read was not accepted:\n\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n\nProduce the complete first read again using exactly the markdown structure from the Task: plain \`### \` headings reading "${REVIEW_ASSESSMENT_HEADINGS.couldBeShorter}", "${REVIEW_ASSESSMENT_HEADINGS.staleOrContradicts}", "${REVIEW_ASSESSMENT_HEADINGS.needsYourCall}" and "${REVIEW_ASSESSMENT_HEADINGS.topics}", and under the last of them one topic title per line, copied from the topic map. Return only the first read.\n`;
}

function promptTelemetry(prompt: string, topics: ReviewTopicRow[]): ReviewPromptTelemetry {
	return {
		promptChars: prompt.length,
		promptEstimatedTokens: estimateTokens(prompt),
		topicCount: topics.length,
		noteCount: countNotes(topics),
	};
}

// --- Reading the first read --------------------------------------------------

const BULLET = /^\s*[-*+•]\s+/;

function sectionLines(section: string): string[] {
	return section
		.split(/\r?\n/)
		.map((line) => line.replace(BULLET, "").trim())
		.filter(Boolean)
		.filter((line) => !/^#{1,6}\s+/.test(line))
		.filter((line) => !/^none\.?$/i.test(line));
}

/** A title as a model is likely to have written it back: quoted, bolded, backticked, or with a trailing note. */
function normalizeTitle(line: string): string {
	return line
		.replace(/^\s*[-*+•]\s+/, "")
		.replace(/^(?:\*\*|__|`|"|“|”|')+/, "")
		.replace(/(?:\*\*|__|`|"|“|”|')+\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The first read, read back. The three prose sections are bullets the screen
 * shows; "Topics to tidy" is matched against the titles the room actually has,
 * because the run addresses topics by title and a title nobody has is a topic
 * the run would silently skip. A dropped title is named in a warning rather
 * than swallowed.
 */
export function parseReviewAssessment(raw: string, knownTopics: string[] = []): { fields: ReviewAssessmentFields; warnings: string[] } {
	const warnings: string[] = [];
	const read = (heading: string): string[] => {
		const body = extractAssessmentSection(raw, heading);
		if (!body.trim()) {
			warnings.push(`the first read has no "${heading}" section`);
			return [];
		}
		return sectionLines(body);
	};
	const couldBeShorter = read(REVIEW_ASSESSMENT_HEADINGS.couldBeShorter);
	const staleOrContradicts = read(REVIEW_ASSESSMENT_HEADINGS.staleOrContradicts);
	const needsYourCall = read(REVIEW_ASSESSMENT_HEADINGS.needsYourCall).slice(0, REVIEW_MAX_QUESTIONS);
	const named = read(REVIEW_ASSESSMENT_HEADINGS.topics).map(normalizeTitle).filter(Boolean);
	const byLowercase = new Map(knownTopics.map((title) => [title.toLowerCase(), title]));
	const topics: string[] = [];
	const unknown: string[] = [];
	for (const title of named) {
		const known = byLowercase.get(title.toLowerCase());
		if (!known) {
			if (!unknown.includes(title)) unknown.push(title);
			continue;
		}
		if (!topics.includes(known)) topics.push(known);
	}
	if (unknown.length > 0) warnings.push(`the first read named ${unknown.length === 1 ? "a topic" : "topics"} this room does not have: ${unknown.map((title) => `"${title}"`).join(", ")}`);
	// The machine's findings are not the model's to write: they are filled in
	// by the route from the memory itself (withMachineFindings).
	return { fields: { couldBeShorter, staleOrContradicts, needsYourCall, saysTheSameTwice: [], duplicateNotes: [], topicsThatLookTheSame: [], lookAlikeTopics: [], topics }, warnings };
}

/**
 * "Read again" feedback off the wire. It is client input bound for a worker
 * prompt, so the only lines that survive are the two warnings this parser
 * writes itself — anything else is not feedback about a first read, and reads
 * as nothing asked for rather than as an error.
 */
const REVIEW_RETRY_FEEDBACK = [
	/^the first read has no "[A-Za-z][A-Za-z ]{1,60}" section$/,
	/^the first read named (?:a topic|topics) this room does not have: .{1,300}$/,
];

export function parseReviewRetryFeedback(raw: unknown): string[] | undefined {
	const lines = (Array.isArray(raw) ? raw : [])
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.replace(/\s+/g, " ").trim())
		.filter((item) => REVIEW_RETRY_FEEDBACK.some((pattern) => pattern.test(item)))
		.slice(0, 6);
	return lines.length > 0 ? lines : undefined;
}

/**
 * Which tidy the screen offers first: the deeper one when the room is over the
 * limit or the first read found something stale, because both are things only
 * the archive can fix, and when two topics look like one, because folding a
 * topic is structural and "wording" cannot do it; the wording one otherwise.
 * Notes that say the same twice do not force the deeper tidy on their own: a
 * merge is allowed at "wording".
 */
export function recommendedReviewDepth(input: { overBudget: boolean; staleOrContradicts: string[]; lookAlikeTopics: boolean }): ReviewDepth {
	return input.overBudget || input.staleOrContradicts.length > 0 || input.lookAlikeTopics ? "tidy" : "wording";
}

// --- The discussion ----------------------------------------------------------

export function reviewDiscussionTokenBudget(promptEstimatedTokens: number): ReviewDiscussionTokenBudget {
	const state: ReviewDiscussionTokenBudgetState = promptEstimatedTokens >= REVIEW_DISCUSSION_TOKEN_BUDGET.hardStop
		? "hard_stop"
		: promptEstimatedTokens >= REVIEW_DISCUSSION_TOKEN_BUDGET.softWarning
			? "soft_warning"
			: "ok";
	return {
		promptEstimatedTokens,
		softWarningTokens: REVIEW_DISCUSSION_TOKEN_BUDGET.softWarning,
		hardStopTokens: REVIEW_DISCUSSION_TOKEN_BUDGET.hardStop,
		state,
		canContinue: state !== "hard_stop",
		canSignOff: true,
	};
}

function formatTranscript(messages: ReviewDiscussionMessage[]): string {
	if (messages.length === 0) return "No prior discussion messages.";
	return messages
		.map((message, index) => `### ${index + 1}. ${message.role === "assistant" ? "Assistant" : "User"}\n\n${message.content.trim() || "(empty)"}`)
		.join("\n\n");
}

function discussionOperatorAddendum(): string {
	return `## Review Discussion Operator Addendum

You are the Review discussion operator. Your job is to help the person decide what the tidy should do with these notes before it starts.

Hard boundaries:

- No tools.
- No file writes.
- No changes to the notes.
- No tidy of your own: the run is a separate operation the person starts.
- No claims that anything has been saved.`;
}

function discussionTurnTask(): string {
	return `## Task: Review discussion turn

Reply to the person's latest message as the Review discussion operator. Help them decide which topics the tidy should work on, what should stay exactly as it is, what should be shorter, and what has finished and can go to the archive. Answer the questions they answer from the first read.

${REVIEW_CANNOT_ACT_PARAGRAPH}

Return only the assistant discussion message.`;
}

function signoffTask(): string {
	return `## Task: Review discussion sign-off

The person is ready to start the tidy. Produce the structured sign-off the run receives. It is read by the system, not by a person: every section is a list of lines, and a section with nothing in it holds the single word None.

Use exactly this markdown structure, with all six sections in this order:

## Review discussion sign-off

### ${REVIEW_GUIDANCE_HEADINGS.keepAsIs}
One line per note or topic the person asked to leave exactly as it is.

### ${REVIEW_GUIDANCE_HEADINGS.shorten}
One line per note or topic the person asked to make shorter.

### ${REVIEW_GUIDANCE_HEADINGS.remove}
One line per note or topic the person asked to move to the archive, with their reason after a dash where they gave one.

### ${REVIEW_GUIDANCE_HEADINGS.answers}
One line per question from the first read that the person answered, as \`question — their answer\`.

### ${REVIEW_GUIDANCE_HEADINGS.instructions}
One plain sentence per line: anything else the person asked the tidy to honour.

### ${REVIEW_GUIDANCE_HEADINGS.topics}
One topic title per line, exactly as it is written in the topic map, for the topics the person wants the tidy to work on. Leave it None when they did not narrow it down.

Write only what the person actually asked for in the discussion. Do not invent topics, do not restate the first read, and do not add commentary around the sections. Return only the sign-off markdown. Do not claim anything has been saved.`;
}

/**
 * The machine's findings as the discussion reads them, one section each, so
 * the operator can talk about the pairs the person saw; an empty list has no
 * section.
 */
function machineFindingsMaterial(input: ReviewDiscussionPromptInput): string[] {
	const sections: string[] = [];
	if (input.saysTheSameTwice?.length) sections.push(`## Material: Notes That Say The Same Twice\n\n${input.saysTheSameTwice.map((line) => `- ${line}`).join("\n")}`);
	if (input.topicsThatLookTheSame?.length) sections.push(`## Material: Topics That Look The Same\n\n${input.topicsThatLookTheSame.map((line) => `- ${line}`).join("\n")}`);
	return sections;
}

function buildDiscussionPrompt(input: ReviewDiscussionPromptInput, task: string): ReviewDiscussionPromptAssembly {
	const now = input.now ?? new Date();
	const parts = [
		reviewConstitution().trim(),
		discussionOperatorAddendum(),
		processMetadata(input, REVIEW_DISCUSSION_WORKER_TYPE, REVIEW_DISCUSSION_MODE, now),
		`## Material: The Topics Of This Room\n\n${formatTopicMap(input.topics)}`,
		budgetSection(input),
		notesMaterial(input),
		`## Material: The First Read\n\n${input.assessmentMarkdown.trim() || "None."}`,
		...machineFindingsMaterial(input),
		`## Material: Discussion So Far\n\n${formatTranscript(input.messages)}`,
		`## Latest Message From The Person\n\n${input.userMessage?.trim() || "None."}`,
		task,
	];
	// The budget block reports the size of the prompt it sits in, so it is
	// measured once without it and then written in at a fixed place.
	const budget = reviewDiscussionTokenBudget(estimateTokens(parts.join("\n\n---\n\n") + "\n"));
	const prompt = [
		...parts.slice(0, 3),
		`## Token Budget State\n\n- Estimated prompt tokens: ${budget.promptEstimatedTokens}\n- Soft warning threshold: ${budget.softWarningTokens}\n- Hard stop threshold: ${budget.hardStopTokens}\n- State: ${budget.state}\n- Can continue discussion: ${budget.canContinue}\n- Can sign off: ${budget.canSignOff}`,
		...parts.slice(3),
	].join("\n\n---\n\n") + "\n";
	return { prompt, tokenBudget: reviewDiscussionTokenBudget(estimateTokens(prompt)), telemetry: promptTelemetry(prompt, input.topics) };
}

export function buildReviewDiscussionTurnPrompt(input: ReviewDiscussionPromptInput): ReviewDiscussionPromptAssembly {
	return buildDiscussionPrompt(input, discussionTurnTask());
}

export function buildReviewSignoffPrompt(input: ReviewDiscussionPromptInput): ReviewDiscussionPromptAssembly {
	return buildDiscussionPrompt(input, signoffTask());
}

/**
 * The sign-off, read into the six lists the run honours. A section the person
 * left empty, that says "None.", or that was never written at all reads as
 * nothing asked for — a discussion the person ended without instructions is a
 * discussion that asked for the first read as it stands, never an error.
 */
export function parseReviewGuidance(markdown: string): ReviewGuidance {
	const guidance = emptyReviewGuidance();
	for (const key of Object.keys(guidance) as Array<keyof ReviewGuidance>) {
		const body = extractAssessmentSection(markdown, REVIEW_GUIDANCE_HEADINGS[key]);
		const lines = body.trim() ? sectionLines(body) : [];
		guidance[key] = (key === "topics" ? lines.map(normalizeTitle) : lines).filter(Boolean).slice(0, REVIEW_GUIDANCE_MAX_LINES);
	}
	return guidance;
}
