// Browse featured sources: the skills of the curated server-side source list
// (config-only to extend), one group per source, one row per skill with its
// description, licence and one Add, which enters the same review seam as the
// paste-a-URL flow, using the source's checkout token. In the new settings
// look each row puts the licence in a column of its own before Add.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { skillTooBigLine } from "../skill-source-copy";
import { replaceRefusedSinceReview } from "../skills-api";
import { fetchFeaturedSources, fetchRepoCandidate, importRepoSkill, licenseLabel, repoCandidateToSkillCandidate, sharesName, skillCardDescription, type FeaturedSourceResult, type RepoFoundSkill, type RepoSkillCandidate } from "../skills-repo-api";
import { GroupHeader } from "./pane-header";
import { SkillReview } from "./SkillReview";
import { useSettingsLookNext } from "../settings-look";

interface ReviewTarget {
	source: string;
	token: string;
	skill: RepoFoundSkill;
}

/** A skill added from Browse, by its source and folder: another of its name stays addable. */
function addedKey(source: string, skill: RepoFoundSkill): string {
	return `${source}\n${skill.path}`;
}

/** `back` is the page's way back, which the open review's title line carries in the new look. */
export function SkillBrowseDirectory({ onImported, back }: { onImported?: (name: string, replaced: boolean) => void; back?: ReactNode }) {
	const lookNext = useSettingsLookNext();
	// In the new look a line whose class doesn't say its kind is a message with a red dot.
	const failedLine = (today: string) => lookNext ? `${today} skill-message skill-message-failed` : today;
	const [sources, setSources] = useState<FeaturedSourceResult[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [target, setTarget] = useState<ReviewTarget | null>(null);
	const [candidate, setCandidate] = useState<RepoSkillCandidate | null>(null);
	const [busy, setBusy] = useState(false);
	const [reviewError, setReviewError] = useState<string | null>(null);
	const [replaceRefused, setReplaceRefused] = useState(false);
	const [imported, setImported] = useState<string[]>([]);

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const result = await fetchFeaturedSources();
			setSources(result.sources);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => { void load(); }, [load]);

	const openReview = useCallback(async (source: string, token: string, skill: RepoFoundSkill) => {
		setTarget({ source, token, skill });
		setCandidate(null);
		setReviewError(null);
		setReplaceRefused(false);
		setBusy(true);
		try {
			setCandidate(await fetchRepoCandidate(token, skill.path));
		} catch (err) {
			setReviewError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, []);

	const accept = useCallback(async () => {
		if (!target) return;
		setBusy(true);
		setReviewError(null);
		try {
			// A skill of yours under its name: the review asked to replace it, and Replace says so.
			const replaced = candidate?.replaces === true;
			const res = await importRepoSkill(target.token, target.skill.path, candidate);
			const name = res.skill?.name ?? target.skill.name;
			setImported((prev) => [...prev, addedKey(target.source, target.skill)]);
			onImported?.(name, replaced);
			setTarget(null);
			setCandidate(null);
		} catch (err) {
			setReviewError(err instanceof Error ? err.message : String(err));
			setReplaceRefused(replaceRefusedSinceReview(err));
		} finally {
			setBusy(false);
		}
	}, [target, candidate, onImported]);

	if (loadError && lookNext) {
		return (
			<div className="skill-browse-retry">
				<div className={failedLine("skill-browse-error")}>
					{loadError}
					<button type="button" className="rs-btn rs-btn-sm" onClick={() => void load()}>Retry</button>
				</div>
			</div>
		);
	}
	if (loadError) {
		return (
			<div className="skill-browse-retry">
				<div className="skill-browse-error">{loadError}</div>
				<button type="button" className="rs-btn" onClick={() => void load()}>Retry</button>
			</div>
		);
	}
	if (!sources) return <div className="skill-browse-loading">Loading featured sources…</div>;

	if (target && candidate) {
		return <SkillReview candidate={repoCandidateToSkillCandidate(candidate)} onAccept={() => void accept()} onCancel={() => { setTarget(null); setCandidate(null); }} busy={busy} error={reviewError} replaceRefused={replaceRefused} back={back} />;
	}
	if (target) {
		return (
			<div className="skill-browse-retry">
				<div className="skill-browse-loading">Loading {target.skill.name}…</div>
				{reviewError && <div className={failedLine("skill-browse-error")}>{reviewError}</div>}
				<button type="button" className={lookNext ? "rs-btn rs-btn-quiet" : "rs-btn"} onClick={() => setTarget(null)}>Back</button>
			</div>
		);
	}

	// A tool this machine lacks fails every source the same way: say it once,
	// as the sentence it is, instead of once per source behind "Could not load".
	const missingTool = sources.find((source) => source.missingTool)?.error ?? null;
	return (
		<section className="skill-browse-directory">
			{missingTool && <div className={failedLine("skill-browse-source-warn")}>{missingTool}</div>}
			{sources.map((source) => (
				<div className="settings-group" key={source.source}>
					<GroupHeader kicker={source.author} line={source.source} />
					{source.error && !source.missingTool && <div className={failedLine("skill-browse-source-warn")}>{source.error}</div>}
					<div className="settings-rows">
						{source.skills.map((skill) => {
							const description = skillCardDescription(skill.description);
							const license = licenseLabel(skill.license);
							const done = imported.includes(addedKey(source.source, skill));
							const main = (
								<>
									<span className="settings-row-label">{skill.name}</span>
									{/* Two skills of one name: each shows its folder. */}
									{sharesName(source.skills, skill) && <span className="settings-row-sub">{skill.path}</span>}
									{/* A skill past the limit says so where its description is, and can't be added. */}
									{skill.tooBig
										? <span className="settings-row-sub">{skillTooBigLine(skill.tooBig)}</span>
										: <span className="settings-row-sub settings-row-clamp" title={description || undefined}>{description || "No description provided."}</span>}
								</>
							);
							// A skill past the limit can't be added, so its row offers no Add.
							const add = (buttonClass: string) => skill.tooBig ? null : done ? (
								<span className="settings-row-value" aria-label={`${skill.name} imported`}>Added</span>
							) : (
								<button
									type="button"
									className={buttonClass}
									title="Review and add"
									aria-label={`Review and add ${skill.name}`}
									onClick={() => source.token && void openReview(source.source, source.token, skill)}
									disabled={!source.token}
								>
									Add
								</button>
							);
							if (lookNext) {
								return (
									<div className="settings-row skill-browse-row" key={skill.path || skill.name}>
										<div className="settings-row-main">{main}</div>
										{/* A narrow line cuts a long licence with "…", so the whole line is its tip. */}
										<span className="skill-browse-license" title={`${license.text}${skill.hasBundledScripts ? " · scripts" : ""}`}>
											<span title={license.title}>{license.text}</span>
											{skill.hasBundledScripts ? " · scripts" : ""}
										</span>
										<span className="skill-browse-add">{add("rs-btn rs-btn-sm")}</span>
									</div>
								);
							}
							return (
								<div className="settings-row" key={skill.path || skill.name}>
									<div className="settings-row-main">
										{main}
										<span className="settings-row-sub">
											<span title={license.title}>{license.text}</span>
											{skill.hasBundledScripts ? " · scripts" : ""}
										</span>
									</div>
									{add("rs-btn")}
								</div>
							);
						})}
					</div>
				</div>
			))}
		</section>
	);
}
