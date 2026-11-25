import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { ChatItem } from "../types";
import type { ApprovalPreviewData } from "../approval-preview";
import { approvalPreviewFromItem } from "../approval-preview";
import { isThoughtOpen } from "../thinking-text-store";
import { boxFault, commandDeclined, connectorCallEndedLine, connectorCallRefused, connectorFailedLine, connectorNotRunLine, inputRefusedByRuntime, isCommandStep, lastName, nobodyToApprove, pageNotOpened, readableToolName, stepOutcome } from "../step-lines";
import { MEMORY_RECALL_STEP, memoryRecallDisplayText } from "../memory-recall-display";
import { useRemoteClientContext } from "../remote-client-context";
import { isMacPlatform } from "../platform";
import { messageDeclinesQuestion, useComposerEmpty, useDraftStartedAt, useEnterReachesQuestion } from "../question-keys";
import { askedCommand, askOpen, commandAction, commandSentence, durationText, foldedWords, itemKind, roomAskResult, sizeText, stepResultWords, stepState, stepTime, workPieces, type RoomAskGiven, type StepKind, type StepState, type WorkPiece } from "../work-look";
import { approvalMetadata, composerTextarea, confirmApprovalLabels, declinedAnswer, splitFencedBrief } from "./Approval";
import { CONNECTOR_CHOICE_WORDS, connectorApprovalSubject, handOffApprovalSubject, SPECIALISTS_OFF_SENTENCE } from "../../../web-server/src/room-approval-titles";
import { ASK_FOR_COMMANDS_TOOL_NAME, ASK_FOR_FOLDER_TOOL_NAME, ASKED_FOR_COMMANDS, ASKED_FOR_FOLDER, commandAsShown, NOT_NOW, onlyAskerAnswers, RUN_OUTSIDE_BOX_TOOL_NAME, SITE_ALLOW_ONCE, SITE_ALLOW_ROOM, WAITING_AT_COMPUTER, WAITING_FOR_OK, WAITING_FOR_OTHERS, waitingForAsker } from "../../../web-server/src/room-box/card-text";
import { RoomAskAfterLine, RoomAsksContext } from "./box-ask-rows";
import { CONNECTOR_CAME_BACK_LABEL, CONNECTOR_SENT_LABEL, OPEN_IN_SETTINGS } from "../../../web-server/src/connector-call-failures";
import { connectorFormGaveUpLine, FORM_SEND, FORM_SENT } from "../../../web-server/src/connector-form-ask";
import { answeredAtComputer, inAskPanel, WaitingAskCard } from "./ask-panel";
import { connectorToolWords, domainOf, GENERIC_TOOL_VIEWS, isMarkdownResult, ResultBody, runningForText, summariseToolArgs } from "./Message";
import { Label, ThinkingCardRow, ThinkingRow, useNow, useOffscreen, WorkIcon, type WorkIconName } from "./ThinkingRow";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;

const KIND_ICONS: Record<StepKind, WorkIconName> = {
	read: "file", write: "pen", edit: "pen", command: "term", search: "search", web: "globe", page: "globe",
	list: "folder", handoff: "handoff", connector: "plug", memory: "book", skill: "book", "folder-ask": "folder", "commands-ask": "term", other: "tool",
};

/** A step the room kept a connector's names on: through the `mcp` tool, or one of the connector's own tools called directly. */
const isConnectorStep = (item: ToolItem): boolean => typeof item.details?.connectorId === "string";

/**
 * The present, past and failed verb of a step, and what it acts on: "Reading" / "Read" / "Couldn't read", "limits.json". `ask`: the card the step asked.
 * `sharedServer`: a file step names the path as the AI gave it, cut at 160 characters. There a path that works in the room's files is a plain name
 * or the files themselves, so a refused one ("drafts/plan.md", "../agent.json") shows what was asked rather than a name that was never refused.
 * A listing asked as "./" and a name over 160 characters read otherwise than on the desktop.
 */
function stepVerbs(item: ToolItem, ask?: ApprovalItem, sharedServer = false): { verbs: [string, string, string]; name: string; where?: string; code?: boolean } {
	const args = item.args && typeof item.args === "object" ? item.args : {};
	const quoted = (value: unknown) => (typeof value === "string" && value.trim() ? `“${value.trim().slice(0, 80)}”` : "");
	const fileName = (path: string) => (sharedServer ? path.trim().slice(0, 160) : lastName(path));
	// A connector's step, through the `mcp` tool or one of the connector's own tools, names what it uses in the person's words: its card's, else the room's (connector-call-failures.ts, mcp/room-scope.ts).
	const use = (ask ? connectorApprovalSubject(ask.title) : null) ?? (typeof item.details?.use === "string" && item.details.use ? item.details.use : null);
	if (use && (item.name === "mcp" || isConnectorStep(item))) return { verbs: ["Using", "Used", "Couldn't use"], name: use };
	switch (item.name) {
		case "bash":
		case RUN_OUTSIDE_BOX_TOOL_NAME: {
			const { verbs, name, where, code } = commandSentence(commandAction(String(args.command ?? "")));
			return { verbs: [verbs[1], verbs[2], verbs[3]], name, where, code };
		}
		case "read": return { verbs: ["Reading", "Read", "Couldn't read"], name: fileName(String(args.path ?? "")) };
		case "read_file": return { verbs: ["Reading", "Read", "Couldn't read"], name: String(args.name ?? "") };
		case "write": return { verbs: ["Writing", "Wrote", "Couldn't write"], name: fileName(String(args.path ?? "")) };
		case "edit": return { verbs: ["Editing", "Edited", "Couldn't edit"], name: fileName(String(args.path ?? "")) };
		case "ls": {
			const folder = fileName(String(args.path ?? ""));
			return { verbs: ["Listing", "Listed", "Couldn't list"], name: folder && folder !== "." ? folder : "the folder" };
		}
		case "find": return { verbs: ["Looking for", "Looked for", "Couldn't look for"], name: String(args.pattern ?? "") };
		case "grep": return { verbs: ["Searching for", "Searched for", "Couldn't search for"], name: quoted(args.pattern), where: args.path ? fileName(String(args.path)) : undefined };
		case "search_file": return { verbs: ["Searching for", "Searched for", "Couldn't search for"], name: quoted(args.query), where: typeof args.name === "string" ? args.name : undefined };
		// The room's own search and the provider's read alike: what main's runtime gives of the provider's is its query and whether it worked.
		case "web_search": return { verbs: ["Searching the web for", "Searched the web for", "Couldn't search the web for"], name: String(args.query ?? "").slice(0, 120) };
		case "fetch_url": {
			const url = String(item.details?.finalUrl ?? args.url ?? "");
			return { verbs: ["Reading", "Read", "Couldn't read"], name: String(item.details?.title || domainOf(url) || url).slice(0, 120) };
		}
		case "kb_search": return { verbs: ["Searching the knowledge base for", "Searched the knowledge base for", "Couldn't search the knowledge base for"], name: quoted(args.query) };
		case "memory_recall": return { verbs: [`${MEMORY_RECALL_STEP.running} for`, `${MEMORY_RECALL_STEP.done} for`, `${MEMORY_RECALL_STEP.failed} for`], name: quoted(args.query) };
		case "delegate_task": return { verbs: ["Handing off to", "Handed off to", "Couldn't hand off to"], name: summariseToolArgs(item.name, args) };
		// The card asked the question; the row says only that the room asked, as the person's answer was her choice.
		case ASK_FOR_FOLDER_TOOL_NAME: return { verbs: [ASKED_FOR_FOLDER, ASKED_FOR_FOLDER, ASKED_FOR_FOLDER], name: "" };
		case ASK_FOR_COMMANDS_TOOL_NAME: return { verbs: [ASKED_FOR_COMMANDS, ASKED_FOR_COMMANDS, ASKED_FOR_COMMANDS], name: "" };
		case "read_skill": return { verbs: ["Reading the skill", "Read the skill", "Couldn't read the skill"], name: String(args.name ?? args.skill ?? "") };
		case "mcp": {
			// A connector by the name the person knows (mcp/room-scope.ts), never its key; one the step doesn't name is "a connector".
			const connector = typeof item.details?.connector === "string" && item.details.connector ? item.details.connector : null;
			if (args.tool) return { verbs: ["Using", "Used", "Couldn't use"], name: connectorToolWords(args, item.details) ?? (connector ? "a tool" : "a connector tool"), where: connector ?? undefined };
			if (args.action === "auth-start" || args.action === "auth-complete") return { verbs: ["Signing in to", "Signed in to", "Couldn't sign in to"], name: connector ?? "a connector" };
			if (args.connect) return { verbs: ["Connecting to", "Connected to", "Couldn't reach"], name: connector ?? "a connector" };
			if (args.search || args.regex) return { verbs: ["Searching connector tools for", "Searched connector tools for", "Couldn't search connector tools for"], name: quoted(args.search ?? args.regex), where: connector ?? undefined };
			if (args.describe) return { verbs: ["Reading about", "Read about", "Couldn't read about"], name: typeof item.details?.about === "string" && item.details.about ? item.details.about : "a connector tool" };
			if (args.server) return { verbs: ["Listing the tools of", "Listed the tools of", "Couldn't list the tools of"], name: connector ?? "a connector" };
			return { verbs: ["Checking connectors", "Checked connectors", "Couldn't check connectors"], name: "" };
		}
	}
	const view = GENERIC_TOOL_VIEWS[item.name];
	if (view) return { verbs: [view.running, view.done, view.failed], name: summariseToolArgs(item.name, args) };
	return { verbs: ["Using", "Used", "Couldn't use"], name: readableToolName(item.name) };
}

/** A verb with nothing after it drops its "for", "to" or "in". */
const bareVerb = (verb: string) => verb.replace(/ (for|to|in)$/, "");

/** What a step acts on, in the text colour; a command named by itself (`code`) as the opened row draws a command. */
function StepName({ name, code }: { name: string; code?: boolean }) {
	return code ? <code className="wk-code">{name}</code> : <b>{name}</b>;
}

/** The sentence of a step: its verb, then what it acts on. */
function StepSentence({ verb, name, where, code }: { verb: string; name: string; where?: string; code?: boolean }) {
	if (!name) return <>{bareVerb(verb)}</>;
	return <>{verb} <StepName name={name} code={code} />{where && <> in <b>{where}</b></>}</>;
}

/** A finished step's sentence in plain words, as its row says it: "Read notes.txt", "Couldn't run npm test". */
function finishedWords(item: ToolItem, state: "done" | "failed", ask?: ApprovalItem, sharedServer = false): string {
	const { verbs, name, where } = stepVerbs(item, ask, sharedServer);
	const verb = verbs[state === "done" ? 1 : 2];
	return name ? `${verb} ${name}${where ? ` in ${where}` : ""}` : bareVerb(verb);
}

type StepOutcome = ReturnType<typeof stepOutcome>;

/** A room's ask that gave nothing (Not now, nobody there, not asked): neither a tick nor a failure. */
function askLeftAsItWas(item: ToolItem): boolean {
	const result = roomAskResult(item);
	return result !== null && result.outcome !== "yes" && result.outcome !== "already";
}

/** What the line under a step's yes names: a folder or commands an ask gave. */
function givenBy(item: ToolItem): RoomAskGiven | null {
	if (item.status !== "done") return null;
	return roomAskResult(item)?.given ?? null;
}

/**
 * The lines under a card's yeses, each with its way back. They stand under
 * the card, not in its rows, so they stay in sight when the card folds.
 */
function RoomAskAfterLines({ steps }: { steps: ReadonlyArray<StepPiece> }) {
	const lines = steps.flatMap((step) => {
		const given = givenBy(step.item);
		return given ? [<RoomAskAfterLine key={step.item.id} id={step.item.id} given={given} takenBack={step.item.takenBack === true} />] : [];
	});
	return lines.length > 0 ? <div className="box-room-after-lines">{lines}</div> : null;
}

/**
 * An old hand-off card left waiting: specialists are switched off, so it can
 * never start and says why instead of asking. Read from the card alone, since
 * an old step comes back stopped, or still running when it was saved mid-turn.
 */
function handOffLeftWaiting(ask: ApprovalItem | undefined): boolean {
	return !!ask?.unanswered && handOffApprovalSubject(ask.title) !== null;
}

/**
 * A step whose line is what the person needs to read, so its card shows it
 * unopened and never folds it behind the earlier steps: a box that didn't
 * start (only the card says what to do), a connector call the answer's
 * stop or a time limit ended (it may have done part of the work), and a
 * connector call that failed for a reason the person can act on (its line
 * says how, at the computer with its button, and elsewhere who to ask). A
 * failure with nothing to do stays folded.
 */
function showsItsLine(item: ToolItem): boolean {
	return boxFault(item) || connectorCallEndedLine(item) !== null || (item.status === "error" && connectorFailedLine(item)?.opensConnector !== undefined);
}

/** Where a step stands as its row shows it: a refusal (the app's rules or the room's settings kept it from running) reads calm, apart from a failure. */
function rowState(item: ToolItem, ask: ApprovalItem | undefined, sharedServer: boolean, remote = false): { state: StepState; outcome: StepOutcome | null } {
	if (handOffLeftWaiting(ask) && item.status !== "done") return { state: "denied", outcome: null };
	const state = stepState(item, ask);
	const connectorNotRun = state === "denied" ? connectorNotRunLine(item) : null;
	if (connectorNotRun) return { state, outcome: { line: connectorNotRun, refused: true } };
	const outcome = (state === "failed" || connectorCallRefused(item)) && typeof item.result === "string" ? stepOutcome(item.result, item, sharedServer, remote) : null;
	return { state: outcome?.refused ? "denied" : state, outcome };
}

interface StretchProps {
	items: ChatItem[];
	/** The turn still runs and nothing has come after this stretch. */
	live: boolean;
	/** When the stretch ended: the time of what came after it, when known. */
	endTs?: number;
	/** Another window took the room: a step still running goes on there. */
	elsewhere: boolean;
	keyboardApprovalId: string | null;
	onResolve: (requestId: string, value: any, label: string) => void;
	onPreview?: (preview: ApprovalPreviewData) => void;
}

/** A stretch of work: a work card when it has steps, its thinking rows when it only thought. */
export function WorkStretch(props: StretchProps) {
	const pieces = useMemo(() => workPieces(props.items), [props.items]);
	if (!pieces.some((piece) => piece.kind !== "thinking")) {
		return <>{pieces.map((piece) => (piece.kind === "thinking" ? <ThinkingRow key={piece.item.id} group={piece.group} /> : null))}</>;
	}
	return <WorkCard {...props} pieces={pieces} />;
}

const ROW_CAP = 6;

function stretchStart(pieces: WorkPiece[]): number | undefined {
	const starts = pieces.map((piece) => (piece.kind === "thinking" ? piece.item.ts : piece.kind === "step" ? piece.item.startedAt : undefined)).filter((ts): ts is number => typeof ts === "number");
	return starts.length ? Math.min(...starts) : undefined;
}

// The person's own open or fold of a card or of a folded turn, by the
// id of its first item: true open, false folded. It wins over every rule that
// opens or folds by itself, a thought opened inside included, and outlives the
// component, since a card is drawn anew when its turn folds and a fold is
// skipped while a thought in it is open. Ids are never reused.
const foldChoices = new Map<string, boolean>();
const foldListeners = new Set<() => void>();

/** The person's choice for this fold, if they made one. */
export function foldChoiceOf(id: string): boolean | undefined {
	return foldChoices.get(id);
}

function setFoldChoice(id: string, open: boolean | undefined): void {
	if (foldChoices.get(id) === open) return;
	if (open === undefined) foldChoices.delete(id);
	else foldChoices.set(id, open);
	for (const listener of [...foldListeners]) listener();
}

function useFoldChoice(id: string): boolean | undefined {
	const read = () => foldChoices.get(id);
	return useSyncExternalStore((listener) => {
		foldListeners.add(listener);
		return () => foldListeners.delete(listener);
	}, read, read);
}

type StepPiece = Extract<WorkPiece, { kind: "step" }>;

/** A folded card's head from its steps: what they did, the icons of the first three kinds, and its mark: the check once every step worked, the failed mark when one failed. */
function foldedHead(steps: ReadonlyArray<StepPiece>, sharedServer: boolean): { label: string; icons: WorkIconName[]; mark: HeadMark } {
	const states = steps.map((step) => rowState(step.item, step.ask, sharedServer).state);
	return {
		label: foldedWords(steps),
		icons: [...new Set(steps.map((step) => itemKind(step.item)))].slice(0, 3).map((kind) => KIND_ICONS[kind]),
		mark: states.includes("failed") ? "failed" : states.length > 0 && states.every((state) => state === "done") && steps.every((step) => !askLeftAsItWas(step.item)) ? "check" : "blank",
	};
}

/** A head's mark: the check, the failed mark, an empty place ("blank"), or no place at all (null). */
type HeadMark = "check" | "failed" | "blank" | null;

/**
 * A card's one line: the live dot or the steps' icons, the words, the time,
 * its mark, and the arrow. The mark's place and the arrow's line its time up
 * with what stands beside it: other cards' heads keep both, an opened card's
 * rows (which carry their own marks) take the mark's place away. Without
 * `onToggle` there is nothing to open: no button, the arrow's place empty, and
 * with no time or mark to line up either, the words take both places too.
 */
function CardHead({ live, waiting, label, sentence, time, icons, mark, open, onToggle }: { live: boolean; waiting: boolean; label: string; sentence?: ReactNode; time: string; icons: WorkIconName[]; mark: HeadMark; open: boolean; onToggle?: () => void }) {
	const working = live || waiting;
	// Only an arrow, a time or a real mark has anything to line up with the heads beside it.
	const lineUp = Boolean(onToggle || time || (mark && mark !== "blank"));
	const parts = (
		<>
			<span className="wk-lead">
				{working ? <span className="wk-dot" /> : icons.map((icon, index) => <span key={index} className="wk-stack"><WorkIcon name={icon} /></span>)}
			</span>
			<span className="wk-label"><Label text={label} className={live && !waiting ? "wk-sweep" : ""}>{sentence}</Label></span>
			{time && <span className="wk-time">{time}</span>}
			{mark && (mark !== "blank" || lineUp) && <span className="wk-hmk">{mark === "check" ? <WorkIcon name="check" className="wk-ok" /> : mark === "failed" ? <WorkIcon name="x" className="wk-bad" /> : null}</span>}
			{onToggle ? <WorkIcon name="chev" className="wk-caret" /> : lineUp ? <span className="wk-noarrow" /> : null}
		</>
	);
	return onToggle ? <button type="button" className="wk-head" aria-expanded={open} onClick={onToggle}>{parts}</button> : <div className="wk-head">{parts}</div>;
}

/**
 * One card per stretch of work. While it works: a live header ("Working",
 * or "Waiting for your OK" while a step asks, amber when the question is in
 * the card; "Waiting", still, while another person's question waits for them),
 * and a row per step.
 * Once something comes after it, it folds to one line of what was done and
 * how long it took, with a check when every step worked; a click opens it again.
 * A finished card whose one step worked or failed says that step's own
 * sentence. Alone, it opens straight to what its row would show under it, so
 * the sentence shows once; with nothing to show, it does not open. Beside
 * the model's thinking, it opens to the thoughts' rows and its own, already
 * open. A step that did not run keeps its row, which says why.
 */
/** What a waiting card's head says: a phone can't answer the room's own asks, so there it says who can. */
function waitingLabel(asks: ApprovalItem[], remote: boolean): string {
	return remote && asks.every(answeredAtComputer) ? WAITING_AT_COMPUTER : WAITING_FOR_OK;
}

/** A folder ask on a computer with no folder window and no one click offered: nobody can give a folder, so the card waits only for Not now. */
const windowless = (ask: ApprovalItem): boolean => ask.uiKind === "folder" && ask.canChoose === false && ask.suggested?.once !== true;

function WorkCard({ pieces, live, endTs, elsewhere, keyboardApprovalId, onResolve, onPreview }: StretchProps & { pieces: WorkPiece[] }) {
	const openAsks = pieces.flatMap((piece) => {
		const ask = piece.kind === "step" ? piece.ask : piece.kind === "ask" ? piece.item : undefined;
		return ask && askOpen(ask) ? [ask] : [];
	});
	const waiting = openAsks.length > 0;
	const { remote } = useRemoteClientContext();
	// The amber head asks for an answer: at the computer, a folder ask with no window to choose in asks for none.
	// A question in another person's answer is theirs: its own row says whom this page waits for, and the head waits, still, with no name.
	const answerable = openAsks.filter((ask) => !ask.waitingFor && (remote || !windowless(ask)));
	const headWaits = answerable.length > 0;
	const waitsForOthers = !headWaits && openAsks.some((ask) => ask.waitingFor);
	// Amber only while a question waits here in the steps: the panel above the message box holds the others.
	const amber = answerable.some((ask) => !inAskPanel(ask));
	const working = live || waiting;
	const foldId = `card:${pieces[0]?.item.id ?? ""}`;
	const choice = useFoldChoice(foldId);
	// A thought the person opened is hidden only by the person: where the card would fold by itself (it stops working, or it comes back finished), it stays open over one.
	const overOpenThought = () => pieces.some((piece) => piece.kind === "thinking" && isThoughtOpen(piece.item.id));
	const [showAll, setShowAll] = useState(false);
	const wasWorking = useRef(working);
	// Before paint, so the card never shows folded for a frame over an open thought.
	useLayoutEffect(() => {
		const folds = wasWorking.current && !working;
		wasWorking.current = working;
		// A fold the person made stays. An open made while it worked ends with it, unless a thought they opened is in it.
		if (folds && choice !== false) setFoldChoice(foldId, overOpenThought() ? true : undefined);
		// Drawn finished over an open thought (its turn folded and came back): open, and it stays so once the thought closes.
		else if (!working && choice === undefined && overOpenThought()) setFoldChoice(foldId, true);
	}, [working]);
	const { sharedServer } = useRemoteClientContext();
	const steps = pieces.filter((piece): piece is StepPiece => piece.kind === "step");
	// A connector step's yes keeps its own row beside the step (workPieces): the card is still that one step's.
	const sole = !working && steps.length === 1 && pieces.every((piece) => piece.kind !== "ask" || piece.item === steps[0].ask) ? steps[0] : null;
	const soleRow = sole ? rowState(sole.item, sole.ask, sharedServer, remote) : null;
	const only = sole && soleRow && (soleRow.state === "done" || soleRow.state === "failed") ? { item: sole.item, ask: sole.ask, state: soleRow.state, outcome: soleRow.outcome } : null;
	const solo = only && pieces.length === 1;
	const details = solo ? stepDetails(only.item, only.state, only.outcome) : null;
	// A card of one answered question and nothing else, such as one kept after its turn went on without an answer: its head says what came of it, and there is nothing more to open.
	const settled = !working && pieces.length === 1 && pieces[0].kind === "ask" ? askOutcome(pieces[0].item, sharedServer) : null;
	const opens = !settled && (!solo || details !== null);
	// It stays open until the person folds it.
	const saysWhy = steps.some((step) => showsItsLine(step.item));
	const open = opens && (choice ?? (working || saysWhy || overOpenThought()));
	const start = stretchStart(pieces);
	// The timer pauses while a step waits for the person.
	const now = useNow(live && !waiting);
	const folded = foldedHead(steps, sharedServer);
	const ref = useOffscreen<HTMLDivElement>();
	let label: string;
	// The label's words as the step's row draws them, where its command is named by itself in code.
	let sentence: ReactNode;
	let time = "";
	if (working) {
		label = headWaits ? waitingLabel(answerable, remote) : waitsForOthers ? WAITING_FOR_OTHERS : "Working";
		time = start !== undefined ? runningForText(now - start) : "";
	} else {
		label = settled ? settled.label : only ? finishedWords(only.item, only.state, only.ask, sharedServer) : folded.label;
		if (only) {
			const { verbs, ...what } = stepVerbs(only.item, only.ask, sharedServer);
			if (what.code) sentence = <StepSentence verb={verbs[only.state === "done" ? 1 : 2]} {...what} />;
		}
		// A card of one ask answered Not now says so where its row does, in place of the time.
		time = only && roomAskResult(only.item)?.outcome === "not-now" ? NOT_NOW : start !== undefined && endTs !== undefined && endTs >= start ? durationText(endTs - start) : "";
	}
	// The earlier rows fold behind one button, but never a thought the person opened, a question waiting for them, nor a step that shows its line unopened.
	const cut = !showAll && pieces.length > ROW_CAP + 1 ? pieces.length - ROW_CAP : 0;
	const kept = (piece: WorkPiece) => (piece.kind === "thinking" ? isThoughtOpen(piece.item.id) : askOpen(piece.kind === "step" ? piece.ask : piece.item) || (piece.kind === "step" && showsItsLine(piece.item)));
	const shown = cut ? pieces.filter((piece, index) => index >= cut || kept(piece)) : pieces;
	const hidden = pieces.length - shown.length;
	return (
		<div className="bubble-row">
			<div className={`wk-card${amber ? " waiting" : headWaits || waitsForOthers ? " asks" : ""}`} data-open={open ? "1" : "0"} data-live={working ? "1" : "0"} ref={ref}>
				{/* Folded, the card is the one row its steps show: it carries their mark; opened, its rows do and its head gives the mark's place up to line its time up with theirs, unless it is one step's card. */}
				<CardHead live={live} waiting={headWaits || waitsForOthers} label={label} sentence={sentence} time={time} icons={settled ? [settled.icon] : folded.icons} mark={working || (open && !solo) ? null : folded.mark} open={open} onToggle={opens ? () => setFoldChoice(foldId, !open) : undefined} />
				<div className="wk-body">
					<div className="wk-in">
						{solo ? <div className="wk-rows wk-solo">{open && details}</div> : (
							<div className="wk-rows">
								{hidden > 0 && (
									<button type="button" className="wk-more" onClick={() => setShowAll(true)}>{hidden === 1 ? "1 earlier step" : `${hidden} earlier steps`}</button>
								)}
								{shown.map((piece) =>
									piece.kind === "thinking" ? (
										<ThinkingCardRow key={piece.item.id} group={piece.group} />
									) : piece.kind === "step" ? (
										<StepRow key={piece.item.id} item={piece.item} ask={piece.ask} elsewhere={elsewhere} keyboard={!!piece.ask && piece.ask.requestId === keyboardApprovalId} onResolve={onResolve} onPreview={onPreview} opensWith={only ? open : undefined} />
									) : (
										<LoneAskRow key={piece.item.id} ask={piece.item} keyboard={piece.item.requestId === keyboardApprovalId} onResolve={onResolve} onPreview={onPreview} />
									),
								)}
							</div>
						)}
					</div>
				</div>
			</div>
			<RoomAskAfterLines steps={steps} />
		</div>
	);
}

/** Whom another person's question waits for, or, once this page's answer was refused, who alone can answer it. */
function waitingLine(waitingFor: NonNullable<ApprovalItem["waitingFor"]>): string {
	return waitingFor.refused ? onlyAskerAnswers(waitingFor.name) : waitingForAsker(waitingFor.name);
}

/**
 * Who answered a question, as this page names them: the person whose answer
 * asked it, "you" on their own page until the conversation is opened again;
 * "you" where nobody else could answer. null on a shared server where this page
 * can't know: a card no person's answer asked, or a step with no card beside it.
 */
function answerer(ask: ApprovalItem | undefined, sharedServer: boolean): string | null {
	const asked = ask?.askedBy;
	if (asked) return asked.here ? "you" : asked.name ?? "the person who asked";
	return sharedServer ? null : "you";
}

/** A no to a question, by whoever gave it, or by nobody named where this page can't know. */
const saidNo = (who: string | null): string => (who ? `${who} said no` : "declined");

/** Why a step did not run, in grey: the person said no, nobody was there, or Stop came first. */
function notRunWords(item: ToolItem, ask: ApprovalItem | undefined, sharedServer: boolean): string {
	if (ask?.stopped) return "Not run · you pressed Stop";
	const page = pageNotOpened(item);
	if (commandDeclined(item.result) || page === "declined" || (ask?.done && declinedAnswer(ask.done))) return `Not run · ${saidNo(answerer(ask, sharedServer))}`;
	if (nobodyToApprove(item.result) || page === "nobody") return "Not run · nobody was there to answer";
	return "Not run";
}

/** `opensWith`: the card's own open, for the one step of a card; the row opens each time the card does, so its output is one click from the folded card. */
function StepRow({ item, ask, elsewhere, keyboard, onResolve, onPreview, opensWith }: { item: ToolItem; ask?: ApprovalItem; elsewhere: boolean; keyboard: boolean; onResolve: StretchProps["onResolve"]; onPreview?: StretchProps["onPreview"]; opensWith?: boolean }) {
	const { sharedServer, remote } = useRemoteClientContext();
	const [open, setOpen] = useState(!!opensWith);
	// Before paint, so the card never shows the row closed for a frame as it opens.
	useLayoutEffect(() => {
		if (opensWith) setOpen(true);
	}, [opensWith]);
	const { state, outcome } = rowState(item, ask, sharedServer, remote);
	const { verbs, ...what } = stepVerbs(item, ask, sharedServer);
	const { name, code } = what;
	const kind = itemKind(item);
	if (state === "asking" && ask) return <AskRow item={item} ask={ask} icon={KIND_ICONS[kind]} keyboard={keyboard} onResolve={onResolve} onPreview={onPreview} />;
	// Another window took the room: a step still under way goes on there, and is shown here only.
	const goesOnElsewhere = elsewhere && (state === "running" || state === "writing");
	const leftWaiting = state === "denied" && handOffLeftWaiting(ask);

	let sentence: ReactNode;
	let meta = "";
	if (goesOnElsewhere) sentence = <>Continued in another window{name ? <> · <StepName name={name} code={code} /></> : null}</>;
	else if (state === "writing") {
		// Nothing runs while the model writes a command, so it reads as the command itself.
		sentence = isCommandStep(item.name) ? <StepSentence verb="Command" name={String(item.args?.command ?? "").slice(0, 160)} /> : <StepSentence verb={verbs[0]} {...what} />;
		meta = typeof item.args?.sizeSoFar === "number" && item.args.sizeSoFar > 0 ? sizeText(item.args.sizeSoFar) : "";
	} else if (state === "running") {
		sentence = <StepSentence verb={verbs[0]} {...what} />;
		// The card's timer ticks every second, and with it the running row's own.
		meta = item.startedAt !== undefined ? runningForText(Date.now() - item.startedAt) : "";
	} else if (state === "done") {
		sentence = <StepSentence verb={verbs[1]} {...what} />;
		meta = roomAskResult(item)?.outcome === "not-now" ? NOT_NOW : [stepResultWords(item), stepTime(item)].filter(Boolean).join(" · ");
	} else if (state === "failed") {
		sentence = <StepSentence verb={verbs[2]} {...what} />;
		meta = stepTime(item);
	} else if (state === "denied") sentence = outcome?.refused ? <>{outcome.line}</> : leftWaiting ? <>{SPECIALISTS_OFF_SENTENCE}</> : <>{notRunWords(item, ask, sharedServer)}{name ? <> ·{"\u00a0"}<StepName name={name} code={code} /></> : null}</>;
	else sentence = <>Stopped · <StepSentence verb={verbs[0]} {...what} /></>;

	const icon: WorkIconName = goesOnElsewhere ? "away" : leftWaiting || state === "stopped" ? "stop" : state === "denied" ? "ban" : KIND_ICONS[kind];
	const body = stepBody(item, state);
	const live = !goesOnElsewhere && (state === "running" || state === "writing");
	// A row that says why it didn't run wraps, whether or not it opens.
	const wrap = leftWaiting || (state === "denied" && outcome?.refused) ? " wk-wrap" : "";
	const mark = live ? <span className="wk-spin" /> : state === "done" && !askLeftAsItWas(item) ? <WorkIcon name="check" className="wk-ok" /> : state === "failed" ? <WorkIcon name="x" className="wk-bad" /> : null;
	return (
		<>
			<div className="wk-row" data-s={goesOnElsewhere ? "elsewhere" : state}>
				<span className="wk-row-ic"><WorkIcon name={icon} /></span>
				{body ? (
					// The sweep lives on the words, as in a thinking row (ThinkingCardRow).
					<button type="button" className={`wk-tx wk-open${wrap}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{live ? <span className="wk-sweep">{sentence}</span> : sentence}</button>
				) : (
					<span className={`wk-tx${live ? " wk-sweep" : ""}${wrap}`}>{sentence}</span>
				)}
				{meta && <span className="wk-meta">{meta}</span>}
				<span className="wk-mk">{mark}</span>
			</div>
			{state === "failed" && outcome?.line && <OutcomeLine outcome={outcome} />}
			{open && body}
		</>
	);
}

/** The line under a failed step, with Open in Settings where it leads to the connector's own page. */
function OutcomeLine({ outcome }: { outcome: NonNullable<StepOutcome> }) {
	const roomAsks = useContext(RoomAsksContext);
	const opens = outcome.opensConnector;
	if (!opens || !roomAsks) return <div className="wk-line">{outcome.line}</div>;
	// The grid puts the sentence and the button on rows of their own, with more space between them on a phone; the line keeps its own space above what the step opens to.
	return (
		<div className="wk-line">
			<div className="box-room-after-lines">
				<span>{outcome.line} </span>
				<span><button type="button" className="rs-btn rs-btn-sm wk-btn" onClick={() => roomAsks.openConnector(opens)}>{OPEN_IN_SETTINGS}</button></span>
			</div>
		</div>
	);
}

/** What a card of one finished step opens to: what its row shows under it (why it failed) and what the row opens to. Null when there is nothing. */
function stepDetails(item: ToolItem, state: "done" | "failed", outcome: StepOutcome | null): ReactNode {
	const line = state === "failed" && outcome?.line ? <OutcomeLine outcome={outcome} /> : null;
	const body = stepBody(item, state);
	return line || body ? <>{line}{body}</> : null;
}

/** A connector step the runtime answered only with where the assistant should look instead (a tool nobody has, or one of the room's own): its head says it. */
const pointsAssistantElsewhere = (item: ToolItem) => item.name === "mcp" && (item.details?.error === "tool_not_found" || item.details?.error === "native_tool");

/**
 * A step of the `mcp` tool that only looks a connector up, not a call of its tool: a connect, a list, a search, a describe, the status
 * and the sign-in actions. What it returns is for the model, apart from a sign-in started that worked: it holds the address the person opens.
 */
const isConnectorLookup = (item: ToolItem) => item.name === "mcp" && !item.args?.tool && !(item.args?.action === "auth-start" && item.status !== "error");

/** What a row opens to: the command and what came back, the first lines of a file. A command that runs shows itself alone, in the box its result joins. Null when there is nothing to show. */
function stepBody(item: ToolItem, state: StepState): ReactNode {
	if (state === "writing" || state === "asking" || (state === "running" && !isCommandStep(item.name))) return null;
	// What an ask's step returns is for the model; the person answered the card and sees the line under it.
	if (itemKind(item) === "folder-ask" || itemKind(item) === "commands-ask") return null;
	// So is a connector look-up's; the line a failed or refused one has stays on its row or under it.
	if (isConnectorLookup(item)) return null;
	const command = isCommandStep(item.name) ? String(item.args?.command ?? "") : "";
	// A box fault's result is the sentence the card already shows, and so is a connector's No or a card nobody answered, whose rest is for the model, as is a page's, a connector call's that was stopped or ran out of time, one whose failure has its own line, and the runtime's refusal of what the assistant sent.
	const result = state !== "running" && typeof item.result === "string" && item.result.trim() && !boxFault(item) && !(item.status === "error" && (connectorNotRunLine(item) !== null || connectorCallEndedLine(item) !== null || connectorFailedLine(item) !== null || inputRefusedByRuntime(item.result) || pointsAssistantElsewhere(item))) && pageNotOpened(item) === null ? item.result : "";
	// A connector's call, not a sign-in started through the `mcp` tool.
	if (item.name === "mcp" ? Boolean(item.args?.tool) : isConnectorStep(item)) return <ConnectorStepBody item={item} result={result} />;
	if (!command && !result) return null;
	return (
		<div className="wk-out">
			{command && <pre className="wk-command">{command}</pre>}
			{result && <ResultBody markdown={isMarkdownResult(item)} text={item.name === "memory_recall" ? memoryRecallDisplayText(result) : result} />}
		</div>
	);
}

/** What a connector call sent: the input the `mcp` tool passes on, or a connector's own tool's arguments; every hidden character written out, as a command step shows them. */
function connectorSent(item: ToolItem): string {
	const args = item.args && typeof item.args === "object" ? item.args : {};
	const input = item.name === "mcp" ? args.args : args;
	return commandAsShown(typeof input === "string" ? input : JSON.stringify(input ?? {}));
}

/** What came back, without what is for the model only: the tool's expected parameters, which the adapter adds to a failure only, and a terminal's colour codes. */
function connectorCameBack(result: string, failed: boolean): string {
	const shown = failed ? result.replace(/\n\nExpected parameters:\n[\s\S]*$/, "") : result;
	return shown.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/** A connector step opens to two parts: what the room sent, whole, and what came back. */
function ConnectorStepBody({ item, result }: { item: ToolItem; result: string }) {
	const cameBack = result ? connectorCameBack(result, item.status === "error") : "";
	return (
		<div className="wk-out">
			<div>{CONNECTOR_SENT_LABEL}</div>
			<pre className="wk-command">{connectorSent(item)}</pre>
			{cameBack && <div>{CONNECTOR_CAME_BACK_LABEL}</div>}
			{cameBack && <ResultBody markdown={isMarkdownResult(item)} text={cameBack} />}
		</div>
	);
}

/** The key that answers a question, as this computer writes it. */
function enterKey(): string {
	return isMacPlatform() ? "↵" : "Enter";
}

/**
 * A step that waits for the person: its own row, with an amber edge, the
 * action in plain words, the exact command under it, and under everything,
 * at the row's right, Deny and Allow. A command's facts (where it runs) stay
 * in the server's text; any other fenced question, a specialist's, keeps the
 * facts the app wrote behind Details.
 * The buttons show their keys only while those keys work: this is the one
 * question the keys answer, the box is empty, and for Enter, the focus is
 * on the page, in the box or on Allow itself. A touch screen, or a
 * phone-width window, shows no keys.
 */
function AskRow({ item, ask, icon, keyboard, onResolve, onPreview }: { item?: ToolItem; ask: ApprovalItem; icon: WorkIconName; keyboard: boolean; onResolve: StretchProps["onResolve"]; onPreview?: StretchProps["onPreview"] }) {
	// The row wears the panel's glyph where the question is not the step's own kind: a site, a command to run outside the room, and one to run, which the step may name by what it does (a list's folder).
	// One that waits for another person is the panel's own card, greyed, here in the steps: the panel holds only this page's.
	if (inAskPanel(ask)) return ask.waitingFor ? <WaitingAskCard ask={ask} line={waitingLine(ask.waitingFor)} /> : <PanelAskRow ask={ask} icon={ask.uiKind === "site" ? "globe" : ask.uiKind === "run" ? "term" : ask.uiKind === "outside" ? "tool" : icon} />;
	return <PlainAskRow item={item} ask={ask} icon={icon} keyboard={keyboard} onResolve={onResolve} onPreview={onPreview} />;
}

/** A question the panel above the message box shows: here, only what was asked, quiet and with no answers, so it is answered in one place. */
function PanelAskRow({ ask, icon }: { ask: ApprovalItem; icon: WorkIconName }) {
	const words = ask.uiKind === "folder" ? ASKED_FOR_FOLDER : ask.uiKind === "commands" ? ASKED_FOR_COMMANDS : ask.title;
	return (
		<div className="wk-row" data-s="waiting">
			<span className="wk-row-ic"><WorkIcon name={icon} /></span>
			<span className="wk-tx wk-wrap">{words}</span>
			<span className="wk-mk" />
		</div>
	);
}

function PlainAskRow({ item, ask, icon, keyboard, onResolve, onPreview }: { item?: ToolItem; ask: ApprovalItem; icon: WorkIconName; keyboard: boolean; onResolve: StretchProps["onResolve"]; onPreview?: StretchProps["onPreview"] }) {
	const preview = useMemo(() => approvalPreviewFromItem(ask), [ask.requestId, ask.done, ask.detail, ask.message, ask.title]);
	const fenced = preview ? null : (splitFencedBrief(ask.message) ?? splitFencedBrief(ask.detail));
	// What the server asks about, not what the step was written with: the person allows the command it shows.
	const asked = askedCommand(ask);
	const command = asked ?? (isCommandStep(item?.name) ? String(item?.args?.command ?? "") : "");
	const metadata = preview ? approvalMetadata(ask.title, ask.detail || ask.message) : [];
	const boxEmpty = useComposerEmpty();
	const touch = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(hover: none), (max-width: 720px)").matches;
	// Another person's question: shown as it asks them, with whom it waits for in place of its answers.
	const waitingFor = ask.waitingFor;
	const keysWork = keyboard && boxEmpty && !touch && !waitingFor;
	// Enter reaches the question from the page and the box, or presses Allow when it has the focus itself.
	const enterFromPage = useEnterReachesQuestion();
	const [allowFocused, setAllowFocused] = useState(false);
	const enterWorks = keysWork && (enterFromPage || allowFocused);
	// The person started typing after this step asked: sending their message says no to it.
	const draftStartedAt = useDraftStartedAt();
	const sendDenies = !waitingFor && !boxEmpty && messageDeclinesQuestion(ask.openedAt, draftStartedAt);
	const [text, setText] = useState("");
	// The facts the app wrote above the fence: a specialist's (what it may write) behind Details; a command's are not shown.
	const facts = asked === null ? fenced?.facts ?? "" : "";
	const [detailsOpen, setDetailsOpen] = useState(false);
	const allowRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (preview && !waitingFor) onPreview?.(preview);
	}, [ask.requestId, preview, onPreview, waitingFor]);

	// The Allow button takes focus only when nobody is typing: a grabbed focus would turn a "send" Enter into a silent yes.
	useLayoutEffect(() => {
		const button = allowRef.current;
		if (!button) return;
		const active = document.activeElement;
		if (active instanceof HTMLElement && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.tagName === "SELECT" || active.isContentEditable)) return;
		if ((composerTextarea()?.value ?? "") !== "") return;
		button.focus({ preventScroll: true });
	}, [ask.requestId]);

	const resolve = (value: any, label: string) => {
		onResolve(ask.requestId, value, label);
		composerTextarea()?.focus();
	};
	// The words saved with the answer stay the ones every reader of the conversation knows.
	const labels = confirmApprovalLabels(ask);
	const deny = (): boolean => {
		if (ask.uiKind === "confirm") resolve(false, labels.decline);
		else if (ask.uiKind === "input") resolve(undefined, "Cancelled");
		else {
			const option = (ask.options ?? []).find((choice) => declinedAnswer(choice));
			if (!option) return false;
			resolve(option, option);
		}
		return true;
	};
	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape" || waitingFor) return;
		if (deny()) {
			event.preventDefault();
			event.stopPropagation();
		}
	};

	let title: ReactNode;
	// How the title names a command named by itself. "whole": one line is the title whole, wrapping and never cut, since the person allows what
	// they read, and is not said again under it. "first-line": a command of several lines keeps its first line as the title, on one line, over
	// the server's text; so does one the server clipped, as its clip line makes it several.
	let named: "whole" | "first-line" | null = null;
	if (isCommandStep(item?.name)) {
		const { verbs, name, where, code } = commandSentence(commandAction(command));
		if (code) named = command.trim().includes("\n") ? "first-line" : "whole";
		title = <StepSentence verb={verbs[0]} name={named === "whole" ? command.trim() : name} where={where} code={code} />;
	}
	else if (item?.name === "delegate_task" || !item) title = ask.title;
	else {
		const { verbs, name } = stepVerbs(item);
		title = <>{ask.title || <StepSentence verb={verbs[0]} name={name} />}</>;
	}
	const sub = named === "whole" ? "" : command || (!fenced && !preview ? ask.message : "") || "";

	return (
		<div className="wk-row wk-ask" data-s={waitingFor ? "waiting" : "asking"} onKeyDown={onKeyDown}>
			<span className="wk-row-ic"><WorkIcon name={icon} /></span>
			<div className={`wk-tx${named === "first-line" ? " wk-one" : ""}`}>{title}</div>
			{(sub || sendDenies || metadata.length > 0 || facts || (ask.uiKind === "input" && !waitingFor)) && (
				<div className="wk-ask-body">
					{sub && <div className="wk-ask-sub">{sub}</div>}
					{sendDenies && <div className="wk-ask-denies">Sending your message denies this step.</div>}
					{metadata.length > 0 && <div className="wk-ask-meta">{metadata.map((line) => <div key={line}>{line}</div>)}</div>}
					{facts && <button type="button" className="wk-ask-more" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>{detailsOpen ? "Hide details" : "Details"}</button>}
					{facts && detailsOpen && <div className="wk-ask-facts">{facts}</div>}
					{ask.uiKind === "input" && !waitingFor && <textarea className="wk-ask-input" value={text} rows={3} placeholder={ask.placeholder ?? "Your answer…"} onChange={(event) => setText(event.target.value)} />}
				</div>
			)}
			{waitingFor ? <div className="wk-ask-wait" role="status">{waitingLine(waitingFor)}</div> : <div className="wk-ask-btns">
				{ask.uiKind === "confirm" && (
					<>
						{/* A press keeps the focus where it is: on Deny, Enter would be Deny's, so Allow would drop its key, and the narrower Allow
						    would pull Deny from under the pointer before the click lands. */}
						<button type="button" className="rs-btn rs-btn-sm wk-btn" onMouseDown={(event) => event.preventDefault()} onClick={() => resolve(false, labels.decline)}>Deny{keysWork && <kbd>Esc</kbd>}</button>
						<button type="button" className="rs-btn rs-btn-primary rs-btn-sm wk-btn primary" ref={allowRef} onFocus={() => setAllowFocused(true)} onBlur={() => setAllowFocused(false)} onClick={() => resolve(true, labels.approve)}>Allow{enterWorks && <kbd>{enterKey()}</kbd>}</button>
					</>
				)}
				{ask.uiKind === "select" && (ask.options ?? []).map((option) => {
					const lower = option.toLowerCase();
					const primary = lower === "approve" || lower === "yes";
					return <button key={option} type="button" className={`rs-btn rs-btn-sm wk-btn${primary ? " rs-btn-primary primary" : ""}`} ref={primary ? allowRef : undefined} onClick={() => resolve(option, option)}>{option}</button>;
				})}
				{ask.uiKind === "input" && (
					<>
						<button type="button" className="rs-btn rs-btn-sm wk-btn" onClick={() => resolve(undefined, "Cancelled")}>Cancel</button>
						<button type="button" className="rs-btn rs-btn-primary rs-btn-sm wk-btn primary" onClick={() => resolve(text, text ? "Submitted" : "(empty)")}>Submit</button>
					</>
				)}
			</div>}
		</div>
	);
}

/** A connector question's yes as its answered row says it: for this time, from now on wherever it is on, or, answered before Always allow, for the room. */
const CONNECTOR_YES_WORDS = new Map([[SITE_ALLOW_ONCE, "Allowed"], [CONNECTOR_CHOICE_WORDS.allow, "Always allowed"], [SITE_ALLOW_ROOM, "Allowed for this room"]]);

/** What an answered question no step is known for came to: its words before its title (none when specialists are off: `label` is then that sentence alone), its icon, and whether nothing was done. */
function askOutcome(ask: ApprovalItem, sharedServer: boolean): { words: string | null; label: string; icon: WorkIconName; notRun: boolean } {
	const declined = !!ask.stopped || declinedAnswer(ask.done);
	const notRun = declined || !!ask.unanswered;
	if (handOffLeftWaiting(ask)) return { words: null, label: SPECIALISTS_OFF_SENTENCE, icon: "stop", notRun };
	// A connector's form its connector stopped waiting for says so whole.
	if (ask.unanswered === "withdrawn") return { words: null, label: connectorFormGaveUpLine(ask.connector ?? ""), icon: "ban", notRun };
	const connectorYes = ask.uiKind === "connector" ? CONNECTOR_YES_WORDS.get(ask.done ?? "") : ask.uiKind === "form" && ask.done === FORM_SEND ? FORM_SENT : undefined;
	const who = answerer(ask, sharedServer);
	const words = ask.stopped ? "Not done · you pressed Stop" : ask.unanswered ? "Not answered" : declined ? `Not done · ${saidNo(who)}` : connectorYes ?? (/^(yes\b|approve)/i.test(ask.done ?? "") ? "Allowed" : who && ask.done && !/^(submitted|\(empty\))/i.test(ask.done) ? `${who[0].toUpperCase()}${who.slice(1)} chose ${ask.done}` : "Answered");
	return { words, label: `${words} · ${ask.title}`, icon: notRun ? "ban" : "check", notRun };
}

/** A question no step is known for: open, it asks as a step would; answered, one quiet row says what was decided. */
function LoneAskRow({ ask, keyboard, onResolve, onPreview }: { ask: ApprovalItem; keyboard: boolean; onResolve: StretchProps["onResolve"]; onPreview?: StretchProps["onPreview"] }) {
	const { sharedServer } = useRemoteClientContext();
	if (askOpen(ask)) return <AskRow ask={ask} icon="tool" keyboard={keyboard} onResolve={onResolve} onPreview={onPreview} />;
	const { words, label, icon, notRun } = askOutcome(ask, sharedServer);
	return (
		<div className="wk-row" data-s={notRun ? "denied" : "done"}>
			<span className="wk-row-ic"><WorkIcon name={icon} /></span>
			{words === null ? <span className="wk-tx wk-wrap">{label}</span> : <span className="wk-tx">{words} · <b>{ask.title}</b></span>}
			<span className="wk-mk" />
		</div>
	);
}

/**
 * A finished turn that worked in several stretches: its cards and the short
 * notes between them fold into one card above the answer, with the head a
 * card of all its steps has, "Read 3 files, ran a command", and the turn's
 * whole time. A click shows them again under it. Over a step that shows its
 * line unopened it starts open, as that step's own card does.
 */
export function TurnCard({ foldId, steps, ms, children }: { foldId: string; steps: ReadonlyArray<StepPiece>; ms?: number; children: ReactNode }) {
	const open = useFoldChoice(foldId) ?? steps.some((step) => showsItsLine(step.item));
	const { sharedServer } = useRemoteClientContext();
	const folded = foldedHead(steps, sharedServer);
	return (
		<>
			<div className="bubble-row">
				<div className="wk-card wk-turn" data-open={open ? "1" : "0"} data-live="0">
					<CardHead live={false} waiting={false} label={folded.label} time={ms !== undefined ? durationText(ms) : ""} icons={folded.icons} mark={open ? "blank" : folded.mark} open={open} onToggle={() => setFoldChoice(foldId, !open)} />
				</div>
				{/* Opened, each stretch's card draws its own lines. */}
				{!open && <RoomAskAfterLines steps={steps} />}
			</div>
			<div className="wk-turnwork" data-open={open ? "1" : "0"}>
				<div>{open && children}</div>
			</div>
		</>
	);
}
