import { fetchJson } from "../api";
import { FillerPlanner, guessLanguage, type SpokenLanguage, type ToolCall } from "./filler";
import { openMicrophone, type Microphone } from "./microphone";
import { SpeechQueue } from "./speech-queue";
import { isEcho, looksLikeSpeech, SentenceSplitter } from "./spoken-text";

/**
 * Conversation mode: listen, send, speak, listen again.
 *
 * The controller sits between the microphone, the room's normal send path and
 * the speech queue. A sentence you finish is sent exactly as if typed, so it
 * lands in the room as your message; the answer streams into the room as
 * always and is spoken sentence by sentence as it arrives. The microphone
 * stays open throughout: talk over the room and it falls silent, the turn is
 * stopped, and what you said becomes the next message. Echo cancellation
 * keeps the room's own voice out of the microphone; a word guard catches the
 * rest, so a stray syllable or a leaked sentence never interrupts anything.
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
/** A sentence finished while the room was still stopping is retried this often, for up to fifteen seconds: a long answer takes a few seconds to stop. */
const SEND_RETRY_MS = 300;
const SEND_RETRIES = 50;

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
	private pendingSend: number | null = null;
	private ended = false;

	constructor(private readonly hooks: {
		/** The room's send path; false when the room cannot take a message right now. */
		send(text: string): boolean;
		/** Stop the room's current turn, as the Stop button would. */
		interrupt(): void;
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
				onPartial: (text) => this.onPartial(text),
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

	/**
	 * Escape: the room falls silent and listens, the same as talking over it.
	 * Returns false when there was nothing to hush, which the caller takes as
	 * "leave the conversation": one Escape stops the answer, the next one ends.
	 */
	hush(): boolean {
		if (this.ended || !this.turnOpen) return false;
		this.interrupt("");
		return true;
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

	private onPartial(text: string): void {
		if (this.ended) return;
		if (this.turnOpen) {
			// Talking over the room: the first partial that is clearly a person
			// speaking, and not the room's own words leaking back, interrupts.
			if (this.userIsTalking(text)) this.interrupt(text);
			return;
		}
		if (this.state.status === "listening") this.set({ partial: text });
	}

	private onFinal(text: string): void {
		const spoken = text.trim();
		if (!spoken || this.ended) return;
		if (this.turnOpen) {
			if (!this.userIsTalking(spoken)) return;
			this.interrupt(spoken);
		}
		if (this.state.status !== "listening") return;
		this.turnLanguage = this.language === "auto" ? guessLanguage(spoken, this.turnLanguage) : this.language;
		this.sendWithRetry(spoken, 0);
	}

	private userIsTalking(text: string): boolean {
		return looksLikeSpeech(text) && !isEcho(text, this.queue.recentlySpoken);
	}

	/** The room falls silent, its turn stops if it is still running, and the words already heard stay on the bar. */
	private interrupt(partial: string): void {
		// Stop the model only while it is still working. Once it has finished
		// and the room is merely reading the rest aloud, there is nothing to
		// abort, and asking anyway would leave the room waiting for a turn end
		// that never comes.
		const modelStillWorking = !this.turnEnded;
		this.turnOpen = false;
		this.turnEnded = false;
		this.clearSilence();
		this.queue.clear();
		if (modelStillWorking) this.hooks.interrupt();
		this.set({ status: "listening", partial, detail: null });
	}

	/** A sentence finished just as the room was being stopped may need a moment before the room takes it. */
	private sendWithRetry(text: string, attempt: number): void {
		this.pendingSend = null;
		if (this.ended || this.state.status !== "listening") return;
		if (this.hooks.send(text)) {
			this.beginTurn();
			return;
		}
		if (attempt >= SEND_RETRIES) {
			// ponytail: fifteen seconds of patience, then the room is busy with
			// something that is not this conversation; keep listening.
			this.set({ partial: "" });
			return;
		}
		this.pendingSend = window.setTimeout(() => this.sendWithRetry(text, attempt + 1), SEND_RETRY_MS);
	}

	private beginTurn(): void {
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
		if (this.pendingSend !== null) window.clearTimeout(this.pendingSend);
		this.pendingSend = null;
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
