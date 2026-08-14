export const MAX_RESTORED_MESSAGES = 24;
export const MAX_RESTORED_TOTAL_CHARS = 12_000;
export const MAX_RESTORED_MESSAGE_CHARS = 1_200;

export interface RestoredLiveThreadContextMetadata {
	sourceItemCount: number;
	eligibleItemCount: number;
	includedItemCount: number;
	omittedOlderCount: number;
	truncatedMessageCount: number;
	maxRestoredMessages: number;
	maxRestoredTotalChars: number;
	maxRestoredMessageChars: number;
	messageCountTruncated: boolean;
	totalCharsTruncated: boolean;
}

export interface RestoredLiveThreadContext {
	block: string;
	metadata: RestoredLiveThreadContextMetadata;
}

type RestoredLiveThreadRole = "user" | "assistant";

interface EligibleLiveThreadMessage {
	role: RestoredLiveThreadRole;
	text: string;
	chars: number;
	truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLiveThreadText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function roleLabel(role: RestoredLiveThreadRole): string {
	return role === "user" ? "User" : "Assistant";
}

function renderedMessageChars(message: Pick<EligibleLiveThreadMessage, "role" | "text">): number {
	return `${roleLabel(message.role)}: ${message.text}`.length;
}

function eligibleLiveThreadMessage(item: unknown, trustStreamingMarks: boolean): EligibleLiveThreadMessage | null {
	if (!isRecord(item)) return null;
	const kind = item.kind;
	if (kind !== "user" && kind !== "assistant") return null;
	// A half-written answer is not context. But the mark that says so is written
	// by the browser and cleared by a debounced save that can be lost, and no
	// server-side write closes the gap on the attached path, so a finished answer
	// can sit on disk marked mid-flight forever. Threads written before this was
	// enforced carry the same scars. When the room has no turn running, nothing
	// is streaming and the mark is stale by definition, so it is ignored rather
	// than allowed to delete an answer from the room's own memory of itself.
	if (kind === "assistant" && item.streaming === true && trustStreamingMarks) return null;
	if (typeof item.text !== "string") return null;

	const normalized = normalizeLiveThreadText(item.text);
	if (!normalized) return null;

	const truncated = normalized.length > MAX_RESTORED_MESSAGE_CHARS;
	const text = truncated ? normalized.slice(0, MAX_RESTORED_MESSAGE_CHARS).trimEnd() : normalized;
	if (!text) return null;

	return {
		role: kind,
		text,
		chars: renderedMessageChars({ role: kind, text }),
		truncated,
	};
}

function totalRenderedMessageChars(messages: EligibleLiveThreadMessage[]): number {
	if (messages.length === 0) return 0;
	return messages.reduce((sum, message) => sum + message.chars, 0) + Math.max(0, messages.length - 1);
}

function mostRecentTailWithinCaps(messages: EligibleLiveThreadMessage[]): EligibleLiveThreadMessage[] {
	const tail: EligibleLiveThreadMessage[] = [];
	let totalChars = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (tail.length >= MAX_RESTORED_MESSAGES) break;
		const message = messages[index];
		if (!message) continue;
		const separatorChars = tail.length === 0 ? 0 : 1;
		if (totalChars + separatorChars + message.chars > MAX_RESTORED_TOTAL_CHARS) break;
		tail.push(message);
		totalChars += separatorChars + message.chars;
	}
	return tail.reverse();
}

/**
 * @param turnInFlight Whether the room is mid-answer right now. Only then does a
 * streaming mark describe something that is actually still being written.
 */
export function buildPersistentRoomRestoredLiveThreadContext(items: unknown[], turnInFlight = false): RestoredLiveThreadContext | null {
	const sourceItemCount = Array.isArray(items) ? items.length : 0;
	const eligibleMessages = Array.isArray(items)
		? items.map((item) => eligibleLiveThreadMessage(item, turnInFlight)).filter((message): message is EligibleLiveThreadMessage => message != null)
		: [];
	if (eligibleMessages.length === 0) return null;

	const includedMessages = mostRecentTailWithinCaps(eligibleMessages);
	if (includedMessages.length === 0) return null;

	const omittedOlderCount = eligibleMessages.length - includedMessages.length;
	const truncatedMessageCount = includedMessages.filter((message) => message.truncated).length;
	const messageCountTruncated = eligibleMessages.length > MAX_RESTORED_MESSAGES;
	const totalCharsTruncated = totalRenderedMessageChars(eligibleMessages) > MAX_RESTORED_TOTAL_CHARS;

	const metadata: RestoredLiveThreadContextMetadata = {
		sourceItemCount,
		eligibleItemCount: eligibleMessages.length,
		includedItemCount: includedMessages.length,
		omittedOlderCount,
		truncatedMessageCount,
		maxRestoredMessages: MAX_RESTORED_MESSAGES,
		maxRestoredTotalChars: MAX_RESTORED_TOTAL_CHARS,
		maxRestoredMessageChars: MAX_RESTORED_MESSAGE_CHARS,
		messageCountTruncated,
		totalCharsTruncated,
	};

	const lines = [
		"[RESTORED PERSISTENT ROOM LIVE THREAD CONTEXT]",
		"This persistent-agent room was resumed from its saved live-thread transcript.",
		"Use this bounded excerpt only as continuation context for the current thread.",
		"Some older live-thread messages may be omitted when the transcript exceeds the restoration caps.",
		`Restoration caps: at most ${MAX_RESTORED_MESSAGES} messages, ${MAX_RESTORED_TOTAL_CHARS} rendered transcript chars total, and ${MAX_RESTORED_MESSAGE_CHARS} chars per message.`,
	];

	if (omittedOlderCount > 0) {
		lines.push(`Older live-thread messages omitted from this bounded excerpt: ${omittedOlderCount}.`);
	}
	if (truncatedMessageCount > 0) {
		lines.push(`Messages truncated to the per-message cap in this bounded excerpt: ${truncatedMessageCount}.`);
	}
	if (messageCountTruncated || totalCharsTruncated) {
		const reasons = [messageCountTruncated ? "message count" : null, totalCharsTruncated ? "total chars" : null].filter(Boolean).join(" and ");
		lines.push(`This restored live-thread excerpt was truncated by ${reasons} restoration caps.`);
	}

	for (const message of includedMessages) {
		lines.push(`${roleLabel(message.role)}: ${message.text}`);
	}
	lines.push("[/RESTORED PERSISTENT ROOM LIVE THREAD CONTEXT]");

	return {
		block: lines.join("\n"),
		metadata,
	};
}
