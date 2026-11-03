// A preload for a lab server that thinking-levels-sweep.ts drives: it records
// what each provider request asked for in thinking, and what thinking came
// back, so the sweep reads the request as it left the process rather than
// what the code meant to send.
//
//   NODE_OPTIONS="--import <this file>" THINKING_SWEEP_LOG=<file.jsonl> <server>
//
// THINKING_SWEEP_HOSTS (comma separated, host or host:port) names the
// provider hosts; it defaults to the OpenAI, Anthropic and ChatGPT ones.
//
// It keeps the request body's thinking fields and a summary of the answer
// (usage, thinking blocks, the effort the answer reports, an error's text).
// Headers are never read, so no key, token or cookie reaches the log.
//
// A log it cannot write stops the process at start, and a call it cannot log
// later is refused before it leaves (and every call after it): a sweep must
// never pay for calls nobody records.
//
// Two lines per call, joined by `seq`: a "request" line when it leaves and an
// "answer" line when its stream ends. The ChatGPT sign-in streams over a
// WebSocket by default, so the WebSocket constructor is wrapped as well as
// fetch.
import fs from "node:fs";

const LOG = process.env.THINKING_SWEEP_LOG;
const HOSTS = (process.env.THINKING_SWEEP_HOSTS || "api.openai.com,api.anthropic.com,chatgpt.com")
	.split(",")
	.map((host) => host.trim())
	.filter(Boolean);

let counter = 0;
let writeFailed = false;

function watched(url) {
	try {
		const parsed = new URL(String(url));
		return HOSTS.includes(parsed.host) || HOSTS.includes(parsed.hostname);
	} catch {
		return false;
	}
}

// Returns whether the line was written.
function write(line) {
	if (writeFailed) return false;
	try {
		fs.appendFileSync(LOG, `${JSON.stringify(line)}\n`);
		return true;
	} catch (error) {
		console.error(`thinking-levels-sweep-recorder: THINKING_SWEEP_LOG ${LOG} cannot be written: ${error?.message ?? error}`);
		writeFailed = true;
		return false;
	}
}

// The thinking fields of a request body, and nothing else from it.
function thinkingFields(body) {
	const sent = {};
	if (body.reasoning !== undefined) sent.reasoning = body.reasoning;
	if (body.reasoning_effort !== undefined) sent.reasoning_effort = body.reasoning_effort;
	if (body.thinking !== undefined) sent.thinking = body.thinking;
	if (body.output_config?.effort !== undefined) sent.output_config = { effort: body.output_config.effort };
	return sent;
}

function startRecord(url, transport, body) {
	const seq = `${process.pid}-${++counter}`;
	if (!write({ kind: "request", seq, at: Date.now(), path: new URL(String(url)).pathname, transport, model: body.model ?? null, sent: thinkingFields(body) })) {
		throw new Error(`thinking-levels-sweep-recorder: refused to send a call it cannot log to THINKING_SWEEP_LOG ${LOG}`);
	}
	return seq;
}

function newAnswer() {
	return { reasoningTokens: 0, reasoningItems: 0, thinkingBlocks: 0, thinkingChars: 0, effort: null, inputTokens: 0, outputTokens: 0, error: null };
}

function errorText(value) {
	const message = value?.error?.message ?? value?.message ?? value?.error ?? value;
	return String(typeof message === "string" ? message : JSON.stringify(message)).slice(0, 300);
}

// One streamed event or one whole JSON answer, whichever provider shaped it.
// Returns true when the event ends the answer.
function absorb(answer, event) {
	if (!event || typeof event !== "object") return false;
	switch (event.type) {
		case "message_start":
			answer.inputTokens = event.message?.usage?.input_tokens ?? answer.inputTokens;
			return false;
		case "content_block_start":
			if (event.content_block?.type === "thinking" || event.content_block?.type === "redacted_thinking") answer.thinkingBlocks++;
			return false;
		case "content_block_delta":
			if (event.delta?.type === "thinking_delta") answer.thinkingChars += String(event.delta.thinking ?? "").length;
			return false;
		case "message_delta":
			answer.outputTokens = event.usage?.output_tokens ?? answer.outputTokens;
			return false;
		case "message_stop":
			return true;
		case "response.output_item.added":
			if (event.item?.type === "reasoning") answer.reasoningItems++;
			return false;
		case "response.reasoning_summary_text.delta":
		case "response.reasoning_text.delta":
			answer.thinkingChars += String(event.delta ?? "").length;
			return false;
		case "response.completed":
		case "response.done":
		case "response.incomplete":
		case "response.failed": {
			const response = event.response ?? {};
			answer.effort = response.reasoning?.effort ?? answer.effort;
			answer.inputTokens = response.usage?.input_tokens ?? answer.inputTokens;
			answer.outputTokens = response.usage?.output_tokens ?? answer.outputTokens;
			answer.reasoningTokens = response.usage?.output_tokens_details?.reasoning_tokens ?? answer.reasoningTokens;
			if (response.error) answer.error = errorText(response.error);
			return true;
		}
		case "error":
			answer.error = errorText(event);
			return true;
	}
	// Chat completions: no event type, choices and a closing usage.
	for (const choice of event.choices ?? []) {
		const delta = choice.delta ?? choice.message ?? {};
		answer.thinkingChars += String(delta.reasoning_content ?? delta.reasoning ?? "").length;
	}
	if (event.usage) {
		answer.inputTokens = event.usage.prompt_tokens ?? answer.inputTokens;
		answer.outputTokens = event.usage.completion_tokens ?? answer.outputTokens;
		answer.reasoningTokens = event.usage.completion_tokens_details?.reasoning_tokens ?? answer.reasoningTokens;
	}
	return false;
}

async function readAnswer(seq, response) {
	const answer = newAnswer();
	try {
		const text = await response.text();
		if (response.status >= 400) {
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {}
			answer.error = `${response.status} ${parsed ? errorText(parsed) : text.slice(0, 300)}`;
		} else if (/^\s*[{[]/.test(text)) {
			try {
				absorb(answer, JSON.parse(text));
			} catch {}
		} else {
			for (const line of text.split("\n")) {
				if (!line.startsWith("data:")) continue;
				try {
					absorb(answer, JSON.parse(line.slice(5).trim()));
				} catch {}
			}
		}
	} catch (error) {
		answer.error = `answer unreadable: ${error?.message ?? error}`;
	}
	write({ kind: "answer", seq, status: response.status, ...answer });
}

if (LOG) {
	try {
		fs.appendFileSync(LOG, "");
	} catch (error) {
		throw new Error(`thinking-levels-sweep-recorder: THINKING_SWEEP_LOG ${LOG} cannot be written: ${error?.message ?? error}`);
	}
	const nativeFetch = globalThis.fetch;
	globalThis.fetch = async function recordedFetch(input, init) {
		const url = typeof input === "string" || input instanceof URL ? input : input?.url;
		let body;
		if (watched(url) && typeof init?.body === "string") {
			try {
				body = JSON.parse(init.body);
			} catch {}
		}
		if (!body?.model) return nativeFetch(input, init);
		const seq = startRecord(url, "fetch", body);
		let response;
		try {
			response = await nativeFetch(input, init);
		} catch (error) {
			write({ kind: "answer", seq, status: 0, ...newAnswer(), error: `fetch failed: ${error?.message ?? error}` });
			throw error;
		}
		// A clone keeps the caller's response whole (its url, its stream).
		void readAnswer(seq, response.clone());
		return response;
	};

	const NativeWebSocket = globalThis.WebSocket;
	if (typeof NativeWebSocket === "function") {
		globalThis.WebSocket = class RecordedWebSocket extends NativeWebSocket {
			#url;
			#current = null;

			constructor(url, protocols) {
				super(url, protocols);
				if (!watched(url)) return;
				this.#url = url;
				this.addEventListener("message", (event) => {
					if (!this.#current || typeof event.data !== "string") return;
					let parsed;
					try {
						parsed = JSON.parse(event.data);
					} catch {
						return;
					}
					if (absorb(this.#current.answer, parsed)) this.#finish(200);
				});
				this.addEventListener("close", () => this.#finish(0, "socket closed before the answer ended"));
			}

			#finish(status, error) {
				if (!this.#current) return;
				const { seq, answer } = this.#current;
				this.#current = null;
				write({ kind: "answer", seq, status, ...answer, ...(error && !answer.error ? { error } : {}) });
			}

			send(data) {
				if (this.#url && typeof data === "string") {
					let body;
					try {
						body = JSON.parse(data);
					} catch {}
					if (body?.model) this.#current = { seq: startRecord(this.#url, "websocket", body), answer: newAnswer() };
				}
				return super.send(data);
			}
		};
	}
}
