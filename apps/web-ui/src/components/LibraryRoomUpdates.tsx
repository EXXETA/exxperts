import { useEffect, useState } from "react";
import { applyLibraryRoomsReview, fetchLibraryRoomsReview, previewInstalledReference, previewLibraryMaterial, type LibraryRoomsReview } from "../skills-repo-api";
import { SkillInstructions } from "./skill-instructions";
import { SkillReferences } from "./SkillReferences";
import { useEscapeKey } from "./use-escape-key";
import { RsInfo } from "./rs-info";
import { SkillFileButton } from "./SkillFileButton";

function changeSummary(changes: LibraryRoomsReview["rooms"][number]["changes"]): string {
	const parts: string[] = [];
	for (const status of ["changed", "added", "removed"] as const) {
		const count = changes.skills.filter((skill) => skill.status === status).length;
		if (count) parts.push(status === "added" ? `${count} new ${count === 1 ? "skill stays" : "skills stay"} off` : `${count} ${count === 1 ? "skill" : "skills"} ${status === "removed" ? "removed" : "updated"}`);
	}
	for (const status of ["added", "changed", "removed", "review"] as const) {
		const count = changes.references.filter((file) => file.status === status).length;
		if (count) parts.push(`${count} ${count === 1 ? "reference" : "references"} ${status === "review" ? "to review" : status}`);
	}
	if (changes.referenceVersionChanged) parts.push("Reference version updated");
	return parts.join(" · ");
}

/** One local review, followed by one explicit confirmation for existing room assignments. */
export function LibraryRoomUpdates({ libraryId, onBack, active = true }: { libraryId: string; onBack: () => void; active?: boolean }) {
	const [review, setReview] = useState<LibraryRoomsReview | null>(null);
	const [selected, setSelected] = useState(new Set<string>());
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [expandedRooms, setExpandedRooms] = useState(new Set<string>());
	const [expandedSkills, setExpandedSkills] = useState(new Set<string>());
	useEscapeKey(() => { if (!busy) onBack(); }, active);
	useEffect(() => {
		let cancelled = false;
		setBusy(true); setError(null);
		void fetchLibraryRoomsReview(libraryId).then((value) => { if (!cancelled) { setReview(value); setSelected(new Set(value.rooms.filter((room) => !room.busy).map((room) => room.id))); } }).catch((value) => { if (!cancelled) setError(value instanceof Error ? value.message : String(value)); }).finally(() => { if (!cancelled) setBusy(false); });
		return () => { cancelled = true; };
	}, [libraryId, attempt]);
	async function apply() {
		if (!review) return;
		setBusy(true); setError(null);
		try {
			const result = await applyLibraryRoomsReview(libraryId, review.reviewSha256, [...selected]);
			setNotice(`${result.updated.length} ${result.updated.length === 1 ? "room" : "rooms"} updated.`);
			if (result.failures.length) setError(result.failures.map((room) => `${room.name}: ${room.error}`).join(" "));
			const next = await fetchLibraryRoomsReview(libraryId);
			setReview(next); setSelected(new Set(result.failures.map((room) => room.id)));
		} catch (value) { setError(value instanceof Error ? value.message : String(value)); }
		finally { setBusy(false); }
	}
	return <section className="library-room-updates" aria-label="Review room updates">
		<button className="skill-detail-back" disabled={busy} onClick={onBack}>← Back to library</button>
		<h3>Update rooms{review ? ` · ${review.name}` : ""}</h3>
		{busy && <p className="cli-note" role="status">{review ? "Updating rooms…" : "Reading saved contents…"}</p>}
		{notice && <p role="status">{notice}</p>}
		{error && <p className="checkpoint-proposal-error" role="alert">{error} <button className="rs-text-btn" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>Refresh review</button></p>}
		{review && <>
			<p className="cli-note">{review.rooms.length} {review.rooms.length === 1 ? "room" : "rooms"} · {review.rooms.reduce((total, room) => total + room.changes.total, 0)} changes <RsInfo text="Changes compare each room's confirmed version with the saved library. Exceptions and independent assignments are preserved. New skills stay off. Expand a room to inspect its changed objects. Instruction history is stored as hashes, so previews show current instructions; saved references can show both versions. Working rooms must finish first." /></p>
			{review.rooms.length ? <div className="room-update-list" aria-label="Rooms to update">{review.rooms.map((room) => <div className="room-update-row" key={room.id}>
				<details className="room-update-details" open={expandedRooms.has(room.id)} onToggle={(event) => { if (event.target !== event.currentTarget) return; const open = event.currentTarget.open; setExpandedRooms((previous) => { if (previous.has(room.id) === open) return previous; const next = new Set(previous); if (open) next.add(room.id); else next.delete(room.id); return next; }); }}><summary><strong>{room.name}</strong><span className="room-update-count">{room.changes.total} {room.changes.total === 1 ? "change" : "changes"}</span><span className="settings-row-sub">{changeSummary(room.changes)}</span>{room.busy && <span className="room-skill-problem">Working · retry after this turn</span>}</summary>
					{expandedRooms.has(room.id) && <div className="room-update-objects">
						{room.changes.skills.length > 0 && <><h4>Skills</h4>{room.changes.skills.map((change) => {
							const skill = review.skills.find((entry) => entry.name === change.name);
							const label = change.status === "removed" ? "Assignment removed" : change.status === "added" ? "New · stays off" : `${change.instructionsChanged ? "Instructions changed" : "References or package changed"}${change.enabled ? "" : " · stays off"}`;
							if (!skill) return <div className="room-update-skill" key={change.name}><span>{change.name}</span><span className="settings-row-sub">{label}</span></div>;
							const key = `${room.id}:${change.name}`;
							return <details className="room-update-skill" key={change.name} open={expandedSkills.has(key)} onToggle={(event) => { if (event.target !== event.currentTarget) return; const open = event.currentTarget.open; setExpandedSkills((previous) => { if (previous.has(key) === open) return previous; const next = new Set(previous); if (open) next.add(key); else next.delete(key); return next; }); }}><summary><span>{skill.displayName || change.name}</span><span className="settings-row-sub">{label}</span></summary>{expandedSkills.has(key) && <>{skill.scanFindings?.length > 0 && <p className="room-skills-warn">Hidden characters found. Inspect before adopting.</p>}<p className="cli-note">Current instructions</p><SkillInstructions body={skill.body} />{skill.provenance?.repo && <SkillReferences references={skill.provenance.repo.references} stored onPreview={(reference) => previewInstalledReference(skill.name, reference)} />}</>}</details>;
						})}</>}
						{room.changes.previousReferencesUnavailable && <p className="room-skills-warn">The previous reference index is unavailable. Review the current selection before confirming.</p>}
						{room.changes.references.length > 0 && <><h4>References</h4>{room.changes.references.map((change) => <div className="room-update-reference" key={JSON.stringify([change.path, change.beforeVersion, change.afterVersion])}><span className="room-update-kind">{change.status === "review" ? "Review" : change.status === "added" ? "Added" : change.status === "removed" ? "Removed" : "Changed"}</span><SkillFileButton path={change.path} load={(path) => previewLibraryMaterial(libraryId, (change.afterVersion ?? change.beforeVersion)!, path)} />{change.beforeVersion && change.afterVersion && <SkillFileButton path={change.path} label="Previous version" load={(path) => previewLibraryMaterial(libraryId, change.beforeVersion!, path)} />}</div>)}</>}
						{room.changes.referenceVersionChanged && <p className="settings-row-sub">Reference version updated; file contents are unchanged.</p>}
					</div>}
				</details>
				<input className="room-update-select" type="checkbox" aria-label={`Update ${room.name}`} disabled={busy || room.busy} checked={selected.has(room.id)} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(room.id); else next.delete(room.id); return next; })} />
			</div>)}</div> : <p className="settings-empty">Assigned rooms are up to date.</p>}
			<div className="skill-review-actions"><button className="rs-btn" disabled={busy} onClick={onBack}>Back</button>{review.rooms.length > 0 && <button className="rs-btn rs-btn-primary" disabled={busy || !selected.size} onClick={() => void apply()}>I reviewed this: update {selected.size} {selected.size === 1 ? "room" : "rooms"}</button>}</div>
		</>}
	</section>;
}
