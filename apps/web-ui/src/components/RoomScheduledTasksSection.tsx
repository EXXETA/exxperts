import { FormEvent, useEffect, useState } from "react";
import { fetchPersistentRoomBackgroundRuns } from "../persistent-room-background-runs-api";
import {
	createPersistentRoomSchedule,
	deletePersistentRoomSchedule,
	fetchPersistentRoomSchedules,
	updatePersistentRoomSchedule,
} from "../persistent-room-schedules-api";
import {
	applyRecurrenceToCreateRequest,
	applyRecurrenceToUpdateRequest,
	createDefaultScheduleRecurrenceDraft,
	formatAdvancedScheduleSummary,
	formatFriendlyWhenForJob,
	formatNativeTimeSummary,
	formatScheduleRecurrenceDraftSummary,
	inferScheduleRecurrenceDraftFromJob,
	SCHEDULE_CREATE_TYPE_AUTO,
	validateScheduleRecurrenceDraft,
} from "../persistent-room-schedule-presets";
import type {
	ScheduleAdvancedType,
	ScheduleOneTimeAtDay,
	ScheduleOneTimeDelayUnit,
	ScheduleOneTimeMode,
	ScheduleRecurrenceDraft,
	ScheduleRecurrenceMode,
} from "../persistent-room-schedule-presets";
import type {
	PersistentAgentStatus,
	PersistentRoomBackgroundRunsResponse,
	PersistentRoomBackgroundRunView,
	PersistentRoomScheduleCreateRequest,
	PersistentRoomScheduleJob,
	PersistentRoomScheduleSummary,
	PersistentRoomScheduleUpdateRequest,
	PersistentRoomSchedulesResponse,
} from "../types";

const PROMPT_PREVIEW_LIMIT = 220;
// Monday-first display order over cron day numbers (0 = Sunday).
const WEEKLY_DAY_CHIPS: Array<{ day: number; short: string; full: string }> = [
	{ day: 1, short: "Mon", full: "Monday" },
	{ day: 2, short: "Tue", full: "Tuesday" },
	{ day: 3, short: "Wed", full: "Wednesday" },
	{ day: 4, short: "Thu", full: "Thursday" },
	{ day: 5, short: "Fri", full: "Friday" },
	{ day: 6, short: "Sat", full: "Saturday" },
	{ day: 0, short: "Sun", full: "Sunday" },
];
const RECENT_RUN_HISTORY_LIMIT = 50;
const RECENT_RUN_DISPLAY_LIMIT = 3;
const ONE_TIME_TERMINAL_STATUSES = new Set<PersistentRoomBackgroundRunView["status"]>(["blocked", "succeeded", "failed", "cancelled"]);
type ScheduleMutation =
	| { kind: "create" }
	| { kind: "edit"; jobId: string }
	| { kind: "toggle"; jobId: string }
	| { kind: "delete"; jobId: string }
	| null;

interface ScheduleFormDraft {
	name: string;
	prompt: string;
	enabled: boolean;
	recurrence: ScheduleRecurrenceDraft;
}

const emptyCreateDraft = (): ScheduleFormDraft => ({
	name: "",
	prompt: "",
	enabled: true,
	recurrence: createDefaultScheduleRecurrenceDraft(),
});

function jobToDraft(job: PersistentRoomScheduleJob): ScheduleFormDraft {
	return {
		name: job.name,
		prompt: job.prompt,
		enabled: job.enabled,
		recurrence: inferScheduleRecurrenceDraftFromJob(job),
	};
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function formatScheduleType(type: PersistentRoomScheduleJob["type"]): string {
	switch (type) {
		case "once": return "Once";
		case "interval": return "Interval";
		case "cron": return "Cron";
		default: return type;
	}
}

function formatTimestamp(value: string | null | undefined): string {
	if (!value) return "not recorded";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
}

function shortId(value: string | undefined): string {
	if (!value) return "unknown";
	return value.length <= 10 ? value : value.slice(0, 8);
}

function formatRunStatus(status: PersistentRoomBackgroundRunView["status"]): string {
	switch (status) {
		case "queued": return "Queued";
		case "running": return "Running";
		case "deferred": return "Waiting";
		case "blocked": return "Blocked";
		case "succeeded": return "Completed";
		case "failed": return "Failed";
		case "cancelled": return "Cancelled";
		default: return status;
	}
}

function formatFriendlyRunReason(run: PersistentRoomBackgroundRunView): string | null {
	const reason = run.reason || run.readiness?.reason || run.error?.code;
	switch (reason) {
		case "room_in_use": return "Room is in use; will retry.";
		case "active_turn_in_flight": return "Room has work in progress.";
		case "prepared_runtime_boundary": return "Checkpoint/Forget needs a manual decision.";
		case "model_not_found": return "Scheduled model is not available.";
		case "provider_not_connected": return "AI provider is not connected.";
		case "model_policy_unavailable": return "Scheduled-room model policy is unavailable.";
		case "schedule_missing": return "Schedule was deleted before it ran.";
		case "schedule_disabled": return "Schedule was disabled before it ran.";
		case "completed": return "Completed.";
		case "already_completed": return "Already completed; no duplicate execution was performed.";
		default: break;
	}
	const fallback = run.message || run.readiness?.message || run.error?.message;
	if (fallback?.trim()) return fallback.trim();
	if (reason?.trim()) return reason.replace(/_/g, " ");
	return null;
}

function formatRunScheduleLabel(run: PersistentRoomBackgroundRunView, jobsById: Map<string, PersistentRoomScheduleJob>): string {
	const scheduleId = run.source.scheduleId;
	if (!scheduleId) return "Unknown schedule";
	const job = jobsById.get(scheduleId);
	if (job) return job.name || `Schedule ${shortId(job.id)}`;
	return `Deleted schedule ${shortId(scheduleId)}`;
}

function isScheduledRun(run: PersistentRoomBackgroundRunView): boolean {
	return run.kind === "scheduled-prompt" || Boolean(run.source.scheduleId);
}

function formatRunTiming(run: PersistentRoomBackgroundRunView): string {
	if (run.source.dueAt) return `Due ${formatTimestamp(run.source.dueAt)}`;
	if (run.finishedAt) return `Finished ${formatTimestamp(run.finishedAt)}`;
	if (run.startedAt) return `Started ${formatTimestamp(run.startedAt)}`;
	return `Created ${formatTimestamp(run.createdAt)}`;
}

function shouldShowRunReason(run: PersistentRoomBackgroundRunView): boolean {
	return run.status === "deferred" || run.status === "blocked" || run.status === "failed";
}

function getRunEventTimestamp(run: PersistentRoomBackgroundRunView): string {
	return run.finishedAt || run.startedAt || run.updatedAt || run.createdAt;
}

function buildRunsByScheduleId(runs: PersistentRoomBackgroundRunView[]): Map<string, PersistentRoomBackgroundRunView[]> {
	const runsByScheduleId = new Map<string, PersistentRoomBackgroundRunView[]>();
	for (const run of runs) {
		const scheduleId = run.source.scheduleId;
		if (!scheduleId) continue;
		const existing = runsByScheduleId.get(scheduleId) ?? [];
		existing.push(run);
		runsByScheduleId.set(scheduleId, existing);
	}
	for (const scheduleRuns of runsByScheduleId.values()) {
		scheduleRuns.sort((a, b) => getRunEventTimestamp(b).localeCompare(getRunEventTimestamp(a)));
	}
	return runsByScheduleId;
}

function findRelevantRunForJob(job: PersistentRoomScheduleJob, runsByScheduleId: Map<string, PersistentRoomBackgroundRunView[]>): PersistentRoomBackgroundRunView | null {
	const runs = runsByScheduleId.get(job.id) ?? [];
	if (runs.length === 0) return null;
	if (job.type === "once") {
		if (!job.nextRunAt) return runs[0] ?? null;
		return runs.find((run) => run.source.dueAt === job.nextRunAt) ?? null;
	}
	return runs[0] ?? null;
}

function deriveOneTimeState(job: PersistentRoomScheduleJob, latestRun: PersistentRoomBackgroundRunView | null): { label: string; tone: "default" | "disabled" | "success" | "warning" | "danger" } {
	if (latestRun) {
		switch (latestRun.status) {
			case "queued": return { label: "Queued", tone: "warning" };
			case "running": return { label: "Running", tone: "warning" };
			case "deferred": return { label: "Waiting", tone: "warning" };
			case "blocked": return { label: "Blocked", tone: "danger" };
			case "succeeded": return { label: "Completed", tone: "success" };
			case "failed": return { label: "Failed", tone: "danger" };
			case "cancelled": return { label: "Cancelled", tone: "disabled" };
			default: break;
		}
	}
	if (!job.enabled) return { label: "Disabled", tone: "disabled" };
	if (!job.nextRunAt) return { label: "Scheduled once", tone: "default" };
	const dueAt = new Date(job.nextRunAt).getTime();
	if (!Number.isNaN(dueAt) && dueAt <= Date.now()) return { label: "Past due", tone: "warning" };
	return { label: job.enabled ? "Scheduled once" : "Disabled", tone: job.enabled ? "default" : "disabled" };
}

function deriveScheduleState(job: PersistentRoomScheduleJob, latestRun: PersistentRoomBackgroundRunView | null): { label: string; tone: "default" | "disabled" | "success" | "warning" | "danger" } {
	if (job.type === "once") return deriveOneTimeState(job, latestRun);
	return { label: job.enabled ? "Enabled" : "Disabled", tone: job.enabled ? "default" : "disabled" };
}

function isCompletedSuccessfulOneTimeSchedule(job: PersistentRoomScheduleJob, latestRun: PersistentRoomBackgroundRunView | null): boolean {
	return job.type === "once" && latestRun?.status === "succeeded";
}

function deriveNextDueAt(jobs: PersistentRoomScheduleJob[], runsByScheduleId: Map<string, PersistentRoomBackgroundRunView[]>): string | null {
	const candidates: string[] = [];
	for (const job of jobs) {
		if (!job.enabled || !job.nextRunAt) continue;
		if (job.type === "once") {
			const latestRun = findRelevantRunForJob(job, runsByScheduleId);
			if (latestRun && ONE_TIME_TERMINAL_STATUSES.has(latestRun.status)) continue;
		}
		candidates.push(job.nextRunAt);
	}
	candidates.sort((a, b) => {
		const aTime = new Date(a).getTime();
		const bTime = new Date(b).getTime();
		if (Number.isNaN(aTime) || Number.isNaN(bTime)) return a.localeCompare(b);
		return aTime - bTime;
	});
	return candidates[0] ?? null;
}

function previewPrompt(prompt: string): string {
	const normalized = prompt.replace(/\s+/g, " ").trim();
	if (normalized.length <= PROMPT_PREVIEW_LIMIT) return normalized;
	return `${normalized.slice(0, PROMPT_PREVIEW_LIMIT).trimEnd()}…`;
}

function draftToCreateRequest(draft: ScheduleFormDraft): PersistentRoomScheduleCreateRequest | { error: string } {
	return applyRecurrenceToCreateRequest({
		name: draft.name.trim(),
		prompt: draft.prompt.trim(),
		enabled: draft.enabled,
	}, draft.recurrence);
}

function draftToUpdateRequest(draft: ScheduleFormDraft): PersistentRoomScheduleUpdateRequest | { error: string } {
	return applyRecurrenceToUpdateRequest({
		name: draft.name.trim(),
		prompt: draft.prompt.trim(),
		enabled: draft.enabled,
	}, draft.recurrence);
}

function hasDraftBuildError<T extends object>(value: T | { error: string }): value is { error: string } {
	return "error" in value;
}

function ScheduleSummary({ latestRun, nextDueAt, summary }: { latestRun: PersistentRoomBackgroundRunView | null; nextDueAt: string | null; summary: PersistentRoomScheduleSummary }) {
	if (summary.totalCount === 0) return null;
	const facts = [
		`${pluralize(summary.totalCount, "schedule")} · ${summary.enabledCount} enabled`,
		nextDueAt ? `next due ${formatTimestamp(nextDueAt)}` : null,
		latestRun ? `last run: ${formatRunStatus(latestRun.status)}` : null,
	].filter(Boolean);
	return (
		<div className="room-schedules-summary" aria-label="Scheduled tasks summary">
			<span className="room-schedules-summary-fact">{facts.join(" · ")}</span>
		</div>
	);
}

function ScheduleForm({
	allowAutoType,
	initialDraft,
	saving,
	error,
	onCancel,
	onSave,
}: {
	allowAutoType: boolean;
	initialDraft: ScheduleFormDraft;
	saving: boolean;
	error: string | null;
	onCancel: () => void;
	onSave: (draft: ScheduleFormDraft) => Promise<void>;
}) {
	const [draft, setDraft] = useState(initialDraft);
	const [validationError, setValidationError] = useState<string | null>(null);
	const summary = formatScheduleRecurrenceDraftSummary(draft.recurrence);
	const displayedError = validationError || error;

	function updateDraft(updater: (current: ScheduleFormDraft) => ScheduleFormDraft) {
		setDraft(updater);
		if (validationError) setValidationError(null);
	}

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const nextValidationError = validateScheduleRecurrenceDraft(draft.recurrence, { allowAutoType });
		if (nextValidationError) {
			setValidationError(nextValidationError);
			return;
		}
		await onSave(draft);
	}

	return (
		<form className="room-schedules-form" onSubmit={handleSubmit}>
			<label className="room-schedules-field">
				<span>Task name</span>
				<input
					className="launcher-path-input"
					value={draft.name}
					onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))}
					placeholder="Daily market brief"
					required
					disabled={saving}
				/>
			</label>
			<label className="room-schedules-field">
				<span>Prompt / what should this room do?</span>
				<textarea
					className="launcher-path-input"
					value={draft.prompt}
					onChange={(event) => updateDraft((current) => ({ ...current, prompt: event.target.value }))}
					placeholder="Summarize new files in the workspace since yesterday and flag anything that needs my attention."
					required
					rows={4}
					maxLength={20000}
					disabled={saving}
				/>
			</label>
			<ScheduleRecurrenceEditor
				allowAutoType={allowAutoType}
				disabled={saving}
				recurrence={draft.recurrence}
				onChange={(recurrence) => updateDraft((current) => ({ ...current, recurrence }))}
			/>
			<label className="room-schedules-checkbox">
				<span>Enabled</span>
				<input
					className="workspaces-tool-switch"
					type="checkbox"
					checked={draft.enabled}
					onChange={(event) => updateDraft((current) => ({ ...current, enabled: event.target.checked }))}
					disabled={saving}
					aria-label="Enabled"
				/>
			</label>
			<div className="room-schedules-save-summary" aria-live="polite">
				<span>Summary</span>
				<p>{summary ?? "Choose when this saved task should run."}</p>
			</div>
			{displayedError && <p className="workspaces-error">{displayedError}</p>}
			<div className="checkpoint-preview-actions room-schedules-form-actions">
				<button className="rs-btn" type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
				<button className="rs-quiet" type="button" onClick={onCancel} disabled={saving}>Cancel</button>
			</div>
		</form>
	);
}

function ScheduleRecurrenceEditor({
	allowAutoType,
	disabled,
	recurrence,
	onChange,
}: {
	allowAutoType: boolean;
	disabled: boolean;
	recurrence: ScheduleRecurrenceDraft;
	onChange: (recurrence: ScheduleRecurrenceDraft) => void;
}) {
	function setMode(mode: ScheduleRecurrenceMode) {
		onChange({ ...recurrence, mode });
	}

	function setDailyTime(time: string) {
		onChange({ ...recurrence, daily: { ...recurrence.daily, time } });
	}

	function toggleWeeklyDay(day: number) {
		const days = recurrence.weekly.days.includes(day)
			? recurrence.weekly.days.filter((value) => value !== day)
			: [...recurrence.weekly.days, day].sort((a, b) => a - b);
		onChange({ ...recurrence, weekly: { ...recurrence.weekly, days } });
	}

	function setWeeklyTime(time: string) {
		onChange({ ...recurrence, weekly: { ...recurrence.weekly, time } });
	}

	function setOneTimeMode(mode: ScheduleOneTimeMode) {
		onChange({ ...recurrence, oneTime: { ...recurrence.oneTime, mode } });
	}

	function setOneTimeInCount(count: string) {
		onChange({
			...recurrence,
			oneTime: { ...recurrence.oneTime, in: { ...recurrence.oneTime.in, count } },
		});
	}

	function setOneTimeInUnit(unit: ScheduleOneTimeDelayUnit) {
		onChange({
			...recurrence,
			oneTime: { ...recurrence.oneTime, in: { ...recurrence.oneTime.in, unit } },
		});
	}

	function setOneTimeAtDay(day: ScheduleOneTimeAtDay) {
		onChange({
			...recurrence,
			oneTime: { ...recurrence.oneTime, at: { ...recurrence.oneTime.at, day } },
		});
	}

	function setOneTimeAtTime(time: string) {
		onChange({
			...recurrence,
			oneTime: { ...recurrence.oneTime, at: { ...recurrence.oneTime.at, time } },
		});
	}

	function setAdvancedType(type: ScheduleAdvancedType) {
		onChange({ ...recurrence, advanced: { ...recurrence.advanced, type } });
	}

	function setAdvancedSchedule(schedule: string) {
		onChange({ ...recurrence, advanced: { ...recurrence.advanced, schedule } });
	}

	const dailyTimeSummary = formatNativeTimeSummary(recurrence.daily.time);
	const weeklySummary = recurrence.mode === "weekly" ? formatScheduleRecurrenceDraftSummary(recurrence) : null;
	const oneTimeAtSummary = formatNativeTimeSummary(recurrence.oneTime.at.time);

	return (
		<fieldset className="room-schedules-recurrence">
			<legend>When / recurrence</legend>
			<div className="room-schedules-mode-buttons" role="radiogroup" aria-label="Schedule recurrence mode">
				<ScheduleModeButton active={recurrence.mode === "daily"} disabled={disabled} onClick={() => setMode("daily")}>Daily</ScheduleModeButton>
				<ScheduleModeButton active={recurrence.mode === "weekly"} disabled={disabled} onClick={() => setMode("weekly")}>Weekly</ScheduleModeButton>
				<ScheduleModeButton active={recurrence.mode === "oneTime"} disabled={disabled} onClick={() => setMode("oneTime")}>One time</ScheduleModeButton>
				<ScheduleModeButton active={recurrence.mode === "advanced"} disabled={disabled} onClick={() => setMode("advanced")}>Advanced</ScheduleModeButton>
			</div>
			{recurrence.mode === "daily" && (
				<div className="room-schedules-preset-panel">
					<label className="room-schedules-field room-schedules-time-field">
						<span>Every day at</span>
						<input
							className="launcher-path-input"
							type="time"
							value={recurrence.daily.time}
							onChange={(event) => setDailyTime(event.target.value)}
							required
							disabled={disabled}
						/>
					</label>
					<p className="room-schedules-help">Runs every day at {dailyTimeSummary ?? "the selected time"}. Times use this app's local runtime.</p>
				</div>
			)}
			{recurrence.mode === "weekly" && (
				<div className="room-schedules-preset-panel">
					<div className="room-schedules-day-row" role="group" aria-label="Weekly schedule days">
						{WEEKLY_DAY_CHIPS.map(({ day, short, full }) => (
							<button
								key={day}
								className={recurrence.weekly.days.includes(day) ? "room-schedules-day-chip active" : "room-schedules-day-chip"}
								type="button"
								aria-pressed={recurrence.weekly.days.includes(day)}
								aria-label={full}
								disabled={disabled}
								onClick={() => toggleWeeklyDay(day)}
							>
								{short}
							</button>
						))}
					</div>
					<label className="room-schedules-field room-schedules-time-field">
						<span>At</span>
						<input
							className="launcher-path-input"
							type="time"
							value={recurrence.weekly.time}
							onChange={(event) => setWeeklyTime(event.target.value)}
							required
							disabled={disabled}
						/>
					</label>
					<p className="room-schedules-help">{weeklySummary ?? "Choose the days this task should run."} Times use this app's local runtime.</p>
				</div>
			)}
			{recurrence.mode === "oneTime" && (
				<div className="room-schedules-preset-panel">
					<div className="room-schedules-submode-row" role="radiogroup" aria-label="One-time schedule type">
						<ScheduleSubmodeButton active={recurrence.oneTime.mode === "in"} disabled={disabled} onClick={() => setOneTimeMode("in")}>In</ScheduleSubmodeButton>
						<ScheduleSubmodeButton active={recurrence.oneTime.mode === "at"} disabled={disabled} onClick={() => setOneTimeMode("at")}>At</ScheduleSubmodeButton>
					</div>
					{recurrence.oneTime.mode === "in" ? (
						<div className="room-schedules-inline-controls">
							<label className="room-schedules-field room-schedules-number-field">
								<span>Run once in</span>
								<input
									className="launcher-path-input"
									type="number"
									min="1"
									step="1"
									value={recurrence.oneTime.in.count}
									onChange={(event) => setOneTimeInCount(event.target.value)}
									required
									disabled={disabled}
								/>
							</label>
							<label className="room-schedules-field room-schedules-unit-field">
								<span>Unit</span>
								<select
									className="launcher-path-input"
									value={recurrence.oneTime.in.unit}
									onChange={(event) => setOneTimeInUnit(event.target.value as ScheduleOneTimeDelayUnit)}
									disabled={disabled}
								>
									<option value="minutes">minutes</option>
									<option value="hours">hours</option>
									<option value="days">days</option>
								</select>
							</label>
						</div>
					) : (
						<div className="room-schedules-inline-controls">
							<label className="room-schedules-field room-schedules-unit-field">
								<span>Day</span>
								<select
									className="launcher-path-input"
									value={recurrence.oneTime.at.day}
									onChange={(event) => setOneTimeAtDay(event.target.value as ScheduleOneTimeAtDay)}
									disabled={disabled}
								>
									<option value="today">Today</option>
									<option value="tomorrow">Tomorrow</option>
								</select>
							</label>
							<label className="room-schedules-field room-schedules-time-field">
								<span>Time</span>
								<input
									className="launcher-path-input"
									type="time"
									value={recurrence.oneTime.at.time}
									onChange={(event) => setOneTimeAtTime(event.target.value)}
									required
									disabled={disabled}
								/>
							</label>
						</div>
					)}
					<p className="room-schedules-help">{recurrence.oneTime.mode === "at" ? `Runs once ${recurrence.oneTime.at.day} at ${oneTimeAtSummary ?? "the selected time"}.` : "Runs once after the selected delay."}</p>
				</div>
			)}
			{recurrence.mode === "advanced" && (
				<div className="room-schedules-preset-panel">
					<p className="room-schedules-help">Advanced is for custom schedules. Most users should use Daily or One time.</p>
					<div className="room-schedules-form-grid">
						<label className="room-schedules-field">
							<span>Type</span>
							<select
								className="launcher-path-input"
								value={recurrence.advanced.type}
								onChange={(event) => setAdvancedType(event.target.value as ScheduleAdvancedType)}
								disabled={disabled}
							>
								{allowAutoType && <option value={SCHEDULE_CREATE_TYPE_AUTO}>Auto</option>}
								<option value="once">Once</option>
								<option value="interval">Interval</option>
								<option value="cron">Cron</option>
							</select>
						</label>
						<label className="room-schedules-field">
							<span>Schedule expression</span>
							<input
								className="launcher-path-input"
								value={recurrence.advanced.schedule}
								onChange={(event) => setAdvancedSchedule(event.target.value)}
								placeholder="+30m"
								required
								disabled={disabled}
							/>
						</label>
					</div>
					<p className="room-schedules-help">Examples: +30m, tomorrow at 7am, 2h, 0 0 7 * * *. Raw expressions are interpreted by the local app/server runtime. Timezone controls are not available yet.</p>
				</div>
			)}
		</fieldset>
	);
}

function ScheduleModeButton({ active, children, disabled, onClick }: { active: boolean; children: string; disabled: boolean; onClick: () => void }) {
	return (
		<button
			className={active ? "room-schedules-mode-button active" : "room-schedules-mode-button"}
			type="button"
			role="radio"
			aria-checked={active}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

function ScheduleSubmodeButton({ active, children, disabled, onClick }: { active: boolean; children: string; disabled: boolean; onClick: () => void }) {
	return (
		<button
			className={active ? "room-schedules-submode-button active" : "room-schedules-submode-button"}
			type="button"
			role="radio"
			aria-checked={active}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

function RecentScheduledRunsSection({
	error,
	loading,
	response,
	schedules,
}: {
	error: string | null;
	loading: boolean;
	response: PersistentRoomBackgroundRunsResponse | null;
	schedules: PersistentRoomScheduleJob[];
}) {
	const jobsById = new Map(schedules.map((job) => [job.id, job]));
	const allScheduledRuns = (response?.runs ?? []).filter(isScheduledRun);
	const scheduledRuns = allScheduledRuns.slice(0, RECENT_RUN_DISPLAY_LIMIT);

	// Nothing has ever run and there are no schedules to run: the schedules
	// empty state already covers this, so don't stack a second empty section.
	if (!loading && !error && scheduledRuns.length === 0 && schedules.length === 0) return null;

	return (
		<section className="room-schedules-history" aria-label="Recent scheduled runs">
			<div className="room-schedules-history-head">
				<strong>Recent runs</strong>
				{scheduledRuns.length > 0 && allScheduledRuns.length > scheduledRuns.length && (
					<span>Showing latest {scheduledRuns.length}</span>
				)}
			</div>
			{loading && <p className="workspaces-empty-state">Loading recent runs…</p>}
			{error && <p className="workspaces-error">Could not load recent runs: {error}</p>}
			{!loading && !error && scheduledRuns.length === 0 && <p className="workspaces-empty-state">Nothing has run yet. Runs appear here once a schedule fires.</p>}
			{!loading && !error && scheduledRuns.length > 0 && (
				<div className="room-schedules-run-list">
					{scheduledRuns.map((run) => {
						const reason = shouldShowRunReason(run) ? formatFriendlyRunReason(run) : null;
						return (
							<article className="room-schedules-run" key={run.runId}>
								<div className="room-schedules-run-primary">
									<span className={`room-schedules-run-status status-${run.status}`}>{formatRunStatus(run.status)}</span>
									<strong>{formatRunScheduleLabel(run, jobsById)}</strong>
									<span>{formatRunTiming(run)}</span>
								</div>
								{reason && <p className="room-schedules-run-reason">{reason}</p>}
							</article>
						);
					})}
				</div>
			)}
		</section>
	);
}

function ScheduleJobCard({
	job,
	confirmingDelete,
	disabled,
	editing,
	error,
	latestRun,
	mutation,
	onCancelDelete,
	onCancelEdit,
	onConfirmDelete,
	onEdit,
	onRequestDelete,
	onSaveEdit,
	onToggleEnabled,
}: {
	job: PersistentRoomScheduleJob;
	confirmingDelete: boolean;
	disabled: boolean;
	editing: boolean;
	error: string | null;
	latestRun: PersistentRoomBackgroundRunView | null;
	mutation: ScheduleMutation;
	onCancelDelete: () => void;
	onCancelEdit: () => void;
	onConfirmDelete: () => Promise<void>;
	onEdit: () => void;
	onRequestDelete: () => void;
	onSaveEdit: (draft: ScheduleFormDraft) => Promise<void>;
	onToggleEnabled: () => Promise<void>;
}) {
	const promptPreview = previewPrompt(job.prompt);
	const whenSummary = formatFriendlyWhenForJob(job);
	// A friendly When sentence and the raw expression must never both state the
	// same timing: the raw line only shows when no nicer sentence exists.
	const hasFriendlyWhen = whenSummary !== formatAdvancedScheduleSummary(job.type, job.schedule);
	const savingEdit = mutation?.kind === "edit" && mutation.jobId === job.id;
	const toggling = mutation?.kind === "toggle" && mutation.jobId === job.id;
	const deleting = mutation?.kind === "delete" && mutation.jobId === job.id;
	const actionDisabled = disabled || Boolean(mutation);
	const rowState = deriveScheduleState(job, latestRun);
	const rowStateClass = rowState.tone === "default" ? "room-schedules-record-state" : `room-schedules-record-state ${rowState.tone}`;
	const latestAttempt = latestRun ? `${formatRunStatus(latestRun.status)} at ${formatTimestamp(getRunEventTimestamp(latestRun))}` : null;
	const latestReason = latestRun ? formatFriendlyRunReason(latestRun) : null;
	return (
		<article className="room-schedules-job">
			<div className="room-schedules-job-head">
				<strong>{job.name || job.id}</strong>
				<span className={rowStateClass}>{rowState.label}</span>
			</div>
			{hasFriendlyWhen && <p className="room-schedules-when-summary"><span>When:</span> {whenSummary}</p>}
			<div className="room-schedules-job-meta">
				{job.nextRunAt && <span>Next due {formatTimestamp(job.nextRunAt)}</span>}
				{latestAttempt && <span>Last attempt: {latestAttempt}</span>}
				{!hasFriendlyWhen && <span className="room-schedules-raw" title="Raw schedule expression">{formatScheduleType(job.type)} · <code>{job.schedule}</code></span>}
			</div>
			{latestReason && latestRun?.status !== "succeeded" && <p className="room-schedules-row-reason">{latestReason}</p>}
			{editing ? (
				<ScheduleForm
					key={job.id}
					allowAutoType={false}
					initialDraft={jobToDraft(job)}
					saving={savingEdit}
					error={error}
					onCancel={onCancelEdit}
					onSave={onSaveEdit}
				/>
			) : (
				<>
					<p className="room-schedules-prompt"><span>Prompt preview:</span> {promptPreview || "No prompt text recorded."}</p>
					{error && <p className="workspaces-error">{error}</p>}
					<div className="room-schedules-job-actions">
						<button className="rs-quiet" type="button" onClick={onEdit} disabled={actionDisabled}>Edit</button>
						<button className="rs-quiet" type="button" onClick={onToggleEnabled} disabled={actionDisabled}>{toggling ? "Saving…" : job.enabled ? "Disable" : "Enable"}</button>
						<button className="rs-quiet rs-quiet-danger" type="button" onClick={onRequestDelete} disabled={actionDisabled}>Delete</button>
					</div>
					{confirmingDelete && (
						<div className="room-schedules-delete-confirm">
							<p>Delete this schedule record? This only removes the saved record.</p>
							<div className="room-schedules-job-actions">
								<button className="rs-btn rs-btn-danger" type="button" onClick={onConfirmDelete} disabled={deleting}>{deleting ? "Deleting…" : "Delete"}</button>
								<button className="rs-quiet" type="button" onClick={onCancelDelete} disabled={deleting}>Cancel</button>
							</div>
						</div>
					)}
				</>
			)}
		</article>
	);
}

export function RoomScheduledTasksSection({ status }: { status: PersistentAgentStatus }) {
	const [response, setResponse] = useState<PersistentRoomSchedulesResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [runsResponse, setRunsResponse] = useState<PersistentRoomBackgroundRunsResponse | null>(null);
	const [runsLoading, setRunsLoading] = useState(false);
	const [runsError, setRunsError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [editingJobId, setEditingJobId] = useState<string | null>(null);
	const [confirmDeleteJobId, setConfirmDeleteJobId] = useState<string | null>(null);
	const [jobError, setJobError] = useState<{ jobId: string; message: string } | null>(null);
	const [completedOneTimeOpen, setCompletedOneTimeOpen] = useState(false);
	const [mutation, setMutation] = useState<ScheduleMutation>(null);
	const summary = response?.summary ?? status.scheduleSummary;
	const canLoadSchedules = status.exists;
	const creating = mutation?.kind === "create";
	const recentScheduledRuns = (runsResponse?.runs ?? []).filter(isScheduledRun);
	const runsByScheduleId = buildRunsByScheduleId(recentScheduledRuns);
	const latestScheduledRun = recentScheduledRuns[0] ?? null;
	const derivedNextDueAt = response && runsResponse ? deriveNextDueAt(response.jobs, runsByScheduleId) : summary.nextRunAt;
	const scheduleRows = (response?.jobs ?? []).map((job) => ({ job, latestRun: findRelevantRunForJob(job, runsByScheduleId) }));
	const activeScheduleRows = scheduleRows.filter(({ job, latestRun }) => !isCompletedSuccessfulOneTimeSchedule(job, latestRun));
	const completedOneTimeRows = scheduleRows.filter(({ job, latestRun }) => isCompletedSuccessfulOneTimeSchedule(job, latestRun));

	useEffect(() => {
		let cancelled = false;
		setResponse(null);
		setRunsResponse(null);
		setMessage(null);
		setCreateOpen(false);
		setCreateError(null);
		setEditingJobId(null);
		setConfirmDeleteJobId(null);
		setJobError(null);
		setCompletedOneTimeOpen(false);
		setMutation(null);
		if (!canLoadSchedules) {
			setLoading(false);
			setRunsLoading(false);
			setError("Create this room before viewing scheduled tasks.");
			setRunsError(null);
			return () => { cancelled = true; };
		}
		setLoading(true);
		setError(null);
		setRunsLoading(true);
		setRunsError(null);
		void fetchPersistentRoomSchedules(status.id)
			.then((nextResponse) => {
				if (!cancelled) setResponse(nextResponse);
			})
			.catch((e) => {
				if (!cancelled) setError((e as Error).message || "Failed to load scheduled tasks.");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		void fetchPersistentRoomBackgroundRuns(status.id, { limit: RECENT_RUN_HISTORY_LIMIT })
			.then((nextResponse) => {
				if (!cancelled) setRunsResponse(nextResponse);
			})
			.catch((e) => {
				if (!cancelled) setRunsError((e as Error).message || "Failed to load recent scheduled runs.");
			})
			.finally(() => {
				if (!cancelled) setRunsLoading(false);
			});
		return () => { cancelled = true; };
	}, [canLoadSchedules, status.id]);

	async function handleCreate(draft: ScheduleFormDraft) {
		setMutation({ kind: "create" });
		setCreateError(null);
		setMessage(null);
		try {
			const request = draftToCreateRequest(draft);
			if (hasDraftBuildError(request)) {
				setCreateError(request.error);
				return;
			}
			const nextResponse = await createPersistentRoomSchedule(status.id, request);
			setResponse(nextResponse);
			setCreateOpen(false);
			setMessage("Schedule saved.");
		} catch (e) {
			setCreateError((e as Error).message || "Failed to save scheduled task.");
		} finally {
			setMutation(null);
		}
	}

	async function handleSaveEdit(jobId: string, draft: ScheduleFormDraft) {
		setMutation({ kind: "edit", jobId });
		setJobError(null);
		setMessage(null);
		try {
			const request = draftToUpdateRequest(draft);
			if (hasDraftBuildError(request)) {
				setJobError({ jobId, message: request.error });
				return;
			}
			const nextResponse = await updatePersistentRoomSchedule(status.id, jobId, request);
			setResponse(nextResponse);
			setEditingJobId(null);
			setMessage("Schedule updated.");
		} catch (e) {
			setJobError({ jobId, message: (e as Error).message || "Failed to update scheduled task." });
		} finally {
			setMutation(null);
		}
	}

	async function handleToggleEnabled(job: PersistentRoomScheduleJob) {
		setMutation({ kind: "toggle", jobId: job.id });
		setJobError(null);
		setMessage(null);
		try {
			const nextResponse = await updatePersistentRoomSchedule(status.id, job.id, { enabled: !job.enabled });
			setResponse(nextResponse);
			setMessage(job.enabled ? "Schedule disabled." : "Schedule enabled.");
		} catch (e) {
			setJobError({ jobId: job.id, message: (e as Error).message || "Failed to update scheduled task." });
		} finally {
			setMutation(null);
		}
	}

	async function handleDelete(job: PersistentRoomScheduleJob) {
		setMutation({ kind: "delete", jobId: job.id });
		setJobError(null);
		setMessage(null);
		try {
			const nextResponse = await deletePersistentRoomSchedule(status.id, job.id);
			setResponse(nextResponse);
			setConfirmDeleteJobId(null);
			if (editingJobId === job.id) setEditingJobId(null);
			setMessage("Schedule deleted.");
		} catch (e) {
			setJobError({ jobId: job.id, message: (e as Error).message || "Failed to delete scheduled task." });
		} finally {
			setMutation(null);
		}
	}

	return (
		<div className="room-schedules-section">
			<header className="rs-pane-head">
				<h3>Scheduled tasks</h3>
				{!createOpen && canLoadSchedules && !loading && !error && (
					<div className="rs-pane-actions">
						<button
							className="rs-btn"
							type="button"
							onClick={() => {
								setCreateOpen(true);
								setCreateError(null);
								setJobError(null);
								setMessage(null);
								setEditingJobId(null);
								setConfirmDeleteJobId(null);
							}}
							disabled={Boolean(mutation)}
						>
							Add schedule
						</button>
					</div>
				)}
			</header>
			<p className="rs-pane-sub">Prompts this room runs on its own.</p>
			<ScheduleSummary latestRun={latestScheduledRun} nextDueAt={derivedNextDueAt} summary={summary} />
			{message && <p className="workspaces-success">{message}</p>}
			{loading && <p className="workspaces-empty-state">Loading scheduled tasks…</p>}
			{error && <div className="workspaces-error">Could not load scheduled tasks: {error}</div>}
			{createOpen && (
				<ScheduleForm
					allowAutoType
					initialDraft={emptyCreateDraft()}
					saving={creating}
					error={createError}
					onCancel={() => { setCreateOpen(false); setCreateError(null); }}
					onSave={handleCreate}
				/>
			)}
			{!loading && !error && response && response.jobs.length === 0 && <p className="workspaces-empty-state">No scheduled tasks yet.</p>}
			{!loading && !error && response && response.jobs.length > 0 && activeScheduleRows.length === 0 && completedOneTimeRows.length > 0 && (
				<p className="workspaces-empty-state">No active schedules. Completed one-time schedules are collapsed below.</p>
			)}
			{!loading && !error && response && activeScheduleRows.length > 0 && (
				<div className="room-schedules-list">
					{activeScheduleRows.map(({ job, latestRun }) => (
						<ScheduleJobCard
							key={job.id}
							job={job}
							latestRun={latestRun}
							confirmingDelete={confirmDeleteJobId === job.id}
							disabled={Boolean(editingJobId && editingJobId !== job.id)}
							editing={editingJobId === job.id}
							error={jobError?.jobId === job.id ? jobError.message : null}
							mutation={mutation}
							onCancelDelete={() => { setConfirmDeleteJobId(null); setJobError(null); }}
							onCancelEdit={() => { setEditingJobId(null); setJobError(null); }}
							onConfirmDelete={() => handleDelete(job)}
							onEdit={() => {
								setEditingJobId(job.id);
								setCreateOpen(false);
								setCreateError(null);
								setConfirmDeleteJobId(null);
								setJobError(null);
								setMessage(null);
							}}
							onRequestDelete={() => {
								setConfirmDeleteJobId(job.id);
								setJobError(null);
								setMessage(null);
							}}
							onSaveEdit={(draft) => handleSaveEdit(job.id, draft)}
							onToggleEnabled={() => handleToggleEnabled(job)}
						/>
					))}
				</div>
			)}
			{!loading && !error && response && completedOneTimeRows.length > 0 && (
				<section className="room-schedules-completed">
					<button
						className="room-schedules-completed-toggle"
						type="button"
						aria-expanded={completedOneTimeOpen}
						onClick={() => setCompletedOneTimeOpen((open) => !open)}
					>
						<span>{completedOneTimeOpen ? "▾" : "▸"}</span>
						Completed one-time schedules ({completedOneTimeRows.length})
					</button>
					{completedOneTimeOpen && (
						<div className="room-schedules-list">
							{completedOneTimeRows.map(({ job, latestRun }) => (
								<ScheduleJobCard
									key={job.id}
									job={job}
									latestRun={latestRun}
									confirmingDelete={confirmDeleteJobId === job.id}
									disabled={Boolean(editingJobId && editingJobId !== job.id)}
									editing={editingJobId === job.id}
									error={jobError?.jobId === job.id ? jobError.message : null}
									mutation={mutation}
									onCancelDelete={() => { setConfirmDeleteJobId(null); setJobError(null); }}
									onCancelEdit={() => { setEditingJobId(null); setJobError(null); }}
									onConfirmDelete={() => handleDelete(job)}
									onEdit={() => {
										setEditingJobId(job.id);
										setCreateOpen(false);
										setCreateError(null);
										setConfirmDeleteJobId(null);
										setJobError(null);
										setMessage(null);
									}}
									onRequestDelete={() => {
										setConfirmDeleteJobId(job.id);
										setJobError(null);
										setMessage(null);
									}}
									onSaveEdit={(draft) => handleSaveEdit(job.id, draft)}
									onToggleEnabled={() => handleToggleEnabled(job)}
								/>
							))}
						</div>
					)}
				</section>
			)}
			{!loading && !error && response && (
				<RecentScheduledRunsSection
					error={runsError}
					loading={runsLoading}
					response={runsResponse}
					schedules={response.jobs}
				/>
			)}
		</div>
	);
}
