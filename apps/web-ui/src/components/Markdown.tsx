import { memo, useEffect, useMemo, useRef } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
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

// Only ~~text~~ crosses out: a single tilde is a Windows short name
// (ENV~1), a range (5~10 min) or a home path, never strikethrough.
const GFM: [typeof remarkGfm, { singleTilde: boolean }] = [remarkGfm, { singleTilde: false }];

type MdastNode = { type: string; value?: string; children?: MdastNode[]; data?: Record<string, unknown> };

function splitSoftBreaks(node: MdastNode): void {
	if (!node.children) return;
	node.children = node.children.flatMap((child): MdastNode[] => {
		if (child.type !== "text" || !child.value?.includes("\n")) {
			splitSoftBreaks(child);
			return [child];
		}
		return child.value.split("\n").flatMap((part, index): MdastNode[] => (index === 0 ? [{ type: "text", value: part }] : [{ type: "break" }, { type: "text", value: part }]));
	});
}

/** An answer keeps the single line breaks it was written with, as the person's own messages do; standard Markdown joins them. */
function remarkKeepLineBreaks() {
	return (tree: MdastNode) => splitSoftBreaks(tree);
}

// HTML is never rendered as HTML. These few tags show as the element they
// mean; layout tags, comments and empty anchors leave only their text.
const HTML_ELEMENTS: Record<string, string> = { b: "strong", strong: "strong", i: "em", em: "em", kbd: "kbd", sup: "sup", sub: "sub" };
const HTML_TEXT_TAG = /^<\/?(?:details|summary|div|p|span|u|small|mark|center)(?:\s[^>]*)?>$/i;
const HTML_KNOWN_TAG = /<!--[\s\S]*?-->|<\/?(?:b|strong|i|em|kbd|sup|sub|br|a|details|summary|div|p|span|u|small|mark|center)(?:\s[^>]*)?\/?>/gi;

function plainHtml(node: MdastNode): void {
	if (!node.children) return;
	const out: MdastNode[] = [];
	const open: Array<{ tag: string; at: number }> = [];
	let emptyAnchors = 0;
	for (const child of node.children) {
		if (child.type !== "html") {
			plainHtml(child);
			out.push(child);
			continue;
		}
		const value = (child.value ?? "").trim();
		const tag = /^<(\/?)([a-z]+)(?:\s[^>]*)?\/?>$/i.exec(value);
		const name = tag?.[2].toLowerCase();
		if (/^<br\s*\/?>$/i.test(value)) out.push({ type: "break" });
		else if (/^<!--[\s\S]*-->$/.test(value)) continue;
		else if (name === "a" && !tag![1] && !/\bhref\s*=/i.test(value)) emptyAnchors++;
		else if (name === "a" && tag![1] && emptyAnchors > 0) emptyAnchors--;
		else if (name && HTML_ELEMENTS[name] && !tag![1]) {
			open.push({ tag: name, at: out.length });
			out.push({ type: "text", value: "" });
		} else if (name && HTML_ELEMENTS[name]) {
			const opened = open.map((entry) => entry.tag).lastIndexOf(name);
			if (opened < 0) continue;
			const [{ at }] = open.splice(opened);
			out.splice(at, out.length - at, { type: "emphasis", children: out.slice(at + 1), data: { hName: HTML_ELEMENTS[name] } });
		} else if (HTML_TEXT_TAG.test(value)) continue;
		else if (!tag && value.replace(HTML_KNOWN_TAG, "").length < value.length && !/<[a-z/!]/i.test(value.replace(HTML_KNOWN_TAG, ""))) {
			// A block of known tags (a <details> box, an anchor line): its text, one line per block tag.
			const text = value.replace(/<br\s*\/?>|<\/(?:summary|div|p)>/gi, "\n").replace(HTML_KNOWN_TAG, "").trim();
			if (text) out.push({ type: "paragraph", children: [{ type: "text", value: text }] });
		} else out.push(child);
	}
	node.children = out;
}

function remarkPlainHtml() {
	return (tree: MdastNode) => plainHtml(tree);
}

const WINDOWS_PATH = /(^|[^\w\\])((?:[A-Za-z]:\\|\\\\(?=[\w.$-]))[^\s`<>"|)\]]*)/g;
// A word that is a path although no drive starts it: a backslash before a
// letter or digit separates folders, and relative or variable roots start one.
const PATH_WORD = /\\[\p{L}\p{N}]|^[("'*_]*(?:\.{1,2}\\|%\w+%\\|\$env:\w+\\|\\\\[?.]\\)/u;
const MATHS_SIGN = /[\^_=+\-*/\\{}<>]/;

/**
 * The offsets of the \( \) and \[ \] delimiters around maths on one line.
 * A span runs from an opener to its first closer and holds a maths sign and
 * no line break, so the closer's own backslash never counts as a sign and the
 * scan stays linear.
 */
function mathsDelimiters(line: string): Set<number> {
	const found = new Set<number>();
	const opener = /(?<!\\)\\[([]/g;
	const lineBreak = /[\r\u2028\u2029]/g;
	// The next closer of each kind and the next line break, kept while they lie ahead: -1 once none is left.
	const next: Record<string, number> = {};
	const ahead = (key: string, from: number, find: () => number) => (next[key] === undefined || (next[key] >= 0 && next[key] < from) ? (next[key] = find()) : next[key]);
	for (let match; (match = opener.exec(line)); ) {
		const from = match.index + 2;
		const kind = match[0][1];
		const closer = ahead(kind, from, () => line.indexOf(kind === "(" ? "\\)" : "\\]", from));
		const lineEnd = ahead("break", from, () => ((lineBreak.lastIndex = from), lineBreak.exec(line)?.index ?? -1));
		if (closer < 0 || (lineEnd >= 0 && lineEnd < closer) || !MATHS_SIGN.test(line.slice(from, closer))) continue;
		found.add(match.index).add(closer);
		opener.lastIndex = closer + 2;
	}
	return found;
}

/**
 * The backslashes of one line that show as written, each mapped to whether
 * it also sits right before a bracket in a link's address. Markdown would
 * read each as an escape or a line break, but in a Windows path it is a
 * separator, so C:\exxtest\.env keeps its "\." and a folder's last backslash
 * at a line end is not a break. A pair still shows as one, since a model that
 * knows the escape rule writes C:\\exxtest\\notes.md, except a network or
 * device path's leading pair, which is the path. Maths written as \( \) or
 * \[ \] keeps its delimiters: the app has no maths rendering. The line is
 * read once for all its backslashes, so a long line costs one pass.
 */
function shownInLine(line: string, last: boolean): Map<number, boolean> {
	const shown = new Map<number, boolean>();
	const paths = [...line.matchAll(WINDOWS_PATH)];
	const words = [...line.matchAll(/\S+/g)];
	let path = 0;
	let word = -1;
	let wordStart = 0;
	let pathWord = false;
	let device: number | undefined;
	let address = -1;
	let nextAddress = line.indexOf("](");
	let maths: Set<number> | undefined;
	let lastCloser: Record<string, number> | undefined;
	for (let index = line.indexOf("\\"); index >= 0; index = line.indexOf("\\", index + 1)) {
		const next = line[index + 1] ?? "";
		// A table cell's \| is its pipe.
		if (next === "|") continue;
		while (word < 0 || words[word].index + words[word][0].length <= index) {
			const found = words[++word];
			wordStart = found.index;
			pathWord = PATH_WORD.test(found[0]);
			device = /^[("'*_]*(?=\\\\[?.]\\)/.exec(found[0])?.[0].length;
		}
		// Micromark reads a backslash before a bracket in a link's address as an escape, before these rules run.
		while (nextAddress >= 0 && nextAddress + 2 <= index) {
			address = nextAddress;
			nextAddress = line.indexOf("](", address + 1);
		}
		const separator = (next === "(" || next === ")") && line[index - 1] !== "\\" && address >= wordStart;
		while (path < paths.length && paths[path].index + paths[path][0].length <= index) path++;
		const from = path < paths.length ? paths[path].index + paths[path][1].length : Infinity;
		if (index >= from) {
			if (next !== "\\" || (index === from && paths[path][2].startsWith("\\\\"))) shown.set(index, separator);
			continue;
		}
		if (pathWord) {
			if (next !== "\\" || device === index - wordStart) shown.set(index, separator);
			continue;
		}
		if (!/[()[\]]/.test(next)) continue;
		maths ??= mathsDelimiters(line);
		if (/^\s*\\[[\]]\s*$/.test(line) || maths.has(index)) {
			shown.set(index, false);
			continue;
		}
		// While an answer streams, its maths may not have reached the closing delimiter yet.
		if (last && (next === "(" || next === "[") && (lastCloser ??= { "(": line.lastIndexOf("\\)"), "[": line.lastIndexOf("\\]") })[next] < index + 2 && MATHS_SIGN.test(line.slice(index + 2))) shown.set(index, false);
	}
	return shown;
}

/**
 * Whether the backslash at an offset shows as written (false or true; true
 * when it sits before a bracket in a link's address) or is an escape
 * (undefined). Each line is worked out once, when the parser first asks.
 */
function backslashRule(source: string): (at: number) => boolean | undefined {
	let start = 0;
	let end = -1;
	let shown = new Map<number, boolean>();
	return (at) => {
		// The parser asks in order through the text, so the last line read is kept.
		if (at < start || at > end) {
			start = source.lastIndexOf("\n", at - 1) + 1;
			end = source.indexOf("\n", at);
			shown = shownInLine(source.slice(start, end < 0 ? undefined : end), end < 0);
			if (end < 0) end = source.length;
		}
		return shown.get(at - start);
	};
}

type Code = number | null;
type State = (code: Code) => State | undefined;
type Effects = { enter(type: string): void; consume(code: Code): void; exit(type: string): void };

/**
 * Characters the parser keeps as written: each rule returns how many
 * characters from that point are plain text (0: none). Only prose and link
 * addresses reach these, so code and HTML are never touched.
 */
function plainCharacters(length: (at: number) => number) {
	return {
		tokenize(this: { now(): { offset: number } }, effects: Effects, ok: State, nok: State): State {
			let left = length(this.now().offset);
			const take: State = (code) => {
				effects.consume(code);
				if (--left) return take;
				effects.exit("data");
				return ok;
			};
			if (!left) return nok;
			effects.enter("data");
			return take;
		},
	};
}

const DUNDER_NAME = /__[\p{L}\p{N}]+__(?=\.[\p{L}\p{N}])/uy;

type Parse = (doc: string, file: never) => unknown;

/** Paths, maths, Python's __init__.py and a product like 2*3*4 read as written. */
function remarkAsWritten(this: { data(): object; parser?: Parse }) {
	let source = "";
	let shown = backslashRule(source);
	// The offsets of path backslashes right before a bracket in a link's address.
	const inAddress = new Set<number>();
	const backslash = plainCharacters((at) => {
		const decision = shown(at);
		if (decision) inAddress.add(at);
		return decision === undefined ? 0 : 1;
	});
	const star = plainCharacters((at) => (/[\p{L}\p{N}]/u.test(source[at - 1] ?? "") && /[\p{L}\p{N}]/u.test(source[at + 1] ?? "") ? 1 : 0));
	const dunder = plainCharacters((at) => {
		if (at > 0 && !/(?:[^\w\\]|\\\\)$/.test(source.slice(Math.max(0, at - 2), at))) return 0;
		DUNDER_NAME.lastIndex = at;
		return DUNDER_NAME.exec(source)?.[0].length ?? 0;
	});
	const data = this.data() as { micromarkExtensions?: unknown[] };
	(data.micromarkExtensions ??= []).push({ text: { 42: star, 92: backslash, 95: dunder }, string: { 92: backslash } });
	const parse = this.parser!;
	this.parser = (doc, file) => {
		// Micromark skips a leading byte order mark, so its offsets count from after it.
		source = doc.replace(/^\uFEFF/, "");
		shown = backslashRule(source);
		inAddress.clear();
		const tree = parse(source, file);
		if (!inAddress.size) return tree;
		// Micromark reads such a backslash as an escape of the bracket, so the
		// address runs on; doubled, it ends at the bracket and still shows once.
		let at = 0;
		source = [...inAddress].sort((a, b) => a - b).map((offset) => source.slice(at, (at = offset))).join("\\") + "\\" + source.slice(at);
		shown = backslashRule(source);
		return parse(source, file);
	};
}

const MARKDOWN_PLUGINS = [GFM, remarkPlainHtml, remarkAsWritten];
const ANSWER_PLUGINS = [GFM, remarkPlainHtml, remarkKeepLineBreaks, remarkAsWritten];

/**
 * Heuristic: if it has any markdown-y characters, render through
 * ReactMarkdown; otherwise callers may choose preformatted text.
 */
function looksLikeMarkdown(s: string): boolean {
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

/** The address as the model wrote it: the parser percent-encodes a backslash or a space. */
function readableAddress(address: string): string {
	try {
		return decodeURIComponent(address);
	} catch {
		return address;
	}
}

/**
 * What a "#" link names inside its own answer: a footnote by its id, or a
 * heading by its words ("#details" for "## Details", "#details-1" for the
 * second such heading). Headings carry no id, so answers never share one.
 */
export function anchorTarget(root: ParentNode, id: string): Element | null {
	for (const name of [id, `user-content-${id}`]) {
		const found = root.querySelector(`[id="${CSS.escape(name)}"]`);
		if (found) return found;
	}
	const numbered = /^(.*)-(\d+)$/.exec(id);
	const named = (anchor: string) => [...root.querySelectorAll(`[data-anchor="${CSS.escape(anchor)}"]`)];
	return named(id)[0] ?? (numbered ? named(numbered[1])[Number(numbered[2])] : undefined) ?? null;
}

function scrollToAnchor(link: HTMLElement, id: string): void {
	anchorTarget(link.closest(".md") ?? document, id)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/** A heading's anchor as GitHub writes it: lower case, words joined by hyphens. */
function headingAnchor(node: HastNode | undefined): string {
	const text = (n: any): string => (n?.type === "text" ? n.value : (n?.children ?? []).map(text).join(""));
	return text(node).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-");
}

/** Marks the sides of a table frame whose scroller hides columns, so its band shows there. */
export function markTableFrame(frame: HTMLElement): void {
	const scroller = frame.firstElementChild;
	if (!scroller) return;
	frame.toggleAttribute("data-more-left", scroller.scrollLeft > 1);
	frame.toggleAttribute("data-more-right", scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
}

// The band sits on the frame, outside the scroller, so it stays at the edge and paints above the table.
function TableFrame({ children }: { children: React.ReactNode }) {
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = frame.current;
		const scroller = element?.firstElementChild;
		if (!element || !scroller) return;
		const mark = () => markTableFrame(element);
		mark();
		scroller.addEventListener("scroll", mark, { passive: true });
		const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mark);
		resized?.observe(scroller);
		if (scroller.firstElementChild) resized?.observe(scroller.firstElementChild);
		return () => {
			scroller.removeEventListener("scroll", mark);
			resized?.disconnect();
		};
	}, []);
	return <div ref={frame} className="md-table-frame"><div className="md-table-scroll">{children}</div></div>;
}

// Intercept ```mermaid / ```mmd fences. A diagram renders only when
// renderMermaid is true — the caller passes false while the message streams,
// so expensive rendering never runs on incomplete content; the fence shows as
// a normal code block until the message is complete.
function markdownComponents(renderMermaid: boolean, onOpenRoomFile?: (name: string) => void, codeTokens = false): Components {
	const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => ({ node, children, ...props }: React.ComponentProps<typeof Tag> & ExtraProps) => <Tag {...props} data-anchor={headingAnchor(node)}>{children}</Tag>;
	return {
		h1: heading("h1"),
		h2: heading("h2"),
		h3: heading("h3"),
		h4: heading("h4"),
		h5: heading("h5"),
		h6: heading("h6"),
		table({ node: _node, children, ...props }) {
			return <TableFrame><table {...props}>{children}</table></TableFrame>;
		},
		a({ href, children, node: _node, ...props }) {
			const address = typeof href === "string" ? href : "";
			// A footnote or "#details" stays in this answer: a new tab would open the app again.
			if (address.startsWith("#")) return <a href={address} {...props} onClick={(event) => { event.preventDefault(); scrollToAnchor(event.currentTarget, address.slice(1)); }}>{children}</a>;
			// A file, a relative or any other address opens nothing here: it shows as text the person can copy.
			if (!/^(?:https?:|mailto:)/i.test(address)) {
				const written = readableAddress(address);
				return written && String(children) !== written ? <span>{children} <code>{written}</code></span> : written ? <code>{written}</code> : <span>{children}</span>;
			}
			return (
				<a href={address} target="_blank" rel="noopener noreferrer" {...props}>
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
			// codeTokens: inline code keeps each space-separated token in its own
			// span, so a stylesheet can let it wrap only between tokens (a table
			// cell on a skill's page). The text itself is unchanged.
			if (codeTokens && !className && typeof children === "string" && !children.includes("\n")) {
				return <code {...props}>{children.split(/(\s+)/).map((part, i) => (/^\s*$/.test(part) ? part : <span key={i} className="md-code-token">{part}</span>))}</code>;
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

// A link keeps its address so the link component can show a non-web one as
// text; it only ever becomes an href for http, https, mailto or "#".
function keepLinkAddress(url: string, key: string): string {
	return key === "href" ? url : defaultUrlTransform(url);
}

/**
 * `onOpenRoomFile` opens a shelf file in the viewer; when given, a picture
 * whose source is the room files route becomes a button that calls it with
 * the file name. Pass a stable identity — it is a dependency of the memoised
 * component map, so a fresh function each render re-parses the markdown.
 */
function MarkdownRendererImpl({ children, renderMermaid = true, onOpenRoomFile, codeTokens = false, answer = false }: { children: string; renderMermaid?: boolean; onOpenRoomFile?: (name: string) => void; codeTokens?: boolean; answer?: boolean }) {
	const components = useMemo(() => markdownComponents(renderMermaid, onOpenRoomFile, codeTokens), [renderMermaid, onOpenRoomFile, codeTokens]);
	return <ReactMarkdown remarkPlugins={answer ? ANSWER_PLUGINS : MARKDOWN_PLUGINS} components={components} urlTransform={keepLinkAddress}>{children}</ReactMarkdown>;
}

export const MarkdownRenderer = memo(MarkdownRendererImpl);
