import { memo, useEffect, useId, useReducer, useState } from "react";
import type { ChatItem } from "../types";
import { formatAbsoluteTime, formatRelativeTime } from "../message-time";
import { CopyButton } from "./CopyButton";
import { ImageActions } from "./ImageActions";
import { MarkdownRenderer, unwrapOuterMarkdownFence } from "./Markdown";
import { artifactBasename, artifactKindLabel, isSvgArtifact, taskArtifactUrl } from "../task-stream";
import { MEMORY_RECALL_STEP, memoryRecallDisplayText } from "../memory-recall-display";
import { failureButtons, failureLineParts, failureLineWords } from "../turn-failure-line";
import { commandAborted, commandDeclined, lastName, missingToolName, nobodyToApprove, readableToolName, stepOutcome, stoppedBeforeAsking } from "../step-lines";
import { SPECIALIST_TEMPLATE_LABELS } from "../../../web-server/src/specialist-template-labels";
import { useRemoteClientContext } from "../remote-client-context";

// The message copy control (CopyButton.tsx): on assistant replies it sits
// permanently below the text (the thing people quote); on the user's own
// messages it is revealed on hover of the row (occasional need, quiet at
// rest) via the .bubble-row:hover rule in styles.css.

/**
 * Compact, single-line preview of a tool call's key argument. Used as
 * the inline summary on the collapsed tool chip (Claude-Code style).
 */
function clip(value: string, max = 160): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** A path with its file name first, so a cut summary hides the folder rather than the name. */
function pathSummary(raw: string): string {
	const name = lastName(raw);
	const folder = raw.replace(/[\\/]+$/, "").slice(0, -name.length - 1);
	return name && folder ? `${name} · ${folder}` : raw;
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
function mcpChipView(args: any, details: any): { name: string; summary: string } {
	const a = args && typeof args === "object" ? args : {};
	if (a.tool) {
		// The connector's name, never the call's raw arguments.
		const server = typeof a.server === "string" && a.server ? a.server : typeof details?.server === "string" ? details.server : "";
		return { name: `🔌 ${String(a.tool)}`, summary: server.slice(0, 160) };
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
 * terms, never the internal tool name. Running gets the in-flight form, done
 * the finished form, and an error says the step did not happen.
 */
const GENERIC_TOOL_VIEWS: Record<string, { icon: string; running: string; done: string; failed: string }> = {
	bash: { icon: "⌨️", running: "Running command", done: "Ran command", failed: "Couldn't run command" },
	read: { icon: "📄", running: "Reading file", done: "Read file", failed: "Couldn't read file" },
	write: { icon: "✏️", running: "Writing file", done: "Wrote file", failed: "Couldn't write file" },
	edit: { icon: "✏️", running: "Editing file", done: "Edited file", failed: "Couldn't edit file" },
	ls: { icon: "📁", running: "Listing files", done: "Listed files", failed: "Couldn't list files" },
	find: { icon: "📁", running: "Finding files", done: "Looked for files", failed: "Couldn't look for files" },
	grep: { icon: "🔎", running: "Searching files", done: "Searched files", failed: "Couldn't search files" },
	read_skill: { icon: "🛠️", running: "Reading skill", done: "Read skill", failed: "Couldn't use the skill" },
	// The room's Files tools (persistent-room-shelf-tools.ts): a chip reading
	// "Read file" says what happened, where the raw name "read_file" only said
	// which tool did it.
	read_file: { icon: "📄", running: "Reading file", done: "Read file", failed: "Couldn't read file" },
	search_file: { icon: "🔎", running: "Searching file", done: "Searched file", failed: "Couldn't search file" },
	memory_recall: { icon: "🗄️", ...MEMORY_RECALL_STEP },
	kb_search: { icon: "📚", running: "Searching knowledge base", done: "Searched knowledge base", failed: "Couldn't search knowledge base" },
	artifact_list: { icon: "🗂️", running: "Listing artifacts", done: "Listed artifacts", failed: "Couldn't list artifacts" },
	artifact_read: { icon: "🗂️", running: "Reading artifact", done: "Read artifact", failed: "Couldn't read artifact" },
	artifact_write: { icon: "🗂️", running: "Writing artifact", done: "Wrote artifact", failed: "Couldn't write artifact" },
	artifact_write_html_deck: { icon: "🗂️", running: "Building deck", done: "Built deck", failed: "Couldn't build deck" },
	delegate_task: { icon: "🤝", running: "Handing off", done: "Handed off", failed: "Couldn't hand off" },
};

function genericChipName(name: string, status: ToolChatItem["status"]): string {
	const view = GENERIC_TOOL_VIEWS[name];
	// A stopped call keeps the in-flight verb: it WAS reading the file, and it
	// never got to have read it. The icon and the body say how it ended. A
	// command says Stopped instead (stateLabel): "Running command" read as running.
	if (view) return `${view.icon} ${status === "running" || status === "stopped" ? view.running : status === "error" ? view.failed : view.done}`;
	// Unknown tool: humanize the internal name rather than showing it raw.
	return `🛠️ ${readableToolName(name)}`;
}

function summariseToolArgs(name: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	if (name === "bash") return clip(String(args.command ?? ""));
	if (name === "read" || name === "write" || name === "edit" || name === "ls") return clip(pathSummary(String(args.path ?? "")));
	if (name === "find" || name === "grep") return clip([args.pattern, args.path].filter((part) => typeof part === "string" && part.trim()).join(" · "));
	// Files tools take a plain shelf filename (`name`), never a path; a search
	// names its query first and the file it was fenced to, when it was.
	if (name === "read_file") return String(args.name ?? "").slice(0, 160);
	if (name === "search_file") {
		const query = String(args.query ?? "");
		const file = typeof args.name === "string" && args.name.trim() ? ` · ${args.name.trim()}` : "";
		return `${query}${file}`.slice(0, 160);
	}
	if (name === "memory_recall") {
		const query = String(args.query ?? "").trim();
		const topic = typeof args.topic === "string" && args.topic.trim() ? args.topic.trim() : "";
		return (query && topic ? `${query} · ${topic}` : query || topic).slice(0, 160);
	}
	if (name === "fetch_url") return String(args.url ?? "").slice(0, 160);
	// A hand-off names its specialist; a name that is none stays as the room wrote it.
	if (name === "delegate_task") return SPECIALIST_TEMPLATE_LABELS[String(args.template ?? "")] ?? String(args.template ?? "").slice(0, 160);
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

const MARKDOWN_FILE = /\.(?:md|markdown|mdx)$/i;
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Only a Markdown document renders as one: a .md file read, or a page read as Markdown. Everything else is shown as written. */
function isMarkdownResult(item: ToolChatItem): boolean {
	if (item.status !== "done") return false;
	if (item.name === "read" || item.name === "read_file") return MARKDOWN_FILE.test(String(item.args?.path ?? item.args?.name ?? ""));
	return item.name === "fetch_url" && item.details?.format === "markdown";
}

/** What a finished write or edit did, in the person's words; the model keeps the tool's own text. */
function plainDoneLine(item: ToolChatItem): string | null {
	if (item.status !== "done" || !item.result) return null;
	const path = String(item.args?.path ?? "");
	const name = lastName(path) || path;
	if (item.name === "write" && /^Successfully wrote \d+ bytes to /.test(item.result)) return `Saved ${name}.`;
	const edits = item.name === "edit" ? /^Successfully replaced (\d+) block\(s\) in /.exec(item.result) : null;
	if (edits) return Number(edits[1]) === 1 ? `Changed ${name}.` : `Changed ${edits[1]} places in ${name}.`;
	return null;
}

function ResultBody({ text, markdown }: { text: string; markdown: boolean }) {
	const unwrapped = markdown ? unwrapOuterMarkdownFence(text).replace(FRONT_MATTER, "") : text;
	const trimmed = unwrapped.length > 20000 ? unwrapped.slice(0, 20000) + "\n\n…(truncated)" : unwrapped;
	if (markdown) {
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
					<MarkdownRenderer answer>{answer}</MarkdownRenderer>
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

/**
 * The permanent thread item a Consult transfer leaves behind. Visitor (lila)
 * accent, `@room` chip, question line, a collapsed answer (expandable), and a
 * human-readable provenance footer. The raw sha256 is NEVER rendered — it
 * lives in the item data and the handoff block only. `pending` drives the
 * "included with your next message" hint, shown until the next send consumes
 * the pending-transfer queue.
 */
export function ConsultThreadItem({ item, pending }: { item: Extract<ChatItem, { kind: "consult" }>; pending: boolean }) {
	// §8.4: a stacked item (N≥2) carries the whole conversation in `exchanges[]`;
	// a legacy/N=1 item renders from the flat fields as a single-exchange stack.
	const exchanges = item.exchanges && item.exchanges.length > 0
		? item.exchanges
		: [{ question: item.question, answer: item.answer, l1bFingerprint: item.l1bFingerprint, consultedAt: item.consultedAt }];
	const stacked = exchanges.length > 1;
	const lastIndex = exchanges.length - 1;
	// ONE provenance footer: the latest as-of (§8.4). The raw sha256 is never
	// rendered — it lives in the item data + handoff block only.
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
 * One artifact on the transferred task item, drawn with the task-stream helpers
 * (no duplication).
 * Precedence: (1) the ONE representative thumbnail rides only the FIRST artifact
 * (item.thumbnailDataUri); (2) an SVG whose route URL is derivable renders inline
 * via that URL; (3) otherwise a typed chip (DECK/HTML/SVG kind + basename). Click
 * opens the viewer through onOpen.
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
 * `onOpenTaskArtifact` is the panel-viewer opener that App.tsx passes in
 * through the in-room-chat dispatch; when it is absent
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
							<MarkdownRenderer answer>{summary}</MarkdownRenderer>
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

type ToolChatItem = Extract<ChatItem, { kind: "tool" }>;

/** How long a command has run, once it is long enough to wonder: "7 s", "1 min 5 s". */
export function runningForText(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 3) return "";
	return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

// Counted from when the step began, so a reload counts on; a step with no
// start time counts from when its card appeared.
function RunningFor({ since }: { since?: number }) {
	const [shownAt] = useState(() => Date.now());
	const [now, setNow] = useState(shownAt);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const text = runningForText(now - (since ?? shownAt));
	return text ? <span className="chip-running-for">{text}</span> : null;
}

// The connector adapter's codes for a connection that failed, and for a connector tool that is not there;
// any other failed connector step keeps its own name.
const CONNECTION_FAILURES = new Set(["connect_failed", "server_not_connected", "server_backoff", "not_connected"]);
const MISSING_CONNECTOR_TOOLS = new Set(["tool_not_found", "tool_not_found_after_reconnect"]);

/**
 * The label of a step that did not run, was stopped, or failed for a reason
 * its verb would hide: the state, then what the step was about ("Not run ·
 * rm notes.txt", "No such tool · create_issue"). Null for a step whose label
 * is its verb. `summary` is the step's own summary. `labelOnly`: the label is
 * the whole fact, so the step has nothing to open.
 */
function stateLabel(item: ToolChatItem, summary: string): { name: string; summary: string; labelOnly?: true } | null {
	if (item.name === "bash" && item.status === "stopped") return { name: "⌨️ Stopped", summary };
	if (item.status !== "error") return null;
	const missing = missingToolName(item.result);
	if (missing) return { name: `${GENERIC_TOOL_VIEWS[item.name]?.icon ?? "🛠️"} No such tool`, summary: readableToolName(missing), labelOnly: true };
	if (item.name === "bash" && (commandDeclined(item.result) || nobodyToApprove(item.result) || stoppedBeforeAsking(item.result))) return { name: "⌨️ Not run", summary };
	if (item.name === "delegate_task" && (nobodyToApprove(item.result) || stoppedBeforeAsking(item.result))) return { name: "🤝 Not handed off", summary };
	if (item.name === "mcp") {
		const args = item.args && typeof item.args === "object" ? item.args : {};
		const error = String(item.details?.error ?? "");
		const connector = String(item.details?.server || args.server || args.connect || summary).slice(0, 160);
		if (error === "auth_required") return { name: "🔌 Needs sign-in", summary: connector };
		if (CONNECTION_FAILURES.has(error)) return { name: "🔌 Couldn't connect", summary: connector };
		if (MISSING_CONNECTOR_TOOLS.has(error)) return { name: "🔌 No such tool", summary: String(args.tool ?? args.describe ?? item.details?.requestedTool ?? "").slice(0, 160), labelOnly: true };
	}
	return null;
}

/** What a step's mark means, in words for a screen reader: the mark itself is hidden from it. */
function stateWord(status: ToolChatItem["status"], refused: boolean): string {
	return refused ? "Refused" : status === "error" ? "Failed" : status === "stopped" ? "Stopped" : status === "done" ? "Done" : "";
}

/**
 * The single collapsed tool chip. Rendered standalone for every tool call, and
 * nested (unchanged) inside a ToolBundle for consecutive web_search/fetch_url
 * runs. `saidOnCard`: the card beside a declined command already says so.
 */
function ToolChip({ item: shown, saidOnCard = false }: { item: ToolChatItem; saidOnCard?: boolean }) {
	// A command ended by Stop comes back as an error; the person stopped it, so it reads as stopped.
	const item: ToolChatItem = shown.name === "bash" && shown.status === "error" && commandAborted(shown.result) ? { ...shown, status: "stopped", result: undefined } : shown;
	// Read through the hook, so a card shown before the server answered takes its words once it does.
	const { sharedServer } = useRemoteClientContext();
	const failed = item.status === "error";
	// A refusal (the app's rules, the room's settings or the person kept the step from running) looks calm; a failure stays red.
	const outcome = failed && typeof item.result === "string" ? stepOutcome(item.result, item, sharedServer) : null;
	const refused = outcome?.refused === true;
	const summary = summariseToolArgs(item.name, item.args);
	const icon = item.status === "running" ? "…" : refused ? "⊘" : failed ? "✗" : item.status === "stopped" ? "■" : "✓";
	// fetch_url reads as a source: show the page title + domain (from the
	// result details) instead of the raw tool name and URL argument.
	const isFetchUrl = item.name === "fetch_url";
	const fetchUrl = isFetchUrl ? String(item.details?.finalUrl ?? item.args?.url ?? "") : "";
	const fetchDomain = fetchUrl ? domainOf(fetchUrl) : "";
	const mcpView = item.name === "mcp" ? mcpChipView(item.args, item.details) : null;
	// web_search reads as a lookup: show the query itself, not the tool name.
	const isWebSearch = item.name === "web_search";
	const searchQuery = isWebSearch ? String(item.args?.query ?? "").slice(0, 160) : "";
	const state = stateLabel(item, mcpView ? mcpView.summary : summary);
	const chipName = state
		? state.name
		: isFetchUrl
			? (failed ? "🌐 Couldn't read page" : `🌐 ${String(item.details?.title || "Fetch URL")}`)
			: isWebSearch
				? (failed ? "🔍 Couldn't search the web" : `🔍 ${searchQuery || "Web search"}`)
				: mcpView ? mcpView.name : genericChipName(item.name, item.status);
	const chipSummary = state ? state.summary : isFetchUrl ? fetchDomain || summary : isWebSearch ? (failed ? searchQuery : "") : mcpView ? mcpView.summary : summary;
	// One line in the person's words: why a failed step did not work (written for the model, which keeps it), or what a write or an edit did.
	const plainLine = outcome?.line ?? plainDoneLine(item);
	// Nothing to open: "You declined this command." stands on the card beside it, or the label already says there is no such tool.
	const labelOnly = state?.labelOnly === true || (saidOnCard && failed && commandDeclined(item.result));
	const word = stateWord(item.status, refused);
	const head = (
		<>
			<span className="icon" aria-hidden="true">{icon}</span>
			{word && <span className="sr-only">{word}</span>}
			<span className="name">{chipName}</span>
			{state && chipSummary && <span className="sep" aria-hidden="true">·</span>}
			{/* A command cut at 160 characters, with nothing to open, can still be read in full. */}
			{chipSummary && <span className="summary" title={labelOnly && item.name === "bash" ? String(item.args?.command ?? "") || undefined : undefined}>{chipSummary}</span>}
			{item.status === "running" && item.name === "bash" && <RunningFor since={item.startedAt} />}
			{item.status === "running" && <span className="spinner" />}
		</>
	);
	const look = `tool-chip ${refused ? "refused" : item.status}`;
	if (labelOnly) {
		return (
			<div className={look}>
				<div className="chip-head">{head}</div>
			</div>
		);
	}
	return (
		<details className={look}>
			<summary>{head}</summary>
			<div className="chip-body">
				{item.result && item.status !== "running" ? (
					plainLine ? (
						<div className="chip-line">{plainLine}</div>
					) : (
						<div className="chip-result">
							<span className="label">{failed ? "error" : "result"}</span>
							<ResultBody markdown={isMarkdownResult(item)} text={item.name === "memory_recall" ? memoryRecallDisplayText(item.result) : item.result} />
						</div>
					)
				) : (
					<div className="chip-empty">
						{item.status === "running" ? "Working…" : item.status === "stopped" ? "Stopped before it finished." : "No output."}
					</div>
				)}
			</div>
		</details>
	);
}

/**
 * One transcript line for a run of consecutive web_search or fetch_url calls
 * (the transcript groups runs of length ≥ 2; single calls render the plain
 * chip). The line speaks in outcomes, not call counts: search rests as
 * "Searched the web", fetches count the pages actually read. Failures stay
 * quiet while anything succeeded (a muted "· N failed" footnote); the line
 * only goes red when every call in the run failed, and reads as a refusal
 * when every one of them was refused. While a call is in flight
 * the line shows the in-progress label plus the current query/domain as a
 * muted swapping tail. Expanded, the individual chips nest unchanged — each
 * still opens to its result body.
 */
export function ToolBundle({ items }: { items: ToolChatItem[] }) {
	const isSearch = items[0]?.name === "web_search";
	const succeeded = items.filter((call) => call.status === "done").length;
	const failed = items.filter((call) => call.status === "error").length;
	const active = items.find((call) => call.status === "running");
	const stopped = items.filter((call) => call.status === "stopped").length;
	const allFailed = !active && succeeded === 0 && failed > 0;
	// Stopped only speaks for the whole bundle when nothing in it got anywhere;
	// a run that read three pages before Stop still says it read three.
	const allStopped = !active && succeeded === 0 && failed === 0 && stopped > 0;
	// Every call that did not work was refused (web search switched off, say): the run reads as a refusal, as each call does.
	const refused = items.filter((call) => call.status === "error" && typeof call.result === "string" && stepOutcome(call.result, call)?.refused).length;
	const allRefused = allFailed && refused === failed;
	const status = active ? "running" : allStopped ? "stopped" : allRefused ? "refused" : allFailed ? "error" : "done";
	const icon = active ? "…" : allStopped ? "■" : allRefused ? "⊘" : allFailed ? "✗" : "✓";
	const word = active ? "" : allStopped ? "Stopped" : allRefused ? "Refused" : allFailed ? "Failed" : "Done";
	const label = active
		? (isSearch ? "🔍 Searching the web" : "🌐 Reading pages")
		: allStopped
			? (isSearch ? "🔍 Web search stopped" : "🌐 Stopped reading pages")
			: allFailed
				? (isSearch ? (allRefused ? "🔍 Couldn't search the web" : "🔍 Web search failed") : "🌐 Couldn't read the pages")
				: isSearch
					? "🔍 Searched the web"
					: `🌐 Read ${succeeded} ${succeeded === 1 ? "page" : "pages"}`;
	// The swapping tail: whatever the in-flight call is looking at right now.
	const tail = active
		? isSearch
			? String(active.args?.query ?? "").slice(0, 160)
			: domainOf(String(active.args?.url ?? "")) || String(active.args?.url ?? "").slice(0, 160)
		: "";
	return (
		<div className="bubble-row">
			<details className={`tool-chip tool-bundle ${status}`}>
				<summary>
					<span className="icon" aria-hidden="true">{icon}</span>
					{word && <span className="sr-only">{word}</span>}
					<span className="name">{label}</span>
					{!active && !allFailed && failed > 0 && <span className="bundle-failed">· {failed} failed</span>}
					{!active && !allStopped && stopped > 0 && <span className="bundle-failed">· {stopped} stopped</span>}
					{tail && <span className="summary">{tail}</span>}
					{status === "running" && <span className="spinner" />}
				</summary>
				<div className="bundle-body">
					{items.map((call) => (
						<ToolChip key={call.id} item={call} />
					))}
				</div>
			</details>
		</div>
	);
}

/** The two tools whose consecutive runs collapse into one bundle line. */
export function isBundleableToolItem(item: ChatItem): item is ToolChatItem {
	return item.kind === "tool" && (item.name === "web_search" || item.name === "fetch_url");
}

export interface MessageAttachmentAccess {
	/** Open this shelf file in the right-pane viewer — the same act as clicking its Files row. */
	onOpen: (name: string) => void;
	/**
	 * The route that serves this shelf file inline, for the thumbnail an
	 * image attachment shows above its chip. Undefined when there is no room
	 * to serve from — the chips alone remain.
	 */
	fileUrl?: (name: string) => string;
	/**
	 * Names still on the room's shelf. A chip whose file is gone must not look
	 * clickable and lead nowhere: it renders muted and inert instead. Undefined
	 * while the listing has not loaded — the chip stays clickable rather than
	 * accusing a file of being deleted on the strength of a pending fetch.
	 */
	existingNames?: ReadonlySet<string>;
}

// The extensions the viewer renders inline as a picture (ArtifactViewer.tsx):
// only these get a thumbnail in the bubble; every other file stays a chip.
const THUMBNAIL_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// The picture an image attachment rode in with, above its chip, opening the
// viewer like the chip does. A broken image (the bytes were never a picture,
// or the route refused them) hides itself and leaves the chip as the record.
function UserAttachmentThumb({ name, src, onOpen }: { name: string; src: string; onOpen: () => void }) {
	const [broken, setBroken] = useState(false);
	if (broken) return null;
	return (
		<ImageActions src={src} name={name}>
			<button type="button" className="user-attachment-thumb" title={`${name} — open`} onClick={onOpen}>
				<img className="user-attachment-thumb-img" src={src} alt={name} loading="lazy" onError={() => setBroken(true)} />
			</button>
		</ImageActions>
	);
}

// When the message was written, in the action row under it: a relative label
// ("5 minutes ago") that is revealed with the row on hover, the full date and
// time as its tooltip. No timer per message: the label is computed from the
// clock at render, and the row's mouseenter forces a render, so every hover
// reads fresh. Rendered only for items that carry a `ts` — items from before
// the field existed show no time rather than a wrong one.
function MessageTime({ ts }: { ts: number }) {
	return (
		<time className="message-time" dateTime={new Date(ts).toISOString()} title={formatAbsoluteTime(ts)}>
			{formatRelativeTime(ts, Date.now())}
		</time>
	);
}

type SystemChatItem = Extract<ChatItem, { kind: "system" }>;

/** What the newest failure line's buttons do. `shared`: a shared server, where the admin is a way on no button takes. `reviewsMemory`: whether the room has memory Review can open on. */
export interface FailureLineActions {
	shared: boolean;
	reviewsMemory: boolean;
	onTryAgain: (line: SystemChatItem) => void;
	onReviewMemory: () => void;
	onChooseModel: () => void;
	onReplaceKey: (provider: string) => void;
	onOpenAiSetup: (provider: string) => void;
}

// Only the newest failure line is drawn in full, with its buttons; an older one
// folds to its cause and keeps its Details.
function FailureLine({ item, newest, actions }: { item: SystemChatItem; newest: boolean; actions?: FailureLineActions }) {
	const saidId = useId();
	const [open, setOpen] = useState(false);
	const decided = newest && actions ? failureButtons(item.failure, item.quotaWay, actions.shared, item.gatewayFind) : null;
	const buttons = decided && { ...decided, replaceKey: decided.replaceKey && Boolean(item.provider), reviewMemory: decided.reviewMemory && actions!.reviewsMemory };
	const shown = failureLineParts(item);
	const [cause, rest] = buttons ? [failureLineWords(shown.cause, buttons), failureLineWords(shown.rest, buttons)] : [shown.cause, shown.rest];
	const toggle = item.details ? (
		<button type="button" className="failure-details-toggle" aria-expanded={open} aria-controls={saidId} onClick={() => setOpen((value) => !value)}>
			{newest ? (open ? "Hide details" : "Show details") : "Details"}
		</button>
	) : null;
	const said = item.details ? (
		<div id={saidId} className="failure-said" hidden={!open}>
			{item.detailsFrom && <span className="failure-said-from">From {item.detailsFrom}</span>}
			<span className="failure-said-words">{item.details}</span>
		</div>
	) : null;
	if (!newest) {
		return (
			<div className="system-line error failure-line is-folded">
				<span className="failure-mark" aria-hidden="true" />
				<div className="failure-body">
					<p className="system-line-text failure-cause">{cause}</p>
					{toggle}
					{said}
				</div>
			</div>
		);
	}
	const anyButton = Boolean(buttons && (buttons.tryAgain || buttons.reviewMemory || buttons.chooseModel || buttons.replaceKey || buttons.aiSetup));
	return (
		<div className="system-line error failure-line">
			<span className="failure-mark" aria-hidden="true" />
			<div className="failure-body">
				<div className="system-line-text">
					<p className="failure-cause">{cause}</p>
					{rest && <p className="failure-next">{rest}</p>}
				</div>
				{(anyButton || toggle) && (
					<div className="failure-actions">
						{buttons?.tryAgain && <button type="button" className="rs-btn" onClick={() => actions?.onTryAgain(item)}>Try again</button>}
						{buttons?.reviewMemory && <button type="button" className="rs-btn" onClick={() => actions?.onReviewMemory()}>Review memory</button>}
						{buttons?.chooseModel && <button type="button" className="rs-btn" onClick={() => actions?.onChooseModel()}>Choose another model</button>}
						{buttons?.replaceKey && <button type="button" className="rs-btn" onClick={() => actions?.onReplaceKey(item.provider ?? "")}>Replace key</button>}
						{buttons?.aiSetup && <button type="button" className="rs-btn" onClick={() => actions?.onOpenAiSetup(item.provider ?? "")}>Open AI setup</button>}
						{toggle}
					</div>
				)}
				{said}
			</div>
		</div>
	);
}

/**
 * `copyText` is set by the transcript on exactly one assistant item per reply
 * (see reply-copy.ts): the whole reply's text, ready to copy. Absent on every
 * other assistant item, which then shows no copy button. `copyTs` rides with
 * it: when the reply began, shown next to the button. `saidOnCard` marks a
 * declined command whose card already says so (declinesSaidOnCards in
 * Approval.tsx). `newestFailure`: this failure line is the newest one, so
 * it is drawn in full, with `failureActions` for its buttons. Plain
 * primitives keep the memo working.
 */
function MessageImpl({ item, attachmentAccess, copyText, copyTs, saidOnCard, newestFailure, failureActions }: { item: ChatItem; attachmentAccess?: MessageAttachmentAccess; copyText?: string; copyTs?: number; saidOnCard?: boolean; newestFailure?: boolean; failureActions?: FailureLineActions }) {
	// Bumped on every hover of the row so the relative time is recomputed.
	const [, refreshTime] = useReducer((n: number) => n + 1, 0);
	if (item.kind === "system") {
		// Keyed by whether it is the newest, so a line that folds closes its Details.
		if (item.level === "error") return <FailureLine key={newestFailure ? "newest" : "folded"} item={item} newest={newestFailure === true} actions={failureActions} />;
		return (
			<div className="system-line">
				<span className="system-line-text">{item.text}</span>
			</div>
		);
	}
	if (item.kind === "tool") {
		return (
			<div className="bubble-row">
				<ToolChip item={item} saidOnCard={saidOnCard} />
			</div>
		);
	}

	const isUser = item.kind === "user";
	const assistantText = isUser ? "" : String((item as any).text ?? "");
	const assistantStreaming = !isUser && Boolean((item as any).streaming);
	const userTs = isUser && typeof item.ts === "number" && Number.isFinite(item.ts) ? item.ts : undefined;
	const replyTs = !isUser && typeof copyTs === "number" && Number.isFinite(copyTs) ? copyTs : undefined;
	const attachmentGone = (name: string) => (attachmentAccess?.existingNames ? !attachmentAccess.existingNames.has(name) : false);
	// Thumbnails only for pictures known to be on the shelf: a deleted file
	// has nothing to show (its muted chip already says so), and until the
	// shelf listing is in nothing is requested, so a room opening does not
	// fire a request per old image only to hide the ones that are gone.
	const thumbnails = item.kind === "user" && attachmentAccess?.fileUrl && attachmentAccess.existingNames
		? (item.attachments ?? []).filter((attachment) => THUMBNAIL_EXTENSIONS.has(attachment.extension.toLowerCase()) && !attachmentGone(attachment.name))
		: [];
	// A picture shown as a thumbnail is not repeated as a chip (the picture is
	// the record); documents keep their chip, and so does a picture since
	// deleted, whose muted chip is all that is left of it.
	const thumbnailNames = new Set(thumbnails.map((attachment) => attachment.name));
	const chipAttachments = (item.kind === "user" ? item.attachments ?? [] : []).filter((attachment) => !thumbnailNames.has(attachment.name));
	return (
		<div className={`bubble-row ${isUser ? "user" : ""}`} onMouseEnter={refreshTime}>
			<div className={`bubble-col ${isUser ? "user" : ""}`}>
				<div className={`bubble ${isUser ? "user" : ""}`}>
					{isUser ? (
						<>
							{item.text && <UserMessageText text={item.text} />}
							{/* Attachment chips (files UI slice): the file rode with THIS
							    message — same chip grammar as task artifacts. The chip
							    opens the file in the viewer (taste pass), exactly as its
							    Files row does: a chip that names a file the room can read
							    but the user cannot click was the odd one out. A file since
							    deleted renders muted and inert — the chip stays as the
							    honest record that it rode with this message. */}
							{thumbnails.length > 0 && (
								<div className="user-attachment-thumbs">
									{thumbnails.map((attachment) => (
										<UserAttachmentThumb
											key={attachment.name}
											name={attachment.name}
											src={attachmentAccess!.fileUrl!(attachment.name)}
											onOpen={() => attachmentAccess!.onOpen(attachment.name)}
										/>
									))}
								</div>
							)}
							{chipAttachments.length > 0 && (
								<div className="task-artifact-strip user-attachment-strip">
									{chipAttachments.map((attachment) => {
										const gone = attachmentGone(attachment.name);
										const openable = Boolean(attachmentAccess) && !gone;
										const kind = attachment.extension.replace(/^\./, "").toUpperCase() || "FILE";
										if (!openable) {
											return (
												<span
													key={attachment.name}
													className={`task-file-chip user-attachment-chip${gone ? " gone" : ""}`}
													title={gone ? `${attachment.name} — no longer in Files` : attachment.name}
												>
													<span className="task-kind">{kind}</span>
													<span className="task-file-name">{attachment.name}</span>
												</span>
											);
										}
										return (
											<button
												key={attachment.name}
												type="button"
												className="task-file-chip user-attachment-chip openable"
												title={`${attachment.name} — open`}
												onClick={() => attachmentAccess!.onOpen(attachment.name)}
											>
												<span className="task-kind">{kind}</span>
												<span className="task-file-name">{attachment.name}</span>
											</button>
										);
									})}
								</div>
							)}
						</>
					) : (
						<div className="md assistant-markdown">
							{/* A picture the reply shows from the room's shelf opens the
							    viewer through the same onOpen the attachment chips use. */}
							<MarkdownRenderer answer renderMermaid={!assistantStreaming} onOpenRoomFile={attachmentAccess?.onOpen}>{assistantText || (assistantStreaming ? "…" : "")}</MarkdownRenderer>
						</div>
					)}
				</div>
				{/* Action row under the bubble: the user's sits right-aligned, time
				    before the button, all revealed on hover; the reply's sits under
				    its last segment (one per reply, once it has settled) with the
				    button always visible and the reply's start time revealed on
				    hover. */}
				{isUser
					? item.text && (
						<div className="message-actions user">
							{userTs !== undefined && <MessageTime ts={userTs} />}
							<CopyButton text={item.text} className="message-copy-user" />
						</div>
					)
					: copyText && (
						<div className="message-actions assistant">
							<CopyButton text={copyText} className="message-copy-assistant" />
							{replyTs !== undefined && <MessageTime ts={replyTs} />}
						</div>
					)}
			</div>
		</div>
	);
}

export const Message = memo(MessageImpl);
