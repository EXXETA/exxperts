import { useEffect, useRef, useState } from "react";
import type { PersistentAgentStatus } from "../types";
import { fetchPersistentRoomMaintenanceSettings, updatePersistentRoomMaintenanceSettings } from "../persistent-room-management-api";
import { AUTOMATIC_APPLY_SETTING_LABEL } from "../memory-v2-copy";
import {
	AUTOMATIC_APPLY_INFO,
	budgetSettledHint,
	MEMORY_LIMIT_HINT,
	MEMORY_LIMIT_LABEL,
	MEMORY_OVER_LIMIT_SENTENCE,
	memoryFullShort,
	memoryPercentFull,
	memoryUsageTitle,
	REMEMBER_WITHOUT_PREVIEW_INFO,
	REMEMBER_WITHOUT_PREVIEW_LABEL,
	ROOM_MEMORY_SUB,
	ROOM_MEMORY_TOGGLES_FOOTNOTE,
	ROOM_MEMORY_TOGGLES_TITLE,
} from "../memory-surface-copy";
import { RsInfo } from "./rs-info";
import { RoomMemoryEntriesSection, RoomMemoryHistorySection } from "./room-memory-entries";

const MEMORY_BUDGET_MIN_TOKENS = 10_000;
// The ceiling the server enforces on every memory write. It rose with the
// entry model: a large room can now choose to carry its memory instead of
// watching two thirds of it move to the archive on the first update.
const MEMORY_BUDGET_MAX_TOKENS = 80_000;

export function fmtTokensK(value: number): string {
	// Tiny values must not read as "0k": show them plainly.
	if (value < 950) return `${Math.max(0, Math.round(value))}`;
	if (value < 9_500) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${Math.round(value / 1000)}k`;
}

export function RoomMaintenanceSection({ status }: { status: PersistentAgentStatus }) {
	const [fastPath, setFastPath] = useState<boolean | null>(null);
	const [quickApply, setQuickApply] = useState<boolean | null>(null);
	const [budget, setBudget] = useState<number | null>(null);
	const [savedBudget, setSavedBudget] = useState<number | null>(null);
	// The budget the settle chose when this room came to 0.12, when it resized
	// it; the hint under the slider shows only while the budget still is that.
	const [budgetSettledTo, setBudgetSettledTo] = useState<number | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const budgetSaveTimer = useRef<number | null>(null);
	// What the room's memory measures right now. The room status carries it too,
	// but that arrives on a poll; the notes pane re-reads it after every write
	// and after an Undo, so the line below never lags what is on screen.
	const [liveTokens, setLiveTokens] = useState<number | null>(null);
	// Bumped by an Undo: the notes, the archive and the usage line are all a
	// reading of one file, so when that file goes back they are all read again.
	const [reloadKey, setReloadKey] = useState(0);
	// Bumped when a note is deleted from the archive for good, so the history below shows it.
	const [historyKey, setHistoryKey] = useState(0);
	// Bumped by an Undo too: a save that raised the limit takes the raise back
	// with it, and the slider must show the limit the room now has.
	const [settingsReloadKey, setSettingsReloadKey] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setFastPath(null);
		setQuickApply(null);
		setBudget(null);
		setSavedBudget(null);
		setBudgetSettledTo(null);
		setError(null);
		fetchPersistentRoomMaintenanceSettings(status.id)
			.then((response) => {
				if (cancelled) return;
				setFastPath(response.settings.fastPathSecondApproval);
				setQuickApply(response.settings.quickCheckpointAutoApply);
				setBudget(response.settings.memoryBudgetTokens);
				setSavedBudget(response.settings.memoryBudgetTokens);
				setBudgetSettledTo(typeof response.settings.memoryBudgetSettledTo === "number" ? response.settings.memoryBudgetSettledTo : null);
			})
			.catch((e) => {
				if (!cancelled) setError((e as Error).message);
			});
		return () => {
			cancelled = true;
		};
	}, [status.id, settingsReloadKey]);

	// Debounced budget save: the slider updates locally on every tick and
	// persists once the user settles for half a second.
	useEffect(() => {
		if (budget === null || savedBudget === null || budget === savedBudget) return;
		if (budgetSaveTimer.current !== null) window.clearTimeout(budgetSaveTimer.current);
		budgetSaveTimer.current = window.setTimeout(() => {
			budgetSaveTimer.current = null;
			updatePersistentRoomMaintenanceSettings(status.id, { memoryBudgetTokens: budget })
				.then((response) => {
					setSavedBudget(response.settings.memoryBudgetTokens);
					setBudget((current) => (current === budget ? response.settings.memoryBudgetTokens : current));
					setError(null);
				})
				.catch((e) => setError((e as Error).message));
		}, 500);
		return () => {
			if (budgetSaveTimer.current !== null) window.clearTimeout(budgetSaveTimer.current);
		};
	}, [budget, savedBudget, status.id]);

	async function toggleFastPath(next: boolean) {
		if (saving || fastPath === null) return;
		setSaving(true);
		setError(null);
		const previous = fastPath;
		setFastPath(next);
		try {
			const response = await updatePersistentRoomMaintenanceSettings(status.id, { fastPathSecondApproval: next });
			setFastPath(response.settings.fastPathSecondApproval);
		} catch (e) {
			setFastPath(previous);
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	async function toggleQuickApply(next: boolean) {
		if (saving || quickApply === null) return;
		setSaving(true);
		setError(null);
		const previous = quickApply;
		setQuickApply(next);
		try {
			const response = await updatePersistentRoomMaintenanceSettings(status.id, { quickCheckpointAutoApply: next });
			setQuickApply(response.settings.quickCheckpointAutoApply);
		} catch (e) {
			setQuickApply(previous);
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const currentMemoryTokens = liveTokens ?? status.memoryBudget?.reviewTargetEstimatedTokens ?? null;
	const usagePercent = budget !== null && currentMemoryTokens !== null ? memoryPercentFull(currentMemoryTokens, budget) : null;
	// One sentence, one limit: both the percent and the over state compare the
	// server-computed review-target tokens against the limit ON SCREEN — the
	// slider value, which may be an unsaved draft. Mixing the server overBudget
	// flag (frozen at status-fetch time) with a dragged slider value would let
	// the line read "70% full · Above its budget" mid-drag. This is the same
	// comparison overMemoryBudget makes server-side once the draft saves.
	const overBudget = budget !== null && currentMemoryTokens !== null && currentMemoryTokens > budget;

	return (
		<div className="room-maintenance-section">
			<header className="rs-pane-head">
				<h3>Memory</h3>
			</header>
			<p className="rs-pane-sub">{ROOM_MEMORY_SUB}</p>
			<h4 className="memory-note-group-head">{ROOM_MEMORY_TOGGLES_TITLE}</h4>
			<p className="rs-row-footnote">{ROOM_MEMORY_TOGGLES_FOOTNOTE}</p>
			<label className="rs-row">
				<div className="rs-row-main">
					<span className="rs-row-label">
						{AUTOMATIC_APPLY_SETTING_LABEL}
						<RsInfo text={AUTOMATIC_APPLY_INFO} />
					</span>
				</div>
				<input
					className="workspaces-tool-switch"
					type="checkbox"
					checked={fastPath === true}
					disabled={fastPath === null || saving}
					onChange={(e) => void toggleFastPath(e.target.checked)}
					aria-label={AUTOMATIC_APPLY_SETTING_LABEL}
				/>
			</label>
			<label className="rs-row">
				<div className="rs-row-main">
					<span className="rs-row-label">
						{REMEMBER_WITHOUT_PREVIEW_LABEL}
						<RsInfo text={REMEMBER_WITHOUT_PREVIEW_INFO} />
					</span>
				</div>
				<input
					className="workspaces-tool-switch"
					type="checkbox"
					checked={quickApply === true}
					disabled={quickApply === null || saving}
					onChange={(e) => void toggleQuickApply(e.target.checked)}
					aria-label={REMEMBER_WITHOUT_PREVIEW_LABEL}
				/>
			</label>
			<div className="rs-row memory-budget-row">
				<div className="rs-row-main">
					<span className="rs-row-label">
						{MEMORY_LIMIT_LABEL}
						<span className="memory-budget-value">{budget !== null ? `${fmtTokensK(budget)} tokens` : "…"}</span>
					</span>
					<span className="rs-row-hint">{MEMORY_LIMIT_HINT}</span>
					<input
						className="memory-budget-slider"
						type="range"
						min={MEMORY_BUDGET_MIN_TOKENS}
						max={MEMORY_BUDGET_MAX_TOKENS}
						step={1000}
						value={budget ?? MEMORY_BUDGET_MIN_TOKENS}
						disabled={budget === null}
						onChange={(e) => setBudget(Number(e.target.value))}
						aria-label={`${MEMORY_LIMIT_LABEL} in tokens`}
					/>
					{usagePercent !== null && (
						// The percent is the sentence; the two token numbers behind it are
						// one hover away, which is the only place this pane says "tokens"
						// other than beside the slider itself.
						<p className="memory-budget-usage" title={memoryUsageTitle(currentMemoryTokens!, budget!)}>
							{memoryFullShort(usagePercent)}{overBudget ? ` · ${MEMORY_OVER_LIMIT_SENTENCE}` : ""}
						</p>
					)}
					{budgetSettledTo !== null && savedBudget === budgetSettledTo && (
						<span className="rs-row-hint">{budgetSettledHint(savedBudget)}</span>
					)}
				</div>
			</div>
			{error && <div className="room-maintenance-error">{error}</div>}
			<RoomMemoryEntriesSection key={reloadKey} status={status} onMemoryTokens={setLiveTokens} onArchiveDeleted={() => setHistoryKey((key) => key + 1)} />
			{/* The history re-reads itself after an Undo and keeps what that undo said, so it is not remounted; a note deleted for good re-reads it too. */}
			<RoomMemoryHistorySection status={status} reloadKey={historyKey} onUndone={() => { setReloadKey((key) => key + 1); setSettingsReloadKey((key) => key + 1); }} />
		</div>
	);
}
