// Smoke for the voice engine (apps/web-server/src/voice.ts): settings, the
// model catalogue, the remote route policy, the WAV encoder and the language
// guess run everywhere. The round trip, one sentence spoken by Supertonic 3
// and heard back by Nemotron 3.5, runs only when both models are downloaded
// on this machine (Settings › Voice) and says so when it is skipped.
//
// Run: npm run smokes -- voice   (or tsx this file)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// The real models, if the developer downloaded them, before HOME moves.
const realModelsRoot = path.join(os.homedir(), ".exxperts", "app", "voice", "models");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-voice-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const voice = await import("../src/voice.js");
const { classifyRemoteRoute } = await import("../src/remote-route-policy.js");

try {
	// Settings: defaults without a file, validation, persistence.
	assert(JSON.stringify(voice.readVoiceSettings()) === JSON.stringify({ speaker: 3, speed: 1, language: "auto" }), "defaults without a file");
	for (const bad of [{ speaker: 12 }, { speaker: -1 }, { speaker: 1.5 }, { speed: 5 }, { speed: "fast" }, { language: "fr" }]) {
		let threw = false;
		try { voice.writeVoiceSettings(bad as never); } catch (e) { threw = e instanceof voice.VoiceSettingsError; }
		assert(threw, `must refuse ${JSON.stringify(bad)}`);
	}
	assert(!fs.existsSync(path.join(tempHome, ".exxperts", "app", "voice.json")), "a refused save writes nothing");
	const saved = voice.writeVoiceSettings({ speaker: 5, language: "de" });
	assert(saved.speaker === 5 && saved.speed === 1 && saved.language === "de", "a patch keeps the untouched values");
	assert(JSON.stringify(voice.readVoiceSettings()) === JSON.stringify(saved), "what was written is what is read");
	assert(fs.existsSync(path.join(tempHome, ".exxperts", "app", "voice.json")), "settings live in ~/.exxperts/app/voice.json");

	// Catalogue: pinned, checksummed, from one origin.
	assert(voice.VOICE_MODELS.length === 2, "two models");
	assert(new Set(voice.VOICE_MODELS.map((m) => m.id)).size === 2, "ids are unique");
	for (const model of voice.VOICE_MODELS) {
		assert(/^[0-9a-f]{64}$/.test(model.sha256), `${model.id} has a sha256`);
		assert(model.url.startsWith("https://github.com/k2-fsa/sherpa-onnx/releases/download/"), `${model.id} downloads from the sherpa-onnx releases`);
		assert(model.bytes > 1_000_000 && model.files.length > 0 && model.dir.length > 0, `${model.id} has a size, files and a folder`);
		assert(!voice.isVoiceModelInstalled(model), `${model.id} is not installed in a fresh home`);
	}
	assert(voice.findVoiceModel("nope") === null, "unknown ids resolve to null");

	// Payload: what the Voice tab draws.
	const payload = await voice.voiceSettingsPayload();
	assert(payload.models.length === 2 && payload.models.every((m) => !m.installed && m.download.phase === "idle" && !m.download.running), "fresh payload: nothing installed, nothing running");
	assert(typeof payload.engine.available === "boolean", "engine availability is a boolean");
	assert(payload.speakers === 10, "ten speakers");

	// Remote route policy: every voice route classified, with the intended class.
	const expected: Record<string, string> = {
		"GET /api/voice/settings": "read",
		"PUT /api/voice/settings": "local",
		"POST /api/voice/models/:id/download": "local",
		"DELETE /api/voice/models/:id": "local",
		"POST /api/voice/tts": "read",
		"GET /ws/voice": "write",
	};
	assert(voice.VOICE_ROUTE_KEYS.length === Object.keys(expected).length, "route key list matches");
	for (const key of voice.VOICE_ROUTE_KEYS) {
		const [method, url] = key.split(" ");
		assert(classifyRemoteRoute(method, url) === expected[key], `${key} must be classified ${expected[key]}, got ${classifyRemoteRoute(method, url)}`);
	}

	// WAV: a RIFF header a browser decodes, 16-bit samples, clamped.
	// 0.25 scales to exactly 8191.75 either way; a half like 0.5 would round
	// differently for the negative sample and test JS rounding, not the encoder.
	const wav = voice.wavFromFloat32(new Float32Array([0, 0.25, -0.25, 2, -2]), 16000);
	assert(wav.length === 44 + 10, "44-byte header plus two bytes per sample");
	assert(wav.toString("ascii", 0, 4) === "RIFF" && wav.toString("ascii", 8, 12) === "WAVE" && wav.toString("ascii", 36, 40) === "data", "RIFF/WAVE/data markers");
	assert(wav.readUInt32LE(24) === 16000 && wav.readUInt16LE(22) === 1 && wav.readUInt16LE(34) === 16, "16 kHz mono 16-bit");
	assert(wav.readUInt32LE(40) === 10 && wav.readUInt32LE(4) === 36 + 10, "sizes");
	assert(wav.readInt16LE(44) === 0 && wav.readInt16LE(46) === 8192 && wav.readInt16LE(48) === -8192, "sample scaling");
	assert(wav.readInt16LE(50) === 32767 && wav.readInt16LE(52) === -32767, "out-of-range samples clamp");

	// Language guess: the pronunciation hint for the speaker.
	assert(voice.guessLanguage("Der Termin ist morgen und wir sind nicht da.") === "de", "German is German");
	assert(voice.guessLanguage("The meeting is tomorrow and we are not there.") === "en", "English is English");
	assert(voice.guessLanguage("Okay.") === "en", "no signal falls back to English");

	// Round trip through both models, when they are on this machine.
	const installedForReal = voice.VOICE_MODELS.every((model) => fs.existsSync(path.join(realModelsRoot, model.dir, model.files[0])));
	if (!installedForReal || !payload.engine.available) {
		console.log(`voice-smoke: round trip skipped (${payload.engine.available ? "models not downloaded under Settings › Voice" : payload.engine.message})`);
	} else {
		const tempModels = path.join(tempHome, ".exxperts", "app", "voice", "models");
		fs.mkdirSync(tempModels, { recursive: true });
		for (const model of voice.VOICE_MODELS) fs.symlinkSync(path.join(realModelsRoot, model.dir), path.join(tempModels, model.dir));
		assert((await voice.voiceSettingsPayload()).models.every((m) => m.installed), "symlinked models count as installed");

		const sentence = "Guten Morgen, das ist ein Test.";
		const t0 = Date.now();
		const spoken = await voice.synthesizeSpeech(sentence, { language: "de", speaker: 3 });
		const synthMs = Date.now() - t0;
		assert(spoken.wav.length > 44 && spoken.seconds > 0.8 && spoken.seconds < 6, `a short sentence is a short clip (${spoken.seconds.toFixed(2)} s)`);

		// Decode our own WAV back to floats and resample to the recogniser's 16 kHz.
		const rate = spoken.wav.readUInt32LE(24);
		const count = (spoken.wav.length - 44) / 2;
		const source = new Float32Array(count);
		for (let i = 0; i < count; i++) source[i] = spoken.wav.readInt16LE(44 + i * 2) / 32768;
		const ratio = rate / 16000;
		const resampled = new Int16Array(Math.floor(count / ratio));
		for (let i = 0; i < resampled.length; i++) {
			const at = i * ratio;
			const lo = Math.floor(at);
			const hi = Math.min(count - 1, lo + 1);
			const mix = source[lo] + (source[hi] - source[lo]) * (at - lo);
			resampled[i] = Math.round(Math.max(-1, Math.min(1, mix)) * 32767);
		}
		const pcm = Buffer.from(resampled.buffer);

		const heard: string[] = [];
		let partials = 0;
		const session = await voice.createRecognitionSession("de", (event) => {
			if (event.type === "final") heard.push(event.text);
			else partials++;
		});
		const frame = 3200; // 100 ms, the size a microphone worklet would send
		const t1 = Date.now();
		for (let offset = 0; offset < pcm.length; offset += frame) session.pushPcm16(pcm.subarray(offset, offset + frame));
		session.finish();
		session.close();
		const decodeMs = Date.now() - t1;
		const text = heard.join(" ");
		assert(partials > 0, "partials arrive while the audio streams");
		assert(/test/i.test(text) && /morgen/i.test(text), `the sentence comes back (heard: ${JSON.stringify(text)})`);
		console.log(`voice-smoke: round trip OK — spoke ${spoken.seconds.toFixed(1)} s in ${synthMs} ms, heard ${JSON.stringify(text)} in ${decodeMs} ms`);
	}

	console.log("voice-smoke: OK");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
