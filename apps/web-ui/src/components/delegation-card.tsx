import { useEffect, useState, type ReactNode } from "react";
import { MarkdownRenderer } from "./Markdown";
import { canFollowUp, canTransferConsult, consultHasDrift, type ConsultExchange, type ConsultState } from "../consult-stream";
import { artifactBasename, artifactKindLabel, isSvgArtifact, taskArtifactUrl, thumbnailFor, type TaskArtifact, type TaskState } from "../task-stream";

/**
 * The DelegationCard family (Consult MR-4). One base component with slots;
 * "consult" is the first variant, the Phase-2 specialist-task card will be the
 * second. The base only arranges the slots — a header row (speaker chip +
 * status subline + header tools), a question line, a status-stream slot, a
 * body/result area, an artifact-strip slot, and a footer (provenance meta +
 * right-aligned actions). Consult leaves the status-stream and artifact slots
 * empty; they exist as optional props so the Phase-2 variant can fill them
 * without a second layout. All state lives in the host (App) via the
 * consult-stream reducer — this file is purely presentational.
 *
 * Class names are the mockup's verbatim `.consult-*` names (see
 * consult-ui-mockups.html and the matching block in styles.css).
 */

export interface DelegationCardProps {
	/** Speaker chip content, e.g. "@euler" — the lila visitor accent, never the assistant's voice. */
	speaker: ReactNode;
	/** Status subline (e.g. "answering from euler's memory …"). */
	subline?: ReactNode;
	/** Header tools, right-aligned (e.g. the minimize control). */
	headerTools?: ReactNode;
	/** Uppercase micro-label + question text. */
	question?: { label?: string; text: string };
	/** Stacked-consult history (§8.4): earlier exchanges, above the current question. */
	historySlot?: ReactNode;
	/** Reserved for the Phase-2 status-stream area — consult leaves it empty. */
	statusStreamSlot?: ReactNode;
	/** Answer / result area. */
	body?: ReactNode;
	/** Reserved for the Phase-2 artifact strip — consult leaves it empty. */
	artifactStripSlot?: ReactNode;
	/** An inline notice above the footer (e.g. a memory-lag warning). */
	notice?: ReactNode;
	/** Stacked-consult follow-up input (§8.2), just above the footer actions. */
	followUpSlot?: ReactNode;
	/** Footer provenance meta (mono, muted) or a live status. */
	footerMeta?: ReactNode;
	/** Footer actions, right-aligned. */
	footerActions?: ReactNode;
}

export function DelegationCard({ speaker, subline, headerTools, question, historySlot, statusStreamSlot, body, artifactStripSlot, notice, followUpSlot, footerMeta, footerActions }: DelegationCardProps) {
	return (
		<div className="consult-card">
			<div className="head-row">
				<span className="consult-chip">{speaker}</span>
				{subline && <span className="consult-sub">{subline}</span>}
				{headerTools && <div className="head-tools">{headerTools}</div>}
			</div>
			{historySlot}
			{question && (
				<div className="consult-q">
					{question.label && <span className="q-label">{question.label}</span>}
					{question.text}
				</div>
			)}
			{statusStreamSlot}
			{body}
			{artifactStripSlot}
			{notice}
			{followUpSlot}
			{(footerMeta || footerActions) && (
				<div className="consult-foot">
					{footerMeta}
					{footerActions && <div className="consult-actions">{footerActions}</div>}
				</div>
			)}
		</div>
	);
}

export interface ConsultDockProps {
	state: ConsultState;
	onMinimize: () => void;
	onOpen: () => void;
	onStop: () => void;
	onDismiss: () => void;
	/** MR-5 wires this to the pending-queue transfer; inert stub for MR-4. */
	onTransfer: () => void;
	/** Stacked consult (§8.2): ask the same room a follow-up from the done card.
	 * Returns whether it was accepted (false → socket down / rejected: draft kept). */
	onFollowUp: (question: string) => boolean;
}

/** "8 Jul 2026" — the consulted room's memory-write date for the "as of" line. */
function formatAsOfDate(iso: string | null): string | null {
	if (!iso) return null;
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return null;
	return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function consultSpeaker(state: ConsultState): string {
	return `@${state.targetDisplayName ?? state.targetRoomId ?? "room"}`;
}

/** Possessive display name for the sublines ("euler's memory …"). */
function consultOwner(state: ConsultState): string {
	return state.targetDisplayName ?? state.targetRoomId ?? "the room";
}

function ConsultAnswer({ state }: { state: ConsultState }) {
	const streaming = state.phase === "streaming";
	const halted = state.phase === "stopped" || state.phase === "failed";
	if (!state.text && streaming) {
		// Nothing revealed yet — just the blinking caret so the card reads as live.
		return (
			<div className="consult-answer">
				<span className="caret" />
			</div>
		);
	}
	if (!state.text) return null;
	return (
		<div className={`consult-answer${halted ? " is-halted" : ""}`}>
			<div className="md">
				<MarkdownRenderer renderMermaid={!streaming}>{state.text}</MarkdownRenderer>
			</div>
			{streaming && <span className="caret" />}
		</div>
	);
}

/** "8 Jul 2026" from an ISO string, or null. */
function formatIsoDate(iso: string | null): string | null {
	return formatAsOfDate(iso);
}

/**
 * Stacked-consult history (§8.4): the earlier COMPLETED exchanges, oldest-first,
 * each a collapsed disclosure of its question + answer. The latest (current)
 * exchange stays expanded in the card body below — these are the context above
 * it. A per-exchange "as of" date shows when it differs from its neighbour (drift,
 * §8.5). Renders nothing when there is no prior exchange.
 */
function ConsultHistory({ exchanges }: { exchanges: ConsultExchange[] }) {
	if (exchanges.length === 0) return null;
	return (
		<div className="consult-history">
			{exchanges.map((exchange, index) => {
				const prev = index > 0 ? exchanges[index - 1] : null;
				const fpr = exchange.l1bFingerprint ? `${exchange.l1bFingerprint.algorithm}:${exchange.l1bFingerprint.value}` : null;
				const prevFpr = prev?.l1bFingerprint ? `${prev.l1bFingerprint.algorithm}:${prev.l1bFingerprint.value}` : null;
				const drifted = index > 0 && fpr !== prevFpr;
				const asOf = drifted ? formatIsoDate(exchange.asOfCheckpointAt) : null;
				return (
					<details className="consult-history-item" key={index}>
						<summary>
							<span className="hx-num">Exchange {index + 1}</span>
							<span className="hx-q">{exchange.question}</span>
							{asOf && <span className="hx-asof">memory updated · as of {asOf}</span>}
						</summary>
						<div className="consult-answer">
							<div className="md">
								<MarkdownRenderer>{exchange.answer}</MarkdownRenderer>
							</div>
						</div>
					</details>
				);
			})}
		</div>
	);
}

/**
 * The done-card follow-up input (§8.2): "the CARD is the conversation with the
 * room." Submitting asks the SAME room a follow-up that builds on the stack. A
 * composer @-mention, by contrast, always starts a fresh consult (§8.2/§8.3).
 */
function ConsultFollowUp({ speaker, onFollowUp }: { speaker: string; onFollowUp: (question: string) => boolean }) {
	const [draft, setDraft] = useState("");
	const submit = () => {
		const question = draft.trim();
		if (!question) return;
		// Only clear the draft when the follow-up was accepted — a rejection
		// (socket down, reducer refused) must not eat the user's typed question
		// (hardening 2026-07-11; same rule as the composer's consult path).
		if (onFollowUp(question)) setDraft("");
	};
	return (
		<div className="consult-followup">
			<input
				className="consult-followup-input"
				type="text"
				value={draft}
				placeholder={`Follow up with ${speaker}…`}
				aria-label={`Follow up with ${speaker}`}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						submit();
					}
				}}
			/>
			<button className="btn" type="button" onClick={submit} disabled={!draft.trim()}>
				Ask
			</button>
		</div>
	);
}

/**
 * The docked consult surface (variant A): the expanded card, or — when
 * minimized — the folded pill. Renders nothing when there is no consult.
 */
export function ConsultDock({ state, onMinimize, onOpen, onStop, onDismiss, onTransfer, onFollowUp }: ConsultDockProps) {
	if (state.phase === "none") return null;

	const speaker = consultSpeaker(state);
	const owner = consultOwner(state);

	if (state.minimized) {
		let pill: ReactNode;
		if (state.phase === "streaming") {
			pill = (
				<>
					<span className="spin" /> <span className="who">{speaker}</span> consulting…
				</>
			);
		} else if (state.phase === "done") {
			// The pulsing lila dot IS the ready signal — no "answer ready" text.
			pill = (
				<>
					<span className="ready-dot" /> <span className="who">{speaker}</span> <span className="open-hint">Open</span>
				</>
			);
		} else if (state.phase === "stopped") {
			pill = (
				<>
					<span className="who">{speaker}</span> consult stopped
				</>
			);
		} else {
			pill = (
				<>
					<span className="who">{speaker}</span> consult failed <span className="open-hint">Open</span>
				</>
			);
		}
		return (
			<div className="consult-dock consult-fold">
				<button className="fold-pill" type="button" onClick={onOpen} title="Open the consult">
					{pill}
				</button>
			</div>
		);
	}

	const headerTools = (
		<button className="mini-btn" type="button" onClick={onMinimize} title="Minimize. The consult keeps running." aria-label="Minimize consult">
			–
		</button>
	);

	// Stacked consult (§8.1): the completed-and-superseded earlier exchanges shown
	// as history above the current one; whether follow-up / transfer are offered.
	const showFollowUp = canFollowUp(state);
	const showTransfer = canTransferConsult(state);
	const hasDrift = consultHasDrift(state);

	let subline: ReactNode;
	let footerMeta: ReactNode;
	let footerActions: ReactNode;
	const notices: ReactNode[] = [];

	if (state.phase === "streaming") {
		const asOf = formatAsOfDate(state.asOfCheckpointAt);
		subline = `answering from ${owner}'s memory${asOf ? ` as of ${asOf}` : ""}. ${owner}'s memory is not modified`;
		footerMeta = (
			<span className="consult-status">
				<span className="spin" /> consulting…
			</span>
		);
		footerActions = (
			<button className="btn" type="button" onClick={onStop}>
				Stop
			</button>
		);
	} else if (state.phase === "done") {
		// §4.5's as-of date lives in the subline ONLY (Borja, 2026-07-11): the
		// header already carries the full provenance sentence, so the footer
		// repeats nothing. The raw L1b fingerprint is machine provenance — it
		// stays in state for the MR-5 handoff block but is not rendered. §8.5: the
		// subline always shows the LATEST as-of (the current exchange's).
		const asOf = formatAsOfDate(state.asOfCheckpointAt);
		subline = `answered from ${owner}'s memory${asOf ? ` as of ${asOf}` : ""}. ${owner}'s memory is not modified`;
		footerMeta = undefined;
		footerActions = (
			<>
				<button className="btn" type="button" onClick={onDismiss}>
					Dismiss
				</button>
				<button className="btn btn-primary" type="button" onClick={onTransfer}>
					Transfer to thread
				</button>
			</>
		);
		if (state.warnings.length > 0) {
			// Deliberate deviation from spec §4.3 ("warning surfaces on the card
			// subline"): a room-specific warning (e.g. the needs_absorb memory-lag
			// note) reads more clearly as a standalone ⚠ notice than appended to the
			// provenance subline, which is already a full sentence. Same information,
			// clearer placement (Borja review, 2026-07-11).
			notices.push(
				<div className="consult-warning" role="status" key="warnings">
					{state.warnings.map((w, i) => (
						<div key={i}>⚠ {w}</div>
					))}
				</div>,
			);
		}
	} else {
		// stopped / failed — subline names it plainly; body keeps partial text
		// greyed. §8.1: a failed/stopped FOLLOW-UP preserves the stack, so Transfer
		// is still offered (footer below) and the follow-up input re-enables; only
		// exchange 1 failing (empty stack) keeps the dismiss-only footer.
		subline = state.errorMessage ?? (state.phase === "stopped" ? "Consult stopped." : "Consult failed.");
		footerActions = showTransfer ? (
			<>
				<button className="btn" type="button" onClick={onDismiss}>
					Dismiss
				</button>
				<button className="btn btn-primary" type="button" onClick={onTransfer}>
					Transfer to thread
				</button>
			</>
		) : (
			<button className="btn" type="button" onClick={onDismiss}>
				Dismiss
			</button>
		);
	}

	// §8.5: when fingerprints differ across the stack, one inline drift notice
	// (verbatim wording). Shown once, above the follow-up input / footer.
	if (hasDrift) {
		notices.unshift(
			<div className="consult-warning consult-drift" role="status" key="drift">
				{speaker}'s memory changed between your questions. Later answers read the updated memory.
			</div>,
		);
	}
	const notice = notices.length ? <>{notices}</> : undefined;

	// §8.2/§8.6: the follow-up input (above Dismiss/Transfer). When the budget
	// ceiling is hit (§8.6) the input is replaced by the "no longer fits" state.
	// A FRESH consult can also overflow (B's memory alone exceeds the budget) —
	// there is no conversation and nothing to transfer, so the copy must not
	// promise either (hardening 2026-07-11, fresh-eyes review).
	let followUpSlot: ReactNode;
	if (state.overflow) {
		followUpSlot = (
			<div className="consult-overflow" role="status">
				{state.exchanges.length > 0
					? <>this conversation no longer fits in {speaker}'s context: transfer what you have and start fresh</>
					: <>this consult doesn't fit in {speaker}'s context: {speaker}'s memory is too large to consult right now</>}
			</div>
		);
	} else if (showFollowUp) {
		followUpSlot = <ConsultFollowUp speaker={speaker} onFollowUp={onFollowUp} />;
	}

	return (
		<div className="consult-dock">
			<DelegationCard
				speaker={speaker}
				subline={subline}
				headerTools={headerTools}
				historySlot={<ConsultHistory exchanges={state.exchanges} />}
				question={state.question ? { label: "Question", text: state.question } : undefined}
				body={<ConsultAnswer state={state} />}
				notice={notice}
				followUpSlot={followUpSlot}
				footerMeta={footerMeta}
				footerActions={footerActions}
			/>
		</div>
	);
}

/* ===========================================================================
 * Task card (visuals track V4) — the SECOND DelegationCard variant.
 *
 * Additive: every export below is new; the consult exports above are untouched.
 * TaskDock reuses the DelegationCard base and finally fills the two RESERVED
 * slots — `statusStreamSlot` (the running mono stream-tail box) and
 * `artifactStripSlot` (thumbnails / inline-SVG tiles / typed chips). All state
 * lives in the host (App) via the task-stream reducer; this is presentational.
 *
 * Face contract (Borja, HARD RULE): title, state, thumbnails/chips, summary
 * only — NEVER task ids, store paths, timestamps, model, or usage. The reducer
 * keeps those for V5's provenance header; nothing here renders them.
 * =========================================================================== */

export interface TaskDockProps {
	state: TaskState;
	onMinimize: () => void;
	onOpen: () => void;
	/** Stop a running task — the host sends the `task_abort` frame. */
	onStop: () => void;
	onDismiss: () => void;
	/** V6 wires this to the pending-queue transfer; the integrator passes a no-op toast for now. */
	onTransfer: () => void;
	/** Open an artifact beside the chat (V5 right-panel viewer). Given the store-relative path. */
	onOpenArtifact?: (relativePath: string) => void;
	/**
	 * Primary iterate path (chip-chat, contract §5 amendment): the typed text is
	 * the brief of a fresh delegation with this task's artifacts as
	 * inputArtifacts — the room model never mediates. Returns whether the
	 * request was sent (socket up), mirroring the consult follow-up contract.
	 */
	onIterateSubmit?: (brief: string) => boolean;
	/** True while an iterate request awaits the approval card / launch. */
	iteratePending?: boolean;
	/** A refusal/decline/failure reason from task_iterate_result (ok:false). */
	iterateNotice?: string | null;
}

/** The speaker chip: "<template label> specialist" (the lila-accented worker name). */
function taskSpeaker(state: TaskState): string {
	return `${state.templateLabel ?? "visual"} specialist`;
}

/**
 * The running status box (fills `statusStreamSlot`): the mono tail of the delta
 * stream, one line per newline, tool markers ("[artifact_write_html_deck]") in
 * the plan accent. The box clips to its tail (CSS justifies to the end), so it
 * always shows the most recent lines — the reducer already caps the buffer.
 */
function TaskStatusStream({ tail }: { tail: string }) {
	// A liveness signal, not content: collapsed, only the latest line shows as
	// a dim borderless ticker; clicking reveals the recent tail (the reducer's
	// capped buffer). aria-live stays off in ticker mode so a per-line ticker
	// does not spam screen readers.
	const [expanded, setExpanded] = useState(false);
	const lines = tail.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	const latest = lines.length === 0 ? "starting…" : lines[lines.length - 1];
	if (!expanded) {
		return (
			<button
				type="button"
				className="task-status-ticker"
				aria-label="task activity, click to expand"
				title="Show recent activity"
				onClick={() => setExpanded(true)}
			>
				{latest}
			</button>
		);
	}
	return (
		<div className="task-status-stream" aria-label="task activity" role="button" tabIndex={0} title="Collapse" onClick={() => setExpanded(false)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setExpanded(false); }}>
			{lines.length === 0 ? (
				<div className="task-line">starting…</div>
			) : (
				lines.map((line, index) => {
					const isTool = /^\[.+\]$/.test(line);
					return (
						<div className={`task-line${isTool ? " is-tool" : ""}`} key={index}>
							{line}
						</div>
					);
				})
			)}
		</div>
	);
}

/**
 * One artifact tile. Precedence (matching the mockup + the server contract):
 *   1. a write-time thumbnail (data: URI) → <img> tile, with the slide-count
 *      badge for decks;
 *   2. else an SVG whose route URL is derivable → inline <img> tile (SVGs are
 *      the one artifact safe to render on the card);
 *   3. else a typed chip (DECK/HTML/SVG kind label + basename).
 * The card NEVER live-renders artifact HTML bytes — HTML with no thumbnail is
 * always a chip. Click routes to the V5 viewer via onOpenArtifact.
 */
function TaskArtifactTile({ state, artifact, onOpenArtifact }: { state: TaskState; artifact: TaskArtifact; onOpenArtifact?: (relativePath: string) => void }) {
	const name = artifactBasename(artifact.relativePath);
	const open = () => onOpenArtifact?.(artifact.relativePath);
	const thumb = thumbnailFor(state, artifact.relativePath);

	if (thumb) {
		return (
			<button className={`task-thumb${thumb.slideCount != null ? " task-thumb-badge" : ""}`} type="button" onClick={open} title={`Open ${name}`}>
				<img src={thumb.dataUri} alt="" />
				{thumb.slideCount != null && <span className="task-count">{thumb.slideCount} slides</span>}
				<span className="task-name">{name}</span>
			</button>
		);
	}

	if (isSvgArtifact(artifact.extension)) {
		const url = taskArtifactUrl(state.taskId ?? "", artifact.relativePath);
		// A malformed / cross-task path yields null → fall through to the chip
		// rather than emitting a broken <img>.
		if (url) {
			return (
				<button className="task-thumb" type="button" onClick={open} title={`Open ${name}`}>
					<img src={url} alt="" />
					<span className="task-name">{name}</span>
				</button>
			);
		}
	}

	return (
		<button className="task-file-chip" type="button" onClick={open} title={`Open ${name}`}>
			<span className="task-kind">{artifactKindLabel(artifact.extension, state.template)}</span>
			<span className="task-file-name">{name}</span>
		</button>
	);
}

/**
 * The done-card iterate input (chip-chat): "the CARD is the conversation with
 * the specialist lineage." Submitting starts a FRESH delegation whose brief is
 * the typed text and whose inputArtifacts are this task's artifacts — approval
 * card and all; never a session resume (D5). Sibling of ConsultFollowUp.
 */
function TaskIterateFollowUp({ onIterateSubmit, pending }: { onIterateSubmit: (brief: string) => boolean; pending: boolean }) {
	const [draft, setDraft] = useState("");
	const submit = () => {
		const brief = draft.trim();
		if (!brief || pending) return;
		// Never clear the draft here: a decline or launch failure resolves AFTER
		// the frame goes out, and must not eat the user's typed brief. On success
		// the fresh task's card supersedes this one and the input unmounts anyway.
		onIterateSubmit(brief);
	};
	return (
		<div className="consult-followup">
			<input
				className="consult-followup-input"
				type="text"
				value={draft}
				disabled={pending}
				placeholder={pending ? "Starting…" : "Describe a change…"}
				aria-label="Iterate on this task"
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						submit();
					}
				}}
			/>
			<button className="btn" type="button" onClick={submit} disabled={pending || !draft.trim()} title="Starts a fresh isolated specialist in a new private folder. It can read this task's files, nothing else.">
				Iterate
			</button>
		</div>
	);
}

/** The artifact strip (fills `artifactStripSlot`): the tiles/chips row. */
function TaskArtifactStrip({ state, onOpenArtifact }: { state: TaskState; onOpenArtifact?: (relativePath: string) => void }) {
	if (state.artifacts.length === 0) return null;
	return (
		<div className="task-artifact-strip">
			{state.artifacts.map((artifact) => (
				<TaskArtifactTile key={artifact.relativePath} state={state} artifact={artifact} onOpenArtifact={onOpenArtifact} />
			))}
		</div>
	);
}

/**
 * The docked task surface (variant B): the expanded card, or — when minimized —
 * the folded pill. Renders nothing when there is no task. Mirrors ConsultDock's
 * state machine (running / done / error × expanded / folded).
 */
export function TaskDock({ state, onMinimize, onOpen, onStop, onDismiss, onTransfer, onOpenArtifact, onIterateSubmit, iteratePending, iterateNotice }: TaskDockProps) {
	// Closing a done card always means losing the handle to the result (Transfer
	// dismisses the card itself), so Close arms an inline not-kept confirm.
	const [confirmingClose, setConfirmingClose] = useState(false);
	const [notesOpen, setNotesOpen] = useState(false);
	useEffect(() => {
		setConfirmingClose(false);
		setNotesOpen(false);
	}, [state.taskId, state.phase]);
	if (state.phase === "none") return null;

	const speaker = taskSpeaker(state);
	const isHalted = state.phase === "error"; // terminal: stopped or failed
	const isError = isHalted && !state.stopRequested; // red accent only for real failures

	if (state.minimized) {
		let pill: ReactNode;
		if (state.phase === "running") {
			pill = (
				<>
					<span className="spin" /> <span className="who">{speaker}</span> working… <span className="open-hint">Open</span>
				</>
			);
		} else if (state.phase === "done") {
			// The pulsing lila dot IS the ready signal (mockup state 5).
			pill = (
				<>
					<span className="ready-dot" /> <span className="who">{speaker}</span> ready <span className="open-hint">Open</span>
				</>
			);
		} else {
			pill = (
				<>
					<span className="who">{speaker}</span> {state.stopRequested ? "stopped" : "error"} <span className="open-hint">Open</span>
				</>
			);
		}
		return (
			<div className={`task-dock task-fold${isError ? " task-dock-error" : ""}`}>
				<button className="task-pill" type="button" onClick={onOpen} title="Open the task">
					{pill}
				</button>
			</div>
		);
	}

	const headerTools = isHalted ? (
		<button className="mini-btn" type="button" onClick={onDismiss} title="Dismiss" aria-label="Dismiss task">
			✕
		</button>
	) : (
		<button className="mini-btn" type="button" onClick={onMinimize} title="Minimize. The task keeps running." aria-label="Minimize task">
			–
		</button>
	);

	let subline: ReactNode;
	let body: ReactNode;
	let statusStreamSlot: ReactNode;
	let artifactStripSlot: ReactNode;
	let notice: ReactNode;
	let followUpSlot: ReactNode;
	let footerMeta: ReactNode;
	let footerActions: ReactNode;

	if (state.phase === "running") {
		subline = "working. You can keep chatting";
		statusStreamSlot = <TaskStatusStream tail={state.tail} />;
		footerMeta = (
			<span className="task-status">
				<span className="spin" /> running
			</span>
		);
		footerActions = (
			<button className="btn" type="button" onClick={onStop}>
				Stop
			</button>
		);
	} else if (state.phase === "done") {
		subline = "done";
		artifactStripSlot = (
			<>
				<TaskArtifactStrip state={state} onOpenArtifact={onOpenArtifact} />
				{state.summary && (
					<div className="task-notes">
						<button type="button" className="task-notes-toggle" aria-expanded={notesOpen} onClick={() => setNotesOpen((open) => !open)}>
							<span className="task-notes-tri">{notesOpen ? "▾" : "▸"}</span> Specialist notes
						</button>
						{notesOpen && (
							<div className="task-summary md">
								<MarkdownRenderer>{state.summary}</MarkdownRenderer>
							</div>
						)}
					</div>
				)}
			</>
		);
		if (iterateNotice) {
			notice = (
				<div className="consult-warning" role="status">
					{iterateNotice}
				</div>
			);
		}
		if (onIterateSubmit && state.artifacts.length > 0) {
			followUpSlot = <TaskIterateFollowUp onIterateSubmit={onIterateSubmit} pending={iteratePending === true} />;
		}
		footerActions = confirmingClose ? (
			<>
				<span className="task-close-confirm">This result was not kept.</span>
				<button className="btn task-close-danger" type="button" onClick={onDismiss}>
					Close anyway
				</button>
				<button className="btn btn-primary" type="button" onClick={onTransfer}>
					Add to conversation
				</button>
			</>
		) : (
			<>
				<button className="btn" type="button" onClick={() => setConfirmingClose(true)}>
					Close
				</button>
				<button className="btn btn-primary" type="button" onClick={onTransfer}>
					Add to conversation
				</button>
			</>
		);
	} else {
		// error / stopped — plain message; partial artifacts (already written) kept.
		subline = state.stopRequested ? "stopped" : "error";
		body = <div className="task-error-msg">{state.errorMessage ?? (state.stopRequested ? "Stopped at your request." : "The task did not finish.")}</div>;
		artifactStripSlot = <TaskArtifactStrip state={state} onOpenArtifact={onOpenArtifact} />;
		footerMeta = state.artifacts.length > 0 ? <span className="task-meta">partial output remains available</span> : undefined;
		footerActions = (
			<button className="btn" type="button" onClick={onDismiss}>
				Dismiss
			</button>
		);
	}

	return (
		<div className={`task-dock${isError ? " task-dock-error" : ""}`}>
			<DelegationCard
				speaker={speaker}
				subline={subline}
				headerTools={headerTools}
				// While running, the user just approved this task seconds ago — the
				// title line is noise next to the live stream. It returns on the
				// done/halted card, where it identifies what finished.
				question={state.phase !== "running" && state.title ? { text: state.title } : undefined}
				statusStreamSlot={statusStreamSlot}
				body={body}
				artifactStripSlot={artifactStripSlot}
				notice={notice}
				followUpSlot={followUpSlot}
				footerMeta={footerMeta}
				footerActions={footerActions}
			/>
		</div>
	);
}
