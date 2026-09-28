import { useState, type HTMLAttributes } from "react";
import { NOTHING_TO_MAINTAIN_SENTENCE, nothingToMaintain } from "../memory-surface-copy";
import { canonicalModelName } from "../model-names";
import type { PersistentAgentId, PersistentAgentStatus, WebChatModelOption } from "../types";

export type LauncherRoomThread = {
	state: "live" | "standby";
	agentId: PersistentAgentId;
	displayName: string;
	conversationId: string;
	model: WebChatModelOption;
	items: unknown[];
};

export type LauncherRoomMaintainTarget = { agentId: PersistentAgentId; displayName: string };

function compactDateTime(value: string | null | undefined): string {
	if (!value) return "none yet";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const day = date.toLocaleDateString([], { month: "short", day: "numeric" });
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	return `${day}, ${time}`;
}

function checkpointAgo(value: string | null | undefined): { label: string; title: string } | null {
	if (!value) return null;
	const t = new Date(value).getTime();
	if (Number.isNaN(t)) return null;
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	const label = s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
	return { label, title: compactDateTime(value) };
}

export type PersistentAgentCardProps = {
	status: PersistentAgentStatus | null;
	thread: LauncherRoomThread | null;
	live: boolean;
	/** The room refused to open because its memory does not fit the thread's model: the standby thread is not resumable, so it must not block Maintain. */
	unresumable?: boolean;
	duplicateDisplayName?: boolean;
	/** Enters a new conversation; the server decides its model (the room's conversation row). */
	onEnter: (status: PersistentAgentStatus) => Promise<void> | void;
	onResume: (status: PersistentAgentStatus) => Promise<void> | void;
	onMaintain: (target: LauncherRoomMaintainTarget) => void;
	onOpenSettings?: () => void;
	/** Opens Room settings on the Model pane (the card's model label). */
	onOpenModelSettings?: () => void;
	/** Each provider's name as AI setup shows it, by provider id. */
	providerLabels?: Readonly<Record<string, string>>;
	/** A response finished in this room after the user left it (community #14). */
	backgroundReady?: boolean;
	/** A purge for this room is in flight (community #10): every door into the room closes until it resolves. */
	purging?: boolean;
	/**
	 * The home screen is in arrange mode: the card keeps its Home look (the
	 * same height and content, the model label included) and nothing inside
	 * it can be pressed or reached: the gear and the actions row are inert,
	 * hidden from assistive technology and dimmed, so a click while arranging
	 * can never enter a room. The card is moved as a whole by the grid.
	 */
	arranging?: boolean;
};

export function PersistentAgentCard({ status, thread, live, unresumable = false, duplicateDisplayName = false, onEnter, onResume, onMaintain, onOpenSettings, onOpenModelSettings, providerLabels, backgroundReady = false, purging = false, arranging = false }: PersistentAgentCardProps) {
	const [entering, setEntering] = useState(false);
	// React 18 knows no `inert` prop: the attribute is passed as a string.
	const inertWhileArranging = arranging ? ({ inert: "", "aria-hidden": true } as HTMLAttributes<HTMLElement>) : {};
	const [expanded, setExpanded] = useState(false);
	const preparedBoundary = status?.activeThread?.preparedByBoundary ?? (status?.activeThread?.preparedByCheckpoint ? "checkpoint" : null);
	const preparedBoundaryThread = !live && !!preparedBoundary && !!status?.runtime.activeThreadId;
	const hasStandbyThread = thread?.state === "standby" || (!live && !preparedBoundaryThread && (status?.runtime.state === "standby" || status?.runtime.state === "active") && !!status.runtime.activeThreadId);
	const hasActiveThread = live || hasStandbyThread || preparedBoundaryThread;
	// Maintain waits only for a conversation someone has spoken in; the empty
	// one Remember or Forget prepares boots on the memory as it is when next
	// entered, so it holds nothing Maintain could leave behind.
	const openConversationHasTurns = thread?.state === "standby"
		? thread.items.some((item: any) => (item?.kind === "user" || item?.kind === "assistant") && typeof item.text === "string" && item.text.trim().length > 0)
		: (status?.activeThread?.hasUserVisibleTurns ?? true);
	const maintainWaitsForConversation = live || (hasActiveThread && openConversationHasTurns);
	const state = hasStandbyThread ? "standby" : live ? "live" : status?.status ?? "missing";
	const stateLabel = state === "needs_absorb" ? "ready to memorize" : state;
	// A room due for Memorize stays open until it holds as many remembered
	// sessions as the server accepts; only then is entering blocked.
	const rememberedSessions = status?.recentContext?.fullEntries ?? 0;
	const sessionBlockCap = status?.recentContext?.blockCap ?? 20;
	const entryBlocked = state === "needs_absorb" && rememberedSessions >= sessionBlockCap;
	const label = status?.displayName || thread?.displayName || status?.id || "Room";
	const memory = status?.memoryStatus;
	const memoryLevel = memory?.recentContextLevel ?? "unknown";
	const memoryHardCap = memory?.recentContextHardCap;
	const memoryMeterReady = !!memory && typeof memoryHardCap === "number" && Number.isFinite(memoryHardCap) && memoryHardCap > 0;
	const memoryFill = memoryMeterReady ? Math.min(Math.max((memory!.recentContextCount ?? 0) / sessionBlockCap, 0), 1) : 0;
	const maintenanceSeverity: "none" | "soft" | "hard" =
		memoryLevel === "hard_cap"
			? (entryBlocked ? "hard" : "soft")
			: memoryLevel === "approaching_soft_cap" || memoryLevel === "at_soft_cap"
				? "soft"
				: state === "needs_absorb"
					? "soft"
					: "none";
	const maintenanceState = state === "ready" || state === "needs_absorb";
	const showMaintenanceBadge = maintenanceState && maintenanceSeverity !== "none";
	const badgeLabel = showMaintenanceBadge ? (entryBlocked ? "memorize now" : memoryLevel === "hard_cap" ? "memorize due" : "memorize soon") : stateLabel;
	const badgeClass = showMaintenanceBadge ? `mem-${maintenanceSeverity}` : state;
	const showBadge = showMaintenanceBadge || state !== "ready";
	const memoryCheckpoint = checkpointAgo(memory?.lastCheckpointAt);
	// The card's model, read-only: a standby conversation continues on its own
	// lock; anything else (an empty room, the empty conversation Remember or
	// Forget prepares, which boots on the room's pick, a standby conversation
	// nobody has written in yet, whose first message follows the pick) runs on
	// the room's conversation row as the server resolved it.
	const conversationModel = status?.models?.conversation.effective ?? null;
	// A room whose model cannot run waits for it: the card still names that
	// model, and Enter's title carries the refusal.
	const waitingModel = !conversationModel && status?.models?.conversation.reason ? status.models.conversation.chosen : null;
	const waitingSentence = waitingModel ? status?.models?.conversation.refusal ?? null : null;
	const standbyFollowsPick = hasStandbyThread && !openConversationHasTurns && status?.activeThread?.threadId === status?.runtime.activeThreadId && status?.activeThread?.followsConversationPick === true;
	const standbyLockedModel = hasStandbyThread && !standbyFollowsPick ? thread?.model ?? status?.runtime.model ?? null : null;
	const cardModel = standbyLockedModel ?? (live ? thread?.model ?? null : null) ?? conversationModel ?? waitingModel;
	const cardModelCanonical = cardModel ? canonicalModelName({ model: cardModel.model, modelLabel: cardModel.label, provider: cardModel.provider }) : null;
	// The provider in AI setup's words, whichever model the card shows.
	const cardModelProvider = cardModel
		? providerLabels?.[cardModel.provider] ?? (conversationModel?.provider === cardModel.provider ? conversationModel.providerLabel : undefined) ?? cardModelCanonical?.provider
		: undefined;
	const cardModelNames = cardModelCanonical ? { name: cardModelCanonical.name, provider: cardModelProvider } : null;
	const cardModelTitle = `${cardModelNames ? `${cardModelNames.name}${cardModelNames.provider ? ` · ${cardModelNames.provider}` : ""}. ` : ""}${hasStandbyThread && !standbyFollowsPick
		? "This conversation continues on its current model. Room settings, Model can switch it."
		: "The model this room talks with. Change it in Room settings, Model."}`;
	const lockedElsewhere = !!status?.activeLock;
	const lockSurface = status?.activeLock?.surface;
	const lockedByScheduler = lockSurface === "scheduler";
	const lockWhere = lockedByScheduler ? "scheduled background work" : lockSurface === "cli" ? "the CLI" : "another window";
	const lockShort = lockedByScheduler ? "working" : lockSurface === "cli" ? "in CLI" : "in app";
	// A web lock plus a running turn means the response is still being written
	// (left mid-generation, or live in another window) — either way it lands in
	// the conversation, so the badge and note say that instead of "open in
	// another browser session".
	const answeringInBackground = lockedElsewhere && lockSurface === "web" && !!status?.activeThread?.working;
	// Issue #33: a response cooking with NO client attached is a room the user
	// may step back into; the server adopts the session onto the live stream.
	// A room genuinely open in another window keeps its lock-and-stay-out.
	const canStepBackIn = answeringInBackground && status?.answeringDetached === true;
	const lockNote = canStepBackIn
		? "This room is still writing a response. You can step back in and watch it finish; it is saved into the conversation either way."
		: answeringInBackground
		? "This room is still writing a response. It is saved into the conversation when finished; open the room again then. A room can only be active in one place at a time."
		: lockedByScheduler
			? "This room is working on a scheduled background task. Wait for it to finish before opening it. A room can only be active in one place at a time."
			: `This room is open in ${lockWhere}. Close it there to use it here. A room can only be active in one place at a time.`;
	// Mid-purge the room may sit on Home for a few seconds while the delete
	// endpoint retries; entering it then would either doom the delete or get
	// the room removed underneath the new session.
	const purgeNote = "This room is being deleted.";
	const canEnter = !!status && (state === "ready" || (state === "needs_absorb" && !entryBlocked)) && !preparedBoundaryThread && !!conversationModel && !lockedElsewhere && !purging;
	const maintainReadyState = !!status && (status.status === "ready" || status.status === "needs_absorb");
	const nothingToMaintainYet = nothingToMaintain(status?.memoryStatus);
	const canMaintain = !!status && status.exists && (!maintainWaitsForConversation || unresumable) && !lockedElsewhere && !purging && maintainReadyState && !nothingToMaintainYet;
	// Disabled tooltips name the actual blocker and the way out; "resting" is
	// not a state shown anywhere else on the card.
	const enterDisabledReason = purging
		? purgeNote
		: entryBlocked
		? `This room is holding ${rememberedSessions} remembered conversations, as many as it can hold. Memorize them first: use Maintain, then enter.`
		: state === "ready" || state === "needs_absorb"
			? conversationModel
				? "Enter persistent chat"
				: waitingSentence ?? "Sign in to an AI provider in Settings, AI setup."
			: "This room is not ready to enter yet.";
	const maintainDisabledReason = purging
		? purgeNote
		: lockedElsewhere
			? lockNote
		: maintainWaitsForConversation
			? "Remember or Forget the open conversation first, then Maintain becomes available."
			: !status || !status.exists
				? "Maintain becomes available once the room is set up."
				: !maintainReadyState
					? "This room needs attention before it can be maintained."
					: NOTHING_TO_MAINTAIN_SENTENCE;
	async function enter() {
		if (!status || entering) return;
		setEntering(true);
		try {
			await onEnter(status);
		} finally {
			setEntering(false);
		}
	}
	return (
		<article className={`landing-card persistent-agent-card ${state}${maintenanceSeverity !== "none" ? ` mem-${maintenanceSeverity}` : ""}${arranging ? " arranging" : ""}`}>
			<div className="persistent-agent-card-main">
				<div className="persistent-agent-header">
					<div className="persistent-agent-title-block">
						<div className="persistent-agent-title-row">
							<h2 title={duplicateDisplayName && status ? `Room id ${status.id}` : undefined}>{label}</h2>
						</div>
					</div>
					<div className="persistent-agent-header-end">
						{answeringInBackground
							? <span className="persistent-agent-badge bg-working" title={lockNote}>answering</span>
							: lockedElsewhere
								? <span className="persistent-agent-badge locked" title={lockNote}>🔒 {lockShort}</span>
								: backgroundReady
									? <span className="persistent-agent-badge ready" title="A response finished after you left this room. Resume to read it.">response ready</span>
									: showBadge && <span className={`persistent-agent-badge ${badgeClass}`} title={badgeLabel === "memorize soon" ? `${rememberedSessions} conversations are waiting to be memorized. Use Maintain → Memorize when convenient; the room keeps working meanwhile.` : badgeLabel === "memorize due" ? `${rememberedSessions} conversations are waiting to be memorized. Use Maintain → Memorize; chatting and Remember keep working until the room holds ${sessionBlockCap}.` : badgeLabel === "memorize now" ? `This room holds ${rememberedSessions} remembered conversations, as many as it can. Memorize them (Maintain → Memorize) to enter it again.` : undefined}>{badgeLabel}</span>}
						{status?.exists && onOpenSettings && <button {...inertWhileArranging} className="card-gear-btn" aria-label="Room settings" title={purging ? purgeNote : "Room settings"} disabled={purging} onClick={onOpenSettings}>⚙</button>}
					</div>
				</div>
				{status && status.errors.length > 0 && <div className="persistent-agent-error-summary">This room needs attention before it can be used.</div>}
				<div className={`persistent-agent-meta ${memoryLevel}`}>
				{memory ? (
					memoryMeterReady ? (
						<div className="memory-meter" title={`Conversations you remembered but have not memorized yet: ${memory.recentContextCount} of the ${sessionBlockCap} this room can hold. Memorize turns them into lasting notes.`}>
							<div className="memory-meter-head">
								<span className="memory-meter-checkpoint" title={memoryCheckpoint?.title}>{memoryCheckpoint ? `memory saved ${memoryCheckpoint.label}` : "no memories saved yet"}</span>
								<span className="memory-meter-label">{memory.recentContextCount === 0 ? "nothing waiting" : `${memory.recentContextCount} ${memory.recentContextCount === 1 ? "conversation" : "conversations"} waiting`}</span>
							</div>
							<div
								className="memory-meter-track"
								role="progressbar"
								aria-valuemin={0}
								aria-valuemax={sessionBlockCap}
								aria-valuenow={memory.recentContextCount}
								aria-label={`Conversations waiting to be memorized: ${memory.recentContextCount} of ${sessionBlockCap}`}
							>
								<div className="memory-meter-fill" style={{ width: `${memoryFill * 100}%` }} />
							</div>
						</div>
					) : (
						<div className="memory-meter-checkpoint" title={memoryCheckpoint?.title}>
							{memory.recentContextCount} {memory.recentContextCount === 1 ? "conversation" : "conversations"} waiting · {memoryCheckpoint ? `memory saved ${memoryCheckpoint.label}` : "no memories saved yet"}
						</div>
					)
				) : (
					<div>{status ? "Memory status unavailable" : "Checking local scaffold…"}</div>
				)}
				</div>
			</div>
			<div className="persistent-agent-actions" {...inertWhileArranging}>
				<div className="persistent-agent-primary-actions">
					{state === "missing" ? (
						<button className="landing-action" disabled title="This room's files are missing on this machine">Unavailable</button>
					) : hasStandbyThread ? (
						<button className="landing-action" title={purging ? purgeNote : lockedElsewhere ? lockNote : "Resume this standby thread"} disabled={!status || (lockedElsewhere && !canStepBackIn) || purging} onClick={() => status && onResume(status)}>Resume →</button>
					) : preparedBoundaryThread ? (
						<button
							className="landing-action"
							title={purging ? purgeNote : lockedElsewhere ? lockNote : "Enter the prepared room runtime"}
							disabled={!status || lockedElsewhere || purging}
							onClick={() => status && void onResume(status)}
						>Enter →</button>
					) : (
						<button className="landing-action" disabled={!canEnter || entering} title={lockedElsewhere ? lockNote : enterDisabledReason} onClick={enter}>{entering ? "Entering…" : "Enter →"}</button>
					)}
				</div>
				<div className="persistent-agent-secondary-actions">
					<button className="inline-action" disabled={!canMaintain} title={canMaintain ? `Memorize the remembered conversations, or tidy what ${label} knows.` : maintainDisabledReason} onClick={() => status && onMaintain({ agentId: status.id, displayName: label })}>Maintain</button>
					{status && (status.errors.length > 0 || status.warnings.length > 0) && <button className="inline-action" title={expanded ? "Hide the details" : "Show what needs attention"} onClick={() => setExpanded((v) => !v)}>{expanded ? "Hide" : "Details"}</button>}
				</div>
				{state !== "missing" && cardModelNames && (
					<div className="persistent-agent-model">
						<button type="button" className="card-model-label" title={purging ? purgeNote : cardModelTitle} disabled={purging || !onOpenModelSettings} onClick={onOpenModelSettings}>
							<span className="card-model-label-name">{cardModelNames.name}</span>
							{cardModelNames.provider && <span className="card-model-label-provider">{cardModelNames.provider}</span>}
						</button>
					</div>
				)}
			</div>
			{expanded && status && (
				<div className="persistent-agent-details">
					{status.errors.length > 0 && <div className="error">This room needs attention before it can be used.</div>}
					{status.warnings.length > 0 && <div>Some room diagnostics are available in server logs.</div>}
				</div>
			)}
		</article>
	);
}
