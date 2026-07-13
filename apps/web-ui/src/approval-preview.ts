import type { ChatItem } from "./types";

export type ApprovalPreviewType = "markdown" | "html";

export interface ApprovalPreviewData {
	content: string;
	title: string;
	type: ApprovalPreviewType;
}

type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;

const PREVIEW_KEYWORDS = /\b(kb|knowledge|artifact|deck|html|markdown|note)\b/i;
const META_LINE = /^(Knowledge base|Vault|Destination|Folder|File|Path|Overwrite|Reason|Title|Slides|Generated HTML preview|Content preview|Content|Append|Proposed fact):\s*(.*)$/i;

function lineValue(detail: string, label: string): string | undefined {
	const re = new RegExp(`^${label}:\\s*(.+)$`, "im");
	return detail.match(re)?.[1]?.trim();
}

function stripPreviewFence(content: string): string {
	const trimmed = content.trim();
	const m = trimmed.match(/^```(?:html|markdown|md)?\s*\n([\s\S]*?)\n```$/i);
	return m ? m[1].trim() : trimmed;
}

function extractContent(detail: string): string {
	const lines = detail.replace(/\r\n/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		const marker = trimmed.match(/^(Generated HTML preview|Content preview|Content|Append):\s*(.*)$/i);
		if (!marker) continue;
		if (marker[2]?.trim()) return stripPreviewFence([marker[2], ...lines.slice(i + 1)].join("\n"));
		return stripPreviewFence(lines.slice(i + 1).join("\n"));
	}

	let firstContent = 0;
	while (firstContent < lines.length) {
		const line = lines[firstContent];
		if (!line.trim()) {
			firstContent++;
			break;
		}
		if (!META_LINE.test(line.trim())) break;
		firstContent++;
	}
	return stripPreviewFence(lines.slice(firstContent).join("\n"));
}

function isHtml(content: string, title: string): boolean {
	// Content sniffing only at the start: a brief that merely MENTIONS markup
	// ("change the <section> headers") must not turn the approval into an iframe.
	return /\.html?\b/i.test(title) || /^\s*(<!doctype\s+html|<html[\s>]|<body[\s>]|<section\b)/i.test(content);
}

function isMarkdown(content: string, title: string): boolean {
	return /\.md\b|KB-INDEX\.md/i.test(title) || /(^|\n)(#{1,6}\s|[-*]\s|\d+\.\s|```|>|\|.+\|)/.test(content);
}

export function approvalPreviewFromItem(item: ApprovalItem): ApprovalPreviewData | null {
	const raw = item.detail || item.message;
	if (item.done || !raw) return null;
	const detail = raw.trim();
	if (detail.split(/\r?\n/).length < 2) return null;
	// Delegate approvals fence the model-written brief with ─── lines; that text
	// is consent copy, not previewable content. Render it via the plain
	// pre-wrap approval detail so the line structure and the fence survive.
	if (detail.includes("───")) return null;

	const file = lineValue(detail, "File") || lineValue(detail, "Path");
	const folder = lineValue(detail, "Folder") || lineValue(detail, "Knowledge base") || lineValue(detail, "Vault");
	const title = file ? `${folder ? `${folder.replace(/\/$/, "")}/` : ""}${file}` : item.title;
	const content = extractContent(detail);
	if (!content.trim()) return null;

	const type: ApprovalPreviewType = isHtml(content, title) ? "html" : "markdown";
	const hasSignal = PREVIEW_KEYWORDS.test(`${item.title} ${title}`) || isHtml(content, title) || isMarkdown(content, title);
	if (!hasSignal) return null;
	return { content, title, type };
}
