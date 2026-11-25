// What each provider is sent once old pictures are left out of a refused
// request: the line as the answer of a tool result whose only content was a
// picture now left out, so no tool result goes out empty.
//
// - A real session, opened on a saved conversation of 8 pictures, is refused
//   once for its size: the same request goes out again without the 4 oldest,
//   and the saved file only grows.
// - With pictures blocked nothing is sent again, and none goes out.
// - The line says the pictures were seen where a finished answer of a model that
//   takes pictures came after them, and else that they were left out; the same in
//   a new session on the saved conversation.
// - Each provider's own request built from that one: its line 4 times and the
//   other never, the 4 pictures kept, and the person's own picture.
//
// Offline: scripted streams, and provider requests stopped before they are sent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, getModels, registerApiProvider, stream, type AssistantMessage, type Context, type KnownProvider, type Message, type Model } from "@exxeta/exxperts-ai";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager } from "@exxeta/exxperts-runtime";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-request-image-budget-"));
process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;

const LEFT_OUT_LINE = "[One or more earlier pictures were left out here to keep this conversation small enough to send. Read the file again if you need it.]";
const SEEN_LINE = "[You saw one or more pictures here earlier; they are left out now to keep this conversation small enough to send. What you said about them then was based on seeing them. Read the file again if you need to look.]";
const PICTURE = "A".repeat(100_000);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const base = getModels("anthropic").find((candidate) => candidate.input.includes("image"))!;
const model = { ...base, api: "request-image-budget-smoke" } as Model<any>;
const otherWithPictures = getModels("openai").find((candidate) => candidate.input.includes("image"))!;
const otherWithout = getModels("mistral").find((candidate) => !candidate.input.includes("image"))!;

// Answers as a provider with a limit: refuses a request of more than 4 pictures that tools returned.
const requests: Message[][] = [];
function toolPictures(messages: Message[]): number {
	return messages.flatMap((message) => (message.role === "toolResult" ? message.content : [])).filter((block) => block.type === "image").length;
}
function answering(_model: unknown, context: Context) {
	requests.push(context.messages);
	const refused = toolPictures(context.messages) > 4;
	const message: AssistantMessage = {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(),
		...(refused ? { content: [], stopReason: "error", errorMessage: "413 Request Entity Too Large", errorStatus: 413 } : { content: [{ type: "text", text: "Here you go." }], stopReason: "stop" }),
	};
	const events = createAssistantMessageEventStream();
	queueMicrotask(() => {
		events.push({ type: "start", partial: message });
		events.push(refused ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message });
	});
	return events;
}
registerApiProvider({ api: model.api, stream: answering, streamSimple: answering });

const answer = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], timestamp: number, by: Model<any> = model): AssistantMessage => ({ role: "assistant", content, api: by.api, provider: by.provider, model: by.id, usage, stopReason, timestamp });

function conversation(last: AssistantMessage): Message[] {
	const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Mine." }, { type: "image", data: PICTURE, mimeType: "image/png" }], timestamp: 1 }];
	for (let i = 1; i <= 8; i++) {
		messages.push(
			answer([{ type: "toolCall", id: `p${i}`, name: "read", arguments: { path: `${i}.png` } }], "toolUse", i * 10),
			// A picture-only result: nothing else in it may keep it from being empty.
			{ role: "toolResult", toolCallId: `p${i}`, toolName: "read", content: [{ type: "image", data: PICTURE, mimeType: "image/png" }], isError: false, timestamp: i * 10 + 1 },
		);
	}
	return [...messages, last];
}

function saveConversation(last: AssistantMessage): string {
	const dir = fs.mkdtempSync(path.join(tempRoot, "room-"));
	const written = SessionManager.create(dir, path.join(dir, "sessions"));
	for (const message of conversation(last)) written.appendMessage(message as any);
	return written.getSessionFile()!;
}

async function ask(file: string, blockImages = false): Promise<{ sent: Message[][]; before: string; saved: string }> {
	const dir = path.dirname(path.dirname(file));
	const before = fs.readFileSync(file, "utf-8");
	const authStorage = AuthStorage.create(path.join(dir, "auth.json"));
	// A made-up key: the session asks for one before the first call.
	authStorage.setRuntimeApiKey(model.provider, "made-up");
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model,
		authStorage,
		modelRegistry: ModelRegistry.create(authStorage, path.join(dir, "models.json")),
		settingsManager: SettingsManager.inMemory({ images: { blockImages } }),
		sessionManager: SessionManager.open(file),
	});
	const from = requests.length;
	try {
		await session.prompt("What do they say?");
	} finally {
		session.dispose();
	}
	return { sent: requests.slice(from), before, saved: fs.readFileSync(file, "utf-8") };
}

// The line of each result of the saved conversation whose picture was left out, by its call id.
function linesSent(messages: Message[]): string[] {
	return messages.flatMap((message) => (message.role === "toolResult" ? message.content.flatMap((block) => (block.type === "text" ? [`${message.toolCallId} ${block.text}`] : [])) : []));
}

try {
	const providers: KnownProvider[] = ["anthropic", "amazon-bedrock", "openai", "openai-codex", "azure-openai-responses", "openrouter", "google", "google-vertex", "mistral"];
	const seen = [{ type: "text" as const, text: "Seen." }];
	const cases: { name: string; last: AssistantMessage; line: string; other: string }[] = [
		{ name: "a finished answer", last: answer(seen, "stop", 100), line: SEEN_LINE, other: LEFT_OUT_LINE },
		{ name: "a failed answer", last: { ...answer(seen, "error", 100), errorMessage: "503 overloaded" }, line: LEFT_OUT_LINE, other: SEEN_LINE },
		{ name: "another model's answer that takes pictures", last: answer(seen, "stop", 100, otherWithPictures), line: SEEN_LINE, other: LEFT_OUT_LINE },
		{ name: "another model's answer that takes none", last: answer(seen, "stop", 100, otherWithout), line: LEFT_OUT_LINE, other: SEEN_LINE },
	];
	for (const { name, last, line, other } of cases) {
		const file = saveConversation(last);
		const { sent, before, saved } = await ask(file);
		assert(sent.length === 2, `${name}: the refused request is sent again once, got ${sent.length} requests`);
		assert(toolPictures(sent[0]!) === 8 && toolPictures(sent[1]!) === 4, `${name}: without the 4 oldest of 8 pictures, got ${sent.map(toolPictures)}`);
		assert(saved.startsWith(before), `${name}: what was saved before stays as it was`);
		assert(saved.split('"type":"image"').length - 1 === 9, `${name}: the saved conversation still holds every picture`);
		assert(!saved.includes(LEFT_OUT_LINE) && !saved.includes(SEEN_LINE) && !saved.includes("Request Entity Too Large"), `${name}: neither line nor the refusal is saved`);
		const lines = linesSent(sent[1]!);
		assert(JSON.stringify(lines) === JSON.stringify([1, 2, 3, 4].map((i) => `p${i} ${line}`)), `after ${name}: ${lines.join(" | ")}`);
		const again = await ask(file);
		assert(JSON.stringify(linesSent(again.sent.at(-1)!).slice(0, 4)) === JSON.stringify(lines), `after ${name}, in a new session: ${linesSent(again.sent.at(-1)!).join(" | ")}`);
		pass(`a refused request goes out again without the oldest pictures, with the line of ${name}, and the same after a restart`);

		for (const provider of providers) {
			const target = getModels(provider).find((candidate) => candidate.input.includes("image"));
			assert(target, `${provider} has a model that sees pictures`);
			const payloads: unknown[] = [];
			const token = provider === "openai-codex" ? `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "made-up" } })).toString("base64")}.x` : "made-up";
			const options = { apiKey: token, project: "made-up", location: "made-up", region: "us-east-1", azureBaseUrl: "http://127.0.0.1:1", onPayload: (payload: unknown) => { payloads.push(payload); throw new Error("stopped before sending"); } };
			await stream({ ...target, baseUrl: "http://127.0.0.1:1" } as any, { systemPrompt: "Test.", messages: sent[1]! }, options as any).result();
			assert(payloads.length === 1, `${provider} builds its request`);
			const payload = JSON.stringify(payloads[0], (_key, value) => (value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value));
			const shown = payload.split(line).length - 1;
			assert(shown === 4 && !payload.includes(other), `after ${name}, ${provider} sends the line in each of the 4 results whose picture was left out, got ${shown}`);
			const pictures = payload.split(/A{90000,}/).length - 1;
			assert(pictures === 5, `${provider} sends the 4 pictures kept and the person's own, got ${pictures}`);
		}
		pass(`every provider sends that line as the answer of a tool result whose only content was a picture left out`);
	}

	const blocked = await ask(saveConversation(answer(seen, "stop", 100)), true);
	assert(blocked.sent.length === 1 && !JSON.stringify(blocked.sent).includes('"type":"image"'), "with pictures blocked, none goes out");
	pass("with pictures blocked, none goes out");
	console.log("request-image-budget smoke passed");
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
