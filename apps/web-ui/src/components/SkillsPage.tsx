import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PaneHeader } from "./pane-header";
import {
	acceptSkillCandidate,
	createSkill,
	fetchSkill,
	fetchSkills,
	fileToBase64,
	uploadSkillFile,
	type SkillCandidate,
	type SkillDetail,
	type SkillListItem,
} from "../skills-api";
import { SkillReview } from "./SkillReview";
import { SkillDetailPage, formatSkillDate } from "./skill-detail";
import { skillTierLabel } from "../skill-source-copy";
import { useRemoteClientContext } from "../remote-client-context";
import { SkillImportFromRepo } from "./SkillImportFromRepo";
import { SkillBrowseDirectory } from "./SkillBrowseDirectory";
import { useEscapeKey } from "./use-escape-key";

/** Client mirror of the server's slugifySkillId — the id must already be a slug for the
 *  write endpoint to accept it (it re-slugifies and requires equality). */
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
 *  into the existing review seam, plus the accepted-file requirements. */
function SkillUploadModal({ onClose, onFile }: { onClose: () => void; onFile: (file: File) => void }) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	useEscapeKey(onClose);

	function pick(file: File | null) {
		if (file) onFile(file);
	}

	// Portal to <body>: ancestor transforms/filters turn position:fixed into a
	// containing-block trap, shrinking the overlay to a floating rectangle.
	return createPortal(
		<div className="skill-upload-overlay" role="dialog" aria-modal="true" aria-label="Upload skill" onClick={onClose}>
			<div className="skill-upload-modal" onClick={(e) => e.stopPropagation()}>
				<div className="skill-upload-modal-head">
					<h3>Upload skill</h3>
					<button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
				</div>
				<button
					type="button"
					className={`skill-upload-drop${dragging ? " dragging" : ""}`}
					onClick={() => inputRef.current?.click()}
					onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
					onDragLeave={() => setDragging(false)}
					onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files?.[0] ?? null); }}
				>
					<span className="skill-upload-drop-glyph" aria-hidden="true">⬆</span>
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

/** Claude-app "Add skill" menu: a button revealing Write / Upload / Import from repo. */
function AddSkillMenu({ onWrite, onUpload, onImportRepo }: { onWrite: () => void; onUpload: () => void; onImportRepo: () => void }) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		function onDown(e: MouseEvent) {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);
	return (
		<div className="skill-add-menu-wrap" ref={wrapRef}>
			{/* Same small filled pill as the connector rows' Log in button: the
			    tab's one primary action, not a page-scale slab. */}
			<button className="rs-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				Add skill
			</button>
			{open && (
				<div className="skill-add-menu" role="menu">
					<button className="menu-item" role="menuitem" onClick={() => { setOpen(false); onWrite(); }}>Write skill</button>
					<button className="menu-item" role="menuitem" onClick={() => { setOpen(false); onUpload(); }}>Upload</button>
					<button className="menu-item" role="menuitem" onClick={() => { setOpen(false); onImportRepo(); }}>Import from repo</button>
				</div>
			)}
		</div>
	);
}

/** Write-skill form (spec §3 path 1). Maps onto the POST validation: name → id + display
 *  name, description, instructions. The server records provenance source "local". */
function WriteSkillForm({ onCreated, onCancel }: { onCreated: (notice: string) => void; onCancel: () => void }) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [instructions, setInstructions] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const id = slugifySkillId(name);
	const canSave = Boolean(id) && description.trim() !== "" && instructions.trim() !== "" && !saving;

	async function save() {
		setSaving(true);
		setError(null);
		try {
			await createSkill({ id, displayName: name.trim(), description: description.trim(), instructions: instructions.trim() });
			onCreated(`Added “${name.trim()}” to your library.`);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="ai-setup-block skill-write-block" aria-label="Write skill">
			<h3>Write a skill</h3>
			<p className="ai-setup-copy">A skill is an instruction a room follows once you enable it there. Write the instructions you want it to adopt.</p>
			<div className="connector-form">
				<label className="connector-form-field">
					<span>Name</span>
					<input type="text" value={name} placeholder="cite-sources" onChange={(e) => setName(e.target.value)} />
					{name.trim() && <span className="skill-write-id-hint">saved as <code>{id || "–"}</code></span>}
				</label>
				<label className="connector-form-field">
					<span>Description (one line, shown in the library and the per-room index)</span>
					<input type="text" value={description} placeholder="Always cite sources before answering." onChange={(e) => setDescription(e.target.value)} />
				</label>
				<label className="connector-form-field">
					<span>Instructions</span>
					<textarea className="skill-write-instructions" value={instructions} rows={12} placeholder={"When answering, cite the source of every factual claim.\nPrefer primary sources."} onChange={(e) => setInstructions(e.target.value)} />
				</label>
				{error && <div className="checkpoint-proposal-error">{error}</div>}
				<div className="settings-form-foot">
					<button className="rs-btn" disabled={saving} onClick={onCancel}>Cancel</button>
					<button className="rs-btn rs-btn-primary" disabled={!canSave} onClick={() => void save()}>{saving ? "Saving…" : "Save skill"}</button>
				</div>
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

/** One library row: the whole row opens the skill's page. The description is
 *  the name's tooltip; on a phone the facts fold into one line under the name. */
function SkillRow({ skill, onOpen, opening = false }: { skill: SkillListItem; onOpen: () => void; opening?: boolean }) {
	const name = skill.displayName || skill.name;
	const rooms = skill.rooms.length;
	const usedIn = rooms === 0 ? "No rooms" : rooms === 1 ? "1 room" : `${rooms} rooms`;
	// A skill exxperts does not own has no import date; its cell names its source.
	const updated = skill.provenance ? formatSkillDate(skill.provenance.importedAt) : "";
	const tier = updated ? null : skillTierLabel(skill.source);
	const files = skill.fileCount === 0 ? "No files" : skill.fileCount === 1 ? "1 file" : `${skill.fileCount} files`;
	return (
		<button
			type="button"
			className="skill-row skill-table-row"
			disabled={opening}
			aria-busy={opening}
			aria-label={[name, `used in ${usedIn.toLowerCase()}`, files.toLowerCase(), updated ? `updated ${updated}` : tier?.toLowerCase()].filter(Boolean).join(", ")}
			onClick={onOpen}
		>
			<span className="skill-table-name" title={skill.description || undefined}>{name}</span>
			{/* One wrapper around the fact cells: on desktop it dissolves into the
			    table grid (display: contents); the phone layout folds it into a
			    single dot-separated line under the name. */}
			<span className="skill-table-facts">
				<span className="skill-table-cell">{usedIn}</span>
				<span className="skill-table-cell">
					<span className="skill-table-wide">{skill.fileCount === 0 ? "None" : skill.fileCount}</span>
					<span className="skill-table-narrow">{files}</span>
				</span>
				<span className="skill-table-cell">{updated || tier}</span>
			</span>
			<span className="skill-table-chevron" aria-hidden="true">›</span>
		</button>
	);
}

export function SkillsPage() {
	const [skills, setSkills] = useState<SkillListItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [mode, setMode] = useState<Mode>({ kind: "list" });
	const [reviewBusy, setReviewBusy] = useState(false);
	const [reviewError, setReviewError] = useState<string | null>(null);
	const [uploadOpen, setUploadOpen] = useState(false);
	const [openingName, setOpeningName] = useState<string | null>(null);
	// Remote devices browse the library read-only: the remote route policy
	// (web-server remote-route-policy) serves the skill GET routes but refuses every
	// write, upload, and repo import, so those affordances are not rendered there
	// instead of failing per tap.
	const remoteClient = useRemoteClientContext();

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setSkills(await fetchSkills());
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	function backToList(notice?: string) {
		setMode({ kind: "list" });
		setReviewError(null);
		if (notice) setNotice(notice);
	}

	async function onFilePicked(file: File | null) {
		if (!file) return;
		setNotice(null);
		setError(null);
		try {
			const base64 = await fileToBase64(file);
			const candidate = await uploadSkillFile(file.name, base64);
			setReviewError(null);
			setMode({ kind: "review", candidate });
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function openDetail(name: string) {
		setNotice(null);
		setOpeningName(name);
		try {
			setMode({ kind: "detail", skill: await fetchSkill(name) });
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setOpeningName(null);
		}
	}

	async function acceptCandidate(candidate: SkillCandidate) {
		setReviewBusy(true);
		setReviewError(null);
		try {
			await acceptSkillCandidate(candidate);
			await refresh();
			backToList(`Added “${candidate.name || candidate.id}” to your library.`);
		} catch (e) {
			setReviewError((e as Error).message);
		} finally {
			setReviewBusy(false);
		}
	}

	const header = (actions?: ReactNode) => <PaneHeader title="Skills" line="Reusable know-how your rooms can pick up. Every skill is reviewed before it enters the library." actions={actions} />;
	const backToLibrary = <button className="rs-btn" onClick={() => backToList()}>Back to library</button>;
	// Review / detail take over the page (the shared trust-moment screen).
	if (mode.kind === "review") {
		return (
			<div className="landing skills-page">
				{header()}
				<SkillReview
					candidate={mode.candidate}
					descriptionEditable
					onAccept={(description) => void acceptCandidate({ ...mode.candidate, description })}
					onCancel={() => backToList()}
					busy={reviewBusy}
					error={reviewError}
				/>
			</div>
		);
	}
	if (mode.kind === "detail") {
		return (
			<div className="landing skills-page">
				<SkillDetailPage
					skill={mode.skill}
					onBack={() => backToList()}
					onDeleted={(message) => { setError(null); void refresh(); backToList(message); }}
					readOnly={remoteClient.remote}
				/>
			</div>
		);
	}

	return (
		<div className="landing skills-page">
			{header(mode.kind === "import-repo" || mode.kind === "browse"
				? backToLibrary
				: mode.kind === "write" || remoteClient.remote
					? undefined
					: <>
						<button className="rs-btn" onClick={() => setMode({ kind: "browse" })}>Browse featured</button>
						<AddSkillMenu onWrite={() => setMode({ kind: "write" })} onUpload={() => setUploadOpen(true)} onImportRepo={() => setMode({ kind: "import-repo" })} />
					</>)}
			{uploadOpen && (
				<SkillUploadModal
					onClose={() => setUploadOpen(false)}
					onFile={(file) => { setUploadOpen(false); void onFilePicked(file); }}
				/>
			)}

			{mode.kind === "write" ? (
				<WriteSkillForm
					onCreated={async (message) => { await refresh(); backToList(message); }}
					onCancel={() => backToList()}
				/>
			) : mode.kind === "import-repo" ? (
				<section className="ai-setup-section" aria-label="Import skills from a repository">
					<h3 className="web-search-fallback-heading">Import from repo</h3>
					<SkillImportFromRepo onImported={(name) => { setNotice(`Added “${name}” to your library.`); void refresh(); }} />
				</section>
			) : mode.kind === "browse" ? (
				<section className="ai-setup-section" aria-label="Browse featured skill sources">
					<SkillBrowseDirectory onImported={(name) => { setNotice(`Added “${name}” to your library.`); void refresh(); }} />
				</section>
			) : (
				<section className="ai-setup-section" aria-label="Skills library">
					{remoteClient.remote && <p className="cli-note">Skills are uploaded and edited on the computer itself.</p>}
					{notice && <p className="cli-note" role="status">{notice}</p>}
					{error && <div className="checkpoint-proposal-error">{error}</div>}
					{loading && skills.length === 0 && <p className="ai-setup-copy">Loading your skills…</p>}
					{!loading && skills.length === 0 && !error && (
						<p className="settings-empty">{remoteClient.remote ? "No skills yet." : "No skills yet. Use Add skill to write, upload, or import one."}</p>
					)}
					{skills.length > 0 && (
						<div className="skill-rows skill-table">
							<div className="settings-table-head skill-table-head" aria-hidden="true">
								<span>Skill</span>
								<span>Used in</span>
								<span>Files</span>
								<span>Updated</span>
								<span />
							</div>
							{skills.map((skill) => (
								<SkillRow
									key={skill.name}
									skill={skill}
									onOpen={() => void openDetail(skill.name)}
									opening={openingName === skill.name}
								/>
							))}
						</div>
					)}
					{skills.length > 0 && <p className="cli-note">A skill's files run only in rooms where you allow them, and only as they were when you did.</p>}
				</section>
			)}
		</div>
	);
}
