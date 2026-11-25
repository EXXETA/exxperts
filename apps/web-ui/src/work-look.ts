/**
 * How a room looks while it works: one card per stretch of work (thinking,
 * steps and questions in the order they came), whose rows read as plain
 * sentences and which folds to one line once the answer's text starts.
 * Everything here is built from the steps the page already has: no model is
 * asked for a word of it.
 */
import type { ChatItem } from "./types";
import { ASK_FOLDER, ASK_FOR_COMMANDS_TOOL_NAME, ASK_FOR_FOLDER_TOOL_NAME, ASK_OUTCOME, ASKED_FOR_COMMANDS, ASKED_FOR_FOLDER, type AskOutcome, commandAsShown, type FolderAskAccess, type FolderLasts, pageCardAddress, RUN_OUTSIDE_BOX_TOOL_NAME } from "../../web-server/src/room-box/card-text";
import { commandAborted, commandDeclined, connectorCallRefused, connectorNotRunLine, isCommandStep, lastName, nobodyToApprove, pageNotOpened, stoppedBeforeAnswer, stoppedBeforeAsking } from "./step-lines";
import { approvalAsking, declinedAnswer, splitFencedBrief } from "./components/Approval";
import { connectorApprovalSubject } from "../../web-server/src/room-approval-titles";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;
type ThinkingItem = Extract<ChatItem, { kind: "thinking" }>;

/** What goes into a work card. An empty assistant message (one that never wrote a word) does not end a stretch. */
export function isWorkItem(item: ChatItem): boolean {
	return item.kind === "thinking" || item.kind === "tool" || item.kind === "approval" || (item.kind === "assistant" && !item.text.trim());
}

/** A card's pieces: a thinking row, a step (with the question it asked, when it asked one), or a question no step is known for. */
export type WorkPiece =
	/** `item`, the first thought; `group`, it and the thoughts right after it with nothing shown between (one row). */
	| { kind: "thinking"; item: ThinkingItem; group: ThinkingItem[] }
	| { kind: "step"; item: ToolItem; ask?: ApprovalItem }
	| { kind: "ask"; item: ApprovalItem };

/** The command a command question saved before the run question asks about, as the server wrote it under its fence; null for any other question. */
export function askedCommand(ask: ApprovalItem): string | null {
	const fenced = splitFencedBrief(ask.message) ?? splitFencedBrief(ask.detail);
	return fenced && /command/i.test(fenced.label) ? fenced.brief : null;
}

// The server clips a long command's preview far past this, so the heads of the two always agree.
const COMMAND_HEAD = 200;
const commandHead = (text: string) => text.trim().slice(0, COMMAND_HEAD);

/**
 * The step a question belongs to. The items do not link a question to its
 * step, and the steps of one message are all placed before the first of them
 * asks. A command question names its command: it belongs to the earliest
 * command step with that command that has not asked yet, since the steps of
 * a message are prepared in order. The run question carries its command
 * whole, as shown; one saved before it carries it under its fence, clipped
 * when long. The run-outside question is its step's until a yes. Any other question belongs to the newest
 * step still at work that has not asked; a step the page does not draw (a
 * hand-off) leaves its question a row of its own, never an earlier step's.
 * A room's folder or commands card belongs to the earliest ask step of its
 * kind that has none, and a page card to the earliest page step for its
 * address. A connector question that names its call belongs to that call's
 * step and no other, so two calls at once each keep their own; one saved
 * before questions named their call is placed as any other question.
 */
function askOwner(pieces: WorkPiece[], ask: ApprovalItem): Extract<WorkPiece, { kind: "step" }> | null {
	const command = askedCommand(ask);
	const open = pieces.filter((piece): piece is Extract<WorkPiece, { kind: "step" }> => piece.kind === "step" && !piece.ask);
	// A room's folder or commands card is its ask step's, ended or not: those asks come one at a time, in order.
	const askTool = ask.uiKind === "folder" ? ASK_FOR_FOLDER_TOOL_NAME : ask.uiKind === "commands" ? ASK_FOR_COMMANDS_TOOL_NAME : null;
	if (askTool !== null) return open.find((piece) => piece.item.name === askTool) ?? null;
	// A page card names its address: it is the earliest page step for that address, ended or not.
	if (ask.uiKind === "site" && ask.address !== undefined) return open.find((piece) => piece.item.name === "fetch_url" && pageCardAddress(String(piece.item.args?.url ?? "")) === ask.address) ?? null;
	if (ask.uiKind === "run") return open.find((piece) => piece.item.name === "bash" && commandAsShown(String(piece.item.args?.command ?? "")) === ask.command) ?? null;
	// Asking, or answered no: its step says so. After a yes the step runs, and the question keeps a row of its own, which says it ran outside.
	if (ask.uiKind === "outside") return askOpen(ask) || declinedAnswer(ask.done) ? open.find((piece) => isOutsideAskStep(piece.item, ask)) ?? null : null;
	if (command !== null) return open.find((piece) => isCommandStep(piece.item.name) && commandHead(String(piece.item.args?.command ?? "")) === commandHead(command)) ?? null;
	if (ask.uiKind === "connector" && ask.toolCallId) return open.find((piece) => piece.item.callId === ask.toolCallId) ?? null;
	// A connector's form asks for details, not whether the step may run: its answer never says the step was not done, so it keeps a row of its own.
	if (ask.uiKind === "form") return null;
	const newest = open.at(-1);
	return newest && !isCommandStep(newest.item.name) && (newest.item.status === "writing" || newest.item.status === "running") ? newest : null;
}

/** Whether a run-outside question is this step's: its command, at work or ended by that question's no. A call refused before it asked never takes one. */
function isOutsideAskStep(item: ToolItem, ask: ApprovalItem): boolean {
	if (item.name !== RUN_OUTSIDE_BOX_TOOL_NAME || commandAsShown(String(item.args?.command ?? "")) !== ask.command) return false;
	return item.status === "running" || (!askOpen(ask) && commandDeclined(item.result));
}

/** The pieces of one stretch, each question in the row of the step that asks it, or a row of its own. */
export function workPieces(stretch: ReadonlyArray<ChatItem>): WorkPiece[] {
	const pieces: WorkPiece[] = [];
	for (const item of stretch) {
		if (item.kind === "thinking") {
			const last = pieces[pieces.length - 1];
			if (last?.kind === "thinking") last.group.push(item);
			else pieces.push({ kind: "thinking", item, group: [item] });
		}
		else if (item.kind === "tool") pieces.push({ kind: "step", item });
		else if (item.kind === "approval") {
			const owner = askOwner(pieces, item);
			if (owner) owner.ask = item;
			else pieces.push({ kind: "ask", item });
		}
	}
	// Once a connector step has ended, askOwner no longer gives it its card, as a command's own words do after a
	// reload; with one connector step and one connector card in the stretch, the card can only be that step's.
	// A yes keeps its own row too, so the card still shows it; a No or no answer is said by the step's row.
	const steps = pieces.filter((piece) => piece.kind === "step");
	const asks = pieces.filter((piece) => piece.kind === "ask");
	if (steps.length === 1 && asks.length === 1 && !steps[0].ask && steps[0].item.name === "mcp" && connectorApprovalSubject(asks[0].item.title) !== null) {
		const ask = asks[0].item;
		steps[0].ask = ask;
		if (ask.stopped || ask.unanswered || declinedAnswer(ask.done)) return pieces.filter((piece) => piece.kind !== "ask");
	}
	// A page card that ended with no yes and no step of its own here (its step is in an earlier stretch): the step's row says what came of it.
	return pieces.filter((piece) => !(piece.kind === "ask" && piece.item.uiKind === "site" && piece.item.address !== undefined && (piece.item.stopped || piece.item.unanswered || declinedAnswer(piece.item.done))));
}

/**
 * The newest command still running in the answer under way, as the site
 * question's Running now row shows it, or null when none runs (a job an
 * earlier command left running can reach a site too). A message the room
 * took in while it answered doesn't end the answer. A step reads running from
 * the moment the model has written it, so only one the server said has begun
 * counts, and a command that waits for its own run-outside question has not.
 */
export function commandRunningNow(items: ReadonlyArray<ChatItem>): string | null {
	// A question comes after its step, so the scan back meets it first.
	const askedOutside = new Set<string>();
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "user" && !item.steered) return null;
		if (item.kind === "approval" && item.uiKind === "outside" && askOpen(item)) askedOutside.add(item.command ?? "");
		if (item.kind !== "tool" || !isCommandStep(item.name) || item.status !== "running" || item.startedAt === undefined) continue;
		const command = commandAsShown(String(item.args?.command ?? ""));
		if (!(item.name === RUN_OUTSIDE_BOX_TOOL_NAME && askedOutside.has(command))) return command;
	}
	return null;
}

/** A question still waiting for the person. */
export function askOpen(ask: ApprovalItem | undefined): boolean {
	return !!ask && approvalAsking(ask);
}

/** What a yes to a room's ask gave, as the line under it says it, and its way back. */
export type RoomAskGiven =
	| { kind: "folder"; path: string; name: string; access: FolderAskAccess; lasts: FolderLasts }
	// A pick of a folder the room could already use: nothing new to take back.
	| { kind: "folder-already"; name: string; access: FolderAskAccess }
	| { kind: "commands" };

const lowerFirst = (words: string): string => words.charAt(0).toLowerCase() + words.slice(1);

const ASK_OUTCOMES: ReadonlySet<string> = new Set<AskOutcome>(["yes", "already", "not-now", "nobody", "not-asked"]);

/** Whether a step's details say a room's ask was answered yes: the room's folders or commands changed. */
export function roomAskYes(details: unknown): boolean {
	return !!details && typeof details === "object" && (details as Record<string, unknown>)[ASK_OUTCOME] === "yes";
}

/**
 * What a room's ask came to, from its step's details: its outcome, and on a
 * yes what it gave, for the line under it. Null for any other step, or an
 * ask whose details can't be read.
 */
export function roomAskResult(item: ToolItem): { outcome: AskOutcome; given: RoomAskGiven | null } | null {
	if (item.name !== ASK_FOR_FOLDER_TOOL_NAME && item.name !== ASK_FOR_COMMANDS_TOOL_NAME) return null;
	const details = item.details && typeof item.details === "object" ? item.details : {};
	const outcome = details[ASK_OUTCOME];
	if (typeof outcome !== "string" || !ASK_OUTCOMES.has(outcome)) return null;
	const folder = details[ASK_FOLDER];
	const named = folder && typeof folder.path === "string" && typeof folder.name === "string" && (folder.access === "read" || folder.access === "write") ? { path: folder.path as string, name: folder.name as string, access: folder.access as FolderAskAccess } : null;
	if (outcome === "already" && item.name === ASK_FOR_FOLDER_TOOL_NAME) return { outcome, given: named ? { kind: "folder-already", name: named.name, access: named.access } : null };
	if (outcome !== "yes") return { outcome: outcome as AskOutcome, given: null };
	if (item.name === ASK_FOR_COMMANDS_TOOL_NAME) return { outcome, given: { kind: "commands" } };
	// A pick that doesn't say how long it lasts went on the room's list.
	return { outcome, given: named ? { kind: "folder", ...named, lasts: folder.lasts === "answer" ? "answer" : "room" } : null };
}

/** Where a step stands, as its row shows it. */
export type StepState = "writing" | "asking" | "running" | "done" | "failed" | "denied" | "stopped";

export function stepState(item: ToolItem, ask: ApprovalItem | undefined): StepState {
	if (askOpen(ask)) return "asking";
	// Said no, or Stop answered for the person: not run, even before the step's own result comes back.
	if (ask && item.status !== "done" && (ask.stopped || declinedAnswer(ask.done))) return "denied";
	if (item.status === "writing") return "writing";
	if (item.status === "running") return "running";
	if (item.status === "done") return "done";
	if (item.status === "stopped" || (item.status === "error" && (commandAborted(item.result) || stoppedBeforeAsking(item.result) || stoppedBeforeAnswer(item.result)))) return "stopped";
	if (item.status === "error" && (commandDeclined(item.result) || nobodyToApprove(item.result) || connectorNotRunLine(item) !== null || connectorCallRefused(item) || pageNotOpened(item) !== null)) return "denied";
	return "failed";
}

/** The kind of a step, for its icon and for the folded line. */
export type StepKind = "read" | "write" | "edit" | "command" | "search" | "web" | "page" | "list" | "handoff" | "connector" | "memory" | "skill" | "folder-ask" | "commands-ask" | "other";

export function stepKind(name: string): StepKind {
	switch (name) {
		case "read":
		case "read_file":
		case "artifact_read":
			return "read";
		case "write":
		case "artifact_write":
		case "artifact_write_html_deck":
			return "write";
		case "edit":
			return "edit";
		case "bash":
		case RUN_OUTSIDE_BOX_TOOL_NAME:
			return "command";
		case "grep":
		case "find":
		case "search_file":
		case "kb_search":
			return "search";
		case "web_search":
			return "web";
		case "fetch_url":
			return "page";
		case "ls":
		case "artifact_list":
			return "list";
		case "delegate_task":
			return "handoff";
		case "mcp":
			return "connector";
		case "memory_recall":
			return "memory";
		case "read_skill":
			return "skill";
		case ASK_FOR_FOLDER_TOOL_NAME:
			return "folder-ask";
		case ASK_FOR_COMMANDS_TOOL_NAME:
			return "commands-ask";
		default:
			return "other";
	}
}

const PROGRAMS_WITH_VERBS = new Set(["git", "npm", "pnpm", "yarn", "npx", "node", "python", "python3", "docker", "kubectl", "cargo", "go", "make", "brew", "pip", "pip3", "gh", "dotnet", "mvn", "gradle"]);

/** What a command runs, in a word or two: "git status", "ls", "npm test". The whole command shows when its row is opened. */
function commandName(tokens: ShellToken[]): string {
	// A quote that never closes takes in the rest of the line, so its word is read up to its first space.
	const words = tokens.flatMap((token) => ("op" in token ? [] : [token.unclosed ? token.word.split(/\s/)[0] : token.word])).filter((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word));
	const first = lastName(words[0] ?? "");
	if (!first) return "a command";
	const second = words[1] ?? "";
	return PROGRAMS_WITH_VERBS.has(first) && /^[a-z][\w:-]*$/.test(second) ? `${first} ${second}` : first;
}

/**
 * What a command does, for the common read-only ones the card can say in
 * plain words (on a Mac's or Linux's shell, or Windows' own names for the
 * same); "run" for every other one program; "line" for a command that
 * chains or wraps several things (a pipe, a list, a redirect, a second
 * program inside it, a loop, a script of several lines), which only the
 * command itself says.
 */
export type CommandAction =
	| { kind: "list"; folder: string }
	| { kind: "read"; files: string[] }
	| { kind: "search"; word: string; where: string }
	| { kind: "git-status" }
	| { kind: "git-diff"; file: string }
	| { kind: "git-log" }
	| { kind: "run"; program: string }
	/** `line`: the command's first line after the settings it begins with, with " …" after it when more lines follow. */
	| { kind: "line"; line: string };

type ShellToken = { word: string; unclosed?: boolean } | { op: string };

/**
 * A command line's words with their quotes taken off, and the operators between them. A backslash escapes only a space, a quote or an operator's character, so a Windows path keeps its own.
 * A second program inside double quotes (`"$(date)"`, a backtick) runs as one outside them does, so it is an operator too; in single quotes, or escaped, it is only words.
 */
function shellTokens(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | null = null;
	const endWord = () => {
		if (inWord) tokens.push(quote ? { word, unclosed: true } : { word });
		word = "";
		inWord = false;
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (quote) {
			if (char === quote) quote = null;
			else if (quote === '"' && char === "\\" && /["\\$`]/.test(command[index + 1] ?? "")) word += command[++index];
			else {
				if (quote === '"' && (char === "`" || (char === "$" && command[index + 1] === "("))) tokens.push({ op: char });
				word += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
		} else if (char === "\\" && /[\s'"|;&<>`$]/.test(command[index + 1] ?? "")) {
			word += command[++index];
			inWord = true;
		} else if (/\s/.test(char)) endWord();
		else if (/[|;&<>`]/.test(char) || (char === "$" && command[index + 1] === "(")) {
			endWord();
			const op = /^(&&|\|\||>>|[|;&<>`$])/.exec(command.slice(index))![0];
			tokens.push({ op });
			index += op.length - 1;
		} else {
			word += char;
			inWord = true;
		}
	}
	endWord();
	return tokens;
}

const LIST_PROGRAMS = new Set(["ls", "dir", "gci", "get-childitem", "tree"]);
const READ_PROGRAMS = new Set(["cat", "head", "tail", "less", "more", "bat", "nl", "type", "gc", "get-content"]);
const SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "findstr", "select-string", "sls"]);
// Options that take the next word as their value, so it is neither the word searched for nor a file, by kind of program.
// PowerShell's own options ("-Tail") are matched in any case, a letter option ("-A") only as written.
const VALUE_OPTIONS = {
	list: new Set(["-I", "-L", "-depth", "-filter", "-include", "-exclude"]),
	read: new Set(["-n", "-c", "--lines", "--bytes", "-tail", "-totalcount", "-head", "-first", "-encoding"]),
	search: new Set(["-A", "-B", "-C", "-m", "-g", "-t", "-f", "--max-count", "--glob", "--type", "--include", "--exclude", "--exclude-dir", "--file", "-encoding", "-context"]),
};
const PATTERN_OPTIONS = new Set(["-e", "--regexp", "-pattern"]);
const PATH_OPTIONS = new Set(["-path", "-literalpath"]);

/** The words of a command that are neither options nor an option's value; an option's pattern or path is taken out first. */
function commandOperands(words: string[], valueOptions: ReadonlySet<string>): { operands: string[]; pattern?: string; path?: string } {
	const operands: string[] = [];
	let pattern: string | undefined;
	let path: string | undefined;
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		const option = /^-[A-Za-z]{2,}$/.test(word) ? word.toLowerCase() : word;
		if (PATTERN_OPTIONS.has(option)) pattern ??= words[++index];
		else if (PATH_OPTIONS.has(option)) path ??= words[++index];
		else if (valueOptions.has(option)) index++;
		else if (word === "--") continue;
		else if (/^-/.test(word) && word.length > 1) continue;
		else if (/^\/[a-z?]$/i.test(word)) continue;
		else operands.push(word);
	}
	return { operands, pattern, path };
}

// Far more than a row shows on a desktop, where the row cuts the line with "…"; on a phone the row takes the lines it needs.
const LINE_HEAD = 300;

// A value's variable ("$A", "${A:-b}"); a form that can hold a space or a quote of another kind ("${A:-$(b)}", "$'a b'") is no plain one.
const VARIABLE = String.raw`\$(?:\w|\{[^{}$"'\x60\\()]*\})`;
// A space, or a line that goes on with the next.
const GAP = String.raw`(?:\s|\\\r?\n)`;
// A setting before what runs ("NAME=value", its value plain, quoted or a variable) and the ";", "&&", space or line end after it.
// A value that runs something itself ("$(date)", a backtick) is no plain setting, nor is one an operator or a comment follows.
const SETTING = new RegExp(String.raw`^[A-Za-z_]\w*=(?:'[^']*'|"(?:[^"\\$\x60]|\\[^]|${VARIABLE})*"|\\.|${VARIABLE}|[^\s'"\\$\x60;&|<>()])*(?:${GAP}*(?:;|&&)${GAP}*|${GAP}+|$)(?!${GAP}|[;&|<>#])`);

/** A command from what it runs on, without the settings at its start; nothing but settings stays as it is. */
function withoutSettings(command: string): string {
	let rest = command;
	for (let setting = SETTING.exec(rest); setting; setting = SETTING.exec(rest)) rest = rest.slice(setting[0].length);
	return rest || command;
}

export function commandAction(command: string): CommandAction {
	const whole = command.trim();
	const lines = withoutSettings(whole).split(/\r?\n/);
	// The token reader takes a line break for a space, so a script of several lines is named by its first line before any of its words are read as one program's.
	if (/\n/.test(whole)) return { kind: "line", line: `${lines[0].trimEnd().slice(0, LINE_HEAD)}${lines.length > 1 ? " …" : ""}` };
	let tokens = shellTokens(command);
	// Decided on the whole line, before "cd src &&" is cut: "cd src && npm test" is named by itself, unless plain words below say what it does ("cd src && ls").
	const run: CommandAction = tokens.some((token) => "op" in token) ? { kind: "line", line: lines[0].slice(0, LINE_HEAD) } : { kind: "run", program: commandName(tokens) };
	// "cd src && ls" lists src's folder as much as "ls src" does.
	let cdFolder = "";
	if (tokens.length > 3 && "word" in tokens[0] && tokens[0].word === "cd" && "word" in tokens[1] && "op" in tokens[2] && tokens[2].op === "&&") {
		cdFolder = tokens[1].word;
		tokens = tokens.slice(3);
	}
	if (tokens.some((token) => "op" in token)) return run;
	const words = (tokens as { word: string }[]).map((token) => token.word);
	while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
	const program = lastName(words[0] ?? "").toLowerCase().replace(/\.exe$/, "");
	const rest = words.slice(1);
	if (LIST_PROGRAMS.has(program)) {
		const { operands, path } = commandOperands(rest, VALUE_OPTIONS.list);
		const folder = path ?? operands[0] ?? cdFolder;
		return { kind: "list", folder: folder === "." || folder === "./" ? "" : folder };
	}
	if (READ_PROGRAMS.has(program)) {
		const { operands, path } = commandOperands(rest, VALUE_OPTIONS.read);
		const files = (path ? [path] : operands).filter((word) => !/^[+-]?\d+$/.test(word));
		return files.length ? { kind: "read", files } : run;
	}
	const search = (args: string[]): CommandAction => {
		const { operands, pattern, path } = commandOperands(args, VALUE_OPTIONS.search);
		const word = pattern ?? operands.shift();
		if (!word) return run;
		const where = path ?? operands[0] ?? "";
		return { kind: "search", word, where: where === "." ? "" : where };
	};
	if (SEARCH_PROGRAMS.has(program)) return search(rest);
	if (program === "git") {
		// "git -C repo status": the folder after -C is not the verb.
		const sub = rest.findIndex((word, index) => !word.startsWith("-") && rest[index - 1] !== "-C");
		const verb = rest[sub];
		const after = rest.slice(sub + 1);
		if (verb === "status") return { kind: "git-status" };
		if (verb === "log") return { kind: "git-log" };
		if (verb === "grep") return search(after);
		if (verb === "diff") {
			const { operands } = commandOperands(after, VALUE_OPTIONS.read);
			return { kind: "git-diff", file: operands.find((word) => /[./\\]/.test(word) && !/^[\w.-]+\.\.[\w.-]*$/.test(word)) ?? "" };
		}
	}
	return run;
}

/** The kind a command counts as on the folded line and for its icon: listing a folder counts as listing one. */
export function commandKind(action: CommandAction): StepKind {
	return action.kind === "list" ? "list" : action.kind === "read" ? "read" : action.kind === "search" ? "search" : "command";
}

/** A step's kind, a command's from what it does. */
export function itemKind(item: ToolItem): StepKind {
	// A connector's own tool, called directly, is a connector's step as the `mcp` tool's is: the room names its connector on it.
	if (typeof item.details?.connectorId === "string") return "connector";
	return isCommandStep(item.name) ? commandKind(commandAction(String(item.args?.command ?? ""))) : stepKind(item.name);
}

/**
 * A command's sentence: the verb as a question asks it, while it runs, once
 * done and when it failed, and what it acts on, "Listed src", "Searched the
 * code for “limit”", "Ran npm test"; `code` when the name is the command
 * itself, drawn as the opened row draws a command: "Ran `cd src && npm test`".
 */
export function commandSentence(action: CommandAction): { verbs: [string, string, string, string]; name: string; where?: string; code?: boolean } {
	switch (action.kind) {
		case "list":
			return { verbs: ["List", "Listing", "Listed", "Couldn't list"], name: action.folder ? lastName(action.folder) || action.folder : "the folder" };
		case "read":
			return { verbs: ["Read", "Reading", "Read", "Couldn't read"], name: action.files.length === 1 ? lastName(action.files[0]) : `${action.files.length} files` };
		case "search":
			return { verbs: ["Search the code for", "Searching the code for", "Searched the code for", "Couldn't search the code for"], name: `“${action.word.slice(0, 80)}”`, where: action.where ? lastName(action.where) || action.where : undefined };
		case "git-status":
			return { verbs: ["Check what changed", "Checking what changed", "Checked what changed", "Couldn't check what changed"], name: "" };
		case "git-diff":
			return { verbs: ["Look at the changes in", "Looking at the changes in", "Looked at the changes in", "Couldn't look at the changes in"], name: action.file ? lastName(action.file) : "" };
		case "git-log":
			return { verbs: ["Read the history", "Reading the history", "Read the history", "Couldn't read the history"], name: "" };
		case "run":
			return { verbs: ["Run", "Running", "Ran", "Couldn't run"], name: action.program };
		case "line":
			return { verbs: ["Run", "Running", "Ran", "Couldn't run"], name: action.line, code: true };
	}
}

function countLines(text: string | undefined): number {
	if (!text) return 0;
	const trimmed = text.replace(/\s+$/, "");
	return trimmed ? trimmed.split("\n").length : 0;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** How much a write or the page's copy of it holds: "800 B", "4.2 KB", "12 KB". */
export function sizeText(chars: number): string {
	if (chars < 1024) return `${chars} B`;
	const kb = chars / 1024;
	return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

/** A finished step's result in two or three words: "12 lines", "no matches", "3 results". Empty when there is nothing short to say. */
export function stepResultWords(item: ToolItem): string {
	if (item.status !== "done") return "";
	const kind = stepKind(item.name);
	const result = typeof item.result === "string" ? item.result : "";
	if (kind === "read" && item.name !== "artifact_read") return result ? plural(countLines(result), "line", "lines") : "";
	if (item.name === "write") {
		const content = typeof item.args?.content === "string" ? item.args.content : "";
		return content ? sizeText(content.length) : "";
	}
	if (item.name === "edit") {
		const edits = /^Successfully replaced (\d+) block\(s\)/.exec(result);
		return edits ? plural(Number(edits[1]), "change", "changes") : "";
	}
	if (item.name === "grep" || item.name === "search_file") {
		if (!result.trim() || /^No matches found/i.test(result)) return "no matches";
		return plural(countLines(result), "match", "matches");
	}
	if (item.name === "find" || item.name === "ls") {
		if (!result.trim() || /^No files found|^\(empty directory\)/i.test(result)) return "none";
		return plural(countLines(result), item.name === "ls" ? "entry" : "file", item.name === "ls" ? "entries" : "files");
	}
	if (isCommandStep(item.name)) {
		const lines = countLines(result);
		return lines ? plural(lines, "line", "lines") : "no output";
	}
	return "";
}

/** How long a finished step took, when both its ends are known. */
export function stepTime(item: ToolItem): string {
	if (item.startedAt === undefined || item.endedAt === undefined || item.endedAt < item.startedAt) return "";
	return tookText(item.endedAt - item.startedAt);
}

/** A step's or a thought's own time. A file read often ends within a few milliseconds, and "0.0 s" reads as no time at all. */
export function tookText(ms: number): string {
	return ms < 50 ? "<0.1 s" : durationText(ms);
}

/** "0.4 s", "3.4 s", "12 s", "1 min 12 s". */
export function durationText(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)} s`;
	const whole = Math.round(seconds);
	return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

const KIND_PHRASES: Record<StepKind, (count: number) => string> = {
	read: (n) => (n === 1 ? "read a file" : `read ${n} files`),
	write: (n) => (n === 1 ? "wrote a file" : `wrote ${n} files`),
	edit: (n) => (n === 1 ? "edited a file" : `edited ${n} files`),
	command: (n) => (n === 1 ? "ran a command" : `ran ${n} commands`),
	search: (n) => (n === 1 ? "searched once" : `searched ${n} times`),
	web: (n) => (n === 1 ? "searched the web" : `searched the web ${n} times`),
	page: (n) => (n === 1 ? "read a page" : `read ${n} pages`),
	list: (n) => (n === 1 ? "listed a folder" : `listed ${n} folders`),
	handoff: (n) => (n === 1 ? "handed off a task" : `handed off ${n} tasks`),
	connector: (n) => (n === 1 ? "used a connector" : `used a connector ${n} times`),
	memory: (n) => (n === 1 ? "searched memory" : `searched memory ${n} times`),
	skill: (n) => (n === 1 ? "read a skill" : `read ${n} skills`),
	"folder-ask": (n) => (n === 1 ? lowerFirst(ASKED_FOR_FOLDER) : `${lowerFirst(ASKED_FOR_FOLDER)} ${n} times`),
	"commands-ask": (n) => (n === 1 ? lowerFirst(ASKED_FOR_COMMANDS) : `${lowerFirst(ASKED_FOR_COMMANDS)} ${n} times`),
	other: (n) => (n === 1 ? "used a tool" : `used ${n} tools`),
};

/**
 * The folded line's words, from the steps alone: "Read 2 files, searched
 * once", at most three kinds and then "and 2 more", with what did not work
 * after it. A card whose one step searched the web names what it searched for.
 */
export function foldedWords(steps: ReadonlyArray<{ item: ToolItem; ask?: ApprovalItem }>): string {
	// A card whose one step searched the web says what for, as that step's row does.
	const [only] = steps;
	const query = steps.length === 1 && itemKind(only.item) === "web" && stepState(only.item, only.ask) === "done" ? String(only.item.args?.query ?? "").trim().slice(0, 120) : "";
	if (query) return `Searched the web for ${query}`;
	const counts = new Map<StepKind, number>();
	let failed = 0;
	let stopped = 0;
	let notRun = 0;
	for (const step of steps) {
		const state = stepState(step.item, step.ask);
		if (state === "failed") failed++;
		else if (state === "stopped") stopped++;
		else if (state === "denied") notRun++;
		else counts.set(itemKind(step.item), (counts.get(itemKind(step.item)) ?? 0) + 1);
	}
	const phrases = [...counts.entries()].map(([kind, count]) => KIND_PHRASES[kind](count));
	const words = phrases.length <= 3 ? phrases.join(", ") : `${phrases.slice(0, 3).join(", ")} and ${phrases.length - 3} more`;
	const ends = ([[failed, "failed"], [stopped, "stopped"], [notRun, "not run"]] as const).filter(([count]) => count > 0);
	const tail = ends.map(([count, end]) => `${count} ${end}`).join(", ");
	// With nothing done and nothing failed, the first count says that it counts steps.
	const alone = failed ? tail : ends.map(([count, end], at) => `${at === 0 ? plural(count, "step", "steps") : count} ${end}`).join(", ");
	const all = words && tail ? `${words} · ${tail}` : words || alone || "worked";
	return all.charAt(0).toUpperCase() + all.slice(1);
}
