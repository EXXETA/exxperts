import { useEffect, useRef, useState } from "react";
import { formatTalkKey, talkKeyFromEvent } from "../voice/talk-key";
import { apiFetch, fetchJson } from "../api";
import { useRemoteClientContext } from "../remote-client-context";

/**
 * Settings › Voice: the two downloaded models exxperts talks with, and how it
 * sounds.
 *
 * One card per model, like a dictation app's model list: what it does, how
 * many languages, how big, then Download or Delete. Nothing speaks or listens
 * before the matching model is on disk, and the cards say so instead of
 * hiding it. The voice controls below only mean something once the speaking
 * model is present, so they wait for it.
 *
 * Nothing here moves until the server says it moved: every control shows a
 * pending state while its save is in flight and takes its value from the
 * server's answer.
 */

type VoiceLanguage = "auto" | "de" | "en";
type VoiceDownload = {
	phase: "idle" | "downloading" | "verifying" | "extracting" | "ready" | "error";
	receivedBytes: number;
	totalBytes: number;
	message: string | null;
	running: boolean;
};
type VoiceModelCard = {
	id: string;
	name: string;
	blurb: string;
	kind: "speech-out" | "speech-in";
	languages: number;
	bytes: number;
	installed: boolean;
	download: VoiceDownload;
};
type VoicePayload = {
	settings: { speaker: number; speed: number; language: VoiceLanguage; talkKey: string };
	engine: { available: boolean; message: string | null };
	speakers: number;
	models: VoiceModelCard[];
};

const SAMPLE = {
	de: "Guten Tag. So klingt exxperts, wenn es mit Ihnen spricht.",
	en: "Hello. This is how exxperts sounds when it talks with you.",
} as const;
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3];
const isMac = navigator.userAgent.includes("Macintosh");

function megabytes(bytes: number): string {
	return `${Math.round(bytes / 1_000_000)} MB`;
}

/** What the card says while a download runs or after it stopped. */
function downloadLine(download: VoiceDownload): string | null {
	switch (download.phase) {
		case "downloading":
			return download.totalBytes ? `Downloading, ${megabytes(download.receivedBytes)} of ${megabytes(download.totalBytes)}.` : "Downloading…";
		case "verifying":
			return "Checking the download.";
		case "extracting":
			return "Unpacking.";
		case "error":
			return download.message ?? "The download failed.";
		default:
			return null;
	}
}

export function VoiceSettingsSection({ onTalkKeyChange }: { onTalkKeyChange?: (talkKey: string) => void } = {}) {
	const remoteClient = useRemoteClientContext();
	const [data, setData] = useState<VoicePayload | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	/** Which control is mid-request, so only that one shows as busy. */
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [playing, setPlaying] = useState(false);
	/** Recording a new talk key: the next combination pressed becomes it. */
	const [recordingKey, setRecordingKey] = useState(false);
	const [keyHint, setKeyHint] = useState<string | null>(null);
	// One audio context for the tab; browsers cap how many a page may open.
	const audioContext = useRef<AudioContext | null>(null);

	async function load(): Promise<void> {
		try {
			setData(await fetchJson<VoicePayload>("/api/voice/settings"));
			setLoadError(null);
		} catch (e) {
			const message = (e as Error).message;
			setLoadError(/\(404\)/.test(message) ? "This server does not offer voice yet. Update it to use voice from here." : message);
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => { void load(); }, []);

	// Polled only while a download is actually running. A download started before
	// this screen was opened is picked up the same way.
	const downloading = data?.models.some((model) => model.download.running) ?? false;
	useEffect(() => {
		if (!downloading) return;
		const timer = window.setInterval(() => void load(), 1000);
		return () => window.clearInterval(timer);
	}, [downloading]);

	async function request(kind: string, run: () => Promise<VoicePayload | void>): Promise<void> {
		setBusy(kind);
		setError(null);
		try {
			const next = await run();
			if (next) setData(next);
			else await load();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(null);
		}
	}

	const saveSettings = (patch: Partial<VoicePayload["settings"]>) =>
		request("settings", async () => {
			const next = await fetchJson<VoicePayload>("/api/voice/settings", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(patch),
			});
			if (patch.talkKey) onTalkKeyChange?.(next.settings.talkKey);
			return next;
		});

	// While recording, the next key press with a modifier becomes the talk key.
	// Escape gives up; a bare modifier is waited through; a key without one is
	// refused with a hint, since a plain letter must stay typeable.
	useEffect(() => {
		if (!recordingKey) return;
		const onKey = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape") { setRecordingKey(false); setKeyHint(null); return; }
			if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
			const text = talkKeyFromEvent(event);
			if (!text) { setKeyHint(`Add a modifier, for example ${isMac ? "⌥" : "Alt"}, so typing keeps working.`); return; }
			setRecordingKey(false);
			setKeyHint(null);
			void saveSettings({ talkKey: text });
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [recordingKey]);

	const download = (id: string) => request(id, async () => { await fetchJson(`/api/voice/models/${id}/download`, { method: "POST" }); });
	const remove = (id: string) => request(id, () => fetchJson<VoicePayload>(`/api/voice/models/${id}`, { method: "DELETE" }));

	async function playSample(): Promise<void> {
		if (!data) return;
		setPlaying(true);
		setError(null);
		try {
			const language = data.settings.language === "auto" ? (navigator.language.toLowerCase().startsWith("de") ? "de" : "en") : data.settings.language;
			const res = await apiFetch("/api/voice/tts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: SAMPLE[language] }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(String(body?.error ?? `Request failed (${res.status})`));
			}
			// Played through the audio graph, not a media element: the bytes came
			// over fetch, so no media source has to be allowed anywhere.
			const context = (audioContext.current ??= new AudioContext());
			const buffer = await context.decodeAudioData(await res.arrayBuffer());
			const source = context.createBufferSource();
			source.buffer = buffer;
			source.connect(context.destination);
			source.onended = () => setPlaying(false);
			source.start();
		} catch (e) {
			setError((e as Error).message);
			setPlaying(false);
		}
	}

	if (loading) {
		return (
			<section className="ai-setup-section" aria-label="Voice">
				<p className="ai-setup-copy" role="status">Reading the current setting…</p>
			</section>
		);
	}

	if (loadError || !data) {
		return (
			<section className="ai-setup-section" aria-label="Voice">
				<div className="workspaces-error archived-rooms-note" role="alert">{loadError ?? "Could not read the voice settings."}</div>
				<p><button className="inline-action" type="button" onClick={() => void load()}>Try again</button></p>
			</section>
		);
	}

	const speaking = data.models.find((model) => model.kind === "speech-out");
	const canSpeak = data.engine.available && (speaking?.installed ?? false);
	const settingsBusy = busy === "settings";

	return (
		<section className="ai-setup-section" aria-label="Voice">
			<p className="ai-setup-copy">
				Talk with exxperts and hear it answer. Both directions run from models downloaded onto this computer; nothing is
				sent anywhere and no operating-system voice is involved.
			</p>

			{!data.engine.available && (
				<div className="workspaces-error archived-rooms-note" role="alert">
					Voice is unavailable on this system. {data.engine.message}
				</div>
			)}

			<h3 className="web-search-fallback-heading">Models</h3>
			<div className="voice-models">
				{data.models.map((model) => {
					const line = downloadLine(model.download);
					const failed = model.download.phase === "error";
					const running = model.download.running;
					const progress = running && model.download.totalBytes ? Math.min(1, model.download.receivedBytes / model.download.totalBytes) : null;
					return (
						<div key={model.id} className={`voice-model${model.installed ? " installed" : ""}`}>
							<div className="voice-model-body">
								<span className="voice-model-name">{model.name}</span>
								<span className="voice-model-blurb">{model.blurb}</span>
								<span className="voice-model-meta">
									{model.kind === "speech-out" ? "Speech out" : "Speech in"} · {model.languages} languages · {megabytes(model.bytes)}
								</span>
							</div>
							<div className="voice-model-actions">
								{remoteClient.remote ? (
									<span className="voice-model-status">{model.installed ? "Downloaded" : "Not downloaded"}</span>
								) : model.installed ? (
									<>
										<span className="voice-model-status">Downloaded</span>
										<button className="inline-action" type="button" disabled={busy !== null} onClick={() => void remove(model.id)}>
											{busy === model.id ? "Deleting…" : "Delete"}
										</button>
									</>
								) : (
									<button
										className="inline-action"
										type="button"
										disabled={busy !== null || running || !data.engine.available}
										title={`Download ${megabytes(model.bytes)} from the sherpa-onnx releases on GitHub. Checked against a pinned checksum before use.`}
										onClick={() => void download(model.id)}
									>
										{running || busy === model.id ? "Downloading…" : `Download ${megabytes(model.bytes)}`}
									</button>
								)}
								{progress !== null && (
									<span className="voice-progress" aria-hidden="true"><span style={{ width: `${Math.round(progress * 100)}%` }} /></span>
								)}
								{line && <span className={`voice-model-status${failed ? " failed" : ""}`} role="status">{line}</span>}
							</div>
						</div>
					);
				})}
			</div>

			<h3 className="web-search-fallback-heading">Voice</h3>
			{remoteClient.remote ? (
				<p className="ai-setup-copy">
					Speaker {data.settings.speaker + 1} at {data.settings.speed.toFixed(1)}× speed, language {data.settings.language === "auto" ? "detected per sentence" : data.settings.language === "de" ? "German" : "English"}, talk key {formatTalkKey(data.settings.talkKey, isMac)}.
					Voice is set up on the computer itself.
				</p>
			) : (
				<div className={`voice-controls${settingsBusy ? " pending" : ""}`}>
					<label>
						Speaker
						<select value={data.settings.speaker} disabled={settingsBusy} onChange={(e) => void saveSettings({ speaker: Number(e.target.value) })}>
							{Array.from({ length: data.speakers }, (_, index) => (
								<option key={index} value={index}>Voice {index + 1}</option>
							))}
						</select>
					</label>
					<label>
						Speed
						<select value={String(data.settings.speed)} disabled={settingsBusy} onChange={(e) => void saveSettings({ speed: Number(e.target.value) })}>
							{SPEEDS.map((speed) => (
								<option key={speed} value={String(speed)}>{speed.toFixed(1)}×</option>
							))}
						</select>
					</label>
					<label>
						Language
						<select value={data.settings.language} disabled={settingsBusy} onChange={(e) => void saveSettings({ language: e.target.value as VoiceLanguage })}>
							<option value="auto">Auto</option>
							<option value="de">Deutsch</option>
							<option value="en">English</option>
						</select>
					</label>
					<label>
						Talk key
						<button
							type="button"
							className={`inline-action voice-key${recordingKey ? " recording" : ""}`}
							disabled={settingsBusy}
							title="Change the key you hold to talk. Press the new combination after clicking."
							onClick={() => { setKeyHint(null); setRecordingKey(true); }}
						>
							{recordingKey ? "Press a combination…" : formatTalkKey(data.settings.talkKey, isMac)}
						</button>
					</label>
					<span className="voice-controls-hint">
						{keyHint ?? "Hold it anywhere in a room and talk; release to send. Pressing it while the room answers cuts the answer off."}
					</span>
				</div>
			)}
			<p>
				<button
					className="inline-action"
					type="button"
					disabled={!canSpeak || playing}
					title={canSpeak ? "Hear one sentence in the current voice." : `Download ${speaking?.name ?? "the speaking model"} first.`}
					onClick={() => void playSample()}
				>
					{playing ? "Playing…" : "Play sample"}
				</button>
			</p>
			<p className="cli-note">Dictation tools you already use keep working in the text field exactly as before.</p>
			{error && <div className="workspaces-error archived-rooms-note" role="alert">{error}</div>}
		</section>
	);
}
