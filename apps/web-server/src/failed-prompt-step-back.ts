// A message the model could not answer goes back to the person: the
// conversation steps back to before it with the runtime's own tree move (its
// "edit and resend"), so the next answer does not answer it too.

import { isSignInFailure } from "../../web-ui/src/sign-in-failure.js";
import { answerStarted, failedTurnKey, failureCodesOf, quotaWayOf, turnFailureOf } from "./model-call-causes.js";
import type { GatewayFind, QuotaWay } from "../../web-ui/src/turn-failure-line.js";
import { gatewayModelFind } from "./gateway-model-find.js";
import { anthropicKeyNeedsWorkspace, type CredentialKey } from "./model-not-offered.js";
import { userAuthoredPromptText } from "./persistent-room-delegate-tool.js";
import { emptyAnswer } from "./usage-log.js";

/** What the step back needs of a room's session. */
interface SteppingSession {
	sessionManager: {
		getLeafEntry(): StepEntry | undefined;
		getEntry(id: string): StepEntry | undefined;
		appendCustomEntry(customType: string, data?: unknown): string;
	};
	navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
}

interface StepMessage {
	role?: string;
	stopReason?: string;
	content?: unknown;
	errorMessage?: string;
	errorStatus?: number;
	errorType?: string;
	provider?: string;
	model?: string;
}

interface StepEntry {
	id: string;
	parentId: string | null;
	type: string;
	message?: StepMessage;
	customType?: string;
	data?: unknown;
}

/** A message handed back, with what the room needs to say why: the cause and the model the last attempt ran on. */
export interface ReturnedPrompt {
	/** The step back's own id: the room says its line once, however often the message is offered again. */
	id?: string;
	text: string;
	failure?: string;
	model?: { provider: string; model: string };
	/** Who can lift a spent limit, for a quota failure. */
	quotaWay?: QuotaWay;
	/** After a gateway's bare "not found": what its model list said. */
	gatewayFind?: GatewayFind;
	/** The failed attempt's own words, as the live failure frame carries them: the page says the same line and Details from them. */
	words?: string;
	/** The failure went to the key or sign-in notice: the room adds no line of its own. */
	notice?: true;
	/** For that notice on a key connection: its key is missing, refused, or made outside a workspace. */
	key?: CredentialKey;
	/** Stop ended the turn while the runtime waited to try again. */
	stopped?: true;
}

const RETURNED_PROMPT = "failed-prompt-returned";
// The page handed the message back, or kept it because the box held other text.
const RETURNED_PROMPT_HANDED = "failed-prompt-handed";
const RETURNED_PROMPT_KEPT = "failed-prompt-kept";
// A turn the app started by itself failed here: its prompt is not the person's to take back.
const APP_TURN_FAILED = "app-turn-failed";
const MARKS = new Set([RETURNED_PROMPT, RETURNED_PROMPT_HANDED, RETURNED_PROMPT_KEPT, APP_TURN_FAILED]);

// A summary of the conversation: stepping back past it would leave the paid summary on an abandoned branch.
const BOUNDARIES = new Set(["compaction", "branch_summary"]);

/** The entry before this one that is a message, one of the marks above or a summary; the model or thinking level a bind writes is passed over. */
function markOrMessageFrom(manager: SteppingSession["sessionManager"], entry: StepEntry | undefined): StepEntry | undefined {
	while (entry && entry.type !== "message" && !BOUNDARIES.has(entry.type) && !(entry.type === "custom" && MARKS.has(entry.customType ?? ""))) {
		entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
	}
	return entry;
}

function textOnly(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	if (content.some((part) => (part as { type?: unknown })?.type !== "text")) return undefined;
	return content.map((part) => String((part as { text?: unknown }).text ?? "")).join("");
}

/**
 * Steps the session back to before its last user message when everything
 * after that message is a failed attempt that left nothing on screen, and
 * returns what was handed back. A turn that ran tools before it failed is left
 * as it is, so the model never loses sight of work it did, and so is an answer
 * cut off part way, whose text the person has read: the page keeps both above,
 * and its Try again continues the turn. So is a message that carries more than
 * the person typed (a file note, a transfer, an image), since only typed text
 * can go back into the box. `stopped`: Stop ended a retry wait. `shown`: the
 * text the room shows for the message; one the model was sent otherwise (an
 * older room's restored context before it) stays where it is.
 */
export async function stepBackFromFailedPrompt(session: SteppingSession, options: { stopped?: boolean; shown?: string } = {}): Promise<ReturnedPrompt | undefined> {
	// Read from the session file: while the runtime waits to try again, its own list has already let the failed attempt go.
	const manager = session.sessionManager;
	const from = markOrMessageFrom(manager, manager.getLeafEntry());
	let entry = from;
	const attempts: StepMessage[] = [];
	while (entry && entry.type === "message" && entry.message?.role === "assistant" && (entry.message.stopReason === "error" || emptyAnswer(entry.message))) {
		attempts.push(entry.message);
		entry = markOrMessageFrom(manager, entry.parentId ? manager.getEntry(entry.parentId) : undefined);
	}
	if (!from || attempts.length === 0 || !entry || entry.type !== "message" || entry.message?.role !== "user") return undefined;
	const sent = textOnly(entry.message.content);
	if (sent === undefined || !sent.trim() || userAuthoredPromptText(sent).trim() !== sent.trim() || sent.trim() !== (options.shown ?? "").trim()) return undefined;
	if (attempts.some((attempt) => answerStarted(attempt.content))) return undefined;
	const failed = attempts[0]!;
	const words = String(failed.errorMessage ?? "");
	const provider = String(failed.provider ?? "");
	const codes = failureCodesOf(failed);
	const failure = options.stopped ? undefined : emptyAnswer(failed) ? "empty-answer" : turnFailureOf(words, attempts.length > 1, provider, false, codes);
	const notice = !options.stopped && (isSignInFailure(words) || anthropicKeyNeedsWorkspace(words) || failure === "signed-out");
	const key = notice ? failedTurnKey(provider, words, codes) : undefined;
	const gatewayFind = failure === "gateway-not-found" ? await gatewayModelFind(provider, String(failed.model ?? "")) : undefined;
	const returned: ReturnedPrompt = {
		text: sent.trim(),
		...(options.stopped ? { stopped: true as const } : { failure }),
		...(failure === "quota" ? { quotaWay: quotaWayOf(provider, words) } : {}),
		...(gatewayFind ? { gatewayFind } : {}),
		...(!options.stopped && words.trim() ? { words } : {}),
		...(provider && failed.model ? { model: { provider, model: String(failed.model) } } : {}),
		...(notice ? { notice: true as const } : {}),
		...(key ? { key } : {}),
	};
	const moved = await session.navigateTree(entry.id);
	if (moved.cancelled) return undefined;
	// The session file's last entry is where it reopens, and a custom entry
	// never reaches the model: written down, the step back outlasts a reload.
	// `from` is where the conversation was, should the page keep the message.
	const id = manager.appendCustomEntry(RETURNED_PROMPT, { ...returned, from: from.id });
	return { ...returned, id };
}

/** The text of the conversation's last message from the person, as the room shows it. */
export function lastShownUserText(items: ReadonlyArray<unknown> | undefined): string | undefined {
	const lastUser = [...(items ?? [])].reverse().find((item) => (item as { kind?: unknown } | null)?.kind === "user") as { text?: unknown } | undefined;
	return typeof lastUser?.text === "string" ? lastUser.text : undefined;
}

/**
 * A turn the app started by itself (a scheduled task, the request for a
 * missing answer after tools) that ended on a failed attempt keeps that
 * failure where it is: marked, so no later open hands its prompt to the
 * person, who only ever gets back a message they typed.
 */
export function keepAppTurnFailure(session: Pick<SteppingSession, "sessionManager">): void {
	const manager = session.sessionManager;
	const leaf = markOrMessageFrom(manager, manager.getLeafEntry());
	if (leaf?.type !== "message" || leaf.message?.role !== "assistant" || !(leaf.message.stopReason === "error" || emptyAnswer(leaf.message))) return;
	manager.appendCustomEntry(APP_TURN_FAILED, {});
}

/** The message the session stepped back from, while the page has not yet handed it back and nothing came after the step: the page puts it back when it opens. */
export function returnedPromptOf(session: Pick<SteppingSession, "sessionManager"> | null | undefined): ReturnedPrompt | undefined {
	const manager = session?.sessionManager;
	const entry = manager ? markOrMessageFrom(manager, manager.getLeafEntry()) : undefined;
	if (entry?.type !== "custom" || entry.customType !== RETURNED_PROMPT) return undefined;
	const { from: _from, ...returned } = (entry.data ?? {}) as ReturnedPrompt & { from?: unknown };
	return typeof returned.text === "string" && returned.text.trim() ? { ...returned, id: entry.id } : undefined;
}

/**
 * The page handed the message back (into the box), or kept it, because the
 * box held other text: the conversation then returns to where it was, so the
 * model still sees the message the room still shows. Either way it is said
 * once, never again on the next open.
 */
export async function settleReturnedPrompt(session: SteppingSession, kept: boolean): Promise<void> {
	const manager = session.sessionManager;
	const entry = markOrMessageFrom(manager, manager.getLeafEntry());
	if (entry?.type !== "custom" || entry.customType !== RETURNED_PROMPT) return;
	const from = (entry.data as { from?: unknown } | undefined)?.from;
	if (kept && typeof from === "string" && manager.getEntry(from)) {
		const moved = await session.navigateTree(from);
		if (moved.cancelled) return;
	}
	manager.appendCustomEntry(kept ? RETURNED_PROMPT_KEPT : RETURNED_PROMPT_HANDED, {});
}
