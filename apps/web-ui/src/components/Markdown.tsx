import { isValidElement, memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram";

const MARKDOWN_PLUGINS = [remarkGfm];

/**
 * Heuristic: if it has any markdown-y characters, render through
 * ReactMarkdown; otherwise callers may choose preformatted text.
 */
export function looksLikeMarkdown(s: string): boolean {
	return /(^|\n)(#{1,6} |\* |- |\d+\. |```|>)|\*\*|`[^`]+`|\[[^\]]+]\([^)]+\)/.test(s);
}

/**
 * Sub-agents sometimes wrap their entire output in a single fenced code
 * block (```markdown ... ``` or ```md ... ```), which makes the rendered
 * result look like a wall of monospaced text instead of formatted
 * Markdown. If the WHOLE string is one such fence, peel it.
 */
export function unwrapOuterMarkdownFence(s: string): string {
	const trimmed = s.trim();
	const m = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
	if (!m) return s;
	const inner = m[1];
	if (!looksLikeMarkdown(inner)) return s;
	return inner;
}

// A rendered <MermaidDiagram> is not phrasing content, so react-markdown's
// default <pre> wrapper around a code fence would be invalid HTML. Detect the
// mermaid element and drop the wrapping <pre> for it only.
function isMermaidElement(children: unknown): boolean {
	if (isValidElement(children)) return children.type === MermaidDiagram;
	if (Array.isArray(children)) return children.some(isMermaidElement);
	return false;
}

// An image is rendered only when fetching it cannot reach the network:
// data: URIs and same-origin/relative paths. Anything with a scheme or a
// protocol-relative host is a remote fetch the model can use as a read
// beacon, so it must stay a click away.
function isSafeImageSrc(src: string): boolean {
	if (/^data:image\//i.test(src)) return true;
	return !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src);
}

// Intercept ```mermaid / ```mmd fences. A diagram renders only when
// renderMermaid is true — the caller passes false while the message streams,
// so expensive rendering never runs on incomplete content; the fence shows as
// a normal code block until the message is complete.
function markdownComponents(renderMermaid: boolean): Components {
	return {
		a({ href, children, ...props }) {
			return (
				<a href={href} target="_blank" rel="noopener noreferrer" {...props}>
					{children}
				</a>
			);
		},
		img({ src, alt }) {
			const url = typeof src === "string" ? src : "";
			if (url && isSafeImageSrc(url)) return <img src={url} alt={alt ?? ""} loading="lazy" />;
			if (!url) return <span>{alt ?? ""}</span>;
			return (
				<a href={url} target="_blank" rel="noopener noreferrer">
					{alt ? `${alt} (image: ${url})` : `image: ${url}`}
				</a>
			);
		},
		code({ className, children, ...props }) {
			const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1]?.toLowerCase();
			if (language === "mermaid" || language === "mmd") {
				if (!renderMermaid) return <code className={className} {...props}>{children}</code>;
				return <MermaidDiagram chart={String(children).replace(/\n$/, "")} />;
			}
			return <code className={className} {...props}>{children}</code>;
		},
		pre({ children, ...props }) {
			if (isMermaidElement(children)) return <>{children}</>;
			return <pre {...props}>{children}</pre>;
		},
	};
}

function MarkdownRendererImpl({ children, renderMermaid = true }: { children: string; renderMermaid?: boolean }) {
	const components = useMemo(() => markdownComponents(renderMermaid), [renderMermaid]);
	return <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={components}>{children}</ReactMarkdown>;
}

export const MarkdownRenderer = memo(MarkdownRendererImpl);
