import { useMemo, type ReactNode } from "react";

export interface ArtifactRef {
	relativePath: string;
	extension: string;
}

interface Props {
	taskId: string;
	templateLabel: string;
	artifact: ArtifactRef;
	onClose: () => void;
	maximized: boolean;
	onToggleMaximize: () => void;
	/** Files UI slice: the room — routes user-added rows (`file:<name>`) through the room-files endpoint. */
	roomId?: string;
	/** Asset-panel mode (contract §2 rung 3): the asset's display title leads the header. */
	assetTitle?: string;
	/**
	 * Room-scoped history (2026-07-18): "From an earlier thread · Jul 12" for
	 * rows born in another conversation. One muted header line — the whole
	 * disclosure; attaching stays gate-free.
	 */
	originLine?: string;
	/** Multi-artifact tasks: sibling files, switchable from the header. */
	files?: ArtifactRef[];
	onSelectFile?: (file: ArtifactRef) => void;
	/**
	 * The action footer (files UI slice: Ask for changes primary left; the
	 * quiet snapshot actions right). The header carries only view chrome —
	 * open in new tab, maximize, close.
	 */
	footerSlot?: ReactNode;
	/**
	 * Bumped by the host when the bytes behind the CURRENT route change while
	 * the viewer is open (a revise rewrote files/<name> in place) — the route
	 * URL alone can't see that, so it folds into the frame key to force a
	 * refetch (the routes are no-store, so a remount always gets fresh bytes).
	 */
	reloadNonce?: number;
}

type RouteResolution = { url: string; segments: string[] } | { error: string };

// Turn a store-relative artifact path (tasks/<taskId>/<rest>) into the served
// route (/api/artifacts/<taskId>/<rest>). If the path is not owned by this
// taskId we return an error rather than guessing a URL — a mismatched prefix
// means the caller handed us something we cannot vouch for, and the viewer must
// never point its sandbox at an unverified path. Exported for the asset-panel
// footer, whose "Open in new tab" lives outside this component.
export function resolveRouteUrl(taskId: string, relativePath: string, roomId?: string): RouteResolution {
	// User-added rows (files UI slice) carry the synthetic `file:<name>` task id
	// and are served by the room-files endpoint — no task record exists for them.
	if (taskId.startsWith("file:") && roomId && relativePath.startsWith("files/")) {
		const name = relativePath.slice("files/".length);
		if (!name || name.includes("/") || name === "." || name === ".." || name.startsWith(".")) {
			return { error: "This file could not be located for preview." };
		}
		return { url: `/api/persistent-agents/${encodeURIComponent(roomId)}/files/${encodeURIComponent(name)}`, segments: [name] };
	}
	// Shelf-canonical rows (files core slice) carry `files/<name>` paths but
	// keep the task-scoped route: the server resolves the name from the owning
	// room's shelf, authorized by this task's ledger record.
	if (taskId && !taskId.startsWith("file:") && relativePath.startsWith("files/")) {
		const name = relativePath.slice("files/".length);
		if (!name || name.includes("/") || name === "." || name === ".." || name.startsWith(".")) {
			return { error: "This artifact could not be located for preview." };
		}
		return { url: `/api/artifacts/${encodeURIComponent(taskId)}/${encodeURIComponent(name)}`, segments: [name] };
	}
	const prefix = `tasks/${taskId}/`;
	if (!taskId || !relativePath.startsWith(prefix)) {
		return { error: "This artifact could not be located for preview." };
	}
	const rest = relativePath.slice(prefix.length);
	const segments = rest.split("/").filter(Boolean);
	if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) {
		return { error: "This artifact could not be located for preview." };
	}
	// Encode per segment so a name with spaces/unicode still resolves, while the
	// slashes that separate segments stay literal for the route's wildcard match.
	const url = `/api/artifacts/${encodeURIComponent(taskId)}/${segments.map(encodeURIComponent).join("/")}`;
	return { url, segments };
}

export function ArtifactViewer({ taskId, templateLabel, artifact, onClose, maximized, onToggleMaximize, roomId, assetTitle, originLine, files, onSelectFile, footerSlot, reloadNonce }: Props) {
	const extension = artifact.extension.toLowerCase();
	// Vocabulary: a user-added row is a "file" everywhere the chrome speaks —
	// "artifact" stays reserved for room-made task outputs.
	const isUserFile = taskId.startsWith("file:");
	const noun = isUserFile ? "file" : "artifact";
	const resolved = useMemo(() => resolveRouteUrl(taskId, artifact.relativePath, roomId), [taskId, artifact.relativePath, roomId]);
	const routeUrl = "url" in resolved ? resolved.url : null;

	// Remount the sandboxed frame whenever the artifact identity changes so a
	// previous document can never linger in a reused iframe (Preview.tsx pattern).
	// reloadNonce covers the other direction: same identity, new bytes.
	const frameKey = `${routeUrl ?? "no-artifact"}#${reloadNonce ?? 0}`;

	function openInTab() {
		if (!routeUrl) return;
		// noopener/noreferrer: the opened tab gets no handle back to this window and
		// no referrer, matching the route's own no-referrer + opaque-origin posture.
		window.open(routeUrl, "_blank", "noopener,noreferrer");
	}

	function renderBody() {
		if (!routeUrl) {
			return (
				<div className="artifact-viewer-error" role="alert">
					{"error" in resolved ? resolved.error : `This ${noun} could not be located for preview.`}
				</div>
			);
		}
		if (extension === ".svg" || extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".gif" || extension === ".webp") {
			// SVG is served as image/svg+xml but rendered here through <img>, which is
			// non-scriptable: script/foreignObject/event handlers in the SVG never run.
			// Raster images (user-added files) share the same non-scriptable path.
			return (
				<div className="artifact-viewer-body artifact-viewer-body-image">
					<img key={frameKey} className="artifact-viewer-image" src={routeUrl} alt={`${templateLabel} preview`} />
				</div>
			);
		}
		if (extension === ".pdf") {
			// Inline PDF preview (vision slice): the browser's own PDF viewer. The
			// frame is deliberately UNsandboxed — the sandbox attribute blocks the
			// PDF viewer plugin — which is safe because the route serves .pdf only
			// after sniffing %PDF- magic, as application/pdf with nosniff: the
			// response can never become a scriptable HTML document.
			return (
				<div className="artifact-viewer-body artifact-viewer-body-frame">
					<iframe
						key={frameKey}
						className="artifact-viewer-frame"
						src={routeUrl}
						title={`${templateLabel} document`}
						loading="eager"
						referrerPolicy="no-referrer"
					/>
				</div>
			);
		}
		if (extension === ".html" || extension === ".md" || extension === ".txt" || extension === ".csv" || extension === ".json") {
			// sandbox="" is DELIBERATE and intentionally stricter than the route's CSP
			// (which allows scripts): every v1 template's HTML is static by construction
			// (deterministic decks are script-free; charts/documents are declared no-JS),
			// so no capability needs granting here. NEVER add allow-same-origin — that
			// would hand the frame this origin's cookies/storage and same-origin fetch.
			// .md (and the plain-text user-file types .txt/.csv/.json) are served as
			// text/plain, so they render as inert source in the frame.
			return (
				<div className="artifact-viewer-body artifact-viewer-body-frame">
					<iframe
						key={frameKey}
						className="artifact-viewer-frame"
						sandbox=""
						src={routeUrl}
						title={`${templateLabel} artifact`}
						loading="eager"
						referrerPolicy="no-referrer"
					/>
				</div>
			);
		}
		return (
			<div className="artifact-viewer-error" role="alert">
				This {noun} type cannot be previewed.
			</div>
		);
	}

	return (
		<aside className={`artifact-viewer${maximized ? " artifact-viewer-maximized" : ""}`} aria-label={isUserFile ? "File viewer" : "Artifact viewer"}>
			{/* Provenance chrome: app-drawn header the artifact cannot forge. It names
			    the producing template and asserts the sandbox — deliberately NO task
			    ids appear here. */}
			<header className="artifact-viewer-head">
				<div className="artifact-viewer-provenance">
					{/* The sandbox assertion moved from a visible badge into this tooltip:
					    it is provenance for the curious, not action-relevant status. The
					    hidden span keeps it announced for assistive tech. */}
					<div className="artifact-viewer-kicker" title="Rendered inside a locked-down sandbox">
						{assetTitle ? templateLabel : noun}
						<span className="artifact-viewer-sr-note">, rendered inside a locked-down sandbox</span>
					</div>
					<div className="artifact-viewer-template" title={assetTitle ?? templateLabel}>{assetTitle ?? templateLabel}</div>
					{originLine && <div className="artifact-viewer-origin">{originLine}</div>}
				</div>
				<div className="artifact-viewer-head-right">
					<div className="artifact-viewer-actions">
						{/* View chrome only (files UI slice): open in a new tab beside
						    maximize — file ACTIONS live in the footer. */}
						<button
							type="button"
							className="artifact-viewer-icon"
							onClick={openInTab}
							disabled={!routeUrl}
							aria-label="Open in a new tab"
							title="Open in a new browser tab"
						>
							⧉
						</button>
						<button
							type="button"
							className="artifact-viewer-icon"
							onClick={onToggleMaximize}
							aria-pressed={maximized}
							aria-label={maximized ? "Restore panel size" : "Maximize panel"}
							title={maximized ? "Restore panel size" : "Maximize panel"}
						>
							{maximized ? "⤡" : "⤢"}
						</button>
						<button
							type="button"
							className="artifact-viewer-close"
							onClick={onClose}
							aria-label={isUserFile ? "Close file viewer" : "Close artifact viewer"}
						>
							✕
						</button>
					</div>
				</div>
			</header>
			{files && files.length > 1 && (
				<div className="artifact-viewer-files" role="tablist" aria-label="Files in this task">
					{files.map((file) => {
						const name = file.relativePath.split("/").pop() ?? file.relativePath;
						const active = file.relativePath === artifact.relativePath;
						return (
							<button
								key={file.relativePath}
								type="button"
								role="tab"
								aria-selected={active}
								className={`artifact-viewer-file${active ? " active" : ""}`}
								onClick={() => !active && onSelectFile?.(file)}
								title={file.relativePath}
							>
								{name}
							</button>
						);
					})}
				</div>
			)}
			{renderBody()}
			{footerSlot && <div className="artifact-viewer-foot">{footerSlot}</div>}
		</aside>
	);
}
