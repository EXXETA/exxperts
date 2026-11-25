// The setup the smokes share that need a provider with a limit on a request's
// size: a synthetic OpenAI-compatible endpoint that refuses a request over the
// limit (after reading all of it, as a gateway does), a real server on a scratch
// home, and a room driven over its socket whose folder holds pictures to read.
//
// "read <name>" in a message makes the model call `read` on that file,
// "read small-01..25" on all of those at once, and "open <name>" makes it call
// `read_file` on a file attached to the room; with the results back it answers.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { ROOM_STATE_HEADING } from "../src/room-state-message.js";
import { authedFetch, freePort, killSmokeServer, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { waitEvery } from "./smoke-wait.js";

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export const waitUntil = waitEvery(25);

export const REQUEST_TOO_LARGE = { status: 413, body: { error: { type: "request_too_large", message: "Request Entity Too Large" } } };
export const INPUT_TOO_LONG = { status: 400, body: { error: { message: "Input is too long." } } };
/** Anthropic's own refusal, as a gateway in front of it words it. */
export const ANTHROPIC_TOO_LARGE = { status: 413, body: { error: { message: 'AnthropicException - {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}' } } };
/** Words the runtime takes for a conversation that is too long, so it shortens it. */
export const TOO_LONG_FOR_MODEL = { status: 400, body: { error: { message: "Input is too long for requested model." } } };
/** The same from Amazon Bedrock behind LiteLLM. */
export const TOO_LONG_LITELLM = {
	status: 400,
	body: {
		error: {
			message: `litellm.ContextWindowExceededError: litellm.BadRequestError: BedrockException: Context Window Error - {"message":"Input is too long for requested model."}\nmodel=claude-haiku-5.5. context_window_fallbacks=None. fallbacks=[{"claude-haiku-5.5":["claude-sonnet-5.5"]}].\nLiteLLM: model group 'claude-haiku-5.5' failed with the error above and no fallback model group was found for it, so the request was not retried on another model.`,
			type: "invalid_request_error",
			param: null,
			code: "400",
		},
	},
};

export interface RecordedRequest {
	bytes: number;
	pictures: number;
	summary: boolean;
	refused: boolean;
	/** The key that paid for it. */
	key: unknown;
}

const PROVIDER = "openai-compatible";
const MODEL = "room-model";

function textOf(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
}

/** The endpoint, and what a scene sets while it runs. */
export class SizeLimitGateway {
	readonly requests: RecordedRequest[] = [];
	limitBytes: number | undefined;
	refusal: { status: number; body: unknown } = REQUEST_TOO_LARGE;
	/** Refuses the next so many chat requests, whatever their size. */
	refuseChats = 0;
	/** Never answers a chat request over this size, nor refuses it. */
	silentBytes: number | undefined;
	/** Refuses a chat request that carries this many pictures or more, whatever its size. */
	limitPictures: number | undefined;
	/** Holds the summaries asked for until the caller gives up. */
	holdSummaries = false;
	url = "";
	private readonly server = http.createServer((req, res) => this.answer(req, res));

	async listen(): Promise<void> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
	}

	close(): void {
		this.server.closeAllConnections();
		this.server.close();
	}

	private answer(req: http.IncomingMessage, res: http.ServerResponse): void {
		const parts: Buffer[] = [];
		req.on("data", (chunk: Buffer) => parts.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(parts);
			if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const body = JSON.parse(raw.toString("utf8"));
			const messages: any[] = body.messages;
			const tools: string[] = (body.tools ?? []).map((tool: any) => tool?.function?.name);
			const summary = tools.length === 0;
			const pictures = messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part: any) => part?.type === "image_url").length;
			const counted = !summary && this.refuseChats > 0;
			if (counted) this.refuseChats -= 1;
			const refused = !summary && (counted || (this.limitBytes !== undefined && raw.length > this.limitBytes) || (this.limitPictures !== undefined && pictures >= this.limitPictures));
			this.requests.push({ bytes: raw.length, pictures, summary, refused, key: req.headers.authorization });
			if (refused) {
				res.writeHead(this.refusal.status, { "content-type": "application/json" }).end(JSON.stringify(this.refusal.body));
				return;
			}
			if (summary ? this.holdSummaries : this.silentBytes !== undefined && raw.length > this.silentBytes) return;
			// Not the person's: the room-state copy, and the message that carries a tool result's pictures.
			const appText = (message: any) => textOf(message).startsWith(ROOM_STATE_HEADING) || textOf(message).startsWith("Attached image(s) from tool result:");
			const asked = messages.map((message) => message.role === "user" && !appText(message)).lastIndexOf(true);
			const words = textOf(messages[asked]);
			const range = /\bread ([a-z]+)-(\d+)\.\.(\d+)/.exec(words);
			const one = /\bread (\S+\.png)/.exec(words);
			const names = range
				? Array.from({ length: Number(range[3]) - Number(range[2]) + 1 }, (_, i) => `${range[1]}-${String(Number(range[2]) + i).padStart(2, "0")}.png`)
				: one ? [one[1]!] : [];
			const opened = /\bopen (\S+\.(?:png|pdf))/.exec(words)?.[1];
			const resultsBack = messages.slice(asked + 1).some((message) => message.role === "tool");
			const base = { id: `cmpl_${this.requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model };
			const send = (delta: unknown, finish: string | null, extra: object = {}) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
			const usage = { usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 } };
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (names.length > 0 && !resultsBack && tools.includes("read")) {
				names.forEach((name, i) => send({ tool_calls: [{ index: i, id: `call_${this.requests.length}_${i}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: name }) } }] }, null));
				send({}, "tool_calls", usage);
			} else if (opened && !resultsBack && tools.includes("read_file")) {
				send({ tool_calls: [{ index: 0, id: `call_${this.requests.length}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ name: opened }) } }] }, null);
				send({}, "tool_calls", usage);
			} else {
				// A summary keeps what was asked for, so the model reads those pictures again.
				send({ content: summary ? `## Goal\n${/\bread [a-z]+-\d+\.\.\d+/.exec(raw.toString("utf8"))?.[0] ?? "Read the pictures."}` : `Answered: ${words.slice(-40)}` }, null);
				send({}, "stop", usage);
			}
			res.end("data: [DONE]\n\n");
		});
	}
}

// zlib's own crc32 is newer than the oldest Node the app runs on.
function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** A picture of noise, which no compression makes smaller. */
function noisePng(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const named = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(named));
		return Buffer.concat([length, named, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2], 8);
	const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), crypto.randomBytes(width * 3)])));
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** A scanned document: a PDF of pages that are pictures of noise, with no text. */
export function scannedPdf(pages: number): Buffer {
	const side = 500;
	const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
	const offsets: number[] = [];
	const object = (id: number, dictionary: string, stream?: Buffer) => {
		offsets[id] = parts.reduce((sum, part) => sum + part.length, 0);
		parts.push(Buffer.from(`${id} 0 obj\n${stream ? dictionary.replace(/>>$/, `/Length ${stream.length} >>\nstream\n`) : `${dictionary}\n`}`));
		if (stream) parts.push(stream, Buffer.from("\nendstream\n"));
		parts.push(Buffer.from("endobj\n"));
	};
	const page = (i: number) => 3 + i * 3;
	object(1, "<< /Type /Catalog /Pages 2 0 R >>");
	object(2, `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${page(i)} 0 R`).join(" ")}] /Count ${pages} >>`);
	for (let i = 0; i < pages; i++) {
		object(page(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${side} ${side}] /Resources << /XObject << /Scan ${page(i) + 2} 0 R >> >> /Contents ${page(i) + 1} 0 R >>`);
		object(page(i) + 1, "<< >>", Buffer.from(`q ${side} 0 0 ${side} 0 0 cm /Scan Do Q`));
		object(page(i) + 2, `<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 >>`, crypto.randomBytes(side * side * 3));
	}
	const xref = parts.reduce((sum, part) => sum + part.length, 0);
	parts.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
	return Buffer.concat(parts);
}

type Frame = Record<string, any>;
const WebSocketImpl: any = (await import("ws")).default;

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webServerDir, "..", "..");

export class SizeLimitRooms {
	readonly gateway = new SizeLimitGateway();
	readonly home = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-size-limit-"));
	private readonly agentDir = path.join(this.home, ".exxperts", "agent");
	private readonly appDir = path.join(this.home, ".exxperts", "app");
	private readonly pictures = path.join(this.home, "pictures");
	private server: ChildProcessWithoutNullStreams | undefined;
	private port = 0;
	readonly output: string[] = [];
	private readonly opened: SizeLimitRoom[] = [];

	async open(): Promise<void> {
		await this.gateway.listen();
		for (const dir of [this.agentDir, this.appDir, this.pictures]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
		write(path.join(this.agentDir, "models.json"), { providers: { [PROVIDER]: { name: "Synthetic Gateway", baseUrl: this.gateway.url, api: "openai-completions", models: [{ id: MODEL, name: "Room Model", input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 }] } } });
		write(path.join(this.agentDir, "auth.json"), { [PROVIDER]: { type: "api_key", key: "synthetic-key" } });
		write(path.join(this.appDir, "openai-compatible-ai-profile.json"), { profileId: PROVIDER, providerId: PROVIDER, label: "Synthetic Gateway", roomModels: [{ modelId: MODEL, label: "Room Model" }], maintenanceModel: MODEL });
		write(path.join(this.appDir, "persistent-agent-ai-profile.json"), { profileId: PROVIDER });
		// A small kept window, so a short conversation has something to shorten.
		write(path.join(this.agentDir, "settings.json"), { compaction: { keepRecentTokens: 5 } });
		await this.start();
	}

	async start(): Promise<void> {
		this.port = await freePort();
		this.server = spawn("npx", ["tsx", "src/index.ts"], {
			shell: process.platform === "win32",
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env: { ...smokeHomeEnv(this.home, { PORT: String(this.port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, LOG_LEVEL: "warn" }), EXXPERTS_CODING_AGENT_DIR: this.agentDir } as NodeJS.ProcessEnv,
		});
		this.server.stdout.on("data", (chunk) => this.output.push(String(chunk)));
		this.server.stderr.on("data", (chunk) => this.output.push(String(chunk)));
		await waitForServer(this.server, this.baseUrl, 60_000);
	}

	/** Ends the server at once, as a crash does, and starts it again on the same home. */
	async restart(): Promise<void> {
		for (const room of this.opened) room.close();
		await killSmokeServer(this.server);
		await this.start();
	}

	async close(): Promise<void> {
		for (const room of this.opened) room.close();
		this.gateway.close();
		await stopSmokeServer(this.server);
		fs.rmSync(this.home, { recursive: true, force: true });
	}

	private get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Where a browser signs in to the app. */
	get signInUrl(): string {
		return `${this.baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`;
	}

	readonly json = async (pathname: string, method = "GET", body?: unknown): Promise<{ status: number; body: any }> => {
		const response = await authedFetch(`${this.baseUrl}${pathname}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : null };
	};

	socket(roomId: string, conversationId: string): any {
		return new WebSocketImpl(`${this.baseUrl.replace("http", "ws")}/ws?persistentAgentId=${roomId}&conversationId=${conversationId}&modelProvider=${PROVIDER}&model=${MODEL}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	}

	/** Pictures of about this size in the folder the rooms read from: `<name>-01.png` and so on. */
	addPictures(name: string, count: number, width: number, height: number): void {
		for (let i = 1; i <= count; i++) fs.writeFileSync(path.join(this.pictures, `${name}-${String(i).padStart(2, "0")}.png`), noisePng(width, height));
	}

	/** One of those pictures. */
	picture(name: string): Buffer {
		return fs.readFileSync(path.join(this.pictures, name));
	}

	/** Attaches a file to a room as the page does, for a paste, a drop or the paper clip. */
	async attach(roomId: string, filename: string, content: Buffer): Promise<void> {
		const uploaded = await this.json(`/api/persistent-agents/${roomId}/files`, "POST", { filename, contentBase64: content.toString("base64") });
		assert(uploaded.body?.name === filename, `${filename} is attached, got ${uploaded.status} ${JSON.stringify(uploaded.body)}`);
	}

	/** A room with the pictures' folder, and its id. */
	async makeRoom(displayName: string): Promise<string> {
		const created = await this.json("/api/persistent-agents", "POST", { displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		const id = String(created.body?.agent?.id ?? "");
		assert(created.status === 201 && id, `the room is made, got ${created.status} ${JSON.stringify(created.body)}`);
		const folder = await this.json(`/api/persistent-agents/${id}/workspace-default`, "PUT", { root: this.pictures, workspaceAccessMode: "localFiles" });
		assert(folder.status === 200, `the room's folder is set, got ${folder.status} ${JSON.stringify(folder.body)}`);
		return id;
	}

	async room(displayName: string): Promise<SizeLimitRoom> {
		const id = await this.makeRoom(displayName);
		const conversationId = `conv_${crypto.randomUUID().slice(0, 8)}`;
		const thread = await this.json(`/api/persistent-agents/${id}/threads/${conversationId}`, "PUT", { state: "active", origin: "launcher", model: { provider: PROVIDER, model: MODEL }, items: [] });
		assert(thread.status === 200, `the conversation is made, got ${thread.status} ${JSON.stringify(thread.body)}`);
		const room = new SizeLimitRoom(this, id, conversationId);
		this.opened.push(room);
		await room.connect();
		return room;
	}

	/** The usage rows recorded for a room. */
	usageRows(roomId: string): any[] {
		const file = path.join(this.appDir, "usage.jsonl");
		if (!fs.existsSync(file)) return [];
		return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => JSON.stringify(row).includes(roomId));
	}

	/** How many pictures the room's saved conversation holds. */
	savedPictures(roomId: string): number {
		let count = 0;
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith(".jsonl") && full.includes(roomId)) count += fs.readFileSync(full, "utf8").split('"type":"image"').length - 1;
			}
		};
		walk(this.appDir);
		return count;
	}
}

/** What one message led to. */
export interface Turn {
	requests: RecordedRequest[];
	answer: string;
	failures: Frame[];
	frames: Frame[];
}

export class SizeLimitRoom {
	private frames: Frame[] = [];
	private ws: any;

	constructor(private readonly rooms: SizeLimitRooms, readonly id: string, private readonly conversationId: string) {}

	async connect(): Promise<void> {
		this.frames = [];
		this.ws = this.rooms.socket(this.id, this.conversationId);
		this.ws.on("message", (data: unknown) => { this.frames.push(JSON.parse(String(data))); });
		this.ws.on("error", () => {});
		await waitUntil(() => this.frames.some((frame) => frame.type === "ready"), `${this.id} is ready`);
	}

	close(): void {
		this.ws?.close();
	}

	send(frame: Frame): void {
		this.ws.send(JSON.stringify(frame));
	}

	/** Sends a message without waiting for its answer. */
	start(text: string): { requests: number; frames: number } {
		const from = { requests: this.rooms.gateway.requests.length, frames: this.frames.length };
		this.send({ type: "prompt", text });
		return from;
	}

	framesFrom(index: number): Frame[] {
		return this.frames.slice(index);
	}

	async settled(label: string, timeoutMs = 30_000): Promise<void> {
		await waitForTurnSettled(this.rooms.json, this.id, label, timeoutMs);
	}

	/** The end of the turn a message started, as its page sees it. */
	async ended(from: { requests: number; frames: number }, label: string): Promise<Turn> {
		await waitUntil(() => this.framesFrom(from.frames).some((frame) => frame.event?.type === "agent_end"), `${label} ends`);
		await this.settled(`${label} settles`);
		const frames = this.framesFrom(from.frames);
		const texts = frames.filter((frame) => frame.event?.type === "message_end" && frame.event.message?.role === "assistant").flatMap((frame) => frame.event.message.content ?? []);
		return {
			requests: this.rooms.gateway.requests.slice(from.requests),
			answer: texts.filter((part: any) => part?.type === "text").map((part: any) => part.text).join(""),
			failures: frames.filter((frame) => frame.event?.failure || frame.type === "error" || (frame.type === "ui_request" && frame.level === "error")),
			frames,
		};
	}

	async say(text: string): Promise<Turn> {
		return this.ended(this.start(text), `"${text}"`);
	}
}
