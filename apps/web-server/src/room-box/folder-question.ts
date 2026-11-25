import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolDefinition } from "@exxeta/exxperts-runtime";
import { Type } from "typebox";

import type { LocalFolderPickerResult } from "../local-folder-picker.js";
import { grantAutomaticRunWithoutAsking } from "../persistent-room-bash-settings.js";
import { persistentAgentRootPath, readPersistentRoomCapabilityPolicy, readPersistentRoomDefaultCapabilityPolicy, type PersistentRoomCapabilityPolicy, updatePersistentRoomCapabilityPolicyWorkspaceSettings, withCommandsFromCard, writePersistentRoomCapabilityPolicy, writePersistentRoomDefaultCapabilityPolicy } from "../persistent-room-workspace-policy.js";
import { coveringRoot, RoomFilesError } from "../room-files.js";
import { realPlace } from "../path-shapes.js";
import type { ChooseOutcome, CommandsApply, FolderAnswer, FolderPress, QuestionWatcher } from "../web-ui-context.js";
import { addAlsoAllowedFolder, type AlsoAllowedFolder, readAlsoAllowed, saveAlsoAllowedFolders } from "./also-allowed.js";
import { isInside, realPathOf } from "./box-closed.js";
import { ASK_FOLDER, ASK_FOR_COMMANDS_TOOL_NAME, CHANGE_SAVE_FAILED, ASK_FOR_FOLDER_TOOL_NAME, ASK_OUTCOME, type AskFolder, type AskOutcome, type CommandsAskLine, FOLDER_PICK_REFUSED, FOLDER_PICK_REFUSED_IN_PANEL, FOLDER_CARD_WINDOW_CLOSED, FOLDER_WINDOW_CLOSED, type FolderAskAccess, folderHoldsRoomLine, type FolderLasts, folderUsableThisTimeLine, namedPathAsShown, NO_FOLDER_WINDOW, pathAsShown } from "./card-text.js";
import { folderGrantable, pickedThroughWritableLink, soundFolders, writeEntries } from "./folder-offer.js";
import { type HeldFolder, judgeSuggestion, SHOW_SUGGESTION_BEFORE_CLICK, SUGGESTION_JUDGE_MS, suggestionBeforeCard, type SuggestionView } from "./folder-suggestion.js";
import { isSharedServer } from "../server-hooks.js";

/**
 * The room's two asks: for a folder it can't reach, and to turn on commands.
 * Each shows a card in the conversation, one at a time in the order the room
 * asked, a folder before commands. Live at the computer only: with nobody
 * there the ask answers at once, and nothing of the room's words is kept.
 */

// How many Not nows in a row end the asking until the person writes. The outside card counts with these.
const NOT_NOWS_IN_A_ROW = 3;

/** The Not nows the room's cards share: the two asks and the outside card. */
export class NotNowCount {
	private inRow = 0;

	reached(): boolean {
		return this.inRow >= NOT_NOWS_IN_A_ROW;
	}

	notNow(): void {
		this.inRow += 1;
	}

	yes(): void {
		this.inRow = 0;
	}

	personSpoke(): void {
		this.inRow = 0;
	}
}

/**
 * The folders one answer may use beyond the room's list: picks made with Allow
 * this time…. Held in memory for that answer only, never written anywhere: the
 * caller makes one as the answer starts and ends it when the answer ends, Stop
 * included. An ended one gives nothing and takes nothing, so a pick that lands
 * late adds nothing.
 */
export class AnswerFolders {
	private ended = false;
	private readonly given = new Map<string, FolderAskAccess>();

	/** A pick for this answer; false once it ended. A folder already given to change keeps that. */
	give(folder: string, access: FolderAskAccess): boolean {
		if (this.ended) return false;
		if (this.given.get(folder) !== "write") this.given.set(folder, access);
		return true;
	}

	/**
	 * The folder went on the room's list: what this answer was given of it is
	 * the list's now, except a change given this time over an entry that only
	 * reads, which stays for this answer.
	 */
	listed(folder: string, access: FolderAskAccess): void {
		if (!(this.given.get(folder) === "write" && access === "read")) this.given.delete(folder);
	}

	/** The folder came off the room's list here: nothing this answer has of it stays, and putting it back brings none of it. */
	forget(folder: string): void {
		this.given.delete(folder);
	}

	/** The room's list as this answer reaches it, read at each call: each entry, changing files where this answer was given that, then the folders given for this answer alone. */
	over(listed: readonly AlsoAllowedFolder[]): AlsoAllowedFolder[] {
		const onList = new Set(listed.map((entry) => entry.path));
		return [...listed.map((entry) => (this.given.get(entry.path) === "write" ? { ...entry, access: "write" as const } : entry)), ...[...this.given].filter(([folder]) => !onList.has(folder)).map(([folder, access]) => ({ path: folder, access }))];
	}

	end(): void {
		this.ended = true;
		this.given.clear();
	}
}

/** How the room's commands stand for an ask, worked out by the caller from the room's settings now. */
export type CommandsAskState = "on" | "may-ask" | "switched-off" | "unavailable";

/** Whether a connection's room may ask at all: a live turn at the computer, never on a shared server. */
export function roomAsksOffered(atComputer: boolean): boolean {
	return atComputer && !isSharedServer();
}

/**
 * How the room's commands stand for an ask, from its settings now. A card may
 * turn them on only where the room asks at all, in a room with a folder in Full
 * access, and never where the person switched them off.
 */
export function commandsAskState(room: { on: boolean; atComputer: boolean; folder: string | null; fullAccess: boolean; switchedOff: () => boolean }): CommandsAskState {
	if (room.on) return "on";
	if (!roomAsksOffered(room.atComputer) || !room.folder || !room.fullAccess) return "unavailable";
	return room.switchedOff() ? "switched-off" : "may-ask";
}

/** The room as an ask needs it, read at each ask. */
export interface RoomAskView {
	/** The room's own folder by its real path, or null where it has none. */
	folder: string | null;
	canChangeFiles: boolean;
	commands: CommandsAskState;
	/** Whether commands stay inside the room on this computer: the card's line and button follow it. */
	boxed: boolean;
	/** Not boxed because the person turned the room's protection off, or its folder is why: the card says so of this room, not of the computer. */
	unprotected?: boolean;
}

/** The slice of the question bridge the asks use. */
export interface AskQuestions {
	watcher(): QuestionWatcher;
	askFolder(card: { access: FolderAskAccess; reason: string; roomHasFolder: boolean; held: HeldFolder | null; named?: string | null; act: (press: FolderPress, held: HeldFolder | null, signal: AbortSignal) => Promise<ChooseOutcome> }): Promise<FolderAnswer>;
	askCommands(card: { reason: string; line: CommandsAskLine; anyway: boolean }, apply: CommandsApply): Promise<boolean>;
}

export interface RoomAsksOptions {
	roomId: string;
	/** The room's reason for a call, which only the card may see. */
	reasonOf: (toolCallId: string, fallback: unknown) => string;
	/** The folder the room suggests on a folder ask, by the model's own text: the judge reads it, the card shows it written out where no folder is held, and nothing saves it. */
	folderOf?: (toolCallId: string, fallback: unknown) => string;
	questions: AskQuestions;
	room: () => RoomAskView;
	/** The computer's own folder window, closed by the signal, opened at `startAt` where the server names one. */
	pickFolder: (signal: AbortSignal, startAt?: string) => Promise<LocalFolderPickerResult>;
	/** A yes on the commands card: commands on for the room. */
	turnOnCommands: () => void;
	notNow: NotNowCount;
	/** The running answer's own folders, read at each ask. */
	answer: () => AnswerFolders;
	/** The first look into a picked folder; `firstLook` unless a smoke holds it. */
	look?: (folder: string) => Promise<FirstLook>;
	/** Every folder ask waits this long before its card, with a suggestion or without; a timer unless a smoke records it. */
	wait?: (ms: number) => Promise<void>;
	/** Whether the panel names a suggested folder it holds before a press; `SHOW_SUGGESTION_BEFORE_CLICK` unless a smoke sets it. */
	showSuggestionBeforeClick?: boolean;
	/** The person's home for the judge and the paths the panel shows; the login home unless a smoke sets it. */
	suggestionHome?: string;
	/**
	 * In a room that asks nothing (Auto with protection off): the real path its
	 * file tools would open a folder at now, or the fence's refusal thrown; null
	 * elsewhere. A read that throws reads as null.
	 */
	opensWithoutAsking?: () => ((folder: string, access: FolderAskAccess) => string) | null;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Takes the room's reason, and the folder it suggests, out of each ask the
 * moment the model's message ends, before anything sends or saves them: the
 * tool events, the finished message, the replay, the runtime's own session file
 * and the saved steps all carry them empty. The card gets the reason, and the
 * judge the folder and the card its words, from here by the call's id, and
 * nothing else does.
 */
const isAsk = (name: unknown): boolean => name === ASK_FOR_FOLDER_TOOL_NAME || name === ASK_FOR_COMMANDS_TOOL_NAME;
const KEPT_FIELDS = ["reason", "folder"] as const;
type KeptField = (typeof KEPT_FIELDS)[number];
const keptOf = (input: any): Partial<Record<KeptField, string>> => Object.fromEntries(KEPT_FIELDS.flatMap((field) => (typeof input?.[field] === "string" && input[field] !== "" ? [[field, input[field]]] : [])));
// Any value leaves the message, a list or an object too: only text is kept for the card and the judge.
const present = (input: any): KeptField[] => KEPT_FIELDS.filter((field) => input?.[field] !== undefined && input[field] !== "");
const blanked = (input: any, fields: readonly KeptField[]) => ({ ...input, ...Object.fromEntries(fields.map((field) => [field, ""])) });

export function createReasonKeeper(): { extension: (pi: any) => void; take: (toolCallId: string, fallback: unknown) => string; takeFolder: (toolCallId: string, fallback: unknown) => string } {
	const kept = new Map<string, Partial<Record<KeptField, string>>>();
	const takeField = (field: KeptField) => (toolCallId: string, fallback: unknown): string => {
		const entry = kept.get(toolCallId);
		const value = entry?.[field];
		if (entry) {
			delete entry[field];
			if (Object.keys(entry).length === 0) kept.delete(toolCallId);
		}
		return value ?? (typeof fallback === "string" ? fallback : "");
	};
	return {
		extension(pi: any) {
			pi.on("message_end", (event: { message?: { role?: string; content?: unknown; rawContent?: unknown } }) => {
				const message = event.message;
				if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
				let changed = false;
				const content = message.content.map((block: any) => {
					if (block?.type !== "toolCall" || !isAsk(block.name)) return block;
					const fields = present(block.arguments);
					if (fields.length === 0) return block;
					const text = keptOf(block.arguments);
					if (Object.keys(text).length > 0) kept.set(String(block.id), text);
					changed = true;
					return { ...block, arguments: blanked(block.arguments, fields) };
				});
				if (!changed) return undefined;
				// A turn with the provider's own tools keeps its wire blocks to send back as they came: the ask's input there loses them too.
				const rawContent = Array.isArray(message.rawContent)
					? message.rawContent.map((block: any) => (block?.type === "tool_use" && isAsk(block.name) && present(block.input).length > 0 ? { ...block, input: blanked(block.input, present(block.input)) } : block))
					: undefined;
				return { message: { ...message, content, ...(rawContent ? { rawContent } : {}) } };
			});
		},
		take: takeField("reason"),
		takeFolder: takeField("folder"),
	};
}

/**
 * Commands on or off for the room, and for this conversation where it keeps
 * its own settings. On is a card's yes, which also gives Run without asking
 * where the room's protection runs and no choice is stored. Off is Turn off,
 * the person switching them off, so the room asks no more. A write that fails
 * puts back the policies written before it, so a yes the card says couldn't
 * be saved left nothing on.
 */
export function setRoomCommands(roomId: string, conversationId: string, on: boolean): void {
	const set = (policy: PersistentRoomCapabilityPolicy) => (on ? withCommandsFromCard(policy) : updatePersistentRoomCapabilityPolicyWorkspaceSettings(policy, { bashEnabled: false }));
	const putBack: Array<() => void> = [];
	try {
		const roomDefault = readPersistentRoomDefaultCapabilityPolicy(roomId);
		// Each put-back is noted before its write: a write that fails after its file is in place is put back too.
		if (roomDefault) {
			putBack.push(() => writePersistentRoomDefaultCapabilityPolicy(roomDefault));
			writePersistentRoomDefaultCapabilityPolicy(set(roomDefault));
		}
		const own = readPersistentRoomCapabilityPolicy(roomId, conversationId);
		if (own) {
			putBack.push(() => writePersistentRoomCapabilityPolicy(own));
			writePersistentRoomCapabilityPolicy(set(own));
		}
		if (on) grantAutomaticRunWithoutAsking(roomId);
	} catch (error) {
		// Newest first; one that fails too still leaves the others tried.
		for (const undo of putBack.reverse()) {
			try {
				undo();
			} catch {}
		}
		throw error;
	}
}

/** Back to Can read in Room settings. Only a folder on the list that can change files goes back. */
export function undoAllowChanges(roomId: string, folder: string): boolean {
	const listed = readAlsoAllowed(roomId).folders;
	if (!listed.some((entry) => entry.path === folder && entry.access === "write")) return false;
	saveAlsoAllowedFolders(roomId, listed.map((entry) => (entry.path === folder ? { ...entry, access: "read" as const } : entry)));
	return true;
}

/** Remove on the line after a pick: that folder leaves the room's list, and what the running answer has of it goes too; it stays on the computer. Only a folder on the list goes; the access it had comes back, for Undo. */
export function removeAskedFolder(roomId: string, folder: string, answer?: AnswerFolders): FolderAskAccess | null {
	const listed = readAlsoAllowed(roomId).folders;
	const entry = listed.find((each) => each.path === folder);
	if (!entry) return null;
	saveAlsoAllowedFolders(roomId, listed.filter((each) => each !== entry));
	answer?.forget(folder);
	return entry.access;
}

// What the model reads. None sends the person to a setting or hands them a step to do by hand.
const STOP_AND_SAY = "Don't ask again in this answer or try another way. Say what you couldn't do";
const NO_STEPS = "Don't give commands to type, steps to do it by hand or a settings path, and don't suggest attaching, pasting, copying or exporting the files, or saving them another way.";
export const FOLDER_NOT_NOW = `The person said Not now to this folder question. ${STOP_AND_SAY}, and that they can ask again or choose a folder. ${NO_STEPS}`;
export const COMMANDS_NOT_NOW = `The person said Not now to turning on commands. ${STOP_AND_SAY}, and that they can ask again. ${NO_STEPS}`;
export const NOBODY_FOR_FOLDER = "Nobody is at the computer to choose a folder, so nothing changed. Don't wait for an answer: finish what you can and say what you couldn't do without that folder.";
export const NOBODY_FOR_COMMANDS = "Nobody is at the computer to turn on commands, so nothing ran. Don't wait for an answer: finish what you can and say what you couldn't do.";
export const ASKED_TOO_OFTEN = `The person has said Not now several times, so don't ask again or try another way until they write. Say what you couldn't do, and that they can ask for it again in a new message. ${NO_STEPS}`;
export const NO_FOLDER_OF_ITS_OWN = "This room has no folder of its own yet, so it can't be given another. Say what you couldn't do.";
export const READ_ONLY_ROOM_ASK = "This room can't change files, so it can't be given a folder to change. Say what you couldn't do.";
export const COMMANDS_SWITCHED_OFF = "Commands are off in Room settings, so this room can't ask for them. Say what you couldn't do.";
/** What the bash tool answers while commands are off: it is there from the start where they may come on. */
export const COMMAND_OFF_NOTHING_RAN = "Commands are off in this room, so nothing ran. To turn them on, call ask_for_commands.";
export const COMMAND_SWITCHED_OFF_NOTHING_RAN = "Commands are off in Room settings, so nothing ran. Say what you couldn't do.";
export const COMMANDS_UNAVAILABLE = "Commands are off in this room and can't be turned on here. Say what you couldn't do.";

/** What the bash tool answers for how the room's commands stand now, or null while they're on. Only "may-ask" points to the ask: elsewhere it isn't offered. */
export function commandOffLine(commands: CommandsAskState): string | null {
	if (commands === "on") return null;
	if (commands === "switched-off") return COMMAND_SWITCHED_OFF_NOTHING_RAN;
	return commands === "may-ask" ? COMMAND_OFF_NOTHING_RAN : COMMANDS_UNAVAILABLE;
}
export const COMMANDS_ALREADY_ON = "Commands are already on in this room: run the command.";
export const COMMANDS_TURNED_ON = "The person turned on commands for this room. Run the command now.";
export const COMMANDS_WITHDRAWN = `Not asked: the person said Not now to the folder this job needed, so there's no folder for commands to work in. If the job still needs commands, you can ask again with a new reason. ${NO_STEPS}`;
export const ASK_WITHDRAWN_FOR_MESSAGE = "Not asked: the person wrote a message instead. Read it and go on from there.";
export const FOLDER_REASON_MISSING = `Not asked: the reason is empty. Call ${ASK_FOR_FOLDER_TOOL_NAME} again with a reason that names the file or folder you're looking for, such as "the folder that holds fetch_transcript.py".`;

const folderPicked = (folder: string, access: FolderAskAccess, lasts: FolderLasts): string =>
	lasts === "answer"
		? `The person chose ${folder} for this answer only. This room can ${access === "write" ? "read and change" : "read"} files there until it finishes answering this message: use that full path, and go on with the job. Don't count on it in a later answer.`
		: `The person chose ${folder}. This room can now ${access === "write" ? "read and change" : "read"} files there: use that full path, and go on with the job.`;
const folderAlready = (folder: string, access: FolderAskAccess): string => `This room can already ${access === "write" ? "read and change" : "read"} files in ${folder}: use that full path, and go on with the job.`;
/**
 * Where a room that asks nothing reaches with its file tools: its ask_for_folder
 * answer and its line in the room's state message both say it. The exceptions
 * are the fence's in that room (room-files.ts: the app's data, the shared
 * connector settings, CLOSED_TO_WRITES_ASKING_NOTHING, a Can read folder) and
 * the person's own content rules, which still apply to its file tools. Left
 * out on purpose: running programs' details under /proc, which no desktop has,
 * and a stored policy's extra closed names, which no screen sets.
 */
export const reachWithoutAsking = (canChangeFiles: boolean): string =>
	canChangeFiles
		? "read and change files anywhere on this computer by their full path, except the app's own data, the connector settings file .config/mcp/mcp.json, changes to .mcp.json files and in a folder the person set to Can read, and anything a rule the person added to the content policy blocks"
		: "read files anywhere on this computer by their full path, except the app's own data, the connector settings file .config/mcp/mcp.json and anything a rule the person added to the content policy blocks";
/** A room that asks nothing, asked for no folder in particular: it names none. */
const nothingToAsk = (canChangeFiles: boolean): string => `Nothing needs the person's approval here: this room's file tools ${reachWithoutAsking(canChangeFiles)}. Use the full path, and go on with the job.`;

/** What ask_for_folder answers in a room that asks nothing: the file tools' own fence decides, and no card shows. */
function answeredWithoutAsking(opens: (folder: string, access: FolderAskAccess) => string, folder: string, access: FolderAskAccess, canChangeFiles: boolean) {
	if (access === "write" && !canChangeFiles) return answered(READ_ONLY_ROOM_ASK, "not-asked");
	if (!folder) return answered(nothingToAsk(canChangeFiles), "already");
	try {
		return answered(folderAlready(opens(folder, access), access), "already");
	} catch (error) {
		if (error instanceof RoomFilesError) return answered(error.message, "not-asked");
		throw error;
	}
}

function opensNow(options: RoomAsksOptions): ((folder: string, access: FolderAskAccess) => string) | null {
	try {
		return options.opensWithoutAsking?.() ?? null;
	} catch {
		return null;
	}
}

const REASON_FIELD = 'Why this room needs it, in one plain line for the person. Say "folder", never "workspace". No paths.';
const FOLDER_REASON_FIELD = 'What you are looking for and why, in one plain line for the person. Name the file or folder by its name, as "the folder that holds fetch_transcript.py" or "your Reports folder". Say "folder", never "workspace". No paths.';
const FOLDER_FIELD = "The full path of the folder, or of the one file the job needs, when you know it, as /Users/ana/Documents/Reports, C:\\Users\\Ana\\Documents\\Reports or ~/Documents/Reports. Leave it out when you don't know it.";

const folderSchema = Type.Object({
	access: Type.Union([Type.Literal("read"), Type.Literal("change")], { description: "read to read files there; change to also change or add files there" }),
	reason: Type.String({ description: FOLDER_REASON_FIELD }),
	folder: Type.Optional(Type.String({ description: FOLDER_FIELD })),
});

const commandsSchema = Type.Object({
	reason: Type.String({ description: REASON_FIELD }),
});

function answered(text: string, outcome: AskOutcome, folder?: AskFolder) {
	return { content: [{ type: "text" as const, text }], details: { [ASK_OUTCOME]: outcome, ...(folder ? { [ASK_FOLDER]: folder } : {}) } };
}

/** How long the first look into a picked folder may take before nothing is given: on a Mac, macOS's own question about the folder comes during it. */
export const FIRST_LOOK_LIMIT_MS = 15_000;
/** The first look into a picked folder: its files listed, the listing refused, or no answer within the limit. */
export type FirstLook = "listed" | "refused" | "slow";

/**
 * Lists a picked folder once, before it is given, so the computer's own first
 * question about it comes at the pick, not in the middle of a command. Off the
 * server's loop; it never throws. A listing still waiting at the limit goes
 * on in the background until the computer answers.
 */
export function firstLook(folder: string, limitMs = FIRST_LOOK_LIMIT_MS): Promise<FirstLook> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const slow = new Promise<FirstLook>((resolve) => {
		timer = setTimeout(() => resolve("slow"), limitMs);
		timer.unref?.();
	});
	const listed = fs.promises.readdir(folder).then((): FirstLook => "listed", (): FirstLook => "refused");
	return Promise.race([listed, slow]).finally(() => clearTimeout(timer));
}

/** A folder as the disk has it now, by its own entry: a folder that is no link, with its disk and file number, or null. */
function folderIdentity(folder: string): { dev: bigint; ino: bigint } | null {
	try {
		const seen = fs.lstatSync(folder, { bigint: true });
		return seen.isDirectory() && !seen.isSymbolicLink() ? { dev: seen.dev, ino: seen.ino } : null;
	} catch {
		return null;
	}
}

/** What the room's rules make of a folder before it is given: a line why not, an answer it already has, or the folder with its identity as the disk has it now. */
export type PickJudged = { line: string } | { already: FolderAnswer } | { folder: string; name: string; dev: bigint; ino: bigint };

/**
 * The room's rules for a folder about to be shown or given, on the list or for
 * `answer` alone as `lasts` says. The checks run over the list and what the
 * running answer was given alike, since commands can write in both. `exact`:
 * the very folder named, reached with no link, never one a link leads to.
 * `beforeClick`: nobody has pressed anything yet, so the list is read by its
 * text and no saved entry is touched, and no program starts. `refused`: the
 * line for a folder no room may use, as the place that shows it says it.
 */
export function judgePick(picked: string, { roomId, room, access, answer, lasts, exact = false, beforeClick = false, refused = FOLDER_PICK_REFUSED }: { roomId: string; room: RoomAskView; access: FolderAskAccess; answer?: AnswerFolders; lasts: FolderLasts; exact?: boolean; beforeClick?: boolean; refused?: string }): PickJudged {
	const saved = readAlsoAllowed(roomId).folders;
	const sound = (folders: readonly AlsoAllowedFolder[]) => (room.folder && !beforeClick ? soundFolders(folders, room.folder) : [...folders]);
	const withAnswer = answer?.over(saved) ?? saved;
	const listed = sound(saved);
	const reachable = sound(withAnswer);
	const roomFolder = room.folder ? [room.folder] : [];
	if (pickedThroughWritableLink(picked, [...roomFolder, ...writeEntries(withAnswer)])) return { line: refused };
	const named = picked.length > 1 ? picked.replace(/[\\/]+$/, "") : picked;
	const folder = exact ? named : realPathOf(named);
	if (exact && realPlace(folder, { links: "refuse" }) !== folder) return { line: refused };
	const name = path.basename(folder) || folder;
	if (room.folder && isInside(room.folder, folder)) return { line: folderHoldsRoomLine(name) };
	// A room whose writing tools are off can only read, whatever a folder on its list once allowed.
	const reach = (place: { path: string; access: FolderAskAccess }) => (room.canChangeFiles ? place : { ...place, access: "read" as const });
	// A pick for the room is covered only by what lasts: what this answer was given still goes on the list.
	const places = [...(room.folder ? [{ path: room.folder, access: "write" as const }] : []), ...(lasts === "answer" ? reachable : listed)].map(reach);
	const covering = coveringRoot(folder, access, places);
	if (covering) return { already: { state: "already", folder, name, access: covering.access } };
	// A room with no folder is judged against its own data, which every closed place already holds.
	const grantableOver = (folders: readonly AlsoAllowedFolder[]) => folderGrantable(folder, access, [...roomFolder, ...writeEntries(folders)], room.folder ?? persistentAgentRootPath(roomId), { ...(exact ? { links: "refuse" as const } : {}), beforeClick });
	if (!grantableOver(reachable)) {
		// Refused for the room only because a folder this answer was given to change holds it: the room has it until the answer ends.
		if (lasts === "room" && grantableOver(listed)) return { line: folderUsableThisTimeLine(name) };
		return { line: refused };
	}
	const seen = folderIdentity(folder);
	return seen ? { folder, name, ...seen } : { line: refused };
}

/**
 * The one way a judged folder is given: looked into first, then given only if
 * the card is still open, the room's rules pass again on the same folder
 * (`judgeAgain`, as the caller judged it) and it is still the one judged, by
 * its disk and file number. `beforeGive` is the caller's own last check, run
 * in the same run as the give: a throw gives nothing and reaches the caller.
 * `refused` as for judgePick.
 */
export async function giveFolder({ roomId, judged, judgeAgain, access, lasts, answer, signal, look = firstLook, beforeGive, refused = FOLDER_PICK_REFUSED }: { roomId: string; judged: { folder: string; name: string; dev: bigint; ino: bigint }; judgeAgain: () => PickJudged; access: FolderAskAccess; lasts: FolderLasts; answer?: AnswerFolders; signal: AbortSignal; look?: (folder: string) => Promise<FirstLook>; beforeGive?: () => void; refused?: string }): Promise<ChooseOutcome> {
	const { folder, name } = judged;
	const looked = await look(folder);
	// The card ended while the window was open or during the look: nothing lands.
	if (signal.aborted) return { unchanged: true };
	// Refused by the computer, or no answer in time: the room couldn't use it, so it isn't given.
	if (looked !== "listed") return { line: refused, canChoose: true };
	// Judged again by the same rules, in this run: a parent moved during the look, with a link left at its name, makes the path inexact.
	const again = judgeAgain();
	if ("line" in again || ("folder" in again && again.folder !== folder)) return { line: refused, canChoose: true };
	// Still the folder that was picked and judged, not moved, replaced or turned into a link: no link, and the same disk and file number.
	const still = folderIdentity(folder);
	if (!still || still.dev !== judged.dev || still.ino !== judged.ino) return { line: refused, canChoose: true };
	// Nothing may be awaited from here to the return: the card closes in the same run as the give, so no Not now, Stop or message can come between them.
	beforeGive?.();
	try {
		if (lasts === "answer") {
			// The answer ended while the window was open.
			if (!answer?.give(folder, access)) return { unchanged: true };
		} else {
			addAlsoAllowedFolder(roomId, folder, access);
			answer?.listed(folder, access);
		}
	} catch {
		return { line: CHANGE_SAVE_FAILED, canChoose: true, unsaved: true };
	}
	return { done: { state: "picked", folder, name, access, lasts } };
}

/**
 * One press of Allow for this room on a card with no folder shown, or of
 * Choose a folder… on the line left after nobody was there: the computer's
 * window, then the room's rules, then the give. A path comes only from the
 * window. `refused` as for judgePick.
 */
export async function chooseFolderForRoom({ roomId, room, access, pickFolder, signal, answer, lasts = "room", closedLine = FOLDER_WINDOW_CLOSED, look = firstLook, beforeGive, refused = FOLDER_PICK_REFUSED }: { roomId: string; room: RoomAskView; access: FolderAskAccess; pickFolder: (signal: AbortSignal) => Promise<LocalFolderPickerResult>; signal: AbortSignal; answer?: AnswerFolders; lasts?: FolderLasts; closedLine?: string; look?: (folder: string) => Promise<FirstLook>; beforeGive?: () => void; refused?: string }): Promise<ChooseOutcome> {
	const picked = await pickFolder(signal);
	if (!picked.ok) {
		if (picked.code === "folder_chooser_stopped") return { unchanged: true };
		return picked.supported ? { line: closedLine, canChoose: true } : { line: NO_FOLDER_WINDOW, canChoose: false };
	}
	if (picked.cancelled || signal.aborted) return { unchanged: true };
	const judged = judgePick(picked.path, { roomId, room, access, answer, lasts, refused });
	if ("line" in judged) return { line: judged.line, canChoose: true };
	if ("already" in judged) return { done: judged.already };
	return giveFolder({ roomId, judged, judgeAgain: () => judgePick(judged.folder, { roomId, room, access, answer, lasts, refused }), access, lasts, answer, signal, look, beforeGive, refused });
}

type InLine = { kind: "folder" | "commands"; start: () => void; withdraw: (text: string) => void };

/**
 * Builds the two ask tools for one connection. The order and the Not now
 * count belong to the running answer only, so nothing here outlives it.
 */
export function createRoomAsks(options: RoomAsksOptions): { tools: ToolDefinition<any, any>[]; personSpoke: () => void } {
	const { questions, notNow, roomId } = options;
	const waiting: InLine[] = [];
	let open = false;

	const next = () => {
		if (open) return;
		const folderAt = waiting.findIndex((entry) => entry.kind === "folder");
		const entry = folderAt >= 0 ? waiting.splice(folderAt, 1)[0] : waiting.shift();
		if (!entry) return;
		open = true;
		entry.start();
	};
	const inLine = <T>(kind: InLine["kind"], run: () => Promise<T>, withdrawn: (text: string) => T): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			waiting.push({
				kind,
				start: () => {
					// Not nows given while it waited count: past the limit it never shows.
					if (notNow.reached()) {
						open = false;
						resolve(withdrawn(ASKED_TOO_OFTEN));
						next();
						return;
					}
					run().then(resolve, reject).finally(() => {
						open = false;
						next();
					});
				},
				withdraw: (text) => resolve(withdrawn(text)),
			});
			// The answer's other calls start in this same pass: once they are in line, a folder goes first.
			setImmediate(next);
		});
	const withdraw = (kind: InLine["kind"] | null, text: string) => {
		for (const entry of waiting.filter((each) => kind === null || each.kind === kind)) {
			waiting.splice(waiting.indexOf(entry), 1);
			entry.withdraw(text);
		}
	};

	let spoken = 0;
	const show = options.showSuggestionBeforeClick ?? SHOW_SUGGESTION_BEFORE_CLICK;
	const home = () => realPathOf(options.suggestionHome ?? os.homedir());

	/** The room as the judge of a suggestion reads it: its own rules for a pick, exact, as `lasts` says. */
	const suggestionView = (room: RoomAskView & { folder: string }, access: FolderAskAccess, answer: AnswerFolders, lasts: FolderLasts): SuggestionView => ({
		roomFolder: room.folder,
		writable: [room.folder, ...writeEntries(answer.over(readAlsoAllowed(roomId).folders))],
		// Before a press, a folder the room already has is no suggestion; at a press it answers that it has it.
		roomRules: (real, at) => {
			const judged = judgePick(real, { roomId, room, access, answer, lasts, exact: true, beforeClick: at === "before-click" });
			return "folder" in judged || (at === "click" && "already" in judged);
		},
		...(options.suggestionHome ? { home: options.suggestionHome } : {}),
	});

	/**
	 * One press on the folder panel, with the folder it held at the press. A
	 * folder shown is given only after the same rules pass again on it and it is
	 * still the very folder shown; Allow for this room on the room's suggestion
	 * gives at once only that folder, and any other pick in the window is shown,
	 * never given, until a press gives it. The folder given is always the one
	 * judged, never one worked out again.
	 */
	const act = (access: FolderAskAccess, suggestion: string) => async (press: FolderPress, held: HeldFolder | null, signal: AbortSignal): Promise<ChooseOutcome> => {
		const room = options.room();
		const answer = options.answer();
		const lasts: FolderLasts = press === "this-time" ? "answer" : "room";
		// The panel's own button offers another folder, so its line doesn't.
		const refused = FOLDER_PICK_REFUSED_IN_PANEL;
		const refusedShown: ChooseOutcome = { show: { line: refused, canChoose: true, held: null } };
		const judge = (picked: string, exact: boolean) => judgePick(picked, { roomId, room, access, answer, lasts, exact, refused });
		// A folder that failed its look or changed is no longer shown; one whose save failed stays, for another try.
		const give = async (judged: { folder: string; name: string; dev: bigint; ino: bigint }): Promise<ChooseOutcome> => {
			const outcome = await giveFolder({ roomId, judged, judgeAgain: () => judge(judged.folder, true), access, lasts, answer, signal, look: options.look, refused });
			return "line" in outcome && !outcome.unsaved ? { show: { line: outcome.line, canChoose: true, held: null } } : outcome;
		};
		const shownFromWindow = (judged: { folder: string; name: string; dev: bigint; ino: bigint }): ChooseOutcome => ({
			show: { canChoose: true, held: { real: judged.folder, name: judged.name, shown: pathAsShown(judged.folder, home(), process.platform === "win32"), from: "window", once: true, dev: String(judged.dev), ino: String(judged.ino) } },
		});
		/** The window, and what came of it: closed or failed keeps the folder shown, a pick is judged and handed to `picked`. */
		const windowAt = async (startAt: string | undefined, picked: (path: string) => ChooseOutcome | Promise<ChooseOutcome>): Promise<ChooseOutcome> => {
			const result = await options.pickFolder(signal, startAt);
			if (!result.ok) {
				if (result.code === "folder_chooser_stopped") return { unchanged: true };
				return { line: result.supported ? FOLDER_CARD_WINDOW_CLOSED : NO_FOLDER_WINDOW, canChoose: result.supported };
			}
			if (result.cancelled || signal.aborted) return { unchanged: true };
			return picked(result.path);
		};
		const shown = (path: string): ChooseOutcome => {
			const judged = judge(path, false);
			if ("line" in judged) return { show: { line: judged.line, canChoose: true, held: null } };
			if ("already" in judged) return { done: judged.already };
			return shownFromWindow(judged);
		};

		if (press === "choose") {
			// No window at the room's own guess but where it allows one click: elsewhere at the home, where no pick can be given at once.
			let startAt = held?.from === "room" && !held.once ? home() : undefined;
			if (held === null && !show && suggestion !== "" && room.folder) {
				const judged = await judgeSuggestion(suggestion, suggestionView({ ...room, folder: room.folder }, access, answer, "room"), "click");
				startAt = judged ? (judged.once ? judged.real : home()) : undefined;
			}
			return windowAt(startAt, shown);
		}
		// Allow for this room with nothing shown: the window, and its pick given as before.
		if (held === null) return chooseFolderForRoom({ roomId, room, access, pickFolder: options.pickFolder, signal, answer, lasts, closedLine: FOLDER_CARD_WINDOW_CLOSED, look: options.look, refused });
		// The room's suggestion is judged again whole, as before the card, and must still be the folder shown.
		if (held.from === "room") {
			if (!room.folder) return refusedShown;
			const again = await judgeSuggestion(held.real, suggestionView({ ...room, folder: room.folder }, access, answer, lasts), "click");
			// Allow this time gives by one click only what the judge still offers one click for.
			if (again === null || again.real !== held.real || again.dev !== held.dev || again.ino !== held.ino || (press === "this-time" && !again.once)) return refusedShown;
			// Not now, Stop or a message during the recheck: no look starts after the card ended.
			if (signal.aborted) return { unchanged: true };
		}
		const judged = judge(held.real, true);
		if ("line" in judged) return { show: { line: judged.line, canChoose: true, held: null } };
		if ("already" in judged) return { done: judged.already };
		if (String(judged.dev) !== held.dev || String(judged.ino) !== held.ino) return refusedShown;
		if (press === "this-time" || held.from === "window") return give(judged);
		// Allow for this room on the room's suggestion: the window at that folder, and only that folder given at once.
		return windowAt(held.real, (path) => {
			const picked = judge(path, false);
			if ("folder" in picked && picked.folder === held.real && picked.dev === judged.dev && picked.ino === judged.ino) return give(picked);
			return shown(path);
		});
	};

	const askFolder: ToolDefinition<typeof folderSchema, Record<string, unknown>> = {
		name: ASK_FOR_FOLDER_TOOL_NAME,
		label: ASK_FOR_FOLDER_TOOL_NAME,
		description: "Ask the person to choose a folder this room can use. Call this as soon as a job names a folder or files this room can't see: it's somewhere else on their computer. Do this instead of guessing paths, making a folder of that name here, saving somewhere else, or telling them to change a setting. The app shows them your reason. Say in it what you're looking for, by name. Give the full path in folder when you know it, of the folder or of the one file the job needs: they see it, and allow its folder or choose another in their computer's folder window. When you know the folder, also name it in your own message. If they allow one, the result gives you its path and you go on with the job. Don't call it for work this room's folder, its attachments or the chat already cover. To change a file in a folder this room can only read, call this with access change: the person picks that folder again.",
		promptSnippet: "Ask the person to choose a folder this room can't reach yet",
		parameters: folderSchema,
		async execute(toolCallId, params) {
			const reason = options.reasonOf(toolCallId, params.reason);
			const suggestion = options.folderOf?.(toolCallId, params.folder) ?? "";
			const spokenBefore = spoken;
			const access: FolderAskAccess = params.access === "change" ? "write" : "read";
			const room = options.room();
			// A folder on the list is opened through the room's own: with none, a pick would give nothing.
			if (!room.folder) return answered(NO_FOLDER_OF_ITS_OWN, "not-asked");
			const opens = opensNow(options);
			if (opens) return answeredWithoutAsking(opens, suggestion, access, room.canChangeFiles);
			if (questions.watcher() === "none") return answered(NOBODY_FOR_FOLDER, "nobody");
			if (notNow.reached()) return answered(ASKED_TOO_OFTEN, "not-asked");
			if (access === "write" && !room.canChangeFiles) return answered(READ_ONLY_ROOM_ASK, "not-asked");
			// The card's reason is all a person may have to go on: a card that names nothing can't be answered.
			if (reason.trim() === "") return answered(FOLDER_REASON_MISSING, "not-asked");
			try {
				const answer = await inLine("folder", async (): Promise<FolderAnswer | string> => {
					// Every ask waits the judge's time, so how long the card took says nothing of the room's guess.
					const judging = suggestion !== "" && room.folder ? suggestionBeforeCard(suggestion, suggestionView({ ...room, folder: room.folder }, access, options.answer(), "room"), show).catch(() => null) : Promise.resolve(null);
					const [held] = await Promise.all([judging, (options.wait ?? pause)(SUGGESTION_JUDGE_MS)]);
					// The person wrote while the card waited: it isn't asked.
					if (spoken !== spokenBefore) return ASK_WITHDRAWN_FOR_MESSAGE;
					// Where no folder is held, the room's own words for the place, so the person still learns which it means.
					const named = held === null && suggestion.trim() !== "" ? namedPathAsShown(suggestion, home(), process.platform === "win32") : null;
					const result = await questions.askFolder({ access, reason, roomHasFolder: room.folder !== null, held, named, act: act(access, suggestion) });
					// After a Not now on the folder, a commands ask waiting behind it has nothing to work in.
					if (result.state === "declined") withdraw("commands", COMMANDS_WITHDRAWN);
					return result;
				}, (text): FolderAnswer | string => text);
				if (typeof answer === "string") return answered(answer, "not-asked");
				if (answer.state === "declined") {
					notNow.notNow();
					return answered(FOLDER_NOT_NOW, "not-now");
				}
				notNow.yes();
				if (answer.state === "already") return answered(folderAlready(answer.folder, answer.access), "already", { path: answer.folder, name: answer.name, access: answer.access });
				// A pick for the room is saved as it always was: only one for this answer says how long.
				const given: AskFolder = { path: answer.folder, name: answer.name, access: answer.access, ...(answer.lasts === "answer" ? { lasts: answer.lasts } : {}) };
				return answered(folderPicked(answer.folder, answer.access, answer.lasts), "yes", given);
			} catch (error) {
				// Stop, or a message sent instead: the bridge's sentence says which.
				return answered((error as Error).message, "not-asked");
			}
		},
	};

	const askCommands: ToolDefinition<typeof commandsSchema, Record<string, unknown>> = {
		name: ASK_FOR_COMMANDS_TOOL_NAME,
		label: ASK_FOR_COMMANDS_TOOL_NAME,
		description: "Ask the person to turn on commands for this room. Call this when a job can't be done without running a command: running a script, converting a file, making a Word, Excel, PDF or picture file. Don't tell the person to change a setting, and don't call it for work the file tools or the chat can do. The app shows them your reason, and they say yes or no.",
		promptSnippet: "Ask the person to turn on commands for this room",
		parameters: commandsSchema,
		async execute(toolCallId, params) {
			const reason = options.reasonOf(toolCallId, params.reason);
			const room = options.room();
			if (room.commands === "on") return answered(COMMANDS_ALREADY_ON, "already");
			if (room.commands === "switched-off") return answered(COMMANDS_SWITCHED_OFF, "not-asked");
			if (room.commands === "unavailable") return answered(COMMANDS_UNAVAILABLE, "not-asked");
			if (questions.watcher() === "none") return answered(NOBODY_FOR_COMMANDS, "nobody");
			if (notNow.reached()) return answered(ASKED_TOO_OFTEN, "not-asked");
			const line: CommandsAskLine = !room.boxed ? (room.unprotected ? "unprotected" : "no-box") : room.canChangeFiles ? "in-box" : "in-box-read-only";
			try {
				// Commands come on before the card is told so: a yes that couldn't be saved keeps the card open.
				const turnOn = (): true => {
					options.turnOnCommands();
					return true;
				};
				const yes = await inLine("commands", () => questions.askCommands({ reason, line, anyway: !room.boxed }, turnOn), (text): boolean | string => text);
				if (typeof yes === "string") return answered(yes, "not-asked");
				if (!yes) {
					notNow.notNow();
					return answered(COMMANDS_NOT_NOW, "not-now");
				}
				notNow.yes();
				return answered(COMMANDS_TURNED_ON, "yes");
			} catch (error) {
				return answered((error as Error).message, "not-asked");
			}
		},
	};

	const personSpoke = () => {
		spoken += 1;
		notNow.personSpoke();
		withdraw(null, ASK_WITHDRAWN_FOR_MESSAGE);
	};
	return {
		tools: [askFolder, askCommands],
		personSpoke,
	};
}
