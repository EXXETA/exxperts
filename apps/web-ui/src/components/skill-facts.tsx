import type { SkillScanFinding } from "../skills-api";

/** Where a skill came from, in the words the skill page and the review share:
 *  an address without its scheme (a link), or what the origin means. `tier`
 *  is the library's store tier, for a skill with no recorded origin. */
export function SkillSourceValue({ source, tier }: { source: string | null | undefined; tier?: string }) {
	if (source && /^https?:\/\//.test(source)) {
		return <a className="skill-fact-link" href={source} target="_blank" rel="noreferrer">{source.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a>;
	}
	if (source === "local") return <>Written here</>;
	if (source === "upload") return <>Uploaded</>;
	if (source) return <>{source}</>;
	if (tier === "builtin") return <>Built in</>;
	if (tier === "shared") return <>~/.agents/skills, shared with other agent tools</>;
	if (tier === "project") return <>This project</>;
	return <>{tier || "Unknown"}</>;
}

/** The Source and License rows of a skill's page and of the review. */
export function SkillSourceRows({ source, tier, license }: { source: string | null | undefined; tier?: string; license: string | null | undefined }) {
	const licenseText = license?.trim() ?? "";
	return (
		<>
			<div className="settings-row">
				<span className="settings-row-label">Source</span>
				<span className="settings-row-value skill-fact-value"><SkillSourceValue source={source} tier={tier} /></span>
			</div>
			<div className="settings-row">
				<span className="settings-row-label">License</span>
				<span className="settings-row-value skill-fact-value">{licenseText || <span className="skill-fact-warn">None declared</span>}</span>
			</div>
		</>
	);
}

/** The hidden-character warning, shared by the review screen and a library
 *  skill's page, and the unknown-license warning, which only the review
 *  passes `licenseKnown` for: there the person decides to add the skill,
 *  while the page says it in its License row. */
export function SkillWarnings({ licenseKnown, findings }: { licenseKnown?: boolean; findings: SkillScanFinding[] }) {
	return (
		<>
			{licenseKnown === false && (
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
		</>
	);
}
