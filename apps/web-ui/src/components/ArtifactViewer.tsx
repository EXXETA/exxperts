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
	onSaveToWorkspace: () => void;
	maximized: boolean;
	onToggleMaximize: () => void;
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
	 * Asset-panel mode: the done-card action footer (Add to conversation ·
	 * Save to workspace · Ask for changes · Open in new tab). When present, the header
	 * keeps only chrome (maximize/close) — actions live in the footer, per
	 * the approved mockup.
	 */
	footerSlot?: ReactNode;
}

type RouteResolution = { url: string; segments: string[] } | { error: string };

// Turn a store-relative artifact path (tasks/<taskId>/<rest>) into the served
// route (/api/artifacts/<taskId>/<rest>). If the path is not owned by this
// taskId we return an error rather than guessing a URL — a mismatched prefix
// means the caller handed us something we cannot vouch for, and the viewer must
// never point its sandbox at an unverified path. Exported for the asset-panel
// footer, whose "Open in new tab" lives outside this component.
export function resolveRouteUrl(taskId: string, relativePath: string): RouteResolution {
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

export function ArtifactViewer({ taskId, templateLabel, artifact, onClose, onSaveToWorkspace, maximized, onToggleMaximize, assetTitle, originLine, files, onSelectFile, footerSlot }: Props) {
	const extension = artifact.extension.toLowerCase();
	const resolved = useMemo(() => resolveRouteUrl(taskId, artifact.relativePath), [taskId, artifact.relativePath]);
	const routeUrl = "url" in resolved ? resolved.url : null;

	// Remount the sandboxed frame whenever the artifact identity changes so a
	// previous document can never linger in a reused iframe (Preview.tsx pattern).
	const frameKey = routeUrl ?? "no-artifact";

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
					{"error" in resolved ? resolved.error : "This artifact could not be located for preview."}
				</div>
			);
		}
		if (extension === ".svg") {
			// SVG is served as image/svg+xml but rendered here through <img>, which is
			// non-scriptable: script/foreignObject/event handlers in the SVG never run.
			return (
				<div className="artifact-viewer-body artifact-viewer-body-image">
					<img className="artifact-viewer-image" src={routeUrl} alt={`${templateLabel} preview`} />
				</div>
			);
		}
		if (extension === ".html" || extension === ".md") {
			// sandbox="" is DELIBERATE and intentionally stricter than the route's CSP
			// (which allows scripts): every v1 template's HTML is static by construction
			// (deterministic decks are script-free; charts/documents are declared no-JS),
			// so no capability needs granting here. NEVER add allow-same-origin — that
			// would hand the frame this origin's cookies/storage and same-origin fetch.
			// .md is served as text/plain, so it renders as inert source in the frame.
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
				This artifact type cannot be previewed.
			</div>
		);
	}

	return (
		<aside className={`artifact-viewer${maximized ? " artifact-viewer-maximized" : ""}`} aria-label="Artifact viewer">
			{/* Provenance chrome: app-drawn header the artifact cannot forge. It names
			    the producing template and asserts the sandbox — deliberately NO task
			    ids appear here. */}
			<header className="artifact-viewer-head">
				<div className="artifact-viewer-provenance">
					{/* The sandbox assertion moved from a visible badge into this tooltip:
					    it is provenance for the curious, not action-relevant status. The
					    hidden span keeps it announced for assistive tech. */}
					<div className="artifact-viewer-kicker" title="Rendered inside a locked-down sandbox">
						{assetTitle ? templateLabel : "artifact"}
						<span className="artifact-viewer-sr-note">, rendered inside a locked-down sandbox</span>
					</div>
					<div className="artifact-viewer-template" title={assetTitle ?? templateLabel}>{assetTitle ?? templateLabel}</div>
					{originLine && <div className="artifact-viewer-origin">{originLine}</div>}
				</div>
				<div className="artifact-viewer-head-right">
					<div className="artifact-viewer-actions">
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
						{!footerSlot && (
							<>
								<button
									type="button"
									className="artifact-viewer-quiet"
									onClick={openInTab}
									disabled={!routeUrl}
									title="Open this artifact in a new browser tab"
								>
									Open in new tab
								</button>
								<button
									type="button"
									className="artifact-viewer-action artifact-viewer-action-primary"
									onClick={onSaveToWorkspace}
									disabled={!routeUrl}
									title="Save a copy into this room's workspace folder"
								>
									Save to workspace
								</button>
							</>
						)}
						<button
							type="button"
							className="artifact-viewer-close"
							onClick={onClose}
							aria-label="Close artifact viewer"
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
