import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
// Only so the build emits the renderers' bundles; the server puts them into the frame's document.
import "../pptx-frame-entry.ts?worker&url";

// PPTX renderer reads an untrusted file, so it stays in a frame with an
// opaque origin (no allow-same-origin) that may fetch nothing. The parent fetches the file and hands the bytes over.
export function WorkspaceFramedPreview({ agentId, conversationId, path }: { agentId: string; conversationId: string; path: string }) {
	const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [rendered, setRendered] = useState(false);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const delivered = useRef(false);
	const fetchController = useRef<AbortController | null>(null);
	// Read once: changing it later would reload the frame and lose the zoom.
	const [theme] = useState(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
	const route = `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-preview?${new URLSearchParams({ conversationId, path })}`;
	useEffect(() => {
		const controller = new AbortController();
		fetchController.current = controller;
		delivered.current = false;
		void apiFetch(route, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) {
					const body = await response.json().catch(() => null);
					if (!controller.signal.aborted) setError(response.status === 401 ? "Sign in to preview this file." : typeof body?.error === "string" ? body.error : "This file could not be previewed.");
					return;
				}
				const buffer = await response.arrayBuffer();
				if (!controller.signal.aborted) setBytes(buffer);
			})
			.catch(() => { if (!controller.signal.aborted) setError("This file could not be previewed."); });
		return () => { controller.abort(); if (fetchController.current === controller) fetchController.current = null; };
	}, [route]);
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const frame = frameRef.current?.contentWindow;
			if (!frame || event.source !== frame) return;
			if (event.data?.kind === "frame-ready" && bytes && !delivered.current) {
				delivered.current = true;
				frame.postMessage(bytes, "*", [bytes]);
			}
			else if (event.data?.kind === "frame-rendered") setRendered(true);
			else if (event.data?.kind === "frame-failed") setError("This file is damaged or cannot be read.");
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [bytes]);
	useEffect(() => {
		if (rendered || error) return;
		const timer = window.setTimeout(() => { fetchController.current?.abort(); setError("This preview took too long to load."); }, 30_000);
		return () => window.clearTimeout(timer);
	}, [rendered, error, route]);
	if (error) return <div className="workspace-preview-html"><p>{error}</p></div>;
	return <div className="workspace-preview-html">{!rendered && <p className="workspace-preview-pptx-loading">Loading preview…</p>}{bytes && <iframe ref={frameRef} sandbox="allow-scripts" title={path.split("/").pop() ?? path} src={`${route}&frame=1#theme=${theme}`} />}</div>;
}
