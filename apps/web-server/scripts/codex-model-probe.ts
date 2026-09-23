// Codex model probe (dev only).
//
// Asks the ChatGPT subscription backend (the openai-codex provider, endpoint
// /codex/responses) whether it serves a given model id, using the ChatGPT
// sign-in already stored by exxperts. Nothing is written beyond the sign-in's
// own token refresh; the access token and the account id travel only inside
// the one request and are never printed.
//
// Run from the repository root with a ChatGPT Plus/Pro sign-in in place:
//
//     npx tsx apps/web-server/scripts/codex-model-probe.ts gpt-6-astra
//
// Prints the HTTP status and either the first error message or the first 40
// characters of the answer. Exit code 0 on a served model, 1 on a refusal or a
// failed stream, 2 when no ChatGPT sign-in is found.

import { AuthStorage } from "@exxeta/exxperts-runtime";
import os from "node:os";

const PROVIDER_ID = "openai-codex";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const TIMEOUT_MS = 60_000;
const ANSWER_PREVIEW_CHARS = 40;
const ERROR_PREVIEW_CHARS = 200;

function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function decodeBase64Url(segment: string): string {
	const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	return Buffer.from(padded, "base64").toString("utf8");
}

function extractAccountId(token: string): string | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>;
		const auth = payload[JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined;
		const accountId = auth?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
	} catch {
		return null;
	}
}

function buildHeaders(accountId: string, token: string): Headers {
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("User-Agent", `pi (${os.platform()} ${os.release()}; ${os.arch()})`);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	return headers;
}

function buildRequestBody(modelId: string): Record<string, unknown> {
	return {
		model: modelId,
		store: false,
		stream: true,
		instructions: "You are a helpful assistant.",
		input: [{ role: "user", content: [{ type: "input_text", text: "Reply with the single word ok." }] }],
		text: { verbosity: "low" },
		include: ["reasoning.encrypted_content"],
		tool_choice: "auto",
		parallel_tool_calls: true,
	};
}

function printInterestingHeaders(headers: Headers): void {
	const lines: string[] = [];
	headers.forEach((value, name) => {
		const lower = name.toLowerCase();
		if (lower.includes("auth") || lower.includes("cookie") || lower.includes("account")) return;
		if (lower.startsWith("x-") || lower.includes("context") || lower.includes("model")) {
			lines.push(`header ${lower}: ${value}`);
		}
	});
	for (const line of lines) console.log(line);
}

function firstErrorMessage(bodyText: string): string {
	try {
		const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } | string };
		if (typeof parsed.error === "string") return parsed.error;
		const message = parsed.error?.message;
		if (typeof message === "string" && message.length > 0) return message;
	} catch {}
	return bodyText.slice(0, ERROR_PREVIEW_CHARS);
}

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const data = chunk
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("\n")
					.trim();
				if (data && data !== "[DONE]") {
					yield JSON.parse(data) as Record<string, unknown>;
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

type StreamOutcome = { answer: string; servedModel?: string; error?: string };

async function readStream(response: Response): Promise<StreamOutcome> {
	let answer = "";
	let servedModel: string | undefined;
	for await (const event of parseSSE(response)) {
		const type = typeof event.type === "string" ? event.type : "";
		if (type === "error") {
			const message = typeof event.message === "string" ? event.message : "";
			const code = typeof event.code === "string" ? event.code : "";
			return { answer, servedModel, error: message || code || JSON.stringify(event).slice(0, ERROR_PREVIEW_CHARS) };
		}
		if (type === "response.failed") {
			const failed = event.response as { error?: { message?: unknown; code?: unknown } } | undefined;
			const message = failed?.error?.message;
			const code = failed?.error?.code;
			return {
				answer,
				servedModel,
				error: typeof message === "string" && message ? message : typeof code === "string" ? code : "response failed",
			};
		}
		if (type === "response.output_text.delta") {
			if (typeof event.delta === "string") answer += event.delta;
			continue;
		}
		if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
			const completed = event.response as { model?: unknown } | undefined;
			if (typeof completed?.model === "string") servedModel = completed.model;
			break;
		}
	}
	return { answer, servedModel };
}

async function main(): Promise<number> {
	const modelId = process.argv[2]?.trim();
	if (!modelId) {
		console.error("usage: npx tsx apps/web-server/scripts/codex-model-probe.ts <model-id>");
		return 2;
	}

	const authStorage = AuthStorage.create();
	const token = await authStorage.getApiKey(PROVIDER_ID);
	if (!token) {
		console.log("no ChatGPT sign-in found (sign in to exxperts with ChatGPT Plus/Pro first)");
		return 2;
	}
	const accountId = extractAccountId(token);
	if (!accountId) {
		console.log("the stored ChatGPT sign-in carries no account id (sign in to exxperts with ChatGPT Plus/Pro again)");
		return 2;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(resolveCodexUrl(), {
			method: "POST",
			headers: buildHeaders(accountId, token),
			body: JSON.stringify(buildRequestBody(modelId)),
			signal: controller.signal,
		});
	} catch (error) {
		clearTimeout(timer);
		if (controller.signal.aborted) {
			console.log(`aborted: no response within ${TIMEOUT_MS / 1000} s`);
		} else {
			console.log(`request failed before a response: ${error instanceof Error ? error.message : String(error)}`);
		}
		return 1;
	}

	try {
		console.log(`status ${response.status}`);
		printInterestingHeaders(response.headers);

		if (!response.ok) {
			const bodyText = await response.text();
			console.log(`error: ${firstErrorMessage(bodyText)}`);
			return 1;
		}

		const outcome = await readStream(response);
		if (outcome.servedModel) console.log(`served model: ${outcome.servedModel}`);
		if (outcome.error) {
			console.log(`error: ${outcome.error}`);
			return 1;
		}
		console.log(`answer: ${outcome.answer.slice(0, ANSWER_PREVIEW_CHARS)}`);
		return 0;
	} catch (error) {
		if (controller.signal.aborted) {
			console.log(`aborted: the stream did not finish within ${TIMEOUT_MS / 1000} s`);
		} else {
			console.log(`stream failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return 1;
	} finally {
		clearTimeout(timer);
	}
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.log(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	},
);
