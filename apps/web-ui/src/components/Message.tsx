import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatItem } from "../types";
import { MarkdownRenderer, looksLikeMarkdown, unwrapOuterMarkdownFence } from "./Markdown";
import { artifactBasename, artifactKindLabel, isSvgArtifact, taskArtifactUrl } from "../task-stream";

// Copy a message's text to the clipboard. The button flips to a checkmark for
// a moment so the click is acknowledged without a toast. On assistant replies
// it sits permanently below the text (the thing people quote); on the user's
// own messages it is revealed on hover of the row (occasional need, quiet at
// rest) via the .bubble-row:hover rule in styles.css.
function CopyMessageButton({ text, className }: { text: string; className?: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const onCopy = useCallback(() => {
		// Optional chaining + catch: navigator.clipboard is undefined over plain
		// http on a LAN IP (not localhost), and a write can be denied; degrade
		// quietly (the button just does not flip) rather than throw.
		void navigator.clipboard?.writeText(text).then(() => {
			setCopied(true);
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => setCopied(false), 2000);
		}).catch(() => {});
	}, [text]);
	useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
	return (
		<button
			type="button"
			className={`message-copy${className ? ` ${className}` : ""}${copied ? " is-copied" : ""}`}
			onClick={onCopy}
			title={copied ? "Copied" : "Copy"}
			aria-label={copied ? "Copied to clipboard" : "Copy message"}
		>
			{/* Inline SVG rather than a font glyph: the unicode clipboard/check
			    characters render as empty boxes in fonts that lack them. */}
			{copied ? (
				<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="M3.5 8.5l3 3 6-6.5" />
				</svg>
			) : (
				<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
					<path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
				</svg>
			)}
		</button>
	);
}

/**
 * Compact, single-line preview of a tool call's key argument. Used as
 * the inline summary on the collapsed tool chip (Claude-Code style).
 */
function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/**
 * The `mcp` proxy tool routes every connector interaction through one tool,
 * so the raw call reads as "mcp {json}". Surface what actually happened
 * instead: which remote tool, connect, search, or auth step.
 */
function mcpChipView(args: any): { name: string; summary: string } {
	const a = args && typeof args === "object" ? args : {};
	if (a.tool) {
		let inner = "";
		if (typeof a.args === "string" && a.args.trim()) {
			inner = a.args.trim();
		}
		const parts = [a.server ? String(a.server) : "", inner].filter(Boolean);
		return { name: `🔌 ${String(a.tool)}`, summary: parts.join(" · ").slice(0, 160) };
	}
	if (a.action === "auth-start" || a.action === "auth-complete") {
		return { name: "🔌 Connector login", summary: String(a.server ?? "") };
	}
	if (a.connect) return { name: "🔌 Connect", summary: String(a.connect) };
	if (a.search || a.regex) return { name: "🔌 Search connector tools", summary: String(a.search ?? a.regex ?? "") };
	if (a.describe) return { name: "🔌 Describe tool", summary: String(a.describe) };
	if (a.server) return { name: "🔌 List connector tools", summary: String(a.server) };
	return { name: "🔌 Connector status", summary: "" };
}

/**
 * Human chip labels for the remaining tools, matching the web_search /
 * fetch_url / mcp treatment: an emoji plus what the tool is doing in user
 * terms, never the internal tool name. Running gets the in-flight form; done
 * and error get the finished form (the status icon carries the outcome).
 */
const GENERIC_TOOL_VIEWS: Record<string, { icon: string; running: string; done: string }> = {
	bash: { icon: "⌨️", running: "Running command", done: "Ran command" },
	read: { icon: "📄", running: "Reading file", done: "Read file" },
	write: { icon: "✏️", running: "Writing file", done: "Wrote file" },
	edit: { icon: "✏️", running: "Editing file", done: "Edited file" },
	ls: { icon: "📁", running: "Listing files", done: "Listed files" },
	find: { icon: "📁", running: "Finding files", done: "Found files" },
	grep: { icon: "🔎", running: "Searching files", done: "Searched files" },
	write_markdown_file: { icon: "📝", running: "Writing document", done: "Wrote document" },
	read_spreadsheet: { icon: "📊", running: "Reading spreadsheet", done: "Read spreadsheet" },
	kb_search: { icon: "📚", running: "Searching knowledge base", done: "Searched knowledge base" },
	artifact_list: { icon: "🗂️", running: "Listing artifacts", done: "Listed artifacts" },
	artifact_read: { icon: "🗂️", running: "Reading artifact", done: "Read artifact" },
	artifact_write: { icon: "🗂️", running: "Writing artifact", done: "Wrote artifact" },
	artifact_write_html_deck: { icon: "🗂️", running: "Building deck", done: "Built deck" },
};

function genericChipName(name: string, status: "running" | "done" | "error"): string {
	const view = GENERIC_TOOL_VIEWS[name];
	if (view) return `${view.icon} ${status === "running" ? view.running : view.done}`;
	// Unknown tool: humanize the internal name rather than showing it raw.
	const humanized = name.replace(/_/g, " ").trim() || "Tool";
	return `🛠️ ${humanized.charAt(0).toUpperCase()}${humanized.slice(1)}`;
}

function summariseToolArgs(name: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	if (name === "bash") return String(args.command ?? "").slice(0, 160);
	if (name === "write_markdown_file") {
		const path = String(args.path ?? "").slice(0, 120);
		const content = typeof args.content === "string" ? ` · ${args.content.length} chars/${utf8ByteLength(args.content)} bytes` : "";
		const overwrite = args.overwrite === true ? " · overwrite" : "";
		return `${path}${content}${overwrite}`.slice(0, 160);
	}
	if (name === "read" || name === "ls" || name === "find" || name === "grep" || name === "write" || name === "edit")
		return String(args.path ?? "").slice(0, 160);
	if (name === "fetch_url") return String(args.url ?? "").slice(0, 160);
	if (name === "web_search") return String(args.query ?? "").slice(0, 160);
	if (name.startsWith("kb_")) {
		const vault = args.vault ? `${args.vault}` : "default knowledge base";
		const p = args.path ? ` · ${args.path}` : "";
		const q = args.query ? ` · ${args.query}` : "";
		return `${vault}${p}${q}`.slice(0, 160);
	}
	// Unknown tool: surface the most telling argument value instead of raw JSON.
	for (const key of ["query", "path", "url", "name", "title", "id"]) {
		if (typeof args[key] === "string" && args[key].trim()) return args[key].trim().slice(0, 160);
	}
	const firstString = Object.values(args).find((value) => typeof value === "string" && value.trim());
	if (typeof firstString === "string") return firstString.trim().slice(0, 160);
	try {
		const s = JSON.stringify(args);
		return s.length > 160 ? s.slice(0, 157) + "…" : s;
	} catch {
		return "";
	}
}

function ResultBody({ text }: { text: string }) {
	const unwrapped = unwrapOuterMarkdownFence(text);
	const trimmed = unwrapped.length > 20000 ? unwrapped.slice(0, 20000) + "\n\n…(truncated)" : unwrapped;
	if (looksLikeMarkdown(trimmed)) {
		return (
			<div className="md md-result">
				<MarkdownRenderer>{trimmed}</MarkdownRenderer>
			</div>
		);
	}
	return <pre className="raw-result">{trimmed}</pre>;
}

function UserMessageText({ text }: { text: string }) {
	const contentId = useId();
	const [expanded, setExpanded] = useState(false);
	const isLong = text.split(/\r\n|\r|\n/).length > 6 || text.length > 400;
	const folded = isLong && !expanded;

	return (
		<>
			<div
				id={contentId}
				className={`user-message-content ${folded ? "is-folded" : ""}`}
			>
				{text}
			</div>
			{isLong && (
				<button
					type="button"
					className="user-message-toggle"
					aria-expanded={expanded}
					aria-controls={contentId}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
		</>
	);
}

/** "8 Jul 2026" — the human-readable provenance date for a transferred consult. */
function formatConsultDate(ms: number): string {
	if (!Number.isFinite(ms)) return "";
	return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The permanent thread item a Consult transfer leaves behind (Consult MR-5
 * §4.4). Visitor (lila) accent, `@room` chip, question line, a collapsed answer
 * (expandable), and a human-readable provenance footer. The raw sha256 is NEVER
 * rendered (Borja 2026-07-11) — it lives in the item data and the handoff block
 * only. `pending` drives the "included with your next message" hint, shown until
 * the next send consumes the pending-transfer queue.
 */
/** One expandable Q/A within a transferred consult item (latest or earlier). */
function ConsultThreadExchange({ label, question, answer, asOf, defaultExpanded }: { label: string; question: string; answer: string; asOf?: string; defaultExpanded: boolean }) {
	const contentId = useId();
	const [expanded, setExpanded] = useState(defaultExpanded);
	const isLong = answer.split(/\r\n|\r|\n/).length > 6 || answer.length > 320;
	const folded = isLong && !expanded;
	return (
		<div className="consult-exchange">
			<div className="consult-q">
				<span className="q-label">{label}</span>
				{question}
				{asOf && <span className="hx-asof">memory updated · {asOf}</span>}
			</div>
			<div id={contentId} className={`consult-answer consult-item-answer ${folded ? "is-folded" : ""}`}>
				<div className="md">
					<MarkdownRenderer>{answer}</MarkdownRenderer>
				</div>
			</div>
			{isLong && (
				<button type="button" className="consult-item-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
		</div>
	);
}

export function ConsultThreadItem({ item, pending }: { item: Extract<ChatItem, { kind: "consult" }>; pending: boolean }) {
	// §8.4: a stacked item (N≥2) carries the whole conversation in `exchanges[]`;
	// a legacy/N=1 item renders from the flat fields as a single-exchange stack.
	const exchanges = item.exchanges && item.exchanges.length > 0
		? item.exchanges
		: [{ question: item.question, answer: item.answer, l1bFingerprint: item.l1bFingerprint, consultedAt: item.consultedAt }];
	const stacked = exchanges.length > 1;
	const lastIndex = exchanges.length - 1;
	// ONE provenance footer: the latest as-of (§8.4). The raw sha256 is never
	// rendered (Borja 2026-07-11) — it lives in the item data + handoff block only.
	const footerDate = formatConsultDate(exchanges[lastIndex].consultedAt);
	return (
		<div className="consult-item">
			<div className="head-row">
				<span className="consult-chip">@{item.targetDisplayName}</span>
				<span className="consult-sub">consulted from this room{stacked ? ` · ${exchanges.length} exchanges` : ""}</span>
				{pending && (
					<span className="pending-hint" title="The answer enters this room's context together with your next message">
						⧗ included with your next message
					</span>
				)}
			</div>
			{exchanges.map((exchange, index) => {
				// Latest expanded; earlier collapsed (§8.4). Per-exchange as-of shows on
				// the collapsed rows only when the fingerprint differs from the previous.
				const prev = index > 0 ? exchanges[index - 1] : null;
				const drifted = prev != null && prev.l1bFingerprint !== exchange.l1bFingerprint;
				const asOf = stacked && drifted ? formatConsultDate(exchange.consultedAt) : undefined;
				return (
					<ConsultThreadExchange
						key={index}
						label={stacked ? `Exchange ${index + 1}` : "Question"}
						question={exchange.question}
						answer={exchange.answer}
						asOf={asOf}
						defaultExpanded={index === lastIndex}
					/>
				);
			})}
			<div className="consult-foot">
				<span className="meta">from {item.targetDisplayName}'s memory{footerDate ? ` · ${footerDate}` : ""}</span>
			</div>
		</div>
	);
}

/** "8 Jul 2026" from an ISO-8601 string — the provenance date on the task thread item. */
function formatTaskDate(iso: string): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "";
	return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

type TaskChatItem = Extract<ChatItem, { kind: "task" }>;
type TaskArtifactItem = TaskChatItem["artifacts"][number];

/**
 * One artifact on the transferred task item — the thread-item counterpart of the
 * card's TaskArtifactTile, using the same task-stream helpers (no duplication).
 * Precedence: (1) the ONE representative thumbnail rides only the FIRST artifact
 * (item.thumbnailDataUri); (2) an SVG whose route URL is derivable renders inline
 * via that URL; (3) otherwise a typed chip (DECK/HTML/SVG kind + basename). Click
 * routes to the coordinator-wired viewer via onOpen.
 */
function TaskThreadArtifact({ item, artifact, isFirst, onOpen }: { item: TaskChatItem; artifact: TaskArtifactItem; isFirst: boolean; onOpen: (relativePath: string) => void }) {
	const name = artifactBasename(artifact.relativePath);
	const open = () => onOpen(artifact.relativePath);

	if (isFirst && item.thumbnailDataUri) {
		return (
			<button className="task-thumb" type="button" onClick={open} title={`Open ${name}`}>
				<img src={item.thumbnailDataUri} alt="" />
				<span className="task-name">{name}</span>
			</button>
		);
	}
	if (isSvgArtifact(artifact.extension)) {
		// A malformed / cross-task path yields null → fall through to the chip rather
		// than emitting a broken/unsafe <img>. SVG is the one type safe to render.
		const url = taskArtifactUrl(item.taskId, artifact.relativePath);
		if (url) {
			return (
				<button className="task-thumb" type="button" onClick={open} title={`Open ${name}`}>
					<img src={url} alt="" />
					<span className="task-name">{name}</span>
				</button>
			);
		}
	}
	return (
		<button className="task-file-chip" type="button" onClick={open} title={`Open ${name}`}>
			<span className="task-kind">{artifactKindLabel(artifact.extension, item.template)}</span>
			<span className="task-file-name">{name}</span>
		</button>
	);
}

/**
 * The permanent thread item a specialist-task transfer leaves behind (delegation
 * contract spec §2.2 / §4.4-style item). Sibling of ConsultThreadItem: a
 * `<templateLabel> specialist` chip, the task title line, the representative
 * thumbnail / typed artifact chips (reusing the task-stream helpers), a folded
 * summary, and a muted one-line provenance footer (template id + date — allowed
 * here because the thread item is the durable record, unlike the card face).
 *
 * `onOpenTaskArtifact` is exposed for the coordinator to wire (App.tsx / the
 * in-room-chat dispatch pass it the V5 panel-viewer opener); when it is absent
 * the chips/thumbnail are inert no-ops, so the item always renders safely.
 */
export function TaskThreadItem({ item, onOpenTaskArtifact }: { item: TaskChatItem; onOpenTaskArtifact?: (taskId: string, relativePath: string) => void }) {
	const contentId = useId();
	// Same shape as the done card: the specialist's narration folds to zero
	// lines behind a "Details" toggle; the artifact is the item.
	const [notesOpen, setNotesOpen] = useState(false);
	const summary = item.summary ?? "";
	const footerDate = formatTaskDate(item.generatedAt);
	const open = (relativePath: string) => onOpenTaskArtifact?.(item.taskId, relativePath);

	return (
		<div className="task-item">
			{/* One plain grey label line; no chip, and no title line (the title is
			    the brief's first line capped server-side at 80 chars, always a
			    cut-off echo; the artifact and the notes identify the result). */}
			<div className="head-row">
				<span className="task-who">{item.templateLabel} specialist</span>
				<span className="task-item-sub">delegated from this room</span>
			</div>
			{item.artifacts.length > 0 && (
				<div className="task-artifact-strip">
					{item.artifacts.map((artifact, index) => (
						<TaskThreadArtifact key={artifact.relativePath || index} item={item} artifact={artifact} isFirst={index === 0} onOpen={open} />
					))}
				</div>
			)}
			{summary && (
				<div className="task-notes">
					<button type="button" className="task-notes-toggle" aria-expanded={notesOpen} aria-controls={contentId} onClick={() => setNotesOpen((value) => !value)}>
						{notesOpen ? "Hide details" : "Details"}
					</button>
					{notesOpen && (
						<div id={contentId} className="task-summary md">
							<MarkdownRenderer>{summary}</MarkdownRenderer>
						</div>
					)}
				</div>
			)}
			<div className="task-item-foot">
				<span className="meta" title={item.template}>{footerDate || item.templateLabel || item.template}</span>
			</div>
		</div>
	);
}

function MessageImpl({ item }: { item: ChatItem }) {
	if (item.kind === "system") {
		return <div className={`system-line ${item.level === "error" ? "error" : ""}`}>{item.text}</div>;
	}
	if (item.kind === "tool") {
		const summary = summariseToolArgs(item.name, item.args);
		const icon = item.status === "running" ? "…" : item.status === "error" ? "✗" : "✓";
		// fetch_url reads as a source: show the page title + domain (from the
		// result details) instead of the raw tool name and URL argument.
		const isFetchUrl = item.name === "fetch_url";
		const fetchUrl = isFetchUrl ? String(item.details?.finalUrl ?? item.args?.url ?? "") : "";
		const fetchDomain = fetchUrl ? domainOf(fetchUrl) : "";
		const mcpView = item.name === "mcp" ? mcpChipView(item.args) : null;
		// web_search reads as a lookup: show the query itself, not the tool name.
		const isWebSearch = item.name === "web_search";
		const searchQuery = isWebSearch ? String(item.args?.query ?? "").slice(0, 160) : "";
		const chipName = isFetchUrl
			? `🌐 ${String(item.details?.title || "Fetch URL")}`
			: isWebSearch
				? `🔍 ${searchQuery || "Web search"}`
				: mcpView ? mcpView.name : genericChipName(item.name, item.status);
		const chipSummary = isFetchUrl ? fetchDomain || summary : isWebSearch ? "" : mcpView ? mcpView.summary : summary;
		return (
			<div className="bubble-row">
				<details className={`tool-chip ${item.status}`}>
					<summary>
						<span className="icon">{icon}</span>
						<span className="name">{chipName}</span>
						{chipSummary && <span className="summary">{chipSummary}</span>}
						{item.status === "running" && <span className="spinner" />}
					</summary>
					<div className="chip-body">
						{item.result && item.status !== "running" ? (
							<div className="chip-result">
								<span className="label">{item.status === "error" ? "error" : "result"}</span>
								<ResultBody text={item.result} />
							</div>
						) : (
							<div className="chip-empty">{item.status === "running" ? "Working…" : "No output."}</div>
						)}
					</div>
				</details>
			</div>
		);
	}

	const isUser = item.kind === "user";
	const assistantText = isUser ? "" : String((item as any).text ?? "");
	const assistantStreaming = !isUser && Boolean((item as any).streaming);
	return (
		<div className={`bubble-row ${isUser ? "user" : ""}`}>
			<div className={`bubble-col ${isUser ? "user" : ""}`}>
				<div className={`bubble ${isUser ? "user" : ""}`}>
					{isUser ? (
						<UserMessageText text={item.text} />
					) : (
						<div className="md assistant-markdown">
							<MarkdownRenderer renderMermaid={!assistantStreaming}>{assistantText || (assistantStreaming ? "…" : "")}</MarkdownRenderer>
						</div>
					)}
				</div>
				{isUser
					? item.text && <CopyMessageButton text={item.text} className="message-copy-user" />
					// Shown once the reply has settled, not mid-stream.
					: assistantText && !assistantStreaming && <CopyMessageButton text={assistantText} className="message-copy-assistant" />}
			</div>
		</div>
	);
}

export const Message = memo(MessageImpl);
