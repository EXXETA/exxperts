import { createContext, useContext, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CARD_DECLINE, COMMANDS_ASK_LINES, NOT_NOW, SITE_ALLOW_ONCE, SITE_ALLOW_ROOM, TURN_ON_ANYWAY, TURN_ON_COMMANDS, COMMANDS_OFF_LINE, COMMANDS_ON_LINE, folderAlreadyLine, folderPickedLine, folderPickedThisTimeLine, folderRemovedLine, FOLDER_PANEL_PRESSES, type FolderPanelPress, REMOVE, TURN_OFF, UNDO } from "../../../web-server/src/room-box/card-text";
import { useRemoteClientContext } from "../remote-client-context";
import type { RoomAskGiven } from "../work-look";
import type { ChatItem } from "../types";
import { composerTextarea } from "./Approval";

type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;
type Resolve = (requestId: string, value: any, label: string) => void;

/** Answers the card and hands the focus back: the card folds to a line, and focus must not die on the page. */
export function answerer(ask: ApprovalItem, onResolve: Resolve) {
	return (value: unknown, label: string): void => {
		onResolve(ask.requestId, value, label);
		composerTextarea()?.focus();
	};
}

/** Enter on this button does nothing, so a yes takes a click; Space stays for people who work by keyboard. */
export function refuseEnter(event: ReactKeyboardEvent<HTMLButtonElement>): void {
	if (event.key === "Enter") event.preventDefault();
}

/**
 * What the room's asks send, given once by the page that holds the room's
 * connection. `press`: a yes on a site or commands card, or an Allow button on
 * a folder card, which opens the computer's window for as long as the button
 * says: sent once, and the card waits for the server's reply, which says what
 * was taken. `pressed`: the value of that card's press while it still waits, else undefined. `action`: a way
 * back on the line after a yes, true once the server has done it.
 */
export interface RoomAsks {
	press: (requestId: string, value: unknown) => void;
	pressed: (requestId: string) => unknown;
	action: (frame: { type: "room_folder_remove" | "room_folder_restore"; path: string } | { type: "room_commands_off" }) => Promise<boolean>;
	/** Keeps on the step whether its yes was taken back, so the saved conversation says so. */
	takenBack: (stepId: string, takenBack: boolean) => void;
	/** Whether this connection removed the folder, so its Undo can put it back: the server keeps that per connection. */
	removedHere: (path: string) => boolean;
}
export const RoomAsksContext = createContext<RoomAsks | null>(null);
/** The ids of the steps in the answer the room is running, for the line under a yes for this answer only. */
export const RunningAnswerSteps = createContext<ReadonlySet<string>>(new Set());
type RoomAskAction = RoomAsks["action"];

type AfterStage = "given" | "taken-back";
type AfterFrame = Parameters<RoomAskAction>[0];
type AfterButton = { label: string; frame: AfterFrame; next: AfterStage };

/** Each stage of the line: its words, and the button that leads on with the frame it sends. */
function afterStage(given: RoomAskGiven, stage: AfterStage, answerRunning: boolean): { line: string | null; button: AfterButton | null } {
	if (given.kind === "folder") {
		// Given for this answer only: the pick put nothing on the list, so there is nothing to remove.
		if (given.lasts === "answer") return { line: folderPickedThisTimeLine(given.access, given.name, answerRunning), button: null };
		return stage === "given"
			? { line: folderPickedLine(given.access, given.name), button: { label: REMOVE, frame: { type: "room_folder_remove", path: given.path }, next: "taken-back" } }
			: { line: folderRemovedLine(given.name), button: { label: UNDO, frame: { type: "room_folder_restore", path: given.path }, next: "given" } };
	}
	if (given.kind === "folder-already") return { line: folderAlreadyLine(given.access, given.name), button: null };
	// The Commands switch in Room settings is the way back after Turn off.
	return stage === "given" ? { line: COMMANDS_ON_LINE, button: { label: TURN_OFF, frame: { type: "room_commands_off" }, next: "taken-back" } } : { line: COMMANDS_OFF_LINE, button: null };
}

/**
 * The line under a yes, with its way back, which only the computer shows.
 * `id`: the step whose yes it is; `takenBack`: saved on that step. Undo shows
 * only while this connection holds the Remove: the server puts back only what
 * that connection removed.
 */
export function RoomAskAfterLine({ id, given, takenBack }: { id: string; given: RoomAskGiven; takenBack: boolean }) {
	const { remote } = useRemoteClientContext();
	const roomAsks = useContext(RoomAsksContext);
	const answerRunning = useContext(RunningAnswerSteps).has(id);
	const [sending, setSending] = useState(false);
	const stage: AfterStage = takenBack ? "taken-back" : "given";
	const { line, button } = afterStage(given, stage, answerRunning);
	if (line === null) return null;
	const shown = button && (button.frame.type !== "room_folder_restore" || roomAsks?.removedHere(button.frame.path)) ? button : null;
	const press = (pressed: AfterButton) => {
		if (!roomAsks) return;
		setSending(true);
		void roomAsks.action(pressed.frame).then((done) => {
			if (!done) return;
			roomAsks.takenBack(id, pressed.next === "taken-back");
		}).finally(() => setSending(false));
	};
	return (
		<div className="wk-line box-room-after" role={stage === "given" ? undefined : "status"}>
			<span>{line}</span>
			{!remote && roomAsks && shown && <button type="button" className="rs-btn rs-btn-sm wk-btn box-room-after-btn" disabled={sending} onClick={() => press(shown)}>{shown.label}</button>}
		</div>
	);
}

/** Each way back's frame, the server's reply to it, and the field that says it was done. */
const AFTER_REPLIES = {
	room_folder_remove: { reply: "room_folder_removed", done: "removed" },
	room_folder_restore: { reply: "room_folder_restored", done: "restored" },
	room_commands_off: { reply: "room_commands_turned_off", done: null },
} as const;

/**
 * The ways back's replies on one connection: `send` resolves when the server
 * answers its frame, and false when the connection goes first, so a lost reply
 * leaves the line as it was.
 */
export function roomAskReplies(post: (frame: object) => boolean) {
	const waiting: Array<{ reply: string; path: string; done: string | null; settle: (done: boolean) => void }> = [];
	// The folders this connection removed, which only its Undo can put back.
	const removed = new Set<string>();
	return {
		send: (frame: Parameters<RoomAskAction>[0]): Promise<boolean> => {
			const { reply, done } = AFTER_REPLIES[frame.type];
			const path = "path" in frame ? frame.path : "";
			if (!post(frame)) return Promise.resolve(false);
			return new Promise((settle) => waiting.push({ reply, path, done, settle }));
		},
		/** True when the frame was a reply this connection waited on. */
		take: (frame: { type?: unknown; path?: unknown; [field: string]: unknown }): boolean => {
			const at = waiting.findIndex((entry) => entry.reply === frame.type && (entry.done === null || entry.path === frame.path));
			if (at < 0) return false;
			const [entry] = waiting.splice(at, 1);
			const done = entry.done === null || frame[entry.done] === true;
			if (done && entry.reply === "room_folder_removed") removed.add(entry.path);
			if (entry.reply === "room_folder_restored") removed.delete(entry.path);
			entry.settle(done);
			return true;
		},
		removedHere: (path: string): boolean => removed.has(path),
		closed: (): void => {
			for (const entry of waiting.splice(0)) entry.settle(false);
		},
	};
}

const COMMANDS_LINE_KEYS = new Set(Object.keys(COMMANDS_ASK_LINES));

type RoomAskFrame = { kind?: unknown; access?: unknown; roomHasFolder?: unknown; canChoose?: unknown; line?: unknown; anyway?: unknown; choosing?: unknown; failure?: unknown; suggested?: unknown; connector?: unknown; sent?: unknown; cut?: unknown };

const FOLDER_PANEL_PRESS_VALUES: ReadonlySet<unknown> = new Set(Object.values(FOLDER_PANEL_PRESSES));
/** The folder a card shows, only whole: a name, a path and whether one click may give it. */
function suggestedFolder(value: unknown): ApprovalItem["suggested"] {
	if (typeof value !== "object" || value === null) return undefined;
	const { name, path, once } = value as Record<string, unknown>;
	return typeof name === "string" && typeof path === "string" && typeof once === "boolean" ? { name, path, once } : undefined;
}

/** What a room's card may change while it stays open, from a frame that carries it: a field the frame leaves out stays as it was. */
export function roomAskState(frame: RoomAskFrame): Partial<ApprovalItem> {
	return {
		...("line" in frame ? { line: typeof frame.line === "string" ? frame.line : undefined } : {}),
		...("canChoose" in frame ? { canChoose: frame.canChoose !== false } : {}),
		...("choosing" in frame ? { choosing: FOLDER_PANEL_PRESS_VALUES.has(frame.choosing) ? frame.choosing as FolderPanelPress : null } : {}),
		...("suggested" in frame ? { suggested: suggestedFolder(frame.suggested) } : {}),
		...("failure" in frame ? { failure: typeof frame.failure === "string" ? frame.failure : undefined } : {}),
	};
}

/** A room's ask from its ui_request frame: the fields its card reads, by its kind. */
export function roomAskFields(frame: RoomAskFrame): Partial<ApprovalItem> {
	const line = typeof frame.line === "string" ? frame.line : undefined;
	const failure = { failure: typeof frame.failure === "string" ? frame.failure : undefined };
	if (frame.kind === "folder") return { access: frame.access === "write" ? "write" : "read", roomHasFolder: frame.roomHasFolder === true, canChoose: frame.canChoose !== false, line, suggested: suggestedFolder(frame.suggested), choosing: roomAskState({ choosing: frame.choosing }).choosing ?? null };
	if (frame.kind === "commands") return { commandsLine: line && COMMANDS_LINE_KEYS.has(line) ? line as ApprovalItem["commandsLine"] : undefined, anyway: frame.anyway === true, ...failure };
	if (frame.kind === "site") return failure;
	if (frame.kind === "connector") return { connector: typeof frame.connector === "string" ? frame.connector : "", sent: typeof frame.sent === "string" ? frame.sent : "", cut: typeof frame.cut === "number" && frame.cut > 0 ? frame.cut : 0, ...failure };
	return {};
}

/** The answer a card reads as once the server took it, from what the server says it took: the same words its buttons give. */
export function answeredLabel(ask: ApprovalItem, taken: unknown): string {
	if (ask.uiKind === "site" || ask.uiKind === "connector") return taken === "room" ? SITE_ALLOW_ROOM : taken === "once" ? SITE_ALLOW_ONCE : CARD_DECLINE;
	if (ask.uiKind === "commands" && taken === true) return ask.anyway ? TURN_ON_ANYWAY : TURN_ON_COMMANDS;
	return NOT_NOW;
}
