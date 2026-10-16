import { useEffect, useId, useState } from "react";
import { defaultRepoPolicy, type ReferenceKind, type RepoPolicy } from "../skills-repo-api";
import { RsInfo } from "./rs-info";

const OPTIONAL_TYPES: { kind: ReferenceKind; label: string }[] = [
	{ kind: "styles", label: "CSS / SCSS" },
	{ kind: "text", label: "Plain text / JSON data" },
	{ kind: "html", label: "HTML source" },
	{ kind: "svg", label: "SVG" },
	{ kind: "pdf", label: "PDF" },
	{ kind: "word", label: "Word" },
	{ kind: "excel", label: "Excel" },
	{ kind: "images", label: "Images" },
	{ kind: "fonts", label: "Fonts" },
];

function SkillReferenceFormats({ value, onChange, disabled = false }: { value: RepoPolicy; onChange: (policy: RepoPolicy, commit?: boolean) => void; disabled?: boolean }) {
	function toggleType(kind: ReferenceKind) {
		onChange({ ...value, allowedTypes: value.allowedTypes.includes(kind) ? value.allowedTypes.filter((item) => item !== kind) : [...value.allowedTypes, kind] }, true);
	}
	return value.designRepo ? <fieldset className="skill-reference-types" disabled={disabled}>
		<legend>Optional reference formats <RsInfo text="Only selected formats can be imported. Markdown remains available; scripts and programs stay excluded. Changing formats does not remove saved copies or grant rooms access to new content." /></legend>
		{OPTIONAL_TYPES.map(({ kind, label }) => <label className="skill-library-check" key={kind}>
			<input className="workspaces-tool-switch" type="checkbox" role="switch" checked={value.allowedTypes.includes(kind)} onChange={() => toggleType(kind)} />
			<span>{label}</span>
		</label>)}
	</fieldset> : null;
}

export function SkillRepoPolicy({ value, onChange, disabled = false }: { value: RepoPolicy; onChange: (policy: RepoPolicy, commit?: boolean) => void; disabled?: boolean }) {
	const entireRepository = value.referenceRoots.some((root) => root === "" || root.trim() === ".");
	const skillRootId = useId();
	const [rootsText, setRootsText] = useState(value.referenceRoots.join("\n"));
	useEffect(() => setRootsText(value.referenceRoots.join("\n")), [value.referenceRoots]);

	return (
		<div className="skill-repo-policy">
			<label className="skill-library-field" htmlFor={skillRootId}>
				<span>Find skills in (optional) <RsInfo text="Limits where SKILL.md instructions are discovered. The repository browser always shows the entire repository, including folders outside this directory." /></span>
				<input id={skillRootId} className="skill-import-url" value={value.skillRoot} placeholder="skills/" disabled={disabled} onChange={(event) => onChange({ ...value, skillRoot: event.target.value }, false)} onBlur={() => onChange(value, true)} />
			</label>
			<label className="skill-library-check">
				<input className="workspaces-tool-switch" role="switch" type="checkbox" checked={value.designRepo} disabled={disabled} onChange={(event) => onChange({ ...value, designRepo: event.target.checked, allowedTypes: event.target.checked ? value.allowedTypes : [...defaultRepoPolicy.allowedTypes] }, true)} />
				<span>Design repository — offer additional reference formats</span>
			</label>
			<SkillReferenceFormats value={value} onChange={onChange} disabled={disabled} />
			<label className="skill-library-check">
				<input className="workspaces-tool-switch" role="switch" type="checkbox" checked={entireRepository} disabled={disabled} onChange={(event) => onChange({ ...value, referenceRoots: event.target.checked ? ["."] : [] }, true)} />
				<span>Select references from the entire repository <RsInfo text="Choose references from any folder, including siblings of the skill directory. Only enabled formats can be selected; scripts and programs remain excluded. Files are saved only after selection and review, with their original repository paths preserved." /></span>
			</label>
			{!entireRepository && <label className="skill-library-field">
				<span>Shared reference directories (optional, one per line)</span>
				<textarea className="skill-import-url" rows={2} placeholder="shared/\nassets/\n_source-material/" value={rootsText} disabled={disabled} onChange={(event) => setRootsText(event.target.value)} onBlur={() => onChange({ ...value, referenceRoots: rootsText.split("\n").map((root) => root.trim()).filter(Boolean) }, true)} />
			</label>}
		</div>
	);
}
