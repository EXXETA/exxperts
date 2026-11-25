import { useId, useState, type ReactNode } from "react";
import { ADD_TO_LIBRARY, REPLACE_SKILL, replaceSkillQuestion, replacesOtherSkillLine, SKILL_DESCRIPTION_LABEL, SKILL_REVIEW_LEAD, skillPickNameLine } from "../skill-source-copy";
import { SHOW_SCRIPTS, SKILL_DESCRIPTION_FIELD, SKILL_FILES_HEADING, skillScriptsCount } from "../skill-source-copy";
import type { SkillCandidate } from "../skills-api";
import { useSettingsLookNext } from "../settings-look";
import { listsFileKinds, SkillFilesByKind } from "./file-groups";
import { GroupHeader, PaneHeader } from "./pane-header";
import { SkillByHandTag, SkillFilesRow, SkillOutsideLine, SkillSourceRows, SkillWarnings, useScriptsLine } from "./skill-facts";
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
 * The trust moment. One component renders a "candidate skill": the full
 * instruction text the user is adopting, where it is from, its license and version
 * when stated, any hidden-character findings, and its files by kind. It is used by
 * upload review, repo import and the featured directory: Accept persists, Cancel
 * discards. An upload whose name is in the library asks to replace it instead. A
 * library skill's own page is skill-detail.tsx.
 *
 * The component is deliberately independent of where the candidate came from: it takes
 * a plain candidate object plus action callbacks and nothing else.
 *
 * In the new settings look (settings-look.ts) a skill with scripts says how
 * many it has under the question, with Show scripts, and a skill whose
 * instructions reach above its folder says so next; the facts, the
 * instructions and the files follow as sections; Cancel and the main button
 * sit in a foot pinned to the pane's bottom.
 */
export function SkillReview({
	candidate,
	onAccept,
	onCancel,
	descriptionEditable = false,
	busy = false,
	error = null,
	replaceRefused = false,
	back,
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
	/** The skill to replace changed after this review opened (`replaceRefusedSinceReview`): only Cancel is left. */
	replaceRefused?: boolean;
	/** The page's way back, before the skill's name: in the new settings look only. */
	back?: ReactNode;
}) {
	const findings = candidate.scanFindings ?? [];
	const files = candidate.files ?? [];
	const scriptsLine = useScriptsLine(files);
	const replaces = candidate.replaces === true;
	const [description, setDescription] = useState(() => toSingleLine(candidate.description ?? ""));
	const descriptionValid = description.trim().length > 0 && description.length <= DESCRIPTION_MAX;
	const acceptDisabled = busy || (descriptionEditable && !descriptionValid);
	const lookNext = useSettingsLookNext();
	const [revealScripts, setRevealScripts] = useState(0);
	const fieldId = useId();
	const accept = () => onAccept(descriptionEditable ? description.trim() : candidate.description);
	const acceptLabel = busy ? (replaces ? "Replacing…" : "Adding…") : replaces ? REPLACE_SKILL : ADD_TO_LIBRARY;
	const acceptButton = !replaceRefused && <button className="rs-btn rs-btn-primary" disabled={acceptDisabled} onClick={accept}>{acceptLabel}</button>;
	const nameLines = (
		<>
			{/* A different skill already has the name: Replace puts this one in its place. */}
			{replaces && candidate.replacesName && <p className="skill-review-lead">{replacesOtherSkillLine(candidate.replacesName, candidate.id)}</p>}
			{/* The name shown isn't the one a room's "/" picks it by, and the sentence above doesn't already say it. */}
			{candidate.name && candidate.name !== candidate.id && !(replaces && candidate.replacesName) && <p className="skill-review-lead">{skillPickNameLine(candidate.id)}</p>}
		</>
	);

	if (lookNext) {
		const scripts = files.filter((file) => file.kind === "scripts").length;
		return (
			<div className="skill-review">
				<PaneHeader
					back={back}
					title={<>{candidate.name || candidate.id}{candidate.disableModelInvocation && <SkillByHandTag />}</>}
					line={descriptionEditable ? undefined : candidate.description}
				/>

				{replaces
					? <p className="skill-review-lead skill-review-replace">{replaceSkillQuestion(candidate.id)}</p>
					: <p className="skill-review-lead">{SKILL_REVIEW_LEAD}</p>}
				{nameLines}

				{/* The Scripts line moves here, so the Files section's Scripts row carries none. */}
				{scriptsLine && (
					<p className="skill-message skill-review-scripts">
						<span className="skill-review-scripts-text"><strong>{skillScriptsCount(scripts)}</strong> {scriptsLine}</span>
						<button type="button" className="rs-btn rs-btn-sm rs-btn-quiet" onClick={() => setRevealScripts((count) => count + 1)}>{SHOW_SCRIPTS}</button>
					</p>
				)}
				{candidate.outsidePath && <SkillOutsideLine path={candidate.outsidePath} className="skill-message skill-review-outside" />}

				{descriptionEditable && (
					<div className="skill-review-field">
						<label className="skill-review-field-label" htmlFor={`${fieldId}-field`}>{SKILL_DESCRIPTION_FIELD.label}</label>
						<input
							id={`${fieldId}-field`}
							type="text"
							className="skill-review-desc-input"
							value={description}
							placeholder="Always cite sources before answering."
							disabled={busy}
							aria-invalid={!descriptionValid}
							aria-describedby={`${fieldId}-help`}
							onChange={(e) => setDescription(e.target.value)}
						/>
						<div className="skill-field-foot">
							<span className="skill-field-help" id={`${fieldId}-help`}>{SKILL_DESCRIPTION_FIELD.help}</span>
							<span className={`skill-review-desc-counter${description.length > DESCRIPTION_MAX ? " over" : ""}`}>
								{description.length}/{DESCRIPTION_MAX}
							</span>
						</div>
					</div>
				)}

				<div className="settings-rows skill-review-facts">
					<SkillSourceRows source={candidate.source} license={candidate.license} version={candidate.version} />
					{files.length > 0 && <SkillFilesRow count={files.length} />}
				</div>

				<SkillWarnings findings={findings} />

				<div className="settings-group skill-review-section">
					<GroupHeader kicker="Instructions" />
					<SkillInstructions body={candidate.body} />
				</div>

				{listsFileKinds(files) && (
					<div className="settings-group skill-review-section">
						<GroupHeader kicker={SKILL_FILES_HEADING} />
						<SkillFilesByKind files={files} scriptsLine={null} revealScripts={revealScripts} />
					</div>
				)}

				{error && <div className="checkpoint-proposal-error skill-review-error skill-message skill-message-failed">{error}</div>}

				<div className="skill-review-actions">
					<button className="rs-btn rs-btn-quiet" disabled={busy} onClick={onCancel}>Cancel</button>
					{acceptButton}
				</div>
			</div>
		);
	}

	return (
		<div className="skill-review">
			<div className="skill-review-head">
				<div className="skill-review-title-block">
					<h2>{candidate.name || candidate.id}{candidate.disableModelInvocation && <SkillByHandTag />}</h2>
					{candidate.description && !descriptionEditable && <p className="skill-review-desc">{candidate.description}</p>}
				</div>
				<button className="rs-btn" onClick={onCancel} aria-label="Cancel">Cancel</button>
			</div>

			{replaces
				? <p className="skill-review-lead skill-review-replace">{replaceSkillQuestion(candidate.id)}</p>
				: <p className="skill-review-lead">{SKILL_REVIEW_LEAD}</p>}
			{nameLines}
			{candidate.outsidePath && <SkillOutsideLine path={candidate.outsidePath} className="skill-review-lead skill-review-outside" />}

			{descriptionEditable && (
				<label className="skill-review-field">
					<span className="skill-review-field-label">{SKILL_DESCRIPTION_LABEL}</span>
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
				<SkillSourceRows source={candidate.source} license={candidate.license} version={candidate.version} />
				{files.length > 0 && <SkillFilesRow count={files.length} />}
			</div>

			<SkillWarnings findings={findings} />

			<SkillFilesByKind files={files} scriptsLine={scriptsLine} />

			<div className="skill-review-body-label">Instructions</div>
			<SkillInstructions body={candidate.body} />

			{error && <div className="checkpoint-proposal-error skill-review-error">{error}</div>}

			<div className="skill-review-actions">
				<button className="rs-btn" disabled={busy} onClick={onCancel}>Cancel</button>
				{acceptButton}
			</div>
		</div>
	);
}
