/**
 * Bridges the runtime's `ExtensionUIContext` to a single WebSocket connection so that
 * `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.input`, `ctx.ui.notify` from any
 * extension prompt the browser user.
 *
 * Wire protocol additions (server → client):
 *   { type: "ui_request", id, kind: "confirm"|"select"|"input"|"notify"|"status",
 *     title?, message?, options?, placeholder?, detail?, level? }
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
	const pending = new Map<string, { kind: WebUiAutoDeclinedQuestion["kind"]; title: string; resolve: (v: any) => void; reject: (e: Error) => void }>();
	let detachedMessage: string | null = null;
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
			const id = newId();
			pending.set(id, { kind, title, resolve: resolve as any, reject });
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

		// Internal — called by the WS close handler when a turn detaches.
		detach(message: string) {
			detachedMessage = message;
			for (const [id, r] of pending) {
				pending.delete(id);
				noteAutoDecline(r.kind, r.title);
				r.reject(new Error(message));
			}
		},
	};

	return ctx as unknown as WebUiContext;
}
