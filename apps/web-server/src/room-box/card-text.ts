/**
 * What the box's cards say, and how a command is drawn on the outside card. No
 * imports: the page reads this file too, so the server and the page can't differ.
 */

export const RUN_OUTSIDE_BOX_TOOL_NAME = "run_outside_box";

export const SITE_CARD_RISK_LINE = "Anything commands can read in this room could be sent there.";
export const SITE_ALLOW_ONCE = "Allow this time";
export const SITE_ALLOW_ROOM = "Allow for this room";
export const CARD_DECLINE = "Decline";
export const WAITING_AT_COMPUTER = "Waiting at the computer";
export const OUTSIDE_CARD_LINE = "This runs outside this room, with all your rights.";
export const OUTSIDE_RUN_ONCE = "Run once";
export const OUTSIDE_REASON_LABEL = "The model's reason, in its own words:";
/** "Run this command?" names the folder its command runs in under this label. */
export const RUNS_IN = "Runs in";
/** The one line a person and the model read when the box didn't start. A command never runs bare instead. */
export const BOX_FAULT_SENTENCE = "Commands can't run because this room's protection didn't start. Try restarting exxperts. If that doesn't help, check for an update.";

/** What the model reads when the box refuses a place no yes can open, such as the person's keys or a local address, so it doesn't send the person to the way out for it. "Just to get at it": a task that needs the person's own login, as git push over SSH, is still the way out's. A clause, for the end of a refusal. */
export const CLOSED_ON_PURPOSE = `this room keeps it closed on purpose and no yes opens it, so don't offer ${RUN_OUTSIDE_BOX_TOOL_NAME} just to get at it unless the person asks`;

/**
 * A room's mode for its commands, keyed by its name on screen. The stored words
 * are older (persistent-room-bash-settings.ts): in a protected room a yes is
 * Semi and `free` is Auto; without protection a yes is Auto, and there is
 * no Semi. The settings route says the same: `autoApprove` for any mode but
 * Ask, `free` for Auto in a protected room.
 */
export type CommandMode = "ask" | "semi" | "auto";
export const MODE_NAMES: Record<CommandMode, string> = { ask: "Ask", semi: "Semi", auto: "Auto" };
/** The mode a read of the room's settings names, in the protection it was read in. */
export const commandModeOf = (settings: { autoApprove: boolean; free?: boolean }, roomProtected: boolean): CommandMode =>
	settings.free === true ? "auto" : !settings.autoApprove ? "ask" : roomProtected ? "semi" : "auto";

/** What the model reads when a room on Auto refused a site whose name leads to the person's own network. A clause, for the end of a refusal; it names the modes as the person sees them, never where they are changed. */
export const FREE_PRIVATE_REFUSAL = `this site is on the person's own network, and a room on ${MODE_NAMES.auto} reaches public websites only; on ${MODE_NAMES.semi} it can be reached after their yes`;

// "A command": the app can't tell which command reached for the site.
export const siteCardQuestion = (host: string): string => `A command wants to reach ${host}.`;
/** The site question's row with the command running when it asks: the newest one, which may not be the one that reached for the site. */
export const RUNNING_NOW = "Running now";
/** The page question's row with the whole address. */
export const ADDRESS = "Address";
// The room's web reader asks before it opens an address the person didn't give.
export const pageCardQuestion = (host: string): string => `This room wants to open a page on ${host}.`;
export const PAGE_CARD_LINE = "This address didn't come from you. Anything in it goes to that site.";
/** Under the page card's line where Allow for this room is offered: that yes goes on the list commands read too. */
export const PAGE_CARD_ROOM_LINE = "Allow for this room also lets its commands reach that site.";
/** Under the page card's line, but not on a shared server: a yes this time covers the site's other pages until the answer ends. */
export const PAGE_CARD_ONCE_LINE = "Allow this time covers that site's pages for this answer.";
/** The page card's lines: the second says what each yes it offers covers. A shared server's yes opens that one page, and its rooms run no commands. */
export const pageCardLines = (lasting: boolean, sharedServer: boolean): string[] =>
	sharedServer ? [PAGE_CARD_LINE] : [PAGE_CARD_LINE, lasting ? `${PAGE_CARD_ONCE_LINE} ${PAGE_CARD_ROOM_LINE}` : PAGE_CARD_ONCE_LINE];
/** What the model reads when a page needed a yes and nobody was there to give it; the step row says it as a page not opened. */
export const NOBODY_TO_OPEN_PAGE = "Nobody is here to allow this address, so it was not opened. An address the person gave or a search result opens without them.";
export const PAGE_DECLINED = "The person declined opening this address.";
/** The address a page card shows for a `fetch_url` call's url: its fragment cut, as the web reader judges it, and hidden characters written out. Null for what isn't an address. */
export function pageCardAddress(raw: string): string | null {
	try {
		const url = new URL(raw.trim());
		url.hash = "";
		return commandAsShown(url.toString());
	} catch {
		return null;
	}
}

/** What the model reads about git in the box, in the standing line and in the line for a refused change in the room: a commit or a clone needs the way out. */
export const BOX_GIT_CLAUSE = `commands can read git's own folders but can't change them or make a new repository, so a commit, a clone or git init needs ${RUN_OUTSIDE_BOX_TOOL_NAME}`;

/** The room's list as the model reads it, beside the box's line. */
export type AlsoAllowedForModel = { folders: readonly { path: string; access: string }[]; sites: readonly { host: string; port: number }[] };

/** In the box's line for the model, on a Mac and on Windows: the person answers the app's questions, which the model never sees. */
export const ALLOW_WHEN_ASKED = "The person can allow a folder or a site when the app asks them.";
/** The same in a room on Auto, where no site asks. */
export const ALLOW_FOLDER_WHEN_ASKED = "The person can allow a folder when the app asks them.";

/** What the box's line says of sites, on a Mac and on Windows: a clause, after what commands can't do with files. */
export const boxSitesClause = (free: boolean): string =>
	free ? "and they reach public websites without the person's yes, but not this computer's own addresses, raw addresses or sites on the person's own network" : "and a site needs the person's yes";

/** What the model reads each answer in a room on Auto, beside the box's line: the web reader's own rule. */
export const FREE_READER_LINE = "\n\nIn this room fetch_url opens a public address without asking the person; addresses on this computer or on the person's own network stay closed.";

/**
 * The end of the box's line for the model: the room's list as it stands. An
 * empty list is said in words: a line that is just gone reads as nothing
 * changed, and the model went on naming a site the person had removed.
 */
export function alsoAllowedSentence(alsoAllowed: AlsoAllowedForModel): string {
	const places = [...alsoAllowed.folders.map((folder) => `${folder.path} (${folder.access === "write" ? "read and change" : "read"})`), ...alsoAllowed.sites.map((site) => `${site.host}:${site.port}`)];
	return ` Also allowed in this room: ${places.length ? places.join(", ") : "none"}.`;
}

/**
 * In the box's line for the model on a Mac, where each kind of file goes: a
 * command's TMPDIR is the turn's private temp, emptied when the turn ends, the
 * shared temp folders are closed, and pip installs into the room's caches
 * (boxEnvironment in box-rules.ts).
 */
export const BOX_FILE_HOMES_LINE = "Only what the person asked for goes into the room's folder. Helper scripts and other temporary files go under $TMPDIR, which is emptied after this answer; /tmp is closed. A library you install with pip is kept for this room.";

/**
 * What the model is told each answer: what the box refuses, and the room's list as
 * it stands. `asks`: the room's folder ask is offered, so a failure that may be
 * the box's sends the model to it first. `free`: the answer reaches public websites without asking.
 */
export function boxModelLine(alsoAllowed: AlsoAllowedForModel, asks: boolean, free = false): string {
	const askFirst = asks ? ` If a command fails or gives nothing useful and may have touched a place outside the room's folder, call ${ASK_FOR_FOLDER_TOOL_NAME} for that place first.` : "";
	return `\n\nCommands run inside this room's protection: outside the room's folder they can't change files, they can't read the person's other files or keys, ${BOX_GIT_CLAUSE}, ${boxSitesClause(free)}, so a command that fails oddly may have been refused. ${BOX_FILE_HOMES_LINE} ${free ? ALLOW_FOLDER_WHEN_ASKED : ALLOW_WHEN_ASKED}${askFirst}${alsoAllowedSentence(alsoAllowed)}`;
}

/** Where the room's folder ask isn't offered (a phone, nobody there), nothing waits for the person: they ask again from the computer, where the ask is. */
export const ASK_AGAIN_FROM_COMPUTER = "the person can ask again from the computer and allow it there";

/**
 * What the model reads after a boxed command that prints the refusal's words
 * ("Operation not permitted" on a Mac, "Access is denied" on Windows), or that
 * exits non-zero or times out with no output at all: the box may have refused a
 * place. A failure that says why in other words gets none. `asks`: the room's
 * folder ask is offered with someone there to answer it.
 */
export const boxRefusedLine = (asks: boolean): string =>
	`The room's protection may have refused a place outside the room's folder. ${asks ? `If this command needed one, call ${ASK_FOR_FOLDER_TOOL_NAME} with access read or change so the person can pick it.` : `If this command needed one, say which place it was: ${ASK_AGAIN_FROM_COMPUTER}.`}`;

/** What follows a file tool's refused write into a folder the room can only read; `asks` as for boxRefusedLine. */
export const readOnlyNextLine = (asks: boolean): string =>
	asks ? `Call ${ASK_FOR_FOLDER_TOOL_NAME} with access change so the person can allow it.` : `Tell the person: ${ASK_AGAIN_FROM_COMPUTER}.`;

export const ASK_FOR_FOLDER_TOOL_NAME = "ask_for_folder";
export const ASK_FOR_COMMANDS_TOOL_NAME = "ask_for_commands";

/** What a folder ask asks for: the person's word for it on the card, `change`, is `write` on the room's list. */
export type FolderAskAccess = "read" | "write";
/** How long a yes on a folder card lasts: until the room finishes answering the current message, or on the room's list. */
export type FolderLasts = "answer" | "room";

// The room asks for a folder.
/** The cards a room asks with, by their question kind: the turn waits on them across a move to another device, a phone sees them without the room's reason, only the computer answers, and their reason is never saved. */
export const ROOM_ASK_KINDS: ReadonlySet<string> = new Set(["folder", "commands"]);
export const ROOM_SAYS_LABEL = "The room says:";
export const NOT_NOW = "Not now";
export const ALLOW_THIS_TIME_PICK = "Allow this time";
export const ALLOW_FOR_ROOM_PICK = "Allow for this room";
/**
 * What the folder panel's presses send. Allow this time gives the folder the
 * panel shows; Allow for this room gives it, or opens the window at the room's
 * suggestion, or with nothing shown opens the window and gives the pick; Choose
 * folder opens the window and the panel shows the pick. The page never sends a
 * path: the server gives only what it holds.
 */
export const FOLDER_PANEL_PRESSES = { thisTime: "allow-this-time", room: "choose", choose: "choose-folder" } as const;
export type FolderPanelPress = (typeof FOLDER_PANEL_PRESSES)[keyof typeof FOLDER_PANEL_PRESSES];
/**
 * A yes, or a folder card's window press, that reaches the server sooner than
 * this after the card was last sent, or after the previous answer, gives
 * nothing: the card is asked again. Shorter than the panel's own pause, whose
 * clock starts later, when the page shows the card.
 */
export const ANSWER_FLOOR_MS = 700;
export const REMOVE = "Remove";
/** Right after Remove, with Undo: the folder itself is untouched. */
export const folderRemovedLine = (name: string): string => `${name} is no longer on this room's list. The folder stays on your computer.`;
export const DISMISS = "Dismiss";
export const WAITING_FOR_OK = "Waiting for your OK";
/** The panel above the message box that shows the room's folder, commands, site, run and run-outside questions, as a screen reader names it. */
export const ASK_PANEL_NAME = "The room's question";
/** Under the room's question when more wait behind it. */
export const moreQuestionsLine = (count: number): string => (count === 1 ? "1 more question waiting" : `${count} more questions waiting`);
/** The desktop notification's title, and what a screen reader hears when a question appears. */
export const roomNeedsAnswer = (room: string): string => `${room} needs your answer`;
export const SENDING_COUNTS_AS_NOT_NOW = "Sending a message counts as Not now.";
export const SENDING_ENDS_QUESTION = "Sending ends this question.";
export const folderAskTitle = (roomHasFolder: boolean): string => (roomHasFolder ? "This room needs access to another folder." : "This room needs access to a folder.");
/** What a yes on a folder card gives: `chosen` where the yes opens the folder window, `named` where it gives the folder the card names. */
export const folderAskLine = (access: FolderAskAccess, folder: "chosen" | "named" = "chosen"): string => {
	const where = folder === "named" ? "this folder" : "the folder you choose";
	return access === "write" ? `It will be able to read and change the files in ${where}. It gets no other access.` : `It will be able to read the files in ${where}. It gets no other access.`;
};
export const folderPickedLine = (access: FolderAskAccess, name: string): string => (access === "write" ? `This room can now read and change files in ${name}.` : `This room can now read files in ${name}.`);
/** Under a yes for this answer only: `running` while the answer that gave it goes on, and in the past once it has ended. */
export const folderPickedThisTimeLine = (access: FolderAskAccess, name: string, running: boolean): string =>
	running
		? access === "write" ? `This room can read and change files in ${name} while it answers this message.` : `This room can read files in ${name} while it answers this message.`
		: access === "write" ? `This room could read and change files in ${name} while it answered this message.` : `This room could read files in ${name} while it answered this message.`;
export const folderAlreadyLine = (access: FolderAskAccess, name: string): string => (access === "write" ? `This room can already read and change files in ${name}.` : `This room can already read files in ${name}.`);
/** In the folder question's panel, whose own button offers another folder. */
export const FOLDER_PICK_REFUSED_IN_PANEL = "This room can't use that folder.";
/** Where nothing beside the line offers another folder, as in Room settings' Add a folder. */
export const FOLDER_PICK_REFUSED = `${FOLDER_PICK_REFUSED_IN_PANEL} Choose another one.`;
/** Allow for this room… on a folder inside one this answer was given to change: the room has it now, and only the list can't take it while that lasts. */
export const folderUsableThisTimeLine = (name: string): string => `This room can already use ${name} while it answers this message. You can allow it for this room in Room settings after that.`;
/** A pick in Room settings the list already covers, with whatever access. */
export const FOLDER_ALREADY_USED = "This room can already use that folder.";
export const folderHoldsRoomLine = (name: string): string => `This room can't use ${name}, because this room's folder is inside it. Choose a folder inside ${name}.`;
export const NO_FOLDER_WINDOW = "This computer can't open a folder window.";
export const FOLDER_WINDOW_CLOSED = "The folder window closed before you chose a folder. Try again.";
/** The folder card has two Allow buttons and no Choose a folder…. */
export const FOLDER_CARD_WINDOW_CLOSED = "The folder window closed before you chose a folder. Try again.";
/** A folder the panel names before it is given: its real name and path as shown, and whether Allow this time is offered. */
export type SuggestedFolder = { name: string; path: string; once: boolean };
/** At the end of the panel's Folder row where one click is offered: the folder window, whose pick the panel then shows. */
export const CHOOSE_ANOTHER_FOLDER = "Choose another folder";
/** A real path as the panel's Folder row shows it: whole on Windows; elsewhere from `~` inside the home. */
export function pathAsShown(real: string, home: string, windows: boolean): string {
	if (windows || home === "") return real;
	if (real === home) return "~";
	const below = home.endsWith("/") ? home : `${home}/`;
	return real.startsWith(below) ? `~/${real.slice(below.length)}` : real;
}

/** Room settings' button on a folder the room can only read. */
export const ALLOW_CHANGES = "Allow changes";
export const UNDO = "Undo";

// The line above the message box in a room whose saved folder is one no room may use: its files and commands stop there.
export const ROOM_FOLDER_REFUSED_LINE = "This room can't use its folder. Choose another one.";

// The line above the message box in a room with no folder: with none, there is nowhere for commands to work, so they aren't offered.
export const NO_FOLDER_LINE = "Choose a folder so this room can work with your files and run commands.";
export const CHOOSE_FOLDER = "Choose folder";
/** The no-folder line when the computer's folder window failed: the button tries again. */
export const FOLDER_CHOOSE_FAILED = "Couldn't choose a folder. Try again.";
/** The Folder page's Location button where the room's folder is there: choosing one replaces it. */
export const CHANGE_FOLDER = "Change folder";
/** A folder button while the folder window is open. */
export const CHOOSING = "Choosing";

// The room asks to turn on commands.
export const COMMANDS_ASK_TITLE = "Allow this room to run commands?";
export type CommandsAskLine = "in-box" | "in-box-read-only" | "no-box" | "unprotected";
/** What commands can reach inside the room's protection, as the card says it: true on a Mac and on Windows alike. */
export const COMMANDS_ASK_REACH = "It can open only files in this room's folders and reach only the sites you allow, until you turn this off in Room settings.";
export const COMMANDS_ASK_LINES: Record<CommandsAskLine, string> = {
	"in-box": `${COMMANDS_ASK_REACH} Commands can change or delete the files this room can change.`,
	"in-box-read-only": `${COMMANDS_ASK_REACH} This room can't change files, so its commands can't either.`,
	"no-box": "On this computer, commands can reach, change or delete any of your files, not just this room's.",
	/** A room whose protection the person turned off, or whose folder is why it can't run. */
	"unprotected": "In this room, commands can reach, change or delete any of your files, not just this room's.",
};
export const TURN_ON_COMMANDS = "Turn on commands";
export const TURN_ON_ANYWAY = "Turn on anyway";
export const COMMANDS_ON_LINE = "Commands are on in this room.";
/** After Turn off: the Commands switch in Room settings is the way back, so the line names it and has no button. */
export const COMMANDS_OFF_LINE = "Commands are off in this room. You can turn them on in Room settings, Folder.";
export const TURN_OFF = "Turn off";

// A room's protection: the Folder pane's switch and its confirms.
export const PROTECTION = "Protection";
export const CANCEL = "Cancel";
export const TURN_OFF_PROTECTION_TITLE = "Turn off protection for this room?";
export const TURN_OFF_PROTECTION_BODY = "Commands will be able to access any files you have access to.";
/** The same question while the room's Commands switch is off: nothing runs until it is turned on. */
export const TURN_OFF_PROTECTION_BODY_COMMANDS_OFF = "If you turn commands on later, they will be able to access any files you have access to.";
/** Asked once at the computer before a protected room goes on Auto; leaving it asks nothing. */
export const FREE_CONFIRM_TITLE = "Let this room reach public websites without asking?";
export const FREE_CONFIRM_BODY = "Anything this room can read or remembers could be sent to a website, also while a scheduled task runs.";
export const ALLOW = "Allow";
/** Asked before a room without protection goes on Auto, which is Auto's own question there too: its pages open without asking as well. */
export const RUN_WITHOUT_ASKING_TITLE = "Run commands without asking?";
export const RUN_WITHOUT_ASKING_BODY = "Protection is off. On Auto, commands can change or delete any of your files and send anything this room can read to a website, without asking you.";
export const RUN_WITHOUT_ASKING = "Run without asking";
// The chip's modes for a room's commands: each item a name and one line, and one line under them.
/** Auto's line, with or without protection. */
const AUTO_LINE = "Runs commands and reaches public websites without asking.";
/** In a protected room, where a new website asks unless the room is on Auto. */
export const MODE_LINES_PROTECTED: Record<CommandMode, string> = {
	ask: "Asks before each command and each new website.",
	semi: "Runs commands without asking. Asks before a new website.",
	auto: AUTO_LINE,
};
/** Under the protected room's modes on a phone: there nobody at the computer can say yes, so a command that needs anything outside is refused. */
export const MODES_PROTECTED_STAY_LINE = "In every mode, commands stay in this room's folders.";
/** Under the protected room's modes at the computer: in each, the folder question and Run once ask before a command reaches outside the room's folders. */
export const MODES_PROTECTED_LINE = `${MODES_PROTECTED_STAY_LINE} If they need anything outside, they ask you first.`;
/** In a room without protection, which has no Semi, since its commands reach any site without asking there; the line under them is the Folder page's Commands line for that room. */
export const MODE_LINES_UNPROTECTED: Record<"ask" | "auto", string> = {
	ask: "Asks before each command.",
	auto: AUTO_LINE,
};
/** Where protection can't work, by its cause: this computer, the room's folder, or not known. */
export const PROTECTION_UNAVAILABLE_COMPUTER = "Protection isn't available on this computer.";
export const PROTECTION_UNAVAILABLE_FOLDER = "Protection isn't available for this folder.";
export const PROTECTION_UNAVAILABLE = "Protection isn't available for this room.";

// The steps row for an ask: what it asked, and Not now as her choice, never as a failure.
export const ASKED_FOR_FOLDER = "Asked for a folder";
export const ASKED_FOR_COMMANDS = "Asked to run commands";
/** What an ask's result says it came to, in its details, for the steps row: a Not now is her choice, never a failure. */
export type AskOutcome = "yes" | "already" | "not-now" | "nobody" | "not-asked";
export const ASK_OUTCOME = "askOutcome";
/** The folder a yes gave, for the line after it and its Remove: the person's own pick, never the model's words. With no `lasts`, it went on the room's list. */
export const ASK_FOLDER = "askFolder";
export type AskFolder = { path: string; name: string; access: FolderAskAccess; lasts?: FolderLasts };

/** A reason as a card draws it: one line, every hidden character written out, cut at a length a card can hold. */
export const REASON_MAX_CHARS = 300;
export function reasonAsShown(reason: string): string {
	const shown = commandAsShown(reason).replace(/[\t\n]/g, (hidden) => `⟦U+${(hidden.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟧`);
	return shown.length > REASON_MAX_CHARS ? `${shown.slice(0, REASON_MAX_CHARS - 1)}…` : shown;
}

/** Longer than this and the outside card refuses the command: nobody reads it all. */
export const OUTSIDE_COMMAND_MAX_CHARS = 8_000;
/** How long Run once stays inactive after the question has stopped moving. */
export const OUTSIDE_RUN_DELAY_MS = 1_500;

// Control characters, line and paragraph separators, bidi controls and every
// zero-width or tag character: what can make text read as something it isn't.
const HIDDEN_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]|\udb40[\udc00-\udfff]/g;

/** A command as the outside card draws it: every hidden character written out, line ends and tabs kept. */
export function commandAsShown(command: string): string {
	return command.replace(HIDDEN_CHARACTER, (hidden) => `⟦U+${(hidden.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟧`);
}

/** Whether a path holds what a card can't draw honestly. A command keeps its line ends and tabs; in a path they only push a card's words apart. */
export function pathHoldsHidden(target: string): boolean {
	return /[\t\n]/.test(target) || commandAsShown(target) !== target;
}

// The room's list, in Room settings' Folder pane.
export const ALSO_ALLOWED = "Also allowed";
export const ALSO_ALLOWED_LINE = "Other folders and sites this room can use.";
export const ADD_A_FOLDER = "Add a folder";
export const CAN_READ = "Can read";
export const CAN_READ_AND_CHANGE = "Can read and change";
export const SITE = "Site";
export const CHANGEABLE_AT_COMPUTER = "Changeable at the computer only";
export const NO_OTHER_FOLDERS_OR_SITES = "No other folders or sites.";
export const CHANGE_SAVE_FAILED = "Couldn't save this change. Try again.";
/** The list itself couldn't be read, with Try again beside it. */
export const ALSO_ALLOWED_LOAD_FAILED = "Couldn't load what else this room may use.";
/** The cross at a row's right edge, read by its tooltip and by a screen reader. */
export const REMOVE_FROM_LIST = "Remove from this room's list";
/** A Can read and change row's one button, back to Can read. */
export const ONLY_ALLOW_READING = "Only allow reading";
/** Right after a site's cross, with Undo. */
export const siteRemovedLine = (host: string): string => `${host} is no longer on this room's list.`;
/** Right after the cross on a Can read and change row inside a Can read one: reading stays. */
export const folderStillReadLine = (name: string, through: string): string => `${name} is back to Can read, because it's inside ${through}.`;

// The Folder pane: Location, Can change files, Commands, the Protection switch and Also allowed, each saved on its click.
export const FOLDER_PANE_TITLE = "Folder";
export const FOLDER_PANE_LINE = "The folder this room works in, and what it may do there.";
export const LOCATION = "Location";
export const NO_FOLDER_YET = "No folder yet";
export const NO_FOLDER_YET_LINE = "Choose a room folder to unlock work.";
export const FOLDER_NOT_FOUND = "This folder was not found on this computer.";
export const NOT_FOUND = "Not found";
/** Where the computer can't open its folder window: the path is typed instead. */
export const TYPE_THE_PATH = "This computer can't open a folder window. Type or paste the folder's full path instead.";
export const USE_THIS_FOLDER = "Use this folder";
export const typedPathExample = (windows: boolean): string => (windows ? "For example C:\\Users\\Ana\\Documents\\Sales" : "For example /Users/ana/Documents/Sales");
export const FOLDER_SAVE_FAILED = "Couldn't save the folder. Try again.";
/** The cross at Location's right edge, and its question. */
export const STOP_USING_FOLDER = "Stop using this folder";
export const stopUsingFolderTitle = (name: string): string => `Stop using the ${name} folder in this room?`;
export const STOP_USING_FOLDER_BODY = "The folder and its files stay where they are. You can choose it again, or another folder, at any time.";
export const STOP_USING = "Stop using";
/** After Stop using, for a screen reader alone: the row's line already says the room has no folder. */
export const FOLDER_REMOVED = "Folder removed.";
export const CAN_CHANGE_FILES = "Can change files";
/** Can change files' line for each position. Off, it says only what is true where the room's commands stand: inside protection they read only too; outside it they still change files; where this computer holds them off, there are none. */
export const CAN_CHANGE_FILES_ON_LINE = "The room and its commands can change files.";
export const CAN_CHANGE_FILES_OFF_LINE = "The room and its commands can only read files.";
export const CAN_CHANGE_FILES_OFF_UNPROTECTED_LINE = "The room can only read files, but its commands can still change them.";
export const CAN_CHANGE_FILES_OFF_NO_COMMANDS_LINE = "The room can only read files.";
export const COMMANDS = "Commands";
/** The Commands line inside the room's protection, whether or not Can change files is on. */
export const COMMANDS_PROTECTED_REACH = "Commands can open only files in this room's folders and reach only the sites you allow.";
/** The Commands line inside the room's protection in a room on Auto. */
export const COMMANDS_FREE_REACH = "Commands can open only files in this room's folders and reach public websites without asking.";
/** The Commands line where the person turned protection off, or the folder is why it can't work. */
export const COMMANDS_UNPROTECTED_REACH = "In this room, commands can reach and change any of your files, not just this room's.";
/** The Commands line on a computer that can't protect, with Can change files on. */
export const COMMANDS_NO_PROTECTION_REACH = "On this computer, commands can reach and change any of your files, not just this room's.";
/** On a computer with no protection, Can change files off: the switch shows off and greyed. */
export const COMMANDS_NEED_CHANGES_LINE = "On this computer, commands can change files, so they work only while Can change files is on.";
/** The Protection row's line where protection can work, on or turned off by the person. */
export const PROTECTION_LINE = "Keeps commands inside this room's folders.";
/** Where it can't, the row says only its cause: the row's label names Protection. A line with no label above it keeps the full sentence (PROTECTION_UNAVAILABLE and its neighbours). */
export const PROTECTION_ROW_UNAVAILABLE_COMPUTER = "Not available on this computer.";
export const PROTECTION_ROW_UNAVAILABLE_FOLDER = "Not available for this folder.";
export const PROTECTION_ROW_UNAVAILABLE = "Not available for this room.";
export const ROOM_ANSWERING_CHANGE_LINE = "Change this when the room finishes answering.";
export const FOLDER_LOAD_FAILED = "Couldn't load this room's folder.";
export const TRY_AGAIN = "Try again";
/** For a screen reader alone: the control's new place says it on screen. */
export const SAVED = "Saved";
export const FOLDER_REMOVED_NONE = "This room had no folder saved.";
export const FOLDER_CLEAR_FAILED = "Couldn't clear the folder. Try again.";
export const NO_FOLDER = "No folder";
export const SHARED_SERVER_NO_FOLDER = "On a shared server, rooms don't use a folder.";
export const ROOM_NEEDS_ATTENTION = "This room needs attention before its folder can be changed.";
export const CREATE_ROOM_FIRST = "Create this room before choosing its folder.";
export const LOADING = "Loading…";
