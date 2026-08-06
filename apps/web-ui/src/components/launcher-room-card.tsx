import { useEffect, useRef, useState } from "react";
import { modelDisplayName } from "../model-names";
import type { PersistentAgentAiProfileSelectionStatus, PersistentAgentId, PersistentAgentStatus, WebChatModelOption, WebChatModelStatus } from "../types";
import { strandedBySwitchCount } from "./product-shell";
import { ProfileSwitchConfirm, RoomModelPicker } from "./room-model-picker";
import { useEscapeKey } from "./use-escape-key";

export type LauncherRoomThread = {
	state: "live" | "standby";
	agentId: PersistentAgentId;
	displayName: string;
	conversationId: string;
	model: WebChatModelOption;
	items: unknown[];
};

export type LauncherRoomMaintainTarget = { agentId: PersistentAgentId; displayName: string };

// Canonical display name for a model lock/option however its label was
// persisted ("moonshotai.kimi-k2.5" and "GitHub Copilot — Claude Opus 4.8"
// both come out clean).
function cardModelName(model: { provider?: string; model?: string; label?: string } | null | undefined): string {
	if (!model) return "";
	return modelDisplayName({ model: model.model, modelLabel: model.label, provider: model.provider });
}

function persistentRoomModels(status: WebChatModelStatus | null): WebChatModelOption[] {
	return status?.roomModels?.length ? status.roomModels : status?.models ?? [];
}

function persistentRoomRecommended(status: WebChatModelStatus | null): WebChatModelOption | undefined {
	return status?.roomRecommended ?? persistentRoomModels(status)[0];
}

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
	modelStatus: WebChatModelStatus | null;
	aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null;
	thread: LauncherRoomThread | null;
	live: boolean;
	duplicateDisplayName?: boolean;
	onEnter: (status: PersistentAgentStatus, model: WebChatModelOption) => Promise<void> | void;
	onResume: (status: PersistentAgentStatus) => Promise<void> | void;
	onMaintain: (target: LauncherRoomMaintainTarget) => void;
	onOpenSettings?: () => void;
	/** A response finished in this room after the user left it (community #14). */
	backgroundReady?: boolean;
	/** A purge for this room is in flight (community #10): every door into the room closes until it resolves. */
	purging?: boolean;
	/** Locked models of standby rooms — feeds the picker's switch-warning counts. */
	standbyLockedModels?: Array<{ provider: string; model: string }>;
	/** Runs a profile switch when the picker confirms a cross-profile model pick. */
	onSelectAiProfile?: (profileId: string) => Promise<void>;
};

export function PersistentAgentCard({ status, modelStatus, aiProfileStatus, thread, live, duplicateDisplayName = false, onEnter, onResume, onMaintain, onOpenSettings, backgroundReady = false, purging = false, standbyLockedModels, onSelectAiProfile }: PersistentAgentCardProps) {
	const [entering, setEntering] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [draftModel, setDraftModel] = useState("");
	const preparedBoundary = status?.activeThread?.preparedByBoundary ?? (status?.activeThread?.preparedByCheckpoint ? "checkpoint" : null);
	const preparedBoundaryThread = !live && !!preparedBoundary && !!status?.runtime.activeThreadId;
	const hasStandbyThread = thread?.state === "standby" || (!live && !preparedBoundaryThread && (status?.runtime.state === "standby" || status?.runtime.state === "active") && !!status.runtime.activeThreadId);
	const hasActiveThread = live || hasStandbyThread || preparedBoundaryThread;
	const state = hasStandbyThread ? "standby" : live ? "live" : status?.status ?? "missing";
	const stateLabel = state === "needs_absorb" ? "ready to learn" : state;
	const label = status?.displayName || thread?.displayName || status?.id || "Room";
	const memory = status?.memoryStatus;
	const memoryLevel = memory?.recentContextLevel ?? "unknown";
	const memoryHardCap = memory?.recentContextHardCap;
	const memoryMeterReady = !!memory && typeof memoryHardCap === "number" && Number.isFinite(memoryHardCap) && memoryHardCap > 0;
	const memoryFill = memoryMeterReady ? Math.min(Math.max((memory!.recentContextCount ?? 0) / memoryHardCap!, 0), 1) : 0;
	const overMemoryBudget = typeof status?.memoryBudgetTokens === "number"
		&& typeof status?.promptBudget?.l1bEstimatedTokens === "number"
		&& status.promptBudget.l1bEstimatedTokens > status.memoryBudgetTokens;
	const maintenanceSeverity: "none" | "soft" | "hard" =
		memoryLevel === "hard_cap"
			? "hard"
			: memoryLevel === "approaching_soft_cap" || memoryLevel === "at_soft_cap"
				? "soft"
				: state === "needs_absorb"
					? "soft"
					: overMemoryBudget
						? "soft"
						: "none";
	const maintenanceState = state === "ready" || state === "needs_absorb";
	const showMaintenanceBadge = maintenanceState && maintenanceSeverity !== "none";
	const badgeLabel = showMaintenanceBadge ? (maintenanceSeverity === "hard" ? "maintenance required" : overMemoryBudget && memoryLevel !== "approaching_soft_cap" && memoryLevel !== "at_soft_cap" && state !== "needs_absorb" ? "memory over budget" : "needs maintenance") : stateLabel;
	const badgeClass = showMaintenanceBadge ? `mem-${maintenanceSeverity}` : state;
	const showBadge = showMaintenanceBadge || state !== "ready";
	const memoryCheckpoint = checkpointAgo(memory?.lastCheckpointAt);
	const roomModels = persistentRoomModels(modelStatus);
	const selectedModel = roomModels.find((m) => `${m.provider}/${m.model}` === draftModel) ?? persistentRoomRecommended(modelStatus);
	const standbyLockedModel = thread?.model ?? (status?.runtime.model ? { provider: status.runtime.model.provider, model: status.runtime.model.model, label: status.runtime.model.label || `${status.runtime.model.provider}/${status.runtime.model.model}` } : null);
	// While the model status still describes a different profile than the
	// profile status (the refetch window after a switch), its list cannot
	// judge anything — validating a pick against it would silently revert a
	// choice made from the new profile's group, and judging a standby lock
	// against it would briefly offer Switch & resume back to the profile just
	// left. In that window the active profile's own curated list judges.
	const modelStatusAgreesWithProfile = !modelStatus?.activeProfileId || !aiProfileStatus || modelStatus.activeProfileId === aiProfileStatus.activeProfileId;
	const activeModelJudgeList: Array<{ provider: string; model: string }> = modelStatusAgreesWithProfile ? roomModels : aiProfileStatus?.activeProfile.processes?.persistentRoom.models ?? [];
	const standbyModelAllowed = !standbyLockedModel || activeModelJudgeList.some((model) => model.provider === standbyLockedModel.provider && model.model === standbyLockedModel.model);
	const preparedModelKey = preparedBoundaryThread && standbyLockedModel && standbyModelAllowed ? `${standbyLockedModel.provider}/${standbyLockedModel.model}` : "";
	useEffect(() => {
		if (preparedModelKey) {
			setDraftModel(preparedModelKey);
			return;
		}
		if (!modelStatusAgreesWithProfile) return;
		// A refresh keeps the user's pick when the new list still carries it —
		// this is what lets a cross-profile pick survive the model-status
		// refetch that follows the profile switch. Keying on draftModel too is
		// the belt for the reverse case: a pick that the refreshed list does
		// NOT carry falls back to the recommendation instead of leaving a
		// selection Enter silently cannot resolve.
		setDraftModel((current) => {
			if (current && persistentRoomModels(modelStatus).some((m) => `${m.provider}/${m.model}` === current)) return current;
			const selected = persistentRoomRecommended(modelStatus);
			return selected ? `${selected.provider}/${selected.model}` : "";
		});
	}, [modelStatus, preparedModelKey, draftModel, modelStatusAgreesWithProfile]);
	// A prepared boundary session is empty, so it only continues on its prepared
	// model when the user keeps that selection; picking another model retires it
	// and enters fresh.
	const preparedSelectionMatchesLock = !!preparedModelKey && draftModel === preparedModelKey;
	const lockedModelLabel = cardModelName(standbyLockedModel) || cardModelName(status?.runtime.model) || "Locked model";
	// Which ready profile provides the locked model — names the way out in the tooltip when resume is dimmed.
	const switchTargetProfile = !standbyModelAllowed && standbyLockedModel
		? aiProfileStatus?.profiles.find((profile) => !profile.active && profile.ready && profile.processes?.persistentRoom.models.some((model) => model.provider === standbyLockedModel.provider && model.model === standbyLockedModel.model)) ?? null
		: null;
	const modelLabel = hasStandbyThread || preparedBoundaryThread
		? lockedModelLabel
		: selectedModel ? cardModelName(selectedModel) : "No model";
	const standbyActionTitle = standbyModelAllowed
		? "Resume this standby thread"
		: switchTargetProfile
			? `This thread is locked to ${lockedModelLabel}. Switch the AI profile to ${switchTargetProfile.label} (⚙ settings) to resume it.`
			: `This thread is locked to ${lockedModelLabel}, which no ready AI profile provides right now. Open AI setup to connect one.`;
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
	const lockNote = answeringInBackground
		? "This room is still writing a response. It is saved into the conversation when finished; open the room again then. A room can only be active in one place at a time."
		: lockedByScheduler
			? "This room is working on a scheduled background task. Wait for it to finish before opening it. A room can only be active in one place at a time."
			: `This room is open in ${lockWhere}. Close it there to use it here. A room can only be active in one place at a time.`;
	// Mid-purge the room may sit on Home for a few seconds while the delete
	// endpoint retries; entering it then would either doom the delete or get
	// the room removed underneath the new session.
	const purgeNote = "This room is being deleted.";
	// A stranded standby room whose locked model another READY profile serves
	// gets its way out on the card itself: Resume keeps its everyday label but
	// opens the same profile-switch confirm the model picker uses (community
	// #9) — the dialog does the explaining, the button stays calm. The thread
	// never changes model — it resumes on the one it is locked to.
	// A room being deleted never offers it: the purge closes every door.
	const [switchResumeOpen, setSwitchResumeOpen] = useState(false);
	const [switchResumeBusy, setSwitchResumeBusy] = useState(false);
	const [switchResumeError, setSwitchResumeError] = useState<string | null>(null);
	// Cancel/Escape hands focus back to the button that opened the confirm —
	// the picker's confirmReturnFocusRef pattern.
	const switchResumeReturnFocusRef = useRef<HTMLElement | null>(null);
	const canSwitchResume = hasStandbyThread && !standbyModelAllowed && !!switchTargetProfile && !!onSelectAiProfile && !!status && !lockedElsewhere && !purging;
	const switchResumeStranded = switchTargetProfile && aiProfileStatus ? strandedBySwitchCount(standbyLockedModels, aiProfileStatus.activeProfile, switchTargetProfile) : 0;
	function closeSwitchResume() {
		setSwitchResumeOpen(false);
		setSwitchResumeError(null);
		requestAnimationFrame(() => switchResumeReturnFocusRef.current?.focus());
	}
	useEscapeKey(closeSwitchResume, switchResumeOpen && !switchResumeBusy);
	async function switchAndResume() {
		if (!status || !switchTargetProfile || !onSelectAiProfile || switchResumeBusy) return;
		setSwitchResumeBusy(true);
		setSwitchResumeError(null);
		try {
			await onSelectAiProfile(switchTargetProfile.id);
			// The switch landed; the resume rides the app's normal path (its
			// failures surface where every resume failure does).
			setSwitchResumeOpen(false);
			await onResume(status);
		} catch (e) {
			setSwitchResumeError((e as Error).message);
		} finally {
			setSwitchResumeBusy(false);
		}
	}
	const canEnter = !!status && state === "ready" && !preparedBoundaryThread && roomModels.length > 0 && !!draftModel && !lockedElsewhere && !purging;
	// The picker stays reachable when the ACTIVE profile offers nothing (its
	// provider signed out) as long as any ready profile has room models — that
	// is exactly when reaching another provider matters most (community #9).
	const switchableModelsAvailable = !!onSelectAiProfile && !!aiProfileStatus?.profiles.some((profile) => profile.ready && (profile.processes?.persistentRoom.models.length ?? 0) > 0);
	const showModelPicker = roomModels.length > 0 || switchableModelsAvailable;
	const canMaintain = !!status && status.exists && !hasActiveThread && !lockedElsewhere && !purging && (status.status === "ready" || status.status === "needs_absorb");
	// Disabled tooltips name the actual blocker and the way out; "resting" is
	// not a state shown anywhere else on the card.
	const enterDisabledReason = purging
		? purgeNote
		: state === "needs_absorb"
		? "This room needs to learn its recent sessions first. Use Maintain, then enter."
		: state === "ready"
			? roomModels.length === 0 && switchableModelsAvailable
				? "Pick a model from another profile to enter."
				: "Enter persistent chat"
			: "This room is not ready to enter yet.";
	const maintainDisabledReason = purging
		? purgeNote
		: lockedElsewhere
			? lockNote
		: hasActiveThread
			? "This room has a session in progress. Resume it and save a checkpoint, then Maintain becomes available."
			: !status || !status.exists
				? "Maintain becomes available once the room is set up."
				: "This room needs attention before it can be maintained.";
	async function enter() {
		const model = roomModels.find((m) => `${m.provider}/${m.model}` === draftModel);
		if (!model || entering) return;
		setEntering(true);
		try {
			if (!status) return;
			await onEnter(status, model);
		} finally {
			setEntering(false);
		}
	}
	return (
		<article className={`landing-card persistent-agent-card ${state}${maintenanceSeverity !== "none" ? ` mem-${maintenanceSeverity}` : ""}`}>
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
									: showBadge && <span className={`persistent-agent-badge ${badgeClass}`}>{badgeLabel}</span>}
						{status?.exists && onOpenSettings && <button className="card-gear-btn" aria-label="Room settings" title={purging ? purgeNote : "Room settings"} disabled={purging} onClick={onOpenSettings}>⚙</button>}
					</div>
				</div>
				{status && status.errors.length > 0 && <div className="persistent-agent-error-summary">This room needs attention before it can be used.</div>}
				<div className={`persistent-agent-meta ${memoryLevel}`}>
				{memory ? (
					memoryMeterReady ? (
						<div className="memory-meter" title={`How much recent conversation this room is holding (${memory.recentContextCount} of ${memory.recentContextHardCap}). Filling up is normal. Run Maintain to fold it into long-term memory.`}>
							<div className="memory-meter-head">
								<span className="memory-meter-checkpoint" title={memoryCheckpoint?.title}>{memoryCheckpoint ? `memory saved ${memoryCheckpoint.label}` : "no memories saved yet"}</span>
								<span className="memory-meter-label">{memory.recentContextCount} / {memory.recentContextHardCap}</span>
							</div>
							<div
								className="memory-meter-track"
								role="progressbar"
								aria-valuemin={0}
								aria-valuemax={memory.recentContextHardCap}
								aria-valuenow={memory.recentContextCount}
								aria-label={`Recent context memory: ${memory.recentContextCount} of ${memory.recentContextHardCap} (soft cap ${memory.recentContextSoftCap})`}
							>
								<div className="memory-meter-fill" style={{ width: `${memoryFill * 100}%` }} />
							</div>
						</div>
					) : (
						<div className="memory-meter-checkpoint" title={memoryCheckpoint?.title}>
							Recent Context {memory.recentContextCount} / {memory.recentContextHardCap} · {memoryCheckpoint ? `memory saved ${memoryCheckpoint.label}` : "no memories saved yet"}
						</div>
					)
				) : (
					<div>{status ? "Memory status unavailable" : "Checking local scaffold…"}</div>
				)}
				</div>
			</div>
			<div className="persistent-agent-actions">
				<div className="persistent-agent-primary-actions">
					{state === "missing" ? (
						<button className="landing-action" disabled>Unavailable</button>
					) : hasStandbyThread ? (
						canSwitchResume && switchTargetProfile ? (
							<button
								className="landing-action"
								title={`This thread is locked to ${lockedModelLabel}, which ${switchTargetProfile.label} provides. Resuming asks to switch the AI profile first.`}
								onClick={(e) => {
									switchResumeReturnFocusRef.current = e.currentTarget;
									setSwitchResumeError(null);
									setSwitchResumeOpen(true);
								}}
							>Resume →</button>
						) : (
							<button className="landing-action" title={purging ? purgeNote : lockedElsewhere ? lockNote : standbyActionTitle} disabled={!status || lockedElsewhere || !standbyModelAllowed || purging} onClick={() => status && onResume(status)}>Resume →</button>
						)
					) : preparedBoundaryThread ? (
						<button
							className="landing-action"
							title={purging ? purgeNote : lockedElsewhere ? lockNote : preparedSelectionMatchesLock || !roomModels.length ? "Enter the prepared room runtime" : "Enter with the selected model"}
							disabled={!status || lockedElsewhere || entering || purging || (roomModels.length > 0 && !draftModel)}
							onClick={() => {
								if (!status) return;
								// With no room models to offer, entering the prepared runtime on
								// its inherited model is still better than a dead button.
								if (preparedSelectionMatchesLock || !roomModels.length) void onResume(status);
								else void enter();
							}}
						>{entering ? "Entering…" : "Enter →"}</button>
					) : (
						<button className="landing-action" disabled={!canEnter || entering} title={lockedElsewhere ? lockNote : enterDisabledReason} onClick={enter}>{entering ? "Entering…" : "Enter →"}</button>
					)}
				</div>
				<div className="persistent-agent-secondary-actions">
					<button className="inline-action" disabled={!canMaintain} title={canMaintain ? `Fold ${label}'s recent activity into long-term memory. Routine housekeeping, not an error.` : maintainDisabledReason} onClick={() => status && onMaintain({ agentId: status.id, displayName: label })}>Maintain</button>
					{status && (status.errors.length > 0 || status.warnings.length > 0) && <button className="inline-action" onClick={() => setExpanded((v) => !v)}>{expanded ? "Hide" : "Details"}</button>}
				</div>
				{state !== "missing" && (
					<div className={`persistent-agent-model${hasStandbyThread ? " locked" : showModelPicker ? "" : " unavailable"}`}>
						{hasStandbyThread ? (
							<span className={`model-pill locked${standbyModelAllowed ? "" : " incompatible"}`} aria-label="Locked room thread model" title={standbyModelAllowed ? "This thread continues on the model it started with." : standbyActionTitle}>🔒 <span className="model-pill-name">{modelLabel}</span></span>
						) : showModelPicker ? (
							<RoomModelPicker roomModels={roomModels} modelStatusProfileId={modelStatus?.activeProfileId} value={draftModel} onChange={setDraftModel} aiProfileStatus={aiProfileStatus} standbyLockedModels={standbyLockedModels} onSelectAiProfile={onSelectAiProfile} />
						) : (
							<span className="model-pill disabled"><span className="model-pill-name">{modelLabel}</span></span>
						)}
					</div>
				)}
			</div>
			{expanded && status && (
				<div className="persistent-agent-details">
					{status.errors.length > 0 && <div className="error">This room needs attention before it can be used.</div>}
					{status.warnings.length > 0 && <div>Some room diagnostics are available in server logs.</div>}
				</div>
			)}
			{switchResumeOpen && switchTargetProfile && (
				<ProfileSwitchConfirm
					profile={switchTargetProfile}
					strandedCount={switchResumeStranded}
					continuation={`This conversation continues on ${lockedModelLabel}.`}
					switching={switchResumeBusy}
					error={switchResumeError}
					onCancel={closeSwitchResume}
					onConfirm={() => void switchAndResume()}
				/>
			)}
		</article>
	);
}
