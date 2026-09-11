import { fetchJson } from "../api";
import { FillerPlanner, guessLanguage, type SpokenLanguage, type ToolCall } from "./filler";
import { openMicrophone, type Microphone } from "./microphone";
import { SpeechQueue } from "./speech-queue";
import { SentenceSplitter } from "./spoken-text";

/**
 * Conversation mode, push-to-talk: hold the talk key and speak, release it
 * and what you said is sent; the answer is spoken as it streams in; press the
 * key while the room answers and it falls silent and listens.
 *
 * The controller sits between the talk key, the microphone, the room's normal
 * send path and the speech queue. A hold is sent exactly as if typed, so it
 * lands in the room as your message; the answer streams into the room as
 * always and is spoken sentence by sentence as it arrives. Nothing is decided
 * from silence: a pause to think is just a pause, and a hold released and
 * pressed again before its words came back continues the same message.
 *
 * The app's own lines (an "Okay", a "searching the web for …") go through the
 * same queue but never through the room: they are audio and nothing else.
 */

export type ConversationStatus = "starting" | "idle" | "listening" | "working" | "speaking";
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
/** A hold released while the room was still stopping is retried this often, for up to fifteen seconds: a long answer takes a few seconds to stop. */
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
	/** The talk key is down. */
	private held = false;
	/** Words from a hold whose final arrived while the key was already down again; they lead the next message. */
	private carry = "";
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
				onReady: () => this.set({ status: this.held ? "listening" : "idle", partial: "" }),
				onPartial: (text) => { if (this.state.status === "listening") this.set({ partial: text }); },
				onFinal: (text) => this.onFinal(text),
				onError: (failure) => this.fail(failure),
			});
			if (this.ended) { microphone.close(); return; }
			this.microphone = microphone;
			// A hold that began while the microphone was opening starts now;
			// the frames wait in the microphone until the server is ready.
			if (this.held) microphone.setTransmitting(true);
		} catch (error) {
			this.fail({ code: String((error as { code?: string }).code ?? "voice"), message: (error as Error).message });
		}
	}

	/** End on purpose: microphone off, speech stopped, the room's text untouched. */
	end(): void {
		this.finish(null);
	}

	/** The talk key went down: the room falls silent if it was answering, and the microphone opens. */
	pressTalk(): void {
		if (this.ended || this.held) return;
		this.held = true;
		if (this.turnOpen) this.interrupt();
		this.microphone?.setTransmitting(true);
		if (this.state.status !== "starting") this.set({ status: "listening", partial: "", detail: null });
	}

	/** The talk key came up: what was said comes back as one final and is sent. */
	releaseTalk(): void {
		if (this.ended || !this.held) return;
		this.held = false;
		if (!this.microphone) return;
		this.microphone.setTransmitting(false);
		this.microphone.flush();
	}

	/**
	 * Escape: the room falls silent, the same as pressing the talk key while
	 * it answers, but without listening. Returns false when there was nothing
	 * to hush, which the caller takes as "leave the conversation".
	 */
	hush(): boolean {
		if (this.ended || !this.turnOpen) return false;
		this.interrupt();
		this.set({ status: "idle", partial: "", detail: null });
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
		if (this.queue.idle) this.finishTurn();
	}

	// ── Internals ───────────────────────────────────────────────────────────

	/** A final only ever follows a release; it is what the hold said. */
	private onFinal(text: string): void {
		if (this.ended) return;
		const spoken = text.trim();
		if (this.held) {
			// Pressed again before these words came back: they lead the next message.
			this.carry = [this.carry, spoken].filter(Boolean).join(" ");
			return;
		}
		if (this.state.status !== "listening") return;
		const message = [this.carry, spoken].filter(Boolean).join(" ");
		this.carry = "";
		if (!message) {
			this.set({ status: "idle", partial: "" });
			return;
		}
		this.turnLanguage = this.language === "auto" ? guessLanguage(message, this.turnLanguage) : this.language;
		this.sendWithRetry(message, 0);
	}

	/** The room falls silent and its turn stops if the model is still working. */
	private interrupt(): void {
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
	}

	/** A hold released just as the room was being stopped may need a moment before the room takes it. */
	private sendWithRetry(text: string, attempt: number): void {
		this.pendingSend = null;
		if (this.ended || this.state.status !== "listening") return;
		if (this.hooks.send(text)) {
			this.beginTurn();
			return;
		}
		if (attempt >= SEND_RETRIES) {
			// ponytail: fifteen seconds of patience, then the room is busy with
			// something that is not this conversation; the words wait for the
			// next hold rather than vanish.
			this.carry = text;
			this.set({ status: "idle", partial: "" });
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
		else if (this.turnEnded) this.finishTurn();
		else if (this.turnOpen) this.set({ status: "working" });
	}

	private finishTurn(): void {
		this.turnOpen = false;
		this.turnEnded = false;
		this.set({ status: this.held ? "listening" : "idle", partial: "", detail: null });
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
