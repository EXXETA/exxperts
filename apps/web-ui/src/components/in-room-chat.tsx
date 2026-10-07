import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, CSSProperties, KeyboardEvent, MutableRefObject, PointerEvent as ReactPointerEvent, ReactNode, Ref } from "react";
import { Approval, confirmApprovalLabels } from "./Approval";
import { ConsultThreadItem, Message, TaskThreadItem, ToolBundle, isBundleableToolItem, type MessageAttachmentAccess } from "./Message";
import { MentionConsultPopover, MentionConsultPopoverBusy, type MentionSupport } from "./mention-consult-popover";
import { rememberChipValue, type RememberReadEstimate } from "../remember-read";
import { useEscapeKey } from "./use-escape-key";
import { SpinnerIcon } from "./icons";
import { SidebarDrawerBackdrop } from "../sidebar-collapse";
import type { ApprovalPreviewData } from "../approval-preview";
import type { ChatItem, ContextHealthStatus } from "../types";
import { completeMention, detectMentionQuery, filterMentionCandidates, resolveLeadingMention, type MentionCandidateRoom } from "../mention-popover";
import { replyCopyTargets } from "../reply-copy";
import { formatModelWithProvider, modelDisplayName } from "../model-names";

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
	/** Desktop-only sidebar drag handle; mobile keeps the rail as an overlay. */
	sidebarResizable?: boolean;
	/** Phone-only affordance (hidden by CSS above the breakpoint): the rail
	 *  is a drawer there, so the topbar carries a direct way home. */
	onHome?: () => void;
	withPreview?: boolean;
	activeDisplay: string;
	ownerSecondary?: string | null;
	busy: boolean;
	usage: InRoomChatUsage;
	contextHealth?: ContextHealthStatus | null;
	/** How a Remember would read the open conversation; asked when the chip's popover opens, never on a turn. */
	loadRememberEstimate?: () => Promise<RememberReadEstimate>;
	currentModelLabel?: string | null;
	/** Provider behind that label. Tooltip only; the face stays the bare name. */
	currentModelProvider?: string | null;
	topbarActions?: ReactNode;
	composerRightActions?: ReactNode;
	/** Files UI slice: staged-attachment chips above the composer textarea. */
	composerStagingSlot?: ReactNode;
	/** Files UI slice: staged attachments make an attachments-only send legal. */
	composerAllowEmptySend?: boolean;
	/** #52: image files pasted into the textarea are handed here to be staged. */
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
	stopVisible?: boolean;
	stopDisabled?: boolean;
	stopLabel?: string;
	textareaRef?: Ref<HTMLTextAreaElement>;
	composerPlaceholder: string;
	sendUnavailable?: boolean;
	initialDraftValue?: string;
	draftResetKey?: string | number;
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
	aboveComposerSlot?: ReactNode;
}

function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return (n / 1000).toFixed(1) + "k";
	if (n < 1_000_000) return Math.round(n / 1000) + "k";
	return (n / 1_000_000).toFixed(1) + "M";
}

/**
 * Following the answer is decided by the reader's gestures, not by position
 * math (the tail of a trackpad gesture used to count as a move down, and a
 * near-bottom threshold then pulled the reader back). A gesture up (wheel,
 * touch, PageUp/ArrowUp/Home, a scrollbar drag) stops following at once,
 * wherever the view is. Following resumes only when the reader reaches the
 * true bottom themselves (within this distance), clicks the pill, or sends.
 */
const FOLLOW_RESUME_BOTTOM_PX = 2;
/** A scroll this soon after a wheel or touch event belongs to that gesture. */
const GESTURE_SCROLL_WINDOW_MS = 100;
/** A scroll this soon after the app wrote scrollTop is the app's own. */
const PROGRAMMATIC_SCROLL_WINDOW_MS = 50;
/** How long a smooth programmatic scroll may run before the bottom pin resumes. */
const SMOOTH_SCROLL_MS = 600;
/** A dropped socket this short is a blink, not news: the banner waits this long. */
const CONNECTION_BANNER_DELAY_MS = 800;

/** Why the room stopped when the connection is fine but its model cannot run, and the ways on. */
export interface ConnectionStopped {
	line: string;
	/** Settings, AI setup, at the provider's row; absent when signing in cannot help. */
	onSignIn?: () => void;
	/** This room's Room settings, Model. */
	onChooseModel: () => void;
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

function compactModelLabel(label: string): string {
	// currentModelLabel is already canonical for new sessions; historical
	// "Provider — Name" strings still pass through here.
	return modelDisplayName({ modelLabel: label }) || label;
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

function ContextPill({
	status,
	usage,
	loadRememberEstimate,
	currentModelLabel,
	currentModelProvider,
	connected,
	reconnectState = "idle",
	stopped = false,
}: {
	status: ContextHealthStatus;
	usage: InRoomChatUsage;
	loadRememberEstimate?: () => Promise<RememberReadEstimate>;
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
	const zone = offline ? "offline" : (status.zone ?? "unknown");
	const reconnecting = offline && reconnectState === "reconnecting";
	const label = offline
		? (reconnecting ? "Reconnecting…" : "Offline")
		: known
			? `${Math.round(status.checkpointPercent!)}% of recommended context`
			: "Measuring tokens";
	// Nothing here names plumbing the user did not install and cannot restart.
	// While a retry is running, say so; once it has given up, the Reconnect
	// button beside this pill is the next move, and restarting the app is the
	// one after that.
	const title = !offline
		? "Context and model details"
		: reconnecting
			? "This room lost its connection. Trying to pick it up again…"
			: "This room lost its connection. Use Reconnect to try again, or restart the app if it keeps happening.";

	useEscapeKey(() => setOpen(false), open);

	// Whether a Remember now would need parts: asked each time the popover
	// opens, so the line follows the conversation without touching a turn.
	// The loader is read through a ref so a parent re-render (every streamed
	// token) never asks again while the popover stays open.
	const [rememberEstimate, setRememberEstimate] = useState<RememberReadEstimate | null>(null);
	const loadRememberEstimateRef = useRef(loadRememberEstimate);
	loadRememberEstimateRef.current = loadRememberEstimate;
	useEffect(() => {
		const load = loadRememberEstimateRef.current;
		if (!open || !load) return;
		let cancelled = false;
		load().then((estimate) => { if (!cancelled) setRememberEstimate(estimate); }, () => { if (!cancelled) setRememberEstimate(null); });
		return () => { cancelled = true; };
	}, [open]);
	const rememberParts = rememberChipValue(rememberEstimate);

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
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls={open ? popoverId : undefined}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="context-health-dot" aria-hidden="true" />
				<span className="composer-context-pill-label">
					{connected && known
						// The phrase hides at the phone breakpoint: "10%" is the
						// meter there, the full sentence is desktop room.
						? <>{Math.round(status.checkpointPercent!)}%<span className="composer-context-pill-phrase"> of recommended context</span></>
						: label}
				</span>
			</button>
			{open && (
				<div className="composer-context-popover" id={popoverId} role="dialog" aria-label="Context and model details">
					{currentModelLabel && (
						<div className="composer-context-popover-row" title={`current chat model: ${formatModelWithProvider(currentModelLabel ?? "", currentModelProvider)}`}>
							<span>model</span>
							<strong>{compactModelLabel(currentModelLabel)}</strong>
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
					{rememberParts && (
						<div className="composer-context-popover-row" title="A memory model with a larger window reads it in one pass (Room settings, Model)">
							<span>remember</span>
							<strong>{rememberParts}</strong>
						</div>
					)}
					<div className="composer-context-popover-row">
						<span>connection</span>
						<strong>{connected ? "online" : stopped ? "paused" : reconnecting ? "reconnecting…" : "offline"}</strong>
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
	if (stopped && (connected || reconnectState === "failed")) {
		return (
			<div className="room-workspace-nudge room-model-notice" role="status">
				<span className="room-workspace-nudge-text">{stopped.line}</span>
				<div className="room-workspace-nudge-actions">
					<button type="button" className="rs-btn" onClick={stopped.onChooseModel}>Choose another model</button>
					{stopped.onSignIn && <button type="button" className="rs-btn rs-btn-primary" onClick={stopped.onSignIn}>Sign in</button>}
				</div>
			</div>
		);
	}
	if (!lost || !shown) return null;
	return (
		<div className="connection-banner" role="status">
			{reconnectState === "failed" ? (
				<>
					<span>Connection lost.</span>
					{onReconnect && <button type="button" className="connection-banner-action" onClick={onReconnect}>Reconnect</button>}
				</>
			) : (
				<>
					<SpinnerIcon size={14} />
					<span>Connection lost. Reconnecting…</span>
				</>
			)}
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
}

/**
 * The default transcript render. Consecutive web_search / fetch_url calls of
 * the SAME tool collapse into one ToolBundle line (interleavings split the
 * run, in order); a single-call run renders exactly as today. Grouping is
 * purely positional over the live items array, so a streaming turn grows its
 * bundle in place as calls land. The reply copy buttons are decided over the
 * same raw array (reply-copy.ts), untouched by the bundling.
 */
function renderTranscript(
	items: ChatItem[],
	busy: boolean,
	onResolveApproval: TranscriptItemsProps["onResolveApproval"],
	onApprovalPreview: TranscriptItemsProps["onApprovalPreview"],
	pendingConsultIds: TranscriptItemsProps["pendingConsultIds"],
	onOpenTaskArtifact: TranscriptItemsProps["onOpenTaskArtifact"],
	attachmentAccess: TranscriptItemsProps["attachmentAccess"],
): IndexedNode[] {
	const copyTargets = replyCopyTargets(items, busy);
	const keyboardApprovalId = soleKeyboardApproval(items)?.requestId ?? null;
	const rendered: IndexedNode[] = [];
	for (let index = 0; index < items.length; index++) {
		const it = items[index];
		if (isBundleableToolItem(it)) {
			let end = index;
			while (end + 1 < items.length) {
				const next = items[end + 1];
				if (next.kind === "tool" && next.name === it.name) end++;
				else break;
			}
			if (end > index) {
				rendered.push({ index, node: <ToolBundle key={it.id} items={items.slice(index, end + 1).filter(isBundleableToolItem)} /> });
				index = end;
				continue;
			}
		}
		rendered.push({ index, node:
			it.kind === "approval" ? (
				<Approval key={it.id} item={it} onResolve={onResolveApproval} onPreview={onApprovalPreview} keyboardHint={it.requestId === keyboardApprovalId} />
			) : it.kind === "consult" ? (
				<ConsultThreadItem key={it.id} item={it} pending={pendingConsultIds?.has(it.id) ?? false} />
			) : it.kind === "task" ? (
				<TaskThreadItem key={it.id} item={it} onOpenTaskArtifact={onOpenTaskArtifact} />
			) : (
				<Message key={it.id} item={it} attachmentAccess={attachmentAccess} copyText={copyTargets.get(it.id)?.text} copyTs={copyTargets.get(it.id)?.ts} />
			),
		});
	}
	return rendered;
}

/**
 * The one pending yes/no card the composer may answer by keyboard: Enter
 * approves and Escape declines while the composer is empty. With two cards
 * pending, or a card that asks for a choice or an answer, the keys keep
 * their usual meaning. Only the current turn is looked at (back to the last
 * user message), so the scan stays a few items long on every render.
 */
function soleKeyboardApproval(items: ChatItem[]): Extract<ChatItem, { kind: "approval" }> | null {
	let found: Extract<ChatItem, { kind: "approval" }> | null = null;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "user") break;
		if (item.kind !== "approval" || item.done) continue;
		if (found || item.uiKind !== "confirm") return null;
		found = item;
	}
	return found;
}

interface IndexedNode {
	/** Index of the first transcript item the node renders. */
	index: number;
	node: ReactNode;
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
function groupIntoTurns(items: ChatItem[], nodes: IndexedNode[], trailing: ReactNode, reservedTurnId: string | null): ReactNode[] {
	const out: ReactNode[] = [];
	let turn: { id: string; nodes: ReactNode[] } | null = null;
	const closeTurn = () => {
		if (!turn) return;
		out.push(
			<div key={`turn-${turn.id}`} className={`transcript-turn${turn.id === reservedTurnId ? " reserved" : ""}`}>
				{turn.nodes}
			</div>,
		);
		turn = null;
	};
	for (const { index, node } of nodes) {
		const item = items[index];
		if (item?.kind === "user") {
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
}: TranscriptItemsProps) {
	const thinking = showThinkingIndicator ? (
		<div key="thinking-row" className="thinking-row" role="status" aria-label="thinking">
			<span className="thinking-dot" aria-hidden="true" />
		</div>
	) : null;
	if (empty) return <>{emptySlot ?? null}{thinking}</>;
	const nodes: IndexedNode[] = renderItem
		? items.map((it, index) => ({ index, node: renderItem(it, index, items) }))
		: renderTranscript(items, busy, onResolveApproval, onApprovalPreview, pendingConsultIds, onOpenTaskArtifact, attachmentAccess);
	return <>{groupIntoTurns(items, nodes, thinking, reservedTurnId)}</>;
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
	draftResetKey?: string | number;
	mention?: MentionSupport;
	statusSlot?: ReactNode;
	rightActions?: ReactNode;
	/** Files UI slice: the staged-attachment chip row, rendered above the textarea. */
	stagingSlot?: ReactNode;
	/** Files UI slice: ready attachments make an empty-text send legal (the note alone rides). */
	allowEmptySend?: boolean;
	/** #52: files pasted into the textarea (images, documents alike) are handed here to be staged. */
	onPasteFiles?: (files: File[]) => void;
	/** The sole pending yes/no card, answered by Enter and Escape while the composer is empty. */
	keyboardApproval?: { approve: () => void; decline: () => void } | null;
}

function ComposerInput({
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
	draftResetKey,
	mention,
	statusSlot,
	rightActions,
	stagingSlot,
	allowEmptySend = false,
	onPasteFiles,
	keyboardApproval = null,
}: ComposerInputProps) {
	const [draft, setDraft] = useState(() => initialDraftValue ?? "");
	const [caret, setCaret] = useState(0);
	const [mentionIndex, setMentionIndex] = useState(0);
	// §8.3: the visible rejection when a composer @-mention is attempted while a
	// consult card is docked. Cleared on the next keystroke so it never lingers.
	const [consultGateNotice, setConsultGateNotice] = useState<string | null>(null);
	// Esc dismisses the popover for the current trigger; any further typing
	// (onChange) clears this so it reopens.
	const [mentionDismissed, setMentionDismissed] = useState(false);
	const textareaNodeRef = useRef<HTMLTextAreaElement | null>(null);
	// Caret to restore after a programmatic draft edit (mention completion).
	const pendingCaretRef = useRef<number | null>(null);
	const sendDisabled = sendUnavailable || (!draft.trim() && !allowEmptySend);

	// Mention popover state. The interactive picker opens only when a trigger is
	// active, the room is not busy, it has not been dismissed, and at least one
	// room matches — so an unmatched '@' never traps Enter. While busy a trigger
	// shows only the disabled affordance (with a title), and submit falls back to
	// normal send.
	const rawTrigger = mention ? detectMentionQuery(draft, caret) : null;
	const mentionQuery = mention && !mention.busy && !mentionDismissed ? rawTrigger : null;
	const mentionMatches: MentionCandidateRoom[] = mention && mentionQuery
		? filterMentionCandidates(mention.candidates, mentionQuery.query, mention.currentRoomId)
		: [];
	const mentionOpen = Boolean(mentionQuery) && mentionMatches.length > 0;
	const mentionBusyActive = Boolean(mention?.busy) && rawTrigger !== null;
	const activeMentionIndex = mentionMatches.length > 0 ? Math.min(mentionIndex, mentionMatches.length - 1) : 0;

	const setTextareaNode = useCallback((node: HTMLTextAreaElement | null) => {
		textareaNodeRef.current = node;
		assignRef(textareaRef, node);
	}, [textareaRef]);

	useEffect(() => {
		setDraft(initialDraftValue ?? "");
		setMentionDismissed(false);
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

	// Restore the caret after a mention completion rewrote the draft.
	useLayoutEffect(() => {
		const el = textareaNodeRef.current;
		if (!el || pendingCaretRef.current == null) return;
		const pos = pendingCaretRef.current;
		pendingCaretRef.current = null;
		el.focus();
		el.setSelectionRange(pos, pos);
		setCaret(pos);
	}, [draft]);

	const syncCaret = useCallback((el: HTMLTextAreaElement) => {
		setCaret(el.selectionStart ?? el.value.length);
	}, []);

	const selectMention = useCallback((room: MentionCandidateRoom) => {
		const trigger = detectMentionQuery(draft, caret);
		if (!trigger) return;
		const { text, caret: nextCaret } = completeMention(draft, trigger, room);
		pendingCaretRef.current = nextCaret;
		setMentionDismissed(false);
		setDraft(text);
	}, [draft, caret]);

	const submitDraft = useCallback(() => {
		if (sendDisabled) return;
		// Submit routing: a leading mention of a known room consults it instead of
		// sending normally. Skipped while busy (falls back to normal send).
		if (mention && !mention.busy) {
			const resolved = resolveLeadingMention(draft, mention.candidates, mention.currentRoomId);
			if (resolved) {
				// §8.3: a composer @-mention always means a FRESH consult, but while a
				// card is docked that is rejected VISIBLY (the card is where you follow
				// up) — no auto-dismiss (an affirmative keystroke must not drop an
				// untransferred stack). The draft is kept so nothing is lost.
				if (mention.activeConsultDisplayName) {
					setConsultGateNotice(`a consult with @${mention.activeConsultDisplayName} is open. Follow up in the card, or dismiss it first.`);
					return;
				}
				// Only clear the composer if the consult was actually accepted — if
				// one is already active (or the socket is down) the request is
				// rejected, and silently wiping the user's typed question would lose
				// it with no feedback. Keep the draft so they can retry.
				const accepted = mention.onConsultRequest(resolved.room.id, resolved.question);
				if (accepted) {
					setDraft("");
					setMentionDismissed(false);
				}
				return;
			}
		}
		const accepted = onSend(draft);
		if (accepted) {
			setDraft("");
		}
	}, [draft, onSend, sendDisabled, mention]);

	function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
		if (mentionOpen) {
			// Navigation and selection never submit the message (spec invariant).
			if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex((i) => (Math.min(i, mentionMatches.length - 1) + 1) % mentionMatches.length); return; }
			if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((i) => (Math.min(i, mentionMatches.length - 1) - 1 + mentionMatches.length) % mentionMatches.length); return; }
			if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectMention(mentionMatches[activeMentionIndex]); return; }
			if (e.key === "Escape") { e.preventDefault(); setMentionDismissed(true); return; }
		}
		// An empty composer answers the one pending yes/no card; with text in
		// it, Enter sends as always and the card stays.
		if (keyboardApproval && draft === "" && !e.shiftKey && (e.key === "Enter" || e.key === "Escape")) {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Enter") keyboardApproval.approve();
			else keyboardApproval.decline();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submitDraft();
		}
	}

	// #52: a pasted file stages as an attachment, through the exact path the
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
			{consultGateNotice && <div className="composer-consult-gate" role="status">{consultGateNotice}</div>}
			{stagingSlot}
			<textarea
				ref={setTextareaNode}
				value={draft}
				onChange={(e) => { setMentionDismissed(false); setConsultGateNotice(null); setDraft(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
				onKeyUp={(e) => syncCaret(e.currentTarget)}
				onClick={(e) => syncCaret(e.currentTarget)}
				onSelect={(e) => syncCaret(e.currentTarget)}
				onKeyDown={handleComposerKeyDown}
				onPaste={handleComposerPaste}
				placeholder={placeholder}
				rows={2}
				spellCheck={false}
			/>
			<div className="composer-box-bottom">
				<div className="composer-box-status">{statusSlot}</div>
				<div className="composer-box-controls">
					{rightActions && <div className="composer-actions">{rightActions}</div>}
					{stopVisible ? (
						<button className="send-btn stop-btn" onClick={onStop} disabled={stopDisabled} aria-label={stopLabel} title={stopLabel}><span aria-hidden="true">■</span></button>
					) : (
						<button className="send-btn" onClick={submitDraft} disabled={sendDisabled} aria-label="Send" title={sendTitle}>↑</button>
					)}
				</div>
			</div>
		</div>
	);
}

export function InRoomChatShellView({
	sidebar,
	sidebarResizable = false,
	onHome,
	withPreview = false,
	activeDisplay,
	ownerSecondary,
	busy,
	usage,
	contextHealth,
	loadRememberEstimate,
	currentModelLabel,
	currentModelProvider,
	topbarActions,
	composerRightActions,
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
	textareaRef,
	composerPlaceholder,
	sendUnavailable,
	initialDraftValue,
	draftResetKey,
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
	aboveComposerSlot,
}: InRoomChatShellViewProps) {
	const messagesElRef = useRef<HTMLDivElement | null>(null);
	const dockElRef = useRef<HTMLDivElement | null>(null);
	const sidebarResizeStartRef = useRef<{ clientX: number; width: number } | null>(null);
	const [sidebarWidth, setSidebarWidth] = useState(260);
	const [sidebarResizing, setSidebarResizing] = useState(false);
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
	// A glide the reader cut short: until it would have landed, reaching the
	// bottom is the glide's leftover, not the reader coming back.
	const glideInterruptedUntilRef = useRef(0);
	// Gesture bookkeeping for the follow decision (see FOLLOW_RESUME_BOTTOM_PX).
	const lastGestureAtRef = useRef(0);
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
	const showThinkingIndicator = busy && items.length > 0 && !visiblyStreaming;
	const soleApproval = soleKeyboardApproval(items);
	const keyboardApproval = useMemo(() => {
		if (!soleApproval) return null;
		const labels = confirmApprovalLabels(soleApproval);
		return {
			approve: () => onResolveApproval(soleApproval.requestId, true, labels.approve),
			decline: () => onResolveApproval(soleApproval.requestId, false, labels.decline),
		};
	}, [soleApproval, onResolveApproval]);
	const composerLayoutClass = [
		"composer-layout",
		composerRightActions ? "with-actions" : "",
	].filter(Boolean).join(" ");
	const clampSidebarWidth = (width: number): number => Math.min(420, Math.max(220, width));
	const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		sidebarResizeStartRef.current = { clientX: event.clientX, width: sidebarWidth };
		setSidebarResizing(true);
	}, [sidebarWidth]);
	const moveSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		const start = sidebarResizeStartRef.current;
		if (!start) return;
		setSidebarWidth(clampSidebarWidth(start.width + event.clientX - start.clientX));
	}, []);
	const finishSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		if (sidebarResizeStartRef.current) {
			try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
		}
		sidebarResizeStartRef.current = null;
		setSidebarResizing(false);
	}, []);
	const keySidebarResize = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			setSidebarWidth((width) => clampSidebarWidth(width + (event.key === "ArrowRight" ? 16 : -16)));
		} else if (event.key === "Home") {
			event.preventDefault();
			setSidebarWidth(220);
		} else if (event.key === "End") {
			event.preventDefault();
			setSidebarWidth(420);
		}
	}, []);
	const appStyle = sidebarResizable ? ({ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties) : undefined;

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
		};
		const onWheel = (event: WheelEvent) => {
			lastGestureAtRef.current = performance.now();
			if (event.deltaY < 0) stopFollowing();
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
			if (y !== undefined && touchY !== null && y > touchY) stopFollowing();
			if (y !== undefined) touchY = y;
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "PageUp" && event.key !== "ArrowUp" && event.key !== "Home") return;
			const target = event.target as HTMLElement | null;
			if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable)) return;
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
		// The app's own writes and glides decide nothing.
		if (now < smoothScrollUntilRef.current || now - lastProgrammaticScrollAtRef.current < PROGRAMMATIC_SCROLL_WINDOW_MS) return;
		// Content that shrank clamps scrollTop; that is not the reader either.
		const shrank = el.scrollHeight < previousScrollHeight;
		if (!shrank) {
			// Moving up with no wheel or touch behind it: the scrollbar, or keys.
			if (el.scrollTop < previousScrollTop - 1 && now - lastGestureAtRef.current > GESTURE_SCROLL_WINDOW_MS) {
				autoFollowRef.current = false;
			}
			// The reader reached the true bottom themselves: follow again.
			if (!autoFollowRef.current && bottomDistance(el) <= FOLLOW_RESUME_BOTTOM_PX && now >= glideInterruptedUntilRef.current) {
				autoFollowRef.current = true;
			}
		}
		setShowJumpToLatest(!autoFollowRef.current && shouldShowJumpToLatest(el, empty));
	}, [empty]);

	// The one animated scroll besides the send: the stream's own ticks never
	// animate, and they hold off until this glide has landed.
	const jumpToLatest = useCallback(() => {
		const el = messagesElRef.current;
		if (!el) return;
		autoFollowRef.current = true;
		setShowJumpToLatest(false);
		if (!prefersReducedMotion() && typeof el.scrollTo === "function") {
			smoothScrollUntilRef.current = performance.now() + SMOOTH_SCROLL_MS;
			el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
			return;
		}
		pinToBottom(el);
	}, [pinToBottom]);

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
		// Re-pins only while following; a resize never moves a reader who
		// stopped following, it only refreshes the pill.
		const pinOrRefresh = () => {
			if (performance.now() < smoothScrollUntilRef.current) return;
			if (autoFollowRef.current) pinToBottom(el);
			else setShowJumpToLatest(shouldShowJumpToLatest(el, empty));
		};
		const observer = new ResizeObserver(() => {
			if (dock) setDockPresent(dock.offsetHeight > 0);
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

		// A live send appends exactly one user message to the list as it was;
		// anything else that changes the first item (a room switch, a fresh
		// thread, a refetch after reattach) is a new list and drops the
		// reservation, so those still open at the bottom as before.
		const prevItems = prevItemsRef.current;
		prevItemsRef.current = items;
		const appendedSend = items.length === prevItems.length + 1
			&& lastItem?.kind === "user"
			&& (prevItems.length === 0 || items[items.length - 2] === prevItems[prevItems.length - 1]);
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
				// of the list is exactly the sent message at the top of the box.
				if (!prefersReducedMotion() && typeof el.scrollTo === "function") {
					smoothScrollUntilRef.current = performance.now() + SMOOTH_SCROLL_MS;
					el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
					setShowJumpToLatest(false);
					return;
				}
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
	}, [empty, items, lastItem, showThinkingIndicator, reservedTurnId, pinToBottom]);

	return (
		<div className={`app${sidebarResizable ? " sidebar-resizable" : ""}`} style={appStyle}>
			<SidebarDrawerBackdrop />
			{sidebar}
			{sidebarResizable && (
				<div
					className={`sidebar-resizer${sidebarResizing ? " is-dragging" : ""}`}
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize sidebar"
					aria-valuemin={220}
					aria-valuemax={420}
					aria-valuenow={sidebarWidth}
					tabIndex={0}
					onKeyDown={keySidebarResize}
					onPointerDown={startSidebarResize}
					onPointerMove={moveSidebarResize}
					onPointerUp={finishSidebarResize}
					onPointerCancel={finishSidebarResize}
				/>
			)}

			<div ref={workbenchRef} className={`workbench ${withPreview ? "with-preview" : ""} ${workbenchClassName ?? ""}`.trim()} style={workbenchStyle}>
				<main className="main">
					<div className="topbar">
						<div className="left">
							{onHome && (
								<button className="topbar-home-btn" aria-label="Back to rooms" title="Back to rooms" onClick={onHome}>
									<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
										<path d="M2.5 7.5 8 2.5l5.5 5" />
										<path d="M4 7v6h8V7" />
									</svg>
								</button>
							)}
							<span className="agent-label">talking to</span>
							<div className="title-stack">
								<span className="title">{activeDisplay || "…"}</span>
								{ownerSecondary && <span className="subtitle">{ownerSecondary}</span>}
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
								draftResetKey={draftResetKey}
								mention={mention}
								statusSlot={<>
									{contextHealth ? (
										<ContextPill
											status={contextHealth}
											usage={usage}
											loadRememberEstimate={loadRememberEstimate}
											currentModelLabel={currentModelLabel}
											currentModelProvider={currentModelProvider}
											connected={connected}
											reconnectState={reconnectState}
											stopped={!!connectionStopped}
										/>
									) : (
										<div className="composer-status" aria-label="Chat status">
											{currentModelLabel && <span title={`current chat model: ${formatModelWithProvider(currentModelLabel ?? "", currentModelProvider)}`}>model <strong>{compactModelLabel(currentModelLabel)}</strong></span>}
											<span><strong>{usage.turns}</strong> turn{usage.turns === 1 ? "" : "s"}</span>
											<span>↑ <strong>{fmtTok(usage.input)}</strong></span>
											<span>↓ <strong>{fmtTok(usage.output)}</strong></span>
											{usage.cacheRead > 0 && <span>cache <strong>{fmtTok(usage.cacheRead)}</strong></span>}
											<span><strong>{fmtCost(usage.cost)}</strong></span>
											{(usage.contextTokens ?? usage.totalTokens) > 0 && <span title="last assistant context">ctx <strong>{fmtTok(usage.contextTokens ?? usage.totalTokens)}</strong></span>}
											{!connectionStopped && <span className={`composer-connection ${connected ? "live" : ""}`}>{connected ? "online" : reconnectState === "reconnecting" ? "reconnecting…" : "offline"}</span>}
										</div>
									)}
									{!connected && reconnectState === "failed" && onReconnect && !connectionStopped && (
										<button type="button" className="icon-btn composer-reconnect-btn" title="The automatic reconnect gave up. Try again now. If the server isn't running, start it with: exxperts web" onClick={onReconnect}>Reconnect</button>
									)}
								</>}
								rightActions={composerRightActions}
								stagingSlot={composerStagingSlot}
								allowEmptySend={composerAllowEmptySend}
								onPasteFiles={composerOnPasteFiles}
								keyboardApproval={keyboardApproval}
							/>
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
