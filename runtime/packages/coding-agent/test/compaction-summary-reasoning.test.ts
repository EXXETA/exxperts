import type { AgentMessage } from "@exxeta/exxperts-core";
import type { AssistantMessage, Model } from "@exxeta/exxperts-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact, generateSummary } from "../src/core/compaction/index.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@exxeta/exxperts-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@exxeta/exxperts-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("rejects a length-limited history summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});

		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
	});

	it("rejects a length-limited split-turn summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});
});

function splitTurnPreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "entry-keep",
		messagesToSummarize: [],
		turnPrefixMessages: messages,
		isSplitTurn: true,
		tokensBefore: 100,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
	};
}

describe("turn prefix summarization prompt", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("frames the prefix as earlier context with the instructions after it", async () => {
		await compact(splitTurnPreparation(), createModel(false), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const prompt = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text as string;
		expect(prompt.startsWith("# Conversation\n")).toBe(true);
		expect(prompt).toContain("\n# Instructions\n");
		expect(prompt).toContain("Later messages are stored separately");
		expect(prompt).toContain("[User]: Summarize this.");
		expect(prompt).not.toContain("<conversation>");
	});
});

describe("summaries that did not end with a summary", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("reports a refused history summary with the provider's reason", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "error",
			errorMessage: "the model refused to answer this request",
			content: [],
		});

		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).rejects.toThrow(
			"Summarization failed: the model refused to answer this request",
		);
	});

	it("reports a refused split-turn summary with the provider's reason", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "error",
			errorMessage: "the model refused to answer this request",
			content: [],
		});

		await expect(compact(splitTurnPreparation(), createModel(false), "test-key")).rejects.toThrow(
			"Turn prefix summarization failed: the model refused to answer this request",
		);
	});

	it("reports a cancelled summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "aborted",
			content: [{ type: "text", text: "partial" }],
		});

		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).rejects.toThrow(
			"Summarization failed: the request was cancelled",
		);
	});

	it("reports a summary that ended in a tool call", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "toolUse",
			content: [{ type: "text", text: "partial" }],
		});

		await expect(compact(splitTurnPreparation(), createModel(false), "test-key")).rejects.toThrow(
			"Turn prefix summarization failed: the model ended with toolUse instead of a summary",
		);
	});
});
