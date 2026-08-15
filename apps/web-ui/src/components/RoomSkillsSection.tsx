import { useEffect, useMemo, useState } from "react";
import type { PersistentAgentStatus } from "../types";
import { fetchPersistentRoomSkillSettings, updatePersistentRoomSkillSetting, type PersistentRoomEnabledSkillStatus } from "../persistent-room-management-api";
import { fetchSkill, fetchSkills, type SkillDetail, type SkillListItem } from "../skills-api";
import { MarkdownRenderer } from "./Markdown";
import { RsInfo } from "./rs-info";

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
			<header className="rs-pane-head">
				<h3>Skills</h3>
				{loaded && library.length > enabledNames.size && !pickerOpen && (
					<div className="rs-pane-actions">
						<button className="rs-btn" onClick={() => { setPickerOpen(true); setQuery(""); }}>Enable skills…</button>
					</div>
				)}
			</header>
			<p className="rs-pane-sub">
				{okCount > 0 ? `${okCount} enabled, ~${okCount * 100} tokens per turn.` : "Abilities this room can use in its turns."}
				<RsInfo text="Each enabled skill adds a ~100-token index entry to every turn of this room. Enabling or disabling takes effect right away, from the room's next reply on; a changed or removed skill stops being injected immediately. A skill's full instructions load only when the room reads it and are never memorized." />
			</p>
			{error && library === null && <div className="checkpoint-proposal-error">{error}</div>}
			{!loaded && error === null && <p className="ai-setup-copy">Loading skills…</p>}
			{loaded && library.length === 0 && enabled.length === 0 && (
				<div className="room-skills-library-empty">
					<p className="ai-setup-copy">No skills in your library yet. Add them under Skills in the sidebar. Every skill passes a review before it can be enabled here.</p>
					{onOpenSkillsLibrary && <button className="rs-btn" type="button" onClick={onOpenSkillsLibrary}>Open skills library</button>}
				</div>
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
								<button className="rs-quiet" onClick={() => setReviewing(null)}>Cancel</button>
							</div>
						</div>
					)}
					{enabled.length === 0 && library.length > 0 && (
						<p className="ai-setup-copy room-skills-empty">No skills enabled for this room yet.</p>
					)}
					<div className="room-skills-rows">
						{enabled.map((state) => {
							const entry = libraryByName.get(state.name);
							const isOk = state.status === "ok";
							// Execution approval only exists for a skill that can be approved
							// at all and actually carries files; everything else renders as before.
							const bundledFiles = state.bundledFiles ?? [];
							const showExecution = Boolean(state.executable) && bundledFiles.length > 0;
							const manualOnly = Boolean(state.manualOnly);
							return (
								<div key={state.name} className="room-skills-row">
									<div className="room-skills-row-main">
										<span className="room-skills-name-row">
											<span className="room-skills-name">{entry?.displayName || state.name}</span>
											{isOk && <span className="room-skills-live">active</span>}
										</span>
										{entry?.description && <span className="room-skills-desc" title={entry.description}>{entry.description}</span>}
										{state.status === "hash-mismatch" && (
											<span className="room-skills-warn">Changed since you enabled it. It stopped injecting until you review the new version.</span>
										)}
										{state.status === "missing" && (
											<span className="room-skills-warn">Removed from the library. No longer injected. Remove to clear, or re-import and re-enable.</span>
										)}
										{manualOnly && (
											<span className="room-skills-warn">The author marked this skill for manual use only, so the room never runs it on its own. Rooms cannot trigger it manually yet, so it stays inactive here for now.</span>
										)}
										{showExecution && (
											<div className="room-skills-exec">
												{state.executeState === "approved" && (
													<span className="room-skills-exec-title">This exact version may run its files in this room.</span>
												)}
												{state.executeState === "drifted" && (
													<span className="room-skills-warn">The skill's files changed since you approved them. It will not run until you approve this version.</span>
												)}
												{state.executeState !== "approved" && state.executeState !== "drifted" && (
													<span className="room-skills-exec-title">Asks to run its bundled files in this room.</span>
												)}
												<ul className="room-skills-files">
													{bundledFiles.map((file) => (
														<li key={file}>{file}</li>
													))}
												</ul>
											</div>
										)}
									</div>
									<div className="room-skills-row-actions">
										{showExecution && (
											state.executeState === "approved" ? (
												<button className="rs-quiet" disabled={execBusyName === state.name} onClick={() => void setExecution(state.name, "revoke-execution")}>
													{execBusyName === state.name ? "Withdrawing…" : "Withdraw"}
												</button>
											) : (
												<button className="rs-btn" disabled={execBusyName === state.name} onClick={() => void setExecution(state.name, "approve-execution")}>
													{execBusyName === state.name ? "Approving…" : state.executeState === "drifted" ? "Approve this version" : "Allow running this skill's files"}
												</button>
											)
										)}
										{state.status === "hash-mismatch" && (
											<button className="rs-btn" disabled={reviewLoadingName === state.name} onClick={() => void openReview(state.name)}>
												{reviewLoadingName === state.name ? "Loading…" : "Review changes"}
											</button>
										)}
										<button className="rs-quiet" disabled={busyName === state.name} title="Disable for this room — the skill stays in your library" onClick={() => void toggle(state.name, "disable")}>
											{busyName === state.name ? "Removing…" : "Remove"}
										</button>
									</div>
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
