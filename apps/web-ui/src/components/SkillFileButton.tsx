import { createContext, useContext, useEffect, useState } from "react";
import type { SkillFilePreviewData } from "../skills-repo-api";
import { MarkdownRenderer } from "./Markdown";
import { SkillInstructions } from "./skill-instructions";
import { useEscapeKey } from "./use-escape-key";

export const SkillPreviewActive = createContext(true);

export function resolveRepositoryLink(from: string, href: string, referencePaths?: readonly string[]): string {
	if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href) || href.includes("\\")) throw new Error("This link is not a file in the repository.");
	const resolved = decodeURIComponent(new URL(href, `https://repository.invalid/${from.split("/").map(encodeURIComponent).join("/")}`).pathname.slice(1));
	const direct = decodeURIComponent(href.split(/[?#]/)[0]);
	return !referencePaths?.includes(resolved) && referencePaths?.includes(direct) ? direct : resolved;
}

function PdfPreview({ file }: { file: SkillFilePreviewData }) {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		const bytes = Uint8Array.from(atob(file.base64!), (value) => value.charCodeAt(0));
		const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
		setUrl(objectUrl);
		return () => URL.revokeObjectURL(objectUrl);
	}, [file]);
	return url ? <iframe className="skill-file-frame" src={url} title={file.path} referrerPolicy="no-referrer" /> : null;
}

/** The loader is called only by a user click, including links to another file. */
export function SkillFileButton({ path, label = path, description, showLocalCopy = false, load, disabled = false, body, foldable = false, referencePaths }: { path: string; label?: string; description?: string; showLocalCopy?: boolean; load: (path: string) => Promise<SkillFilePreviewData>; disabled?: boolean; body?: string; foldable?: boolean; referencePaths?: readonly string[] }) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [file, setFile] = useState<SkillFilePreviewData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [source, setSource] = useState(false);
	const active = useContext(SkillPreviewActive);
	useEscapeKey(() => setOpen(false), open && active);
	async function read(target: string) {
		setOpen(true);
		setBusy(true);
		setFile(null);
		setError(null);
		setSource(false);
		try { setFile(await load(target)); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(false); }
	}
	function openLink(href: string, from = file?.path ?? path) {
		try { void read(resolveRepositoryLink(from, href, referencePaths)); }
		catch (err) { setOpen(true); setFile(null); setError(err instanceof Error ? err.message : String(err)); }
	}
	function toggle() {
		if (open) setOpen(false);
		else void read(path);
	}
	function renderFile() {
		if (!file) return null;
		if (file.text !== undefined) {
			if (source || !["markdown", "html", "svg"].includes(file.kind)) return <pre className="skill-reference-preview">{file.text}</pre>;
			if (file.kind === "markdown") return <div className="skill-doc"><MarkdownRenderer codeTokens onOpenReference={openLink}>{file.text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}</MarkdownRenderer></div>;
			return <iframe className="skill-file-frame" title={file.path} sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">${file.text}`} />;
		}
		if (file.kind === "images" && file.base64) return <img className="skill-file-image" src={`data:${file.mimeType};base64,${file.base64}`} alt={file.path} />;
		if (file.kind === "pdf" && file.base64) return <PdfPreview file={file} />;
		return <p className="cli-note">{file.kind} attachment · {file.size.toLocaleString()} bytes. No inline preview is available for this format.</p>;
	}
	return <div className="skill-file-open">
		{body !== undefined ? <SkillInstructions body={body} foldable={foldable} onOpenReference={(href) => openLink(href, path)} /> : <div className="skill-file-row">
			<div><button type="button" className="rs-text-btn skill-reference-path" title={path} aria-expanded={open} disabled={disabled || busy} onClick={toggle}>{label}</button>{description && <p className="settings-row-sub skill-reference-description">{description}</p>}</div>
			{showLocalCopy && <button type="button" className="rs-btn" aria-expanded={open} disabled={disabled || busy} onClick={toggle}>{open ? "Hide local copy" : "Show local copy"}</button>}
		</div>}
		{open && <section className="skill-file-preview" aria-label="File preview">
			<header><strong className="skill-reference-path">{file?.path || path}</strong><div>{file?.text !== undefined && ["markdown", "html", "svg"].includes(file.kind) && <button type="button" className="rs-btn" onClick={() => setSource(!source)}>{source ? "Rendered" : "Source"}</button>}<button type="button" className="rs-btn" onClick={() => setOpen(false)}>Close preview</button></div></header>
			{busy && <p role="status" className="cli-note">Opening file…</p>}
			{error && <p role="alert" className="checkpoint-proposal-error">{error}</p>}
			{renderFile()}
		</section>}
	</div>;
}
