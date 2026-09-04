import { fetchJson } from "../api";
import { FillerPlanner, guessLanguage, type SpokenLanguage, type ToolCall } from "./filler";
import { openMicrophone, type Microphone } from "./microphone";
import { SpeechQueue } from "./speech-queue";
import { SentenceSplitter } from "./spoken-text";

/**
 * Conversation mode: listen, send, speak, listen again.
 *
 * The controller sits between the microphone, the room's normal send path and
 * the speech queue. A sentence you finish is sent exactly as if typed, so it
 * lands in the room as your message; the answer streams into the room as
 * always and is spoken sentence by sentence as it arrives. The microphone is
 * closed while the room speaks, so it does not hear itself, and reopens when
 * the last sentence has played.
 *
 * The app's own lines (an "Okay", a "searching the web for …") go through the
 * same queue but never through the room: they are audio and nothing else.
 */

export type ConversationStatus = "starting" | "listening" | "working" | "speaking";
export type ConversationState = { status: ConversationStatus; partial: string; detail: string | null };
export type ConversationFailure = { code: string; message: string };
type VoiceLanguage = "auto" | SpokenLanguage;

type VoicePayload = {
	settings: { language: VoiceLanguage };
	engine: { available: boolean; message: string | null };
	models: Array<{ name: string; installed: boolean }>;
};

/** How long the model may stay silent after a send before the app says a word. */
const SILENCE_MS = 1500;

export class Conversation {
	private state: ConversationState = { status: "starting", partial: "", detail: null };
	private readonly queue: SpeechQueue;
	private readonly splitter = new SentenceSplitter();
	private readonly planner = new FillerPlanner();
	private microphone: Microphone | null = null;
	private language: VoiceLanguage = "auto";
	private turnLanguage: SpokenLanguage = "en";
	private turnOpen = false;
	private turnEnded = false;
	private silenceTimer: number | null = null;
	private ended = false;

	constructor(private readonly hooks: {
		/** The room's send path; false when the room cannot take a message right now. */
		send(text: string): boolean;
		onState(state: ConversationState): void;
		onEnd(failure: ConversationFailure | null): void;
	}) {
		this.queue = new SpeechQueue({
			onStateChange: (speaking) => this.onQueueState(speaking),
			onError: (failure) => this.fail(failure),
		});
	}

	async start(): Promise<void> {
		this.set({ status: "starting", partial: "", detail: null });
		try {
			const payload = await fetchJson<VoicePayload>("/api/voice/settings");
			if (!payload.engine.available) {
				this.fail({ code: "voice_unavailable", message: payload.engine.message ?? "Voice is unavailable on this system." });
				return;
			}
			const missing = payload.models.filter((model) => !model.installed).map((model) => model.name);
			if (missing.length > 0) {
				this.fail({ code: "model_missing", message: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not downloaded yet.` });
				return;
			}
			this.language = payload.settings.language;
			this.turnLanguage = this.language === "auto" ? (navigator.language.toLowerCase().startsWith("de") ? "de" : "en") : this.language;
			const microphone = await openMicrophone({
				language: this.language,
				onReady: () => this.set({ status: "listening", partial: "" }),
				onPartial: (text) => { if (this.state.status === "listening") this.set({ partial: text }); },
				onFinal: (text) => this.onFinal(text),
				onError: (failure) => this.fail(failure),
			});
			if (this.ended) { microphone.close(); return; }
			this.microphone = microphone;
		} catch (error) {
			this.fail({ code: String((error as { code?: string }).code ?? "voice"), message: (error as Error).message });
		}
	}

	/** End on purpose: microphone off, speech stopped, the room's text untouched. */
	end(): void {
		this.finish(null);
	}

	// ── Fed by the room's websocket handler ─────────────────────────────────

	onTurnText(delta: string): void {
		if (!this.turnOpen || this.ended) return;
		this.clearSilence();
		this.planner.onModelText();
		for (const sentence of this.splitter.push(delta)) this.queue.say(sentence);
	}

	onTurnTextEnd(): void {
		if (!this.turnOpen || this.ended) return;
		const rest = this.splitter.flush();
		if (rest) this.queue.say(rest);
	}

	onTurnTools(calls: ToolCall[]): void {
		if (!this.turnOpen || this.ended) return;
		this.clearSilence();
		const plan = this.planner.planForTools(calls, this.turnLanguage);
		if (plan.speak) this.queue.say(plan.speak);
		if (plan.label && this.state.status === "working") this.set({ detail: plan.label });
	}

	onTurnEnd(): void {
		if (!this.turnOpen || this.ended) return;
		this.clearSilence();
		const rest = this.splitter.flush();
		if (rest) this.queue.say(rest);
		this.turnEnded = true;
		if (this.queue.idle) this.resumeListening();
	}

	// ── Internals ───────────────────────────────────────────────────────────

	private onFinal(text: string): void {
		const spoken = text.trim();
		if (!spoken || this.ended || this.state.status !== "listening") return;
		this.turnLanguage = this.language === "auto" ? guessLanguage(spoken, this.turnLanguage) : this.language;
		if (!this.hooks.send(spoken)) {
			// The room is busy with something else; keep listening.
			this.set({ partial: "" });
			return;
		}
		this.microphone?.mute(true);
		this.turnOpen = true;
		this.turnEnded = false;
		this.splitter.reset();
		this.planner.startTurn();
		this.set({ status: "working", partial: "", detail: null });
		this.silenceTimer = window.setTimeout(() => {
			this.silenceTimer = null;
			if (this.turnOpen && this.planner.quiet) this.queue.say(this.planner.acknowledgement(this.turnLanguage));
		}, SILENCE_MS);
	}

	private onQueueState(speaking: boolean): void {
		if (this.ended) return;
		if (speaking) this.set({ status: "speaking" });
		else if (this.turnEnded) this.resumeListening();
		else if (this.turnOpen) this.set({ status: "working" });
	}

	private resumeListening(): void {
		this.turnOpen = false;
		this.turnEnded = false;
		this.microphone?.mute(false);
		this.set({ status: "listening", partial: "", detail: null });
	}

	private clearSilence(): void {
		if (this.silenceTimer !== null) window.clearTimeout(this.silenceTimer);
		this.silenceTimer = null;
	}

	private fail(failure: ConversationFailure): void {
		this.finish(failure);
	}

	private finish(failure: ConversationFailure | null): void {
		if (this.ended) return;
		this.ended = true;
		this.clearSilence();
		this.queue.stop();
		this.microphone?.close();
		this.microphone = null;
		this.hooks.onEnd(failure);
	}

	private set(patch: Partial<ConversationState>): void {
		this.state = { ...this.state, ...patch };
		this.hooks.onState(this.state);
	}
}
