import { useEffect, useState } from "react";
import { apiFetch } from "../api";

type Page = { page: number; mimeType: "image/jpeg"; imageBase64: string; widthPx: number; heightPx: number };

const errorText: Record<string, string> = {
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
	expanded_content_too_large: "This file is too large or complex to preview here.",
	decoded_image_too_large: "This file is too large or complex to preview here.",
	unsupported_document_feature: "This document uses a feature that cannot be previewed here.",
	file_changed: "This file changed while the preview was loading; close the tab and open it again.",
	file_too_large: "This file is too large or complex to preview here.",
	preview_too_complex: "This file is too large or complex to preview here.",
	damaged_file: "This file is damaged or cannot be read.",
	encrypted_file: "Password-protected files cannot be previewed here.",
	renderer_unavailable: "Preview rendering is unavailable on this system.",
	preview_busy: "Another preview is loading; close this tab and open it again shortly.",
	preview_timeout: "This preview took too long to load.",
};

export function WorkspacePdfPreview({ agentId, conversationId, path }: { agentId: string; conversationId: string; path: string }) {
	const [pages, setPages] = useState<Page[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		const query = new URLSearchParams({ conversationId, path });
		void apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-preview?${query}`, { signal: controller.signal })
			.then(async (response) => {
				const body = await response.json();
				if (!response.ok) {
					if (!controller.signal.aborted) setError(response.status === 401 ? "Sign in to preview this file." : errorText[body?.code] ?? "This file could not be previewed.");
					return;
				}
				if (body?.schemaVersion !== 1 || body.agentId !== agentId || body.conversationId !== conversationId || body.path !== path || body.kind !== "pdf" || !Number.isInteger(body.totalPages) || body.totalPages < 1 || body.totalPages > 200 || !Array.isArray(body.pages) || body.pages.length !== body.totalPages || !body.pages.every((page: Page, index: number) => page?.page === index + 1 && page.mimeType === "image/jpeg" && typeof page.imageBase64 === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(page.imageBase64) && Number.isInteger(page.widthPx) && page.widthPx > 0 && Number.isInteger(page.heightPx) && page.heightPx > 0)) throw new Error("Invalid preview");
				if (!controller.signal.aborted) setPages(body.pages);
			})
			.catch(() => { if (!controller.signal.aborted) setError("This file could not be previewed."); });
		return () => controller.abort();
	}, [agentId, conversationId, path]);
	return <div className="workspace-preview-pdf">{pages ? pages.map((page) => <img key={page.page} src={`data:image/jpeg;base64,${page.imageBase64}`} alt={`Page ${page.page}`} width={page.widthPx} height={page.heightPx} />) : <p>{error ?? "Loading preview…"}</p>}</div>;
}
