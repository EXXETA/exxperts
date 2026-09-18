import { apiFetch } from "./api";

export interface WorkspaceMarkdownFile {
	path: string;
	content: string;
	encoding: "utf-8";
	bytes: number;
	revision: string;
	readOnly: boolean;
}

export interface WorkspaceMarkdownApiErrorInit {
	status: number;
	code?: string;
	currentRevision?: string;
}

export class WorkspaceMarkdownApiError extends Error {
	readonly status: number;
	readonly code?: string;
	readonly currentRevision?: string;

	constructor(message: string, init: WorkspaceMarkdownApiErrorInit) {
		super(message);
		this.name = "WorkspaceMarkdownApiError";
		this.status = init.status;
		this.code = init.code;
		this.currentRevision = init.currentRevision;
	}
}

interface RequestOptions {
	signal?: AbortSignal;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await apiFetch(url, init);
	if (response.ok) return await response.json() as T;
	let body: { error?: unknown; code?: unknown; currentRevision?: unknown } = {};
	try { body = await response.json(); } catch {}
	throw new WorkspaceMarkdownApiError(
		typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
		{
			status: response.status,
			code: typeof body.code === "string" ? body.code : undefined,
			currentRevision: typeof body.currentRevision === "string" ? body.currentRevision : undefined,
		},
	);
}

function markdownUrl(agentId: string, conversationId: string, relativePath: string): string {
	const params = new URLSearchParams({ conversationId, path: relativePath });
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-markdown?${params.toString()}`;
}

export function getWorkspaceMarkdownFile(
	agentId: string,
	conversationId: string,
	relativePath: string,
	options: RequestOptions = {},
): Promise<WorkspaceMarkdownFile> {
	return request<WorkspaceMarkdownFile>(markdownUrl(agentId, conversationId, relativePath), { signal: options.signal });
}

export function putWorkspaceMarkdownFile(
	agentId: string,
	conversationId: string,
	relativePath: string,
	content: string,
	revision: string,
	options: RequestOptions = {},
): Promise<WorkspaceMarkdownFile> {
	return request<WorkspaceMarkdownFile>(markdownUrl(agentId, conversationId, relativePath), {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content, revision }),
		signal: options.signal,
	});
}
