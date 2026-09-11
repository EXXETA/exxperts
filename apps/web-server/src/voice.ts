import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

/**
 * Voice: the models exxperts talks with, and the routes that serve them.
 *
 * Nothing here uses the operating system's speech. Both directions run from
 * models the user downloads in Settings, the way a dictation app ships its
 * transcription models: one card per model, a size before the click, a delete
 * afterwards. The same files behave the same on every platform the server
 * runs on, and a paired phone gets the same voice because the audio is made
 * here and only played there.
 *
 * Both models run through one optional native dependency, sherpa-onnx-node.
 * It is loaded lazily and behind a try/catch, like the image renderer: a
 * machine without the platform binary keeps every other feature and the Voice
 * tab says so in words.
 */

export type VoiceModelId = "supertonic-3" | "nemotron-3.5";

export type VoiceModel = {
	id: VoiceModelId;
	name: string;
	/** What it does, in the user's terms. */
	blurb: string;
	kind: "speech-out" | "speech-in";
	languages: number;
	url: string;
	sha256: string;
	bytes: number;
	/** The folder the archive unpacks to, under the models root. */
	dir: string;
	/** Files that must exist for the model to count as installed. */
	files: string[];
};

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export const VOICE_MODELS: readonly VoiceModel[] = [
	{
		id: "supertonic-3",
		name: "Supertonic 3",
		blurb: "The voice exxperts speaks with. Ten speakers, natural pace, ready in half a second per sentence.",
		kind: "speech-out",
		languages: 31,
		url: `${RELEASES}/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2`,
		sha256: "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427",
		bytes: 128774318,
		dir: "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
		files: ["duration_predictor.int8.onnx", "text_encoder.int8.onnx", "vector_estimator.int8.onnx", "vocoder.int8.onnx", "tts.json", "unicode_indexer.bin", "voice.bin"],
	},
	{
		id: "nemotron-3.5",
		name: "Nemotron Streaming 3.5",
		blurb: "Live transcription of what you say, German and English alike, with the words appearing as you speak.",
		kind: "speech-in",
		languages: 40,
		url: `${RELEASES}/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2`,
		sha256: "c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a",
		bytes: 475271763,
		dir: "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11",
		files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
	},
];

export function findVoiceModel(id: string): VoiceModel | null {
	return VOICE_MODELS.find((model) => model.id === id) ?? null;
}

function modelsRoot(): string {
	return productAppStatePath("voice", "models");
}

function modelDir(model: VoiceModel): string {
	return path.join(modelsRoot(), model.dir);
}

export function isVoiceModelInstalled(model: VoiceModel): boolean {
	const dir = modelDir(model);
	return model.files.every((file) => fs.existsSync(path.join(dir, file)));
}

// ── Settings ────────────────────────────────────────────────────────────────

export type VoiceLanguage = "auto" | "de" | "en";
export type VoiceSettings = { speaker: number; speed: number; language: VoiceLanguage; talkKey: string };

/** Supertonic 3 ships ten voice styles; the engine reports the same number. */
export const SPEAKER_COUNT = 10;
const SPEEDS = { min: 0.7, max: 1.4 };
const SETTINGS_FILE = "voice.json";
export const DEFAULT_TALK_KEY = "Alt+Space";
const DEFAULT_SETTINGS: VoiceSettings = { speaker: 3, speed: 1, language: "auto", talkKey: DEFAULT_TALK_KEY };

/**
 * The talk key as the client stores it: modifiers, then the key's code if
 * there is one, "Alt+Space", "Ctrl+Alt" or "Fn+Shift". A key needs at least
 * one modifier, so a plain letter can never be taken away from typing;
 * modifiers on their own need at least two, so a lone Shift stays a Shift.
 */
const TALK_KEY_MODIFIERS = new Set(["Ctrl", "Alt", "Shift", "Meta", "Fn"]);
export function isValidTalkKey(text: string): boolean {
	if (text.length > 60) return false;
	const parts = text.split("+");
	if (parts.some((part) => !part)) return false;
	const modifiers = new Set<string>();
	let code: string | null = null;
	for (const [index, part] of parts.entries()) {
		if (TALK_KEY_MODIFIERS.has(part)) {
			if (modifiers.has(part) || code) return false;
			modifiers.add(part);
		} else if (index === parts.length - 1 && /^[A-Za-z0-9]{1,20}$/.test(part)) {
			code = part;
		} else {
			return false;
		}
	}
	return code ? modifiers.size >= 1 : modifiers.size >= 2;
}

export class VoiceSettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VoiceSettingsError";
	}
}

/** The voice model needed for this request is not downloaded. */
export class VoiceModelMissingError extends Error {
	constructor(public readonly model: VoiceModel) {
		super(`${model.name} is not downloaded yet. Download it under Settings › Voice.`);
		this.name = "VoiceModelMissingError";
	}
}

/** The native speech runtime could not be loaded on this system. */
export class VoiceUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VoiceUnavailableError";
	}
}

export function readVoiceSettings(): VoiceSettings {
	// ponytail: three cosmetic values; a broken file falls back to defaults and
	// the next save replaces it, unlike the search settings that refuse to save.
	try {
		const raw = JSON.parse(fs.readFileSync(productAppStatePath(SETTINGS_FILE), "utf8"));
		return normalizeSettings({ ...DEFAULT_SETTINGS, ...raw });
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

function normalizeSettings(input: Record<string, unknown>): VoiceSettings {
	const speaker = Number(input.speaker);
	if (!Number.isInteger(speaker) || speaker < 0 || speaker >= SPEAKER_COUNT) {
		throw new VoiceSettingsError(`The speaker must be one of the ${SPEAKER_COUNT} voices.`);
	}
	const speed = Number(input.speed);
	if (!Number.isFinite(speed) || speed < SPEEDS.min || speed > SPEEDS.max) {
		throw new VoiceSettingsError(`The speed must be between ${SPEEDS.min} and ${SPEEDS.max}.`);
	}
	const language = String(input.language ?? "");
	if (language !== "auto" && language !== "de" && language !== "en") {
		throw new VoiceSettingsError("The language must be auto, de or en.");
	}
	const talkKey = String(input.talkKey ?? "");
	if (!isValidTalkKey(talkKey)) {
		throw new VoiceSettingsError("The talk key must be a key with a modifier, or two or more modifiers together, for example Alt+Space or Ctrl+Alt.");
	}
	return { speaker, speed: Math.round(speed * 100) / 100, language, talkKey };
}

export function writeVoiceSettings(patch: Partial<Record<keyof VoiceSettings, unknown>>): VoiceSettings {
	const next = normalizeSettings({ ...readVoiceSettings(), ...definedOnly(patch) });
	const filePath = productAppStatePath(SETTINGS_FILE);
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
	return next;
}

function definedOnly<T extends object>(input: T): Partial<T> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/**
 * German or English, from the words a sentence cannot do without. Enough for
 * picking the pronunciation of a reply; anything finer would need a model.
 */
const GERMAN = new Set(["der", "die", "das", "und", "ist", "nicht", "ich", "mit", "für", "auf", "ein", "eine", "sie", "wir", "zu", "sind", "im", "den", "auch", "es"]);
const ENGLISH = new Set(["the", "and", "is", "not", "i", "with", "for", "on", "a", "an", "you", "we", "to", "of", "it", "are", "in", "that", "this", "have"]);

export function guessLanguage(text: string): "de" | "en" {
	let de = 0;
	let en = 0;
	for (const word of text.toLowerCase().split(/[^a-zäöüß]+/)) {
		if (GERMAN.has(word)) de++;
		if (ENGLISH.has(word)) en++;
	}
	return de > en ? "de" : "en";
}

// ── Downloads ───────────────────────────────────────────────────────────────

export type VoiceDownloadPhase = "idle" | "downloading" | "verifying" | "extracting" | "ready" | "error";
export type VoiceDownload = {
	phase: VoiceDownloadPhase;
	receivedBytes: number;
	totalBytes: number;
	/** Why it stopped, in the phases that stopped. */
	message: string | null;
	/** True while work is in flight, so the screen knows to keep polling. */
	running: boolean;
};

const downloads = new Map<VoiceModelId, VoiceDownload>();

function downloadState(model: VoiceModel): VoiceDownload {
	return downloads.get(model.id) ?? { phase: "idle", receivedBytes: 0, totalBytes: model.bytes, message: null, running: false };
}

/**
 * Start fetching a model. Returns immediately with the state; the screen polls
 * the settings payload. Asking twice while one runs reports the run, never a
 * second one. The file is hashed as it streams and unpacked only when the
 * digest matches the pinned one, so a truncated or tampered archive never
 * becomes an installed model.
 */
export function startVoiceModelDownload(model: VoiceModel): VoiceDownload {
	const current = downloads.get(model.id);
	if (current?.running) return current;
	if (isVoiceModelInstalled(model)) {
		const ready: VoiceDownload = { phase: "ready", receivedBytes: model.bytes, totalBytes: model.bytes, message: null, running: false };
		downloads.set(model.id, ready);
		return ready;
	}
	const state: VoiceDownload = { phase: "downloading", receivedBytes: 0, totalBytes: model.bytes, message: null, running: true };
	downloads.set(model.id, state);
	void runDownload(model, state);
	return state;
}

async function runDownload(model: VoiceModel, state: VoiceDownload): Promise<void> {
	const root = modelsRoot();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const partPath = path.join(root, `${model.dir}.tar.bz2.part`);
	try {
		const res = await fetch(model.url, { redirect: "follow" });
		if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}. Try again in a moment.`);
		const declared = Number(res.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > 0) state.totalBytes = declared;
		const hash = crypto.createHash("sha256");
		const out = fs.createWriteStream(partPath, { mode: 0o600 });
		for await (const chunk of res.body) {
			hash.update(chunk);
			state.receivedBytes += chunk.length;
			if (!out.write(chunk)) await once(out, "drain");
		}
		await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
		state.phase = "verifying";
		if (hash.digest("hex") !== model.sha256) {
			throw new Error("The downloaded file did not match its published checksum, so it was discarded. Try again.");
		}
		state.phase = "extracting";
		await extractTarBz2(partPath, root);
		if (!isVoiceModelInstalled(model)) throw new Error("The archive did not contain the expected model files.");
		state.phase = "ready";
	} catch (error) {
		state.phase = "error";
		state.message = (error as Error).message;
	} finally {
		fs.rmSync(partPath, { force: true });
		state.running = false;
	}
}

// ponytail: Node has no bzip2, and every platform the server ships for has a
// tar that does (bsdtar on macOS and Windows 10+, GNU tar on Linux). A pure
// JS decoder is the upgrade if a platform without tar ever appears.
function extractTarBz2(archive: string, destination: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("tar", ["-xjf", archive, "-C", destination], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (data) => { stderr += String(data); });
		child.on("error", () => reject(new Error("This system has no tar command to unpack the model with.")));
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking failed: ${stderr.trim() || `tar exited with ${code}`}`))));
	});
}

export function deleteVoiceModel(model: VoiceModel): void {
	unloadEngines();
	fs.rmSync(modelDir(model), { recursive: true, force: true });
	downloads.delete(model.id);
}

// ── Engines ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sherpa = any;
let sherpa: Sherpa | null | undefined;
let sherpaMessage: string | null = null;

async function loadSherpa(): Promise<Sherpa | null> {
	if (sherpa !== undefined) return sherpa;
	try {
		const mod = await import("sherpa-onnx-node");
		sherpa = (mod as { default?: Sherpa }).default ?? mod;
	} catch (error) {
		sherpa = null;
		sherpaMessage = `The speech runtime could not be loaded on this system (${(error as Error).message.split("\n")[0]}).`;
	}
	return sherpa;
}

export async function voiceEngineStatus(): Promise<{ available: boolean; message: string | null }> {
	return { available: (await loadSherpa()) !== null, message: sherpaMessage };
}

const IDLE_UNLOAD_MS = 10 * 60_000;
const threads = () => Math.min(4, os.availableParallelism());

type Loaded = { engine: Sherpa; idle: NodeJS.Timeout | null; users: number };
let tts: Loaded | null = null;
let asr: Loaded | null = null;

/** Memory comes back ten minutes after the last use; a live session holds it. */
function touch(loaded: Loaded, unload: () => void): void {
	if (loaded.idle) clearTimeout(loaded.idle);
	loaded.idle = null;
	if (loaded.users > 0) return;
	loaded.idle = setTimeout(unload, IDLE_UNLOAD_MS);
	loaded.idle.unref();
}

function unloadEngines(): void {
	for (const loaded of [tts, asr]) if (loaded?.idle) clearTimeout(loaded.idle);
	tts = null;
	asr = null;
}

async function requireEngine(id: VoiceModelId): Promise<{ s: Sherpa; dir: string }> {
	const s = await loadSherpa();
	if (!s) throw new VoiceUnavailableError(sherpaMessage ?? "The speech runtime is unavailable.");
	const model = findVoiceModel(id)!;
	if (!isVoiceModelInstalled(model)) throw new VoiceModelMissingError(model);
	return { s, dir: modelDir(model) };
}

async function getTts(): Promise<Sherpa> {
	if (!tts) {
		const { s, dir } = await requireEngine("supertonic-3");
		const engine = new s.OfflineTts({
			model: {
				supertonic: {
					durationPredictor: path.join(dir, "duration_predictor.int8.onnx"),
					textEncoder: path.join(dir, "text_encoder.int8.onnx"),
					vectorEstimator: path.join(dir, "vector_estimator.int8.onnx"),
					vocoder: path.join(dir, "vocoder.int8.onnx"),
					ttsJson: path.join(dir, "tts.json"),
					unicodeIndexer: path.join(dir, "unicode_indexer.bin"),
					voiceStyle: path.join(dir, "voice.bin"),
				},
				numThreads: threads(),
				provider: "cpu",
				debug: false,
			},
			maxNumSentences: 1,
		});
		tts = { engine, idle: null, users: 0 };
	}
	touch(tts, () => { tts = null; });
	return tts.engine;
}

async function getRecognizer(): Promise<Loaded> {
	if (!asr) {
		const { s, dir } = await requireEngine("nemotron-3.5");
		const engine = new s.OnlineRecognizer({
			featConfig: { sampleRate: 16000, featureDim: 128 },
			modelConfig: {
				transducer: { encoder: path.join(dir, "encoder.int8.onnx"), decoder: path.join(dir, "decoder.int8.onnx"), joiner: path.join(dir, "joiner.int8.onnx") },
				tokens: path.join(dir, "tokens.txt"),
				numThreads: threads(),
				provider: "cpu",
				debug: false,
			},
			// No endpoint detection: the talk key says when a sentence ends.
			enableEndpoint: false,
		});
		asr = { engine, idle: null, users: 0 };
	}
	touch(asr, () => { asr = null; });
	return asr;
}

// ── Speech out ──────────────────────────────────────────────────────────────

export const MAX_TTS_CHARS = 2000;

export async function synthesizeSpeech(text: string, overrides: Partial<VoiceSettings> = {}): Promise<{ wav: Buffer; seconds: number }> {
	const engine = await getTts();
	const s = (await loadSherpa())!;
	const settings = normalizeSettings({ ...readVoiceSettings(), ...definedOnly(overrides) });
	const lang = settings.language === "auto" ? guessLanguage(text) : settings.language;
	const generationConfig = new s.GenerationConfig({ sid: settings.speaker, speed: settings.speed, numSteps: 8, extra: { lang } });
	const audio = await engine.generateAsync({ text, generationConfig });
	return { wav: wavFromFloat32(audio.samples, audio.sampleRate), seconds: audio.samples.length / audio.sampleRate };
}

/** 16-bit mono PCM in a RIFF container: what every browser decodes without a codec. */
export function wavFromFloat32(samples: Float32Array, sampleRate: number): Buffer {
	const data = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		data.writeInt16LE(Math.round(clamped * 32767), i * 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

// ── Speech in ───────────────────────────────────────────────────────────────

export type RecognitionEvent = { type: "partial"; text: string } | { type: "final"; text: string };

export type RecognitionSession = {
	/** 16 kHz mono signed 16-bit little-endian frames, any length. */
	pushPcm16(frame: Buffer): void;
	/** The talk key came up: decode what is in flight, emit it as one final, and get ready for the next hold. */
	flush(): void;
	/** No more audio at all: emit what is left, without preparing for another utterance. */
	finish(): void;
	/** Release the stream; call once, after finish or on disconnect. */
	close(): void;
};

/** Silence fed after the last frame, so the streaming model's look-ahead lets the last words out. */
const TAIL_SILENCE_SAMPLES = 16000;
/** Silence fed in front of every utterance: the model drops the first half second of a stream that starts mid-word. */
const LEAD_SILENCE_SAMPLES = 8000;

/**
 * One microphone stream, push-to-talk. Frames arrive while the talk key is
 * held and partials go back as the words change. Releasing the key flushes
 * what was said as one final, and the stream is made ready for the next
 * hold. Nothing is decided from silence: the key says when a sentence ends,
 * so a pause to think is just a pause.
 */
export async function createRecognitionSession(language: VoiceLanguage, onEvent: (event: RecognitionEvent) => void): Promise<RecognitionSession> {
	const loaded = await getRecognizer();
	const rec = loaded.engine;
	const stream = rec.createStream();
	if (language !== "auto") stream.setOption("language", language);
	stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(LEAD_SILENCE_SAMPLES) });
	loaded.users++;
	let last = "";
	let open = true;
	const decode = (): string => {
		while (rec.isReady(stream)) rec.decode(stream);
		return String(rec.getResult(stream).text ?? "").trim();
	};
	return {
		pushPcm16(frame) {
			if (!open) return;
			const count = frame.length >> 1;
			const samples = new Float32Array(count);
			for (let i = 0; i < count; i++) samples[i] = frame.readInt16LE(i * 2) / 32768;
			stream.acceptWaveform({ sampleRate: 16000, samples });
			const text = decode();
			if (text !== last) {
				last = text;
				if (text) onEvent({ type: "partial", text });
			}
		},
		flush() {
			if (!open) return;
			stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(TAIL_SILENCE_SAMPLES) });
			// An empty final still goes out: the client is waiting to learn
			// whether the hold said anything.
			onEvent({ type: "final", text: decode() });
			rec.reset(stream);
			stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(LEAD_SILENCE_SAMPLES) });
			last = "";
		},
		finish() {
			if (!open) return;
			stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(TAIL_SILENCE_SAMPLES) });
			stream.inputFinished();
			const text = decode();
			if (text) onEvent({ type: "final", text });
			last = "";
		},
		close() {
			if (!open) return;
			open = false;
			loaded.users = Math.max(0, loaded.users - 1);
			touch(loaded, () => { asr = null; });
		},
	};
}

function normalizeLanguage(value: unknown): VoiceLanguage {
	const text = String(value ?? "").trim();
	return text === "de" || text === "en" ? text : "auto";
}

// ── Spoken turns ────────────────────────────────────────────────────────────

/**
 * One line for a turn the user spoke rather than typed. It asks for prose a
 * voice can read, nothing about narrating steps: the app narrates from the
 * tool chips on its own, so the model's message stays the answer and nothing
 * else. Appended per turn rather than in the system prompt, because the
 * runtime bakes the system prompt at load and a session-level change would
 * outlive the conversation. The client renders and saves the text it sent,
 * so this never appears in the room.
 */
export const SPOKEN_CONVERSATION_HINT =
	"[Spoken conversation: the user is listening, not reading. Answer in plain spoken prose, concise, in the user's language; no headings, tables or lists unless asked for a document.]";

export function withSpokenConversationHint(text: string, spoken: boolean): string {
	return spoken ? `${text}\n\n${SPOKEN_CONVERSATION_HINT}` : text;
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** The routes below, for the remote policy coverage smoke. */
export const VOICE_ROUTE_KEYS = [
	"GET /api/voice/settings",
	"PUT /api/voice/settings",
	"POST /api/voice/models/:id/download",
	"DELETE /api/voice/models/:id",
	"POST /api/voice/tts",
	"GET /ws/voice",
] as const;

export async function voiceSettingsPayload() {
	return {
		settings: readVoiceSettings(),
		engine: await voiceEngineStatus(),
		speakers: SPEAKER_COUNT,
		models: VOICE_MODELS.map((model) => ({
			id: model.id,
			name: model.name,
			blurb: model.blurb,
			kind: model.kind,
			languages: model.languages,
			bytes: model.bytes,
			installed: isVoiceModelInstalled(model),
			download: downloadState(model),
		})),
	};
}

export function registerVoiceApi(app: FastifyInstance): void {
	app.get("/api/voice/settings", async () => voiceSettingsPayload());

	app.put("/api/voice/settings", async (req, reply) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		try {
			writeVoiceSettings({ speaker: body.speaker, speed: body.speed, language: body.language, talkKey: body.talkKey });
		} catch (error) {
			if (error instanceof VoiceSettingsError) return reply.code(400).send({ error: error.message });
			return reply.code(500).send({ error: (error as Error).message });
		}
		return voiceSettingsPayload();
	});

	app.post("/api/voice/models/:id/download", async (req, reply) => {
		const model = findVoiceModel(String((req.params as { id: string }).id));
		if (!model) return reply.code(404).send({ error: "No such voice model." });
		return startVoiceModelDownload(model);
	});

	app.delete("/api/voice/models/:id", async (req, reply) => {
		const model = findVoiceModel(String((req.params as { id: string }).id));
		if (!model) return reply.code(404).send({ error: "No such voice model." });
		if (downloadState(model).running) return reply.code(409).send({ error: `${model.name} is still downloading.` });
		deleteVoiceModel(model);
		return voiceSettingsPayload();
	});

	// One sentence in, a WAV out. The client asks per sentence and prefetches
	// the next while one plays, which is why this is a plain request and not a
	// stream.
	app.post("/api/voice/tts", async (req, reply) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const text = String(body.text ?? "").trim();
		if (!text) return reply.code(400).send({ error: "Nothing to say." });
		if (text.length > MAX_TTS_CHARS) return reply.code(400).send({ error: `Speak at most ${MAX_TTS_CHARS} characters at a time.` });
		try {
			const { wav, seconds } = await synthesizeSpeech(text, {
				speaker: body.speaker as number | undefined,
				speed: body.speed as number | undefined,
				language: body.language as VoiceLanguage | undefined,
			});
			return reply.type("audio/wav").header("cache-control", "no-store").header("x-voice-seconds", seconds.toFixed(2)).send(wav);
		} catch (error) {
			if (error instanceof VoiceSettingsError) return reply.code(400).send({ error: error.message });
			if (error instanceof VoiceModelMissingError) return reply.code(409).send({ error: error.message, code: "model_missing", model: error.model.id });
			if (error instanceof VoiceUnavailableError) return reply.code(503).send({ error: error.message, code: "voice_unavailable" });
			return reply.code(500).send({ error: (error as Error).message });
		}
	});

	// Binary 16 kHz PCM frames in while the talk key is held; JSON partials
	// back as the words change; {type:"flush"} on release answers with one
	// final. The client waits for {type:"ready"} before sending audio, because
	// the model may be loading on first use and a frame sent before the stream
	// exists would be lost without a trace.
	app.get("/ws/voice", { websocket: true }, async (socket, req) => {
		const params = new URLSearchParams(String((req as { url?: string }).url ?? "").split("?")[1] ?? "");
		const settings = readVoiceSettings();
		const language = normalizeLanguage(params.get("language") ?? settings.language);
		const send = (payload: unknown) => { try { socket.send(JSON.stringify(payload)); } catch {} };
		let session: RecognitionSession;
		try {
			session = await createRecognitionSession(language, send);
		} catch (error) {
			const code = error instanceof VoiceModelMissingError ? "model_missing" : error instanceof VoiceUnavailableError ? "voice_unavailable" : "error";
			send({ type: "error", code, message: (error as Error).message });
			socket.close();
			return;
		}
		socket.on("message", (raw: Buffer, isBinary: boolean) => {
			if (isBinary) {
				session.pushPcm16(raw);
				return;
			}
			let msg: { type?: string } | null = null;
			try { msg = JSON.parse(raw.toString()); } catch { return; }
			if (msg?.type === "flush") {
				session.flush();
				return;
			}
			if (msg?.type === "stop") {
				session.finish();
				send({ type: "stopped" });
				socket.close();
			}
		});
		socket.on("close", () => session.close());
		send({ type: "ready", language });
	});
}
