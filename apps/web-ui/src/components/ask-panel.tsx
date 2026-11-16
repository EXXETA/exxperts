import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ADDRESS, ALLOW_FOR_ROOM_PICK, ALLOW_THIS_TIME_PICK, ASK_PANEL_NAME, CARD_DECLINE, CHOOSE_ANOTHER_FOLDER, CHOOSE_FOLDER, CHOOSING, COMMANDS_ASK_LINES, folderAskLine, FOLDER_PANE_TITLE, FOLDER_PANEL_PRESSES, type FolderPanelPress, moreQuestionsLine, NOT_NOW, OUTSIDE_CARD_LINE, OUTSIDE_REASON_LABEL, OUTSIDE_RUN_DELAY_MS, OUTSIDE_RUN_ONCE, pageCardLines, ROOM_ASK_KINDS, ROOM_SAYS_LABEL, roomNeedsAnswer, RUNNING_NOW, RUNS_IN, SITE_ALLOW_ONCE, SITE_ALLOW_ROOM, SITE_CARD_RISK_LINE, TURN_ON_ANYWAY, TURN_ON_COMMANDS, WAITING_AT_COMPUTER } from "../../../web-server/src/room-box/card-text";
import { chordHeld, isMacPlatform, isTouchScreen } from "../platform";
import { useComposerEmpty } from "../question-keys";
import { useRemoteClientContext } from "../remote-client-context";
import type { ChatItem } from "../types";
import { composerTextarea } from "./Approval";
import { connectorAllowRoomLine, connectorApprovalSubject, connectorCutLine, connectorRiskLine, connectorSentLabel } from "../../../web-server/src/room-approval-titles";
import { answerer, refuseEnter, RoomAsksContext, type RoomAsks } from "./box-ask-rows";
import { WorkIcon, type WorkIconName } from "./ThinkingRow";

type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;
type Resolve = (requestId: string, value: unknown, label: string) => void;

/** The questions the panel above the message box shows: the room's folder and commands asks, a site a command or a page wants, a connector's tool, a command to run on Ask, and a command to run outside the room. Every other question stays in the steps. */
const PANEL_ASK_KINDS: ReadonlySet<string> = new Set(["folder", "commands", "site", "connector", "run", "outside"]);
export const inAskPanel = (ask: ApprovalItem): boolean => PANEL_ASK_KINDS.has(ask.uiKind);
/** A question only the computer answers: a phone shows it waiting there, with no answers. The server counts a phone's yes to running outside as a no. */
export const answeredAtComputer = (ask: ApprovalItem): boolean => ROOM_ASK_KINDS.has(ask.uiKind) || ask.uiKind === "outside";

/** How long the answers ignore a press after a question appears: a click or a key meant for what was there before lands on nothing. A yes also waits after the question changes or the window comes back to the front. */
const PAUSE_MS = 1_000;

// The keys reach the shown question through here: the message box and the
// page's own listener ask the one panel on the page, which decides from the
// same state its buttons draw from.
let shownKeys: { chord: (repeat: boolean) => boolean; escape: (repeat: boolean) => boolean } | null = null;
/** Cmd/Ctrl+Enter with nothing in the box and nothing queued: the shown question's Allow this time or Run once, once awake. True when it answered, or when a held-down key's repeat landed on it and did nothing. */
export function askPanelChord(repeat: boolean): boolean {
	return shownKeys?.chord(repeat) ?? false;
}
/** Escape: the shown question's no. True when it answered, or when it landed on the pause or a held-down key's repeat and did nothing. */
export function askPanelEscape(repeat: boolean): boolean {
	return shownKeys?.escape(repeat) ?? false;
}
// The message box's own Cmd/Ctrl+Enter, Send now: the panel hands the chord
// there when its answer doesn't take it, so a focused answer doesn't swallow it.
let boxChord: (() => void) | null = null;
/** Registers the message box's Send now for the chord pressed in the panel. */
export function useBoxChord(run: () => void): void {
	useLayoutEffect(() => {
		boxChord = run;
		return () => {
			if (boxChord === run) boxChord = null;
		};
	});
}

/** `off`: this answer takes no press now and is drawn disabled (the family's look): a press on this card waits for the server's reply (a yes's press has already moved the focus to the box), or Run once waits for the question to hold still. */
interface Answer { label: string; run: () => void; off?: boolean }
/** A path that needs more than one line breaks after a separator, so a folder's name stays whole on its line. */
function breaksAfterSeparators(path: string): ReactNode {
	return path.split(/(?<=[\\/])/).map((part, at) => (at ? [<wbr key={at} />, part] : part));
}

/** One question as the panel draws it. `main` is the answer at the right edge; `chord` when Cmd/Ctrl+Enter may give it. A fact's `action` sits at its end; a `stacked` fact's label takes a line of its own. */
interface PanelQuestion {
	icon: WorkIconName;
	/** A line before everything else the question shows: what a connector's tool may do. */
	lead?: string;
	/** A command to run, on Ask or outside the room, whole and as written, in a box of its own that scrolls. */
	command?: string;
	facts: Array<{ label: string; value: ReactNode; action?: Answer; stacked?: boolean }>;
	lines: string[];
	/** A refused pick's line, or a yes that couldn't be saved, from the server. */
	warning?: string;
	/** The line that says what the yes gives where it reaches all of a person's files: never the quietest on the panel. */
	risk?: string;
	no: Answer | null;
	lasting: Answer | null;
	main: (Answer & { chord: boolean }) | null;
}

/** The waiting line a phone shows for the room's own asks: only the computer answers them. */
const atComputer = (icon: WorkIconName): PanelQuestion => ({ icon, facts: [], lines: [`${WAITING_AT_COMPUTER}.`], no: null, lasting: null, main: null });

function roomSays(reason: string | undefined): PanelQuestion["facts"] {
	return reason ? [{ label: ROOM_SAYS_LABEL, value: reason }] : [];
}

/**
 * Each question's facts, lines and answers, by its kind. A no sends what the
 * steps' cards sent and folds at once; a yes, and each folder window press,
 * waits for the server's reply, which says what was taken. The run and
 * run-outside questions get no reply, so their Run once folds at once too.
 */
function panelQuestion(ask: ApprovalItem, at: { remote: boolean; sharedServer: boolean; roomAsks: RoomAsks | null; runningCommand: string | null; runReady: boolean; onResolve: Resolve }): PanelQuestion {
	const resolve = answerer(ask, at.onResolve);
	const { roomAsks } = at;
	const pressed = roomAsks?.pressed(ask.requestId);
	// While a press waits, or the folder window is open, only Not now still answers.
	const off = pressed !== undefined || !!ask.choosing;
	const yes = (value: unknown, label: string) => () => {
		if (!roomAsks) return resolve(value, label);
		roomAsks.press(ask.requestId, value);
		composerTextarea()?.focus();
	};
	if (ask.uiKind === "folder") {
		if (at.remote) return atComputer("folder");
		// With no folder window on this computer no folder can be chosen: Not now is left, and Allow this time where one click is offered.
		const picker = ask.canChoose !== false ? roomAsks : null;
		// The folder the server shows, by its real name and path; one click only where the server offers it.
		const folder = ask.suggested;
		const once = folder?.once === true;
		// A press the server is working on, or one this page sent and waits on: one that may open the window reads Choosing.
		const working = ask.choosing ?? pressed;
		const pressOf = (value: FolderPanelPress, label: string): Answer => ({ label: working === value && value !== FOLDER_PANEL_PRESSES.thisTime ? CHOOSING : label, run: yes(value, label), off });
		// Allow this time needs no window: it stays with one click where the folder window can't open.
		const thisTime = once && roomAsks ? pressOf(FOLDER_PANEL_PRESSES.thisTime, ALLOW_THIS_TIME_PICK) : null;
		const shown = folder ? [{ label: FOLDER_PANE_TITLE, value: <><bdi className="ask-name">{folder.name}</bdi><wbr /><bdi className="ask-path">{breaksAfterSeparators(folder.path)}</bdi></>, ...(picker && once ? { action: pressOf(FOLDER_PANEL_PRESSES.choose, CHOOSE_ANOTHER_FOLDER) } : {}) }] : [];
		return {
			icon: "folder",
			facts: [...shown, ...roomSays(ask.reason)],
			// What a yes gives stays wherever one is offered: where Allow this time gives the folder named here, the line says this folder.
			lines: picker || thisTime ? [folderAskLine(ask.access === "write" ? "write" : "read", thisTime ? "named" : "chosen")] : [],
			warning: ask.line,
			no: { label: NOT_NOW, run: () => resolve(false, NOT_NOW) },
			// No press is an answer: the question stays until the server says a folder was given, and a folder picked in the window is shown here first.
			lasting: picker && once ? pressOf(FOLDER_PANEL_PRESSES.room, ALLOW_FOR_ROOM_PICK) : null,
			main: thisTime ? { ...thisTime, chord: true } : picker ? { ...pressOf(FOLDER_PANEL_PRESSES.choose, CHOOSE_FOLDER), chord: false } : null,
		};
	}
	if (ask.uiKind === "commands") {
		if (at.remote) return atComputer("term");
		const turnOn = ask.anyway ? TURN_ON_ANYWAY : TURN_ON_COMMANDS;
		const line = ask.commandsLine ? COMMANDS_ASK_LINES[ask.commandsLine] : undefined;
		return {
			icon: "term",
			facts: roomSays(ask.reason),
			lines: line && !ask.anyway ? [line] : [],
			risk: ask.anyway ? line : undefined,
			warning: ask.failure,
			no: { label: NOT_NOW, run: () => resolve(false, NOT_NOW) },
			lasting: null,
			// Turning commands on lasts for the room: a click or Space only.
			main: { label: turnOn, run: yes(true, turnOn), off, chord: false },
		};
	}
	if (ask.uiKind === "run") {
		return {
			icon: "term",
			command: ask.command ?? "",
			facts: ask.folder ? [{ label: RUNS_IN, value: <bdi className="ask-path">{breaksAfterSeparators(ask.folder)}</bdi> }] : [],
			lines: [],
			// Saved as Decline, which the step's row reads as a no, as the card's Deny was.
			no: { label: NOT_NOW, run: () => resolve(false, CARD_DECLINE) },
			lasting: null,
			// A click or the chord, once the pause is over; a phone answers it too.
			main: { label: OUTSIDE_RUN_ONCE, run: () => resolve(true, OUTSIDE_RUN_ONCE), chord: true },
		};
	}
	if (ask.uiKind === "outside") {
		const facts = ask.reason ? [{ label: OUTSIDE_REASON_LABEL, value: ask.reason, stacked: true }] : [];
		// A phone can't answer it, but sending a message there ends it: what is asked stays readable, only the answers go.
		if (at.remote) return { icon: "tool", command: ask.command ?? "", facts, lines: [`${WAITING_AT_COMPUTER}.`], risk: OUTSIDE_CARD_LINE, no: null, lasting: null, main: null };
		return {
			icon: "tool",
			command: ask.command ?? "",
			facts,
			lines: [],
			risk: OUTSIDE_CARD_LINE,
			// The server sends no reply to either answer, so both fold at once. Not now is saved as Decline, which the steps read as a no.
			no: { label: NOT_NOW, run: () => resolve(false, CARD_DECLINE) },
			lasting: null,
			// A click only, once the question has held still: never Enter, never the chord.
			main: { label: OUTSIDE_RUN_ONCE, run: () => resolve(true, OUTSIDE_RUN_ONCE), off: !at.runReady, chord: false },
		};
	}
	if (ask.uiKind === "connector") {
		const cut = ask.cut ?? 0;
		const use = connectorApprovalSubject(ask.title);
		return {
			icon: "plug",
			lead: connectorRiskLine(ask.connector ?? ""),
			facts: [{ label: connectorSentLabel(cut), value: <code>{ask.sent ?? ""}</code>, stacked: true }],
			// What Allow for this room gives, wherever it is offered: never on a phone, whose yes is for this time.
			lines: [...(cut > 0 ? [connectorCutLine(cut)] : []), ...(ask.lasting && use ? [connectorAllowRoomLine(SITE_ALLOW_ROOM, use)] : [])],
			warning: ask.failure,
			// Saved as Decline, which the step's row reads as a no, as on the site question.
			no: { label: NOT_NOW, run: () => resolve("decline", CARD_DECLINE) },
			lasting: ask.lasting ? { label: SITE_ALLOW_ROOM, run: yes("room", SITE_ALLOW_ROOM), off } : null,
			main: { label: SITE_ALLOW_ONCE, run: yes("once", SITE_ALLOW_ONCE), off, chord: true },
		};
	}
	const page = ask.address !== undefined;
	const lines = page ? pageCardLines(ask.lasting === true, at.sharedServer) : [SITE_CARD_RISK_LINE];
	const facts = page ? [{ label: ADDRESS, value: <code>{ask.address}</code> }] : at.runningCommand ? [{ label: RUNNING_NOW, value: <code>{at.runningCommand}</code> }] : [];
	return {
		icon: "globe",
		facts,
		lines,
		warning: ask.failure,
		// Not now, as on the room's other questions; the answer is still saved as Decline, which the step's row reads as a no.
		no: { label: NOT_NOW, run: () => resolve("decline", CARD_DECLINE) },
		lasting: ask.lasting ? { label: SITE_ALLOW_ROOM, run: yes("room", SITE_ALLOW_ROOM), off } : null,
		main: { label: SITE_ALLOW_ONCE, run: yes("once", SITE_ALLOW_ONCE), off, chord: true },
	};
}

/**
 * The pause before an answer takes a press: it starts when `key` changes and,
 * with `onFocus`, again whenever the window comes to the front, which is also
 * how the page sees the folder window close. `awake` marks the answer for
 * assistive tech and the smokes; `awakeNow` is what a press asks.
 */
function usePause(key: string | null, onFocus: boolean): { awake: boolean; awakeNow: () => boolean } {
	const wakeAt = useRef(Number.POSITIVE_INFINITY);
	const [awake, setAwake] = useState(false);
	// Before paint, so no frame shows the new question as awake.
	useLayoutEffect(() => {
		if (key === null) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const pause = () => {
			wakeAt.current = Date.now() + PAUSE_MS;
			setAwake(false);
			clearTimeout(timer);
			timer = setTimeout(() => setAwake(true), PAUSE_MS);
		};
		const onVisible = () => {
			if (document.visibilityState === "visible") pause();
		};
		pause();
		if (!onFocus) return () => clearTimeout(timer);
		// Focus back from one of the page's own frames (a preview) pauses too: the page can't tell it from coming back from another window.
		window.addEventListener("focus", pause);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("focus", pause);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [key, onFocus]);
	return { awake, awakeNow: () => key !== null && Date.now() >= wakeAt.current };
}

const GATE_CHECK_MS = 100;

/**
 * Whether Run once may be pressed: the button has stayed where it is for the
 * delay. A question that moves goes back to waiting, so nothing can slide a
 * live button under the pointer. `key`: the question shown, or null when it
 * isn't one to run; a new one starts over.
 */
function useRunReady(key: string | null, button: RefObject<HTMLElement | null>): boolean {
	const [ready, setReady] = useState<{ key: string | null; ready: boolean }>({ key: null, ready: false });
	useEffect(() => {
		if (key === null) return;
		let lastTop: number | null = null;
		let stillSince = Date.now();
		const check = () => {
			const run = button.current;
			if (!run) return;
			const top = run.getBoundingClientRect().top;
			if (top !== lastTop) {
				lastTop = top;
				stillSince = Date.now();
			}
			const now = Date.now() - stillSince >= OUTSIDE_RUN_DELAY_MS;
			setReady((was) => (was.key === key && was.ready === now ? was : { key, ready: now }));
		};
		check();
		const timer = setInterval(check, GATE_CHECK_MS);
		return () => clearInterval(timer);
	}, [key, button]);
	// Before its first check a new question's Run once is off: no frame shows the last one's ready.
	return ready.key === key && ready.ready;
}

/**
 * The room's question, docked right above the message box: the oldest open
 * question, one at a time, with a line for how many more wait. A question
 * that arrives while one shows changes only that line. It takes no focus;
 * Escape is its no, and Cmd/Ctrl+Enter its Allow this time or Run once while
 * the box is empty and nothing is queued. Plain Enter gives no yes.
 * `asks`: the open questions of the panel's kinds asked on this connection, in
 * the order they came; `queued`: a message waits to be sent; `runningCommand`:
 * the newest command still running, as shown.
 */
export function AskPanel({ asks, roomName, queued, runningCommand, onResolve }: { asks: ApprovalItem[]; roomName: string; queued: boolean; runningCommand: string | null; onResolve: Resolve }) {
	const { remote, sharedServer } = useRemoteClientContext();
	const roomAsks = useContext(RoomAsksContext);
	const boxEmpty = useComposerEmpty();
	const shownId = useRef<string | null>(null);
	const shown = asks.find((ask) => ask.requestId === shownId.current) ?? asks[0] ?? null;
	shownId.current = shown?.requestId ?? null;
	const mainRef = useRef<HTMLButtonElement>(null);
	const runReady = useRunReady(shown?.uiKind === "outside" && !remote ? shown.requestId : null, mainRef);
	const question = shown ? panelQuestion(shown, { remote, sharedServer, roomAsks, runningCommand, runReady, onResolve }) : null;
	// For a yes, every frame the server sends for the card starts the pause again: the card came back, or changed under the pointer.
	const { awake, awakeNow } = usePause(shown ? `${shown.requestId}\n${shown.shownAt ?? shown.openedAt ?? ""}` : null, true);
	// Not now and Escape wait only when a question newly shows here, the first one or the next in an answered one's place: a no gives nothing away.
	const { awake: noAwake, awakeNow: noAwakeNow } = usePause(shown?.requestId ?? null, false);
	const touch = isTouchScreen();
	const main = question?.main ?? null;
	const chordTaken = () => !!main?.chord && boxEmpty && !queued;
	const chordAnswers = () => chordTaken() && !main?.off && awakeNow();

	// The next question starts from its top: a panel scrolled down to the last one's Not now would hide it.
	const panelRef = useRef<HTMLElement>(null);
	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;
		panel.scrollTop = 0;
		const words = panel.querySelector(".ask-panel-in");
		if (words) words.scrollTop = 0;
	}, [shown?.requestId]);

	// A screen reader hears each new question once, in the notification's words, and a folder the panel comes to show as a new question with that folder.
	const [heard, setHeard] = useState("");
	const heardFolder = shown?.suggested?.name;
	useEffect(() => {
		setHeard(shown ? `${roomNeedsAnswer(roomName)}: ${shown.title}${heardFolder ? ` ${FOLDER_PANE_TITLE}: ${heardFolder}` : ""}` : "");
	}, [shown?.requestId, heardFolder]);

	useLayoutEffect(() => {
		// A held-down key's repeats answer nothing: only a fresh press does.
		const keys = {
			chord: (repeat: boolean) => {
				if (repeat) return chordTaken();
				if (!main || !chordAnswers()) return false;
				main.run();
				return true;
			},
			escape: (repeat: boolean) => {
				if (!question?.no) return false;
				if (noAwakeNow() && !repeat) question.no.run();
				return true;
			},
		};
		shownKeys = keys;
		return () => {
			if (shownKeys === keys) shownKeys = null;
		};
	});

	const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (event.key === "Escape" && question?.no) {
			event.preventDefault();
			event.stopPropagation();
			if (noAwakeNow() && !event.repeat) question.no.run();
			return;
		}
		// The chord never presses the focused button: it answers Allow this time or Run once, or it is the box's Send now.
		if (event.key === "Enter" && chordHeld(event.nativeEvent) && !event.shiftKey && !event.altKey) {
			event.preventDefault();
			event.stopPropagation();
			if (event.repeat && chordTaken()) return;
			if (main && chordAnswers()) main.run();
			else if (!boxEmpty || queued) boxChord?.();
		}
	};

	// Every answer waits out its pause, so a second click meant for the question before lands on nothing.
	const press = (answer: Answer, ready = awakeNow) => () => {
		if (ready() && !answer.off) answer.run();
	};

	return (
		<>
			<p className="sr-only" aria-live="polite">{heard}</p>
			{shown && question && (
				<section ref={panelRef} className="ask-panel" aria-label={ASK_PANEL_NAME} data-box-empty={boxEmpty ? "1" : "0"} onKeyDown={onKeyDown}>
					<p className="ask-title"><WorkIcon name={question.icon} /><span>{shown.title}</span></p>
					{(question.lead || question.command !== undefined || question.facts.length > 0 || question.lines.length > 0 || question.risk || question.warning) && (
						// Only the facts scroll, between the question and its answers; a fade at each end that hides words says more are there.
						<div className="ask-panel-in">
							<span className="ask-fade" data-end="top" aria-hidden="true" />
							<div className="ask-words">
								{question.lead && <p className="ask-line">{question.lead}</p>}
								{/* Text, never Markdown, with every hidden character already written out by the server; a keyboard reaches it to scroll it. */}
								{question.command !== undefined && <pre key={shown.requestId} className="ask-command" tabIndex={0} aria-label="The full command">{question.command}</pre>}
								{/* What the yes gives sits right under the command, before the model's reason, so no reason pushes it out of view. */}
								{question.command !== undefined && question.risk && <p className="ask-line ask-risk">{question.risk}</p>}
								{question.facts.length > 0 && (
									<dl className="ask-facts">
										{question.facts.map((fact) => (
											<div key={fact.label} className={fact.action ? "ask-fact ask-fact-with-answer" : fact.stacked ? "ask-fact ask-fact-stacked" : "ask-fact"}>
												<dt>{fact.label}</dt>
												<dd>{fact.value}</dd>
												{fact.action && <button type="button" className="rs-btn rs-btn-quiet rs-btn-sm" aria-disabled={!awake || !!fact.action.off} disabled={!!fact.action.off} onKeyDown={refuseEnter} onClick={press(fact.action)}>{fact.action.label}</button>}
											</div>
										))}
									</dl>
								)}
								{question.lines.map((line) => <p key={line} className="ask-line">{line}</p>)}
								{question.command === undefined && question.risk && <p className="ask-line ask-risk">{question.risk}</p>}
								{question.warning && <p className="ask-line ask-warning" role="status">{question.warning}</p>}
							</div>
							<span className="ask-fade" data-end="bottom" aria-hidden="true" />
						</div>
					)}
					{question.no && (
						<div className="ask-actions">
							<button type="button" className="rs-btn rs-btn-sm" aria-disabled={!noAwake} onClick={press(question.no, noAwakeNow)}>
								{!touch ? (
									<span className="ask-key-slot ask-esc-slot">
										<span className="ask-key-with">{question.no.label}<kbd className="ask-esc">Esc</kbd></span>
										<span className="ask-key-alone">{question.no.label}</span>
									</span>
								) : question.no.label}
							</button>
							<span className="ask-actions-end">
								{question.lasting && <button type="button" className="rs-btn rs-btn-sm" aria-disabled={!awake || !!question.lasting.off} disabled={!!question.lasting.off} onKeyDown={refuseEnter} onClick={press(question.lasting)}>{question.lasting.label}</button>}
								{main && (
									<button type="button" ref={mainRef} className="rs-btn rs-btn-sm rs-btn-primary" aria-disabled={!awake || !!main.off} disabled={!!main.off} data-awake={awake ? "1" : "0"} onKeyDown={refuseEnter} onClick={press(main)}>
										{/* The words with the hint always set the width, so the answers never shift under the pointer. While the chord is the box's Send now, the words alone show centred in that width. The pause changes nothing on the button; while it is off, the chord answers nothing and its hint goes. */}
										{!touch && main.chord ? (
											<span className="ask-key-slot ask-chord-slot" data-on={boxEmpty && !queued && !main.off ? "1" : "0"}>
												<span className="ask-key-with">{main.label}<kbd className="ask-chord">{isMacPlatform() ? "⌘↵" : "Ctrl+Enter"}</kbd></span>
												<span className="ask-key-alone">{main.label}</span>
											</span>
										) : main.label}
									</button>
								)}
							</span>
						</div>
					)}
					{asks.length > 1 && <p className="ask-more">{moreQuestionsLine(asks.length - 1)}</p>}
				</section>
			)}
		</>
	);
}
