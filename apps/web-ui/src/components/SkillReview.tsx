import { useState } from "react";
import type { SkillCandidate } from "../skills-api";
import { MarkdownRenderer } from "./Markdown";

/** Server cap on a skill description (mirrors validateSkillWritePayload). */
const DESCRIPTION_MAX = 1024;

/** Collapse a (possibly multi-line) frontmatter description into a single line for the
 *  editable field's prefill — an uploaded SKILL.md may carry a wrapped/multi-line
 *  description the single-line write validator would otherwise reject. */
function toSingleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * The trust moment (spec §0/§3). One component renders a "candidate skill" — the full
 * instruction text the user is adopting, its source and license, any hidden-character
 * findings, and a bundled-scripts note. It is used by:
 *   - Upload review (Accept persists, Cancel discards) — pass onAccept.
 *   - The library detail view (read mode) — omit onAccept, optionally pass onDelete.
 *   - MR-4 repo-import later — same candidate shape, so it plugs straight in.
 *
 * The component is deliberately independent of where the candidate came from: it takes
 * a plain candidate object plus action callbacks and nothing else.
 */
export function SkillReview({
	candidate,
	onAccept,
	onCancel,
	onDelete,
	descriptionEditable = false,
	busy = false,
	error = null,
}: {
	candidate: SkillCandidate;
	/** Present in review/import mode — renders the Accept button. Receives the (possibly
	 *  edited) description so the accept request carries what the user actually submitted. */
	onAccept?: (description: string) => void;
	/** Back (detail) or Cancel (review). Always present. */
	onCancel: () => void;
	/** Present in detail mode — renders a guarded Delete button. */
	onDelete?: () => void;
	/** Upload/accept flow only: render the editable, required single-line description
	 *  field. The repo-import flows vendor the SKILL.md verbatim, so they stay read-only. */
	descriptionEditable?: boolean;
	busy?: boolean;
	error?: string | null;
}) {
	const reviewMode = Boolean(onAccept);
	const licenseKnown = Boolean(candidate.license && candidate.license.trim());
	const findings = candidate.scanFindings ?? [];
	const scripts = candidate.bundledScripts ?? [];
	const [description, setDescription] = useState(() => toSingleLine(candidate.description ?? ""));
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const descriptionValid = description.trim().length > 0 && description.length <= DESCRIPTION_MAX;
	const acceptDisabled = busy || (descriptionEditable && !descriptionValid);

	return (
		<div className="skill-review">
			<div className="skill-review-head">
				<div className="skill-review-title-block">
					<div className="agent-details-kicker">{reviewMode ? "Review skill" : "Skill"}</div>
					<h2>{candidate.name || candidate.id}</h2>
					{candidate.description && !descriptionEditable && <p className="skill-review-desc">{candidate.description}</p>}
				</div>
				<button className="icon-btn" onClick={onCancel} aria-label={reviewMode ? "Cancel" : "Back"}>{reviewMode ? "Cancel" : "Back"}</button>
			</div>

			{reviewMode && (
				<p className="skill-review-lead">
					You are adopting the instructions below into your skills library. They become an
					instruction the room follows once you enable this skill in it. Read them first.
				</p>
			)}

			{descriptionEditable && (
				<label className="skill-review-field">
					<span className="skill-review-field-label">Description (one line, shown in the library and the per-room index)</span>
					<input
						type="text"
						className="skill-review-desc-input"
						value={description}
						placeholder="Always cite sources before answering."
						disabled={busy}
						aria-invalid={!descriptionValid}
						onChange={(e) => setDescription(e.target.value)}
					/>
					<span className={`skill-review-desc-counter${description.length > DESCRIPTION_MAX ? " over" : ""}`}>
						{description.length}/{DESCRIPTION_MAX}
					</span>
				</label>
			)}

			<dl className="skill-review-meta">
				<div className="skill-review-meta-row">
					<dt>Source</dt>
					<dd>{candidate.source || "unknown"}</dd>
				</div>
				<div className="skill-review-meta-row">
					<dt>License</dt>
					<dd className={licenseKnown ? "" : "skill-review-warn-text"}>
						{licenseKnown ? candidate.license : "Unknown (no license declared)"}
					</dd>
				</div>
			</dl>

			{!licenseKnown && (
				<div className="skill-review-banner warn" role="note">
					<strong>Unknown license.</strong> This skill declares no license, so you have no stated
					permission to use or redistribute it. Adopt it only if you trust the source.
				</div>
			)}

			{findings.length > 0 && (
				<div className="skill-review-banner danger" role="alert">
					<strong>{findings.length} hidden {findings.length === 1 ? "character" : "characters"} found.</strong>{" "}
					The instructions contain invisible or bidirectional characters, a common way to smuggle
					hidden instructions past a reader. Review carefully before accepting.
					<ul className="skill-review-findings">
						{findings.slice(0, 12).map((finding, index) => (
							<li key={`${finding.index}-${index}`}>
								<code>{finding.label}</code> ({finding.category}) at position {finding.index}
							</li>
						))}
						{findings.length > 12 && <li>…and {findings.length - 12} more</li>}
					</ul>
				</div>
			)}

			{scripts.length > 0 && (
				<div className="skill-review-banner" role="note">
					<strong>This package bundles {scripts.length} {scripts.length === 1 ? "script" : "scripts"}.</strong>{" "}
					Scripts will not run. Instructions only. exxperts adopts the prose; the bundled files
					({scripts.join(", ")}) are never executed.
				</div>
			)}

			<div className="skill-review-body-label">Instructions</div>
			<div className="skill-review-body">
				<MarkdownRenderer>{candidate.body}</MarkdownRenderer>
			</div>

			{error && <div className="checkpoint-proposal-error skill-review-error">{error}</div>}

			<div className="skill-review-actions">
				{reviewMode ? (
					<>
						<button className="landing-action" disabled={acceptDisabled} onClick={() => onAccept?.(descriptionEditable ? description.trim() : candidate.description)}>
							{busy ? "Adding…" : "Accept and add to library"}
						</button>
						<button className="landing-action secondary" disabled={busy} onClick={onCancel}>Cancel</button>
					</>
				) : (
					<>
						<button className="landing-action secondary" disabled={busy} onClick={onCancel}>Back to library</button>
						{onDelete && (
							confirmingDelete ? (
								<>
									<button className="landing-action skill-delete-action" disabled={busy} onClick={onDelete}>{busy ? "Deleting…" : "Delete"}</button>
									<button className="landing-action secondary" disabled={busy} onClick={() => setConfirmingDelete(false)}>Keep</button>
								</>
							) : (
								<button className="landing-action skill-delete-action" disabled={busy} onClick={() => setConfirmingDelete(true)}>Delete skill</button>
							)
						)}
					</>
				)}
			</div>
		</div>
	);
}
