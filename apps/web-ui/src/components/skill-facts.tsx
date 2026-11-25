import type { ReactNode } from "react";
import type { SkillFile, SkillRepositoryView, SkillScanFinding } from "../skills-api";
import { SKILL_BY_HAND_TAG, skillFilesAtLine, skillFilesLine, skillOutsideFolderLine, skillRefText, skillTierLabel } from "../skill-source-copy";
import { useRemoteClientContext } from "../remote-client-context";

const ADDRESS = /^https?:\/\//;

/** Where a skill came from, as words: an address without its scheme, or what
 *  the origin means. `tier` is the library's store tier, for a skill with no
 *  recorded origin; `short` gives the library table's few words for a tier. */
export function skillFromText(source: string | null | undefined, tier?: string, short = false): string {
	if (source && ADDRESS.test(source)) return source.replace(ADDRESS, "").replace(/\/$/, "");
	if (source === "local") return "Written here";
	if (source === "upload") return "Uploaded";
	if (source) return source;
	if (tier === "shared" && !short) return "~/.agents/skills, shared with other agent tools";
	return (tier && skillTierLabel(tier)) || tier || "Unknown";
}

/** Where a skill came from, in the words the skill page and the review share:
 *  an address is a link. */
export function SkillSourceValue({ source, tier }: { source: string | null | undefined; tier?: string }) {
	const text = skillFromText(source, tier);
	if (source && ADDRESS.test(source)) return <a className="skill-fact-link" href={source} target="_blank" rel="noreferrer">{text}</a>;
	return <>{text}</>;
}

/** The From row of a skill's page and of the review, naming the branch, tag or commit a skill from a repository follows, and License and Version when the skill states them. */
export function SkillSourceRows({ source, tier, license, version, repository }: { source: string | null | undefined; tier?: string; license: string | null | undefined; version: string | null | undefined; repository?: SkillRepositoryView }) {
	const licenseText = license?.trim() ?? "";
	const versionText = version?.trim() ?? "";
	const refText = repository ? skillRefText(repository.refKind, repository.ref) : null;
	return (
		<>
			<div className="settings-row">
				<span className="settings-row-label">From</span>
				<span className="settings-row-value skill-fact-value"><SkillSourceValue source={source} tier={tier} />{refText && <>, {refText}</>}</span>
			</div>
			{licenseText && (
				<div className="settings-row">
					<span className="settings-row-label">License</span>
					<span className="settings-row-value skill-fact-value">{licenseText}</span>
				</div>
			)}
			{versionText && (
				<div className="settings-row">
					<span className="settings-row-label">Version</span>
					<span className="settings-row-value skill-fact-value">{versionText}</span>
				</div>
			)}
		</>
	);
}

/**
 * The Files row: how many files a skill brings, its instructions included, when
 * rooms open them, and a line in its value column when given: where they are, or
 * why rooms use only its instructions.
 */
export function SkillFilesRow({ count, line }: { count?: number; line?: ReactNode }) {
	return (
		<div className="settings-row">
			<span className="settings-row-label">Files</span>
			{count !== undefined && <span className="settings-row-value skill-fact-value">{count === 1 ? "1 file" : `${count} files`}</span>}
			{line && <span className="settings-row-sub skill-fact-line">{line}</span>}
		</div>
	);
}

/**
 * Where a shared-folder skill's files are (`skillFilesAtLine`), its path breaking
 * only after a separator, "/" or a Windows "\": a folder's name stays whole, so a
 * hyphen in it never reads as a line's end. On its page and on a room's Skills page.
 */
export function SkillFilesAt({ place }: { place: string }) {
	const line = skillFilesAtLine(place);
	const at = line.indexOf(place);
	// Names and separators alternate: ["~", "/", "team-guides", "/", "travel-report"].
	const pieces = place.split(/([\\/])/);
	return (
		<>
			{line.slice(0, at)}
			{pieces.map((piece, i) => (i % 2 === 0 ? <span key={i} className="skill-path-part">{piece}</span> : <span key={i}>{piece}<wbr /></span>))}
			{line.slice(at + place.length)}
		</>
	);
}

/** The review's line on a skill whose instructions reach above its folder (`skillOutsideFolderLine`), its path as written set as code. */
export function SkillOutsideLine({ path, className }: { path: string; className: string }) {
	const line = skillOutsideFolderLine(path);
	const at = line.indexOf(path);
	return (
		<p className={className}>
			<span>{line.slice(0, at)}<code className="skill-outside-path">{path}</code>{line.slice(at + path.length)}</span>
		</p>
	);
}

/** Beside the name of a skill its author marked to start only by hand, wherever it is listed. */
export function SkillByHandTag() {
	return <span className="skill-tag">{SKILL_BY_HAND_TAG}</span>;
}

/** The hidden-character warning, shared by the review screen and a library skill's page. `before` names the step it comes before: accepting an add, or updating. */
export function SkillWarnings({ findings, before = "accepting" }: { findings: SkillScanFinding[]; before?: "accepting" | "updating" }) {
	return (
		<>
			{findings.length > 0 && (
				<div className="skill-review-banner danger" role="alert">
					<strong>{findings.length} hidden {findings.length === 1 ? "character" : "characters"} found.</strong>{" "}
					The instructions contain invisible or bidirectional characters, a common way to smuggle
					hidden instructions past a reader. Review carefully before {before}.
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
		</>
	);
}

/** The Scripts line's one explanation for a skill's scripts: on a shared server
 *  that they never run; on the computer that the assistant can run them, a skill
 *  marked for picking by hand included, whose folder opens while it is on, or,
 *  when the library item says so (`readOnly`), that a protected room there runs
 *  them only from a folder it can already open. */
export function useScriptsLine(files: SkillFile[], readOnly = false): string | null {
	const { sharedServer } = useRemoteClientContext();
	const scripts = files.filter((file) => file.kind === "scripts").length;
	if (scripts === 0) return null;
	if (sharedServer) return skillFilesLine("sharedServer", scripts);
	return skillFilesLine(readOnly ? "readOnly" : "run", scripts);
}
