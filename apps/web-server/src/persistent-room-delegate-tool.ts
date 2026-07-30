import { Type } from "typebox";
import type { ToolDefinition } from "@exxeta/exxperts-runtime";
import {
	buildSpecialistSessionPlan,
	type SpecialistSessionPlan,
} from "./persistent-room-specialist-execution.js";
import {
	listSpecialistTemplates,
	getSpecialistTemplate,
	SPECIALIST_TASK_CAPS,
	type SpecialistTemplate,
} from "./specialist-templates.js";

/**
 * Visuals V2 room wiring (contract spec §5): the L2 specialist-templates index
 * and the model-proposed `delegate_task` tool.
 *
 * Governance shape (do not weaken):
 * - `delegate_task` never spawns anything by itself. It validates against the
 *   static template registry, then requires USER consent — one of exactly two
 *   forms, both of them the user's own act:
 *     (a) the user's CURRENT message asked for the artifact. The model passes
 *         that request as a verbatim quote (`userRequest`) and the server
 *         verifies it is a real substring of the user-authored text of the
 *         in-flight turn (handoff blocks and attachment notes are stripped
 *         before matching, so model-written wire text can never be quoted as
 *         consent). The message is the consent; the specialist starts without
 *         a card. A quote that fails verification NEVER refuses — it falls
 *         back to (b), so the safe path is always the floor.
 *     (b) the interactive approval card: the approval text names the exact
 *         task-private folder the specialist may write, because approving IS
 *         the write grant (artifacts extension pre-approved scope, V1).
 *   No UI → structural refusal on BOTH paths, which keeps background/CLI
 *   contexts delegation-free without a separate gate.
 * - The launch itself is injected by the connection (run-free beside the
 *   room's turn); this module never touches sessions, sockets, or the store.
 */

export const DELEGATE_TASK_TOOL_NAME = "delegate_task";

/**
 * The L2 specialist-templates index: static registry, so unlike the skills
 * index it carries no user-authored text and needs no defang. Rendered for
 * every web room (v1) — templates are a platform capability, not a setting.
 */
export function buildSpecialistTemplatesIndexSection(templates: readonly SpecialistTemplate[] = listSpecialistTemplates()): string {
	if (templates.length === 0) return "";
	const lines = templates.map((template) => `- ${template.doctrineLine}`);
	return `

## Visual specialists

You can delegate visual work to an ephemeral specialist with the delegate_task tool. A delegation spawns the specialist and grants it write access to one new task-private artifact folder. Specialists have no memory, no web access, and no knowledge of this conversation beyond the brief you write — put ALL needed data in the brief (or reference prior task artifacts via inputArtifacts). Results appear in the room's Files panel, not in this conversation; never claim, invent, or wait for a specialist's results in your reply. Available templates:

${lines.join("\n")}

Consent — WHO initiated decides how the specialist starts:
- The user's CURRENT message asks for the artifact, or plainly green-lights one this conversation already put on the table ("make me a deck from this", "yes, go ahead with the chart") → call delegate_task with userRequest set to their EXACT words that ask for it, copied verbatim from that message. Their message IS the consent: the specialist starts immediately, with no approval step. Never paraphrase the quote, and never pass data-sharing, topic talk, or an answer about something else as if it were a request — when in doubt whether they actually asked, omit userRequest.
- YOU are inferring that a specialist would help when the current message did not ask → call delegate_task WITHOUT userRequest. The app shows the user an approval card with an inline Approve button; that card IS the proposal, so never ask in text first and wait for a typed reply. If the user declines, do not propose it again unless they ask.

Routing — the user's INTENT decides the path, never their exact wording ("chart", "plot", "graph", "diagram", "visualize" are synonyms here):
- A quick sketch serving the current discussion → a small inline Mermaid diagram in the chat. It is ephemeral and that is fine.
- Diagram requests sit on that line: when unsure whether a sketch or a deliverable is wanted, draw the Mermaid sketch AND propose the specialist upgrade (delegate_task without userRequest, same turn) — never coin-flip between the two paths.
- Anything the user will keep, share, or present — a chart of their data, a standalone diagram, a deck, a one-pager — → delegate to the matching specialist, whatever words they used.
- A vague but visualizable request ("make this easier to grasp") → answer briefly in text, then propose a specialist through the approval card (delegate_task without userRequest — a vague request is not consent for a specific artifact). Never silently default to text-only when a kept visual would serve the user better.
- Decks: unless the user already gave them, ask audience, length, and style once — with a stated default so they can just say "go ahead" — before delegating; their answer is then the green-light you can quote as userRequest.
- artifact_write is for content the user explicitly asked to save as a file; creating a designed visual deliverable is specialist work.`;
}

const delegateTaskSchema = Type.Object({
	template: Type.String({ description: "Template id from the visual-specialists list (e.g. deck, diagram-svg, chart-html, document-html)." }),
	brief: Type.String({ description: "Complete standalone working brief for the specialist, including all data it needs. It cannot see this conversation and cannot fetch anything." }),
	expectedResult: Type.Optional(Type.String({ description: "One or two sentences describing the artifact(s) the user expects." })),
	inputArtifacts: Type.Optional(Type.Array(Type.String(), { description: "Store-relative paths of prior task artifacts to build on (e.g. tasks/tsk-abc123/deck.html)." })),
	userRequest: Type.Optional(Type.String({ description: "ONLY when the user's current message itself asks for this artifact: their exact words that ask for it, copied verbatim (no paraphrase). Verified against the message; when it matches, the specialist starts without an approval card. Omit when you are proposing on your own initiative." })),
});

/**
 * The wire prompt is user text PLUS text other actors put in front of it: the
 * client prepends queued handoff blocks (consult/specialist summaries — MODEL
 * written) and `[FILE ATTACHED: …]` notes (app written). Consent verification
 * must only ever match the words the user actually typed, so this strips those
 * leading layers. Parsing leans on guarantees the composers already enforce:
 * blocks ride BEFORE the user text (composeOutgoingPromptWithHandoffs), and
 * block content is neutralised against fence forgery. INVARIANT the fence
 * regexes must keep (adversarial pass, delegation-flow slice): they may only
 * recognise fence shapes the neutralizers actually defang — a full BRACKETED
 * marker line, because neutralizeBlockContent / neutralizeSpecialistBlockContent
 * strip brackets only off `[…]`-closed tokens. A looser recogniser (e.g. a
 * prefix match) accepts the unbracketed `[/SPECIALIST RESULT: x` a hostile
 * summary can still emit, ends the block early, and launders the rest of the
 * model-written block into "user-authored" consent scope. Anything malformed
 * is left in place — an unclosed fence is user-typed text, and over-stripping
 * could only shrink what counts as consent anyway (the fail-safe direction).
 */
export function userAuthoredPromptText(wireText: string): string {
	// The close recogniser is FAMILY-MATCHED to its open (critical-fixes
	// hardening): a consult block only ends at a CONSULT close, a specialist
	// block only at a SPECIALIST close. The neutralizers now defang both
	// families in all untrusted content, so no literal marker should survive
	// into a block at all — but were one ever to, a foreign-family close must
	// not terminate the block early and launder its tail into consent scope.
	const openFence = /^\[(CONSULT HANDOFF FROM|SPECIALIST RESULT:)[^\]\n]*\]$/;
	const closeFence = /^\[\/(CONSULT HANDOFF FROM|SPECIALIST RESULT:)[^\]\n]*\]$/;
	// Deliberately unanchored at the tail: a note line that somehow lost its
	// closing bracket must still strip (stripping MORE is the safe direction —
	// it can only shrink what counts as consent).
	const attachmentNote = /^\[FILE ATTACHED: /;
	const lines = String(wireText ?? "").replace(/\r\n/g, "\n").split("\n");
	let at = 0;
	while (at < lines.length) {
		const line = lines[at].trim();
		if (line === "" || attachmentNote.test(line)) { at++; continue; }
		const open = openFence.exec(line);
		if (!open) break;
		const family = open[1];
		const closeAt = lines.findIndex((candidate, index) => {
			if (index <= at) return false;
			const close = closeFence.exec(candidate.trim());
			return close !== null && close[1] === family;
		});
		if (closeAt < 0) break;
		at = closeAt + 1;
	}
	return lines.slice(at).join("\n").trim();
}

/**
 * Below this (after whitespace collapse), a quote is too generic to carry
 * consent — "a", "it", "yes" match half of all messages. The floor is
 * anti-degenerate only; the real bar ("did the user actually ask?") is the
 * model's judgement under the index-section rules, and a failed floor just
 * means the approval card, never a refusal.
 */
export const USER_REQUEST_MIN_CHARS = 10;

function normalizeForConsentMatch(text: string): string {
	return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A substring test cannot read meaning, so two shapes it would otherwise
 * mechanically bless are rejected outright (adversarial pass): a quote whose
 * matched span sits right after a negation ("please DON'T make me a deck" —
 * the verifier must not stamp "verified" on an inverted request), and a quote
 * that crosses a sentence boundary ("…no deck. Build a chart…" glued into one
 * "request"). Both rejections only downgrade to the approval card.
 *
 * The scan reads the WHOLE sentence prefix before the match, not a fixed
 * window (review hardening): a negation can sit arbitrarily far from the verb
 * it governs — "I do not under any circumstances want you to make me a deck"
 * — and a windowed scan silently verifies exactly the long-winded refusals a
 * user writes when they mean it most. Same-sentence confinement comes from the
 * pattern's own `[^.?!]*$` tail, so widening the input cannot leak a negation
 * across a sentence boundary.
 */
const CONSENT_NEGATION_BEFORE_QUOTE = /\b(?:don'?t|do not|doesn'?t|does not|didn'?t|never|not|no|none|won'?t|wouldn'?t|shouldn'?t|can'?t|cannot|stop|without|nicht|kein|keine|keinen|nie|niemals|ohne)\b[^.?!]*$/i;

/**
 * True when `quote` is a verbatim (case/whitespace-insensitive) span of
 * `userText`, long enough to be meaningful, confined to one sentence, and at
 * least one of its occurrences is not sitting behind a negation.
 */
export function verbatimUserRequestMatches(quote: string, userText: string): boolean {
	// Tolerate cosmetic wrapping the model may add around an otherwise exact
	// quote (quotation marks, trailing period) — the words must still match.
	const normalizedQuote = normalizeForConsentMatch(quote).replace(/^["'“”‘’\s]+/, "").replace(/["'“”‘’\s.?!,;:]+$/, "");
	if (normalizedQuote.length < USER_REQUEST_MIN_CHARS) return false;
	if (/[.?!]\s/.test(normalizedQuote)) return false;
	const haystack = normalizeForConsentMatch(userText);
	for (let at = haystack.indexOf(normalizedQuote); at >= 0; at = haystack.indexOf(normalizedQuote, at + 1)) {
		if (!CONSENT_NEGATION_BEFORE_QUOTE.test(haystack.slice(0, at))) return true;
	}
	return false;
}

type TextToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined; isError?: boolean };

function refusal(text: string, details?: Record<string, unknown>): TextToolResult {
	return { content: [{ type: "text", text }], details };
}

export interface CreateDelegateTaskToolOptions {
	agentId: string;
	/** Concurrent-specialist ceiling (contract D9: 2). */
	taskCap: number;
	runningCount: () => number;
	generateTaskId: () => string;
	/**
	 * The user-authored text of the turn currently being answered (wire prompt
	 * with handoff blocks / attachment notes already stripped), or null outside
	 * a user turn. This is what a `userRequest` quote must verbatim-match for
	 * the no-card auto-dispatch — consent lives in the user's own message, so
	 * only THIS turn's message can grant it.
	 */
	currentUserMessage: () => string | null;
	/**
	 * Per-turn auto-dispatch budget (adversarial pass): the card path was the
	 * de-facto rate limiter and task_iterate got an explicit cooldown when its
	 * click became the consent — the no-card path needs its own bound, or one
	 * verified sentence could be re-quoted to relaunch a specialist every time
	 * the cap slot frees within a turn. Returns true and consumes one unit, or
	 * false when the turn's budget is spent (the tool then falls back to the
	 * approval card — never a refusal).
	 */
	consumeAutoDispatch: () => boolean;
	/**
	 * Fire-and-forget launch injected by the connection: registers the slot,
	 * emits `task_started`, and runs the worker beside the live thread. Must not
	 * throw; a refused launch returns a reason for the model.
	 */
	launch: (plan: SpecialistSessionPlan) => { ok: true } | { ok: false; reason: string };
}

export function createDelegateTaskTool(options: CreateDelegateTaskToolOptions): ToolDefinition<any, any> {
	const { taskCap, runningCount, generateTaskId, currentUserMessage, consumeAutoDispatch, launch } = options;
	return {
		name: DELEGATE_TASK_TOOL_NAME,
		label: "delegate visual task",
		description:
			"Delegate a visual artifact (deck, diagram, chart, document) to an ephemeral specialist. With userRequest (the user's verbatim words asking for it, from their current message) it starts immediately; without, the user is shown an approval card first. Either way the specialist gets write access to one new task-private folder, and results appear in the room's Files panel, never in this conversation.",
		promptSnippet: "Delegate a user-consented visual-specialist task",
		parameters: delegateTaskSchema,
		execute: async (_toolCallId: string, params: { template: string; brief: string; expectedResult?: string; inputArtifacts?: string[]; userRequest?: string }, _signal: unknown, _onUpdate: unknown, ctx: any): Promise<TextToolResult> => {
			const templateId = String(params?.template ?? "").trim();
			const template = getSpecialistTemplate(templateId);
			if (!template) {
				const known = listSpecialistTemplates().map((t) => t.id).join(", ");
				return refusal(`"${templateId}" is not a specialist template. Available templates: ${known}.`, { outcome: "unknown-template" });
			}
			if (runningCount() >= taskCap) {
				return refusal(`The specialist limit (${taskCap} at a time) is reached. Wait for a running task to finish or ask the user to stop one.`, { outcome: "cap-reached" });
			}
			// Validation happens BEFORE the approval prompt: the user is never asked
			// to approve something that could not run.
			let plan: SpecialistSessionPlan;
			try {
				plan = buildSpecialistSessionPlan({
					taskId: generateTaskId(),
					templateId,
					brief: String(params?.brief ?? ""),
					...(params?.expectedResult ? { expectedResult: String(params.expectedResult) } : {}),
					...(Array.isArray(params?.inputArtifacts) ? { inputArtifacts: params.inputArtifacts.map(String) } : {}),
				});
			} catch (e) {
				return refusal(`Delegation not possible: ${(e as Error).message}`, { outcome: "invalid" });
			}
			if (!ctx?.hasUI) {
				return refusal("Delegation requires the interactive room UI; there is no user here to approve it.", { outcome: "no-ui" });
			}
			// Auto-dispatch (delegation-flow slice): the user's own current message
			// asked for this artifact, quoted verbatim by the model and verified
			// mechanically here — the message is the consent, so no card. A quote
			// that does not verify (paraphrased, from an older turn, or lifted from
			// model-written wire text) silently falls through to the approval card:
			// downgrading to ask-the-user is always safe, refusing here never is.
			const requestQuote = typeof params?.userRequest === "string" ? params.userRequest : "";
			if (requestQuote) {
				const userMessage = currentUserMessage();
				if (userMessage && verbatimUserRequestMatches(requestQuote, userMessage) && consumeAutoDispatch()) {
					const autoStarted = launch(plan);
					if (!autoStarted.ok) {
						return refusal(`The specialist could not start: ${autoStarted.reason}`, { outcome: "launch-failed" });
					}
					return {
						content: [{
							type: "text",
							text: `Specialist started (task ${plan.taskId}, template ${template.id}) — dispatched directly on the user's request, no approval step. The user can follow it in the Files panel; results appear there when ready. Tell the user it is underway — do not describe, invent, or wait for its results.`,
						}],
						details: { outcome: "started", dispatch: "auto", taskId: plan.taskId, template: template.id, userRequest: requestQuote },
					};
				}
			}
			// Truncate only the brief text, never the input-artifacts list: those
			// paths are the read grant under review, so they must stay visible no
			// matter how long the model's brief runs.
			const artifactsAt = plan.triggerPrompt.indexOf("\nInput artifacts (");
			const briefHead = artifactsAt >= 0 ? plan.triggerPrompt.slice(0, artifactsAt) : plan.triggerPrompt;
			const artifactsTail = artifactsAt >= 0 ? plan.triggerPrompt.slice(artifactsAt) : "";
			const clippedHead = briefHead.length > 1_200 ? `${briefHead.slice(0, 1_200)}\n[brief preview truncated]` : briefHead;
			const briefPreview = `${clippedHead}${artifactsTail}`;
			// The approval question is the consent: action-first, no jargon. The
			// mechanics (isolation, folder grant, brief) live behind the client's
			// Show details.
			const noun = /^[A-Z]{2,}/.test(template.label) ? template.label : template.label.charAt(0).toLowerCase() + template.label.slice(1);
			const article = /^(svg|html|[aeiou])/i.test(noun) ? "an" : "a";
			const approved = await ctx.ui.confirm(
				`Have a specialist create ${article} ${noun}?`,
				[
					// The guidance the client shows behind "Details": three short
					// paragraphs (isolation, grant, lifecycle), no redundancy. The
					// consent anchors the smoke pins live here, before the separator.
					"A separate specialist runs this task in isolation: no memory access, no web access, no shell.",
					"",
					`It can only write into one new folder made for this task: ${plan.taskFolder}/ (at most ${SPECIALIST_TASK_CAPS.maxArtifacts} files). Approving starts it and grants that folder write access.`,
					"",
					"The result appears in Files, on the left, where the room can read it. Download or save a copy anytime.",
					"",
					// Anti-spoof separator: everything below is the room model's own text
					// appended after the app-drawn facts above; a brief that mimics those
					// fact lines must not be able to pass as the app speaking.
					"─── Brief it will receive (written by the room's model; the app has not verified anything below this line) ───",
					briefPreview,
				].join("\n"),
			);
			if (!approved) {
				return refusal("The user declined the specialist. Do not propose it again unless they ask. If they still want the content, offer to work it out directly in the conversation instead.", { outcome: "declined" });
			}
			const started = launch(plan);
			if (!started.ok) {
				return refusal(`The specialist could not start: ${started.reason}`, { outcome: "launch-failed" });
			}
			return {
				content: [{
					type: "text",
					text: `Specialist started (task ${plan.taskId}, template ${template.id}). The user can follow it in the Files panel; results appear there when ready. Tell the user it is underway — do not describe, invent, or wait for its results.`,
				}],
				details: { outcome: "started", dispatch: "approved", taskId: plan.taskId, template: template.id },
			};
		},
	};
}
