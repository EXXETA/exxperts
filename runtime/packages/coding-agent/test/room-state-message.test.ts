import type { AgentMessage } from "@exxeta/exxperts-core";
import { type Context, fauxAssistantMessage, type Message } from "@exxeta/exxperts-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToLlm, ROOM_STATE_CUSTOM_TYPE } from "../src/core/messages.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

const OTHER_TYPE = "other-note";

/** A before_agent_start handler that returns, at each run, the next of `types` as a message ("state 1", "state 2", ...); undefined returns nothing. */
async function harnessWithHook(types: Array<string | undefined>): Promise<{ harness: Harness; hookRuns: () => number }> {
	let runs = 0;
	const harness = await createHarness({
		settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async () => {
					runs++;
					const customType = types[runs - 1];
					return customType ? { message: { customType, content: `state ${runs}`, display: false } } : undefined;
				});
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "compacted",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		],
	});
	return { harness, hookRuns: () => runs };
}

/** Answers "ok" and keeps the messages the model was sent. */
function answerAndKeep(sent: Message[][]) {
	return (context: Context) => {
		sent.push(context.messages);
		return fauxAssistantMessage("ok");
	};
}

function savedCustomTexts(harness: Harness, customType: string): string[] {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom_message" && entry.customType === customType ? [getMessageText(entry)] : []));
}

/** A hook run held until opened; `reached` resolves once the run is waiting. */
function heldRun() {
	let reachedNow = () => {};
	let open = () => {};
	const reached = new Promise<void>((resolve) => {
		reachedNow = resolve;
	});
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return {
		reached,
		open,
		async wait() {
			reachedNow();
			await opened;
		},
	};
}

/**
 * Two prompts, the second overflowing, so the overflow retry's before_agent_start run is the third.
 * The runs numbered in `holdRuns` wait until opened; the third returns a room-state copy, "late state".
 */
async function overflowWithHeldHooks(holdRuns: number[]) {
	const held: Record<number, ReturnType<typeof heldRun>> = Object.fromEntries(holdRuns.map((run) => [run, heldRun()]));
	let runs = 0;
	const harness = await createHarness({
		settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async () => {
					const run = ++runs;
					await held[run]?.wait();
					return run === 3 ? { message: { customType: ROOM_STATE_CUSTOM_TYPE, content: "late state", display: false } } : undefined;
				});
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "compacted",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		],
	});
	const sent: Message[][] = [];
	harness.setResponses([
		fauxAssistantMessage("one"),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
		answerAndKeep(sent),
		answerAndKeep(sent),
	]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	return { harness, sent, held };
}

/** Opens the retry's held hook and waits for whatever it starts to finish. */
async function settleRetry(harness: Harness, retryRun: ReturnType<typeof heldRun>): Promise<void> {
	retryRun.open();
	// Lets the hook's answer reach the retry, which starts any answer it asks for right then.
	await new Promise((resolve) => setImmediate(resolve));
	await harness.session.agent.waitForIdle();
}

describe("room-state message", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("becomes a marked user message; another custom type stays an unmarked one", () => {
		const custom = (customType: string): AgentMessage => ({
			role: "custom",
			customType,
			content: "the room",
			display: false,
			timestamp: 1,
		});

		expect(convertToLlm([custom(ROOM_STATE_CUSTOM_TYPE), custom(OTHER_TYPE)])).toEqual([
			{ role: "user", content: [{ type: "text", text: "the room" }], timestamp: 1, roomState: true },
			{ role: "user", content: [{ type: "text", text: "the room" }], timestamp: 1 },
		]);
	});

	it("Try again after a failed answer that followed a room-state message continues, without sending the person's message twice", async () => {
		const { harness } = await harnessWithHook([ROOM_STATE_CUSTOM_TYPE]);
		harnesses.push(harness);
		const sent: Message[][] = [];
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" }), answerAndKeep(sent)]);
		await harness.session.prompt("hello");

		expect(harness.session.canContinueAfterFailure()).toBe(true);
		await harness.session.continueAfterFailure();

		expect(sent).toHaveLength(1);
		expect(sent[0].filter((message) => message.role === "user" && !message.roomState).map(getMessageText)).toEqual(["hello"]);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("Try again still continues after the room is opened again from a failed Try again that sent room state", async () => {
		const { harness } = await harnessWithHook([ROOM_STATE_CUSTOM_TYPE, ROOM_STATE_CUSTOM_TYPE, ROOM_STATE_CUSTOM_TYPE]);
		harnesses.push(harness);
		const sent: Message[][] = [];
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" }),
			answerAndKeep(sent),
		]);
		await harness.session.prompt("hello");
		await harness.session.continueAfterFailure();
		// Opening the room reads the conversation back from the session file, failed attempts included.
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		expect(harness.session.canContinueAfterFailure()).toBe(true);
		await harness.session.continueAfterFailure();

		expect(sent[0].some((message) => message.role === "assistant")).toBe(false);
		expect(sent[0].map(getMessageText)).toEqual(["hello", "state 1", "state 2", "state 3"]);
	});

	it("a trailing message of another type still refuses Try again", async () => {
		const { harness } = await harnessWithHook([OTHER_TYPE]);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" })]);
		await harness.session.prompt("hello");

		expect(harness.session.canContinueAfterFailure()).toBe(false);
	});

	it("Try again sends the room-state message the hook returns, and saves it", async () => {
		const { harness } = await harnessWithHook([undefined, ROOM_STATE_CUSTOM_TYPE]);
		harnesses.push(harness);
		const sent: Message[][] = [];
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" }), answerAndKeep(sent)]);
		await harness.session.prompt("hello");
		await harness.session.continueAfterFailure();

		expect(sent[0].slice(-2)).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "user", content: [{ type: "text", text: "state 2" }], roomState: true },
		]);
		expect(savedCustomTexts(harness, ROOM_STATE_CUSTOM_TYPE)).toEqual(["state 2"]);
	});

	it("Try again leaves out a hook message of another type, as before", async () => {
		const { harness, hookRuns } = await harnessWithHook([undefined, OTHER_TYPE]);
		harnesses.push(harness);
		const sent: Message[][] = [];
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad request" }), answerAndKeep(sent)]);
		await harness.session.prompt("hello");
		await harness.session.continueAfterFailure();

		expect(hookRuns()).toBe(2);
		expect(sent[0].map(getMessageText)).toEqual(["hello"]);
		expect(savedCustomTexts(harness, OTHER_TYPE)).toEqual([]);
	});

	it("the overflow retry runs the hook and sends the room-state message it returns, and saves it", async () => {
		const { harness, hookRuns } = await harnessWithHook([undefined, undefined, ROOM_STATE_CUSTOM_TYPE]);
		harnesses.push(harness);
		const sent: Message[][] = [];
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			answerAndKeep(sent),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
		expect(hookRuns()).toBe(3);
		expect(sent[0].at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "state 3" }], roomState: true });
		expect(savedCustomTexts(harness, ROOM_STATE_CUSTOM_TYPE)).toEqual(["state 3"]);
	});

	it("the overflow retry neither sends room state nor answers again when a newer message was answered while its hook ran", async () => {
		const { harness, sent, held } = await overflowWithHeldHooks([3]);
		harnesses.push(harness);
		await held[3].reached;
		await harness.session.prompt("newer");
		await settleRetry(harness, held[3]);

		expect(sent).toHaveLength(1);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "ok" }] });
		expect(savedCustomTexts(harness, ROOM_STATE_CUSTOM_TYPE)).toEqual([]);
	});

	it("the overflow retry stands down for a newer message still in its own hook", async () => {
		const { harness, sent, held } = await overflowWithHeldHooks([3, 4]);
		harnesses.push(harness);
		await held[3].reached;
		const newer = harness.session.prompt("newer");
		await held[4].reached;
		await settleRetry(harness, held[3]);
		held[4].open();
		await newer;

		expect(sent).toHaveLength(1);
		expect(sent[0].at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "newer" }] });
		expect(savedCustomTexts(harness, ROOM_STATE_CUSTOM_TYPE)).toEqual([]);
	});

	it("the overflow retry stands down when a custom message started and finished a turn while its hook ran", async () => {
		const { harness, sent, held } = await overflowWithHeldHooks([3]);
		harnesses.push(harness);
		await held[3].reached;
		await harness.session.sendCustomMessage({ customType: OTHER_TYPE, content: "a note", display: true }, { triggerTurn: true });
		await settleRetry(harness, held[3]);

		expect(sent).toHaveLength(1);
		expect(sent[0].at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "a note" }] });
		expect(savedCustomTexts(harness, ROOM_STATE_CUSTOM_TYPE)).toEqual([]);
	});

	it("the overflow retry stands down when the session is closed while its hook runs", async () => {
		const { harness, sent, held } = await overflowWithHeldHooks([3]);
		harnesses.push(harness);
		await held[3].reached;
		harness.session.dispose();
		await settleRetry(harness, held[3]);

		expect(sent).toHaveLength(0);
		expect(savedCustomTexts(harness, ROOM_STATE_CUSTOM_TYPE)).toEqual([]);
	});

	it("the overflow retry stands down when the turn is stopped while its hook runs", async () => {
		const { harness, sent, held } = await overflowWithHeldHooks([3]);
		harnesses.push(harness);
		await held[3].reached;
		await harness.session.abort();
		await settleRetry(harness, held[3]);

		expect(sent).toHaveLength(0);
		expect(savedCustomTexts(harness, ROOM_STATE_CUSTOM_TYPE)).toEqual([]);
	});

	it("the overflow retry still goes on after a message is only added while its hook runs", async () => {
		const { harness, sent, held } = await overflowWithHeldHooks([3]);
		harnesses.push(harness);
		await held[3].reached;
		await harness.session.sendCustomMessage({ customType: OTHER_TYPE, content: "a note", display: true });
		held[3].open();

		await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
		expect(sent[0].slice(-2)).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "a note" }] },
			{ role: "user", content: [{ type: "text", text: "late state" }], roomState: true },
		]);
	});

	it("the overflow retry leaves out a hook message of another type, as before", async () => {
		const { harness } = await harnessWithHook([undefined, undefined, OTHER_TYPE]);
		harnesses.push(harness);
		const sent: Message[][] = [];
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			answerAndKeep(sent),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 });
		expect(sent[0].at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "second" }] });
		expect(savedCustomTexts(harness, OTHER_TYPE)).toEqual([]);
	});
});
