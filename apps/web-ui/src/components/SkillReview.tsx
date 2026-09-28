import { useState } from "react";
import type { SkillCandidate } from "../skills-api";
import { FileGroupList, groupFilesByFolder } from "./file-groups";
import { SkillSourceRows, SkillWarnings } from "./skill-facts";
import { SkillInstructions } from "./skill-instructions";

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
 * findings, and a bundled-files note. It is used by upload review, repo import and the
 * featured directory: Accept persists, Cancel discards. A library skill's own page is
 * skill-detail.tsx.
 *
 * The component is deliberately independent of where the candidate came from: it takes
 * a plain candidate object plus action callbacks and nothing else.
 */
export function SkillReview({
	candidate,
	onAccept,
	onCancel,
	descriptionEditable = false,
	busy = false,
	error = null,
}: {
	candidate: SkillCandidate;
	/** Renders the Accept button. Receives the (possibly edited) description so the
	 *  accept request carries what the user actually submitted. */
	onAccept: (description: string) => void;
	onCancel: () => void;
	/** Upload/accept flow only: render the editable, required single-line description
	 *  field. The repo-import flows vendor the SKILL.md verbatim, so they stay read-only. */
	descriptionEditable?: boolean;
	busy?: boolean;
	error?: string | null;
}) {
	const licenseKnown = Boolean(candidate.license && candidate.license.trim());
	const findings = candidate.scanFindings ?? [];
	const scripts = candidate.bundledScripts ?? [];
	const [description, setDescription] = useState(() => toSingleLine(candidate.description ?? ""));
	const descriptionValid = description.trim().length > 0 && description.length <= DESCRIPTION_MAX;
	const acceptDisabled = busy || (descriptionEditable && !descriptionValid);

	return (
		<div className="skill-review">
			<div className="skill-review-head">
				<div className="skill-review-title-block">
					<div className="agent-details-kicker">Review skill</div>
					<h2>{candidate.name || candidate.id}</h2>
					{candidate.description && !descriptionEditable && <p className="skill-review-desc">{candidate.description}</p>}
				</div>
				<button className="icon-btn" onClick={onCancel} aria-label="Cancel">Cancel</button>
			</div>

			<p className="skill-review-lead">
				You are adopting the instructions below into your skills library. They become an
				instruction the room follows once you enable this skill in it. Read them first.
			</p>

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

			<div className="settings-rows skill-review-facts">
				<SkillSourceRows source={candidate.source} license={candidate.license} />
			</div>

			<SkillWarnings licenseKnown={licenseKnown} findings={findings} />

			{scripts.length > 0 && (
				<div className="skill-review-banner" role="note">
					<strong>This package bundles {scripts.length} {scripts.length === 1 ? "file" : "files"}.</strong>{" "}
					The bundled files are saved next to the instructions, and they never run on their
					own. A room can run them only after you enable this skill in it, the room has bash
					allowed, and you separately approve running exactly this version's files in that
					room's settings. Any change to the files voids that approval.
					{findings.length > 0 && " A skill with hidden characters can never be approved for execution."}
					<FileGroupList groups={groupFilesByFolder(scripts)} className="skill-review-files" />
				</div>
			)}

			<div className="skill-review-body-label">Instructions</div>
			<SkillInstructions body={candidate.body} />

			{error && <div className="checkpoint-proposal-error skill-review-error">{error}</div>}

			<div className="skill-review-actions">
				<button className="rs-btn" disabled={busy} onClick={onCancel}>Cancel</button>
				<button className="rs-btn rs-btn-primary" disabled={acceptDisabled} onClick={() => onAccept(descriptionEditable ? description.trim() : candidate.description)}>
					{busy ? "Adding…" : "Accept and add to library"}
				</button>
			</div>
		</div>
	);
}
