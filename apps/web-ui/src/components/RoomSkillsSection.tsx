import { useEffect, useMemo, useState } from "react";
import type { PersistentAgentStatus } from "../types";
import { fetchPersistentRoomSkillSettings, updatePersistentRoomSkillSetting, type PersistentRoomEnabledSkillStatus } from "../persistent-room-management-api";
import { fetchSkill, fetchSkills, type SkillDetail, type SkillListItem } from "../skills-api";
import { FileGroupList, groupFilesByFolder } from "./file-groups";
import { MarkdownRenderer } from "./Markdown";
import { RsInfo } from "./rs-info";
import { PaneHeader } from "./pane-header";

/**
 * Room settings wheel — Skills panel (skills MR-5, spec §4/§5; enabled-first
 * redesign, Borja 2026-07-11). Shows ONLY the room's enabled skills, so the
 * wheel stays constant-size however large the library grows; adding more goes
 * through a searchable picker over the not-yet-enabled library. Enabling pins
 * the skill's current sha256 server-side; a skill whose body changed since
 * enablement shows a "re-review required" state and is NOT injected until
 * re-enabled after review. The resident-cost line keeps the
 * ~100-tokens-per-skill index price visible.
 */
/** A skill's problem in plain words, under its description; null when it works. */
function skillProblemLine(state: PersistentRoomEnabledSkillStatus): string | null {
	if (state.status === "hash-mismatch") return "Changed since you enabled it. The room stopped using it until you review the new version.";
	if (state.status === "missing") return "Removed from your library, so the room no longer uses it. Remove it here, or import it again.";
	if (state.manualOnly) return "Its author marked it for manual use only. Rooms cannot start a skill by hand yet, so the room does not use it.";
	return null;
}

/** The files line's state: allowed, off, or allowed before and changed since. */
function runFilesLine(executeState: PersistentRoomEnabledSkillStatus["executeState"], count: number): string {
	const one = count === 1;
	if (executeState === "approved") return one ? "Allowed: the room may run its file as it is now." : `Allowed: the room may run its ${count} files as they are now.`;
	if (executeState === "drifted") {
		return one
			? "Its file changed since you allowed it, so it does not run. Turn this on to allow it as it is now."
			: "Its files changed since you allowed them, so they do not run. Turn this on to allow them as they are now.";
	}
	return one ? "Off: the room follows its instructions but does not run its file." : `Off: the room follows its instructions but does not run its ${count} files.`;
}

export function RoomSkillsSection({ status, onOpenSkillsLibrary }: { status: PersistentAgentStatus; onOpenSkillsLibrary?: () => void }) {
	const [library, setLibrary] = useState<SkillListItem[] | null>(null);
	const [enabled, setEnabled] = useState<PersistentRoomEnabledSkillStatus[] | null>(null);
	const [busyName, setBusyName] = useState<string | null>(null);
	// Execution approval (executable skills): its own busy name so the enable/remove
	// buttons keep their own labels while an approval is in flight.
	const [execBusyName, setExecBusyName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Re-review gate (skills MR-5 hardening): a drifted skill can only be
	// re-enabled after its CURRENT body is shown here — no sight-unseen re-adoption.
	const [reviewing, setReviewing] = useState<SkillDetail | null>(null);
	const [reviewLoadingName, setReviewLoadingName] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	// Skills whose file list is open under their files line.
	const [filesShown, setFilesShown] = useState<ReadonlySet<string>>(new Set());
	const [query, setQuery] = useState("");

	useEffect(() => {
		let cancelled = false;
		setLibrary(null);
		setEnabled(null);
		setError(null);
		Promise.all([fetchSkills(), fetchPersistentRoomSkillSettings(status.id)])
			.then(([skills, response]) => {
				if (cancelled) return;
				setLibrary(skills);
				setEnabled(response.skills);
			})
			.catch((e) => {
				if (!cancelled) setError((e as Error).message);
			});
		return () => {
			cancelled = true;
		};
	}, [status.id]);

	async function toggle(name: string, action: "enable" | "disable") {
		setBusyName(name);
		setError(null);
		try {
			await updatePersistentRoomSkillSetting(status.id, action, name);
			// The PUT view carries no execution capability, so the pane re-reads the
			// full settings view and the approval rows stay accurate.
			setEnabled((await fetchPersistentRoomSkillSettings(status.id)).skills);
			if (action === "enable") setReviewing(null);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusyName(null);
		}
	}

	async function setExecution(name: string, action: "approve-execution" | "revoke-execution") {
		setExecBusyName(name);
		setError(null);
		try {
			await updatePersistentRoomSkillSetting(status.id, action, name);
			setEnabled((await fetchPersistentRoomSkillSettings(status.id)).skills);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setExecBusyName(null);
		}
	}

	function toggleFilesShown(name: string) {
		setFilesShown((shown) => {
			const next = new Set(shown);
			if (!next.delete(name)) next.add(name);
			return next;
		});
	}

	async function openReview(name: string) {
		setReviewLoadingName(name);
		setError(null);
		try {
			setReviewing(await fetchSkill(name));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setReviewLoadingName(null);
		}
	}

	const libraryByName = useMemo(() => new Map((library ?? []).map((skill) => [skill.name, skill] as const)), [library]);
	const enabledNames = useMemo(() => new Set((enabled ?? []).map((skill) => skill.name)), [enabled]);
	const available = useMemo(() => {
		const rest = (library ?? []).filter((skill) => !enabledNames.has(skill.name));
		const q = query.trim().toLowerCase();
		if (!q) return rest;
		return rest.filter((skill) => `${skill.displayName ?? ""} ${skill.name} ${skill.description}`.toLowerCase().includes(q));
	}, [library, enabledNames, query]);

	const okCount = (enabled ?? []).filter((skill) => skill.status === "ok").length;
	const loaded = library !== null && enabled !== null;

	return (
		<div className="room-skills-section">
			<PaneHeader
				title="Skills"
				line={<>
					{okCount > 0 ? `${okCount} enabled, ~${okCount * 100} tokens per turn.` : "Abilities this room can use in its turns."}
					<RsInfo text="Each enabled skill adds a ~100-token index entry to every turn of this room. Enabling or disabling takes effect right away, from the room's next reply on; a changed or removed skill stops being injected immediately. A skill's full instructions load only when the room reads it and are never memorized." />
				</>}
				actions={loaded && library.length > enabledNames.size && !pickerOpen
					? <button className="rs-btn" onClick={() => { setPickerOpen(true); setQuery(""); }}>Enable skills…</button>
					: loaded && library.length === 0 && enabled.length === 0 && onOpenSkillsLibrary
						? <button className="rs-btn" type="button" onClick={onOpenSkillsLibrary}>Open skills</button>
						: null}
			/>
			{error && library === null && <div className="checkpoint-proposal-error">{error}</div>}
			{!loaded && error === null && <p className="ai-setup-copy">Loading skills…</p>}
			{loaded && library.length === 0 && enabled.length === 0 && (
				<p className="settings-empty">No skills in your library yet. Add them in Settings, Skills (the gear at the bottom of the sidebar). Every skill passes a review before it can be enabled here.</p>
			)}
			{loaded && (library.length > 0 || enabled.length > 0) && (
				<>
					{error && <div className="checkpoint-proposal-error">{error}</div>}
					{reviewing && (
						<div className="room-skills-review">
							<div className="room-skills-review-head">
								<strong>Review “{reviewing.displayName || reviewing.name}” before re-enabling</strong>
								<button className="icon-btn" onClick={() => setReviewing(null)} aria-label="Close review">Close</button>
							</div>
							<p className="room-skills-warn">This is the skill's current content, which changed since you first enabled it. Read it, then re-enable only if you trust the change.</p>
							{reviewing.scanFindings && reviewing.scanFindings.length > 0 && (
								<div className="checkpoint-proposal-error">
									{reviewing.scanFindings.length} hidden/invisible character(s) found in this skill. Inspect carefully before adopting.
								</div>
							)}
							<div className="room-skills-review-body">
								<MarkdownRenderer>{reviewing.body}</MarkdownRenderer>
							</div>
							<div className="room-skills-row-actions">
								<button className="rs-btn" disabled={busyName === reviewing.name} onClick={() => void toggle(reviewing.name, "enable")}>
									{busyName === reviewing.name ? "Re-enabling…" : "I reviewed the change: re-enable"}
								</button>
								<button className="rs-btn" onClick={() => setReviewing(null)}>Cancel</button>
							</div>
						</div>
					)}
					{enabled.length === 0 && library.length > 0 && (
						<p className="ai-setup-copy room-skills-empty">No skills enabled for this room yet.</p>
					)}
					<div className="settings-rows room-skill-list">
						{enabled.map((state) => {
							const entry = libraryByName.get(state.name);
							const name = entry?.displayName || state.name;
							// The files line only exists for a skill that can be approved at
							// all and actually carries files.
							const bundledFiles = state.bundledFiles ?? [];
							const showExecution = Boolean(state.executable) && bundledFiles.length > 0;
							const problem = skillProblemLine(state);
							return (
								<div key={state.name} className="room-skill">
									<div className="settings-row room-skill-row">
										<div className="settings-row-main">
											<span className="settings-row-label">{name}</span>
											{entry?.description && <span className="settings-row-sub settings-row-clamp" title={entry.description}>{entry.description}</span>}
											{problem && <span className="settings-row-sub room-skill-problem">{problem}</span>}
										</div>
										<div className="room-skill-actions">
											{state.status === "hash-mismatch" && (
												<button className="rs-btn" disabled={reviewLoadingName === state.name} onClick={() => void openReview(state.name)}>
													{reviewLoadingName === state.name ? "Loading…" : "Review changes"}
												</button>
											)}
											<button className="rs-btn" disabled={busyName === state.name} title="Disable for this room; the skill stays in your library" onClick={() => void toggle(state.name, "disable")}>
												{busyName === state.name ? "Removing…" : "Remove"}
											</button>
										</div>
									</div>
									{showExecution && (
										<>
											<div className="settings-row room-skill-files-row">
												<div className="settings-row-main">
													<span className="room-skill-files-label">Run its files</span>
													<span className={`settings-row-sub${state.executeState === "drifted" ? " room-skill-problem" : ""}`}>
														{runFilesLine(state.executeState, bundledFiles.length)}{" "}
														<button
															type="button"
															className="rs-text-btn"
															aria-expanded={filesShown.has(state.name)}
															onClick={() => toggleFilesShown(state.name)}
														>
															{filesShown.has(state.name) ? "Hide files" : "Show files"}
														</button>
													</span>
												</div>
												<input
													className="workspaces-tool-switch"
													type="checkbox"
													role="switch"
													checked={state.executeState === "approved"}
													disabled={execBusyName === state.name}
													onChange={(e) => void setExecution(state.name, e.target.checked ? "approve-execution" : "revoke-execution")}
													aria-label={`Let ${name} run its files in this room`}
												/>
											</div>
											{filesShown.has(state.name) && <FileGroupList groups={groupFilesByFolder(bundledFiles)} className="room-skill-files" />}
										</>
									)}
								</div>
							);
						})}
					</div>
					{pickerOpen && (
						<div className="room-skills-picker">
							<div className="room-skills-picker-head">
								<input
									type="text"
									className="room-skills-picker-search"
									placeholder="Search your library…"
									value={query}
									autoFocus
									onChange={(e) => setQuery(e.target.value)}
								/>
								<button className="icon-btn" aria-label="Close skill picker" onClick={() => setPickerOpen(false)}>✕</button>
							</div>
							<div className="room-skills-picker-list">
								{available.length === 0 && <p className="ai-setup-copy">{query.trim() ? "No skills match." : "Everything in your library is already enabled."}</p>}
								{available.map((skill) => (
									<div key={skill.name} className="room-skills-row">
										<div className="room-skills-row-main">
											<span className="room-skills-name">{skill.displayName || skill.name}</span>
											{skill.description && <span className="room-skills-desc">{skill.description}</span>}
										</div>
										<div className="room-skills-row-actions">
											<button className="rs-btn" disabled={busyName === skill.name} title="Let this room use this skill" onClick={() => void toggle(skill.name, "enable")}>
												{busyName === skill.name ? "Enabling…" : "Enable"}
											</button>
										</div>
									</div>
								))}
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}
