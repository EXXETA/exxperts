import { apiFetch } from "../api";

/**
 * Sentences in, sound out, in order. Each sentence is one request to the
 * server's speech route; the next sentence's audio is requested while the
 * current one plays, so speech runs continuously as long as the model writes
 * faster than the voice reads, which it does.
 *
 * Playback goes through the audio graph, not a media element: the bytes
 * arrive over fetch, so nothing needs to be allowed as a media source.
 */

export type SpeechFailure = { code: string; message: string };

type Item = { text: string; audio?: Promise<AudioBuffer> };

export class SpeechQueue {
	private readonly context: AudioContext;
	private items: Item[] = [];
	private current: AudioBufferSourceNode | null = null;
	private playing = false;
	private stopped = false;
	private generation = 0;

	constructor(private readonly hooks: { onStateChange(speaking: boolean): void; onError(failure: SpeechFailure): void }) {
		// Created inside the user's click, so the graph is unlocked on every platform.
		this.context = new AudioContext();
	}

	get idle(): boolean {
		return !this.playing && this.items.length === 0;
	}

	say(text: string): void {
		if (this.stopped || !text.trim()) return;
		this.items.push({ text });
		this.prefetch();
		if (!this.playing) void this.pump();
	}

	/** Fall silent now and forget what was queued; the conversation goes on. */
	clear(): void {
		this.generation++;
		this.items = [];
		try { this.current?.stop(); } catch {}
		this.current = null;
		if (this.playing) {
			this.playing = false;
			this.hooks.onStateChange(false);
		}
	}

	/** Drop everything, now. Used when the conversation ends. */
	stop(): void {
		this.stopped = true;
		this.clear();
		void this.context.close().catch(() => {});
	}

	/** The current sentence and the next one are always in flight; no more, so a long reply cannot flood the server. */
	private prefetch(): void {
		for (const item of this.items.slice(0, 2)) item.audio ??= this.fetch(item.text);
	}

	private async fetch(text: string): Promise<AudioBuffer> {
		const res = await apiFetch("/api/voice/tts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({} as { error?: string; code?: string }));
			throw Object.assign(new Error(String(body?.error ?? `Speech failed (${res.status}).`)), { code: String(body?.code ?? "tts") });
		}
		return this.context.decodeAudioData(await res.arrayBuffer());
	}

	private async pump(): Promise<void> {
		const generation = this.generation;
		this.playing = true;
		this.hooks.onStateChange(true);
		while (this.items.length > 0 && generation === this.generation) {
			const item = this.items[0];
			this.prefetch();
			let buffer: AudioBuffer;
			try {
				buffer = await item.audio!;
			} catch (error) {
				if (generation !== this.generation) return;
				this.hooks.onError({ code: String((error as { code?: string }).code ?? "tts"), message: (error as Error).message });
				return;
			}
			if (generation !== this.generation) return;
			this.items.shift();
			this.prefetch();
			await this.play(buffer);
		}
		if (generation === this.generation) {
			this.playing = false;
			this.hooks.onStateChange(false);
		}
	}

	private play(buffer: AudioBuffer): Promise<void> {
		return new Promise((resolve) => {
			if (this.context.state === "suspended") void this.context.resume().catch(() => {});
			const source = this.context.createBufferSource();
			source.buffer = buffer;
			source.connect(this.context.destination);
			this.current = source;
			source.onended = () => {
				if (this.current === source) this.current = null;
				resolve();
			};
			source.start();
		});
	}
}
