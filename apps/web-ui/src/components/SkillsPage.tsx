import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PaneBack, PaneHeader } from "./pane-header";
import { apiErrorCode, isServiceUnreachableLine } from "../api";
import {
	acceptSkillCandidate,
	checkSkillUpdates,
	closeSkillUpdateNotices,
	createSkill,
	fetchSkill,
	fetchSkills,
	fileToBase64,
	replaceRefusedSinceReview,
	skillRefusalLine,
	setSkillAutoUpdate,
	skillUpdateRefusalLine,
	updateSkill,
	uploadSkillFile,
	type SkillCandidate,
	type SkillDetail,
	type SkillListItem,
	type SkillNoticeShown,
	type SkillUpdateConfirm,
	type SkillUpdatesCheck,
} from "../skills-api";
import { confirmDialog } from "./confirm-dialog";
import { SkillReview } from "./SkillReview";
import { SkillDetailPage, skillAddedNotice, skillReplacedNotice, type SkillLibraryView } from "./skill-detail";
import { ADD_SKILL_WAYS, BROWSE_FEATURED_LINK, CHECK_NOW, CHECKING_NOW, CLOSE_NOTICE, skillsLeftForYouLine, skillsUpdatedAutomaticallyLine, skillUpdateAllLine, type SkillNotUpdated, UPDATE_ALL, SKILL_BY_HAND_TAG, SKILL_DESCRIPTION_LABEL, SKILL_UNREADABLE_LINE, skillNameTakenByOtherLine, SKILL_UPDATE_RECHECKED_LINE, SKILL_UPLOAD_MAX_BYTES, SKILLS_PAGE_LINE, skillChangedHereQuestion, skillTooBigLine, skillUpdatedNotice, skillUpdatesCheckedLine, skillUpdatesFailedLines, skillUpdatesFoundLine, UPDATE_SKILL, WRITE_SKILL_LEAD } from "../skill-source-copy";
import { SkillByHandTag, skillFromText } from "./skill-facts";
import { SHARED_SERVER_ADMIN_LINE, sharedServerNonAdmin, showsComputerOnlyControls, useRemoteClientContext } from "../remote-client-context";
import { SkillImportFromRepo } from "./SkillImportFromRepo";
import { SkillBrowseDirectory } from "./SkillBrowseDirectory";
import { useEscapeKey } from "./use-escape-key";
import { ChevronDownIcon } from "./icons";
import { useSettingsLookNext } from "../settings-look";
import { useQuietSkillCheck } from "../skills-quiet-check";
import { useNeededFields } from "./settings-dialog";
import { SKILL_DESCRIPTION_FIELD, SKILL_NAME_REFUSED_LINE, SKILL_PAGE_BACK_NAME } from "../skill-source-copy";
import { BackArrowIcon, CloseIcon } from "./icons";

/** The id a typed name is saved under. The write route fits the id it gets with the server's
 *  `fitSkillName` (skills-repo-fetch.ts) and refuses one that fitting changes. This is not that
 *  function: it drops `_` and `.` where fitting turns them into hyphens, and keeps a hyphen at
 *  either end, which fitting takes off, so such a name is refused when saved. */
function slugifySkillId(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 48);
}

/** Upload-skill modal (MR-P2): a drag-and-drop / click zone that routes the picked file
 *  into the existing review seam, plus the accepted-file requirements. In the new
 *  settings look it is drawn as the window's question dialog, with the window's close. */
function SkillUploadModal({ onClose, onFile }: { onClose: () => void; onFile: (file: File) => void }) {
	const lookNext = useSettingsLookNext();
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	useEscapeKey(onClose);

	function pick(file: File | null) {
		if (file) onFile(file);
	}

	// Portal to <body>: ancestor transforms/filters turn position:fixed into a
	// containing-block trap, shrinking the overlay to a floating rectangle.
	return createPortal(
		<div className={lookNext ? "skill-upload-overlay settings-look-next" : "skill-upload-overlay"} role="dialog" aria-modal="true" aria-label="Upload skill" onClick={onClose}>
			<div className="skill-upload-modal" onClick={(e) => e.stopPropagation()}>
				<div className="skill-upload-modal-head">
					<h3>Upload skill</h3>
					{lookNext
						? <button type="button" className="rs-btn rs-btn-icon rs-btn-sm" aria-label="Close" onClick={onClose}><CloseIcon size={16} /></button>
						: <button className="rs-btn rs-btn-icon" aria-label="Close" onClick={onClose}>✕</button>}
				</div>
				<button
					type="button"
					className={`skill-upload-drop${dragging ? " dragging" : ""}`}
					onClick={() => inputRef.current?.click()}
					onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
					onDragLeave={() => setDragging(false)}
					onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files?.[0] ?? null); }}
				>
					{/* The new look's mark is the back arrow turned to point up. */}
					<span className="skill-upload-drop-glyph" aria-hidden="true">{lookNext ? <BackArrowIcon size={16} /> : "⬆"}</span>
					<span className="skill-upload-drop-label">Drag and drop or click to upload</span>
				</button>
				<input
					ref={inputRef}
					type="file"
					accept=".md,.zip,.skill"
					className="skill-upload-input"
					onChange={(e) => { const file = e.target.files?.[0] ?? null; e.target.value = ""; pick(file); }}
				/>
				<div className="skill-upload-reqs">
					<span className="skill-upload-reqs-title">File requirements</span>
					<ul>
						<li><code>.md</code> file with the skill name and description in YAML frontmatter</li>
						<li><code>.zip</code> or <code>.skill</code> file must include a <code>SKILL.md</code></li>
					</ul>
				</div>
			</div>
		</div>,
		document.body,
	);
}

/** The Add skill menu: write it, upload a file, add from a repository, or browse the featured ones.
 *  Without onImportRepo and onBrowse the menu has no such item: a shared server refuses both. */
function AddSkillMenu({ onWrite, onUpload, onImportRepo, onBrowse }: { onWrite: () => void; onUpload: () => void; onImportRepo?: () => void; onBrowse?: () => void }) {
	const lookNext = useSettingsLookNext();
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) return;
		function onDown(e: MouseEvent) {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onDown);
		if (!lookNext) document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, lookNext]);
	// In the new look the open menu is the top layer: one Escape closes it, not
	// the window under it, and the keyboard goes back to the button.
	useEscapeKey(() => {
		setOpen(false);
		if (wrapRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
	}, open && lookNext);
	return (
		<div className="skill-add-menu-wrap" ref={wrapRef}>
			{/* In the new look an ordinary small button with a caret for its menu, as the button at the top of every page. */}
			<button ref={buttonRef} className={lookNext ? "rs-btn rs-btn-sm" : "rs-btn"} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				Add skill
				{lookNext && <span className="skill-add-caret" aria-hidden="true"><ChevronDownIcon size={12} /></span>}
			</button>
			{open && (
				<div className="skill-add-menu" role="menu">
					<button className="menu-item" role="menuitem" onClick={() => { setOpen(false); onWrite(); }}>{ADD_SKILL_WAYS.write}</button>
					<button className="menu-item" role="menuitem" onClick={() => { setOpen(false); onUpload(); }}>{ADD_SKILL_WAYS.upload}</button>
					{onImportRepo && <button className="menu-item" role="menuitem" onClick={() => { setOpen(false); onImportRepo(); }}>{ADD_SKILL_WAYS.repository}</button>}
					{onBrowse && <button className="menu-item" role="menuitem" onClick={() => { setOpen(false); onBrowse(); }}>{ADD_SKILL_WAYS.featured}</button>}
				</div>
			)}
		</div>
	);
}

const WRITE_SKILL_TITLE = "Write a skill";

/** Write-skill form (spec §3 path 1). Maps onto the POST validation: name → id + display
 *  name, description, instructions. The server records provenance source "local". */
function WriteSkillForm({ view, onCreated, onCancel }: { view: SkillLibraryView; onCreated: (notice: string) => void; onCancel: () => void }) {
	const lookNext = useSettingsLookNext();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [instructions, setInstructions] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const needed = useNeededFields();
	const nameRef = useRef<HTMLInputElement | null>(null);
	const descriptionRef = useRef<HTMLInputElement | null>(null);
	const instructionsRef = useRef<HTMLTextAreaElement | null>(null);
	const nameNeeded = needed.field("name", name);
	const descriptionNeeded = needed.field("description", description);
	const instructionsNeeded = needed.field("instructions", instructions);

	const id = slugifySkillId(name);
	const canSave = Boolean(id) && description.trim() !== "" && instructions.trim() !== "" && !saving;
	// A name with no letter or number has no saved form: the new look says why it can't be saved.
	const refusedName = lookNext && name.trim() !== "" && !id;

	// The new look's Save stays pressable: pressed too early, it marks what is missing.
	function press() {
		if (needed.filled([[id, nameRef.current], [description, descriptionRef.current], [instructions, instructionsRef.current]])) void save();
	}

	async function save() {
		setSaving(true);
		setError(null);
		try {
			await createSkill({ id, displayName: name.trim(), description: description.trim(), instructions: instructions.trim() });
			onCreated(skillAddedNotice(view, name.trim()));
		} catch (e) {
			setError(skillRefusalLine(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="ai-setup-block skill-write-block" aria-label="Write skill">
			{!lookNext && (
				<>
					<h3>{WRITE_SKILL_TITLE}</h3>
					<p className="ai-setup-copy">{WRITE_SKILL_LEAD}</p>
				</>
			)}
			<div className="connector-form">
				<label className="connector-form-field">
					<span>Name</span>
					<input ref={nameRef} type="text" value={name} placeholder="cite-sources" {...nameNeeded.props} aria-invalid={refusedName || nameNeeded.props["aria-invalid"]} onChange={(e) => setName(e.target.value)} />
					{refusedName
						? <span className="skill-field-error">{SKILL_NAME_REFUSED_LINE}</span>
						: name.trim() && <span className="skill-write-id-hint">saved as <code>{id || "–"}</code></span>}
					{nameNeeded.line}
				</label>
				<label className="connector-form-field">
					<span>{lookNext ? SKILL_DESCRIPTION_FIELD.label : SKILL_DESCRIPTION_LABEL}</span>
					<input ref={descriptionRef} type="text" value={description} placeholder="Always cite sources before answering." {...descriptionNeeded.props} onChange={(e) => setDescription(e.target.value)} />
					{descriptionNeeded.line}
					{lookNext && <span className="skill-field-help">{SKILL_DESCRIPTION_FIELD.help}</span>}
				</label>
				<label className="connector-form-field">
					<span>Instructions</span>
					<textarea ref={instructionsRef} className="skill-write-instructions" value={instructions} {...instructionsNeeded.props} rows={12} placeholder={"When answering, cite the source of every factual claim.\nPrefer primary sources."} onChange={(e) => setInstructions(e.target.value)} />
					{instructionsNeeded.line}
				</label>
				{error && <div className={lookNext ? "checkpoint-proposal-error skill-message skill-message-failed" : "checkpoint-proposal-error"}>{error}</div>}
				{lookNext ? (
					// The main action first, on the left edge; Cancel quiet after it.
					<div className="settings-form-foot">
						<button className="rs-btn rs-btn-primary" disabled={saving} onClick={press}>{saving ? "Saving…" : "Save skill"}</button>
						<button className="rs-btn rs-btn-quiet" disabled={saving} onClick={onCancel}>Cancel</button>
					</div>
				) : (
					<div className="settings-form-foot">
						<button className="rs-btn" disabled={saving} onClick={onCancel}>Cancel</button>
						<button className="rs-btn rs-btn-primary" disabled={!canSave} onClick={() => void save()}>{saving ? "Saving…" : "Save skill"}</button>
					</div>
				)}
			</div>
		</div>
	);
}

type Mode =
	| { kind: "list" }
	| { kind: "write" }
	| { kind: "import-repo" }
	| { kind: "browse" }
	| { kind: "review"; candidate: SkillCandidate }
	| { kind: "detail"; skill: SkillDetail };

/** What a line above the library says: news to act on, something done or found fine, or something that failed. */
type LineKind = "news" | "done" | "failed";
/** A line after a check, or Update all's line, which the new look doesn't draw as a message yet. */
type CheckLine = { kind: LineKind | "update-all"; text: string };

/** The lines after a check: how many skills have an update, or none (named: the ones that can't update), unless a repository could not be asked; and the skills whose repository couldn't. */
function checkLines(check: SkillUpdatesCheck, skills: SkillListItem[]): CheckLine[] {
	const asked = check.results.filter((result) => result.state !== "untracked" && result.state !== "pinned");
	const available = asked.filter((result) => result.state === "available").length;
	const shown = (name: string) => skills.find((skill) => skill.name === name)?.displayName || name;
	const cannotUpdate = check.results.filter((result) => result.state === "untracked" || result.state === "gone" || result.state === "renamed").map((result) => shown(result.name));
	const lines: CheckLine[] = available > 0 || (!asked.some((result) => result.state === "unreachable") && asked.length + cannotUpdate.length > 0) ? [{ kind: available > 0 ? "news" : "done", text: skillUpdatesFoundLine(available, cannotUpdate) }] : [];
	const failed = asked.flatMap((result) => (result.state === "unreachable" && result.failure ? [{ name: shown(result.name), failure: result.failure }] : []));
	return [...lines, ...skillUpdatesFailedLines(failed, asked.length).map((text): CheckLine => ({ kind: "failed", text }))];
}

/** Added from a repository, and not fixed to one version of it. */
function canBeChecked(skill: SkillListItem): boolean {
	return skill.repository !== undefined && skill.repository.refKind !== "commit";
}

/**
 * When a check last had an answer from one of the skills' repositories, as the
 * page says it; null while none has.
 */
function lastChecked(skills: SkillListItem[]): string | null {
	const checkable = skills.filter(canBeChecked);
	const newest = checkable.flatMap((skill) => skill.update?.checkedAt ?? []).sort().at(-1);
	if (!newest) return null;
	const at = new Date(newest);
	return Number.isNaN(at.getTime()) ? null : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The name of the button that updates one skill: the row's to a screen reader, the message's on screen. */
function updateSkillName(name: string): string {
	return `${UPDATE_SKILL} ${name}`;
}

/** The refusals after which an Update is checked again for that skill, and the page shows what the check found. */
const RECHECKED_REFUSALS = new Set(["skill-changed-since-check", "candidate-expired", "skill-update-hidden-characters", "skill-changed-here", "no-update", "skill-renamed-upstream"]);

/** How often an open Settings, Skills reads the library again, so what Update automatically did shows without reopening it. */
const SKILLS_REREAD_MS = 60_000;

/** What Update automatically did that the person hasn't closed yet: the skills it updated, and the ones it left for them. */
function autoUpdateNotice(skills: SkillListItem[]): { updated: SkillListItem[]; left: SkillListItem[] } {
	return {
		updated: skills.filter((skill) => skill.update?.updated?.automatic && !skill.update.updated.noticeClosed),
		left: skills.filter((skill) => skill.update?.state === "available" && skill.update.autoSkipped && !skill.update.autoSkipped.noticeClosed),
	};
}

/** What a shown notice names of each skill, so its Close closes only that. */
function noticeShown(notice: ReturnType<typeof autoUpdateNotice>): SkillNoticeShown[] {
	const shown = new Map<string, SkillNoticeShown>();
	for (const skill of notice.updated) shown.set(skill.name, { name: skill.name, updatedAt: skill.update!.updated!.at });
	for (const skill of notice.left) shown.set(skill.name, { ...shown.get(skill.name), name: skill.name, skippedVersion: skill.update!.candidate!.filesSha256 });
	return [...shown.values()];
}

/** The notice of what Update automatically did, until the person closes it. */
function AutoUpdateNotice({ notice, onClose, closing }: { notice: ReturnType<typeof autoUpdateNotice>; onClose: () => void; closing: boolean }) {
	const name = (skill: SkillListItem) => skill.displayName || skill.name;
	return (
		<div className="cli-note skill-auto-notice" role="status">
			<p>
				{[notice.updated.length > 0 && skillsUpdatedAutomaticallyLine(notice.updated.map(name)), notice.left.length > 0 && skillsLeftForYouLine(notice.left.map(name))].filter(Boolean).join(" ")}
			</p>
			<button type="button" className="rs-btn rs-btn-quiet" disabled={closing} onClick={onClose}>{CLOSE_NOTICE}</button>
		</div>
	);
}

/** Where a skill came from, in the settings look's one line of facts. Text cut with "…" ends on a whole letter, up to
 *  a letter short of its box, so the box is brought in to it and what follows keeps its usual gap. */
function FromText({ text }: { text: string }) {
	const ref = useRef<HTMLSpanElement | null>(null);
	useLayoutEffect(() => {
		const box = ref.current!;
		const line = box.parentElement!;
		const pen = document.createElement("canvas").getContext("2d")!;
		const fit = () => {
			box.style.maxWidth = "";
			if (box.scrollWidth <= box.clientWidth) return;
			const style = getComputedStyle(box);
			pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const room = box.getBoundingClientRect().width - pen.measureText("…").width;
			const shown = document.createRange();
			shown.selectNodeContents(box);
			let letters = text.length;
			do shown.setEnd(box.firstChild!, --letters); while (letters > 0 && shown.getBoundingClientRect().width > room);
			box.style.maxWidth = `${Math.ceil(shown.getBoundingClientRect().width + pen.measureText("…").width)}px`;
		};
		fit();
		const resized = new ResizeObserver(fit);
		resized.observe(line);
		void document.fonts.ready.then(fit);
		return () => resized.disconnect();
	}, [text]);
	return <span ref={ref} className="skill-table-cell skill-table-from">{text}</span>;
}

/** One library row: the row opens the skill's page; a skill with an update has
 *  Update beside it, which installs it. The description is the name's tooltip;
 *  on a phone the facts fold into one line under the name. Without showsRooms
 *  the row has no room count (a company's library), nor has a skill no room can
 *  use: one that can't be opened, or whose name another skill has, which says
 *  so under its name. */
function SkillRow({ skill, showsRooms, onOpen, opening = false, onUpdate, updating = false }: { skill: SkillListItem; showsRooms: boolean; onOpen: () => void; opening?: boolean; onUpdate?: () => void; updating?: boolean }) {
	const lookNext = useSettingsLookNext();
	const name = skill.displayName || skill.name;
	const rooms = skill.rooms.length;
	const usedIn = rooms === 0 ? "No rooms" : rooms === 1 ? "1 room" : `${rooms} rooms`;
	const unusable = skill.unreadable ? SKILL_UNREADABLE_LINE : skill.nameTaken ? skillNameTakenByOtherLine(skill.nameTaken) : null;
	const countsRooms = showsRooms && !unusable;
	const from = skillFromText(skill.provenance?.source, skill.source, true);
	const hasUpdate = skill.update?.state === "available";
	const row = (
		<button
			type="button"
			className="skill-row skill-table-row"
			disabled={opening}
			aria-busy={opening}
			aria-label={[name, skill.disableModelInvocation && SKILL_BY_HAND_TAG.toLowerCase(), unusable, `from ${from}`, countsRooms && `used in ${usedIn.toLowerCase()}`].filter(Boolean).join(", ")}
			onClick={onOpen}
		>
			<span className="skill-table-name" title={skill.description || undefined}>
				<span className="skill-table-name-text">{name}</span>
				{skill.disableModelInvocation && <SkillByHandTag />}
			</span>
			{unusable && <span className="skill-table-problem">{unusable}</span>}
			{/* One wrapper around the fact cells: on desktop it dissolves into the
			    table grid (display: contents); the phone layout folds it into a
			    single dot-separated line under the name. */}
			<span className="skill-table-facts">
				{lookNext ? <FromText text={from} /> : <span className="skill-table-cell skill-table-from">{from}</span>}
				{showsRooms && <span className="skill-table-cell">{countsRooms ? (lookNext ? usedIn.toLowerCase() : usedIn) : ""}</span>}
			</span>
			{onUpdate !== undefined && <span className={`skill-table-update-slot${hasUpdate ? " has-update" : ""}`} aria-hidden="true" />}
			<span className={lookNext ? "skill-table-chevron disclosure-chevron" : "skill-table-chevron"} aria-hidden="true">{lookNext ? null : "›"}</span>
		</button>
	);
	if (onUpdate === undefined) return row;
	return (
		<div className="skill-row-line">
			{row}
			<span className="skill-row-update">
				{hasUpdate && (
					<button type="button" className={lookNext ? "rs-btn rs-btn-sm" : "rs-btn"} disabled={updating} aria-busy={updating} aria-label={updateSkillName(name)} onClick={onUpdate}>
						{updating ? "Updating…" : UPDATE_SKILL}
					</button>
				)}
			</span>
		</div>
	);
}

export function SkillsPage({ serviceBack, focus }: { /** Counts the page's reconnects after an outage. */ serviceBack?: number; /** A skill whose page to open, from a room's Skills page. */ focus?: { name: string } | null }) {
	const [skills, setSkills] = useState<SkillListItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [mode, setMode] = useState<Mode>({ kind: "list" });
	const [reviewBusy, setReviewBusy] = useState(false);
	const [reviewError, setReviewError] = useState<string | null>(null);
	const [replaceRefused, setReplaceRefused] = useState(false);
	const [uploadOpen, setUploadOpen] = useState(false);
	const [openingName, setOpeningName] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const [checkedLines, setCheckedLines] = useState<CheckLine[]>([]);
	const [updatingName, setUpdatingName] = useState<string | null>(null);
	const [updatingAll, setUpdatingAll] = useState(false);
	const [closingNotice, setClosingNotice] = useState(false);
	// The last update's refusal, for the skill it was about: on the list and on that skill's page.
	const [updateLine, setUpdateLine] = useState<{ name: string; text: string } | null>(null);
	// Remote devices browse the library read-only: the remote route policy
	// (web-server remote-route-policy) serves the skill GET routes but refuses every
	// write, upload, and repo import, so those affordances are not rendered there
	// instead of failing per tap. On a shared server only its admin adds and
	// removes skills, for every room in the company, and nobody gets the featured
	// directory or repository import, which it refuses for everyone.
	const remoteClient = useRemoteClientContext();
	const lookNext = useSettingsLookNext();
	const view: SkillLibraryView = remoteClient.remote || sharedServerNonAdmin(remoteClient) ? "read-only" : remoteClient.sharedServer ? "company" : "own";
	const readOnly = view === "read-only";
	const offersRepoSources = showsComputerOnlyControls(remoteClient);
	// A read that takes the admin's role away closes what only the admin could
	// have opened, so no form is left to send what the server now refuses.
	useEffect(() => {
		if (!readOnly) return;
		setUploadOpen(false);
		setMode((current) => current.kind === "list" || current.kind === "detail" ? current : { kind: "list" });
	}, [readOnly]);

	/** Reads the library again; gives what it read, or null when the read failed. */
	const refresh = useCallback(async (): Promise<SkillListItem[] | null> => {
		setLoading(true);
		setError(null);
		try {
			const read = await fetchSkills();
			setSkills(read);
			return read;
		} catch (e) {
			setError((e as Error).message);
			return null;
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Each new focus opens that skill's page once.
	const focusedRef = useRef<typeof focus>(null);
	useEffect(() => {
		if (!focus || focusedRef.current === focus) return;
		focusedRef.current = focus;
		void openDetail(focus.name);
	}, [focus]);

	/**
	 * Reads the list again, and the open skill's page with it, without asking a
	 * repository and without touching the lines a check, an update or a stop left:
	 * what Update automatically or another window changed shows here. A read that
	 * fails keeps what the page shows, and so does one still on its way when a
	 * switch's save ended: it may hold the place from before that save.
	 */
	const modeRef = useRef(mode);
	modeRef.current = mode;
	// A skill's page opens at its top, and the list comes back at the place it was left.
	const pageRef = useRef<HTMLDivElement | null>(null);
	const pane = () => pageRef.current?.closest(".settings-dialog-pane") ?? null;
	const listTop = useRef<number | null>(null);
	const openedName = mode.kind === "detail" ? mode.skill.name : null;
	useLayoutEffect(() => {
		const scroller = pane();
		if (!scroller) return;
		if (openedName !== null) scroller.scrollTop = 0;
		else if (listTop.current !== null) {
			scroller.scrollTop = listTop.current;
			listTop.current = null;
		}
	}, [openedName]);
	const switchSaves = useRef(0);
	const reread = useCallback(async () => {
		const saves = switchSaves.current;
		try {
			const skills = await fetchSkills();
			if (saves === switchSaves.current) setSkills(skills);
		} catch {}
		const open = modeRef.current;
		if (open.kind !== "detail") return;
		try {
			const detail = await fetchSkill(open.skill.name);
			if (saves !== switchSaves.current) return;
			setMode((current) => (current.kind === "detail" && current.skill.name === detail.name ? { kind: "detail", skill: detail } : current));
		} catch {}
	}, []);

	// While Settings, Skills is open: on the window's focus, and every minute while it can be seen.
	useEffect(() => {
		const onFocus = () => void reread();
		window.addEventListener("focus", onFocus);
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") void reread();
		}, SKILLS_REREAD_MS);
		return () => {
			window.removeEventListener("focus", onFocus);
			window.clearInterval(timer);
		};
	}, [reread]);

	// When the service answers again after an outage: a line saying it could not
	// be reached goes, and the library is read again.
	const firstServiceBack = useRef(serviceBack);
	useEffect(() => {
		if (isServiceUnreachableLine(error)) void refresh();
		else if (serviceBack !== firstServiceBack.current) void reread();
	}, [serviceBack]);

	function backToList(notice?: string) {
		setMode({ kind: "list" });
		setReviewError(null);
		if (notice) setNotice(notice);
	}

	async function onFilePicked(file: File | null) {
		if (!file) return;
		setNotice(null);
		setError(null);
		// A file past what an upload may be is never sent; one under it is measured by the server on what it would write.
		if (file.size > SKILL_UPLOAD_MAX_BYTES) {
			setError(skillTooBigLine({ bytes: SKILL_UPLOAD_MAX_BYTES, over: true }));
			return;
		}
		try {
			const base64 = await fileToBase64(file);
			const candidate = await uploadSkillFile(file.name, base64);
			setReviewError(null);
			setReplaceRefused(false);
			setMode({ kind: "review", candidate });
		} catch (e) {
			setError(skillRefusalLine(e));
		}
	}

	async function openDetail(name: string) {
		setNotice(null);
		setOpeningName(name);
		try {
			const skill = await fetchSkill(name);
			if (modeRef.current.kind === "list") listTop.current = pane()?.scrollTop ?? null;
			setMode({ kind: "detail", skill });
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setOpeningName(null);
		}
	}

	// Behind the list, once as the page opens on it: what it finds shows in the rows.
	useQuietSkillCheck(loading || error !== null || openingName !== null || mode.kind !== "list" ? null : skills, reread);

	/** The person's own check, on Check now: every repository of their skills, with what it found and what it couldn't ask. */
	async function checkNow() {
		if (checking || updatingAll) return;
		setChecking(true);
		setNotice(null);
		setError(null);
		setUpdateLine(null);
		// The last check's lines go: they would read as this one's while it runs.
		setCheckedLines([]);
		try {
			const check = await checkSkillUpdates();
			const fresh = await fetchSkills();
			setSkills(fresh);
			setCheckedLines(checkLines(check, fresh));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setChecking(false);
		}
	}

	/** Reads one skill again after its update or its check, on the list and on its page when that is open. */
	async function reloadSkill(name: string) {
		await refresh();
		try {
			const detail = await fetchSkill(name);
			setMode((current) => (current.kind === "detail" && current.skill.name === name ? { kind: "detail", skill: detail } : current));
		} catch {}
	}

	/**
	 * One click installs the version the check found. Two cases stop first: hidden
	 * characters in the new version stop at the skill's page, where the add's own
	 * warning shows and the person decides; a skill changed on this computer asks
	 * once whether to replace those changes. A check that no longer holds is run
	 * again for that skill, and the page shows what it found.
	 */
	async function runUpdate(skill: SkillListItem, confirm: SkillUpdateConfirm = {}) {
		const candidate = skill.update?.candidate;
		const installed = skill.update?.installedFilesSha256;
		const name = skill.displayName || skill.name;
		if (!candidate || !installed || updatingAll) return;
		if (candidate.hiddenCharacters && !confirm.hiddenCharacters) {
			if (mode.kind !== "detail") await openDetail(skill.name);
			return;
		}
		let yes = confirm;
		if (candidate.changedHere && !yes.replaceMyChanges) {
			if (!(await confirmDialog(skillChangedHereQuestion(name)))) return;
			yes = { ...yes, replaceMyChanges: true };
		}
		setUpdatingName(skill.name);
		setUpdateLine(null);
		setNotice(null);
		setCheckedLines([]);
		try {
			await updateSkill(skill.name, candidate, installed, yes);
			setNotice(skillUpdatedNotice(name));
			await reloadSkill(skill.name);
		} catch (e) {
			const code = apiErrorCode(e);
			if (code && RECHECKED_REFUSALS.has(code)) {
				try {
					await checkSkillUpdates([skill.name]);
				} catch {}
				await reloadSkill(skill.name);
				// A renamed skill's open page says so in its state line after the recheck: no second line there. The list has no such line.
				if (code !== "skill-renamed-upstream" || mode.kind !== "detail") setUpdateLine({ name: skill.name, text: SKILL_UPDATE_RECHECKED_LINE });
			} else {
				setUpdateLine({ name: skill.name, text: skillUpdateRefusalLine(e, name) });
			}
		} finally {
			setUpdatingName(null);
		}
	}

	/**
	 * Update all: each skill with an update in turn, as its own Update, never with
	 * a yes. One that would stop (hidden characters, or changed on this computer)
	 * keeps its own Update and stop; one refused is checked again, as a single
	 * Update's is. The line after names each skill that didn't update.
	 */
	async function updateAll() {
		const waiting = skills.filter((skill) => skill.update?.state === "available" && skill.update.candidate && skill.update.installedFilesSha256);
		setUpdatingAll(true);
		setUpdateLine(null);
		setNotice(null);
		setError(null);
		setCheckedLines([]);
		let updated = 0;
		const couldNot: { skill: SkillListItem; why: SkillNotUpdated["why"] }[] = [];
		for (const skill of waiting) {
			const candidate = skill.update!.candidate!;
			if (candidate.hiddenCharacters || candidate.changedHere) {
				couldNot.push({ skill, why: "waits" });
				continue;
			}
			setUpdatingName(skill.name);
			try {
				await updateSkill(skill.name, candidate, skill.update!.installedFilesSha256!);
				updated += 1;
			} catch (e) {
				couldNot.push({ skill, why: "failed" });
				const code = apiErrorCode(e);
				if (code && RECHECKED_REFUSALS.has(code)) {
					try {
						await checkSkillUpdates([skill.name]);
					} catch {}
				}
			}
		}
		setUpdatingName(null);
		// The way on is each skill's own Update: only the ones whose row still shows it are sent to it (after a failed read, the rows are as before).
		const read = await refresh();
		const label = (skill: SkillListItem) => skill.displayName || skill.name;
		const hasUpdate = (skill: SkillListItem) => read === null || read.find((s) => s.name === skill.name)?.update?.state === "available";
		setCheckedLines([{ kind: "update-all", text: skillUpdateAllLine(updated, couldNot.map(({ skill, why }) => ({ name: label(skill), why, hasUpdate: hasUpdate(skill) }))) }]);
		setUpdatingAll(false);
	}

	/** Closes the notice for what it showed, so an update or a version left after it showed stays named. */
	async function closeNotice(shown: SkillNoticeShown[]) {
		setClosingNotice(true);
		try {
			await closeSkillUpdateNotices(shown);
			await reread();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setClosingNotice(false);
		}
	}

	/**
	 * Saves a skill's Update automatically and shows its page with the place saved.
	 * A save whose answer was lost may still have been made: what a read says then
	 * wins, and the failure stays the switch's own line only where it didn't take.
	 */
	async function saveAutoUpdate(name: string, on: boolean) {
		const showOpen = (skill: SkillListItem | SkillDetail) =>
			setMode((current) => (current.kind === "detail" && current.skill.name === name && skill.repository ? { kind: "detail", skill: { ...current.skill, repository: skill.repository } } : current));
		let saved: SkillListItem | null = null;
		let failure: unknown = null;
		try {
			saved = await setSkillAutoUpdate(name, on);
		} catch (e) {
			failure = e;
		}
		// The save is over: a read still on its way may hold the place from before it.
		switchSaves.current += 1;
		if (saved) showOpen(saved);
		else {
			const read = await fetchSkill(name).catch(() => null);
			if (read) showOpen(read);
			if (read?.repository?.autoUpdate !== on) throw failure;
		}
		void reread();
	}

	async function acceptCandidate(candidate: SkillCandidate) {
		setReviewBusy(true);
		setReviewError(null);
		try {
			await acceptSkillCandidate(candidate);
			await refresh();
			backToList((candidate.replaces ? skillReplacedNotice : skillAddedNotice)(view, candidate.name || candidate.id));
		} catch (e) {
			setReviewError(skillRefusalLine(e));
			setReplaceRefused(replaceRefusedSinceReview(e));
		} finally {
			setReviewBusy(false);
		}
	}

	const header = (actions?: ReactNode) => <PaneHeader title="Skills" line={SKILLS_PAGE_LINE} actions={actions} />;
	// In the new look a way to add a skill is a page of its own: the arrow back and its name, in place of the Skills title, its lead and Back to library.
	const subPageBack = <PaneBack aria-label={SKILL_PAGE_BACK_NAME} onClick={() => backToList()} />;
	const subPageTitles = { write: WRITE_SKILL_TITLE, "import-repo": ADD_SKILL_WAYS.repository, browse: ADD_SKILL_WAYS.featured };
	// Update sits beside a row's open button only on the computer itself, and only while a skill has one.
	const rowsUpdate = offersRepoSources && skills.some((skill) => skill.update?.state === "available");
	const updatesWaiting = skills.filter((skill) => skill.update?.state === "available").length;
	// Only the computer itself shows it: a phone or a shared server could not close it.
	const autoNotice = offersRepoSources ? autoUpdateNotice(skills) : null;
	const backToLibrary = <button className="rs-btn" onClick={() => backToList()}>Back to library</button>;
	// In the new look a line above the table is a strip whose dot tells its kind; today's look keeps its plain line.
	const messageClass = (today: string, kind: LineKind) => lookNext ? `${today} skill-message skill-message-${kind}` : today;
	// After a check that found one update, its message offers that update, as the row's Update does.
	const withUpdate = skills.filter((skill) => skill.update?.state === "available");
	const messageUpdate = lookNext && rowsUpdate && withUpdate.length === 1 ? withUpdate[0] : null;
	const browseFeatured = offersRepoSources ? () => setMode({ kind: "browse" }) : undefined;
	const when = lastChecked(skills);
	// The one check the person makes: it keeps the keyboard while it runs, so it is never disabled.
	const checkedLine = offersRepoSources && skills.some(canBeChecked) && (
		<p className="cli-note skill-updates-line skill-updates-checked">
			{skillUpdatesCheckedLine(when)}{" "}
			<button type="button" className="rs-text-btn pane-lead-link pane-check-link skill-check-now" aria-disabled={checking || updatingAll} aria-busy={checking} onClick={() => void checkNow()}>{checking ? CHECKING_NOW : CHECK_NOW}</button>
		</p>
	);
	// Review / detail take over the page (the shared trust-moment screen).
	if (mode.kind === "review") {
		return (
			<div className="landing skills-page">
				{!lookNext && header()}
				<SkillReview
					back={subPageBack}
					candidate={mode.candidate}
					descriptionEditable
					onAccept={(description) => void acceptCandidate({ ...mode.candidate, description })}
					onCancel={() => backToList()}
					busy={reviewBusy}
					error={reviewError}
					replaceRefused={replaceRefused}
				/>
			</div>
		);
	}
	if (mode.kind === "detail") {
		return (
			<div ref={pageRef} className="landing skills-page">
				{notice && <p className="cli-note" role="status">{notice}</p>}
				<SkillDetailPage
					skill={mode.skill}
					onBack={() => { setUpdateLine(null); backToList(); }}
					onDeleted={(message) => { setError(null); void refresh(); backToList(message); }}
					view={view}
					onUpdate={offersRepoSources ? (confirm) => void runUpdate(mode.skill, confirm) : undefined}
					updating={updatingName === mode.skill.name}
					updateLine={updateLine?.name === mode.skill.name ? updateLine.text : null}
					onAutoUpdate={offersRepoSources ? (on) => saveAutoUpdate(mode.skill.name, on) : undefined}
				/>
			</div>
		);
	}

	return (
		<div ref={pageRef} className="landing skills-page">
			{lookNext && mode.kind !== "list" ? <PaneHeader back={subPageBack} title={subPageTitles[mode.kind]} line={mode.kind === "write" ? WRITE_SKILL_LEAD : undefined} /> : header(mode.kind === "import-repo" || mode.kind === "browse"
				? backToLibrary
				: mode.kind === "write" || readOnly
					? undefined
					: <AddSkillMenu onWrite={() => setMode({ kind: "write" })} onUpload={() => setUploadOpen(true)} onImportRepo={offersRepoSources ? () => setMode({ kind: "import-repo" }) : undefined} onBrowse={browseFeatured} />)}
			{uploadOpen && (
				<SkillUploadModal
					onClose={() => setUploadOpen(false)}
					onFile={(file) => { setUploadOpen(false); void onFilePicked(file); }}
				/>
			)}

			{mode.kind === "write" ? (
				<WriteSkillForm
					view={view}
					onCreated={async (message) => { await refresh(); backToList(message); }}
					onCancel={() => backToList()}
				/>
			) : mode.kind === "import-repo" ? (
				<section className="ai-setup-section" aria-label={ADD_SKILL_WAYS.repository}>
					{!lookNext && <h3 className="web-search-fallback-heading">{ADD_SKILL_WAYS.repository}</h3>}
					<SkillImportFromRepo back={subPageBack} onImported={(name, replaced) => { setNotice((replaced ? skillReplacedNotice : skillAddedNotice)(view, name)); void refresh(); }} />
				</section>
			) : mode.kind === "browse" ? (
				<section className="ai-setup-section" aria-label="Browse featured skill sources">
					<SkillBrowseDirectory back={subPageBack} onImported={(name, replaced) => { setNotice((replaced ? skillReplacedNotice : skillAddedNotice)(view, name)); void refresh(); }} />
				</section>
			) : (
				<section className={lookNext ? "ai-setup-section skill-library" : "ai-setup-section"} aria-label="Skills library">
					{readOnly && <p className="cli-note">{remoteClient.sharedServer ? SHARED_SERVER_ADMIN_LINE : "Skills are uploaded and edited on the computer itself."}</p>}
					{notice && <p className={messageClass("cli-note", "done")} role="status">{notice}</p>}
					{autoNotice && (autoNotice.updated.length > 0 || autoNotice.left.length > 0) && (
						<AutoUpdateNotice notice={autoNotice} closing={closingNotice} onClose={() => void closeNotice(noticeShown(autoNotice))} />
					)}
					{/* Update all sits with the line that says when the page last checked, so the page doesn't move when it comes and goes. */}
					{(checkedLines.length > 0 || checkedLine || (offersRepoSources && updatesWaiting >= 2)) && (
						<div className="skill-updates-bar">
							<div className="skill-updates-lines">
								{checkedLines.map((line) => (
									<p key={line.text} className={line.kind === "update-all" ? "cli-note skill-updates-line" : messageClass("cli-note skill-updates-line", line.kind)} role="status">
										{line.text}
										{line.kind === "news" && messageUpdate && (
											// Pressed, the update starts and the lines go: Updated or its failure takes their place.
											<button type="button" className="rs-btn rs-btn-sm" onClick={() => void runUpdate(messageUpdate)}>
												{updateSkillName(messageUpdate.displayName || messageUpdate.name)}
											</button>
										)}
									</p>
								))}
								{checkedLine}
							</div>
							{offersRepoSources && updatesWaiting >= 2 && (
								<button className="rs-btn" disabled={updatingAll || checking || updatingName !== null} aria-busy={updatingAll} onClick={() => void updateAll()}>{updatingAll ? "Updating…" : UPDATE_ALL}</button>
							)}
						</div>
					)}
					{updateLine && mode.kind === "list" && <div className={messageClass("checkpoint-proposal-error", "failed")}>{updateLine.text}</div>}
					{error && <div className={messageClass("checkpoint-proposal-error", "failed")}>{error}</div>}
					{loading && skills.length === 0 && <p className="ai-setup-copy">Loading your skills…</p>}
					{!loading && skills.length === 0 && !error && (
						<p className="settings-empty">
							{readOnly ? "No skills yet." : view === "company" ? "No skills yet. Use Add skill to write or upload one." : `No skills yet. Use Add skill to write, upload, or import one${browseFeatured ? ", or " : "."}`}
							{browseFeatured && <><button type="button" className="rs-text-btn pane-lead-link" onClick={browseFeatured}>{BROWSE_FEATURED_LINK}</button>.</>}
						</p>
					)}
					{skills.length > 0 && (
						<div className={`skill-rows skill-table${view === "company" ? " skill-table-no-rooms" : ""}${rowsUpdate ? " skill-table-updates" : ""}`}>
							<div className="settings-table-head skill-table-head" aria-hidden="true">
								<span>Skill</span>
								<span>From</span>
								{view !== "company" && <span>Used in</span>}
								<span />
								{rowsUpdate && <span />}
							</div>
							{skills.map((skill) => (
								<SkillRow
									key={skill.name}
									skill={skill}
									showsRooms={view !== "company"}
									onOpen={() => void openDetail(skill.name)}
									opening={openingName === skill.name}
									{...(rowsUpdate ? { onUpdate: () => void runUpdate(skill), updating: updatingName === skill.name } : {})}
								/>
							))}
						</div>
					)}
				</section>
			)}
		</div>
	);
}
