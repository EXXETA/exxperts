import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { deleteSkill, type SkillDetail, type SkillFile, type SkillUpdateChanges, type SkillUpdateConfirm } from "../skills-api";
import { confirmDialog } from "./confirm-dialog";
import { listsFileKinds, SkillFilesByKind } from "./file-groups";
import { GroupHeader, PaneBack, PaneHeader } from "./pane-header";
import { SkillByHandTag, SkillFilesAt, SkillFilesRow, SkillSourceRows, SkillWarnings, useScriptsLine } from "./skill-facts";
import { SkillInstructions } from "./skill-instructions";
import { SKILL_FILES_HEADING, SKILL_PAGE_BACK, SKILL_PAGE_BACK_NAME } from "../skill-source-copy";
import { useSettingsLookNext } from "../settings-look";
import { AUTO_UPDATE_LABEL, AUTO_UPDATE_LINE, AUTO_UPDATE_SAVE_FAILED_LINE, joinWithAnd, protectedSkillDeleteLine, SKILL_AUTO_SKIPPED_LINES, SKILL_INSTRUCTIONS_ONLY_LINES, SKILL_UNREADABLE_PAGE_LINE, skillNameTakenByOtherLine, SKILL_UPDATE_CHANGE_GROUPS, SKILL_UPDATE_HEADING, SKILL_UPDATE_NEW_DESCRIPTION, SKILL_UPDATE_NEW_INSTRUCTIONS, SKILL_UPDATE_ROOMS_LINE, SKILL_UPDATE_SCRIPTS_LINE, SKILL_UPDATE_STATE_LINES, skillRenamedLine, skillUpdatedHeading, skillPageCheckFailedLine, skillUpdateVersionsLine, type SkillUpdateFailure, UPDATE_SKILL, UPDATE_SKILL_ANYWAY } from "../skill-source-copy";

/** A date as the library shows it ("Aug 15, 2026"), or "" when unreadable. */
export function formatSkillDate(iso: string): string {
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return "";
	return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Whose library the Skills page shows: the person's own; a shared server's,
 *  which its admin changes for every room in the company; or one this person
 *  only reads (a remote device, or a shared server's member). */
export type SkillLibraryView = "own" | "company" | "read-only";

/** The line after a skill joins the library. */
export function skillAddedNotice(view: SkillLibraryView, name: string): string {
	return view === "company" ? `Added “${name}” to your company's library.` : `Added “${name}” to your library.`;
}

/** The line after Replace has swapped a skill in the library. */
export function skillReplacedNotice(view: SkillLibraryView, name: string): string {
	return view === "company" ? `Replaced “${name}” in your company's library.` : `Replaced “${name}” in your library.`;
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

/** The files an update adds, removes and changes, a row each, by path. */
function SkillUpdateChangeRows({ changes }: { changes: SkillUpdateChanges }) {
	const groups = (["added", "removed", "changed"] as const).filter((group) => changes[group].length > 0);
	return (
		<>
			{groups.map((group) => (
				<div key={group} className="settings-row skill-update-change">
					<span className="settings-row-label">{SKILL_UPDATE_CHANGE_GROUPS[group]}</span>
					<span className="settings-row-value skill-fact-value">{changes[group].map((file: SkillFile) => file.path).join(", ")}</span>
				</div>
			))}
		</>
	);
}

/**
 * A skill's updates on its page: another version and what it changes, with
 * Update (the hidden-character stop shows the add's own warning, and the button
 * then says so); what the last update changed; or why the skill doesn't update.
 * Without onUpdate (a phone, a shared server) the facts stay and the button goes.
 */
function SkillUpdateGroup({ skill, onUpdate, updating, updateLine }: { skill: SkillDetail; onUpdate?: (confirm: SkillUpdateConfirm) => void; updating: boolean; updateLine: string | null }) {
	const update = skill.update;
	if (!update) return null;
	const failedLine = (failure: SkillUpdateFailure) => skillPageCheckFailedLine(failure, skill.displayName || skill.name);
	// The last check couldn't ask its repository: said only where the person can check again.
	const missedLine = onUpdate && update.missed ? failedLine(update.missed) : null;
	const candidate = update.state === "available" ? update.candidate : undefined;
	if (candidate) {
		const versions = skillUpdateVersionsLine(candidate.versions.from, candidate.versions.to);
		const scripts = [...candidate.changes.added, ...candidate.changes.removed, ...candidate.changes.changed].some((file) => file.kind === "scripts");
		return (
			<div className="settings-group skill-update-group" aria-label={SKILL_UPDATE_HEADING}>
				<GroupHeader kicker={SKILL_UPDATE_HEADING} line={scripts ? SKILL_UPDATE_SCRIPTS_LINE : SKILL_UPDATE_ROOMS_LINE} />
				{/* Update automatically left it for the person: why, where they can act on it, by the stop this version still has. */}
				{onUpdate && update.autoSkipped && (candidate.changedHere || candidate.hiddenCharacters) && <p className="group-head-line skill-update-skipped">{candidate.changedHere ? SKILL_AUTO_SKIPPED_LINES.changedHere : SKILL_AUTO_SKIPPED_LINES.hiddenCharacters}</p>}
				{missedLine && !updateLine && <p className="group-head-line skill-update-missed">{missedLine}</p>}
				<SkillWarnings findings={candidate.scanFindings} before="updating" />
				<div className="settings-rows">
					{versions && (
						<div className="settings-row">
							<span className="settings-row-label">Version</span>
							<span className="settings-row-value skill-fact-value">{versions}</span>
						</div>
					)}
					<SkillUpdateChangeRows changes={candidate.changes} />
				</div>
				{/* The description shows only when it changes: unchanged words labelled new would mislead. */}
				{candidate.description !== undefined && candidate.description !== skill.description && (
					<>
						<div className="skill-review-body-label">{SKILL_UPDATE_NEW_DESCRIPTION}</div>
						<p className="skill-review-desc">{candidate.description}</p>
					</>
				)}
				{candidate.body !== undefined && (
					<>
						<div className="skill-review-body-label">{SKILL_UPDATE_NEW_INSTRUCTIONS}</div>
						<SkillInstructions body={candidate.body} />
					</>
				)}
				{updateLine && <div className="checkpoint-proposal-error">{updateLine}</div>}
				{onUpdate && (
					<div className="settings-form-foot">
						<button type="button" className={`rs-btn ${candidate.hiddenCharacters ? "rs-btn-danger" : "rs-btn-primary"}`} disabled={updating} aria-busy={updating} onClick={() => onUpdate(candidate.hiddenCharacters ? { hiddenCharacters: true } : {})}>
							{updating ? "Updating…" : candidate.hiddenCharacters ? UPDATE_SKILL_ANYWAY : UPDATE_SKILL}
						</button>
					</div>
				)}
			</div>
		);
	}
	// "Add it again" and "up to date" speak of what only the computer itself can do or ask: elsewhere the facts alone stay.
	const computerOnly = update.state === "untracked" || update.state === "current" || update.state === "unreachable";
	// A missed check takes the place of "up to date"; a skill that left its repository or was renamed there keeps its own line, with the missed one after it.
	const replaces = missedLine !== null && computerOnly;
	const line = computerOnly && !onUpdate ? null : replaces ? missedLine : update.state === "unreachable" && update.failure ? failedLine(update.failure) : update.state === "available" || update.state === "unreachable" ? null : update.state === "renamed" && update.renamedTo ? skillRenamedLine(update.renamedTo, onUpdate !== undefined) : SKILL_UPDATE_STATE_LINES[update.state];
	const updated = update.updated;
	if (!line && !updated) return null;
	return (
		<div className="settings-group skill-update-group">
			{updated ? <GroupHeader kicker={skillUpdatedHeading(formatSkillDate(updated.at), updated.automatic === true)} line={line ?? undefined} /> : <p className="group-head-line skill-update-state">{line}</p>}
			{missedLine && !replaces && <p className="group-head-line skill-update-missed">{missedLine}</p>}
			{updated && (
				<div className="settings-rows">
					{skillUpdateVersionsLine(updated.versions.from, updated.versions.to) && (
						<div className="settings-row">
							<span className="settings-row-label">Version</span>
							<span className="settings-row-value skill-fact-value">{skillUpdateVersionsLine(updated.versions.from, updated.versions.to)}</span>
						</div>
					)}
					<SkillUpdateChangeRows changes={updated.changes} />
				</div>
			)}
			{updateLine && <div className="checkpoint-proposal-error">{updateLine}</div>}
		</div>
	);
}

/**
 * A skill's Update automatically switch, saved on its click, as a room's skill
 * switch is. While it saves it shows the new place; a save that fails shows the
 * place the skill has and says so. The keyboard comes back to it after the save.
 */
function AutoUpdateSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => Promise<void> }) {
	const [saving, setSaving] = useState<boolean | null>(null);
	// The place a save that failed wanted: its line stays while the switch isn't there.
	const [failed, setFailed] = useState<boolean | null>(null);
	const [refocus, setRefocus] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!refocus || saving !== null) return;
		inputRef.current?.focus();
		setRefocus(false);
	}, [refocus, saving]);
	async function flip(next: boolean) {
		const hadFocus = document.activeElement === inputRef.current;
		setSaving(next);
		setFailed(null);
		try {
			await onChange(next);
		} catch {
			setFailed(next);
		} finally {
			setSaving(null);
			if (hadFocus) setRefocus(true);
		}
	}
	return (
		<div className="settings-group skill-auto-update">
			<div className="settings-rows">
				<label className={`settings-row${saving !== null ? " pending" : ""}`}>
					<div className="settings-row-main">
						<span className="settings-row-label">{AUTO_UPDATE_LABEL}</span>
						<span className="settings-row-sub">{AUTO_UPDATE_LINE}</span>
						{failed !== null && failed !== on && saving === null && <span className="settings-row-sub room-skill-problem" role="alert">{AUTO_UPDATE_SAVE_FAILED_LINE}</span>}
					</div>
					<input ref={inputRef} className="workspaces-tool-switch" type="checkbox" role="switch" checked={saving ?? on} disabled={saving !== null} onChange={(e) => void flip(e.target.checked)} aria-label={AUTO_UPDATE_LABEL} />
				</label>
			</div>
		</div>
	);
}

/**
 * A library skill's page in Settings, Skills: its facts as rows, its
 * instructions folded at the pane's scale, and Delete as the last row, asked
 * through the app's dialog. A skill exxperts does not own shows the same row
 * with Delete disabled and where to remove it; a library read only shows no
 * row. A company's library leaves out "Used in": the rooms a skill lists are
 * the asker's own, so for the admin they would leave out every member's.
 * In the new settings look (settings-look.ts) the files by kind are a section
 * of their own, after the facts, and Delete is the soft red button. A skill no
 * room can use says why where its description would be; one from the folder
 * shared with other tools says in its Files row why rooms can't open its files,
 * or where they are when its link leads outside ~/.agents.
 */
export function SkillDetailPage({ skill, onBack, onDeleted, view, onUpdate, updating = false, updateLine = null, onAutoUpdate }: { skill: SkillDetail; onBack: () => void; onDeleted: (notice: string) => void; view: SkillLibraryView; onUpdate?: (confirm: SkillUpdateConfirm) => void; updating?: boolean; updateLine?: string | null; /** Saves its Update automatically: only on the computer itself. */ onAutoUpdate?: (on: boolean) => Promise<void> }) {
	const name = skill.displayName || skill.name;
	const files = skill.files ?? [];
	const scriptsLine = useScriptsLine(files, skill.scriptsReadOnly === true);
	const license = skill.license?.trim() ?? "";
	const added = skill.provenance ? formatSkillDate(skill.provenance.importedAt) : "";
	const roomNames = skill.rooms.map((room) => room.name);
	// A skill exxperts does not own keeps the same last row with the button
	// disabled and a line that says where it can be removed instead.
	const deleteLine = skill.protected
		? protectedSkillDeleteLine(skill.source)
		: view === "company" ? "Removes it from your company's library. Rooms that use it stop using it." : "Removes it from your library. Rooms that use it stop using it.";
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const lookNext = useSettingsLookNext();

	async function remove() {
		const ok = await confirmDialog({
			...(view === "company"
				? { title: `Remove “${name}” for everyone?`, body: "Every room in your company that uses it stops using it.", confirmLabel: "Remove" }
				: { title: `Delete ${name}?`, body: roomNames.length > 0 ? `It leaves your library. ${joinWithAnd(roomNames)} ${roomNames.length === 1 ? "stops" : "stop"} using it.` : "It leaves your library.", confirmLabel: "Delete" }),
			danger: true,
		});
		if (!ok) return;
		setDeleting(true);
		setError(null);
		try {
			await deleteSkill(skill.name);
			onDeleted(view === "company" ? `Removed “${name}” from your company's library.` : `Removed “${name}”.`);
		} catch (e) {
			setError((e as Error).message);
			setDeleting(false);
		}
	}

	return (
		<div className="skill-detail">
			{!lookNext && <button type="button" className="skill-detail-back" onClick={onBack}>{SKILL_PAGE_BACK}</button>}
			<PaneHeader back={<PaneBack aria-label={SKILL_PAGE_BACK_NAME} onClick={onBack} />} title={<>{name}{skill.disableModelInvocation && <SkillByHandTag />}</>} line={skill.unreadable || skill.nameTaken ? <span className="skill-detail-problem">{skill.unreadable ? SKILL_UNREADABLE_PAGE_LINE : skillNameTakenByOtherLine(skill.nameTaken!)}</span> : skill.description ? <ClampedDescription text={skill.description} /> : undefined} />

			<SkillWarnings findings={skill.scanFindings ?? []} />

			{/* What its repository offers, or why it doesn't update, comes before the facts: it is what the person came for. */}
			<SkillUpdateGroup skill={skill} onUpdate={onUpdate} updating={updating} updateLine={updateLine} />

			{/* Only a skill that follows a branch or a tag of its repository can update by itself. */}
			{onAutoUpdate && skill.repository && skill.repository.refKind !== "commit" && <AutoUpdateSwitch on={skill.repository.autoUpdate} onChange={onAutoUpdate} />}

			<div className="settings-group">
				<div className="settings-rows">
					<SkillSourceRows source={skill.provenance?.source} tier={skill.source} license={license} version={skill.version} repository={skill.repository} />
					{added && (
						<div className="settings-row">
							<span className="settings-row-label">Added</span>
							<span className="settings-row-value skill-fact-value">{added}</span>
						</div>
					)}
					{/* A skill no room can use counts no room: its line above says so. */}
					{view !== "company" && !skill.unreadable && !skill.nameTaken && (
						<div className="settings-row">
							<span className="settings-row-label">Used in</span>
							<span className="settings-row-value skill-fact-value">{roomNames.length > 0 ? joinWithAnd(roomNames) : "No room yet"}</span>
						</div>
					)}
					{files.length > 0 && <SkillFilesRow count={files.length} line={skill.filesAt ? <SkillFilesAt place={skill.filesAt} /> : undefined} />}
					{skill.instructionsOnly && <SkillFilesRow line={SKILL_INSTRUCTIONS_ONLY_LINES[skill.instructionsOnly]} />}
				</div>
				{!lookNext && <SkillFilesByKind files={files} scriptsLine={scriptsLine} />}
			</div>

			{lookNext && listsFileKinds(files) && (
				<div className="settings-group skill-detail-files">
					<GroupHeader kicker={SKILL_FILES_HEADING} />
					<SkillFilesByKind files={files} scriptsLine={scriptsLine} />
				</div>
			)}

			{!skill.unreadable && (
				<div className="settings-group">
					<GroupHeader kicker="Instructions" line="What the room reads when it uses this skill." />
					<SkillInstructions body={skill.body} foldable />
				</div>
			)}

			{view !== "read-only" && deleteLine && (
				<div className="settings-group">
					{error && <div className={lookNext ? "checkpoint-proposal-error skill-message skill-message-failed" : "checkpoint-proposal-error"}>{error}</div>}
					<div className="settings-rows">
						<div className="settings-row">
							<div className="settings-row-main">
								<span className="settings-row-label">Delete skill</span>
								<span className="settings-row-sub">{deleteLine}</span>
							</div>
							<button type="button" className={lookNext ? "rs-btn rs-btn-danger rs-btn-danger-soft" : "rs-btn rs-btn-danger"} disabled={deleting || skill.protected} onClick={() => void remove()}>
								{deleting ? "Deleting…" : "Delete"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
