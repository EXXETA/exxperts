// MR-4 — Import from repo (spec §3 path 3). Paste a git/GitHub URL → scanning →
// multi-select list of found skills → per selected skill, the shared review seam
// → accept imports (server persists with provenance via MR-1 machinery). Body
// rendering belongs to MR-3's review screen; this pane shows name/description/
// scripts-flag cards only.
import { useCallback, useState } from "react";
import { fetchRepoCandidate, importRepoSkill, licenseLabel, repoCandidateToSkillCandidate, scanRepo, skillCardDescription, type RepoFoundSkill, type RepoScanResponse, type RepoSkillCandidate } from "../skills-repo-api";
import { SkillReview } from "./SkillReview";

type Phase = "idle" | "scanning" | "list" | "reviewing";

export function SkillImportFromRepo({ onImported }: { onImported?: (name: string) => void }) {
	const [url, setUrl] = useState("");
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [scan, setScan] = useState<RepoScanResponse | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [queue, setQueue] = useState<RepoFoundSkill[]>([]);
	const [candidate, setCandidate] = useState<RepoSkillCandidate | null>(null);
	const [busy, setBusy] = useState(false);
	const [imported, setImported] = useState<string[]>([]);

	const runScan = useCallback(async () => {
		setError(null);
		setPhase("scanning");
		setScan(null);
		setSelected(new Set());
		setImported([]);
		try {
			const result = await scanRepo(url.trim());
			setScan(result);
			setPhase("list");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("idle");
		}
	}, [url]);

	const toggle = useCallback((path: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const startReview = useCallback(async () => {
		if (!scan) return;
		const chosen = scan.skills.filter((s) => selected.has(s.path));
		if (chosen.length === 0) return;
		setQueue(chosen);
		await loadCandidate(scan.token, chosen[0]);
	}, [scan, selected]);

	const loadCandidate = useCallback(async (token: string, skill: RepoFoundSkill) => {
		setError(null);
		setBusy(true);
		setPhase("reviewing");
		try {
			setCandidate(await fetchRepoCandidate(token, skill.path));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setCandidate(null);
		} finally {
			setBusy(false);
		}
	}, []);

	const advanceQueue = useCallback(async () => {
		const [, ...rest] = queue;
		setQueue(rest);
		setCandidate(null);
		if (rest.length > 0 && scan) {
			await loadCandidate(scan.token, rest[0]);
		} else {
			setPhase("list");
		}
	}, [queue, scan, loadCandidate]);

	const accept = useCallback(async () => {
		if (!scan || queue.length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const res = await importRepoSkill(scan.token, queue[0].path);
			const name = res.skill?.name ?? queue[0].name;
			setImported((prev) => [...prev, name]);
			onImported?.(name);
			await advanceQueue();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [scan, queue, advanceQueue, onImported]);

	return (
		<section className="skill-import-from-repo">
			<p className="ai-setup-copy skill-import-help">
				Paste a public GitHub repository URL. Every skill found gets an individual review before it enters your library.
			</p>
			<div className="skill-import-row">
				<input
					type="text"
					className="skill-import-url"
					value={url}
					placeholder="https://github.com/user/repo"
					onChange={(e) => setUrl(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) void runScan(); }}
					disabled={phase === "scanning"}
				/>
				<button type="button" className="landing-action" onClick={() => void runScan()} disabled={!url.trim() || phase === "scanning"}>
					{phase === "scanning" ? "Scanning…" : "Scan"}
				</button>
			</div>

			{phase === "scanning" && <div className="skill-import-loading">Scanning repository…</div>}

			{error && <div className="checkpoint-proposal-error">{error}</div>}

			{phase === "list" && scan && scan.skills.length === 0 && (
				<p className="cli-note">No SKILL.md skills found in this repository.</p>
			)}

			{phase === "list" && scan && scan.skills.length > 0 && (
				<div className="skill-import-found">
					<div className="skill-import-found-count">{scan.skills.length} skill{scan.skills.length === 1 ? "" : "s"} found in {scan.source}</div>
					{scan.skills.map((skill) => {
						const description = skillCardDescription(skill.description);
						const license = licenseLabel(skill.license);
						return (
							<label className="skill-import-option" key={skill.path || skill.name}>
								<input type="checkbox" checked={selected.has(skill.path)} onChange={() => toggle(skill.path)} disabled={imported.includes(skill.name)} />
								<span className="skill-import-option-main">
									<span className="skill-import-option-name">{skill.name}{imported.includes(skill.name) ? " ✓ imported" : ""}</span>
									{description ? (
										<span className="skill-import-option-desc">{description}</span>
									) : (
										<span className="skill-import-option-desc empty">No description provided.</span>
									)}
									<span className="skill-import-option-meta">
										<span title={license.title}>{license.text}</span>
										{skill.hasBundledScripts ? " · bundles scripts (won't run)" : ""}
									</span>
								</span>
							</label>
						);
					})}
					<div>
						<button type="button" className="landing-action" onClick={() => void startReview()} disabled={selected.size === 0}>
							Review {selected.size > 0 ? `${selected.size} ` : ""}selected
						</button>
					</div>
				</div>
			)}

			{phase === "reviewing" && candidate && (
				<div className="skill-import-found">
					<div className="skill-import-queue">{queue.length} to review</div>
					<SkillReview candidate={repoCandidateToSkillCandidate(candidate, candidate.name)} onAccept={() => void accept()} onCancel={() => void advanceQueue()} busy={busy} error={error} />
				</div>
			)}
		</section>
	);
}
