/**
 * AgentSession.dispose() must abort the agent's in-flight call. A session
 * replaced mid-stream (switchSession / newSession / fork) otherwise leaves the
 * previous request running in the background until the provider answers.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@exxeta/exxperts-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@exxeta/exxperts-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession.dispose aborts in-flight call", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dispose-abort-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			try {
				session.dispose();
			} catch {
				// already disposed inside the test
			}
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(): { session: AgentSession; getAbortSignal: () => AbortSignal | undefined } {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				// Capture the signal so the test can assert on it after dispose.
				// The stream stays live until the signal aborts, like a real HTTP call.
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({
								type: "error",
								reason: "aborted",
								error: createAssistantMessage("Aborted"),
							});
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		return { session, getAbortSignal: () => abortSignal };
	}

	it("trips the agent's abort signal when dispose() is called mid-stream", async () => {
		const { session, getAbortSignal } = createSession();

		// Start a prompt without awaiting; the mock stream only resolves once aborted.
		const inflight = session.prompt("Long-running prompt").catch(() => {
			/* expected: rejects with abort */
		});

		await new Promise((resolve) => setTimeout(resolve, 20));
		const signalBefore = getAbortSignal();
		expect(signalBefore, "stream should have started and captured an AbortSignal").toBeDefined();
		expect(signalBefore!.aborted).toBe(false);
		expect(session.isStreaming).toBe(true);

		session.dispose();

		// AbortController.abort() is synchronous: the signal trips immediately.
		expect(signalBefore!.aborted).toBe(true);

		await inflight;
	});

	it("calls agent.abort() exactly once during dispose()", async () => {
		const { session } = createSession();
		const abortSpy = vi.spyOn(session.agent, "abort");

		session.dispose();

		expect(abortSpy).toHaveBeenCalledOnce();
	});

	it("does not throw when agent.abort() throws", () => {
		const { session } = createSession();
		vi.spyOn(session.agent, "abort").mockImplementation(() => {
			throw new Error("simulated abort failure");
		});

		expect(() => session.dispose()).not.toThrow();
	});

	it("still tears down listeners + cleans up resources after abort", () => {
		const { session } = createSession();

		session.dispose();

		// A second dispose() is safe: abort on an already-aborted controller is a no-op.
		expect(() => session.dispose()).not.toThrow();
	});
});
