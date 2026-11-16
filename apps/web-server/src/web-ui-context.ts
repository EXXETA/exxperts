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
 *   { type: "ui_request_closed", id, reason: "unanswered" }
 *     (its turn ended with nobody answering: the card reads as not answered)
 *
 *   { type: "ui_request_closed", id, reason: "chosen", lasts }
 *     (a folder card ended by the folder the person chose in the computer's window)
 *   { type: "ui_request_closed", id, reason: "answered", taken }
 *     (a site, connector, commands or folder card's answer was taken, and
 *     `taken` is what the server applied: "once", "room" or "decline" for a
 *     site or a connector, true or false for commands, false for a folder
 *     card's Not now)
 *
 *   { type: "ui_request_update", id, ...state }
 *     (a room's card stays open in a new state: a folder card's line, canChoose,
 *     choosing and the folder it shows (`suggested`); a site, connector or
 *     commands card's failure, when its yes couldn't be saved)
 *
 *   { type: "ui_request", id, ..., again: true }
 *     (a card sent again, as first sent: an answer too soon, or one that can't
 *     count, or a device that came back; the page notifies nobody for it)
 *
 * The run-outside and run questions get no closing frame for an answer: the
 * page folds them itself.
 *
 * Wire protocol additions (client → server):
 *   { type: "ui_response", id, value }
 *
 * Every answer to a site, connector, commands or folder card gets exactly one of these
 * frames back, with its id, and a yes waits for it on the page.
 *
 * For `notify` / `setStatus` etc. (fire-and-forget), the server emits a
 * `ui_request` with no expectation of a response.
 *
 * The browser's job: render the request as an inline approval card; collect
 * the answer; send `ui_response` back with the same id.
 */

import { randomUUID } from "node:crypto";

import type { ExtensionUIContext } from "@exxeta/exxperts-runtime";

import { ANSWER_FLOOR_MS, CHANGE_SAVE_FAILED, type CommandsAskLine, commandAsShown, COMMANDS_ASK_TITLE, type FolderAskAccess, folderAskTitle, type FolderLasts, FOLDER_PANEL_PRESSES, pageCardQuestion, reasonAsShown, ROOM_ASK_KINDS, siteCardQuestion, type SuggestedFolder } from "./room-box/card-text.js";
import type { HeldFolder } from "./room-box/folder-suggestion.js";
import { PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE } from "./room-approval-titles.js";

type Sender = (msg: unknown) => void;
type SiteChoice = "once" | "room" | "decline";
/**
 * A caller's own application of a yes on its site card, run by the bridge
 * before it says the card was answered: what it applied (a phone's or a shared
 * server's "room" lasts for this run, so "once"), or null when the caller's
 * turn had already ended. A throw leaves the card open with its failure line.
 */
export type SiteApply = (choice: "once" | "room", answeredBy: QuestionAuthority) => "once" | "room" | null;
/** The same for the commands card's yes: true once commands are on, or null when the turn had already ended. */
export type CommandsApply = () => true | null;
/** The same for a connector card's yes: "room" once that tool's yes is stored for the room, else "once". */
export type ConnectorApply = (choice: "once" | "room", answeredBy: QuestionAuthority) => "once" | "room";

/** A connector tool's question as the gate asks it (mcp/room-scope.ts), its words already made safe to show. */
export interface ConnectorCard {
	title: string;
	/** The connector's name as shown. */
	connector: string;
	/** What the room would send, as one line of JSON, cut at its end by `cut` characters. */
	sent: string;
	cut: number;
	/** Whether Allow for this room may be offered: the computer sees it, a phone never. */
	lasting: boolean;
}

/** A dialog that was answered for the user because nobody was on the other end. */
export interface WebUiAutoDeclinedQuestion {
	kind: "confirm" | "select" | "input" | "site" | "outside" | "run" | "folder" | "commands" | "connector";
	title: string;
	/** A connector question: whether it offered Allow for this room, so the note can name that way on. */
	lasting?: boolean;
}

/** How a folder card ended: a folder given for as long as the button said, one it already had, or Not now. */
export type FolderAnswer = { state: "picked"; folder: string; name: string; access: FolderAskAccess; lasts: FolderLasts } | { state: "already"; folder: string; name: string; access: FolderAskAccess } | { state: "declined" };

/** A press on the folder panel: Allow this time, Allow for this room, or Choose folder (Choose another folder too). */
export type FolderPress = "this-time" | "room" | "choose";

/**
 * What came of one press on a folder card: the card's answer; a line for the
 * card while it stays, the folder it shows kept; the card in a new state, with
 * the folder it now shows or none; or nothing (the window was cancelled).
 * `unsaved`: the give itself couldn't be written, so a caller tells a failed
 * save by this field, never by the line's words.
 */
export type ChooseOutcome = { done: FolderAnswer } | { line: string; canChoose: boolean; unsaved?: true } | { show: { line?: string; canChoose: boolean; held: HeldFolder | null } } | { unchanged: true };

/** How a question ends when the person answered it by sending a message: their no, unlike a Stop or a person who left. */
export class QuestionDeclined extends Error {}

/** Where an answer can come from. Worked out from the connection, never from what the page says. */
export type QuestionAuthority = "computer" | "phone";
export type QuestionWatcher = QuestionAuthority | "none";

export interface WebUiContext extends ExtensionUIContext {
	/** Resolve a pending UI request when the client responds; `answeredBy` is the answering connection's. */
	resolveResponse(id: string, value: any, answeredBy?: QuestionAuthority): void;
	/** Who can answer a card right now. */
	watcher(): QuestionWatcher;
	/**
	 * A site card, a kind of its own: the command waits on the answer, and the
	 * answer says who gave it. With an address, it is the web reader's card for
	 * that page. A yes is applied by `apply` before the card is told it was
	 * answered; the promise still resolves with the person's choice. Aborting
	 * `signal` closes this card alone, as not answered, and rejects: a yes after it applies nothing.
	 */
	askSite(card: { host: string; port: number; lasting: boolean; address?: string }, apply: SiteApply, signal?: AbortSignal): Promise<{ choice: SiteChoice; answeredBy: QuestionWatcher }>;
	/** A connector tool's question, a kind of its own, answered from any device: a yes is applied by `apply` before the card is told it was answered. */
	askConnector(card: ConnectorCard, apply: ConnectorApply): Promise<SiteChoice>;
	/** The outside card, a kind of its own, answered only from the computer. */
	askOutside(card: { command: string; reason: string }): Promise<boolean>;
	/** The command question in a room on Ask, a kind of its own: the command whole and the folder it runs in, answered from any device. */
	askRun(card: { command: string; folder: string | null }): Promise<boolean>;
	/**
	 * The room asks for a folder, showing `held` where the server holds one.
	 * Its presses aren't answers: each runs `act` with the folder held then and
	 * a signal that closes the window when the card ends, and the card stays
	 * until it gives an answer. A press the card doesn't offer counts for nothing.
	 */
	askFolder(card: { access: FolderAskAccess; reason: string; roomHasFolder: boolean; held: HeldFolder | null; act: (press: FolderPress, held: HeldFolder | null, signal: AbortSignal) => Promise<ChooseOutcome> }): Promise<FolderAnswer>;
	/** The room asks to turn on commands; true is the computer's yes, applied by `apply` before the card is told it was answered. */
	askCommands(card: { reason: string; line: CommandsAskLine; anyway: boolean }, apply: CommandsApply): Promise<boolean>;
	/**
	 * Flip the bridge into headless mode: nobody is on the other end anymore
	 * (the client disconnected while a turn keeps running). Every pending
	 * dialog rejects with `message` and every future dialog rejects
	 * immediately, the same contract as the scheduled-background headless UI
	 * context — an unanswerable question must fail the asking tool, not hang
	 * the turn forever. A room's own folder or commands ask stays open, so the
	 * person can answer it from the device the room moves to; Stop and a
	 * message still end it, an away limit doesn't.
	 */
	detach(message: string): void;
	/**
	 * Somebody is on the other end again (a person came back while the turn
	 * keeps running): future dialogs reach the client as normal, the last
	 * cards answered or chosen are told so again, in case that frame went with
	 * the connection, and every dialog still waiting is asked again, so the
	 * newest watcher sees its card.
	 */
	attach(authority?: QuestionAuthority): void;
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
	/** The turn ended: its open site cards close with `sentence`, and every other question stays. */
	closeSiteCards(sentence: string): void;
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

// How many of the running answer's last answered and chosen frames a returning device is sent again.
const KEPT_CLOSING_FRAMES = 8;
// Why a card closed by its caller's signal rejects: nobody waits for its answer any more.
const CARD_CLOSED = "nobody waits for this question's answer any more";
// What a room's card may change while it stays open, by its kind: the update frame carries all of it, so a field left out clears.
const CHANGEABLE: Readonly<Record<string, readonly string[]>> = { folder: ["line", "canChoose", "choosing", "suggested"], site: ["failure"], connector: ["failure"], commands: ["failure"] };

// A Map, so "toString" and every other prototype key is no press.
const FOLDER_PRESSES = new Map<string, FolderPress>([[FOLDER_PANEL_PRESSES.thisTime, "this-time"], [FOLDER_PANEL_PRESSES.room, "room"], [FOLDER_PANEL_PRESSES.choose, "choose"]]);
const folderPressOf = (value: unknown): FolderPress | undefined => (typeof value === "string" ? FOLDER_PRESSES.get(value) : undefined);

/** The folder a card shows, as the page draws it: its real name and path, never the room's words for it. */
const suggestedOf = (held: HeldFolder | null): SuggestedFolder | null => (held ? { name: held.name, path: held.shown, once: held.once } : null);

/** Whether the folder panel offers a press with this folder held: Allow this time only for one click, Allow for this room not beside Choose folder. */
function pressOffered(press: FolderPress, held: HeldFolder | null): boolean {
	if (press === "this-time") return held?.once === true;
	if (press === "room") return held === null || held.once;
	return true;
}

/** A yes, or a folder card's press: what the floor holds back when it comes too soon. A no is never held back. */
function floored(kind: string, value: unknown): boolean {
	if (kind === "site" || kind === "connector") return value === "once" || value === "room";
	if (kind === "commands" || kind === "run") return value === true;
	return kind === "folder" && folderPressOf(value) !== undefined;
}

export function createWebUiContext(send: Sender, onAutoDecline?: (question: WebUiAutoDeclinedQuestion) => void, connectedFrom: QuestionAuthority = "computer", clock: { now?: () => number } = {}): WebUiContext {
	type Pending = {
		kind: WebUiAutoDeclinedQuestion["kind"];
		title: string;
		payload: Record<string, unknown>;
		/** When a frame for this card last went out: the floor counts from it. */
		shownAt: number;
		resolve: (v: any, answeredBy: QuestionAuthority) => void;
		reject: (e: Error) => void;
		/** A room's card takes its own answers, and says whether it took this one; the other dialogs resolve with the value. */
		take?: (id: string, open: Pending, value: unknown, answeredBy: QuestionAuthority) => boolean;
		/** Run synchronously wherever the card ends, so nothing it started can land after. */
		end?: () => void;
	};
	// A clock that only moves forward: the time of day can jump, and the floor never leaves the server.
	const now = clock.now ?? (() => performance.now());
	const pending = new Map<string, Pending>();
	let detachedMessage: string | null = null;
	let watcher: QuestionAuthority = connectedFrom;
	let stoppedMessage: string | null = null;
	// When a room's card last took an answer or ended: a yes right after it is too soon, as it is right after a card shows.
	let lastAnswerAt = Number.NEGATIVE_INFINITY;
	const kept: Record<string, unknown>[] = [];
	// Random, so two connections asking at once never share an id, and an answer reaches only its own question.
	const newId = () => `ui_${randomUUID()}`;
	// Every dialog the detached bridge answers for the user is reported once so
	// the turn's landing can say so in the transcript. Bookkeeping must never
	// change the rejection itself, so a throwing listener is swallowed.
	const noteAutoDecline = (kind: WebUiAutoDeclinedQuestion["kind"], title: string, payload: Record<string, unknown>) => {
		if (!onAutoDecline) return;
		try { onAutoDecline({ kind, title, ...(kind === "connector" ? { lasting: payload.lasting === true } : {}) }); } catch {}
	};

	// A phone never gets the room's own reason, nor a folder card's line, the folder it shows or the press under way: each can name a folder or a step, and nobody can answer there.
	// Nor a site or connector card's room yes: a phone's yes is for this time only.
	const shownTo = (authority: QuestionAuthority, payload: Record<string, unknown>): Record<string, unknown> => {
		if (authority === "phone" && (payload.kind === "site" || payload.kind === "connector")) return { ...payload, lasting: false };
		if (authority !== "phone" || !ROOM_ASK_KINDS.has(String(payload.kind))) return payload;
		const { reason: _reason, ...rest } = payload;
		if (payload.kind !== "folder") return rest;
		const { line: _line, suggested: _suggested, choosing: _choosing, ...shown } = rest;
		return shown;
	};
	const drop = (id: string, open: Pending) => {
		pending.delete(id);
		// A room's card leaving, however it ends, changes what the next press lands on: the floor counts from it.
		if (open.take) lastAnswerAt = now();
		open.end?.();
	};
	/** Ends a card with its closing frame; an answered or chosen one is kept for a device that comes back. */
	const close = (id: string, open: Pending, closing: Record<string, unknown>) => {
		drop(id, open);
		const frame = { type: "ui_request_closed", id, ...closing };
		if (closing.reason === "answered" || closing.reason === "chosen") {
			kept.push(frame);
			if (kept.length > KEPT_CLOSING_FRAMES) kept.shift();
		}
		send(frame);
	};
	const sendRequest = (id: string, open: Pending, again: boolean) => {
		open.shownAt = now();
		send({ type: "ui_request", id, ...shownTo(watcher, open.payload), ...(again ? { again: true } : {}) });
	};
	/** The card again, as first sent: the answer counted for nothing, and the question stays open. */
	const askAgain = (id: string, open: Pending) => {
		// Nobody can answer while detached: attach sends the whole card again.
		if (detachedMessage === null) sendRequest(id, open, true);
	};
	/** The card stays open in a new state: the device that holds the turn gets all of what can change, filtered as the card was. */
	const showUpdate = (id: string, open: Pending, state: Record<string, unknown>) => {
		open.payload = { ...open.payload, ...state };
		open.shownAt = now();
		// While detached, `watcher` may still name the device before: attach sends the whole card again, filtered.
		if (detachedMessage !== null) return;
		const shown = shownTo(watcher, open.payload);
		send({ type: "ui_request_update", id, ...Object.fromEntries((CHANGEABLE[open.kind] ?? []).map((field) => [field, shown[field] ?? null])) });
	};
	/** Runs a caller's application of a yes: its result, or undefined when it threw and the card stays with its failure line. */
	const applied = <T>(id: string, open: Pending, apply: () => T): T | undefined => {
		try {
			return apply();
		} catch {
			showUpdate(id, open, { failure: CHANGE_SAVE_FAILED });
			return undefined;
		}
	};
	/**
	 * A site or connector card's take: a no closes it at once; a yes is applied
	 * by `apply` first, and the closing frame says what it applied. A throw
	 * leaves the card open with its failure line; null (the caller's turn
	 * ended first) closes it as not answered, with a no for the caller.
	 */
	const lastingYesTake = (apply: (choice: "once" | "room", answeredBy: QuestionAuthority) => "once" | "room" | null): Pending["take"] => (id, open, value, answeredBy) => {
		if (value !== "once" && value !== "room") {
			close(id, open, { reason: "answered", taken: "decline" });
			open.resolve("decline", answeredBy);
			return true;
		}
		const taken = applied(id, open, () => apply(value, answeredBy));
		if (taken === undefined) return false;
		if (taken === null) {
			close(id, open, { reason: "unanswered" });
			open.resolve("decline", answeredBy);
			return true;
		}
		close(id, open, { reason: "answered", taken });
		open.resolve(value, answeredBy);
		return true;
	};
	/** `own.closed`: aborting it closes this card alone, as not answered. */
	const ask = <T>(payload: Record<string, unknown>, answerOf: (value: any, answeredBy: QuestionAuthority) => T = (value) => value, own?: Pick<Pending, "take" | "end"> & { closed?: AbortSignal }): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const kind = payload.kind as WebUiAutoDeclinedQuestion["kind"];
			const title = String(payload.title ?? "");
			if (detachedMessage !== null) {
				noteAutoDecline(kind, title, payload);
				reject(new Error(detachedMessage));
				return;
			}
			if (stoppedMessage !== null) {
				reject(new Error(stoppedMessage));
				return;
			}
			const closed = own?.closed;
			if (closed?.aborted) {
				reject(new Error(CARD_CLOSED));
				return;
			}
			const id = newId();
			const closeThis = () => {
				if (pending.get(id) !== open) return;
				close(id, open, { reason: "unanswered" });
				reject(new Error(CARD_CLOSED));
			};
			const open: Pending = { kind, title, payload, shownAt: now(), resolve: (value, answeredBy) => resolve(answerOf(value, answeredBy)), reject, take: own?.take, end: () => {
				closed?.removeEventListener("abort", closeThis);
				own?.end?.();
			} };
			pending.set(id, open);
			closed?.addEventListener("abort", closeThis, { once: true });
			sendRequest(id, open, false);
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

		askSite({ host, port, lasting, address }: { host: string; port: number; lasting: boolean; address?: string }, apply: SiteApply, signal?: AbortSignal) {
			// The host as shown, with any hidden character spelled out, as the reason and the address are.
			const shownHost = commandAsShown(host);
			const page = address === undefined ? {} : { title: pageCardQuestion(shownHost), address: commandAsShown(address) };
			return ask<{ choice: SiteChoice; answeredBy: QuestionWatcher }>({ kind: "site", title: siteCardQuestion(shownHost), host: shownHost, port, lasting, ...page }, (value, answeredBy) => ({
				choice: value === "once" || value === "room" ? value : "decline",
				answeredBy,
			}), { take: lastingYesTake(apply), closed: signal });
		},
		askConnector({ title, connector, sent, cut, lasting }: ConnectorCard, apply: ConnectorApply) {
			return ask<SiteChoice>({ kind: "connector", title, connector, sent, cut, lasting }, (value) => (value === "once" || value === "room" ? value : "decline"), { take: lastingYesTake(apply) });
		},
		askOutside({ command, reason }: { command: string; reason: string }) {
			return ask<boolean>({ kind: "outside", title: "Run outside this room?", command: commandAsShown(command), reason: commandAsShown(reason) }, (value, answeredBy) => value === true && answeredBy === "computer");
		},
		askRun({ command, folder }: { command: string; folder: string | null }) {
			// A take of its own, so a yes meets the floor; no closing frame, since the page folds the card itself.
			return ask<boolean>({ kind: "run", title: PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE, command: commandAsShown(command), folder: folder === null ? null : commandAsShown(folder) }, (value) => value === true, {
				take: (id, open, value, answeredBy) => {
					drop(id, open);
					open.resolve(value, answeredBy);
					return true;
				},
			});
		},
		askFolder({ access, reason, roomHasFolder, held: first, act }: Parameters<WebUiContext["askFolder"]>[0]) {
			// Aborted the moment the card ends, wherever it ends: the window closes, and a pick still being looked at gives nothing.
			const closeWindow = new AbortController();
			// The folder the card shows, held here only: a press names none, and a device that comes back gets it unjudged.
			let held = first;
			const shownFolder = suggestedOf(held);
			return ask<FolderAnswer>({ kind: "folder", title: folderAskTitle(roomHasFolder), access, reason: reasonAsShown(reason), roomHasFolder, canChoose: true, choosing: null, ...(shownFolder ? { suggested: shownFolder } : {}) }, (value) => (value === false ? { state: "declined" } : value as FolderAnswer), {
				end: () => closeWindow.abort(),
				take: (id, open, value) => {
					if (value === false) {
						close(id, open, { reason: "answered", taken: false });
						open.resolve(false, "computer");
						return true;
					}
					// A value the card doesn't offer now, a page loaded before the panel's among them, counts for nothing.
					const press = folderPressOf(value);
					if (press === undefined || !pressOffered(press, held)) {
						askAgain(id, open);
						return false;
					}
					// One press at a time: one while a window is open or a folder is being looked at is asked again, so its buttons stay off.
					if (open.payload.choosing) {
						askAgain(id, open);
						return false;
					}
					// Not sent: the pressing device waits for this press's reply, and one that joins gets it in the card.
					open.payload = { ...open.payload, choosing: value };
					// Started from a promise, so a throw before the window opens is a reply too, never a card left choosing.
					void Promise.resolve().then(() => act(press, held, closeWindow.signal)).catch((): ChooseOutcome => ({ unchanged: true })).then((outcome: ChooseOutcome) => {
						// A pick after the card ended lands nothing: `act` checks the signal before it gives.
						if (pending.get(id) !== open) return;
						if ("done" in outcome) {
							// The same run as the give: no answer can come between them.
							const lasts: FolderLasts = outcome.done.state === "picked" ? outcome.done.lasts : press === "this-time" ? "answer" : "room";
							close(id, open, { reason: "chosen", lasts });
							open.resolve(outcome.done, "computer");
						} else if ("show" in outcome) {
							held = outcome.show.held;
							showUpdate(id, open, { line: outcome.show.line ?? null, canChoose: outcome.show.canChoose, choosing: null, suggested: suggestedOf(held) });
						} else {
							showUpdate(id, open, "line" in outcome ? { line: outcome.line, canChoose: outcome.canChoose, choosing: null } : { choosing: null });
						}
					});
					return true;
				},
			});
		},
		askCommands({ reason, line, anyway }: Parameters<WebUiContext["askCommands"]>[0], apply: CommandsApply) {
			return ask<boolean>({ kind: "commands", title: COMMANDS_ASK_TITLE, reason: reasonAsShown(reason), line, anyway }, (value, answeredBy) => value === true && answeredBy === "computer", {
				take: (id, open, value, answeredBy) => {
					if (value !== true) {
						close(id, open, { reason: "answered", taken: false });
						open.resolve(false, answeredBy);
						return true;
					}
					const taken = applied(id, open, apply);
					if (taken === undefined) return false;
					if (taken === null) {
						close(id, open, { reason: "unanswered" });
						open.resolve(false, answeredBy);
						return true;
					}
					close(id, open, { reason: "answered", taken });
					open.resolve(true, answeredBy);
					return true;
				},
			});
		},
		watcher() {
			return detachedMessage !== null ? "none" : watcher;
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
		resolveResponse(id: string, value: any, answeredBy: QuestionAuthority = watcher) {
			const r = pending.get(id);
			if (!r) return;
			if (!r.take) {
				pending.delete(id);
				r.resolve(value, answeredBy);
				return;
			}
			// These cards have no buttons on a phone: its answer counts for nothing, and the card is asked again.
			if (ROOM_ASK_KINDS.has(r.kind) && answeredBy !== "computer") {
				askAgain(id, r);
				return;
			}
			// Too soon after the card was sent, or after the last answer: a press meant for something else.
			if (floored(r.kind, value) && now() - Math.max(r.shownAt, lastAnswerAt) < ANSWER_FLOOR_MS) {
				askAgain(id, r);
				return;
			}
			if (r.take(id, r, value, answeredBy)) lastAnswerAt = now();
		},

		declineOpenQuestions(sentence: string) {
			stoppedMessage = sentence;
			for (const [id, r] of pending) {
				drop(id, r);
				send({ type: "ui_request_closed", id, reason: "stopped" });
				r.reject(new Error(sentence));
			}
		},
		declineOpenQuestionsOnce(sentence: string) {
			for (const [id, r] of pending) {
				drop(id, r);
				send({ type: "ui_request_closed", id, reason: "declined" });
				r.reject(new QuestionDeclined(sentence));
			}
		},
		closeSiteCards(sentence: string) {
			for (const [id, r] of pending) {
				if (r.payload.kind !== "site") continue;
				drop(id, r);
				send({ type: "ui_request_closed", id, reason: "unanswered" });
				r.reject(new Error(sentence));
			}
		},
		hasOpenQuestions() {
			return pending.size > 0;
		},
		reopen() {
			stoppedMessage = null;
			// A new answer: the last one's closing frames are nobody's to catch up on, since only a running turn is taken over.
			kept.length = 0;
		},

		// Internal — called by the WS close handler when a turn detaches.
		detach(message: string) {
			detachedMessage = message;
			for (const [id, r] of pending) {
				if (ROOM_ASK_KINDS.has(r.kind)) continue;
				drop(id, r);
				noteAutoDecline(r.kind, r.title, r.payload);
				r.reject(new Error(message));
			}
		},

		// Internal: called when a returning connection takes the turn over.
		attach(authority: QuestionAuthority = watcher) {
			detachedMessage = null;
			watcher = authority;
			// Before the open cards: a yes taken while the connection went reads as taken, never as still open.
			for (const frame of kept) send(frame);
			// Sent before, so nobody is notified again.
			for (const [id, r] of pending) sendRequest(id, r, true);
		},
	};

	return ctx as unknown as WebUiContext;
}
