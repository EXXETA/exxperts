import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@exxeta/exxperts-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@exxeta/exxperts-ai";
import { describe, expect, it } from "vitest";
import {
	APP_PROMPT_MARK,
	EARLIER_PICTURES_HIGH_MARK,
	EARLIER_PICTURES_LOW_MARK,
	EarlierPictures,
	hasPicturesSinceLastMessage,
	LEFT_OUT_PICTURES_LINE,
	leaveOutPictures,
	SEEN_PICTURES_LINE,
} from "../src/core/request-image-budget.js";
import { SessionManager } from "../src/core/session-manager.js";

function picture(bytes: number) {
	return { type: "image" as const, data: "A".repeat(bytes), mimeType: "image/png" };
}

function text(words: string) {
	return { type: "text" as const, text: words };
}

function person(words: string, timestamp: number, ...pictures: number[]): AgentMessage {
	return { role: "user", content: [text(words), ...pictures.map(picture)], timestamp };
}

function toolResult(id: string, content: ToolResultMessage["content"], timestamp = 1): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp };
}

// An answer that called the named tools, as it stands before their results.
function toolCalls(...ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.png` } })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

// An answer that ended, from the model of the conversation's tool calls unless said otherwise.
function answer(over: Partial<AssistantMessage> = {}): AssistantMessage {
	return { ...toolCalls(), content: [text("It says so.")], stopReason: "stop", ...over };
}

// The models the registry knows: two that take pictures and one that takes none.
const INPUTS: Record<string, string[]> = { "anthropic/test": ["text", "image"], "openai/other": ["text", "image"], "openai/blind": ["text"] };
function takesPictures(provider: string, model: string): boolean {
	return INPUTS[`${provider}/${model}`]?.includes("image") ?? false;
}

// A conversation that read `count` pictures, one per message of the person's, and then a new message.
function readOneByOne(count: number, bytes = 100): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let i = 1; i <= count; i++) {
		messages.push(
			person(`Read ${i}.`, i),
			toolCalls(`p${i}`),
			toolResult(`p${i}`, [text(`Read image file ${i}`), picture(bytes)]),
		);
	}
	return [...messages, person("And now?", count + 1)];
}

// The ids of the tool results that still hold a picture.
function shown(messages: Message[]): string[] {
	return messages.flatMap((m) =>
		m.role === "toolResult" && m.content.some((c) => c.type === "image") ? [m.toolCallId] : [],
	);
}

function ids(from: number, to: number): string[] {
	return Array.from({ length: to - from + 1 }, (_, i) => `p${from + i}`);
}

// What a conversation's requests carry, across refusals: the request for these messages, refused so many times.
function afterRefusals(pictures: EarlierPictures, messages: AgentMessage[], refusals: number): string[] {
	pictures.readRequest(messages, []);
	for (let i = 0; i < refusals; i++) pictures.leaveOutMore("size");
	return shown(pictures.applyTo(messages as Message[]));
}

// Eight of these are just over the high mark; three, and no more, fit under the low one.
const LARGE = Math.floor(EARLIER_PICTURES_HIGH_MARK / 8) + 1;

// What a conversation's next request carries, in a session that sent nothing before it.
function carried(messages: AgentMessage[], saved: SessionManager = SessionManager.inMemory("/")): string[] {
	const pictures = new EarlierPictures();
	pictures.readConversation(messages, saved.getBranch(), takesPictures);
	pictures.readRequest(messages, saved.getBranch());
	return shown(pictures.applyTo(messages as Message[]));
}

describe("the marks for earlier pictures", () => {
	it("leave room between them for a step", () => {
		expect(EARLIER_PICTURES_LOW_MARK).toBeLessThan(EARLIER_PICTURES_HIGH_MARK);
		expect(LARGE * 3).toBeLessThanOrEqual(EARLIER_PICTURES_LOW_MARK);
		expect(LARGE * 4).toBeGreaterThan(EARLIER_PICTURES_LOW_MARK);
	});

	it("take nothing out at the high mark, and above it the oldest, down to the low one", () => {
		const messages = readOneByOne(8, EARLIER_PICTURES_HIGH_MARK / 8);
		expect(carried(messages)).toEqual(ids(1, 8));
		expect(carried(readOneByOne(8, LARGE))).toEqual(ids(6, 8));
	});

	it("change nothing in the messages of a request under the high mark", () => {
		const messages = readOneByOne(8, EARLIER_PICTURES_HIGH_MARK / 8);
		const pictures = new EarlierPictures();
		pictures.readConversation(messages, [], takesPictures);
		pictures.readRequest(messages, []);
		expect(pictures.applyTo(messages as Message[])).toBe(messages);
	});

	it("move in steps: earlier messages stay the same from one message to the next, but at a step", () => {
		const pictures = new EarlierPictures();
		const changedAt: number[] = [];
		let before: Message[] = [];
		for (let count = 1; count <= 20; count++) {
			const messages = readOneByOne(count, LARGE);
			pictures.readConversation(messages, [], takesPictures);
			pictures.readRequest(messages, []);
			const sent = pictures.applyTo(messages.slice(0, -1) as Message[]);
			if (JSON.stringify(sent.slice(0, before.length)) !== JSON.stringify(before)) changedAt.push(count);
			before = sent;
		}
		expect(changedAt).toEqual([8, 13, 18]);
	});

	it("take out the same in a session that sent nothing yet as in one that sent every message", () => {
		const lived = new EarlierPictures();
		for (let count = 1; count <= 20; count++) {
			const messages = readOneByOne(count, LARGE);
			lived.readConversation(messages, [], takesPictures);
			lived.readRequest(messages, []);
			expect(shown(lived.applyTo(messages as Message[]))).toEqual(carried(messages));
		}
	});

	it("never take out a picture since the person's last message, nor move while its answer goes on", () => {
		const asked = (count: number) => [...readOneByOne(8, LARGE), toolCalls("new"), ...ids(101, 100 + count).map((id) => toolResult(id, [picture(LARGE)]))];
		for (const count of [1, 9, 20]) expect(carried(asked(count))).toEqual([...ids(6, 8), ...ids(101, 100 + count)]);
		expect(carried([...asked(9), person("And then?", 100)])).toEqual(ids(107, 109));
	});

	it("take out a result whole, and all of them where the newest alone is over the low mark", () => {
		const messages = [
			person("Read.", 1),
			toolResult("small", [picture(100)]),
			toolResult("pages", Array.from({ length: 8 }, () => picture(LARGE))),
			person("And now?", 2),
		];
		expect(carried(messages)).toEqual([]);
	});

	it("count an old result that the request itself no longer carries, so the rest does not come back", () => {
		const messages = readOneByOne(8, LARGE);
		const shortened = messages.map((message) => (message.role === "toolResult" && message.toolCallId === "p7" ? { ...message, content: [text("Removed.")] } : message));
		const pictures = new EarlierPictures();
		pictures.readConversation(messages, [], takesPictures);
		pictures.readRequest(shortened, []);
		expect(shown(pictures.applyTo(shortened as Message[]))).toEqual(["p6", "p8"]);
	});

	it("pass over the app's own prompts, saved or not yet", () => {
		const saved = SessionManager.inMemory("/");
		saved.appendMessage(person("Read.", 1) as Message);
		saved.appendCustomEntry(APP_PROMPT_MARK, {});
		const read = [person("Read.", 1), toolCalls("p"), ...ids(1, 8).map((id) => toolResult(id, [picture(LARGE)]))];
		expect(carried([...read, person("Answer now.", 2)], saved)).toEqual(ids(1, 8));
		saved.appendMessage(person("Answer now.", 2) as Message);
		expect(carried([...read, person("Answer now.", 2)], saved)).toEqual(ids(1, 8));
		expect(carried([...read, person("Answer now.", 2), person("And now?", 3)], saved)).toEqual(ids(6, 8));
	});

	it("go by the message, whoever of a shared conversation wrote it", () => {
		const saved = SessionManager.inMemory("/");
		const messages = readOneByOne(8, LARGE);
		for (const message of messages) {
			const id = saved.appendMessage(message as Message);
			if (message.role === "user") saved.appendCustomEntry("message-author", { space: "team", person: `person-${message.timestamp % 2}`, for: id });
		}
		expect(carried(messages, saved)).toEqual(ids(6, 8));
	});

	it("are no limit on a picture the person added", () => {
		const messages = [person("Mine.", 0, EARLIER_PICTURES_HIGH_MARK * 2), ...readOneByOne(3)];
		expect(carried(messages)).toEqual(ids(1, 3));
	});

	it("leave the rest to a refusal, which takes half of what is still sent", () => {
		const messages = readOneByOne(8, LARGE);
		const pictures = new EarlierPictures();
		pictures.readConversation(messages, [], takesPictures);
		pictures.readRequest(messages, []);
		expect(pictures.leaveOutMore("size")).toBe(2);
		expect(shown(pictures.applyTo(messages as Message[]))).toEqual(["p8"]);
		expect(pictures.leaveOutMore("size")).toBe(1);
		expect(pictures.leaveOutMore("size")).toBe(0);
	});
});

describe("EarlierPictures", () => {
	it("leaves nothing out below the marks until it is told to", () => {
		const pictures = new EarlierPictures();
		const messages = readOneByOne(30, EARLIER_PICTURES_HIGH_MARK / 40) as Message[];
		pictures.readConversation(messages as AgentMessage[], [], takesPictures);
		pictures.readRequest(messages as AgentMessage[], []);
		expect(pictures.applyTo(messages)).toBe(messages);
	});

	it("told once, leaves the oldest out, to about half the bytes", () => {
		expect(afterRefusals(new EarlierPictures(), readOneByOne(8), 1)).toEqual(ids(5, 8));
		expect(afterRefusals(new EarlierPictures(), readOneByOne(7), 1)).toEqual(ids(5, 7));
	});

	it("goes by bytes, not by how many", () => {
		const messages = [
			person("Read.", 1),
			toolResult("p1", [picture(900)]),
			toolResult("p2", [picture(100)]),
			toolResult("p3", [picture(100)]),
			person("And now?", 2),
		];
		expect(afterRefusals(new EarlierPictures(), messages, 1)).toEqual(["p2", "p3"]);
	});

	it("told again for the same message, leaves all of them out, and says so when there is nothing more", () => {
		const pictures = new EarlierPictures();
		expect(afterRefusals(pictures, readOneByOne(8), 2)).toEqual([]);
		expect(pictures.leaveOutMore("size")).toBe(0);
	});

	it("told again for a later request of the same message, leaves all of them out, but none that came since", () => {
		const pictures = new EarlierPictures();
		const asked = [...readOneByOne(8), toolCalls("new"), toolResult("new", [picture(100)])];
		afterRefusals(pictures, readOneByOne(8), 1);
		expect(afterRefusals(pictures, asked, 1)).toEqual(["new"]);
		pictures.readRequest(asked, []);
		expect(pictures.leaveOutMore("size")).toBe(0);
	});

	it("told of too many tokens, leaves all of them out at once", () => {
		const pictures = new EarlierPictures();
		pictures.readRequest(readOneByOne(8), []);
		expect(pictures.leaveOutMore("length")).toBe(8);
		expect(shown(pictures.applyTo(readOneByOne(8) as Message[]))).toEqual([]);
		expect(pictures.leaveOutMore("length")).toBe(0);
	});

	it("says how many pictures it left out, told of words that leave size or tokens open as of a size", () => {
		const pictures = new EarlierPictures();
		pictures.readRequest([person("Read.", 1), toolResult("p1", [picture(100), picture(100), picture(100)]), toolResult("p2", [picture(100)]), person("And now?", 2)], []);
		expect(pictures.leaveOutMore("either")).toBe(3);
		expect(pictures.leaveOutMore("either")).toBe(1);
		expect(pictures.leaveOutMore("either")).toBe(0);
	});

	it("passes over the app's own prompt, saved or not yet, to the person's message", () => {
		const path = (...marked: boolean[]) => {
			const saved = SessionManager.inMemory("/");
			for (const [i, mark] of marked.entries()) {
				if (mark) saved.appendCustomEntry(APP_PROMPT_MARK, {});
				saved.appendMessage(person("Saved.", i + 1) as Message);
			}
			return saved;
		};
		const messages = [person("Read.", 1), toolCalls("p1"), toolResult("p1", [picture(100)]), person("Answer now.", 2)];
		const leavesOut = (saved: SessionManager) => {
			const pictures = new EarlierPictures();
			pictures.readRequest(messages, saved.getBranch());
			return pictures.leaveOutMore("size") > 0;
		};
		expect(leavesOut(path(false, true))).toBe(false);
		const unsaved = path(false);
		unsaved.appendCustomEntry(APP_PROMPT_MARK, {});
		expect(leavesOut(unsaved)).toBe(false);
		expect(leavesOut(path(false, false))).toBe(true);
		expect(leavesOut(path(false))).toBe(true);
	});

	it("never leaves out a picture that came since the person's last message", () => {
		const pictures = new EarlierPictures();
		const many = Array.from({ length: 25 }, (_, i) => `n${i + 1}`);
		const messages = [...readOneByOne(4), toolCalls(...many), ...many.map((id) => toolResult(id, [picture(100)]))];
		expect(afterRefusals(pictures, messages, 2)).toEqual(many);
		expect(pictures.leaveOutMore("size")).toBe(0);
	});

	it("counts only the person's own messages: a summary, a note or the room's state is not their last message", () => {
		const own = [
			person("Read.", 1),
			toolCalls("p1"),
			toolResult("p1", [picture(100)]),
			{ role: "custom", customType: "note", content: "From the app.", display: false, timestamp: 2 },
			{ role: "compactionSummary", summary: "So far.", tokensBefore: 1, timestamp: 3 },
		] as AgentMessage[];
		const pictures = new EarlierPictures();
		pictures.readRequest(own, []);
		expect(pictures.leaveOutMore("size")).toBe(0);
		expect(hasPicturesSinceLastMessage(own, [])).toBe(true);
		pictures.readRequest([...own, person("And now?", 4)], []);
		expect(pictures.leaveOutMore("size")).toBe(1);
		expect(hasPicturesSinceLastMessage([...own, person("And now?", 4)], [])).toBe(false);
	});

	it("counts every picture as new where a summary took the person's last message away", () => {
		const summarized = [{ role: "compactionSummary", summary: "So far.", tokensBefore: 1, timestamp: 3 }, toolCalls("p1"), toolResult("p1", [picture(100)])] as AgentMessage[];
		expect(hasPicturesSinceLastMessage(summarized, [])).toBe(true);
	});

	it("never leaves out a picture the person added", () => {
		const pasted = person("Mine.", 0, 5000);
		const messages = [pasted, ...readOneByOne(3)];
		const pictures = new EarlierPictures();
		pictures.readRequest(messages, []);
		pictures.leaveOutMore("size");
		pictures.leaveOutMore("size");
		const sent = pictures.applyTo(messages as Message[]);
		expect(sent[0]).toBe(pasted);
		expect(shown(sent)).toEqual([]);
	});

	it("keeps out what it left out, and leaves out more only when told", () => {
		const pictures = new EarlierPictures();
		afterRefusals(pictures, readOneByOne(8), 1);
		let before = pictures.applyTo(readOneByOne(8).slice(0, -1) as Message[]);
		for (let count = 9; count <= 16; count++) {
			pictures.readRequest(readOneByOne(count), []);
			const sent = pictures.applyTo(readOneByOne(count).slice(0, -1) as Message[]);
			expect(sent.slice(0, before.length)).toEqual(before);
			before = sent;
		}
		expect(shown(before)).toEqual(ids(5, 16));
		expect(afterRefusals(pictures, readOneByOne(16), 1)).toEqual(ids(11, 16));
	});

	it("tells two results apart that a provider gave the same call id", () => {
		const messages = [
			person("Read.", 1),
			toolResult("call_0", [picture(100)], 10),
			toolResult("call_0", [picture(100)], 20),
			person("And now?", 2),
		] as AgentMessage[];
		const pictures = new EarlierPictures();
		pictures.readRequest(messages, []);
		pictures.leaveOutMore("size");
		const sent = pictures.applyTo(messages as Message[]);
		expect(shown(sent.slice(0, 2))).toEqual([]);
		expect(shown(sent.slice(2))).toEqual(["call_0"]);
	});
});

describe("leaveOutPictures", () => {
	it("puts one line where a result's pictures were, keeps its text, and does not change its input", () => {
		const messages = [toolResult("p1", [text("Pages 1 and 2"), picture(100), picture(100), text("Done")], 7)];
		const before = structuredClone(messages);
		const sent = leaveOutPictures(messages, new Set(["p1 7"]), new Set());
		expect(sent).toEqual([toolResult("p1", [text("Pages 1 and 2"), text(LEFT_OUT_PICTURES_LINE), text("Done")], 7)]);
		expect(messages).toEqual(before);
	});

	it("leaves no result empty whose only content was a picture", () => {
		const sent = leaveOutPictures([toolResult("p1", [picture(100)], 7)], new Set(["p1 7"]), new Set());
		expect(sent).toEqual([toolResult("p1", [text(LEFT_OUT_PICTURES_LINE)], 7)]);
	});

	it("says once that they were seen where they were, and keeps the result's text", () => {
		const messages = [toolResult("p1", [text("Pages 1 and 2"), picture(100), picture(100), text("Done")], 7), toolResult("p2", [picture(100)], 8)];
		const before = structuredClone(messages);
		const sent = leaveOutPictures(messages, new Set(["p1 7", "p2 8"]), new Set(["p1 7"]));
		expect(sent).toEqual([
			toolResult("p1", [text("Pages 1 and 2"), text(SEEN_PICTURES_LINE), text("Done")], 7),
			toolResult("p2", [text(LEFT_OUT_PICTURES_LINE)], 8),
		]);
		expect(messages).toEqual(before);
	});

	it("says nothing in a result whose pictures stay", () => {
		const messages = [toolResult("p1", [picture(100)], 7)];
		expect(leaveOutPictures(messages, new Set(["p2 8"]), new Set(["p1 7"]))).toEqual(messages);
	});
});

describe("the line where pictures were left out", () => {
	// Which line each left-out result has, with every older picture refused.
	function lines(messages: AgentMessage[], saved: SessionManager = SessionManager.inMemory("/")): Record<string, string> {
		const pictures = new EarlierPictures();
		pictures.readConversation(messages, saved.getBranch(), takesPictures);
		pictures.readRequest(messages, saved.getBranch());
		pictures.leaveOutMore("length");
		return linesOf(pictures.applyTo(messages as Message[]));
	}
	function linesOf(messages: Message[]): Record<string, string> {
		const names: Record<string, string> = { [SEEN_PICTURES_LINE]: "seen", [LEFT_OUT_PICTURES_LINE]: "left out" };
		return Object.fromEntries(
			messages.flatMap((m) => (m.role === "toolResult" ? m.content.map((c) => [m.toolCallId, c.type === "text" ? (names[c.text] ?? c.text) : "picture"]) : [])),
		);
	}
	// The picture, what came after it, and then a new message.
	const read = (...after: AgentMessage[]) => [person("Read.", 1), toolCalls("p1"), toolResult("p1", [picture(100)]), ...after, person("And now?", 9)];

	it.each<[string, AgentMessage[]]>([
		["a finished answer", [answer()]],
		["an answer cut at its length", [answer({ stopReason: "length" })]],
		["an answer of another model that takes pictures", [answer({ provider: "openai", model: "other" })]],
		["an answer after more tool calls", [toolCalls("p2"), toolResult("p2", [text("Words.")]), answer()]],
		["an answer with thinking and a blank block before its words", [answer({ content: [{ type: "thinking", thinking: "Hm." }, text(" "), text("It says so.")] })]],
		["a finished answer after a failed one", [answer({ stopReason: "error" }), answer()]],
		["an answer after the room's own note", [{ role: "custom", customType: "note", content: "From the app.", display: false, timestamp: 2 } as AgentMessage, answer()]],
	])("says the picture was seen after %s", (_name, after) => {
		expect(lines(read(...after)).p1).toBe("seen");
	});

	it.each<[string, AgentMessage[]]>([
		["no answer", []],
		["an answer that only called a tool", [answer({ stopReason: "toolUse" })]],
		["an answer that was stopped", [answer({ stopReason: "aborted" })]],
		["an answer that failed", [answer({ stopReason: "error", errorMessage: "503 overloaded" })]],
		["an answer of blank text", [answer({ content: [text(" \n"), text("")] })]],
		["an answer of thinking alone", [answer({ content: [{ type: "thinking", thinking: "Hm." }] })]],
		["an answer of no block", [answer({ content: [] })]],
		["an answer of a model that takes no pictures", [answer({ provider: "openai", model: "blind" })]],
		["an answer of a model the registry doesn't know", [answer({ model: "gone" })]],
		["an answer of a model known from another provider", [answer({ provider: "openai", model: "test" })]],
	])("stays as it was after %s", (_name, after) => {
		expect(lines(read(...after)).p1).toBe("left out");
	});

	it("counts no answer before the picture", () => {
		expect(lines([person("Read.", 1), answer(), toolCalls("p1"), toolResult("p1", [picture(100)]), person("And now?", 9)]).p1).toBe("left out");
	});

	it("counts no answer to a later message of the person's", () => {
		expect(lines([...read(), answer(), person("And then?", 10)]).p1).toBe("left out");
	});

	it("counts the answer to the app's own prompt, which is not the person's next message", () => {
		const saved = SessionManager.inMemory("/");
		const messages = [person("Read.", 1), toolCalls("p1"), toolResult("p1", [picture(100)]), person("Answer now.", 2), answer(), person("And now?", 9)];
		const unmarked = lines(messages).p1;
		saved.appendMessage(messages[0] as Message);
		saved.appendCustomEntry(APP_PROMPT_MARK, {});
		for (const message of messages.slice(3)) saved.appendMessage(message as Message);
		expect(lines(messages, saved).p1).toBe("seen");
		expect(unmarked).toBe("left out");
	});

	it("is the same for every result of one message, and each message's own", () => {
		const messages = [
			person("Read.", 1),
			toolCalls("p1", "p2"),
			toolResult("p1", [picture(100)]),
			toolResult("p2", [picture(100)]),
			answer(),
			...read().slice(0, -1).map((m) => (m.role === "toolResult" ? { ...m, toolCallId: "p3" } : m)),
			person("And now?", 9),
		] as AgentMessage[];
		expect(lines(messages)).toEqual({ p1: "seen", p2: "seen", p3: "left out" });
	});

	it("goes by the model that answered, whatever model the conversation was changed to", () => {
		const turn = (id: string, timestamp: number, model: Partial<AssistantMessage>) => [person("Read.", timestamp), { ...toolCalls(id), ...model }, toolResult(id, [picture(100)], timestamp), answer(model)];
		const other = { provider: "openai", model: "other" };
		const blind = { provider: "openai", model: "blind" };
		expect(lines([...turn("p1", 1, other), ...turn("p2", 2, {}), person("And now?", 9)] as AgentMessage[])).toEqual({ p1: "seen", p2: "seen" });
		expect(lines([...turn("p1", 1, blind), ...turn("p2", 2, {}), person("And now?", 9)] as AgentMessage[])).toEqual({ p1: "left out", p2: "seen" });
	});

	it("tells two results apart that a provider gave the same call id", () => {
		const messages = [person("Read.", 1), toolResult("call_0", [picture(100)], 10), answer(), person("Again.", 2), toolResult("call_0", [picture(100)], 20), person("And now?", 3)];
		const pictures = new EarlierPictures();
		pictures.readConversation(messages, [], takesPictures);
		pictures.readRequest(messages, []);
		pictures.leaveOutMore("length");
		const sent = pictures.applyTo(messages as Message[]);
		expect(linesOf(sent.slice(0, 2))).toEqual({ call_0: "seen" });
		expect(linesOf(sent.slice(3))).toEqual({ call_0: "left out" });
	});

	it("goes by what the conversation held before its old results were shortened for the request", () => {
		const messages = read(answer());
		const shortened = messages.filter((m) => m.role !== "assistant");
		const pictures = new EarlierPictures();
		pictures.readConversation(messages, [], takesPictures);
		pictures.readRequest(shortened, []);
		pictures.leaveOutMore("length");
		expect(linesOf(pictures.applyTo(shortened as Message[]))).toEqual({ p1: "seen" });
	});

	it("changes nothing in the messages it reads", () => {
		const messages = read(answer());
		const before = structuredClone(messages);
		lines(messages);
		expect(messages).toEqual(before);
	});

	it("past the marks, stays the same in every later request, and after a restart from the saved conversation", () => {
		const dir = mkdtempSync(join(tmpdir(), "left-out-line-"));
		try {
			const written = SessionManager.create(dir, join(dir, "sessions"));
			const lived = new EarlierPictures();
			const said: Record<string, string>[] = [];
			const messages: AgentMessage[] = [];
			const add = (message: AgentMessage) => {
				messages.push(message);
				written.appendMessage(message as Message);
			};
			for (let i = 1; i <= 10; i++) {
				add(person(`Read ${i}.`, i * 10));
				lived.readConversation(messages, written.getBranch(), takesPictures);
				lived.readRequest(messages, written.getBranch());
				said.push(linesOf(lived.applyTo(messages as Message[])));
				add(toolCalls(`p${i}`));
				add(toolResult(`p${i}`, [picture(LARGE)], i * 10 + 1));
				// The even ones failed.
				add(answer(i % 2 === 0 ? { stopReason: "error", errorMessage: "503 overloaded" } : {}));
			}
			add(person("And now?", 200));
			lived.readConversation(messages, written.getBranch(), takesPictures);
			const last = linesOf(lived.applyTo(messages as Message[]));
			expect(last).toMatchObject({ p1: "seen", p2: "left out", p3: "seen", p4: "left out", p5: "seen", p6: "picture", p10: "picture" });
			const changed = said.flatMap((lines, request) => Object.entries(lines).filter(([id, line]) => line !== "picture" && line !== last[id]).map(([id]) => `${request} ${id}`));
			expect(changed).toEqual([]);

			const opened = SessionManager.open(written.getSessionFile()!);
			const restarted = new EarlierPictures();
			const read = opened.buildSessionContext().messages;
			restarted.readConversation(read, opened.getBranch(), takesPictures);
			expect(linesOf(restarted.applyTo(read as Message[]))).toEqual(last);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
