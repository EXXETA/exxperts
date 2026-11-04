import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { ChatItem } from "../types";
import type { ApprovalPreviewData } from "../approval-preview";
import { approvalPreviewFromItem } from "../approval-preview";
import { isThoughtOpen } from "../thinking-text-store";
import { commandDeclined, lastName, nobodyToApprove, readableToolName, stepOutcome } from "../step-lines";
import { MEMORY_RECALL_STEP, memoryRecallDisplayText } from "../memory-recall-display";
import { useRemoteClientContext } from "../remote-client-context";
import { isMacPlatform } from "../platform";
import { messageDeclinesQuestion, useComposerEmpty, useDraftStartedAt, useEnterReachesQuestion } from "../question-keys";
import { askedCommand, askOpen, commandAction, commandSentence, durationText, foldedWords, itemKind, sizeText, stepResultWords, stepState, stepTime, workPieces, type StepKind, type StepState, type WorkPiece } from "../work-look";
import { approvalMetadata, composerTextarea, confirmApprovalLabels, declinedAnswer, splitFencedBrief } from "./Approval";
import { handOffApprovalSubject, SPECIALISTS_OFF_SENTENCE } from "../../../web-server/src/room-approval-titles";
import { domainOf, GENERIC_TOOL_VIEWS, isMarkdownResult, mcpChipView, ResultBody, runningForText, summariseToolArgs } from "./Message";
import { Label, ThinkingCardRow, ThinkingRow, useNow, useOffscreen, WorkIcon, type WorkIconName } from "./ThinkingRow";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;

const KIND_ICONS: Record<StepKind, WorkIconName> = {
	read: "file", write: "pen", edit: "pen", command: "term", search: "search", web: "globe", page: "globe",
	list: "folder", handoff: "handoff", connector: "plug", memory: "book", skill: "book", other: "tool",
};

/** The present, past and failed verb of a step, and what it acts on: "Reading" / "Read" / "Couldn't read", "limits.json". */
function stepVerbs(item: ToolItem): { verbs: [string, string, string]; name: string; where?: string; code?: boolean } {
	const args = item.args && typeof item.args === "object" ? item.args : {};
	const quoted = (value: unknown) => (typeof value === "string" && value.trim() ? `“${value.trim().slice(0, 80)}”` : "");
	switch (item.name) {
		case "bash": {
			const { verbs, name, where, code } = commandSentence(commandAction(String(args.command ?? "")));
			return { verbs: [verbs[1], verbs[2], verbs[3]], name, where, code };
		}
		case "read": return { verbs: ["Reading", "Read", "Couldn't read"], name: lastName(String(args.path ?? "")) };
		case "read_file": return { verbs: ["Reading", "Read", "Couldn't read"], name: String(args.name ?? "") };
		case "write": return { verbs: ["Writing", "Wrote", "Couldn't write"], name: lastName(String(args.path ?? "")) };
		case "edit": return { verbs: ["Editing", "Edited", "Couldn't edit"], name: lastName(String(args.path ?? "")) };
		case "ls": {
			const folder = lastName(String(args.path ?? ""));
			return { verbs: ["Listing", "Listed", "Couldn't list"], name: folder && folder !== "." ? folder : "the folder" };
		}
		case "find": return { verbs: ["Looking for", "Looked for", "Couldn't look for"], name: String(args.pattern ?? "") };
		case "grep": return { verbs: ["Searching for", "Searched for", "Couldn't search for"], name: quoted(args.pattern), where: args.path ? lastName(String(args.path)) : undefined };
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
		case "read_skill": return { verbs: ["Reading the skill", "Read the skill", "Couldn't read the skill"], name: String(args.name ?? args.skill ?? "") };
		case "mcp": {
			if (args.tool) return { verbs: ["Using", "Used", "Couldn't use"], name: String(args.tool), where: mcpChipView(args, item.details).summary || undefined };
			const view = mcpChipView(args, item.details);
			return { verbs: [view.name.replace(/^\S+\s/, ""), view.name.replace(/^\S+\s/, ""), "Couldn't reach the connector"], name: view.summary };
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
function finishedWords(item: ToolItem, state: "done" | "failed"): string {
	const { verbs, name, where } = stepVerbs(item);
	const verb = verbs[state === "done" ? 1 : 2];
	return name ? `${verb} ${name}${where ? ` in ${where}` : ""}` : bareVerb(verb);
}

type StepOutcome = ReturnType<typeof stepOutcome>;

/**
 * An old hand-off card left waiting: specialists are switched off, so it can
 * never start and says why instead of asking. Read from the card alone, since
 * an old step comes back stopped, or still running when it was saved mid-turn.
 */
function handOffLeftWaiting(ask: ApprovalItem | undefined): boolean {
	return !!ask?.unanswered && handOffApprovalSubject(ask.title) !== null;
}

/** Where a step stands as its row shows it: a refusal (the app's rules or the room's settings kept it from running) reads calm, apart from a failure. */
function rowState(item: ToolItem, ask: ApprovalItem | undefined, sharedServer: boolean): { state: StepState; outcome: StepOutcome | null } {
	if (handOffLeftWaiting(ask) && item.status !== "done") return { state: "denied", outcome: null };
	const state = stepState(item, ask);
	const outcome = state === "failed" && typeof item.result === "string" ? stepOutcome(item.result, item, sharedServer) : null;
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

/** A folded card's head from its steps: what they did, the kinds of the first three, and its mark: the check once every step worked, the failed mark when one failed. */
function foldedHead(steps: ReadonlyArray<StepPiece>, sharedServer: boolean): { label: string; kinds: StepKind[]; mark: HeadMark } {
	const states = steps.map((step) => rowState(step.item, step.ask, sharedServer).state);
	return {
		label: foldedWords(steps),
		kinds: [...new Set(steps.map((step) => itemKind(step.item)))].slice(0, 3),
		mark: states.includes("failed") ? "failed" : states.length > 0 && states.every((state) => state === "done") ? "check" : "blank",
	};
}

/** A head's mark: the check, the failed mark, an empty place ("blank"), or no place at all (null). */
type HeadMark = "check" | "failed" | "blank" | null;

/**
 * A card's one line: the live dot or the steps' icons, the words, the time,
 * its mark, and the arrow. The mark's place and the arrow's line its time up
 * with what stands beside it: other cards' heads keep both, an opened card's
 * rows (which carry their own marks) take the mark's place away. Without
 * `onToggle` there is nothing to open: no button, the arrow's place empty.
 */
function CardHead({ live, waiting, label, sentence, time, kinds, mark, open, onToggle }: { live: boolean; waiting: boolean; label: string; sentence?: ReactNode; time: string; kinds: StepKind[]; mark: HeadMark; open: boolean; onToggle?: () => void }) {
	const working = live || waiting;
	const parts = (
		<>
			<span className="wk-lead">
				{working ? <span className="wk-dot" /> : kinds.map((kind) => <span key={kind} className="wk-stack"><WorkIcon name={KIND_ICONS[kind]} /></span>)}
			</span>
			<span className="wk-label"><Label text={label} className={live && !waiting ? "wk-sweep" : ""}>{sentence}</Label></span>
			{time && <span className="wk-time">{time}</span>}
			{mark && <span className="wk-hmk">{mark === "check" ? <WorkIcon name="check" className="wk-ok" /> : mark === "failed" ? <WorkIcon name="x" className="wk-bad" /> : null}</span>}
			{onToggle ? <WorkIcon name="chev" className="wk-caret" /> : <span className="wk-noarrow" />}
		</>
	);
	return onToggle ? <button type="button" className="wk-head" aria-expanded={open} onClick={onToggle}>{parts}</button> : <div className="wk-head">{parts}</div>;
}

/**
 * One card per stretch of work. While it works: a live header ("Working",
 * or amber "Waiting for your OK" while a step asks), and a row per step.
 * Once something comes after it, it folds to one line of what was done and
 * how long it took, with a check when every step worked; a click opens it again.
 * A finished card whose one step worked or failed says that step's own
 * sentence. Alone, it opens straight to what its row would show under it, so
 * the sentence shows once; with nothing to show, it does not open. Beside
 * the model's thinking, it opens to the thoughts' rows and its own, already
 * open. A step that did not run keeps its row, which says why.
 */
function WorkCard({ pieces, live, endTs, elsewhere, keyboardApprovalId, onResolve, onPreview }: StretchProps & { pieces: WorkPiece[] }) {
	const waiting = pieces.some((piece) => (piece.kind === "step" || piece.kind === "ask") && askOpen(piece.kind === "step" ? piece.ask : piece.item));
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
	const sole = !working && steps.length === 1 && pieces.every((piece) => piece.kind !== "ask") ? steps[0] : null;
	const soleRow = sole ? rowState(sole.item, sole.ask, sharedServer) : null;
	const only = sole && soleRow && (soleRow.state === "done" || soleRow.state === "failed") ? { item: sole.item, state: soleRow.state, outcome: soleRow.outcome } : null;
	const solo = only && pieces.length === 1;
	const details = solo ? stepDetails(only.item, only.state, only.outcome) : null;
	const opens = !solo || details !== null;
	const open = opens && (choice ?? (working || overOpenThought()));
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
		label = waiting ? "Waiting for your OK" : "Working";
		time = start !== undefined ? runningForText(now - start) : "";
	} else {
		label = only ? finishedWords(only.item, only.state) : folded.label;
		if (only) {
			const { verbs, ...what } = stepVerbs(only.item);
			if (what.code) sentence = <StepSentence verb={verbs[only.state === "done" ? 1 : 2]} {...what} />;
		}
		time = start !== undefined && endTs !== undefined && endTs >= start ? durationText(endTs - start) : "";
	}
	// The earlier rows fold behind one button, but never a thought the person opened, nor a question waiting for them.
	const cut = !showAll && pieces.length > ROW_CAP + 1 ? pieces.length - ROW_CAP : 0;
	const kept = (piece: WorkPiece) => (piece.kind === "thinking" ? isThoughtOpen(piece.item.id) : askOpen(piece.kind === "step" ? piece.ask : piece.item));
	const shown = cut ? pieces.filter((piece, index) => index >= cut || kept(piece)) : pieces;
	const hidden = pieces.length - shown.length;
	return (
		<div className="bubble-row">
			<div className={`wk-card${waiting ? " waiting" : ""}`} data-open={open ? "1" : "0"} data-live={working ? "1" : "0"} ref={ref}>
				{/* Folded, the card is the one row its steps show: it carries their mark; opened, its rows do and its head gives the mark's place up to line its time up with theirs, unless it is one step's card. */}
				<CardHead live={live} waiting={waiting} label={label} sentence={sentence} time={time} kinds={folded.kinds} mark={working || (open && !solo) ? null : folded.mark} open={open} onToggle={opens ? () => setFoldChoice(foldId, !open) : undefined} />
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
		</div>
	);
}

/** Why a step did not run, in grey: the person said no, nobody was there, or Stop came first. */
function notRunWords(item: ToolItem, ask: ApprovalItem | undefined): string {
	if (ask?.stopped) return "Not run · you pressed Stop";
	if (commandDeclined(item.result) || (ask?.done && declinedAnswer(ask.done))) return "Not run · you said no";
	if (nobodyToApprove(item.result)) return "Not run · nobody was there to answer";
	return "Not run";
}

/** `opensWith`: the card's own open, for the one step of a card; the row opens each time the card does, so its output is one click from the folded card. */
function StepRow({ item, ask, elsewhere, keyboard, onResolve, onPreview, opensWith }: { item: ToolItem; ask?: ApprovalItem; elsewhere: boolean; keyboard: boolean; onResolve: StretchProps["onResolve"]; onPreview?: StretchProps["onPreview"]; opensWith?: boolean }) {
	const { sharedServer } = useRemoteClientContext();
	const [open, setOpen] = useState(!!opensWith);
	// Before paint, so the card never shows the row closed for a frame as it opens.
	useLayoutEffect(() => {
		if (opensWith) setOpen(true);
	}, [opensWith]);
	const { state, outcome } = rowState(item, ask, sharedServer);
	const { verbs, ...what } = stepVerbs(item);
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
		sentence = item.name === "bash" ? <StepSentence verb="Command" name={String(item.args?.command ?? "").slice(0, 160)} /> : <StepSentence verb={verbs[0]} {...what} />;
		meta = typeof item.args?.sizeSoFar === "number" && item.args.sizeSoFar > 0 ? sizeText(item.args.sizeSoFar) : "";
	} else if (state === "running") {
		sentence = <StepSentence verb={verbs[0]} {...what} />;
		// The card's timer ticks every second, and with it the running row's own.
		meta = item.startedAt !== undefined ? runningForText(Date.now() - item.startedAt) : "";
	} else if (state === "done") {
		sentence = <StepSentence verb={verbs[1]} {...what} />;
		meta = [stepResultWords(item), stepTime(item)].filter(Boolean).join(" · ");
	} else if (state === "failed") {
		sentence = <StepSentence verb={verbs[2]} {...what} />;
		meta = stepTime(item);
	} else if (state === "denied") sentence = outcome?.refused ? <>{outcome.line}</> : leftWaiting ? <>{SPECIALISTS_OFF_SENTENCE}</> : <>{notRunWords(item, ask)}{name ? <> · <StepName name={name} code={code} /></> : null}</>;
	else sentence = <>Stopped · <StepSentence verb={verbs[0]} {...what} /></>;

	const icon: WorkIconName = goesOnElsewhere ? "away" : leftWaiting || state === "stopped" ? "stop" : state === "denied" ? "ban" : KIND_ICONS[kind];
	const body = stepBody(item, state);
	const live = !goesOnElsewhere && (state === "running" || state === "writing");
	const mark = live ? <span className="wk-spin" /> : state === "done" ? <WorkIcon name="check" className="wk-ok" /> : state === "failed" ? <WorkIcon name="x" className="wk-bad" /> : null;
	return (
		<>
			<div className="wk-row" data-s={goesOnElsewhere ? "elsewhere" : state}>
				<span className="wk-row-ic"><WorkIcon name={icon} /></span>
				{body ? (
					<button type="button" className="wk-tx wk-open" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{sentence}</button>
				) : (
					<span className={`wk-tx${live ? " wk-sweep" : ""}${leftWaiting ? " wk-wrap" : ""}`}>{sentence}</span>
				)}
				{meta && <span className="wk-meta">{meta}</span>}
				<span className="wk-mk">{mark}</span>
			</div>
			{state === "failed" && outcome?.line && <div className="wk-line">{outcome.line}</div>}
			{open && body}
		</>
	);
}

/** What a card of one finished step opens to: what its row shows under it (why it failed) and what the row opens to. Null when there is nothing. */
function stepDetails(item: ToolItem, state: "done" | "failed", outcome: StepOutcome | null): ReactNode {
	const line = state === "failed" && outcome?.line ? <div className="wk-line">{outcome.line}</div> : null;
	const body = stepBody(item, state);
	return line || body ? <>{line}{body}</> : null;
}

/** What a row opens to: the command and what came back, the first lines of a file. Null when there is nothing to show. */
function stepBody(item: ToolItem, state: StepState): ReactNode {
	if (state === "running" || state === "writing" || state === "asking") return null;
	const command = item.name === "bash" ? String(item.args?.command ?? "") : "";
	const result = typeof item.result === "string" && item.result.trim() ? item.result : "";
	if (!command && !result) return null;
	return (
		<div className="wk-out">
			{command && <pre className="wk-command">{command}</pre>}
			{result && <ResultBody markdown={isMarkdownResult(item)} text={item.name === "memory_recall" ? memoryRecallDisplayText(result) : result} />}
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
	const preview = useMemo(() => approvalPreviewFromItem(ask), [ask.requestId, ask.done, ask.detail, ask.message, ask.title]);
	const fenced = preview ? null : (splitFencedBrief(ask.message) ?? splitFencedBrief(ask.detail));
	// What the server asks about, not what the step was written with: the person allows the command it shows.
	const asked = askedCommand(ask);
	const command = asked ?? (item?.name === "bash" ? String(item.args?.command ?? "") : "");
	const metadata = preview ? approvalMetadata(ask.title, ask.detail || ask.message) : [];
	const boxEmpty = useComposerEmpty();
	const touch = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(hover: none), (max-width: 720px)").matches;
	const keysWork = keyboard && boxEmpty && !touch;
	// Enter reaches the question from the page and the box, or presses Allow when it has the focus itself.
	const enterFromPage = useEnterReachesQuestion();
	const [allowFocused, setAllowFocused] = useState(false);
	const enterWorks = keysWork && (enterFromPage || allowFocused);
	// The person started typing after this step asked: sending their message says no to it.
	const draftStartedAt = useDraftStartedAt();
	const sendDenies = !boxEmpty && messageDeclinesQuestion(ask.openedAt, draftStartedAt);
	const [text, setText] = useState("");
	// The facts the app wrote above the fence: a specialist's (what it may write) behind Details; a command's are not shown.
	const facts = asked === null ? fenced?.facts ?? "" : "";
	const [detailsOpen, setDetailsOpen] = useState(false);
	const allowRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (preview) onPreview?.(preview);
	}, [ask.requestId, preview, onPreview]);

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
		if (event.key !== "Escape") return;
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
	if (item?.name === "bash") {
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
		<div className="wk-row wk-ask" data-s="asking" onKeyDown={onKeyDown}>
			<span className="wk-row-ic"><WorkIcon name={icon} /></span>
			<div className={`wk-tx${named === "first-line" ? " wk-one" : ""}`}>{title}</div>
			{(sub || sendDenies || metadata.length > 0 || facts || ask.uiKind === "input") && (
				<div className="wk-ask-body">
					{sub && <div className="wk-ask-sub">{sub}</div>}
					{sendDenies && <div className="wk-ask-denies">Sending your message denies this step.</div>}
					{metadata.length > 0 && <div className="wk-ask-meta">{metadata.map((line) => <div key={line}>{line}</div>)}</div>}
					{facts && <button type="button" className="wk-ask-more" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>{detailsOpen ? "Hide details" : "Details"}</button>}
					{facts && detailsOpen && <div className="wk-ask-facts">{facts}</div>}
					{ask.uiKind === "input" && <textarea className="wk-ask-input" value={text} rows={3} placeholder={ask.placeholder ?? "Your answer…"} onChange={(event) => setText(event.target.value)} />}
				</div>
			)}
			<div className="wk-ask-btns">
				{ask.uiKind === "confirm" && (
					<>
						{/* A press keeps the focus where it is: on Deny, Enter would be Deny's, so Allow would drop its key, and the narrower Allow
						    would pull Deny from under the pointer before the click lands. */}
						<button type="button" className="wk-btn" onMouseDown={(event) => event.preventDefault()} onClick={() => resolve(false, labels.decline)}>Deny{keysWork && <kbd>Esc</kbd>}</button>
						<button type="button" className="wk-btn primary" ref={allowRef} onFocus={() => setAllowFocused(true)} onBlur={() => setAllowFocused(false)} onClick={() => resolve(true, labels.approve)}>Allow{enterWorks && <kbd>{enterKey()}</kbd>}</button>
					</>
				)}
				{ask.uiKind === "select" && (ask.options ?? []).map((option) => {
					const lower = option.toLowerCase();
					const primary = lower === "approve" || lower === "yes";
					return <button key={option} type="button" className={`wk-btn${primary ? " primary" : ""}`} ref={primary ? allowRef : undefined} onClick={() => resolve(option, option)}>{option}</button>;
				})}
				{ask.uiKind === "input" && (
					<>
						<button type="button" className="wk-btn" onClick={() => resolve(undefined, "Cancelled")}>Cancel</button>
						<button type="button" className="wk-btn primary" onClick={() => resolve(text, text ? "Submitted" : "(empty)")}>Submit</button>
					</>
				)}
			</div>
		</div>
	);
}

/** A question no step is known for: open, it asks as a step would; answered, one quiet row says what was decided. */
function LoneAskRow({ ask, keyboard, onResolve, onPreview }: { ask: ApprovalItem; keyboard: boolean; onResolve: StretchProps["onResolve"]; onPreview?: StretchProps["onPreview"] }) {
	if (askOpen(ask)) return <AskRow ask={ask} icon="tool" keyboard={keyboard} onResolve={onResolve} onPreview={onPreview} />;
	const declined = ask.stopped || declinedAnswer(ask.done);
	const specialistsOff = handOffLeftWaiting(ask);
	const words = ask.stopped ? "Not done · you pressed Stop" : ask.unanswered ? "Not answered" : declined ? "Not done · you said no" : /^(yes\b|approve)/i.test(ask.done ?? "") ? "Allowed" : ask.done && !/^(submitted|\(empty\))/i.test(ask.done) ? `You chose ${ask.done}` : "Answered";
	return (
		<div className="wk-row" data-s={declined || ask.unanswered ? "denied" : "done"}>
			<span className="wk-row-ic"><WorkIcon name={specialistsOff ? "stop" : declined ? "ban" : "check"} /></span>
			{specialistsOff ? <span className="wk-tx wk-wrap">{SPECIALISTS_OFF_SENTENCE}</span> : <span className="wk-tx">{words} · <b>{ask.title}</b></span>}
			<span className="wk-mk" />
		</div>
	);
}

/**
 * A finished turn that worked in several stretches: its cards and the short
 * notes between them fold into one card above the answer, with the head a
 * card of all its steps has, "Read 3 files, ran a command", and the turn's
 * whole time. A click shows them again under it.
 */
export function TurnCard({ foldId, steps, ms, children }: { foldId: string; steps: ReadonlyArray<StepPiece>; ms?: number; children: ReactNode }) {
	const open = useFoldChoice(foldId) ?? false;
	const { sharedServer } = useRemoteClientContext();
	const folded = foldedHead(steps, sharedServer);
	return (
		<>
			<div className="bubble-row">
				<div className="wk-card wk-turn" data-open={open ? "1" : "0"} data-live="0">
					<CardHead live={false} waiting={false} label={folded.label} time={ms !== undefined ? durationText(ms) : ""} kinds={folded.kinds} mark={open ? "blank" : folded.mark} open={open} onToggle={() => setFoldChoice(foldId, !open)} />
				</div>
			</div>
			<div className="wk-turnwork" data-open={open ? "1" : "0"}>
				<div>{open && children}</div>
			</div>
		</>
	);
}
