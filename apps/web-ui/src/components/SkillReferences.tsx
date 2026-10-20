import { useMemo, useState } from "react";
import type { SkillReference, SkillFilePreviewData } from "../skills-repo-api";
import { RsInfo } from "./rs-info";
import { SkillFileButton } from "./SkillFileButton";
import { skillReferenceVersion } from "../skill-source-copy";

export function SkillReferences({ references, onDownload, stored = false, onPreview }: { references: SkillReference[]; onDownload?: (path: string) => Promise<void>; stored?: boolean; onPreview?: (path: string) => Promise<SkillFilePreviewData> }) {
	const [busyPath, setBusyPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const version = useMemo(() => skillReferenceVersion(references), [references]);

	async function download(path: string) {
		if (!onDownload) return;
		setBusyPath(path);
		setError(null);
		try {
			await onDownload(path);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyPath(null);
		}
	}

	const row = (reference: SkillReference) => {
		const load = onPreview ?? (reference.preview !== undefined ? async () => ({ ...reference, text: reference.preview }) : undefined);
		return (
			<div className="skill-reference" key={reference.path}>
				{load ? <SkillFileButton key={reference.path} path={reference.path} label={reference.path.split("/").pop()} description={reference.description} referencePaths={references.map((entry) => entry.path)} showLocalCopy={stored} load={load} /> : <div><span className="settings-row-label skill-reference-path" title={reference.path}>{reference.path.split("/").pop()}</span>{reference.description && <p className="settings-row-sub skill-reference-description">{reference.description}</p>}</div>}
				{!stored && onDownload && <button className="rs-btn" disabled={busyPath !== null} onClick={() => void download(reference.path)}>{busyPath === reference.path ? "Downloading…" : "Download for review"}</button>}
			</div>
		);
	};
	return (
		<div className="skill-references" key={version}>
			<div className="skill-reference-heading"><span className="settings-group-kicker">{stored ? "Local reference files" : "Selected references"}</span>{references.length > 0 && <RsInfo text={stored ? "These files are saved locally. Rooms read their approved copies. Click a file name or Show local copy to preview it; click again to close." : "Accepting the reviewed package saves these selected files. Click a file name to preview it. Previews do not import files or run scripts."} />}</div>
			{references.length === 0 && <p className="cli-note">No reference files selected.</p>}
			{references.map(row)}
			{error && <div className="checkpoint-proposal-error">{error}</div>}
		</div>
	);
}
