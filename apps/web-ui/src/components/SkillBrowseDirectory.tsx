// Browse featured sources: the skills of the curated server-side source list
// (config-only to extend), one group per source, one row per skill with its
// description, licence and one Add, which enters the same review seam as the
// paste-a-URL flow, using the source's checkout token.
import { useCallback, useEffect, useState } from "react";
import { fetchFeaturedSources, fetchRepoCandidate, importRepoSkill, licenseLabel, repoCandidateToSkillCandidate, skillCardDescription, type FeaturedSourceResult, type RepoFoundSkill, type RepoSkillCandidate } from "../skills-repo-api";
import { GroupHeader } from "./pane-header";
import { SkillReview } from "./SkillReview";

interface ReviewTarget {
	token: string;
	skill: RepoFoundSkill;
}

export function SkillBrowseDirectory({ onImported }: { onImported?: (name: string) => void }) {
	const [sources, setSources] = useState<FeaturedSourceResult[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [target, setTarget] = useState<ReviewTarget | null>(null);
	const [candidate, setCandidate] = useState<RepoSkillCandidate | null>(null);
	const [busy, setBusy] = useState(false);
	const [reviewError, setReviewError] = useState<string | null>(null);
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

	const openReview = useCallback(async (token: string, skill: RepoFoundSkill) => {
		setTarget({ token, skill });
		setCandidate(null);
		setReviewError(null);
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
			const res = await importRepoSkill(target.token, target.skill.path);
			const name = res.skill?.name ?? target.skill.name;
			setImported((prev) => [...prev, name]);
			onImported?.(name);
			setTarget(null);
			setCandidate(null);
		} catch (err) {
			setReviewError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [target, onImported]);

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
		return <SkillReview candidate={repoCandidateToSkillCandidate(candidate, target.skill.name)} onAccept={() => void accept()} onCancel={() => { setTarget(null); setCandidate(null); }} busy={busy} error={reviewError} />;
	}
	if (target) {
		return (
			<div className="skill-browse-retry">
				<div className="skill-browse-loading">Loading {target.skill.name}…</div>
				{reviewError && <div className="skill-browse-error">{reviewError}</div>}
				<button type="button" className="rs-btn" onClick={() => setTarget(null)}>Back</button>
			</div>
		);
	}

	return (
		<section className="skill-browse-directory">
			{sources.map((source) => (
				<div className="settings-group" key={source.source}>
					<GroupHeader kicker={source.author} line={source.source} />
					{source.error && <div className="skill-browse-source-warn">Could not load: {source.error}</div>}
					<div className="settings-rows">
						{source.skills.map((skill) => {
							const description = skillCardDescription(skill.description);
							const license = licenseLabel(skill.license);
							const done = imported.includes(skill.name);
							return (
								<div className="settings-row" key={skill.path || skill.name}>
									<div className="settings-row-main">
										<span className="settings-row-label">{skill.name}</span>
										<span className="settings-row-sub settings-row-clamp" title={description || undefined}>{description || "No description provided."}</span>
										<span className="settings-row-sub">
											<span title={license.title}>{license.text}</span>
											{skill.hasBundledScripts ? " · scripts" : ""}
										</span>
									</div>
									{done ? (
										<span className="settings-row-value" aria-label={`${skill.name} imported`}>Added</span>
									) : (
										<button
											type="button"
											className="rs-btn"
											title="Review and add"
											aria-label={`Review and add ${skill.name}`}
											onClick={() => source.token && void openReview(source.token, skill)}
											disabled={!source.token}
										>
											Add
										</button>
									)}
								</div>
							);
						})}
					</div>
				</div>
			))}
		</section>
	);
}
