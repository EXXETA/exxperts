import { useMemo } from "react";

interface ArtifactRef {
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
}

type RouteResolution = { url: string; segments: string[] } | { error: string };

// Turn a store-relative artifact path (tasks/<taskId>/<rest>) into the served
// route (/api/artifacts/<taskId>/<rest>). If the path is not owned by this
// taskId we return an error rather than guessing a URL — a mismatched prefix
// means the caller handed us something we cannot vouch for, and the viewer must
// never point its sandbox at an unverified path.
function resolveRouteUrl(taskId: string, relativePath: string): RouteResolution {
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

export function ArtifactViewer({ taskId, templateLabel, artifact, onClose, onSaveToWorkspace, maximized, onToggleMaximize }: Props) {
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
					<div className="artifact-viewer-kicker">artifact</div>
					<div className="artifact-viewer-template" title={templateLabel}>{templateLabel}</div>
				</div>
				<div className="artifact-viewer-head-right">
					<span className="artifact-viewer-badge" title="Rendered inside a locked-down sandbox">sandboxed</span>
					<div className="artifact-viewer-actions">
						<button
							type="button"
							className="artifact-viewer-action"
							onClick={onToggleMaximize}
							aria-pressed={maximized}
							title={maximized ? "Restore panel size" : "Maximize panel"}
						>
							{maximized ? "Restore" : "Maximize"}
						</button>
						<button
							type="button"
							className="artifact-viewer-action"
							onClick={openInTab}
							disabled={!routeUrl}
							title="Open this artifact in a new browser tab"
						>
							Open in tab
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
			{renderBody()}
		</aside>
	);
}
