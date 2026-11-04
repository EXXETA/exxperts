import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { rowShelfFileName, type AssetRowView } from "../assets-panel";
import { apiFetch } from "../api";
import { STAGED_IMAGE_EXTENSIONS } from "../composer-staging";
import { usePhoneWidth } from "../sidebar-collapse";
import { PLAIN_TEXT_PREVIEW_EXTENSIONS } from "../../../web-server/src/plain-text-preview";
import { fileDownloadUrl } from "./asset-viewer-footer";
import { resolveRouteUrl } from "./ArtifactViewer";
import { BackArrowIcon, CloseIcon, DownloadIcon, PaperclipIcon, PencilIcon, TrashIcon } from "./icons";

/** Where a room's Attachments show: the panel beside the chat, or the gallery in place of it. */
export type AttachmentsView = "panel" | "gallery";

/** The room sidebar's entry, under Home and in Home's look: the name, and the count once there is one. */
export function AttachmentsEntry({ count, open, onClick }: { count: number; open: boolean; onClick: () => void }) {
	return (
		<button className="list-btn attachments-entry" aria-expanded={open} onClick={onClick}>
			<span>Attachments</span>
			{count > 0 && <span className="attachments-entry-count">{count}</span>}
		</button>
	);
}

type PreviewKind = "image" | "pdf" | "text" | "sheet" | "page";

function previewKind(extensionRaw: string): PreviewKind {
	const extension = extensionRaw.toLowerCase();
	if (STAGED_IMAGE_EXTENSIONS.has(extension)) return "image";
	if (extension === ".pdf") return "pdf";
	if (extension === ".xlsx") return "sheet";
	if (extension === ".md" || PLAIN_TEXT_PREVIEW_EXTENSIONS.has(extension)) return "text";
	return "page";
}

function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Previews are fetched and drawn once per version of a file and kept for the
// life of the page, so the cards can come and go without asking again. The
// cap bounds what a room full of PDFs holds; files are the truth, so an
// evicted preview is only drawn again.
const PREVIEWS_KEPT = 60;
const TEXT_PREVIEW_CHARS = 500;
const PDF_PREVIEW_WIDTH = 480;

function kept<T>(store: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
	const known = store.get(key);
	if (known) return known;
	const made = make().catch((error: unknown) => {
		store.delete(key);
		throw error;
	});
	store.set(key, made);
	if (store.size > PREVIEWS_KEPT) store.delete(store.keys().next().value as string);
	return made;
}

async function okResponse(url: string): Promise<Response> {
	const response = await apiFetch(url);
	if (!response.ok) throw new Error(`the file's route answered ${response.status}`);
	return response;
}

const textPreviews = new Map<string, Promise<string>>();

/** Reads no further than the card shows: a file can be many megabytes. */
async function firstLines(url: string): Promise<string> {
	const response = await okResponse(url);
	const reader = response.body?.getReader();
	if (!reader) return (await response.text()).slice(0, TEXT_PREVIEW_CHARS);
	const decoder = new TextDecoder();
	let text = "";
	while (text.length < TEXT_PREVIEW_CHARS) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	void reader.cancel();
	return text.slice(0, TEXT_PREVIEW_CHARS);
}

const pdfPreviews = new Map<string, Promise<HTMLCanvasElement | null>>();
// One PDF at a time: each takes a worker, and a room's cards ask together.
let pdfTurn: Promise<unknown> = Promise.resolve();

/**
 * The first page, drawn in the page by pdf.js, which loads with the first PDF
 * on show. The bytes come from the viewer's own route, through apiFetch, and
 * pdf.js only draws them: no eval, and no scripting, which lives in its viewer
 * layer that is not used here.
 */
async function drawFirstPage(url: string): Promise<HTMLCanvasElement | null> {
	const data = new Uint8Array(await (await okResponse(url)).arrayBuffer());
	const pdfjs = await import("pdfjs-dist");
	pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?worker&url")).default;
	const task = pdfjs.getDocument({ data, isEvalSupported: false });
	try {
		const page = await (await task.promise).getPage(1);
		const viewport = page.getViewport({ scale: PDF_PREVIEW_WIDTH / page.getViewport({ scale: 1 }).width });
		const canvas = document.createElement("canvas");
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		await page.render({ canvas, viewport }).promise;
		return canvas;
	} catch {
		// Its bytes came and pdf.js cannot draw them, a password say: asking again would change nothing.
		return null;
	} finally {
		await task.destroy();
	}
}

function firstPage(url: string): Promise<HTMLCanvasElement | null> {
	const drawn = pdfTurn.then(() => drawFirstPage(url));
	pdfTurn = drawn.catch(() => undefined);
	return drawn;
}

/** A plain drawn page for what the page cannot show yet: lines, or a grid for a spreadsheet. */
// The menu opens upward over its card, out of sight on a card at the top of the list: bring
// the whole card into view. One function for every render, because a new ref callback would
// run again and undo the person's scrolling.
function showOpenedMenu(menu: HTMLDivElement | null): void {
	(menu?.closest(".att-card") ?? menu)?.scrollIntoView({ block: "nearest" });
}

function DrawnPage({ sheet }: { sheet: boolean }) {
	return (
		<span className={`att-drawn${sheet ? " att-drawn-sheet" : ""}`} aria-hidden="true">
			{Array.from({ length: sheet ? 16 : 7 }, (_, index) => <i key={index} />)}
		</span>
	);
}

type Loaded = { kind: "waiting" } | { kind: "text"; text: string } | { kind: "page"; canvas: HTMLCanvasElement } | { kind: "failed" };

function AttachmentPreview({ row, roomId }: { row: AssetRowView; roomId?: string }) {
	const artifact = row.artifacts[0];
	const previewedAs = previewKind(artifact?.extension ?? "");
	const resolved = artifact ? resolveRouteUrl(row.taskId, artifact.relativePath, roomId) : null;
	const url = resolved && "url" in resolved ? resolved.url : null;
	const version = `${url}#${artifact?.bytes}#${row.generatedAt}`;
	const fetched = url !== null && (previewedAs === "pdf" || previewedAs === "text");
	const paperRef = useRef<HTMLSpanElement | null>(null);
	const [onScreen, setOnScreen] = useState(false);
	const [loaded, setLoaded] = useState<Loaded>({ kind: "waiting" });
	// A card further down the list costs nothing until it is scrolled to.
	useEffect(() => {
		const paper = paperRef.current;
		if (!fetched || !paper) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) setOnScreen(true);
		});
		observer.observe(paper);
		return () => observer.disconnect();
	}, [fetched]);
	useEffect(() => {
		if (!url || !fetched || !onScreen) return;
		let gone = false;
		setLoaded({ kind: "waiting" });
		const asked: Promise<Loaded> = previewedAs === "pdf"
			? kept(pdfPreviews, version, () => firstPage(url)).then((canvas) => (canvas ? { kind: "page", canvas } : { kind: "failed" }))
			: kept(textPreviews, version, () => firstLines(url)).then((text) => ({ kind: "text", text }));
		void asked.catch((): Loaded => ({ kind: "failed" })).then((next) => { if (!gone) setLoaded(next); });
		return () => { gone = true; };
	}, [url, version, previewedAs, fetched, onScreen]);
	useEffect(() => {
		if (loaded.kind === "page") paperRef.current?.replaceChildren(loaded.canvas);
	}, [loaded]);
	if (url && previewedAs === "image") return <img className="att-image" src={url} alt="" loading="lazy" />;
	if (!fetched || loaded.kind === "failed") return <DrawnPage sheet={previewedAs === "sheet"} />;
	if (loaded.kind === "text") return <span className="att-paper att-paper-text">{loaded.text}</span>;
	return <span className="att-paper" ref={paperRef} />;
}

interface FileCardProps {
	row: AssetRowView;
	roomId?: string;
	selected: boolean;
	menuOpen: boolean;
	onToggleMenu: () => void;
	onCloseMenu: () => void;
	onOpen: (row: AssetRowView) => void;
	onDeleteFile: (row: AssetRowView, fileName: string) => void;
	onRenameFile: (row: AssetRowView, fileName: string, newName: string) => void;
	onRemove: (row: AssetRowView) => void;
}

function FileCard({ row, roomId, selected, menuOpen, onToggleMenu, onCloseMenu, onOpen, onDeleteFile, onRenameFile, onRemove }: FileCardProps) {
	const [draftName, setDraftName] = useState<string | null>(null);
	const fileName = rowShelfFileName(row);
	const artifact = row.artifacts[0];
	const resolved = artifact ? resolveRouteUrl(row.taskId, artifact.relativePath, roomId) : null;
	// A run with several files has no one file to take: its viewer lists them.
	const downloadUrl = resolved && "url" in resolved && row.artifacts.length === 1 ? fileDownloadUrl(resolved.url) : null;
	// A file a run is rewriting keeps its name and its place until the run ends.
	const fileVerbs = fileName !== null && !row.running;
	// Run rows that are not one shelf file keep today's list operation.
	const removable = fileName === null && !row.userFileName && !row.running;
	const commitRename = () => {
		const draft = draftName?.trim() ?? "";
		setDraftName(null);
		if (fileName && draft && draft !== fileName) onRenameFile(row, fileName, draft);
	};
	return (
		<article className={`att-card${selected ? " sel" : ""}${row.orphan ? " orphan" : ""}`}>
			<button type="button" className="att-open" title={`Open ${row.title}`} onClick={() => onOpen(row)}>
				<span className="att-preview">
					<AttachmentPreview row={row} roomId={roomId} />
				</span>
			</button>
			{(downloadUrl !== null || fileVerbs || removable) && (
				<button type="button" className="att-more" aria-label={`More for ${row.title}`} aria-expanded={menuOpen} title="Download, rename or delete" onClick={onToggleMenu}>
					<span aria-hidden="true">⋯</span>
				</button>
			)}
			<div className="att-foot">
				<div className="att-words">
					{draftName !== null ? (
						<input
							autoFocus
							className="assets-rename-input"
							value={draftName}
							aria-label={`New name for ${fileName}`}
							onFocus={(e) => e.target.select()}
							onChange={(e) => setDraftName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") { e.preventDefault(); commitRename(); }
								// Escape here ends the rename, not the panel around it.
								else if (e.key === "Escape") { e.stopPropagation(); setDraftName(null); }
							}}
							onBlur={commitRename}
						/>
					) : (
						<span className="att-name">{row.title}</span>
					)}
					<span className="att-meta">{row.iconLabel}{artifact ? ` · ${humanSize(artifact.bytes)}` : ""}</span>
					<span className="att-meta">
						{row.unread && <span className="assets-dot assets-dot-ready" aria-hidden="true" />}
						{row.failed && <span className="assets-dot assets-dot-failed" aria-hidden="true" />}
						{row.subline}
					</span>
				</div>
				{menuOpen && (
					<div className="att-menu" role="menu" ref={showOpenedMenu}>
						{downloadUrl && <a role="menuitem" href={downloadUrl} onClick={onCloseMenu}><DownloadIcon size={14} /> Download</a>}
						{fileVerbs && <button type="button" role="menuitem" onClick={() => { onCloseMenu(); setDraftName(fileName); }}><PencilIcon size={14} /> Rename</button>}
						{fileVerbs && <button type="button" role="menuitem" className="att-menu-delete" onClick={() => { onCloseMenu(); onDeleteFile(row, fileName); }}><TrashIcon size={14} /> Delete</button>}
						{removable && <button type="button" role="menuitem" title="Remove from the list. Its files are kept." onClick={() => { onCloseMenu(); onRemove(row); }}><CloseIcon size={14} /> Remove from the list</button>}
					</div>
				)}
			</div>
		</article>
	);
}

interface Props {
	view: AttachmentsView;
	rows: AssetRowView[];
	roomId?: string;
	selectedTaskId: string | null;
	onOpen: (row: AssetRowView) => void;
	onClose: () => void;
	onShowView: (view: AttachmentsView) => void;
	onDeleteFile: (row: AssetRowView, fileName: string) => void;
	onRenameFile: (row: AssetRowView, fileName: string, newName: string) => void;
	onRemove: (row: AssetRowView) => void;
	onAddFiles: (files: File[]) => void;
	/** Where the cards were scrolled: they unmount while a file takes their place. */
	scrollTop: MutableRefObject<number>;
}

/** One room's attachments as cards, each a preview, its name, size and when, and the file verbs behind ⋯. */
export function AttachmentsBrowser({ view, rows, roomId, selectedTaskId, onOpen, onClose, onShowView, onDeleteFile, onRenameFile, onRemove, onAddFiles, scrollTop }: Props) {
	const phone = usePhoneWidth();
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const addInputRef = useRef<HTMLInputElement | null>(null);
	const gridRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		if (gridRef.current) gridRef.current.scrollTop = scrollTop.current;
	}, [scrollTop]);
	useEffect(() => {
		if (!menuFor) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!(event.target instanceof Element) || !event.target.closest(".att-menu, .att-more")) setMenuFor(null);
		};
		// Before the room's own Escape, which would close the whole pane: one Escape, one layer.
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			setMenuFor(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [menuFor]);
	const addButton = (
		<button type="button" className="att-add" onClick={() => addInputRef.current?.click()}>
			<PaperclipIcon size={14} /> Attach a file
		</button>
	);
	return (
		<>
			{view === "panel" && <div className="att-backdrop" onClick={onClose} aria-hidden="true" />}
			<section className={`attachments-browser attachments-${view}`} aria-label="Attachments">
				<header className="att-head">
					{view === "gallery" && (
						<button type="button" className="att-icon" onClick={() => onShowView("panel")} aria-label="Back to the conversation" title="Back to the conversation">
							<BackArrowIcon />
						</button>
					)}
					<h2 className="att-title">Attachments</h2>
					{rows.length > 0 && <span className="att-count">{rows.length}</span>}
					<span className="att-spacer" aria-hidden="true" />
					{rows.length > 0 && addButton}
					{view === "panel" && !phone && rows.length > 0 && (
						<button type="button" className="artifact-viewer-icon" onClick={() => onShowView("gallery")} aria-label="Show as a gallery" title="Show as a gallery">⤢</button>
					)}
					{view === "panel" && (
						<button type="button" className="artifact-viewer-close" onClick={onClose} aria-label="Close attachments" title="Close">
							<CloseIcon size={16} />
						</button>
					)}
				</header>
				<input
					ref={addInputRef}
					type="file"
					multiple
					className="composer-attach-input"
					onChange={(e) => {
						onAddFiles(Array.from(e.target.files ?? []));
						e.target.value = "";
					}}
				/>
				{rows.length === 0 ? (
					<div className="att-empty">
						<span className="att-empty-tile" aria-hidden="true"><PaperclipIcon size={22} /></span>
						<p className="att-empty-title">No attachments yet</p>
						<p className="att-empty-line">{phone ? "The room can read what you attach here, in any conversation." : "Drop a file anywhere in the room. It can read what you attach, in any conversation."}</p>
						{addButton}
					</div>
				) : (
					<div className="att-grid" ref={gridRef} onScroll={(e) => { scrollTop.current = e.currentTarget.scrollTop; }}>
						{rows.map((row) => (
							<FileCard
								key={row.taskId}
								row={row}
								{...(roomId ? { roomId } : {})}
								selected={row.taskId === selectedTaskId}
								menuOpen={menuFor === row.taskId}
								onToggleMenu={() => setMenuFor((open) => (open === row.taskId ? null : row.taskId))}
								onCloseMenu={() => setMenuFor(null)}
								onOpen={onOpen}
								onDeleteFile={onDeleteFile}
								onRenameFile={onRenameFile}
								onRemove={onRemove}
							/>
						))}
					</div>
				)}
			</section>
		</>
	);
}
