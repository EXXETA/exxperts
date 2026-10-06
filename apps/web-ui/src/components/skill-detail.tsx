import { useLayoutEffect, useRef, useState } from "react";
import { deleteSkill, type SkillDetail } from "../skills-api";
import { confirmDialog } from "./confirm-dialog";
import { FileGroupList, groupFilesByFolder } from "./file-groups";
import { GroupHeader, PaneHeader } from "./pane-header";
import { SkillSourceRows, SkillWarnings } from "./skill-facts";
import { SkillInstructions } from "./skill-instructions";
import { protectedSkillDeleteLine } from "../skill-source-copy";

/** A date as the library shows it ("Aug 15, 2026"), or "" when unreadable. */
export function formatSkillDate(iso: string): string {
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return "";
	return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Names joined as a sentence says them: "A", "A and B", "A, B and C". */
export function joinWithAnd(names: string[]): string {
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The description under the title, held to three lines with More and Less
 *  when it runs longer. */
function ClampedDescription({ text }: { text: string }) {
	const ref = useRef<HTMLSpanElement | null>(null);
	const [long, setLong] = useState(false);
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		const line = ref.current;
		if (!line || open) return;
		const measure = () => setLong(line.scrollHeight > line.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(line);
		return () => observer.disconnect();
	}, [text, open]);
	return (
		<>
			<span ref={ref} className={`skill-detail-desc${open ? "" : " clamped"}`}>{text}</span>
			{(long || open) && (
				<button type="button" className="rs-text-btn skill-detail-more" aria-expanded={open} onClick={() => setOpen(!open)}>
					{open ? "Less" : "More"}
				</button>
			)}
		</>
	);
}

/**
 * A library skill's page in Settings, Skills: its facts as rows, its
 * instructions folded at the pane's scale, and Delete as the last row, asked
 * through the app's dialog. A skill exxperts does not own shows the same row
 * with Delete disabled and where to remove it; a remote device shows no row.
 */
export function SkillDetailPage({ skill, onBack, onDeleted, readOnly }: { skill: SkillDetail; onBack: () => void; onDeleted: (notice: string) => void; readOnly: boolean }) {
	const name = skill.displayName || skill.name;
	const files = skill.bundledScripts ?? [];
	const license = skill.license?.trim() ?? "";
	const added = skill.provenance ? formatSkillDate(skill.provenance.importedAt) : "";
	const roomNames = skill.rooms.map((room) => room.name);
	// A skill exxperts does not own keeps the same last row with the button
	// disabled and a line that says where it can be removed instead.
	const deleteLine = skill.protected ? protectedSkillDeleteLine(skill.source) : "Removes it from your library. Rooms that use it stop using it.";
	const [filesShown, setFilesShown] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function remove() {
		const ok = await confirmDialog({
			title: `Delete ${name}?`,
			body: roomNames.length > 0 ? `It leaves your library. ${joinWithAnd(roomNames)} ${roomNames.length === 1 ? "stops" : "stop"} using it.` : "It leaves your library.",
			confirmLabel: "Delete",
			danger: true,
		});
		if (!ok) return;
		setDeleting(true);
		setError(null);
		try {
			await deleteSkill(skill.name);
			onDeleted(`Removed “${name}”.`);
		} catch (e) {
			setError((e as Error).message);
			setDeleting(false);
		}
	}

	return (
		<div className="skill-detail">
			<button type="button" className="skill-detail-back" onClick={onBack}>← Skills</button>
			<PaneHeader title={name} line={skill.description ? <ClampedDescription text={skill.description} /> : undefined} />

			<SkillWarnings findings={skill.scanFindings ?? []} />

			<div className="settings-group">
				<div className="settings-rows">
					<SkillSourceRows source={skill.provenance?.source} tier={skill.source} license={license} />
					{added && (
						<div className="settings-row">
							<span className="settings-row-label">Added</span>
							<span className="settings-row-value skill-fact-value">{added}</span>
						</div>
					)}
					<div className="settings-row">
						<span className="settings-row-label">Used in</span>
						<span className="settings-row-value skill-fact-value">{roomNames.length > 0 ? joinWithAnd(roomNames) : "No room yet"}</span>
					</div>
					{files.length > 0 && (
						<div>
							<div className="settings-row">
								<div className="settings-row-main">
									<span className="settings-row-label">Files</span>
									<span className="settings-row-sub">They run only in rooms where you allow them.</span>
								</div>
								<span className="settings-row-value">
									{files.length === 1 ? "1 file" : `${files.length} files`}
									<button type="button" className="rs-text-btn" aria-expanded={filesShown} onClick={() => setFilesShown(!filesShown)}>
										{filesShown ? "Hide" : "Show"}
									</button>
								</span>
							</div>
							{filesShown && <FileGroupList groups={groupFilesByFolder(files)} className="skill-detail-files" />}
						</div>
					)}
				</div>
			</div>

			<div className="settings-group">
				<GroupHeader kicker="Instructions" line="What the room reads when it uses this skill." />
				<SkillInstructions body={skill.body} foldable />
			</div>

			{!readOnly && deleteLine && (
				<div className="settings-group">
					{error && <div className="checkpoint-proposal-error">{error}</div>}
					<div className="settings-rows">
						<div className="settings-row">
							<div className="settings-row-main">
								<span className="settings-row-label">Delete skill</span>
								<span className="settings-row-sub">{deleteLine}</span>
							</div>
							<button type="button" className="rs-btn rs-btn-danger" disabled={deleting || skill.protected} onClick={() => void remove()}>
								{deleting ? "Deleting…" : "Delete"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
