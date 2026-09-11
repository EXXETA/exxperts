import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components, ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { ImageActions } from "./ImageActions";
import { MermaidDiagram } from "./MermaidDiagram";

type HastNode = NonNullable<ExtraProps["node"]>;

// The raw text and language of a fenced block, read from the syntax tree
// rather than from the rendered children: the tree still holds the plain
// text after the `code` component has wrapped it, and a fence with no info
// string simply has no language class.
function fencedCode(pre: HastNode | undefined): { text: string; language: string | undefined } | null {
	const code = pre?.children.find((child) => child.type === "element" && child.tagName === "code");
	if (!code || code.type !== "element") return null;
	const classes = Array.isArray(code.properties?.className) ? code.properties.className : [];
	const language = classes.map(String).find((name) => name.startsWith("language-"))?.slice("language-".length);
	const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("").replace(/\n$/, "");
	return { text, language: language || undefined };
}

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

// A mermaid fence rendered as a diagram is not phrasing content, so the
// default <pre> wrapper (and the code-block chrome) must be dropped for it.
// Decided from the fence's language in the syntax tree: the rendered child
// is the custom `code` component, not the diagram element itself, so it
// cannot be recognised by inspecting React children.
function isMermaidLanguage(language: string | undefined): boolean {
	return language === "mermaid" || language === "mmd";
}

// An image is rendered only when fetching it cannot reach the network:
// data: URIs and same-origin/relative paths. Anything with a scheme or a
// protocol-relative host is a remote fetch the model can use as a read
// beacon, so it must stay a click away.
function isSafeImageSrc(src: string): boolean {
	if (/^data:image\//i.test(src)) return true;
	return !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src);
}

// The room files route (roomFileUrl in room-files-api.ts), any room id: a
// picture a reply shows from a room's shelf is the shelf file itself, so
// clicking it opens that file in the viewer like an attached thumbnail does.
// Only the encoded name is taken from the URL; the room id is not trusted —
// the callback resolves the name against THIS room's shelf and a name not on
// it is a no-op.
const ROOM_FILE_ROUTE = /^\/api\/persistent-agents\/[^/?#]+\/files\/([^/?#]+)(?:[?#]|$)/;
function roomFileNameFromSrc(src: string): string | null {
	const encoded = ROOM_FILE_ROUTE.exec(src)?.[1];
	if (!encoded) return null;
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null; // a malformed escape: not a name the shelf could hold
	}
}

// Intercept ```mermaid / ```mmd fences. A diagram renders only when
// renderMermaid is true — the caller passes false while the message streams,
// so expensive rendering never runs on incomplete content; the fence shows as
// a normal code block until the message is complete.
function markdownComponents(renderMermaid: boolean, onOpenRoomFile?: (name: string) => void): Components {
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
			if (url && isSafeImageSrc(url)) {
				const image = <img src={url} alt={alt ?? ""} loading="lazy" />;
				const roomFile = onOpenRoomFile ? roomFileNameFromSrc(url) : null;
				if (roomFile === null) return image;
				// A shelf picture also carries the copy/download cluster on its
				// corner; a picture from anywhere else is not the room's to save.
				return (
					<ImageActions src={url} name={roomFile}>
						<button type="button" className="md-image-button" title={`${roomFile} — open`} onClick={() => onOpenRoomFile!(roomFile)}>{image}</button>
					</ImageActions>
				);
			}
			if (!url) return <span>{alt ?? ""}</span>;
			return (
				<a href={url} target="_blank" rel="noopener noreferrer">
					{alt ? `${alt} (image: ${url})` : `image: ${url}`}
				</a>
			);
		},
		code({ className, children, node: _node, ...props }) {
			const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1]?.toLowerCase();
			if (isMermaidLanguage(language)) {
				if (!renderMermaid) return <code className={className} {...props}>{children}</code>;
				return <MermaidDiagram chart={String(children).replace(/\n$/, "")} />;
			}
			return <code className={className} {...props}>{children}</code>;
		},
		pre({ children, node, ...props }) {
			const fenced = fencedCode(node);
			if (fenced && isMermaidLanguage(fenced.language?.toLowerCase()) && renderMermaid) return <>{children}</>;
			if (!fenced) return <pre {...props}>{children}</pre>;
			// A header strip above the block, not an overlay inside it: a bubble
			// sized to a short block would put an overlay on top of the code,
			// and the block scrolls sideways for long lines, which would carry
			// anything positioned inside it away.
			return (
				<div className="code-block">
					<div className="code-block-tools">
						{fenced.language && <span className="code-block-lang">{fenced.language}</span>}
						<CopyButton text={fenced.text} className="code-block-copy" what="code" />
					</div>
					<pre {...props}>{children}</pre>
				</div>
			);
		},
	};
}

/**
 * `onOpenRoomFile` opens a shelf file in the viewer; when given, a picture
 * whose source is the room files route becomes a button that calls it with
 * the file name. Pass a stable identity — it is a dependency of the memoised
 * component map, so a fresh function each render re-parses the markdown.
 */
function MarkdownRendererImpl({ children, renderMermaid = true, onOpenRoomFile }: { children: string; renderMermaid?: boolean; onOpenRoomFile?: (name: string) => void }) {
	const components = useMemo(() => markdownComponents(renderMermaid, onOpenRoomFile), [renderMermaid, onOpenRoomFile]);
	return <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={components}>{children}</ReactMarkdown>;
}

export const MarkdownRenderer = memo(MarkdownRendererImpl);
