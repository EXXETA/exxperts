/**
 * Bridges the runtime's `ExtensionUIContext` to a single WebSocket connection so that
 * `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.input`, `ctx.ui.notify` from any
 * extension prompt the browser user.
 *
 * Wire protocol additions (server → client):
 *   { type: "ui_request", id, kind: "confirm"|"select"|"input"|"notify"|"status",
 *     title?, message?, options?, placeholder?, detail?, level? }
 *
 *   { type: "ui_request_closed", id, reason: "stopped" }
 *     (Stop answered the question for the person: the card stops asking)
 *
 * Wire protocol additions (client → server):
 *   { type: "ui_response", id, value }
 *
 * For `notify` / `setStatus` etc. (fire-and-forget), the server emits a
 * `ui_request` with no expectation of a response.
 *
 * The browser's job: render the request as an inline approval card; collect
 * the answer; send `ui_response` back with the same id.
 */

import type { ExtensionUIContext } from "@exxeta/exxperts-runtime";

type Sender = (msg: unknown) => void;

/** A dialog that was answered for the user because nobody was on the other end. */
export interface WebUiAutoDeclinedQuestion {
	kind: "confirm" | "select" | "input";
	title: string;
}

export interface WebUiContext extends ExtensionUIContext {
	/** Resolve a pending UI request when the client responds. */
	resolveResponse(id: string, value: any): void;
	/**
	 * Flip the bridge into headless mode: nobody is on the other end anymore
	 * (the client disconnected while a turn keeps running). Every pending
	 * dialog rejects with `message` and every future dialog rejects
	 * immediately, the same contract as the scheduled-background headless UI
	 * context — an unanswerable question must fail the asking tool, not hang
	 * the turn forever.
	 */
	detach(message: string): void;
	/**
	 * Somebody is on the other end again (a person came back while the turn
	 * keeps running): future dialogs reach the client as normal, and every
	 * dialog still waiting is asked again, so the newest watcher sees its card.
	 */
	attach(): void;
	/**
	 * The person pressed Stop: every open question is answered with
	 * `sentence` for the model, its card is told it closed, and a question
	 * asked while the stop is under way gets the same answer at once. Not an
	 * away decline, so nothing is noted for the landing. `reopen` ends it
	 * when the next turn starts.
	 */
	declineOpenQuestions(sentence: string): void;
	/**
	 * The person sent a message instead of answering: every question open now
	 * is answered with `sentence` and its card is told it was declined. Unlike
	 * Stop, a question asked after this is asked as usual.
	 */
	declineOpenQuestionsOnce(sentence: string): void;
	/** Whether a question waits for the person's answer now. */
	hasOpenQuestions(): boolean;
	reopen(): void;
}

// Extensions style status/notification text via `ctx.ui.theme` (a required
// member of ExtensionUIContext). The web transport is plain text, so every
// styling call passes the text through unchanged instead of emitting ANSI.
const passthroughTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
};

export function createWebUiContext(send: Sender, onAutoDecline?: (question: WebUiAutoDeclinedQuestion) => void): WebUiContext {
	const pending = new Map<string, { kind: WebUiAutoDeclinedQuestion["kind"]; title: string; payload: Record<string, unknown>; resolve: (v: any) => void; reject: (e: Error) => void }>();
	let detachedMessage: string | null = null;
	let stoppedMessage: string | null = null;
	let nextId = 1;
	const newId = () => `ui_${Date.now()}_${nextId++}`;
	// Every dialog the detached bridge answers for the user is reported once so
	// the turn's landing can say so in the transcript. Bookkeeping must never
	// change the rejection itself, so a throwing listener is swallowed.
	const noteAutoDecline = (kind: WebUiAutoDeclinedQuestion["kind"], title: string) => {
		if (!onAutoDecline) return;
		try { onAutoDecline({ kind, title }); } catch {}
	};

	const ask = <T>(payload: Record<string, unknown>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const kind = payload.kind as WebUiAutoDeclinedQuestion["kind"];
			const title = String(payload.title ?? "");
			if (detachedMessage !== null) {
				noteAutoDecline(kind, title);
				reject(new Error(detachedMessage));
				return;
			}
			if (stoppedMessage !== null) {
				reject(new Error(stoppedMessage));
				return;
			}
			const id = newId();
			pending.set(id, { kind, title, payload, resolve: resolve as any, reject });
			send({ type: "ui_request", id, ...payload });
		});

	const ctx = {
		// Dialogs (request/response)
		select(title: string, options: string[], opts?: any) {
			return ask<string | undefined>({
				kind: "select",
				title,
				options,
				detail: (opts as any)?.detail,
			});
		},
		confirm(title: string, message: string, opts?: any) {
			return ask<boolean>({
				kind: "confirm",
				title,
				message,
				detail: (opts as any)?.detail,
			});
		},
		input(title: string, placeholder: string, opts?: any) {
			return ask<string | undefined>({
				kind: "input",
				title,
				placeholder,
				detail: (opts as any)?.detail,
			});
		},

		// Fire-and-forget
		notify(message: string, type?: "info" | "warning" | "error") {
			send({ type: "ui_request", kind: "notify", message, level: type ?? "info" });
		},
		setStatus(key: string, text: string) {
			send({ type: "ui_request", kind: "status", key, text });
		},
		theme: passthroughTheme,
		setWorkingMessage() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		onTerminalInput() { return () => {}; },

		// Internal — called by the WS message handler
		resolveResponse(id: string, value: any) {
			const r = pending.get(id);
			if (!r) return;
			pending.delete(id);
			r.resolve(value);
		},

		declineOpenQuestions(sentence: string) {
			stoppedMessage = sentence;
			for (const [id, r] of pending) {
				pending.delete(id);
				send({ type: "ui_request_closed", id, reason: "stopped" });
				r.reject(new Error(sentence));
			}
		},
		declineOpenQuestionsOnce(sentence: string) {
			for (const [id, r] of pending) {
				pending.delete(id);
				send({ type: "ui_request_closed", id, reason: "declined" });
				r.reject(new Error(sentence));
			}
		},
		hasOpenQuestions() {
			return pending.size > 0;
		},
		reopen() {
			stoppedMessage = null;
		},

		// Internal — called by the WS close handler when a turn detaches.
		detach(message: string) {
			detachedMessage = message;
			for (const [id, r] of pending) {
				pending.delete(id);
				noteAutoDecline(r.kind, r.title);
				r.reject(new Error(message));
			}
		},

		// Internal: called when a returning connection takes the turn over.
		attach() {
			detachedMessage = null;
			for (const [id, r] of pending) send({ type: "ui_request", id, ...r.payload });
		},
	};

	return ctx as unknown as WebUiContext;
}
