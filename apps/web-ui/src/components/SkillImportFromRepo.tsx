// Adding skills from a repository address. Paste a git or GitHub address, scan
// it, pick from the skills found (each its name and description), then each
// picked skill goes through the shared review before it is added. Body
// rendering belongs to the review screen. In the new settings look each skill
// found is a row that opens its review, one at a time.
import { useCallback, useRef, useState, type ReactNode } from "react";
import { REPOSITORY_HELP, skillTooBigLine } from "../skill-source-copy";
import { replaceRefusedSinceReview, skillRefusalLine } from "../skills-api";
import { SkillByHandTag } from "./skill-facts";
import { fetchRepoCandidate, importRepoSkill, repoCandidateToSkillCandidate, scanRepo, sharesName, skillCardDescription, type RepoFoundSkill, type RepoScanResponse, type RepoSkillCandidate } from "../skills-repo-api";
import { useNeededFields } from "./settings-dialog";
import { SkillReview } from "./SkillReview";
import { useSettingsLookNext } from "../settings-look";
import { ChevronDownIcon } from "./icons";

type Phase = "idle" | "scanning" | "list" | "reviewing";

/** `back` is the page's way back, which the open review's title line carries in the new look. */
export function SkillImportFromRepo({ onImported, back }: { onImported?: (name: string, replaced: boolean) => void; back?: ReactNode }) {
	const lookNext = useSettingsLookNext();
	const [url, setUrl] = useState("");
	const urlRef = useRef<HTMLInputElement | null>(null);
	const needed = useNeededFields();
	const urlNeeded = needed.field("url", url);
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [scan, setScan] = useState<RepoScanResponse | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [queue, setQueue] = useState<RepoFoundSkill[]>([]);
	const [candidate, setCandidate] = useState<RepoSkillCandidate | null>(null);
	const [busy, setBusy] = useState(false);
	const [replaceRefused, setReplaceRefused] = useState(false);
	// The folders added, so a skill of the same name in another folder stays pickable.
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

	/** In the new look Scan is never greyed for an empty field: the press marks it. */
	const pressScan = () => {
		if (lookNext ? needed.filled([[url, urlRef.current]]) : url.trim()) void runScan();
	};

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
		setReplaceRefused(false);
		setBusy(true);
		setPhase("reviewing");
		try {
			setCandidate(await fetchRepoCandidate(token, skill.path));
		} catch (err) {
			setError(skillRefusalLine(err));
			setCandidate(null);
		} finally {
			setBusy(false);
		}
	}, []);

	/** The new look's row: that skill's review, as a queue of one. */
	const reviewOne = useCallback(async (skill: RepoFoundSkill) => {
		if (!scan) return;
		setQueue([skill]);
		await loadCandidate(scan.token, skill);
	}, [scan, loadCandidate]);

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
			// A skill of yours under its name: the review asked to replace it, and Replace says so.
			const replaced = candidate?.replaces === true;
			const res = await importRepoSkill(scan.token, queue[0].path, candidate);
			const name = res.skill?.name ?? queue[0].name;
			setImported((prev) => [...prev, queue[0].path]);
			onImported?.(name, replaced);
			await advanceQueue();
		} catch (err) {
			setError(skillRefusalLine(err));
			setReplaceRefused(replaceRefusedSinceReview(err));
		} finally {
			setBusy(false);
		}
	}, [scan, queue, candidate, advanceQueue, onImported]);

	return (
		<section className="skill-import-from-repo">
			{lookNext
				? <p className="ai-setup-copy skill-import-help">{REPOSITORY_HELP.join(" ")}</p>
				: REPOSITORY_HELP.map((line) => <p key={line} className="ai-setup-copy skill-import-help">{line}</p>)}
			<div className="skill-import-row">
				<input
					type="text"
					className="skill-import-url"
					ref={urlRef}
					value={url}
					{...urlNeeded.props}
					placeholder="https://github.com/user/repo"
					onChange={(e) => setUrl(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") pressScan(); }}
					disabled={phase === "scanning"}
				/>
				{/* In the new look Scan is the page's main action until a scan has found skills, which are the way on after it. */}
				<button type="button" className={lookNext && scan && scan.skills.length > 0 ? "rs-btn" : "rs-btn rs-btn-primary"} onClick={pressScan} disabled={(!lookNext && !url.trim()) || phase === "scanning"}>
					{phase === "scanning" ? "Scanning…" : "Scan"}
				</button>
			</div>
			{urlNeeded.line}

			{phase === "scanning" && <div className="skill-import-loading">Scanning repository…</div>}

			{error && <div className={lookNext ? "checkpoint-proposal-error skill-message skill-message-failed" : "checkpoint-proposal-error"}>{error}</div>}

			{phase === "list" && scan && scan.skills.length === 0 && (
				<p className="cli-note">No SKILL.md skills found in this repository.</p>
			)}

			{lookNext && phase === "list" && scan && scan.skills.length > 0 && (
				<div className="skill-import-found">
					<div className="skill-import-found-count">{scan.skills.length} skill{scan.skills.length === 1 ? "" : "s"} found in {scan.source}</div>
					<div className="skill-import-rows">
						{scan.skills.map((skill) => {
							const description = skillCardDescription(skill.description);
							const added = imported.includes(skill.path);
							const main = (
								<span className="skill-import-option-main">
									{/* The name alone is cut with "…" on a narrow screen, so its tag and Added stay whole. */}
									<span className="skill-import-option-name"><span className="skill-import-option-name-text">{skill.name}</span>{skill.disableModelInvocation && <SkillByHandTag />}{added && <span className="skill-import-option-added">✓ Added</span>}</span>
									{/* Two skills of one name: each shows its folder. */}
									{sharesName(scan.skills, skill) && <span className="skill-import-option-desc">{skill.path}</span>}
									{/* A skill past the limit says why on its second line, whole, and opens nothing. */}
									{skill.tooBig ? (
										<span className="skill-import-option-desc skill-import-too-big">{skillTooBigLine(skill.tooBig)}</span>
									) : description ? (
										<span className="skill-import-option-desc" title={description}>{description}</span>
									) : (
										<span className="skill-import-option-desc empty">No description provided.</span>
									)}
								</span>
							);
							if (added || skill.tooBig) return <div className="skill-import-option" key={skill.path || skill.name}>{main}</div>;
							return (
								<button type="button" className="skill-import-option" key={skill.path || skill.name} onClick={() => void reviewOne(skill)}>
									{main}
									<span className="skill-import-chevron" aria-hidden="true"><ChevronDownIcon size={16} /></span>
								</button>
							);
						})}
					</div>
				</div>
			)}

			{!lookNext && phase === "list" && scan && scan.skills.length > 0 && (
				<div className="skill-import-found">
					<div className="skill-import-found-count">{scan.skills.length} skill{scan.skills.length === 1 ? "" : "s"} found in {scan.source}</div>
					{scan.skills.map((skill) => {
						const description = skillCardDescription(skill.description);
						const added = imported.includes(skill.path);
						return (
							<label className="skill-import-option" key={skill.path || skill.name}>
								<input type="checkbox" checked={selected.has(skill.path)} onChange={() => toggle(skill.path)} disabled={added || Boolean(skill.tooBig)} />
								<span className="skill-import-option-main">
									<span className="skill-import-option-name">{skill.name}{skill.disableModelInvocation && <SkillByHandTag />}{added ? " ✓ Added" : ""}</span>
									{/* Two skills of one name: each shows its folder. */}
									{sharesName(scan.skills, skill) && <span className="skill-import-option-desc">{skill.path}</span>}
									{/* A skill past the limit says so where its description is, and can't be picked. */}
									{skill.tooBig ? (
										<span className="skill-import-option-desc">{skillTooBigLine(skill.tooBig)}</span>
									) : description ? (
										<span className="skill-import-option-desc">{description}</span>
									) : (
										<span className="skill-import-option-desc empty">No description provided.</span>
									)}
								</span>
							</label>
						);
					})}
					<div>
						<button type="button" className="rs-btn rs-btn-primary" onClick={() => void startReview()} disabled={selected.size === 0}>
							Review {selected.size > 0 ? `${selected.size} ` : ""}selected
						</button>
					</div>
				</div>
			)}

			{phase === "reviewing" && candidate && (
				<div className="skill-import-found">
					{/* The new look reviews one skill at a time, so there is no queue to count. */}
					{!lookNext && <div className="skill-import-queue">{queue.length} to review</div>}
					<SkillReview candidate={repoCandidateToSkillCandidate(candidate)} onAccept={() => void accept()} onCancel={() => void advanceQueue()} busy={busy} error={error} replaceRefused={replaceRefused} back={back} />
				</div>
			)}
		</section>
	);
}
