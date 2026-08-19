/**
 * Bulk edits for the gateway model approval list.
 *
 * A company gateway can route fifty or more models, and setting four fields on
 * each of them by hand is not editing, it is data entry. These are the pure
 * halves of the header controls: they take the drafts the list is already
 * holding and hand back the next set, so the list stays the only owner of its
 * state and nothing here can reach the server.
 *
 * A draft carries capabilities in two halves. The optional fields are the
 * person's overrides, present only when they chose; `detected` is what the
 * gateway last declared, nullable per field because a gateway answering about
 * images says nothing about reasoning, and a null is "not answered", never
 * "no". What a row effectively is comes from draftEffective: override over
 * detection over default, mirroring the server's one resolution function.
 */

/**
 * What a gateway declared about one model. Every field is nullable because a
 * gateway answering about images says nothing about reasoning, and a null is
 * "not answered", never "no".
 */
export type BulkDetection = {
	vision: boolean | null;
	webSearch: boolean | null;
	reasoning: boolean | null;
	contextWindow: number | null;
	/** The per-request output cap the gateway declared, or null where it said nothing. */
	maxTokens?: number | null;
	/**
	 * The gateway's declared mode. A known non-chat value (embedding,
	 * image_generation, ...) is a model no room turn can run on.
	 */
	mode?: string | null;
	/**
	 * Per-level effort declarations, when the gateway spoke them: which rungs of
	 * the thinking dial exist for this model. Pure detection with no override
	 * half, so the bulk controls never touch it; it informs the detected note
	 * and, server-side, the ladder the model is registered with.
	 */
	thinkingLevels?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", boolean>> | null;
	/** The hardest thinking the deployment lets through; caps the declared levels. */
	effortCeiling?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
	/** Whether the gateway says the model picks its own effort. */
	adaptiveThinking?: boolean | null;
};

/** The parts of a model draft the bulk controls touch. */
export type BulkDraftFields = {
	approved: boolean;
	/** The web search tick. Effective as it stands; detection never sets it by itself. */
	webSearch: boolean;
	/** Override: present only when the person set it. */
	vision?: boolean;
	/** Override: present only when the person set it. */
	reasoning?: boolean;
	/** Override: the window as typed. Present only when the person set it. */
	contextWindow?: string;
	/** What the gateway last declared about this model; null before any reload answered. */
	detected: BulkDetection | null;
};

/** What one row effectively is, for the badges and the field editors. */
export type EffectiveDraft = {
	vision: boolean;
	reasoning: boolean;
	/** As text, because that is what the window field holds and validates. */
	contextWindow: string;
};

/** Override over detection over default, per field, exactly as the server resolves it. */
export function draftEffective(draft: BulkDraftFields, defaultContextWindow: number): EffectiveDraft {
	return {
		vision: draft.vision ?? draft.detected?.vision ?? false,
		reasoning: draft.reasoning ?? draft.detected?.reasoning ?? false,
		contextWindow: draft.contextWindow ?? String(draft.detected?.contextWindow ?? defaultContextWindow),
	};
}

/** Whether the gateway answered anything at all about this model. */
export function detectionAnswers(detection: BulkDetection | null | undefined): boolean {
	return detection != null && (detection.vision != null || detection.webSearch != null || detection.reasoning != null || detection.contextWindow != null || detection.maxTokens != null);
}

/**
 * LiteLLM modes that name a model no chat turn can run on. Mirrors the
 * server's list; only a KNOWN non-chat declaration counts, absent and unknown
 * modes read as chat-compatible.
 */
const NON_CHAT_MODES = ["embedding", "image_generation", "audio_transcription", "audio_speech", "rerank", "moderation"];

export function isNonChatMode(mode: string | null | undefined): boolean {
	return typeof mode === "string" && NON_CHAT_MODES.includes(mode);
}

/** Approve every model, or none of them. */
export function setAllApproved<T extends { approved: boolean }>(drafts: T[], approved: boolean): T[] {
	return drafts.map((draft) => (draft.approved === approved ? draft : { ...draft, approved }));
}

/**
 * Apply one choice to the approved models only. An unapproved model is not
 * being saved, so quietly rewriting its fields would only mean a surprise the
 * next time somebody ticks it. Whatever this writes is an override: the person
 * pressing a bulk control is speaking for every approved row at once.
 *
 * With one restraint: turning images or reasoning ON skips a model whose
 * gateway declaration is an explicit false for that field. A list-wide switch
 * is a blunt instrument, and it must not force a capability onto a model the
 * gateway explicitly denied; the per-row adjust fold stays the deliberate way
 * to overrule a declaration. Only a declared false is skipped, because a null
 * is "not answered", never "no". Turning either OFF reaches every approved
 * row, since switching a capability off is always safe. Web search is exempt
 * both ways: it is a spend choice rather than a capability claim, and gateway
 * declarations for it have proven unreliable.
 */
export function applyToApproved<T extends BulkDraftFields>(drafts: T[], patch: Partial<BulkDraftFields>): T[] {
	return drafts.map((draft) => {
		if (!draft.approved) return draft;
		const next = { ...patch };
		if (next.vision === true && draft.detected?.vision === false) delete next.vision;
		if (next.reasoning === true && draft.detected?.reasoning === false) delete next.reasoning;
		if (Object.keys(next).length === 0) return draft;
		return { ...draft, ...next };
	});
}

/**
 * Take the gateway at its word: clear the overrides on every field the gateway
 * answered, so those fields follow detection again, and set the web search
 * tick to what it declared. Web search is adopted rather than merely unpinned
 * because the tick is always an explicit value, and the person pressing this
 * is explicitly asking for the gateway's answer; it is only the silent
 * pre-tick that is banned. Fields the gateway did not answer keep whatever
 * choice they hold, because clearing those would land them on the default, not
 * on a detection. This reaches every row, approved or not: an unapproved row
 * is the one most likely to be wrong.
 */
export function trustDetected<T extends BulkDraftFields>(drafts: T[]): T[] {
	return drafts.map((draft) => {
		const detection = draft.detected;
		if (!detectionAnswers(detection)) return draft;
		let changed = false;
		const next = { ...draft };
		if (detection!.vision != null && next.vision !== undefined) {
			delete next.vision;
			changed = true;
		}
		if (detection!.reasoning != null && next.reasoning !== undefined) {
			delete next.reasoning;
			changed = true;
		}
		if (detection!.contextWindow != null && next.contextWindow !== undefined) {
			delete next.contextWindow;
			changed = true;
		}
		if (detection!.webSearch != null && next.webSearch !== detection!.webSearch) {
			next.webSearch = detection!.webSearch;
			changed = true;
		}
		return changed ? next : draft;
	});
}

/** How many of the models on screen are approved. */
export function approvedCount(drafts: Array<{ approved: boolean }>): number {
	return drafts.reduce((count, draft) => count + (draft.approved ? 1 : 0), 0);
}
