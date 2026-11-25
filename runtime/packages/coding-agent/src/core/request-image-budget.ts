import type { AgentMessage } from "@exxeta/exxperts-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	tooBigRefusal,
	type ToolResultMessage,
} from "@exxeta/exxperts-ai";
import type { SessionEntry } from "./session-manager.js";

/** Stands where pictures were left out, once per tool result; the tool call before it names the file. */
export const LEFT_OUT_PICTURES_LINE =
	"[One or more earlier pictures were left out here to keep this conversation small enough to send. Read the file again if you need it.]";

/** The same, where an answer followed while the model could see them; the line above reads as if it never had. */
export const SEEN_PICTURES_LINE =
	"[You saw one or more pictures here earlier; they are left out now to keep this conversation small enough to send. What you said about them then was based on seeing them. Read the file again if you need to look.]";

/** The saved mark that the prompt after it is the app's own (the request for a missing answer), not the person's. */
export const APP_PROMPT_MARK = "app-prompt";

/**
 * In base64 characters: once the pictures tools returned before one of the
 * person's messages are together over the high mark, the oldest are left out
 * until the rest is at or under the low one. The gap is how often the beginning
 * of a conversation's requests changes for the provider's cache.
 */
export const EARLIER_PICTURES_HIGH_MARK = 20_000_000;
export const EARLIER_PICTURES_LOW_MARK = 10_000_000;

/** A tool result as the saved conversation and every request built from it name it; some providers use a call's id again. */
function resultKey(result: ToolResultMessage): string {
	return `${result.toolCallId} ${result.timestamp}`;
}

/** The pictures a tool returned with this message. */
function toolPictures(message: AgentMessage | Message): ImageContent[] {
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return [];
	return message.content.filter((block) => block.type === "image");
}

/** The messages with the pictures of these tool results left out, and what is said there of those seen. Never changes its input. */
export function leaveOutPictures(messages: Message[], leftOut: ReadonlySet<string>, seen: ReadonlySet<string>): Message[] {
	if (leftOut.size === 0) return messages;
	return messages.map((message) => {
		if (message.role !== "toolResult" || toolPictures(message).length === 0 || !leftOut.has(resultKey(message))) return message;
		const content: (TextContent | ImageContent)[] = [];
		let said = false;
		for (const block of message.content) {
			if (block.type !== "image") content.push(block);
			else if (!said) {
				said = true;
				content.push({ type: "text", text: seen.has(resultKey(message)) ? SEEN_PICTURES_LINE : LEFT_OUT_PICTURES_LINE });
			}
		}
		return { ...message, content };
	});
}

/** A picture's size in a request, which carries it as base64. */
function pictureBytes(pictures: ImageContent[]): number {
	return pictures.reduce((sum, picture) => sum + picture.data.length, 0);
}

/**
 * Which messages are the person's own; the app's own prompts are not. One they
 * send while an answer runs is their newest too, so the running job's pictures
 * before it can be left out, and it reads again those it still needs.
 */
function personMessages(messages: AgentMessage[], saved: SessionEntry[]): AgentMessage[] {
	const appPrompts = new Set<number>();
	const others = new Set<number>();
	let marked = false;
	for (const entry of saved) {
		if (entry.type === "custom" && entry.customType === APP_PROMPT_MARK) marked = true;
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		(marked ? appPrompts : others).add(entry.message.timestamp);
		marked = false;
	}
	// A request can be built before its message is saved: a mark with no message after it is that one's.
	const unsaved = (message: AgentMessage) => !appPrompts.has(message.timestamp) && !others.has(message.timestamp);
	return messages.filter((message) => message.role === "user" && !appPrompts.has(message.timestamp) && !(marked && unsaved(message)));
}

/** Where the person's last message is; -1 when there is none. */
function lastPersonMessage(messages: AgentMessage[], saved: SessionEntry[]): number {
	const last = personMessages(messages, saved).at(-1);
	return last ? messages.lastIndexOf(last) : -1;
}

/**
 * The tool results whose pictures are past the marks, worked out from the
 * messages alone: at each of the person's, in order, by what came before it. So
 * it moves only at a message of theirs and is the same after a restart.
 */
function resultsPastMarks(messages: AgentMessage[], saved: SessionEntry[]): Set<string> {
	const persons = new Set(personMessages(messages, saved));
	const past = new Set<string>();
	const kept: { key: string; bytes: number }[] = [];
	let total = 0;
	for (const message of messages) {
		if (persons.has(message) && total > EARLIER_PICTURES_HIGH_MARK) {
			while (total > EARLIER_PICTURES_LOW_MARK) {
				const oldest = kept.shift()!;
				total -= oldest.bytes;
				past.add(oldest.key);
			}
		}
		const bytes = pictureBytes(toolPictures(message));
		if (message.role !== "toolResult" || bytes === 0) continue;
		kept.push({ key: resultKey(message), bytes });
		total += bytes;
	}
	return past;
}

/** Whether a model said something to the end: what it only began, or ended in a failure or a tool call, is no answer. */
function isFinishedAnswer(message: AssistantMessage): boolean {
	return (
		(message.stopReason === "stop" || message.stopReason === "length") &&
		message.content.some((block) => block.type === "text" && block.text.trim() !== "")
	);
}

/**
 * The tool results whose pictures the conversation answered about: a finished
 * answer of a model that takes pictures came after them, before the person's
 * next message. It is the same in every later request and after a restart,
 * while the registry says the same of that model.
 */
function seenResults(
	messages: AgentMessage[],
	saved: SessionEntry[],
	takesPictures: (provider: string, model: string) => boolean,
): Set<string> {
	const persons = new Set(personMessages(messages, saved));
	const seen = new Set<string>();
	let answered = false;
	for (const message of [...messages].reverse()) {
		if (persons.has(message)) answered = false;
		else if (message.role === "assistant") answered ||= isFinishedAnswer(message) && takesPictures(message.provider, message.model);
		else if (message.role === "toolResult" && answered && toolPictures(message).length > 0) seen.add(resultKey(message));
	}
	return seen;
}

/** Whether a conversation holds a picture a tool returned since the person's last message; one a summary took away leaves every message since. */
export function hasPicturesSinceLastMessage(messages: AgentMessage[], saved: SessionEntry[]): boolean {
	return messages.slice(lastPersonMessage(messages, saved) + 1).some((message) => toolPictures(message).length > 0);
}

function count(pictures: number): string {
	return `${pictures} more earlier ${pictures === 1 ? "picture" : "pictures"}`;
}

/** Says in the server's log how many were left out and why, never what they are. */
function logLeftOut(why: string, what: string): void {
	// On stderr: the runtime's own modes answer on stdout.
	console.warn(`[${why}] ${what} that tools returned`);
}

/**
 * The pictures tools returned before the person's last message, for one
 * conversation while its session lives. Past the marks above, the oldest are
 * left out before a request is sent. Where a provider still refuses one for its
 * size, the oldest of the rest go, to about half their bytes, and at a second
 * refusal of the same message all of them; a refusal for its tokens leaves all
 * of them out at once. The request is sent again each time, and one with none
 * left to leave out stands. What a refusal left out stays out of every later
 * request, so their beginnings stay the same for the provider's cache. The saved
 * conversation is never changed.
 */
export class EarlierPictures {
	private pastMarks: ReadonlySet<string> = new Set();
	private seen: ReadonlySet<string> = new Set();
	private readonly leftOut = new Set<string>();
	/** Those the request being built still carries, oldest first. */
	private sent: { key: string; bytes: number; pictures: number }[] = [];
	private lastMessage: number | undefined;
	private refused = false;
	private readonly counted = new Set<string>();
	private toLog = 0;

	/**
	 * Reads the conversation before anything is taken out of it for a request. Its
	 * old results may be shortened after this, and then no longer say what they held.
	 */
	readConversation(
		messages: AgentMessage[],
		saved: SessionEntry[],
		takesPictures: (provider: string, model: string) => boolean,
	): void {
		this.pastMarks = resultsPastMarks(messages, saved);
		this.seen = seenResults(messages, saved, takesPictures);
	}

	/** Reads the messages a request is built from, and the saved path, which tells the person's messages from the app's prompts. */
	readRequest(messages: AgentMessage[], saved: SessionEntry[]): void {
		const last = lastPersonMessage(messages, saved);
		if (last >= 0 && messages[last].timestamp !== this.lastMessage) {
			this.lastMessage = messages[last].timestamp;
			this.refused = false;
		}
		this.sent = [];
		for (const message of messages.slice(0, Math.max(last, 0))) {
			const pictures = toolPictures(message);
			if (message.role !== "toolResult" || pictures.length === 0) continue;
			const key = resultKey(message);
			if (this.leftOut.has(key)) continue;
			if (!this.pastMarks.has(key)) {
				this.sent.push({ key, bytes: pictureBytes(pictures), pictures: pictures.length });
			} else if (!this.counted.has(key)) {
				this.counted.add(key);
				this.toLog += pictures.length;
			}
		}
	}

	/** A request's messages without what was left out. */
	applyTo(messages: Message[]): Message[] {
		return leaveOutPictures(messages, new Set([...this.pastMarks, ...this.leftOut]), this.seen);
	}

	/** Leaves out more of them after a refusal, and says how many; 0 when there is none left. */
	leaveOutMore(refusal: "size" | "length" | "either"): number {
		let bytes = this.sent.reduce((sum, result) => sum + result.bytes, 0);
		const target = refusal !== "length" && !this.refused ? bytes / 2 : 0;
		let pictures = 0;
		while (bytes > target) {
			const oldest = this.sent.shift()!;
			bytes -= oldest.bytes;
			pictures += oldest.pictures;
			this.leftOut.add(oldest.key);
		}
		if (pictures > 0) this.refused = true;
		return pictures;
	}

	/** Sends a request, and again without the older pictures when it is refused as too big before any answer. */
	send(model: Model<any>, context: Context, options: SimpleStreamOptions): AssistantMessageEventStream {
		// A model that takes no pictures is sent none, so none can be left out.
		if (!model.input.includes("image")) return streamSimple(model, context, options);
		if (this.toLog > 0) {
			logLeftOut("pictures past the high mark", `sent without ${count(this.toLog)}`);
			this.toLog = 0;
		}
		const request = () => streamSimple(model, { ...context, messages: this.applyTo(context.messages) }, options);
		const first = request();
		if (this.sent.length === 0) return first;
		const answer = createAssistantMessageEventStream();
		void this.follow(first, request, answer, options.signal, false);
		return answer;
	}

	private async follow(
		attempt: AssistantMessageEventStream,
		request: () => AssistantMessageEventStream,
		answer: AssistantMessageEventStream,
		signal: AbortSignal | undefined,
		alreadyStarted: boolean,
	): Promise<void> {
		let started = alreadyStarted;
		let answering = false;
		for await (const event of attempt) {
			if (event.type === "start") {
				// One answer, however often it was asked for.
				if (!started) answer.push(event);
				started = true;
				continue;
			}
			const refusal = event.type === "error" && !answering && !signal?.aborted ? tooBigRefusal(event.error) : undefined;
			const leftOut = refusal ? this.leaveOutMore(refusal) : 0;
			if (leftOut > 0) {
				logLeftOut("request refused as too big", `sent again without ${count(leftOut)}`);
				return this.follow(request(), request, answer, signal, started);
			}
			answering = true;
			answer.push(event);
		}
		answer.end(await attempt.result());
	}
}
