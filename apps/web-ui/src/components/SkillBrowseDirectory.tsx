// MR-4 — Browse featured sources (spec §3 Browse, locked). A directory-style grid
// of skills from the curated server-side source list (config-only to extend).
// Cards show name/description/author(source); a "+" enters the same review seam
// as the paste-a-URL flow, using the featured card's checkout token.
import { useCallback, useEffect, useState } from "react";
import { fetchFeaturedSources, fetchRepoCandidate, importRepoSkill, licenseLabel, repoCandidateToSkillCandidate, skillCardDescription, type FeaturedSourceResult, type RepoFoundSkill, type RepoSkillCandidate } from "../skills-repo-api";
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
				<button type="button" className="inline-action" onClick={() => void load()}>Retry</button>
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
				<button type="button" className="inline-action" onClick={() => setTarget(null)}>Back</button>
			</div>
		);
	}

	return (
		<section className="skill-browse-directory">
			{sources.map((source) => (
				<div className="skill-browse-source" key={source.source}>
					<div className="skill-browse-source-head">
						<strong>{source.author}</strong>
						<span className="skill-browse-source-repo">{source.source}</span>
					</div>
					{source.error && <div className="skill-browse-source-warn">Could not load: {source.error}</div>}
					<div className="skill-browse-grid">
						{source.skills.map((skill) => {
							const description = skillCardDescription(skill.description);
							const license = licenseLabel(skill.license);
							const done = imported.includes(skill.name);
							return (
								<div className="skill-card" key={skill.path || skill.name}>
									<div className="skill-card-head">
										<span className="skill-card-name">{skill.name}</span>
										<button
											type="button"
											className="skill-card-import"
											title={done ? "Imported" : "Review & import"}
											aria-label={done ? `${skill.name} imported` : `Review and import ${skill.name}`}
											onClick={() => source.token && void openReview(source.token, skill)}
											disabled={!source.token || done}
										>
											{done ? "✓" : "+"}
										</button>
									</div>
									{description ? (
										<span className="skill-card-desc">{description}</span>
									) : (
										<span className="skill-card-desc empty">No description provided.</span>
									)}
									<span className="skill-card-meta">
										<span title={license.title}>{license.text}</span>
										{skill.hasBundledScripts ? " · scripts" : ""}
									</span>
								</div>
							);
						})}
					</div>
				</div>
			))}
		</section>
	);
}
