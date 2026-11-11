import { useEffect, useState } from "react";
import { apiFetch } from "../api";

const WORD_PREVIEW_PREFIX = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">`;

export function WorkspaceWordPreview({ agentId, conversationId, path }: { agentId: string; conversationId: string; path: string }) {
	const [html, setHtml] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		const query = new URLSearchParams({ conversationId, path });
		void apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-preview?${query}`, { signal: controller.signal })
			.then(async (response) => {
				const body = await response.json();
				if (!response.ok) {
					const messages: Record<string, string> = {
						damaged_file: "This file is damaged or cannot be read.",
						encrypted_file: "Password-protected files cannot be previewed here.",
						unsupported_document_feature: "This document uses a feature that cannot be previewed here.",
						file_too_large: "This file is too large or complex to preview here.",
						expanded_content_too_large: "This file is too large or complex to preview here.",
						decoded_image_too_large: "This file is too large or complex to preview here.",
						preview_too_complex: "This file is too large or complex to preview here.",
						renderer_unavailable: "Preview rendering is unavailable on this system.",
						preview_busy: "Another preview is loading; close this tab and open it again shortly.",
						preview_timeout: "This preview took too long to load.",
						invalid_request: "Choose a valid workspace file to preview.",
						invalid_path: "Choose a valid workspace file to preview.",
						not_file: "Choose a valid workspace file to preview.",
						workspace_read_forbidden: "This file is not available under the current workspace permissions.",
						blocked_by_policy: "This file is not available under the current workspace permissions.",
						outside_workspace: "This file is not available under the current workspace permissions.",
						grant_changed: "This file is not available under the current workspace permissions.",
						room_not_found: "This file is no longer available in this workspace.",
						conversation_not_found: "This file is no longer available in this workspace.",
						workspace_not_found: "This file is no longer available in this workspace.",
						file_not_found: "This file is no longer available in this workspace.",
						workspace_unavailable: "The workspace folder is not readable right now.",
						unsupported_file_type: "This file type cannot be previewed here.",
						file_changed: "This file changed while the preview was loading; close the tab and open it again.",
					};
					if (!controller.signal.aborted) setError(response.status === 401 ? "Sign in to preview this file." : messages[body?.code] ?? "This file could not be previewed.");
					return;
				}
				if (body?.schemaVersion !== 1 || body.agentId !== agentId || body.conversationId !== conversationId || body.path !== path || body.kind !== "word" || typeof body.html !== "string" || body.html.length > 16_777_216 || !body.html.startsWith(WORD_PREVIEW_PREFIX) || !Array.isArray(body.notices) || body.notices.length > 1 || !body.notices.every((item: { code?: string; text?: string }) => item?.code === "external_resources_blocked" && item.text === "External document resources are blocked.")) throw new Error("Invalid preview");
				if (!controller.signal.aborted) { setNotice(body.notices.length === 1); setHtml(body.html); }
			})
			.catch(() => { if (!controller.signal.aborted) setError("This file could not be previewed."); });
		return () => controller.abort();
	}, [agentId, conversationId, path]);
	return <div className="workspace-preview-word">{html ? <>{notice && <p>External document resources are blocked.</p>}<iframe sandbox="" title={path.split("/").pop() ?? path} srcDoc={html} /></> : <p>{error ?? "Loading preview…"}</p>}</div>;
}
