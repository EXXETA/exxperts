import { useEffect, useMemo, useState } from "react";
import type { PersistentAgentStatus } from "../types";
import { fetchPersistentRoomSkillSettings, updatePersistentRoomSkillSetting, type PersistentRoomEnabledSkillStatus } from "../persistent-room-management-api";
import { fetchSkill, fetchSkills, type SkillDetail, type SkillListItem } from "../skills-api";
import { MarkdownRenderer } from "./Markdown";

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
export function RoomSkillsSection({ status }: { status: PersistentAgentStatus }) {
	const [library, setLibrary] = useState<SkillListItem[] | null>(null);
	const [enabled, setEnabled] = useState<PersistentRoomEnabledSkillStatus[] | null>(null);
	const [busyName, setBusyName] = useState<string | null>(null);
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
			const response = await updatePersistentRoomSkillSetting(status.id, action, name);
			setEnabled(response.skills);
			if (action === "enable") setReviewing(null);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusyName(null);
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

	if (error && library === null) return <div className="checkpoint-proposal-error">{error}</div>;
	if (library === null || enabled === null) return <p className="ai-setup-copy">Loading skills…</p>;

	const okCount = enabled.filter((skill) => skill.status === "ok").length;

	return (
		<div className="room-skills-section">
			{library.length === 0 && enabled.length === 0 && (
				<p className="ai-setup-copy">No skills in your library yet. Add them under Skills in the sidebar. Every skill passes a review before it can be enabled here.</p>
			)}
			{(library.length > 0 || enabled.length > 0) && (
				<>
					<p className="ai-setup-copy">
						Enabled skills add a ~100-token index entry to every turn of this room
						{okCount > 0 ? <> (currently {okCount} enabled ≈ ~{okCount * 100} tokens)</> : null}. Bodies load on demand and are never memorized.
					</p>
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
								<button className="landing-action" disabled={busyName === reviewing.name} onClick={() => void toggle(reviewing.name, "enable")}>
									{busyName === reviewing.name ? "Re-enabling…" : "I reviewed the change: re-enable"}
								</button>
								<button className="landing-action secondary" onClick={() => setReviewing(null)}>Cancel</button>
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
							return (
								<div key={state.name} className="room-skills-row">
									<div className="room-skills-row-main">
										<span className="room-skills-name">{entry?.displayName || state.name}</span>
										{entry?.description && <span className="room-skills-desc">{entry.description}</span>}
										{state.status === "hash-mismatch" && (
											<span className="room-skills-warn">Changed since you enabled it. It stopped injecting. Review the new version before re-enabling.</span>
										)}
										{state.status === "missing" && (
											<span className="room-skills-warn">Removed from the library. No longer injected. Remove to clear, or re-import and re-enable.</span>
										)}
									</div>
									<div className="room-skills-row-actions">
										{state.status === "hash-mismatch" && (
											<button className="landing-action secondary" disabled={reviewLoadingName === state.name} onClick={() => void openReview(state.name)}>
												{reviewLoadingName === state.name ? "Loading…" : "Review changes"}
											</button>
										)}
										<button className="landing-action secondary" disabled={busyName === state.name} onClick={() => void toggle(state.name, "disable")}>
											{busyName === state.name ? "Removing…" : "Remove"}
										</button>
										{isOk && <span className="room-skills-live">active</span>}
									</div>
								</div>
							);
						})}
					</div>
					{library.length > enabledNames.size && !pickerOpen && (
						<button className="landing-action secondary room-skills-add" onClick={() => { setPickerOpen(true); setQuery(""); }}>
							Enable skills…
						</button>
					)}
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
											<button className="landing-action secondary" disabled={busyName === skill.name} onClick={() => void toggle(skill.name, "enable")}>
												{busyName === skill.name ? "Enabling…" : "Enable"}
											</button>
										</div>
									</div>
								))}
							</div>
						</div>
					)}
					<p className="cli-note">Enabling or disabling a skill takes effect the next time you open this room; a changed or removed skill stops being injected immediately.</p>
				</>
			)}
		</div>
	);
}
