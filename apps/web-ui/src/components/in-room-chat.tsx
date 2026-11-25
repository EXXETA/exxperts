import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, CSSProperties, KeyboardEvent, MutableRefObject, ReactNode, Ref } from "react";
import { answersHere, keyboardAnswers } from "./Approval";
import { BubbleEditor, ConsultThreadItem, Message, QueuedBubbles, TaskThreadItem, type FailureLineActions, type MessageAttachmentAccess, type QueuedBubbleActions } from "./Message";
import type { QueuedBubble } from "../outgoing-messages";
import { MentionConsultPopover, MentionConsultPopoverBusy, type MentionSupport } from "./mention-consult-popover";
import { SkillPickList } from "./skill-pick-list";
import { BACK_TO_ROOMS_LABEL } from "../back-to-rooms-label";
import { draftAfterSkillPick, filterSkillPicks, skillPickEntries, skillPickQuery, type SkillPickEntry } from "../skill-pick-list";
import { fetchSkills } from "../skills-api";
import { fetchPersistentRoomSkillSettings } from "../persistent-room-management-api";
import { escapeLayerOpen, useEscapeKey } from "./use-escape-key";
import { foldChoiceOf, TurnCard, WorkStretch } from "./work-card";
import { RunningAnswerSteps } from "./box-ask-rows";
import { askPanelChord, askPanelEscape, useBoxChord } from "./ask-panel";
import { isThoughtOpen } from "../thinking-text-store";
import { isWorkItem, workPieces } from "../work-look";
import { enterReachesQuestion, isTextField, setComposerEmpty } from "../question-keys";
import { SidebarDrawerBackdrop, usePhoneWidth } from "../sidebar-collapse";
import type { ApprovalPreviewData } from "../approval-preview";
import type { ChatItem, ContextHealthStatus } from "../types";
import { ANOTHER_ROOM, askHint, askingWords, detectMentionQuery, draftAfterPick, filterMentionCandidates, labelAtFirstSpace, laterMentionRoom, listedRoom, ROOM_GONE, TYPE_QUESTION, type MentionCandidateRoom } from "../mention-popover";
import { replyCopyTargets } from "../reply-copy";
import { chordHeld } from "../platform";
import { formatModelWithProvider } from "../model-names";
import { knownRemoteClientContext, mayBeOnSharedServer, useRemoteClientContext } from "../remote-client-context";

export interface InRoomChatUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens: number;
	contextTokens?: number | null;
}

export interface InRoomChatShellViewProps {
	sidebar: ReactNode;
	/** Phone-only affordance (hidden by CSS above the breakpoint): the rail
	 *  is a drawer there, so the topbar carries a direct way home. */
	onHome?: () => void;
	withPreview?: boolean;
	activeDisplay: string;
	ownerSecondary?: string | null;
	busy: boolean;
	usage: InRoomChatUsage;
	contextHealth?: ContextHealthStatus | null;
	/** The model's canonical name, shown as given: a gateway's saved name can hold a dash. */
	currentModelLabel?: string | null;
	/** Provider behind that label. Tooltip only; the face stays the bare name. */
	currentModelProvider?: string | null;
	topbarActions?: ReactNode;
	composerRightActions?: ReactNode;
	/** The paperclip: inside the box, at the left on wider screens and beside Remember on the phone. */
	composerAttachSlot?: ReactNode;
	/** Remember (and on the phone the command mode before it): in the row under the box on wider screens, inside the box on the phone. */
	composerRememberSlot?: ReactNode;
	/** The model and effort control, drawn for where the layout puts it: the row under the box, or the phone's header. */
	composerModelSlot?: (placement: "row" | "header") => ReactNode;
	/** Files UI slice: staged-attachment chips above the composer textarea. */
	composerStagingSlot?: ReactNode;
	/** Files UI slice: staged attachments make an attachments-only send legal. */
	composerAllowEmptySend?: boolean;
	/** Image files pasted into the textarea are handed here to be staged. */
	composerOnPasteFiles?: (files: File[]) => void;
	connected: boolean;
	/** Room auto-reconnect: "reconnecting" while backoff attempts run, "failed" once capped. */
	reconnectState?: "idle" | "reconnecting" | "failed";
	/** Starts a fresh reconnect cycle immediately (the "Reconnect" affordance when failed). */
	onReconnect?: () => void;
	/** The room stopped because its model cannot run (a signed-out provider, a model no longer offered), not a lost connection: one notice with the ways on, and no Reconnect. */
	connectionStopped?: ConnectionStopped;
	items: ChatItem[];
	empty: boolean;
	messagesRef?: Ref<HTMLDivElement>;
	onSend: (text: string) => boolean;
	onStop?: () => void;
	/** While the room answers, Stop shows with an empty box; Send takes its place once text is typed. */
	stopVisible?: boolean;
	stopDisabled?: boolean;
	stopLabel?: string;
	/** Cmd/Ctrl+Enter with text: send now, stopping the answer at the words on screen. */
	onSendNow?: (text: string) => boolean;
	/** Cmd/Ctrl+Enter in an empty box: the first queued message goes now. */
	onSendQueuedNow?: () => boolean;
	/** While the room answers: why the box cannot queue this text (`asking`: to the room on its label, by id), or null; Send greys with it as its hover. */
	queueRefusal?: (text: string, asking: string | null) => string | null;
	/** Esc while the room answers, nothing else taking it: true when it stopped the answer. */
	onEscapeStop?: () => boolean;
	/** Messages the room has not taken, drawn as "Queued" bubbles under the answer. */
	queued?: ReadonlyArray<QueuedBubble>;
	queuedActions?: QueuedBubbleActions;
	textareaRef?: Ref<HTMLTextAreaElement>;
	composerPlaceholder: string;
	sendUnavailable?: boolean;
	initialDraftValue?: string;
	/** The room on the box's label when the box is filled again (draftResetKey), by its id. */
	initialAsking?: string | null;
	draftResetKey?: string | number;
	/** Told the room on the box's label, by its id, or null, on each change. */
	onAskingChange?: (roomId: string | null) => void;
	/** A line above the box about what the person just tried (ComposerInput's `notice`). */
	composerNotice?: { key: number; words: string } | null;
	mention?: MentionSupport;
	onResolveApproval: (requestId: string, value: any, label: string) => void;
	onApprovalPreview?: (preview: ApprovalPreviewData) => void;
	previewSlot?: ReactNode;
	checkpointPreviewSlot?: ReactNode;
	globalOverlaySlot?: ReactNode;
	/**
	 * The room's transient notices (taste pass): floats directly above the
	 * composer, anchored to the composer COLUMN — a viewport-centred overlay
	 * drifts off it as soon as the viewer pane opens. Overlay, not in flow, so
	 * a toast never pushes the transcript the way the dock does.
	 */
	composerOverlaySlot?: ReactNode;
	// Optional hooks for the resizable right pane (e.g. approval preview).
	// All absent in fixtures, so default behaviour is unchanged.
	workbenchRef?: Ref<HTMLDivElement>;
	workbenchClassName?: string;
	workbenchStyle?: CSSProperties;
	beforeMessagesSlot?: ReactNode;
	emptySlot?: ReactNode;
	renderItem?: (item: ChatItem, index: number, items: ChatItem[]) => ReactNode;
	/** Consult MR-5: ids of transferred consult items still awaiting the next send. */
	pendingConsultIds?: ReadonlySet<string>;
	/** Visuals V6: opens a transferred task item's artifact in the right-pane viewer. */
	onOpenTaskArtifact?: (taskId: string, relativePath: string) => void;
	/** Taste pass: a message's attachment chip opens that file in the viewer, like its Files row. */
	attachmentAccess?: MessageAttachmentAccess;
	/** What the newest failure line's buttons do. */
	failureLineActions?: FailureLineActions;
	/** The answer a reconnect's replay drew in one paint: the blocks drawn then do not fade in. */
	answerDrawnAtOnceId?: string | null;
	/** Another window took the room: its running steps go on there. */
	stepsElsewhere?: boolean;
	/** A quiet line in the working dot's place while the room does something other than answer, such as shortening the conversation. */
	statusLine?: string | null;
	aboveComposerSlot?: ReactNode;
	/** Editing the newest message: where the pencil shows, what is being edited, and what is dimmed. */
	edit?: LastMessageEdit;
}

/**
 * Editing the newest message the person sent, in its bubble. From Edit until
 * the server takes the edit, the message's turn is dimmed: its answer while
 * the bubble is edited, all of it once the edit is sent.
 */
export interface LastMessageEdit {
	/** The bubble that shows the pencil, when one may be edited. */
	editableId: string | null;
	/** The bubble being edited, with the text it shows. */
	editing: { id: string; text: string } | null;
	/** The bubble whose edit was sent and is not yet taken. */
	sentId: string | null;
	onEdit: (id: string) => void;
	onCancel: () => void;
	onSend: (text: string) => void;
}

/**
 * Following the answer is decided by the reader's gestures, not by position
 * math (the tail of a trackpad gesture used to count as a move down, and a
 * near-bottom threshold then pulled the reader back). A gesture up (wheel,
 * touch, PageUp/ArrowUp/Home, a scrollbar drag) stops following at once,
 * wherever the view is; a wheel up only where the chat overflows, so a
 * wheel on a short chat does not leave the answer growing out of sight.
 * Following resumes when the reader reaches the true bottom themselves
 * (within this distance) or clicks the pill; or when a scroll down driven by
 * a downward wheel, finger or key, or by the scroll bar (a scroll with no
 * wheel or finger behind it), lands within FOLLOW_CATCH_BOTTOM_PX of a
 * bottom that keeps moving away, with no gesture up in the last
 * UP_GESTURE_QUIET_MS (that rules out a gesture's tail). After Send the
 * message glides to the top of the view and the view stays there while the
 * answer grows below it: only the reader's own scroll to the end, or the
 * pill, starts following.
 */
const FOLLOW_RESUME_BOTTOM_PX = 2;
const FOLLOW_CATCH_BOTTOM_PX = 24;
const UP_GESTURE_QUIET_MS = 300;
/** A scroll this soon after a wheel or touch event belongs to that gesture. */
const GESTURE_SCROLL_WINDOW_MS = 100;
/** A scroll this soon after the app wrote scrollTop is the app's own. */
const PROGRAMMATIC_SCROLL_WINDOW_MS = 50;
/**
 * A smooth programmatic scroll is the page's own until it lands on its
 * target; this caps one that never lands. A long glide runs well past half a
 * second, and its last steps reach the bottom: read as the reader's, they
 * would start following.
 */
const SMOOTH_SCROLL_MAX_MS = 2000;
/** A dropped socket this short is a blink, not news: the banner waits this long. */
const CONNECTION_BANNER_DELAY_MS = 800;

/** Why the room stopped when the connection is fine but its model cannot run, and the ways on. */
export interface ConnectionStopped {
	line: string;
	/** Settings, AI setup, at the provider's row; absent when signing in cannot help. */
	onSignIn?: () => void;
	/** That button's words: "Sign in", or "Add key" for a key provider. */
	signInLabel?: string;
	/** This room's Room settings, Model. */
	onChooseModel?: () => void;
	/** A conversation the room closed (the save that filled it): Home, or Memorize. */
	onReturnHome?: () => void;
	onMemorize?: () => void;
	/** A window the room moved on from: join the room's conversation. */
	onReload?: () => void;
	/** A window another took the room from: take it back here. */
	onOpenHere?: () => void;
	/** The room stopped on its key or sign-in: the notice carries the failure lines' mark. */
	failed?: true;
}

/** Whether the stopped notice shows: with the connection up, or once reconnecting gave up. */
export function stoppedNoticeShows(stopped: ConnectionStopped | undefined, connected: boolean, reconnectState: "idle" | "reconnecting" | "failed"): boolean {
	return Boolean(stopped) && (connected || reconnectState === "failed");
}

function bottomDistance(el: HTMLElement): number {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/**
 * The newest thing the reader could read: the last row of the last turn
 * (the thinking row aside), measured at its message body when it has one so
 * the time row under a message never counts. For a fresh send with no answer
 * yet that is the user's own bubble; while an answer streams it is the
 * growing reply. Empty reserved space below it is never content.
 */
function newestContent(el: HTMLElement): Element | null {
	const turns = el.querySelectorAll(":scope > .transcript-turn");
	const scope = turns.length > 0 ? turns[turns.length - 1] : el;
	let row = scope.lastElementChild;
	while (row && row.classList.contains("thinking-row")) row = row.previousElementSibling;
	if (!row) return null;
	const bodies = row.querySelectorAll(".bubble");
	return bodies.length > 0 ? bodies[bodies.length - 1] : row;
}

/**
 * The pill shows while not following once the newest content has gone past
 * the box's visible bottom edge; one rect pair per call. The pill's fade only
 * exists while the pill does, so a line still above the edge is fully
 * readable; the half pixel only absorbs subpixel rounding.
 */
function shouldShowJumpToLatest(el: HTMLElement, empty: boolean): boolean {
	if (empty) return false;
	const newest = newestContent(el);
	if (!newest) return false;
	return newest.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom > 0.5;
}

function prefersReducedMotion(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
	if (!ref) return;
	if (typeof ref === "function") {
		ref(value);
		return;
	}
	(ref as MutableRefObject<T | null>).current = value;
}

function fmtCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return "<$0.01";
	return "$" + n.toFixed(2);
}

function fmtContextTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtExact(n: number): string {
	return new Intl.NumberFormat("en-US").format(Math.round(n));
}

/**
 * The context meter's ring: filled as far as the conversation has come
 * towards the recommended context, in the zone's colour; empty when the
 * reading is unknown, offline, or not in yet.
 */
function ContextRing({ percent }: { percent: number | null }) {
	const radius = 5;
	const circumference = 2 * Math.PI * radius;
	const filled = percent == null ? 0 : Math.min(100, Math.max(0, percent)) / 100;
	return (
		<svg className="context-ring" width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
			<circle className="context-ring-track" cx="7" cy="7" r={radius} fill="none" strokeWidth={2} />
			{filled > 0 && <circle className="context-ring-fill" cx="7" cy="7" r={radius} fill="none" strokeWidth={2} strokeLinecap="round" strokeDasharray={`${(filled * circumference).toFixed(2)} ${circumference.toFixed(2)}`} transform="rotate(-90 7 7)" />}
		</svg>
	);
}

function ContextPill({
	status,
	usage,
	currentModelLabel,
	currentModelProvider,
	connected,
	reconnectState = "idle",
	stopped = false,
}: {
	status: ContextHealthStatus;
	usage: InRoomChatUsage;
	currentModelLabel?: string | null;
	currentModelProvider?: string | null;
	connected: boolean;
	reconnectState?: "idle" | "reconnecting" | "failed";
	/** Stopped on its model, not offline: the notice above the composer says so. */
	stopped?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLDivElement | null>(null);
	const popoverId = useId();
	const known = status.tokens != null && status.checkpointPercent != null;
	const offline = !connected && !stopped;
	const reconnecting = offline && reconnectState === "reconnecting";
	// Its dot is red whenever the room is down, reconnecting too, as on main; the line in the working dot's place says the words.
	const zone = offline ? "offline" : (status.zone ?? "unknown");
	// While it reconnects, the line in the working dot's place says so.
	const shownPercent = known && !(offline && !reconnecting) ? Math.round(status.checkpointPercent!) : null;
	// Nothing here names plumbing the user did not install and cannot restart.
	// While a retry is running, say so; once it has given up, the Reconnect
	// button beside this pill is the next move, and restarting the app is the
	// one after that. A shared server's room keeps trying until it is stopped
	// on purpose, and nothing there is the person's to restart.
	const { sharedServer } = useRemoteClientContext();
	const title = !offline
		? "Context and model details"
		: sharedServer
			? (reconnectState === "failed" ? "This room lost its connection. Use Reconnect to try again." : "This room lost its connection. It keeps trying by itself.")
			: reconnecting
				? "This room lost its connection. Trying to pick it up again…"
				: "This room lost its connection. Use Reconnect to try again, or restart the app if it keeps happening.";

	useEscapeKey(() => setOpen(false), open);


	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: MouseEvent) {
			const anchor = anchorRef.current;
			if (anchor && event.target instanceof Node && !anchor.contains(event.target)) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [open]);

	return (
		<div className="composer-context-anchor" ref={anchorRef}>
			<button
				type="button"
				className={`composer-context-pill ${zone}`}
				title={title}
				aria-label={offline && !reconnecting ? "Offline" : shownPercent !== null ? `${shownPercent}% of recommended context` : "Context: appears after the next response"}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls={open ? popoverId : undefined}
				onClick={() => setOpen((v) => !v)}
			>
				<ContextRing percent={shownPercent} />
				<span className="composer-context-pill-label">
					{/* The number alone; the panel's first line says what it is of. An
					    unknown reading (after a summary) is a dash until the next answer. */}
					{offline && !reconnecting ? "Offline" : shownPercent !== null ? `${shownPercent}%` : "\u2013"}
				</span>
			</button>
			{open && (
				<div className="composer-context-popover" id={popoverId} role="dialog" aria-label="Context and model details">
					{known && <p className="composer-context-popover-lead">{`${Math.round(status.checkpointPercent!)}% of recommended context`}</p>}
					{currentModelLabel && (
						<div className="composer-context-popover-row" title={`current chat model: ${formatModelWithProvider(currentModelLabel ?? "", currentModelProvider)}`}>
							<span>model</span>
							<strong>{currentModelLabel}</strong>
						</div>
					)}
					{known && (
						<div className="composer-context-popover-row">
							<span>context</span>
							<strong>{fmtExact(status.tokens!)} tokens</strong>
						</div>
					)}
					{!known && (
						<div className="composer-context-popover-row">
							<span>context</span>
							<strong>appears after the next response</strong>
						</div>
					)}
					<div className="composer-context-popover-row">
						<span>recommended</span>
						<strong>{fmtContextTok(status.checkpointTokens)}</strong>
					</div>
					{status.contextWindow && (
						<div className="composer-context-popover-row">
							<span>window</span>
							<strong>{fmtContextTok(status.contextWindow)}</strong>
						</div>
					)}
					<div className="composer-context-popover-row">
						<span>turns</span>
						<strong>{usage.turns}</strong>
					</div>
					<div className="composer-context-popover-row">
						<span>cost</span>
						<strong>{fmtCost(usage.cost)}</strong>
					</div>
					<div className="composer-context-popover-row">
						<span>connection</span>
						<strong>{connected ? "Online" : stopped ? "Paused" : reconnecting ? "Reconnecting…" : "Offline"}</strong>
					</div>
					<p className="composer-context-popover-note">
						{zone === "red"
							? "Recommended context size reached. Consider using Remember soon. Nothing happens automatically."
							: zone === "yellow"
								? "Approaching the recommended context size."
								: "Models lose sharpness as context grows. Use Remember before you reach the recommendation to keep answers sharp."}
					</p>
				</div>
			)}
		</div>
	);
}

/**
 * Losing the server is said above the composer, not only in its footer: a
 * banner while the room reconnects, and a Reconnect button once the automatic
 * attempts have given up, so a dead room always leaves the user a way back.
 * Typed text stays in the composer; Send waits for the connection.
 */
function ConnectionBanner({ connected, reconnectState, onReconnect, stopped }: { connected: boolean; reconnectState: "idle" | "reconnecting" | "failed"; onReconnect?: () => void; stopped?: ConnectionStopped }) {
	const lost = !connected && reconnectState !== "idle";
	const [shown, setShown] = useState(false);
	useEffect(() => {
		if (!lost) {
			setShown(false);
			return;
		}
		const timer = window.setTimeout(() => setShown(true), CONNECTION_BANNER_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [lost]);
	// Stopped on its model (the socket refused, or a turn failed on the sign-in
	// with the socket up): Reconnect cannot help, so the notice offers the two
	// ways on, and the room carries on once one of them is taken.
	// It takes the workspace nudge's panel, in the same place, so the two
	// read as one family and stack cleanly.
	if (stopped && stoppedNoticeShows(stopped, connected, reconnectState)) {
		return (
			<div className="room-workspace-nudge room-model-notice" role="status">
				<span className={`room-workspace-nudge-text${stopped.failed ? " with-failure-mark" : ""}`}>
					{stopped.failed && <span className="failure-mark" aria-hidden="true" />}
					{stopped.failed ? <span>{stopped.line}</span> : stopped.line}
				</span>
				<div className="room-workspace-nudge-actions">
					{stopped.onChooseModel && <button type="button" className="rs-btn rs-btn-sm" onClick={stopped.onChooseModel}>Choose another model</button>}
					{stopped.onSignIn && <button type="button" className="rs-btn rs-btn-primary rs-btn-sm" onClick={stopped.onSignIn}>{stopped.signInLabel ?? "Sign in"}</button>}
					{stopped.onReturnHome && <button type="button" className="rs-btn rs-btn-sm" onClick={stopped.onReturnHome}>{BACK_TO_ROOMS_LABEL}</button>}
					{stopped.onMemorize && <button type="button" className="rs-btn rs-btn-primary rs-btn-sm" onClick={stopped.onMemorize}>Memorize</button>}
					{stopped.onReload && <button type="button" className="rs-btn rs-btn-primary rs-btn-sm" onClick={stopped.onReload}>Reload</button>}
					{stopped.onOpenHere && <button type="button" className="rs-btn rs-btn-primary rs-btn-sm" onClick={stopped.onOpenHere}>Open here</button>}
				</div>
			</div>
		);
	}
	// While it reconnects, the line in the working dot's place says so.
	if (!lost || !shown || reconnectState !== "failed") return null;
	return (
		<div className="connection-banner" role="status">
			<span>Connection lost.</span>
			{onReconnect && <button type="button" className="rs-btn rs-btn-sm connection-banner-action" onClick={onReconnect}>Reconnect</button>}
		</div>
	);
}

interface TranscriptItemsProps {
	items: ChatItem[];
	empty: boolean;
	emptySlot?: ReactNode;
	renderItem?: (item: ChatItem, index: number, items: ChatItem[]) => ReactNode;
	onResolveApproval: (requestId: string, value: any, label: string) => void;
	onApprovalPreview?: (preview: ApprovalPreviewData) => void;
	/** Consult MR-5: ids of transferred consult items still awaiting the next send. */
	pendingConsultIds?: ReadonlySet<string>;
	/** Visuals V6: opens a transferred task item's artifact in the right-pane viewer. */
	onOpenTaskArtifact?: (taskId: string, relativePath: string) => void;
	/** Taste pass: a message's attachment chip opens that file in the viewer, like its Files row. */
	attachmentAccess?: MessageAttachmentAccess;
	showThinkingIndicator: boolean;
	/** Turn in flight: the last reply's copy button waits for it to end. */
	busy: boolean;
	/** The user message whose turn holds the answer space (see groupIntoTurns). */
	reservedTurnId: string | null;
	failureLineActions?: FailureLineActions;
	/** The answer a reconnect's replay drew in one paint: the blocks drawn then do not fade in. */
	answerDrawnAtOnceId?: string | null;
	/** A quiet line in the working dot's place, such as "Reconnecting…". */
	turnStatusLine?: string | null;
	/** Another window took the room: its running steps go on there. */
	stepsElsewhere?: boolean;
	/** The "Queued" bubbles, under everything else in the last turn. */
	queuedSlot?: ReactNode;
	edit?: LastMessageEdit;
}

/**
 * The transcript: each run of thinking, steps and questions is one stretch,
 * drawn as one work card that folds when something comes after it, or as
 * its thinking rows when it only thought. A finished turn with several cards
 * folds its work into one card above its answer. The reply
 * copy buttons are decided over the raw array (reply-copy.ts).
 */
function renderTranscript(
	items: ChatItem[],
	busy: boolean,
	onResolveApproval: TranscriptItemsProps["onResolveApproval"],
	onApprovalPreview: TranscriptItemsProps["onApprovalPreview"],
	pendingConsultIds: TranscriptItemsProps["pendingConsultIds"],
	onOpenTaskArtifact: TranscriptItemsProps["onOpenTaskArtifact"],
	attachmentAccess: TranscriptItemsProps["attachmentAccess"],
	failureLineActions: TranscriptItemsProps["failureLineActions"],
	answerDrawnAtOnceId: string | null,
	stepsElsewhere: boolean,
	edit: LastMessageEdit | undefined,
	messagesWaitBelow: boolean,
): IndexedNode[] {
	const copyTargets = replyCopyTargets(items, busy);
	// The conversation's last items: the last answer or message and the lines after it. Everything above them has
	// something after it, and with queued or held messages under the transcript, so do they.
	let lastFrom = items.length - 1;
	while (lastFrom > 0 && items[lastFrom].kind === "system") lastFrom--;
	const followedBefore = messagesWaitBelow ? items.length : lastFrom;
	const keyboardApprovalId = soleKeyboardApproval(items)?.requestId ?? null;
	const newestFailureId = newestFailureLineId(items);
	const rendered: IndexedNode[] = [];
	for (let index = 0; index < items.length; index++) {
		const it = items[index];
		if (isWorkItem(it)) {
			let end = index;
			while (end + 1 < items.length && isWorkItem(items[end + 1])) end++;
			const run = items.slice(index, end + 1);
			// An answer not written yet is no stretch of its own.
			if (run.some((item) => item.kind !== "assistant")) {
				const next = items[end + 1] as (ChatItem & { ts?: number }) | undefined;
				rendered.push({
					index,
					stretch: run,
					node: <WorkStretch key={it.id} items={run} live={busy && !next} endTs={next?.ts} elsewhere={stepsElsewhere} keyboardApprovalId={keyboardApprovalId} onResolve={onResolveApproval} onPreview={onApprovalPreview} />,
				});
				index = end;
				continue;
			}
		}
		rendered.push({ index, node:
			it.kind === "consult" ? (
				<ConsultThreadItem key={it.id} item={it} pending={pendingConsultIds?.has(it.id) ?? false} />
			) : it.kind === "task" ? (
				<TaskThreadItem key={it.id} item={it} onOpenTaskArtifact={onOpenTaskArtifact} />
			) : it.kind === "user" && edit?.editing?.id === it.id ? (
				<BubbleEditor key={`edit-${it.id}`} text={edit.editing.text} onCancel={edit.onCancel} onSend={edit.onSend} />
			) : (
				<Message key={it.id} item={it} attachmentAccess={attachmentAccess} copyText={copyTargets.get(it.id)?.text} copyTs={copyTargets.get(it.id)?.ts} newestFailure={it.id === newestFailureId} failureActions={it.id === newestFailureId ? failureLineActions : undefined} drawnAtOnce={it.id === answerDrawnAtOnceId} elsewhere={stepsElsewhere} followed={index < followedBefore} onEdit={it.id === edit?.editableId && !edit.editing ? edit.onEdit : undefined} sender={it.kind === "user" ? it.sender : undefined} />
			),
		});
	}
	return foldLongTurns(items, rendered, busy);
}

/**
 * The steps of the answer the room is running: those after the person's last
 * message, since one sent while the room answers joins that answer, and after
 * a failure line, since Try again under it starts a new answer with no
 * message. None while the room is idle. Each line under a yes asks by its own
 * step, since a card or a folded turn can hold steps of two answers.
 */
function runningAnswerSteps(items: ChatItem[], busy: boolean): ReadonlySet<string> {
	const steps = new Set<string>();
	if (!busy) return steps;
	for (let at = items.length - 1; at >= 0; at--) {
		const item = items[at];
		if ((item.kind === "user" && item.steered !== true) || (item.kind === "system" && item.level === "error")) break;
		if (item.kind === "tool") steps.add(item.id);
	}
	return steps;
}

/** A finished turn's cards, and the notes between them, as one card above its answer, when it had more than one card. */
function foldLongTurns(items: ChatItem[], nodes: IndexedNode[], busy: boolean): IndexedNode[] {
	const out: IndexedNode[] = [];
	let turn: IndexedNode[] = [];
	const closeTurn = (last: boolean) => {
		const cards = turn.filter((node) => node.stretch?.some((item) => item.kind === "tool"));
		let answerAt = -1;
		for (let at = turn.length - 1; at >= 0; at--) {
			const item = items[turn[at].index];
			if (item.kind === "assistant" && item.text.trim() && !turn[at].stretch) {
				answerAt = at;
				break;
			}
		}
		const firstCard = cards.length ? turn.indexOf(cards[0]) : -1;
		const folding = firstCard >= 0 && answerAt > firstCard ? turn.slice(firstCard, answerAt) : [];
		const foldId = folding.length ? `worked:${items[folding[0].index].id}` : "";
		// A thought the person opened is hidden only by the person: no fold over it, unless they folded or opened this one themselves.
		const overOpenThought = folding.some((node) => node.stretch?.some((item) => item.kind === "thinking" && isThoughtOpen(item.id)));
		if ((last && busy) || cards.length < 2 || !folding.length || (foldChoiceOf(foldId) === undefined && overOpenThought)) {
			out.push(...turn);
			turn = [];
			return;
		}
		const steps = folding.flatMap((node) => (node.stretch ? workPieces(node.stretch) : [])).filter((piece): piece is Extract<ReturnType<typeof workPieces>[number], { kind: "step" }> => piece.kind === "step");
		const user = items[turn[0].index];
		const answer = items[turn[answerAt].index] as ChatItem & { ts?: number };
		const ms = user.kind === "user" && user.ts !== undefined && answer.ts !== undefined && answer.ts >= user.ts ? answer.ts - user.ts : undefined;
		out.push(...turn.slice(0, firstCard));
		out.push({ index: folding[0].index, node: <TurnCard key={foldId} foldId={foldId} steps={steps} ms={ms}>{folding.map((node) => node.node)}</TurnCard> });
		out.push(...turn.slice(answerAt));
		turn = [];
	};
	for (const node of nodes) {
		if (items[node.index]?.kind === "user" && turn.length) closeTurn(false);
		turn.push(node);
	}
	if (turn.length) closeTurn(true);
	return out;
}

/**
 * The newest failure line: the last one, with nothing the person sent or the
 * model answered after it. Every other failure line folds.
 */
export function newestFailureLineId(items: ChatItem[]): string | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind !== "system") return null;
		if (item.level === "error") return item.id;
	}
	return null;
}

/**
 * The one pending yes/no card the composer may answer by keyboard: Enter
 * approves and Escape declines while the composer is empty. With two cards
 * pending, a card that asks for a choice or an answer, or a question in the
 * panel above the box (which takes no Enter), the keys keep their usual
 * meaning. Only the current turn is looked at (back to the last
 * user message), so the scan stays a few items long on every render.
 */
function soleKeyboardApproval(items: ChatItem[]): Extract<ChatItem, { kind: "approval" }> | null {
	let found: Extract<ChatItem, { kind: "approval" }> | null = null;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "user") break;
		if (item.kind !== "approval" || !answersHere(item)) continue;
		if (found || item.uiKind !== "confirm") return null;
		found = item;
	}
	return found;
}

interface IndexedNode {
	/** Index of the first transcript item the node renders. */
	index: number;
	node: ReactNode;
	/** The items of a stretch of work the node draws as one card. */
	stretch?: ChatItem[];
}

/**
 * Wraps each turn (a user message and everything after it, up to the next
 * user message) in its own element, keyed by the user message, so a turn
 * never remounts when a newer one starts. The turn the user just sent is the
 * reserved one: it is at least as tall as the messages box, which leaves
 * empty space under the message for the answer to grow into while the
 * viewport stands still. Anything before the first user message stays
 * unwrapped. The trailing node (the thinking row) joins the last turn so the
 * reservation covers it too.
 */
function groupIntoTurns(items: ChatItem[], nodes: IndexedNode[], trailing: ReactNode, reservedTurnId: string | null, edit?: LastMessageEdit): ReactNode[] {
	const out: ReactNode[] = [];
	let turn: { id: string; nodes: ReactNode[] } | null = null;
	// The edited message's answer is dimmed while its bubble is the box; all of its turn once the edit is sent.
	const dimmed = (id: string) => (id === edit?.sentId ? " edit-dim-all" : id === edit?.editing?.id ? " edit-dim-answer" : "");
	const closeTurn = () => {
		if (!turn) return;
		out.push(
			<div key={`turn-${turn.id}`} className={`transcript-turn${turn.id === reservedTurnId ? " reserved" : ""}${dimmed(turn.id)}`}>
				{turn.nodes}
			</div>,
		);
		turn = null;
	};
	for (const { index, node } of nodes) {
		const item = items[index];
		// A message the room took while it answered belongs to that answer's turn, unless it is being edited: its own answer dims on its own.
		const edited = item?.kind === "user" && (item.id === edit?.sentId || item.id === edit?.editing?.id);
		if (item?.kind === "user" && (edited || !(turn && item.steered === true))) {
			closeTurn();
			turn = { id: item.id, nodes: [] };
		}
		if (turn) turn.nodes.push(node);
		else out.push(node);
	}
	if (trailing) {
		if (turn) (turn as { id: string; nodes: ReactNode[] }).nodes.push(trailing);
		else out.push(trailing);
	}
	closeTurn();
	return out;
}

/**
 * Sizes the sent message's reserved turn so the glide to the bottom stops
 * with the bottom of what sits above the message (an answer's copy row, a
 * failure line, a steps card) at the box's top edge, whatever gap that item
 * keeps. At the box's top padding alone it would stop with the bottom of that
 * item showing under the header, since items sit closer together than the
 * padding. Measured on the turn's first layout, before any lift is set.
 */
function fitReservedTurn(box: HTMLElement): void {
	const turn = box.querySelector<HTMLElement>(":scope > .transcript-turn.reserved");
	const above = turn?.previousElementSibling;
	if (!turn || !above) return;
	// A scroll position is whole pixels and the browser rounds a fractional
	// scroll range to the nearest one, so the stop is the position that brings
	// the bottom of the item above to the top edge, rounded up, and the lift
	// makes the range reach just under half a pixel past it: it still rounds
	// to the stop when what is above settles by under a pixel after the send
	// (the end of a steps card's fold). Worked out from the boxes' positions:
	// the box's scroll sizes are rounded too.
	const edges = box.getBoundingClientRect();
	const paddingBottom = Number.parseFloat(getComputedStyle(box).paddingBottom) || 0;
	const stop = Math.ceil(box.scrollTop + above.getBoundingClientRect().bottom - edges.top - 0.001);
	const lift = edges.bottom + (stop - box.scrollTop) - turn.getBoundingClientRect().bottom - paddingBottom + 31 / 64;
	turn.style.setProperty("--reserved-turn-lift", `${lift}px`);
}

const TranscriptItems = memo(function TranscriptItems({
	items,
	empty,
	emptySlot,
	renderItem,
	onResolveApproval,
	onApprovalPreview,
	pendingConsultIds,
	onOpenTaskArtifact,
	attachmentAccess,
	showThinkingIndicator,
	busy,
	reservedTurnId,
	failureLineActions,
	answerDrawnAtOnceId = null,
	turnStatusLine = null,
	stepsElsewhere = false,
	queuedSlot = null,
	edit,
}: TranscriptItemsProps) {
	// A live card or thinking row already says the room works: the dot shows only before anything has arrived.
	const last = items[items.length - 1];
	const cardSaysIt = !renderItem && !!last && (last.kind === "tool" || last.kind === "approval" || (last.kind === "thinking" && last.ms === undefined));
	const thinking = turnStatusLine ? (
		<div key="thinking-row" className="thinking-row turn-status-line" role="status">
			<span className="thinking-dot" aria-hidden="true" />
			<span>{turnStatusLine}</span>
		</div>
	) : showThinkingIndicator && !cardSaysIt ? (
		<div key="thinking-row" className="thinking-row" role="status" aria-label="thinking">
			<span className="thinking-dot" aria-hidden="true" />
		</div>
	) : null;
	const trailing = thinking || queuedSlot ? <>{thinking}{queuedSlot}</> : null;
	const runningSteps = useMemo(() => runningAnswerSteps(items, busy), [items, busy]);
	if (empty) return <>{emptySlot ?? null}{trailing}</>;
	const nodes: IndexedNode[] = renderItem
		? items.map((it, index) => ({ index, node: renderItem(it, index, items) }))
		: renderTranscript(items, busy, onResolveApproval, onApprovalPreview, pendingConsultIds, onOpenTaskArtifact, attachmentAccess, failureLineActions, answerDrawnAtOnceId, stepsElsewhere, edit, queuedSlot !== null);
	return <RunningAnswerSteps.Provider value={runningSteps}>{groupIntoTurns(items, nodes, trailing, reservedTurnId, edit)}</RunningAnswerSteps.Provider>;
});

interface ComposerInputProps {
	onSend: (text: string) => boolean;
	onStop?: () => void;
	stopVisible?: boolean;
	stopDisabled?: boolean;
	stopLabel?: string;
	textareaRef?: Ref<HTMLTextAreaElement>;
	placeholder: string;
	sendUnavailable?: boolean;
	/** Tooltip of the Send button (says why it is waiting when it is). */
	sendTitle?: string;
	initialDraftValue?: string;
	/** The room on the box's label when the box is filled again (draftResetKey), by its id. */
	initialAsking?: string | null;
	draftResetKey?: string | number;
	/** Told the room on the box's label, by its id, or null, on each change. */
	onAskingChange?: (roomId: string | null) => void;
	mention?: MentionSupport;
	statusSlot?: ReactNode;
	rightActions?: ReactNode;
	/** Files UI slice: the staged-attachment chip row, rendered above the textarea. */
	stagingSlot?: ReactNode;
	/** Files UI slice: ready attachments make an empty-text send legal (the note alone rides). */
	allowEmptySend?: boolean;
	/** Files pasted into the textarea (images, documents alike) are handed here to be staged. */
	onPasteFiles?: (files: File[]) => void;
	/** The sole pending yes/no card, answered by Enter and Escape while the composer is empty. */
	keyboardApproval?: { approve: () => void; decline: () => void } | null;
	onSendNow?: (text: string) => boolean;
	onSendQueuedNow?: () => boolean;
	queueRefusal?: (text: string, asking: string | null) => string | null;
	onEscapeStop?: () => boolean;
	/** Whether the box holds words or a room on its label, so Cmd/Ctrl+Enter is the box's and not the first queued message's; told on each change. */
	onBoxHoldsChange?: (holds: boolean) => void;
	/** A line above the box about what the person just tried; it goes once the box changes. `key` tells one try from the next. */
	notice?: { key: number; words: string } | null;
}

/** Something else on the page takes Esc first: a dialog, a menu, a viewer. */
function otherLayerOpen(): boolean {
	return escapeLayerOpen() || !!document.querySelector('[aria-modal="true"], [role="menu"], [role="listbox"], .diagram-zoom-overlay');
}

/** The room's message box. Exported so a smoke can type into it and press its keys. */
export function ComposerInput({
	onSend,
	onStop,
	stopVisible = false,
	stopDisabled = false,
	stopLabel = "Stop",
	textareaRef,
	placeholder,
	sendUnavailable = false,
	sendTitle = "Send",
	initialDraftValue,
	initialAsking,
	draftResetKey,
	onAskingChange,
	mention,
	statusSlot,
	rightActions,
	stagingSlot,
	allowEmptySend = false,
	onPasteFiles,
	keyboardApproval = null,
	onSendNow,
	onSendQueuedNow,
	queueRefusal,
	onEscapeStop,
	onBoxHoldsChange,
	notice = null,
}: ComposerInputProps) {
	// The box draws again once the page hears which server it is on.
	useRemoteClientContext();
	// A word names a room by its id's start only once the server has said it is
	// this computer: a shared server's ids are random, and the page may be on one
	// until that answer comes, or after a first read failed.
	const idsByStart = knownRemoteClientContext() !== null && !mayBeOnSharedServer();
	const [draft, setDraft] = useState(() => initialDraftValue ?? "");
	const boxHasText = draft.trim() !== "";
	const [caret, setCaret] = useState(0);
	// The room the message goes to instead of this one, by its id: a label on the box, never a word in the text.
	const [asking, setAsking] = useState<string | null>(() => initialAsking ?? null);
	// Archived or deleted since it was picked: the label stays, without its name, and nothing is sent to it.
	const askedRoom = asking && mention ? listedRoom(asking, mention.candidates, mention.currentRoomId) : null;
	const askingGone = !!asking && !askedRoom;
	const askingName = asking ? askedRoom?.displayName ?? ANOTHER_ROOM : null;
	useEffect(() => {
		onAskingChange?.(asking);
	}, [asking, onAskingChange]);
	const boxHolds = boxHasText || !!asking;
	useEffect(() => {
		onBoxHoldsChange?.(boxHolds);
	}, [boxHolds, onBoxHoldsChange]);
	const boxEmpty = draft === "" && !asking;
	const [mentionIndex, setMentionIndex] = useState(0);
	// §8.3: the visible rejection when a composer @-mention is attempted while a
	// consult card is docked. Cleared on the next keystroke so it never lingers.
	const [consultGateNotice, setConsultGateNotice] = useState<string | null>(null);
	// Esc dismisses the popover for the current trigger; any further typing
	// (onChange) clears this so it reopens.
	const [mentionDismissed, setMentionDismissed] = useState(false);
	// The notice the box has changed since, which no longer shows; one there when the box is made belongs to the box before it.
	const [noticeDone, setNoticeDone] = useState<number | null>(() => notice?.key ?? null);
	const noticeShown = notice && notice.key !== noticeDone ? notice.words : null;
	// The draft as it was when an input method began composing, or null while none composes.
	const composeFromRef = useRef<string | null>(null);
	const textareaNodeRef = useRef<HTMLTextAreaElement | null>(null);
	// Caret to restore after a programmatic draft edit (a room picked or labelled).
	const pendingCaretRef = useRef<number | null>(null);
	// Asking a room needs a question, files attached or not: files do not go with it.
	const awaitingQuestion = !!asking && !draft.trim();
	const queueRefused = draft.trim() ? queueRefusal?.(draft, asking) ?? null : null;
	const sendDisabled = sendUnavailable || askingGone || awaitingQuestion || !!queueRefused || (!draft.trim() && !allowEmptySend);
	const sendButtonTitle = sendUnavailable ? sendTitle : askingGone ? ROOM_GONE : awaitingQuestion ? TYPE_QUESTION : queueRefused ?? sendTitle;
	// A later '@' word that names one room: the line above the box says how to ask it; the message still goes to this room.
	const laterRoom = mention && !asking ? laterMentionRoom(draft, mention.candidates, mention.currentRoomId, idsByStart) : null;

	// Mention popover state. The interactive picker opens only when a trigger is
	// active, no room is on the box, the room is not busy, it has not been
	// dismissed, and at least one room matches, so an unmatched '@' never traps
	// Enter. While busy a trigger shows only the disabled affordance (with a
	// title).
	const rawTrigger = mention && !asking ? detectMentionQuery(draft, caret) : null;
	const mentionQuery = mention && !mention.busy && !mentionDismissed ? rawTrigger : null;
	const mentionMatches: MentionCandidateRoom[] = mention && mentionQuery
		? filterMentionCandidates(mention.candidates, mentionQuery.query, mention.currentRoomId, idsByStart)
		: [];
	const mentionOpen = Boolean(mentionQuery) && mentionMatches.length > 0;
	const mentionBusyActive = Boolean(mention?.busy) && rawTrigger !== null;
	const activeMentionIndex = mentionMatches.length > 0 ? Math.min(mentionIndex, mentionMatches.length - 1) : 0;

	// The "/" list: the skills on in this room, asked for at each opening, so a
	// skill switched on a moment ago is there. Never under a room's label (that
	// question goes to the other room as typed), and none while its skills load,
	// after a failed lookup, or when nothing fits: Enter then sends the text as
	// typed, and the server reads a leading "/name" all the same.
	const skillRoomId = mention && !asking ? mention.currentRoomId : null;
	const skillQuery = skillRoomId ? skillPickQuery(draft, caret) : null;
	const [skillDismissed, setSkillDismissed] = useState(false);
	// Esc closes it as leaving the "/" does: typing after it is a new opening, which asks again.
	const skillListWanted = skillQuery !== null && !mentionOpen && !skillDismissed;
	const [skillIndex, setSkillIndex] = useState(0);
	const [skillLibrary, setSkillLibrary] = useState<{ roomId: string; entries: SkillPickEntry[] } | null>(null);
	// Closed: its entries go in the same render, so an opening right after shows only its own answer, never the last one's.
	if (!skillListWanted && skillLibrary !== null) setSkillLibrary(null);
	useEffect(() => {
		if (!skillListWanted || !skillRoomId) return;
		let current = true;
		Promise.all([fetchSkills(), fetchPersistentRoomSkillSettings(skillRoomId)])
			.then(([library, room]) => {
				// An answer for a room the person has left, or a list closed since, is dropped.
				if (current) setSkillLibrary({ roomId: skillRoomId, entries: skillPickEntries(library, room.skills) });
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [skillListWanted, skillRoomId]);
	const skillMatches = skillListWanted && skillLibrary?.roomId === skillRoomId ? filterSkillPicks(skillLibrary.entries, skillQuery!) : [];
	const skillOpen = skillMatches.length > 0;
	const activeSkillIndex = skillOpen ? Math.min(skillIndex, skillMatches.length - 1) : 0;
	useEffect(() => {
		setSkillIndex(0);
	}, [skillQuery]);

	const setTextareaNode = useCallback((node: HTMLTextAreaElement | null) => {
		textareaNodeRef.current = node;
		assignRef(textareaRef, node);
	}, [textareaRef]);

	useEffect(() => {
		setDraft(initialDraftValue ?? "");
		setAsking(initialAsking ?? null);
		setMentionDismissed(false);
		setSkillDismissed(false);
	}, [draftResetKey]);

	// A room that just opened is there to be typed into: focus the composer
	// once per draft reset (mount, room change, a sent message) with the caret
	// after any restored draft. Never when something outside the composer
	// holds focus (a modal's field, an approval card) so a re-render can't
	// steal it; the composer's own controls (the Send button just clicked)
	// hand focus back. Never on touch devices, where focusing pops the
	// keyboard over the room. The caret goes after the draft this reset
	// installs (the DOM still shows the previous value at this point).
	useEffect(() => {
		const el = textareaNodeRef.current;
		if (!el) return;
		if (typeof window.matchMedia === "function" && window.matchMedia("(hover: none)").matches) return;
		const active = document.activeElement;
		if (active && active !== document.body && active !== el && !active.closest(".composer-box")) return;
		el.focus();
		const end = (initialDraftValue ?? "").length;
		el.setSelectionRange(end, end);
		setCaret(end);
	}, [draftResetKey]);

	// Reset the highlighted row whenever the query changes.
	useEffect(() => {
		setMentionIndex(0);
	}, [mentionQuery?.query]);

	// Auto-grow: the draft's own height drives the box, the stylesheet's
	// max-height (40vh) is the single cap — past it the textarea scrolls
	// internally, and a viewport resize re-clamps without any JS. The textarea
	// must NOT be a flex-basis-0 item for this to work (a `flex: 1` in the
	// column layout silently discarded this height for a month).
	useLayoutEffect(() => {
		const el = textareaNodeRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [draft]);

	// Restore the caret after picking or labelling a room rewrote the draft.
	useLayoutEffect(() => {
		const el = textareaNodeRef.current;
		if (!el || pendingCaretRef.current == null) return;
		const pos = pendingCaretRef.current;
		pendingCaretRef.current = null;
		el.focus();
		el.setSelectionRange(pos, pos);
		setCaret(pos);
	}, [draft, asking]);

	useEffect(() => setComposerEmpty(boxEmpty), [boxEmpty]);
	// The box changed: a notice about what it held before no longer applies.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => setNoticeDone(notice?.key ?? null), [draft, asking]);
	useEffect(() => () => setComposerEmpty(true), []);

	// Enter and Esc from anywhere on the page, one layer at a time: an open
	// dialog, menu or viewer takes Esc first and that Esc does nothing else;
	// a text field keeps its own keys. With nothing open and the box empty,
	// Enter answers the one waiting question with yes and Esc with no, unless
	// a button or link has the focus, since Enter presses it. The room's
	// question above the box takes Esc as its no, and Cmd/Ctrl+Enter as its
	// Allow this time where the box would send nothing.
	const pageKeyRef = useRef<(key: "enter" | "escape" | "chord", repeat: boolean) => boolean>(() => false);
	pageKeyRef.current = (key, repeat) => {
		if (key === "chord") return askPanelChord(repeat);
		if (keyboardApproval && boxEmpty) {
			if (key === "enter") keyboardApproval.approve();
			else keyboardApproval.decline();
			return true;
		}
		if (key === "escape" && boxEmpty && askPanelEscape(repeat)) return true;
		// Esc anywhere on the page stops the answer while it runs.
		return key === "escape" && !!onEscapeStop?.();
	};
	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			const enter = event.key === "Enter" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
			const chord = event.key === "Enter" && !event.shiftKey && !event.altKey && chordHeld(event);
			if ((event.key !== "Escape" && !enter && !chord) || event.defaultPrevented || event.isComposing) return;
			const target = event.target instanceof HTMLElement ? event.target : null;
			if (target?.closest(".composer-box")) return;
			if (isTextField(target)) return;
			if ((enter || chord) && target && !enterReachesQuestion(target)) return;
			if (otherLayerOpen()) return;
			if (pageKeyRef.current(chord ? "chord" : enter ? "enter" : "escape", event.repeat)) event.preventDefault();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const syncCaret = useCallback((el: HTMLTextAreaElement) => {
		setCaret(el.selectionStart ?? el.value.length);
	}, []);

	const selectMention = useCallback((room: MentionCandidateRoom) => {
		const rest = draftAfterPick(draft);
		pendingCaretRef.current = Math.max(0, caret - (draft.length - rest.length));
		setMentionDismissed(false);
		setAsking(room.id);
		setDraft(rest);
	}, [draft, caret]);

	// A skill picked from the "/" list: the draft's first word becomes "/name ", the caret after it.
	const selectSkill = useCallback((entry: SkillPickEntry) => {
		const picked = draftAfterSkillPick(draft, entry.name);
		pendingCaretRef.current = picked.caret;
		setSkillDismissed(false);
		setDraft(picked.draft);
	}, [draft]);

	// Typing in the box. The space after a word at the start that names one
	// room puts that room on the box, unless Esc dismissed the list for it.
	// While an input method composes, the words stay as they are: the label
	// forms once the word is done (`from`, the draft before it began).
	function changeDraft(box: HTMLTextAreaElement, from = draft) {
		const next = box.value;
		const composing = composeFromRef.current !== null;
		const labelled = !composing && mention && !mention.busy && !asking && !mentionDismissed ? labelAtFirstSpace(from, next, mention.candidates, mention.currentRoomId, idsByStart) : null;
		// Esc holds while an input method composes, so the word it ends with is judged with Esc's choice.
		if (!composing) {
			setMentionDismissed(false);
			setSkillDismissed(false);
		}
		setConsultGateNotice(null);
		if (labelled) {
			pendingCaretRef.current = Math.max(0, (box.selectionStart ?? next.length) - (next.length - labelled.rest.length));
			setAsking(labelled.room.id);
			setDraft(labelled.rest);
			return;
		}
		setDraft(next);
		syncCaret(box);
	}

	// The label comes off; the text stays, and goes to this room.
	const stopAsking = useCallback(() => {
		setAsking(null);
		setConsultGateNotice(null);
		textareaNodeRef.current?.focus();
	}, []);

	// Asking a room: a fresh question to it, now or once the answer here ends.
	const askRoom = useCallback((now: boolean) => {
		if (!mention || !asking) return;
		// A mention here always means a fresh consult, so while a card is docked
		// it is refused visibly: the card is where you follow up, and a keystroke
		// must never drop a stack not yet added to the conversation. The draft
		// is kept so nothing is lost.
		if (mention.activeConsultDisplayName) {
			setConsultGateNotice(`a consult with @${mention.activeConsultDisplayName} is open. Follow up in the card, or dismiss it first.`);
			return;
		}
		// Only clear the box if the consult was accepted. With one already
		// active, or the socket down, the request is refused, and wiping the
		// typed question would lose it with no feedback; the box stays for a
		// retry, its label with it.
		if (mention.onConsultRequest(asking, draft.trim(), now)) {
			setDraft("");
			setAsking(null);
			setMentionDismissed(false);
		}
	}, [mention, asking, draft]);

	const submitDraft = useCallback(() => {
		if (sendDisabled) return;
		if (asking) {
			askRoom(false);
			return;
		}
		const accepted = onSend(draft);
		if (accepted) {
			setDraft("");
		}
	}, [draft, onSend, sendDisabled, asking, askRoom]);

	// Cmd+Enter on a Mac, Ctrl+Enter elsewhere: now, even through the answer; in an empty box, the first queued message goes now.
	function sendNowByChord() {
		// A room on the label waits for its question, also with messages queued.
		if (!boxHolds) onSendQueuedNow?.();
		else if (sendUnavailable || askingGone || awaitingQuestion || queueRefused) return;
		else if (asking) askRoom(true);
		else if (onSendNow?.(draft)) setDraft("");
	}
	// The same chord pressed on the room's question above the box, when its answer doesn't take it.
	useBoxChord(sendNowByChord);

	function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
		// Enter that confirms a Japanese, Chinese or Korean word is the input method's, never a send.
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		// Backspace at the very start of the box takes the room's label off.
		if (asking && e.key === "Backspace" && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
			e.preventDefault();
			stopAsking();
			return;
		}
		if (skillOpen) {
			// As in the "@" list: moving and picking never send the message.
			if (e.key === "ArrowDown") { e.preventDefault(); setSkillIndex((i) => (Math.min(i, skillMatches.length - 1) + 1) % skillMatches.length); return; }
			if (e.key === "ArrowUp") { e.preventDefault(); setSkillIndex((i) => (Math.min(i, skillMatches.length - 1) - 1 + skillMatches.length) % skillMatches.length); return; }
			if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectSkill(skillMatches[activeSkillIndex]!); return; }
			if (e.key === "Escape") { e.preventDefault(); setSkillDismissed(true); return; }
		}
		if (mentionOpen) {
			// Navigation and selection never submit the message (spec invariant).
			if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex((i) => (Math.min(i, mentionMatches.length - 1) + 1) % mentionMatches.length); return; }
			if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((i) => (Math.min(i, mentionMatches.length - 1) - 1 + mentionMatches.length) % mentionMatches.length); return; }
			if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectMention(mentionMatches[activeMentionIndex]); return; }
			if (e.key === "Escape") { e.preventDefault(); setMentionDismissed(true); return; }
		}
		// An empty composer answers the one pending yes/no card; with text in
		// it, Enter sends as always and the card stays.
		// Cmd/Ctrl+Enter is never the card's: in an empty box it sends the first queued message now.
		if (e.key === "Escape" && otherLayerOpen()) return;
		if (keyboardApproval && boxEmpty && !e.shiftKey && !(e.key === "Enter" && chordHeld(e.nativeEvent)) && (e.key === "Enter" || e.key === "Escape")) {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Enter") keyboardApproval.approve();
			else keyboardApproval.decline();
			return;
		}
		// The room's question above the box: Esc in the empty box is its no, not Stop.
		if (e.key === "Escape" && boxEmpty && askPanelEscape(e.nativeEvent.repeat)) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		// Cmd/Ctrl+Enter with nothing in the box and nothing queued: its Allow this time, once awake.
		if (e.key === "Enter" && !e.shiftKey && !e.altKey && chordHeld(e.nativeEvent) && !boxHolds && askPanelChord(e.nativeEvent.repeat)) {
			e.preventDefault();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.altKey && chordHeld(e.nativeEvent) && (onSendNow || onSendQueuedNow)) {
			e.preventDefault();
			sendNowByChord();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submitDraft();
			return;
		}
		if (e.key === "Escape" && onEscapeStop?.()) e.preventDefault();
	}

	// A pasted file stages as an attachment, through the exact path the
	// 📎 uses. Every FILE on the clipboard is taken (a screenshot, a copied
	// picture, a PDF or spreadsheet copied from the file manager) — what the
	// room can read is the server's call at upload, which answers with the
	// same parse note or refusal the 📎 gets. Any plain-text paste is
	// untouched, and a mixed clipboard (text + file) stages the file AND lets
	// the text paste normally, so preventDefault fires only when there is no
	// text for the textarea to receive. A file copied from the file manager
	// rides with its own name as the text: that name is the file, not a
	// message, so it is not pasted either.
	function handleComposerPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
		if (!onPasteFiles) return;
		const files = Array.from(e.clipboardData?.files ?? []);
		if (files.length === 0) return;
		onPasteFiles(files);
		const text = e.clipboardData.getData("text/plain").trim();
		const names = new Set(files.map((file) => file.name));
		const onlyFileNames = text.split(/\r?\n/).every((line) => names.has(line.trim()));
		if (!text || onlyFileNames) e.preventDefault();
	}

	return (
		<>
		{/* Above the box, outside it: a line about the message, never a line of it. */}
		{noticeShown && <div className="composer-edit-line" role="status">{noticeShown}</div>}
		{laterRoom && <div className="composer-ask-hint" role="status">{askHint(laterRoom.displayName)}</div>}
		{askingGone && <div className="composer-room-gone" role="status">{`${ROOM_GONE}.`}</div>}
		<div className="composer-box">
			{mentionOpen && mentionQuery && (
				<MentionConsultPopover
					matches={mentionMatches}
					query={mentionQuery.query}
					activeIndex={activeMentionIndex}
					onHover={setMentionIndex}
					onSelect={selectMention}
				/>
			)}
			{mentionBusyActive && mention && <MentionConsultPopoverBusy title={mention.busyTitle} />}
			{skillOpen && <SkillPickList entries={skillMatches} activeIndex={activeSkillIndex} onHover={setSkillIndex} onSelect={selectSkill} />}
			{consultGateNotice && <div className="composer-consult-gate" role="status">{consultGateNotice}</div>}
			{stagingSlot}
			<div className="composer-input">
				{askingName && (
					<span className="composer-asking">
						<span className="composer-asking-name">{askingWords(askingName)}</span>
						<button type="button" className="composer-asking-off" aria-label={`Don't ask ${askingName}`} title={`Don't ask ${askingName}`} onClick={stopAsking}>×</button>
					</span>
				)}
				<textarea
					ref={setTextareaNode}
					value={draft}
					onChange={(e) => changeDraft(e.target)}
					onCompositionStart={() => { composeFromRef.current ??= draft; }}
					onCompositionEnd={(e) => {
						const from = composeFromRef.current ?? draft;
						composeFromRef.current = null;
						changeDraft(e.currentTarget, from);
					}}
					onKeyUp={(e) => syncCaret(e.currentTarget)}
					onClick={(e) => syncCaret(e.currentTarget)}
					onSelect={(e) => syncCaret(e.currentTarget)}
					onKeyDown={handleComposerKeyDown}
					onPaste={handleComposerPaste}
					placeholder={placeholder}
					rows={2}
					spellCheck={false}
				/>
			</div>
			<div className="composer-box-bottom">
				<div className="composer-box-status">{statusSlot}</div>
				<div className="composer-box-controls">
					{rightActions && <div className="composer-actions">{rightActions}</div>}
					{stopVisible && !draft.trim() ? (
						<button className="send-btn stop-btn" onClick={onStop} disabled={stopDisabled} aria-label={stopLabel} title={stopLabel}><span aria-hidden="true">■</span></button>
					) : (
						<button className="send-btn" onClick={submitDraft} disabled={sendDisabled} aria-label="Send" title={sendButtonTitle}>↑</button>
					)}
				</div>
			</div>
		</div>
		</>
	);
}

export function InRoomChatShellView({
	sidebar,
	onHome,
	withPreview = false,
	activeDisplay,
	ownerSecondary,
	busy,
	usage,
	contextHealth,
	currentModelLabel,
	currentModelProvider,
	topbarActions,
	composerRightActions,
	composerAttachSlot,
	composerRememberSlot,
	composerModelSlot,
	composerStagingSlot,
	composerAllowEmptySend,
	composerOnPasteFiles,
	connected,
	reconnectState = "idle",
	onReconnect,
	connectionStopped,
	items,
	empty,
	messagesRef,
	onSend,
	onStop,
	stopVisible,
	stopDisabled,
	stopLabel,
	onSendNow,
	onSendQueuedNow,
	queueRefusal,
	onEscapeStop,
	queued,
	queuedActions,
	textareaRef,
	composerPlaceholder,
	sendUnavailable,
	initialDraftValue,
	initialAsking,
	draftResetKey,
	onAskingChange,
	composerNotice,
	mention,
	onResolveApproval,
	onApprovalPreview,
	previewSlot,
	checkpointPreviewSlot,
	globalOverlaySlot,
	composerOverlaySlot,
	workbenchRef,
	workbenchClassName,
	workbenchStyle,
	beforeMessagesSlot,
	emptySlot,
	renderItem,
	pendingConsultIds,
	onOpenTaskArtifact,
	attachmentAccess,
	failureLineActions,
	answerDrawnAtOnceId = null,
	stepsElsewhere = false,
	statusLine = null,
	aboveComposerSlot,
	edit,
}: InRoomChatShellViewProps) {
	const sharedServer = useRemoteClientContext().sharedServer;
	// At the phone breakpoint the model moves to the header and the row under the box goes.
	const phone = usePhoneWidth();
	const messagesElRef = useRef<HTMLDivElement | null>(null);
	const dockElRef = useRef<HTMLDivElement | null>(null);
	// The column holding the dock and the composer, where the dock's height is
	// kept for the composer's notices to read.
	const columnElRef = useRef<HTMLElement | null>(null);
	const autoFollowRef = useRef(true);
	const lastItemIdRef = useRef<string | null>(null);
	const lastScrollTopRef = useRef(0);
	const prevItemsRef = useRef<ChatItem[]>(items);
	// The turn the user just sent (see groupIntoTurns). Kept until the next
	// send so a short answer never snaps the view back when the turn ends.
	const [reservedTurnId, setReservedTurnId] = useState<string | null>(null);
	// A smooth programmatic scroll (the send, a pill click) is running until
	// this time: the per-tick bottom pin must not cut it short.
	const smoothScrollUntilRef = useRef(0);
	// Where that smooth scroll lands: its scroll there ends it.
	const glideTargetRef = useRef<number | null>(null);
	// A glide the reader cut short: until it would have landed, reaching the
	// bottom is the glide's leftover, not the reader coming back.
	const glideInterruptedUntilRef = useRef(0);
	// Gesture bookkeeping for the follow decision (see FOLLOW_RESUME_BOTTOM_PX).
	const lastGestureAtRef = useRef(0);
	const lastDownGestureAtRef = useRef(0);
	const lastUpGestureAtRef = useRef(0);
	const lastProgrammaticScrollAtRef = useRef(0);
	const lastScrollHeightRef = useRef(0);
	const [showJumpToLatest, setShowJumpToLatest] = useState(false);
	const [dockPresent, setDockPresent] = useState(false);
	const lastItem = items[items.length - 1];
	// Busy spans the whole turn (agent_start -> agent_end). Thinking phases
	// and gaps between tool calls used to read as dead air because the
	// indicator vanished once anything followed the user's message; hide it
	// only while assistant text is actually growing on screen.
	const visiblyStreaming = lastItem?.kind === "assistant" && lastItem.streaming === true && !!lastItem.text;
	// The one "Reconnecting…" the page shows, in the working dot's place.
	const turnStatusLine = !connected && reconnectState === "reconnecting" && !connectionStopped ? "Reconnecting…" : statusLine;
	const showThinkingIndicator = Boolean(turnStatusLine) || (busy && items.length > 0 && !visiblyStreaming);
	const [boxHolds, setBoxHolds] = useState(false);
	const queuedSlot = useMemo(() => (queued && queued.length > 0 && queuedActions ? <QueuedBubbles key="queued" messages={queued} actions={queuedActions} boxHolds={boxHolds} /> : null), [queued, queuedActions, boxHolds]);
	const soleApproval = soleKeyboardApproval(items);
	const keyboardApproval = useMemo(() => {
		if (!soleApproval) return null;
		const { enter, escape } = keyboardAnswers(soleApproval);
		return {
			approve: () => onResolveApproval(soleApproval.requestId, enter[0], enter[1]),
			decline: () => onResolveApproval(soleApproval.requestId, escape[0], escape[1]),
		};
	}, [soleApproval, onResolveApproval]);
	// The context ring and Reconnect: under the box on wider screens, inside it
	// on the phone. Before the room's first ready frame, an empty ring.
	const offlineWord = !connected && !connectionStopped && reconnectState !== "reconnecting" ? "Offline" : null;
	const contextSlot = (
		<>
			{contextHealth ? (
				<ContextPill
					status={contextHealth}
					usage={usage}
					currentModelLabel={currentModelLabel}
					currentModelProvider={currentModelProvider}
					connected={connected}
					reconnectState={reconnectState}
					stopped={!!connectionStopped}
				/>
			) : (
				<span className={`composer-context-pill composer-context-waiting ${offlineWord ? "offline" : "unknown"}`} role="status" aria-label={offlineWord ?? "Context: appears when the room is ready"}>
					<ContextRing percent={null} />
					{offlineWord && <span className="composer-context-pill-label">{offlineWord}</span>}
				</span>
			)}
			{!connected && reconnectState === "failed" && onReconnect && !connectionStopped && (
				<button type="button" className="rs-btn rs-btn-sm composer-reconnect-btn" title={sharedServer ? "Try again now. If it keeps failing, reload the page or tell your admin." : "The automatic reconnect gave up. Try again now. If it keeps failing, restart exxperts."} onClick={onReconnect}>Reconnect</button>
			)}
		</>
	);
	const composerLayoutClass = [
		"composer-layout",
		composerRightActions ? "with-actions" : "",
	].filter(Boolean).join(" ");

	const setMessagesNode = useCallback((node: HTMLDivElement | null) => {
		messagesElRef.current = node;
		assignRef(messagesRef, node);
	}, [messagesRef]);

	// The app's own bottom pin: remembered, so the scroll event it causes is
	// never mistaken for the reader.
	const pinToBottom = useCallback((el: HTMLElement) => {
		lastProgrammaticScrollAtRef.current = performance.now();
		el.scrollTop = el.scrollHeight;
		lastScrollTopRef.current = el.scrollTop;
		lastScrollHeightRef.current = el.scrollHeight;
	}, []);

	// Gestures up stop following at once. Passive listeners, a boolean and a
	// timestamp each; a gesture up also stops a send or pill glide in progress
	// where the reader is, so it holds from the first moment after Send.
	useEffect(() => {
		const el = messagesElRef.current;
		if (!el) return;
		const stopFollowing = () => {
			autoFollowRef.current = false;
			const now = performance.now();
			if (now < smoothScrollUntilRef.current) {
				glideInterruptedUntilRef.current = smoothScrollUntilRef.current;
				lastProgrammaticScrollAtRef.current = now;
				// An instant write to the current position cancels the smooth one.
				if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollTop, behavior: "auto" });
				else el.scrollTop = el.scrollTop;
			}
			smoothScrollUntilRef.current = 0;
			glideTargetRef.current = null;
		};
		const onWheel = (event: WheelEvent) => {
			const now = performance.now();
			lastGestureAtRef.current = now;
			if (event.deltaY > 0) lastDownGestureAtRef.current = now;
			if (event.deltaY < 0) {
				lastUpGestureAtRef.current = now;
				// Whether the chat overflows, not scrollTop: the browser may have applied
				// this wheel's scroll already, so a wheel that reached the top reads 0.
				if (el.scrollHeight - el.clientHeight > FOLLOW_RESUME_BOTTOM_PX) stopFollowing();
			}
		};
		let touchY: number | null = null;
		const onTouchStart = (event: TouchEvent) => {
			lastGestureAtRef.current = performance.now();
			touchY = event.touches[0]?.clientY ?? null;
		};
		const onTouchMove = (event: TouchEvent) => {
			lastGestureAtRef.current = performance.now();
			const y = event.touches[0]?.clientY;
			// A finger moving down drags the content down: reading back up.
			if (y !== undefined && touchY !== null && y > touchY) {
				lastUpGestureAtRef.current = lastGestureAtRef.current;
				stopFollowing();
			} else if (y !== undefined && touchY !== null && y < touchY) lastDownGestureAtRef.current = lastGestureAtRef.current;
			if (y !== undefined) touchY = y;
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			const up = event.key === "PageUp" || event.key === "ArrowUp" || event.key === "Home";
			const down = event.key === "PageDown" || event.key === "ArrowDown" || event.key === "End";
			if (!up && !down) return;
			const target = event.target as HTMLElement | null;
			if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable)) return;
			if (down) {
				lastDownGestureAtRef.current = performance.now();
				return;
			}
			lastUpGestureAtRef.current = performance.now();
			stopFollowing();
		};
		el.addEventListener("wheel", onWheel, { passive: true });
		el.addEventListener("touchstart", onTouchStart, { passive: true });
		el.addEventListener("touchmove", onTouchMove, { passive: true });
		document.addEventListener("keydown", onKeyDown);
		return () => {
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("touchstart", onTouchStart);
			el.removeEventListener("touchmove", onTouchMove);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [empty]);

	const handleMessagesScroll = useCallback(() => {
		const el = messagesElRef.current;
		if (!el) return;
		const now = performance.now();
		const previousScrollTop = lastScrollTopRef.current;
		const previousScrollHeight = lastScrollHeightRef.current;
		lastScrollTopRef.current = el.scrollTop;
		lastScrollHeightRef.current = el.scrollHeight;
		// A glide that has landed: its own last step, and from here a scroll is the reader's again.
		if (now < smoothScrollUntilRef.current && glideTargetRef.current !== null && Math.abs(el.scrollTop - glideTargetRef.current) <= 1) {
			smoothScrollUntilRef.current = 0;
			glideTargetRef.current = null;
			lastProgrammaticScrollAtRef.current = now;
			return;
		}
		// The app's own writes and glides decide nothing.
		if (now < smoothScrollUntilRef.current || now - lastProgrammaticScrollAtRef.current < PROGRAMMATIC_SCROLL_WINDOW_MS) return;
		// Content that shrank clamps scrollTop; that is not the reader either.
		const shrank = el.scrollHeight < previousScrollHeight;
		if (!shrank) {
			// Moving with no wheel or touch behind it: the scrollbar, or keys.
			const noGesture = now - lastGestureAtRef.current > GESTURE_SCROLL_WINDOW_MS;
			if (el.scrollTop < previousScrollTop - 1 && noGesture) {
				autoFollowRef.current = false;
			}
			// The reader reached the true bottom themselves: follow again.
			if (!autoFollowRef.current && bottomDistance(el) <= FOLLOW_RESUME_BOTTOM_PX && now >= glideInterruptedUntilRef.current) {
				autoFollowRef.current = true;
			}
			// Or scrolled down to just short of a bottom that keeps moving away.
			const downOnPurpose = noGesture || now - lastDownGestureAtRef.current <= GESTURE_SCROLL_WINDOW_MS;
			const caughtUp = el.scrollTop > previousScrollTop && bottomDistance(el) <= FOLLOW_CATCH_BOTTOM_PX && downOnPurpose && now - lastUpGestureAtRef.current > UP_GESTURE_QUIET_MS;
			if (!autoFollowRef.current && caughtUp && now >= glideInterruptedUntilRef.current) {
				autoFollowRef.current = true;
			}
		}
		setShowJumpToLatest(!autoFollowRef.current && shouldShowJumpToLatest(el, empty));
	}, [empty]);

	/** Glides to the bottom; false when there is no glide to run (reduced motion, no smooth scroll, already there). */
	const glideToBottom = useCallback((el: HTMLElement): boolean => {
		const target = Math.max(0, el.scrollHeight - el.clientHeight);
		if (prefersReducedMotion() || typeof el.scrollTo !== "function" || Math.abs(el.scrollTop - target) <= 1) return false;
		smoothScrollUntilRef.current = performance.now() + SMOOTH_SCROLL_MAX_MS;
		glideTargetRef.current = target;
		el.scrollTo({ top: target, behavior: "smooth" });
		return true;
	}, []);

	// The one animated scroll besides the send: the stream's own ticks never
	// animate, and they hold off until this glide has landed.
	const jumpToLatest = useCallback(() => {
		const el = messagesElRef.current;
		if (!el) return;
		autoFollowRef.current = true;
		setShowJumpToLatest(false);
		if (!glideToBottom(el)) pinToBottom(el);
	}, [pinToBottom, glideToBottom]);

	// The above-composer dock (consult / task card) shares the column with the
	// messages: when it mounts or grows it shrinks the scroll area from below,
	// which used to cut the latest message mid-line. Observe the messages box
	// and the dock slot, and re-pin to the bottom while auto-following (or
	// refresh the jump-to-latest affordance otherwise). The re-pin runs now AND
	// on the next frame: WebKit can deliver the observation while the scroll
	// geometry still reflects the previous layout, which would clamp the write.
	useEffect(() => {
		const el = messagesElRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const dock = dockElRef.current;
		// With no dock nothing is measured, so what the last dock left behind
		// is cleared here.
		const column = columnElRef.current;
		if (!dock) {
			setDockPresent(false);
			column?.style.removeProperty("--above-composer-dock-height");
		}
		// Re-pins only while following; a resize never moves a reader who
		// stopped following, it only refreshes the pill.
		const pinOrRefresh = () => {
			if (performance.now() < smoothScrollUntilRef.current) return;
			if (autoFollowRef.current) pinToBottom(el);
			else setShowJumpToLatest(shouldShowJumpToLatest(el, empty));
		};
		const observer = new ResizeObserver(() => {
			// The scrollbar gutter the messages keep (8px styled in Chromium,
			// wider in a browser that draws its own): the topbar centres on
			// what is left, so the room name starts where the answers do and
			// the actions end where the person's message bubbles end.
			column?.style.setProperty("--messages-gutter", `${el.offsetWidth - el.clientWidth}px`);
			if (dock) {
				setDockPresent(dock.offsetHeight > 0);
				// The room's notices float above the composer; this keeps them
				// above the dock too (the workspace hint, a consult card).
				column?.style.setProperty("--above-composer-dock-height", `${dock.offsetHeight}px`);
			}
			pinOrRefresh();
			requestAnimationFrame(pinOrRefresh);
		});
		observer.observe(el);
		if (dock) observer.observe(dock);
		return () => observer.disconnect();
	}, [empty, aboveComposerSlot != null, pinToBottom]);

	useLayoutEffect(() => {
		const el = messagesElRef.current;
		if (!el) return;

		// A live send appends exactly one user message to the list as it was
		// (its last answer may get its unshown rest in the same render, so it
		// is compared by id); anything else that changes the first item (a
		// room switch, a fresh thread, a refetch after reattach) is a new list
		// and drops the reservation, so those still open at the bottom as before.
		const prevItems = prevItemsRef.current;
		prevItemsRef.current = items;
		const appendedSend = items.length === prevItems.length + 1
			&& lastItem?.kind === "user"
			&& (prevItems.length === 0 || items[items.length - 2]?.id === prevItems[prevItems.length - 1]?.id);
		if (appendedSend) {
			if (lastItem.id !== reservedTurnId) {
				// Render the reserved space first; this effect runs again for it.
				autoFollowRef.current = true;
				setReservedTurnId(lastItem.id);
				return;
			}
		} else if (reservedTurnId && items !== prevItems && items[0] !== prevItems[0]) {
			setReservedTurnId(null);
		}

		const lastItemId = lastItem?.id ?? null;
		const lastItemChanged = lastItemIdRef.current !== lastItemId;
		lastItemIdRef.current = lastItemId;
		if (lastItemChanged && lastItem?.kind === "user") {
			autoFollowRef.current = true;
			if (lastItem.id === reservedTurnId) {
				// The reserved turn is at least the box's height, so the bottom
				// of the list is the sent message at the top of the box, with
				// what sits above it just out of view (fitReservedTurn). The
				// view stays where it lands: the answer grows below until the
				// reader scrolls down to it.
				fitReservedTurn(el);
				if (!glideToBottom(el)) pinToBottom(el);
				autoFollowRef.current = false;
				setShowJumpToLatest(false);
				return;
			}
		}

		if (performance.now() < smoothScrollUntilRef.current) return;

		if (autoFollowRef.current) {
			pinToBottom(el);
			setShowJumpToLatest(false);
			return;
		}

		// Each reveal tick commits one items change, so while not following
		// this measures the growing reply once per tick and never per token.
		setShowJumpToLatest(shouldShowJumpToLatest(el, empty));
	}, [empty, items, lastItem, showThinkingIndicator, reservedTurnId, pinToBottom, glideToBottom, queued?.length]);

	return (
		<div className="app">
			<SidebarDrawerBackdrop />
			{sidebar}

			<div ref={workbenchRef} className={`workbench ${withPreview ? "with-preview" : ""} ${workbenchClassName ?? ""}`.trim()} style={workbenchStyle}>
				<main className="main" ref={columnElRef}>
					<div className="topbar">
						<div className="left">
							{onHome && (
								<button className="topbar-home-btn" aria-label={BACK_TO_ROOMS_LABEL} title={BACK_TO_ROOMS_LABEL} onClick={onHome}>
									<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
										<path d="M2.5 7.5 8 2.5l5.5 5" />
										<path d="M4 7v6h8V7" />
									</svg>
								</button>
							)}
							<div className="title-stack">
								<span className="title">{activeDisplay || "…"}</span>
								{ownerSecondary && <span className="subtitle">{ownerSecondary}</span>}
								{phone && composerModelSlot?.("header")}
							</div>
							{busy && <span className="spinner" />}
						</div>
						{topbarActions && <div className="topbar-actions">{topbarActions}</div>}
					</div>

					{beforeMessagesSlot}
					<div className={`messages-frame${dockPresent ? " with-dock" : ""}`}>
						<div className="messages" ref={setMessagesNode} onScroll={handleMessagesScroll} data-has-unseen-latest={showJumpToLatest ? "true" : undefined}>
							<TranscriptItems
								items={items}
								empty={empty}
								emptySlot={emptySlot}
								renderItem={renderItem}
								onResolveApproval={onResolveApproval}
								onApprovalPreview={onApprovalPreview}
								pendingConsultIds={pendingConsultIds}
								onOpenTaskArtifact={onOpenTaskArtifact}
								attachmentAccess={attachmentAccess}
								showThinkingIndicator={showThinkingIndicator}
								busy={busy}
								reservedTurnId={reservedTurnId}
								failureLineActions={failureLineActions}
								answerDrawnAtOnceId={answerDrawnAtOnceId}
								turnStatusLine={turnStatusLine}
								stepsElsewhere={stepsElsewhere}
								queuedSlot={queuedSlot}
								edit={edit}
							/>
						</div>
						{showJumpToLatest && (
							<>
								<div className="jump-to-latest-fade" aria-hidden="true" />
								<button type="button" className="jump-to-latest" onClick={jumpToLatest} aria-label="Jump to latest message" title="Jump to the newest message">
									{busy ? "↓ New text" : "↓ Latest"}
								</button>
							</>
						)}
					</div>
					{aboveComposerSlot && (
						<div className="above-composer-dock" ref={dockElRef}>
							{aboveComposerSlot}
						</div>
					)}
					<ConnectionBanner connected={connected} reconnectState={reconnectState} onReconnect={onReconnect} stopped={connectionStopped} />

					<div className="composer">
						{composerOverlaySlot}
						<div className={composerLayoutClass}>
							<div className="composer-stack">
							<ComposerInput
								onSend={onSend}
								onStop={onStop}
								stopVisible={stopVisible}
								stopDisabled={stopDisabled}
								stopLabel={stopLabel}
								textareaRef={textareaRef}
								placeholder={composerPlaceholder}
								sendUnavailable={sendUnavailable}
								sendTitle={connected ? "Send" : "Waiting for the connection"}
								initialDraftValue={initialDraftValue}
								initialAsking={initialAsking}
								draftResetKey={draftResetKey}
								onAskingChange={onAskingChange}
								mention={mention}
								statusSlot={phone ? contextSlot : composerAttachSlot && <div className="composer-actions">{composerAttachSlot}</div>}
								rightActions={phone ? <>{composerAttachSlot}{composerRememberSlot}{composerRightActions}</> : composerRightActions}
								stagingSlot={composerStagingSlot}
								allowEmptySend={composerAllowEmptySend}
								onPasteFiles={composerOnPasteFiles}
								keyboardApproval={keyboardApproval}
								onSendNow={onSendNow}
								onSendQueuedNow={onSendQueuedNow}
								queueRefusal={queueRefusal}
								onEscapeStop={onEscapeStop}
								onBoxHoldsChange={setBoxHolds}
								notice={composerNotice}
							/>
							{/* Wider screens keep the box to the text, the paperclip and Send;
							    the meter, Remember and the model sit on one quiet row under it.
							    The phone has no such row: it would sit on the keyboard. */}
							{!phone && (
								<div className="composer-under-row">
									<div className="composer-under-left">
										{contextSlot}
										{composerRememberSlot && <div className="composer-actions composer-under-actions">{composerRememberSlot}</div>}
									</div>
									<div className="composer-under-right">{composerModelSlot?.("row")}</div>
								</div>
							)}
							</div>
						</div>
					</div>
				</main>
				{previewSlot}
				{checkpointPreviewSlot}
			</div>
			{globalOverlaySlot}
		</div>
	);
}
