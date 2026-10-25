// How a room's step cards read in the chat, rendered as the page renders them:
// a step's result shows as written unless it is a Markdown document; find and
// search say what they looked for; a write or an edit says what it did in
// plain words; a long command ends with "…" and says how long it has run; a
// resolved command card says what the person decided; the captions and the
// closed card stay readable; a step that did not run names its state, and a
// failed one what went wrong; an opened step says its reason once, as a plain
// line; a refusal reads calm and apart from a failure; a declined command is
// said once on the screen; a screen reader hears each step's state in words;
// and a running command counts on from when it began, after a reload too,
// even with the browser's clock ahead of the server's.
// Offline: no provider. The last section starts a real server with a
// synthetic model that runs one long command, and needs Chromium.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { STOP_QUESTIONS_SENTENCE } from "../src/server-stop.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ONLY=<words of a label> runs one section alone, so each is its own red-first command.
function check(label: string, body: () => void | Promise<void>): Promise<void> {
	if (process.env.ONLY && !label.includes(process.env.ONLY)) return Promise.resolve();
	return Promise.resolve(body()).then(() => console.log(`  ok  ${label}`));
}

const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
const { createElement } = pageRequire("react");
(globalThis as any).React = pageRequire("react");
const { renderToStaticMarkup } = pageRequire("react-dom/server");
// Page components (.tsx): loaded at run time, as the server build compiles scripts without JSX.
const message: any = await import(new URL("../../web-ui/src/components/Message.tsx", import.meta.url).href);
const approval: any = await import(new URL("../../web-ui/src/components/Approval.tsx", import.meta.url).href);

const chip = (item: Record<string, unknown>, props: Record<string, unknown> = {}): string => renderToStaticMarkup(createElement(message.Message, { item: { kind: "tool", id: "t1", args: {}, ...item }, ...props }));
const chipName = (html: string) => /<span class="name">([^<]*)<\/span>/.exec(html)?.[1] ?? "";
const chipSummary = (html: string) => /<span class="summary"[^>]*>([^<]*)<\/span>/.exec(html)?.[1] ?? "";
const chipIcon = (html: string) => /<span class="icon"[^>]*>([^<]*)<\/span>/.exec(html)?.[1] ?? "";
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
// What an opened step says: its plain line, its captioned result, or its empty line.
const bodyText = (html: string) => decode((/<div class="chip-line">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? /<div class="chip-result">([\s\S]*?)<\/div><\/div>/.exec(html)?.[1] ?? /<div class="chip-empty">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "").replace(/<span class="label">[^<]*<\/span>/, "").replace(/<[^>]+>/g, ""));
// A state label: the state, a dot, then what the step was about ("Not run · rm notes.txt").
const dotted = (html: string) => /<span class="name">[^<]*<\/span><span class="sep" aria-hidden="true">·<\/span><span class="summary"[^>]*>/.test(html);
// A step with nothing to open: its label alone.
const labelOnly = (html: string) => html.includes('<div class="chip-head">') && !html.includes("<details") && !html.includes("chip-body");

await check("a step's result shows as written unless it is a Markdown document", () => {
	const output = "# Totals\nline a\nline b\nline c\n- item x";
	const command = chip({ name: "bash", status: "done", args: { command: "./totals.sh" }, result: output });
	assert(command.includes(`<pre class="raw-result">${output}</pre>`) && !/<h1[\s>]/.test(command), `command output shows as written, got ${command}`);
	const text = chip({ name: "read", status: "done", args: { path: "notes.txt" }, result: output });
	assert(text.includes(`<pre class="raw-result">${output}</pre>`), `a text file shows as written, got ${text}`);
	const skill = "---\nname: weekly-report\ndescription: Writes the weekly status report.\n---\n\n# Weekly report\n\n1. Read the notes folder.\n2. Write the report.";
	const markdownFile = chip({ name: "read", status: "done", args: { path: "/Users/x/.exxperts/agent/skills/weekly-report/SKILL.md" }, result: skill });
	assert(/<h1[^>]*>Weekly report<\/h1>/.test(markdownFile) && markdownFile.includes("<ol>") && !markdownFile.includes("name: weekly-report") && !markdownFile.includes("<hr"), `a Markdown file renders without its front matter, got ${markdownFile}`);
	const shelfFile = chip({ name: "read_file", status: "done", args: { name: "guide.md" }, result: "# Guide\n\n- one" });
	assert(/<h1[^>]*>Guide<\/h1>/.test(shelfFile), `a room file in Markdown renders too, got ${shelfFile}`);
	const page = chip({ name: "fetch_url", status: "done", args: { url: "https://example.org/a" }, details: { format: "markdown", title: "A" }, result: "Source: [https://example.org/a](https://example.org/a)\n\n# Export guide" });
	assert(/<h1[^>]*>Export guide<\/h1>/.test(page), `a page read as Markdown renders, got ${page}`);
	const rawPage = chip({ name: "fetch_url", status: "done", args: { url: "https://example.org/a.txt" }, details: { format: "raw", title: "a.txt" }, result: "# not a heading\nline" });
	assert(rawPage.includes("<pre class=\"raw-result\">"), `a page read as plain text shows as written, got ${rawPage}`);
});

await check("find and search say what they looked for", () => {
	const find = chip({ name: "find", status: "done", args: { pattern: "*.md", path: "docs" }, result: "docs/a.md" });
	assert(chipName(find).endsWith(" Looked for files") && chipSummary(find) === "*.md · docs", `find, got ${chipName(find)} / ${chipSummary(find)}`);
	assert(chipSummary(chip({ name: "find", status: "done", args: { pattern: "*.md" }, result: "a.md" })) === "*.md", "find with no folder names the pattern alone");
	const grep = chip({ name: "grep", status: "done", args: { pattern: "SECRET", path: "docs" }, result: "No matches found" });
	assert(chipSummary(grep) === "SECRET · docs", `grep, got ${chipSummary(grep)}`);
});

await check("two web searches show no search service name", () => {
	const search = (id: string, query: string) => ({ kind: "tool", id, name: "web_search", args: { query }, status: "done", result: "1. A", details: { provider: "searxng" } });
	const html = renderToStaticMarkup(createElement(message.ToolBundle, { items: [search("w1", "export tool"), search("w2", "import tool")] }));
	assert(!html.includes("searxng") && html.includes("export tool"), `no provider beside a search, got ${html}`);
});

await check("a long command ends with an ellipsis", () => {
	const long = `for f in ${"a".repeat(150)}; do wc -l "$f"; done`;
	const summary = chipSummary(chip({ name: "bash", status: "done", args: { command: long }, result: "ok" }));
	assert(summary.length === 161 && summary.endsWith("…") && summary.startsWith("for f in"), `cut with "…", got ${summary}`);
	assert(chipSummary(chip({ name: "bash", status: "done", args: { command: "ls -la" }, result: "ok" })) === "ls -la", "a short command is as written");
});

await check("a write or an edit says what it did in plain words, the file name first", () => {
	const writeArgs = { path: "/Users/x/Projects/demo/docs/report.md", content: "# Report\n\nThe export runs on Monday.\n" };
	const wrote = chip({ name: "write", status: "done", args: writeArgs, result: "Successfully wrote 37 bytes to /Users/x/Projects/demo/docs/report.md" });
	assert(chipSummary(wrote) === "report.md · /Users/x/Projects/demo/docs" && !wrote.includes("chars/") && !wrote.includes("bytes"), `the write names the file first and no size, got ${chipSummary(wrote)} / ${wrote}`);
	assert(wrote.includes("Saved report.md.") && !wrote.includes("Successfully"), `the opened write says it saved the file, got ${wrote}`);
	const edited = chip({ name: "edit", status: "done", args: { path: "C:\\exxtest\\notes.txt" }, result: "Successfully replaced 1 block(s) in C:\\exxtest\\notes.txt." });
	assert(chipSummary(edited) === "notes.txt · C:\\exxtest" && edited.includes("Changed notes.txt.") && !edited.includes("Successfully"), `the edit, got ${chipSummary(edited)} / ${edited}`);
	assert(chip({ name: "edit", status: "done", args: { path: "notes.txt" }, result: "Successfully replaced 3 block(s) in /p/notes.txt." }).includes("Changed 3 places in notes.txt."), "several changes are counted");
	assert(chipSummary(chip({ name: "read", status: "done", args: { path: "notes.txt" }, result: "x" })) === "notes.txt", "a bare file name stays as it is");
	const card = (done: string) => decode(renderToStaticMarkup(createElement(approval.Approval, { item: { kind: "approval", id: "a1", requestId: "r1", uiKind: "confirm", title: "Run this command?", done }, onResolve: () => undefined })));
	const yes = card("Yes");
	const no = card("No");
	assert(yes.includes("You approved this command.") && !yes.includes("Run this command?"), `the approved command card, got ${yes}`);
	assert(no.includes("You declined this command.") && !no.includes("Run this command?"), `the declined command card, got ${no}`);
	const handOff = (done: string) => decode(renderToStaticMarkup(createElement(approval.Approval, { item: { kind: "approval", id: "a2", requestId: "r2", uiKind: "confirm", title: "Have a specialist create an SVG chart?", done }, onResolve: () => undefined })));
	assert(handOff("Yes").includes("You approved the specialist task: an SVG chart.") && !handOff("Yes").includes("Have a specialist"), `the approved hand-off card, got ${handOff("Yes")}`);
	assert(handOff("No").includes("You declined the specialist task: an SVG chart.") && !handOff("No").includes("Have a specialist"), `the declined hand-off card, got ${handOff("No")}`);
});

await check("a refused hand-off says why in one plain line", () => {
	const refused = (result: string, template = "nope") => decode(chip({ name: "delegate_task", status: "error", args: { template }, result }));
	// Opened, the line says why, never the label's words again.
	const unknown = refused('"nope" is not a specialist template. Available templates: svg-chart, html-page.');
	assert(chipName(unknown) === "🤝 Couldn't hand off" && bodyText(unknown) === 'No specialist called "nope" in this room.' && !unknown.includes("Available templates"), `an unknown specialist, got ${chipName(unknown)} / ${bodyText(unknown)}`);
	const busy = refused("The specialist limit (2 at a time) is reached. Wait for a running task to finish or ask the user to stop one.", "diagram-svg");
	assert(bodyText(busy) === "2 specialists are already working. Try again when one finishes." && !busy.includes("ask the user"), `the specialist limit, got ${bodyText(busy)}`);
	// A room runs one specialist at a time (index.ts, WEB_TASK_CAP), so this is the line a person meets.
	const one = refused("The specialist limit (1 at a time) is reached. Wait for a running task to finish or ask the user to stop one.", "diagram-svg");
	assert(bodyText(one) === "1 specialist is already working. Try again when it finishes.", `the limit of one specialist, in the singular, got ${bodyText(one)}`);
	// No page to approve it on reads as the away case: nobody was there to approve it.
	const noUi = refused("Delegation requires the interactive room UI; there is no user here to approve it.", "diagram-svg");
	assert(chipName(noUi) === "🤝 Not handed off" && chipSummary(noUi) === "Diagram" && dotted(noUi) && bodyText(noUi) === "Nobody was there to approve it, so nothing was handed off." && !noUi.includes("interactive room UI"), `no one to approve, got ${chipName(noUi)} / ${chipSummary(noUi)} / ${bodyText(noUi)}`);
	const label = (status: string) => decode(chipName(chip({ name: "delegate_task", status, args: { templateId: "svg-chart" }, result: status === "error" ? "The specialist limit (2 at a time) is reached." : "Started." })));
	assert(label("error") === "🤝 Couldn't hand off" && label("running") === "🤝 Handing off" && label("done") === "🤝 Handed off", `a hand-off's step says what happened to the hand-off, got ${["error", "running", "done"].map(label).join(" | ")}`);
});

await check("a hand-off's step names the specialist in readable words, from one list of names", async () => {
	const summary = (template: string) => decode(chipSummary(chip({ name: "delegate_task", status: "done", args: { template, brief: "Draw the export flow." }, result: "Specialist started." })));
	assert(summary("diagram-svg") === "Diagram" && summary("chart-html") === "Chart" && summary("deck") === "Slide deck" && summary("document-html") === "Document", `the step names the specialist, got ${["diagram-svg", "chart-html", "deck", "document-html"].map(summary).join(" | ")}`);
	assert(summary("nope") === "nope", "a name that is no specialist stays as the room wrote it, as its line says");
	const labels: any = await import("../src/specialist-template-labels.js");
	const { listSpecialistTemplates } = await import("../src/specialist-templates.js");
	assert(listSpecialistTemplates().every((template) => template.label === labels.SPECIALIST_TEMPLATE_LABELS[template.id]), "the registry and the page read the same names");
	assert(!/^import /m.test(fs.readFileSync(new URL("../src/specialist-template-labels.ts", import.meta.url), "utf8")), "the names file has no imports, so the page can read it");
});

await check("a running command says how long it has run", () => {
	assert(message.runningForText(2_000) === "" && message.runningForText(7_400) === "7 s" && message.runningForText(65_000) === "1 min 5 s", `the elapsed words, got ${[2_000, 7_400, 65_000].map((ms) => message.runningForText?.(ms)).join(" | ")}`);
	const source = fs.readFileSync(new URL("../../web-ui/src/components/Message.tsx", import.meta.url), "utf8");
	assert(/item\.status === "running" && item\.name === "bash" && <RunningFor since=\{item\.startedAt\} \/>/.test(source), "a running command's card shows the time");
});

await check("captions and the closed card stay readable", () => {
	const css = fs.readFileSync(new URL("../../web-ui/src/styles.css", import.meta.url), "utf8");
	const label = /\.tool-chip \.chip-result \.label \{[^}]*\}/.exec(css)?.[0] ?? "";
	assert(label.includes("color: var(--muted);"), `the ERROR and RESULT captions use the muted text colour (4.5:1 or more in both themes), got ${label}`);
	const chipRule = /\.tool-chip \{[^}]*\}/.exec(css)?.[0] ?? "";
	assert(chipRule.includes("min-width: 0;") && chipRule.includes("max-width: min(760px, 100%);"), `a card never grows past its bubble, so a long summary ends with "…", got ${chipRule}`);
});

await check("a specialist's notes keep their single line breaks", () => {
	const source = fs.readFileSync(new URL("../../web-ui/src/components/Message.tsx", import.meta.url), "utf8");
	assert(source.includes("<MarkdownRenderer answer>{summary}</MarkdownRenderer>"), "the notes render as an answer");
});

await check("the approval questions have one source", async () => {
	const titles = await import("../src/room-approval-titles.js");
	assert(titles.handOffApprovalTitle("an SVG chart") === "Have a specialist create an SVG chart?" && titles.handOffApprovalSubject("Have a specialist create an SVG chart?") === "an SVG chart" && titles.handOffApprovalSubject("Run this command?") === null, "the hand-off question is built and read in one place");
	for (const file of ["../src/persistent-room-delegate-tool.ts", "../src/persistent-agents.ts", "../../web-ui/src/components/Approval.tsx", "../src/persistent-room-bash-approval.ts"]) {
		const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
		assert(source.includes("room-approval-titles") && !/[`/^]Have a specialist create/.test(source) && !source.includes('"Run this command?"'), `${file} takes the questions from room-approval-titles.ts`);
	}
});

await check("a question nobody was there to answer never offers its buttons or claims an answer", () => {
	const away = "The user left the room while this response was being written, so interactive questions cannot be answered right now. Proceed with your best judgment and finish the task; anything that strictly needs the user's approval must be left undone and mentioned in your answer.";
	// Said once, where the person reads it: the step's label carries the outcome, opened it says why, and the card shows only its question.
	const step = decode(chip({ name: "bash", status: "error", args: { command: "rm report-old.txt" }, result: away }));
	assert(chipName(step) === "⌨️ Not run" && chipSummary(step) === "rm report-old.txt" && dotted(step) && !step.includes("Couldn't run command") && !step.includes("best judgment"), `the saved step of a command nobody approved says it did not run, then the command, got ${chipName(step)} / ${chipSummary(step)}`);
	assert(bodyText(step) === "Nobody was there to approve it, so the command did not run." && step.split(/nobody was there/i).length === 2 && !step.includes("Nothing ran.") && !step.includes("No output."), `opened, the step says why it did not run, once, got ${bodyText(step)}`);
	const handOffStep = decode(chip({ name: "delegate_task", status: "error", args: { template: "diagram-svg" }, result: away }));
	assert(chipName(handOffStep) === "🤝 Not handed off" && chipSummary(handOffStep) === "Diagram" && dotted(handOffStep) && bodyText(handOffStep) === "Nobody was there to approve it, so nothing was handed off." && !handOffStep.includes("Not run") && !handOffStep.includes("best judgment"), `the saved step of a hand-off nobody approved says it once, got ${chipName(handOffStep)} / ${chipSummary(handOffStep)} / ${bodyText(handOffStep)}`);
	const card = (title: string, live: boolean) => {
		const [item] = approval.withUnansweredApprovals([{ kind: "approval", id: "a9", requestId: "r9", uiKind: "confirm", title }], new Set(live ? ["r9"] : []));
		return decode(renderToStaticMarkup(createElement(approval.Approval, { item, onResolve: () => undefined })));
	};
	for (const title of ["Run this command?", "Have a specialist create an SVG chart?", "Overwrite notes.txt?"]) {
		const ended = card(title, false);
		assert(ended.includes(title) && ended.includes("approval-unanswered") && !/Not run|Not handed off|Not answered|nobody was there/.test(ended) && !ended.includes("<button") && !ended.includes("You approved"), `a card whose question ended shows only its question, greyed, got ${ended}`);
	}
	const styles = fs.readFileSync(new URL("../../web-ui/src/styles.css", import.meta.url), "utf8");
	assert(/\.approval-unanswered[^{]*\{[^}]*color:\s*var\(--muted\)/.test(styles), "the ended question is greyed");
	assert(card("Run this command?", true).includes("<button"), "a question still open keeps its buttons");
	const app = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	assert(/items=\{shownItems\}/.test(app) && /withUnansweredApprovals\(items, liveApprovalIds\)/.test(app), "the room's chat shows its items with ended questions resolved");
	const resolve = app.slice(app.indexOf("const resolveApproval = useCallback"), app.indexOf("const openApprovalPreview"));
	assert(/if \(!liveApprovalIdsRef\.current\.has\(requestId\)\) return;/.test(resolve), "an answer to a question that ended is never sent or recorded");
});

await check("a step that did not run, or was stopped, names its state, a dot, then what it was about", () => {
	const declined = decode(chip({ name: "bash", status: "error", args: { command: "rm notes.txt" }, result: "The user declined this command. Do not run it or retry variants of it unless the user asks." }));
	assert(chipName(declined) === "⌨️ Not run" && chipSummary(declined) === "rm notes.txt" && dotted(declined) && bodyText(declined) === "You declined this command.", `a declined command with no card beside it, got ${chipName(declined)} / ${chipSummary(declined)} / ${bodyText(declined)}`);
	// A command asked with no page to approve it on reads like the away case, as a hand-off does.
	const noPage = decode(chip({ name: "bash", status: "error", args: { command: "rm notes.txt" }, result: "Running commands requires the interactive room UI; there is no user here to approve them." }));
	assert(chipName(noPage) === "⌨️ Not run" && chipSummary(noPage) === "rm notes.txt" && dotted(noPage) && noPage.includes('class="tool-chip refused"') && bodyText(noPage) === "Nobody was there to approve it, so the command did not run." && !noPage.includes("interactive room UI"), `a command with no page to approve it on, got ${chipName(noPage)} / ${chipSummary(noPage)} / ${bodyText(noPage)}`);
	const stops: Array<[string, Record<string, unknown>]> = [
		["stopped", { name: "bash", status: "stopped", args: { command: "sleep 25; echo never" } }],
		["ended by Stop", { name: "bash", status: "error", args: { command: "sleep 25; echo never" }, result: "Command aborted" }],
		["ended by Stop after some output", { name: "bash", status: "error", args: { command: "sleep 25; echo never" }, result: "line 1\n\nCommand aborted" }],
	];
	for (const [how, item] of stops) {
		const stopped = decode(chip(item));
		assert(chipName(stopped) === "⌨️ Stopped" && chipSummary(stopped) === "sleep 25; echo never" && dotted(stopped) && chipIcon(stopped) === "■" && stopped.includes('class="tool-chip stopped"') && bodyText(stopped) === "Stopped before it finished." && !stopped.includes("Running command"), `a command ${how} reads Stopped, got ${chipName(stopped)} / ${bodyText(stopped)}`);
	}
	// A label that is a verb on its object needs no dot.
	const read = decode(chip({ name: "read", status: "done", args: { path: "notes.txt" }, result: "x" }));
	const page = decode(chip({ name: "fetch_url", status: "error", args: { url: "http://127.0.0.1:9078/missing" }, result: "Couldn't read page: the site answered 404 Not Found." }));
	assert(!dotted(read) && !dotted(page) && chipName(page) === "🌐 Couldn't read page" && chipSummary(page) === "127.0.0.1", `verb labels keep no dot, got ${chipName(read)} / ${chipName(page)} ${chipSummary(page)}`);
});

await check("connector and tool failures say what went wrong", () => {
	const step = (item: Record<string, unknown>) => decode(chip({ status: "error", ...item }));
	const signIn = step({ name: "mcp", args: { connect: "exxdocs" }, details: { mode: "connect", error: "auth_required", server: "exxdocs" }, result: "Connector \"exxdocs\" needs a sign-in." });
	assert(chipName(signIn) === "🔌 Needs sign-in" && chipSummary(signIn) === "exxdocs" && dotted(signIn) && bodyText(signIn) === "This connector needs you to sign in: Settings, Connectors.", `a connector that needs a sign-in, got ${chipName(signIn)} / ${chipSummary(signIn)} / ${bodyText(signIn)}`);
	const signInCall = step({ name: "mcp", args: { tool: "create_issue", server: "github" }, details: { mode: "call", error: "auth_required", server: "github" }, result: "Connector \"github\" needs a sign-in." });
	assert(chipName(signInCall) === "🔌 Needs sign-in" && chipSummary(signInCall) === "github", `a call on a connector that needs a sign-in names the connector, got ${chipName(signInCall)} / ${chipSummary(signInCall)}`);
	const describe = step({ name: "mcp", args: { describe: "create_issue" }, details: { mode: "describe", error: "tool_not_found" }, result: "Tool \"create_issue\" not found. Use mcp({ search: \"...\" }) to search." });
	// The label says there is no such tool; opened, a line would only say it again, so nothing opens.
	assert(chipName(describe) === "🔌 No such tool" && chipSummary(describe) === "create_issue" && dotted(describe) && labelOnly(describe) && !describe.includes("No connector of this room has a tool called"), `a connector tool nobody has, as its label only, got ${chipName(describe)} / ${chipSummary(describe)} / ${describe}`);
	const call = step({ name: "mcp", args: { tool: "create_issue", server: "github", args: "{\"title\":\"Export fails\"}" }, details: { mode: "call", error: "tool_not_found", requestedTool: "create_issue" }, result: "Tool \"create_issue\" not found. Use mcp({ search: \"...\" }) to search." });
	assert(chipName(call) === "🔌 No such tool" && chipSummary(call) === "create_issue" && labelOnly(call) && !call.includes("Export fails"), `a call of a connector tool nobody has, as its label only, got ${chipName(call)} / ${chipSummary(call)}`);
	const unknown = step({ name: "open_browser", args: { url: "https://docs.example.invalid/" }, result: "Tool open_browser not found" });
	assert(chipName(unknown) === "🛠️ No such tool" && chipSummary(unknown) === "Open browser" && dotted(unknown) && labelOnly(unknown) && !unknown.includes("open_browser") && !unknown.includes("docs.example.invalid") && !unknown.includes("This room has no tool called"), `a tool the room does not have, by its readable name, as its label only, got ${chipName(unknown)} / ${chipSummary(unknown)} / ${unknown}`);
	const down = step({ name: "mcp", args: { tool: "create_issue", server: "github" }, details: { mode: "call", error: "server_backoff", server: "github" }, result: "Server \"github\" not available (last failed 3s ago)" });
	assert(chipName(down) === "🔌 Couldn't connect" && chipSummary(down) === "github" && dotted(down), `a connection that failed, got ${chipName(down)} / ${chipSummary(down)}`);
	for (const failure of [signIn, describe, unknown, down]) assert(chipIcon(failure) === "✗" && failure.includes('class="tool-chip error"'), `these steps ran and failed: red, with ✗, got ${chipIcon(failure)}`);
});

await check("an opened step says its fact once, as a plain line", () => {
	const page = (result: string) => decode(chip({ name: "fetch_url", status: "error", args: { url: "http://127.0.0.1:9078/missing" }, result }));
	const missing = page("Couldn't read page: the site answered 404 Not Found.\n\nWhat the site sent back:\n\n{\"error\":\"not found\"}");
	assert(bodyText(missing) === "The site answered 404 Not Found." && missing.split("Couldn't read page").length === 2, `the 404 opens to what the site answered, said once, got ${bodyText(missing)}`);
	assert(missing.includes('<div class="chip-line">') && !missing.includes('<span class="label">') && !missing.includes("raw-result"), `a one-line reason shows as a plain line, with no caption and no box, got ${missing}`);
	assert(bodyText(page("Couldn't read page: the site answered 404 Not Found.")) === "The site answered 404 Not Found.", "a 404 with nothing sent back reads the same");
	const others: Array<[string, string]> = [
		["Cannot read \"http://127.0.0.1:9078/report.pdf\" \u2014 content type \"application/pdf\" is not textual (binary/file downloads are not supported).", "It is a PDF file."],
		["Cannot read \"http://127.0.0.1:9078/data.zip\" \u2014 content type \"application/zip\" is not textual (binary/file downloads are not supported).", "It is a file, not a page of text."],
		["Fetch failed: Request to http://127.0.0.1:9078/intranet failed: fetch failed", "Nothing answered at that address."],
	];
	for (const [result, line] of others) assert(bodyText(page(result)) === line, `${result.slice(0, 40)}: want ${line}, got ${bodyText(page(result))}`);
	// Real output keeps its caption and its box.
	const failed = decode(chip({ name: "bash", status: "error", args: { command: "npm test" }, result: "npm ERR! missing script: test\nCommand exited with code 1" }));
	assert(failed.includes('<span class="label">error</span>') && failed.includes('<pre class="raw-result">npm ERR! missing script: test'), `a failed command's output keeps its caption and box, got ${failed}`);
	const contents = decode(chip({ name: "read", status: "done", args: { path: "notes.txt" }, result: "line one" }));
	assert(contents.includes('<span class="label">result</span>') && contents.includes('<pre class="raw-result">line one</pre>'), "a file's contents keep theirs");
	const saved = decode(chip({ name: "write", status: "done", args: { path: "/Users/x/docs/report.md" }, result: "Successfully wrote 37 bytes to /Users/x/docs/report.md" }));
	assert(bodyText(saved) === "Saved report.md." && saved.includes('<div class="chip-line">') && !saved.includes('<span class="label">'), `a write's plain line has no caption or box either, got ${saved}`);
	const css = fs.readFileSync(new URL("../../web-ui/src/styles.css", import.meta.url), "utf8");
	assert(/\.tool-chip \.chip-line \{[^}]*color: var\(--fg\);/.test(css), "the plain line reads in the text colour");
});

await check("a refusal is calm and reads apart from a failure", () => {
	const away = "The user left the room while this response was being written, so interactive questions cannot be answered right now. Proceed with your best judgment and finish the task; anything that strictly needs the user's approval must be left undone and mentioned in your answer.";
	const refusals: Array<[string, Record<string, unknown>, string]> = [
		["a secret key", { name: "read", args: { path: "~/.ssh/id_rsa" }, result: "Content policy blocked tool 'read': blocked SSH private-key access. Do not try this file or value again another way; other files you are allowed to use are fine. Explain the constraint to the user and ask for a safe alternative." }, "Blocked: an SSH private key"],
		["a secret file or the app's own data", { name: "write", args: { path: "server.key" }, result: "server.key looks like a secret file or the app's own data, so rooms don't open it, even with Full access. Tell the person; they can open it themselves." }, "Blocked: a secret file or the app's own data"],
		["a file rooms may only read", { name: "edit", args: { path: ".npmrc" }, result: ".npmrc can be read but not changed by rooms, because changing it can run code later. Tell the person." }, "Read only: rooms can read this file but not change it"],
		["the skills folder with Bash off", { name: "read", args: { path: "/Users/a/.exxperts/skills/weekly/SKILL.md" }, result: "/Users/a/.exxperts/skills/weekly/SKILL.md is in the person's own skills folder, which opens to this room only while its terminal (Bash) is on. Tell the person." }, "Opens to this room only with Bash on (Room settings, Workspace, Edit workspace)"],
		["a path outside the room's folder", { name: "read", args: { path: "/etc/hosts" }, result: "Path is outside the selected workspace." }, "That is outside this room's folder."],
		["the skills folder in a run in the background", { name: "read", args: { path: "/Users/a/.exxperts/skills/weekly/SKILL.md" }, result: "/Users/a/.exxperts/skills/weekly/SKILL.md is in the person's own skills folder, which a background run can't open. Tell the person." }, "A run in the background can't open the skills folder."],
		["a skills folder file rooms never change", { name: "edit", args: { path: "/Users/a/.exxperts/skills/weekly/.skill-source.json" }, result: "/Users/a/.exxperts/skills/weekly/.skill-source.json is in the person's own skills folder: rooms can read it only while Bash is on, and never change it. Tell the person." }, "Read only: rooms never change this file."],
		["a declined command", { name: "bash", args: { command: "rm notes.txt" }, result: "The user declined this command. Do not run it or retry variants of it unless the user asks." }, "You declined this command."],
		["a command nobody was there to approve", { name: "bash", args: { command: "rm report-old.txt" }, result: away }, "Nobody was there to approve it, so the command did not run."],
		["a hand-off nobody was there to approve", { name: "delegate_task", args: { template: "diagram-svg" }, result: away }, "Nobody was there to approve it, so nothing was handed off."],
		["a command exxperts stopped before asking", { name: "bash", args: { command: "rm report-old.txt" }, result: STOP_QUESTIONS_SENTENCE }, "exxperts was stopping, so it could not ask you."],
		["a hand-off exxperts stopped before asking", { name: "delegate_task", args: { template: "diagram-svg" }, result: STOP_QUESTIONS_SENTENCE }, "exxperts was stopping, so it could not ask you."],
		["a skill that is off", { name: "read_skill", args: { name: "weekly-report" }, result: "Skill \"weekly-report\" is not enabled for this room. Only skills in the enabled-skills index can be read; the user can enable others in the room settings." }, "This skill is not on for this room. You can turn it on in Room settings, Skills."],
		["a connector that is off", { name: "mcp", args: { connect: "deepwiki" }, details: { error: "connector_not_enabled", server: "deepwiki" }, result: "Connector \"deepwiki\" is not enabled for this room. Room settings control which connectors this room can use." }, "This connector is not on for this room. You can turn it on in Room settings, Connectors."],
		["a file that is already there", { name: "write", args: { path: "notes.txt" }, result: "File already exists in selected workspace. Set overwrite=true to replace it." }, "That file is already there; the room did not overwrite it."],
		["a specialist over the limit", { name: "delegate_task", args: { template: "diagram-svg" }, result: "The specialist limit (2 at a time) is reached. Wait for a running task to finish or ask the user to stop one." }, "2 specialists are already working. Try again when one finishes."],
		["web search switched off in AI setup", { name: "web_search", args: { query: "export guide weekly csv" }, details: { configured: false, provider: "disabled" }, result: "Web search is switched off in AI setup under Web search. Turn it back on there to use it." }, "Web search is switched off in AI setup under Web search. Turn it back on there to use it."],
	];
	for (const [what, item, line] of refusals) {
		const html = decode(chip({ status: "error", ...item }));
		assert(html.includes('class="tool-chip refused"') && chipIcon(html) === "⊘" && !html.includes("✗") && bodyText(html) === line && !html.includes('<span class="label">'), `${what} is a refusal: ⊘, the calm card, the plain line with no caption, got ${chipIcon(html)} / ${/class="(tool-chip[^"]*)"/.exec(html)?.[1]} / ${bodyText(html)}`);
	}
	// The stop declined the question, so the step did not happen: its label names the state.
	const stoppedCommand = decode(chip({ name: "bash", status: "error", args: { command: "rm report-old.txt" }, result: STOP_QUESTIONS_SENTENCE }));
	const stoppedHandOff = decode(chip({ name: "delegate_task", status: "error", args: { template: "diagram-svg" }, result: STOP_QUESTIONS_SENTENCE }));
	assert(chipName(stoppedCommand) === "⌨️ Not run" && chipName(stoppedHandOff) === "🤝 Not handed off", `a step exxperts stopped before asking names its state, got ${chipName(stoppedCommand)} / ${chipName(stoppedHandOff)}`);
	const failures: Array<[string, Record<string, unknown>]> = [
		["a page that answered 404", { name: "fetch_url", args: { url: "http://127.0.0.1:9078/missing" }, result: "Couldn't read page: the site answered 404 Not Found." }],
		["a missing file", { name: "read", args: { path: "missing.txt" }, result: "ENOENT: no such file or directory, access '/Users/a/missing.txt'" }],
		["a connection that failed", { name: "mcp", args: { connect: "exxdocs" }, details: { error: "connect_failed", server: "exxdocs" }, result: "Failed to connect to \"exxdocs\"" }],
		["a connector that needs a sign-in", { name: "mcp", args: { connect: "exxdocs" }, details: { error: "auth_required", server: "exxdocs" }, result: "Connector \"exxdocs\" needs a sign-in." }],
		["a tool the room does not have", { name: "open_browser", args: {}, result: "Tool open_browser not found" }],
		["a command that failed", { name: "bash", args: { command: "false" }, result: "Command exited with code 1" }],
	];
	for (const [what, item] of failures) {
		const html = decode(chip({ status: "error", ...item }));
		assert(html.includes('class="tool-chip error"') && chipIcon(html) === "✗" && !html.includes("⊘"), `${what} ran and failed: red, with ✗, got ${chipIcon(html)} / ${/class="(tool-chip[^"]*)"/.exec(html)?.[1]}`);
	}
	const css = fs.readFileSync(new URL("../../web-ui/src/styles.css", import.meta.url), "utf8");
	const calm = /\.tool-chip\.refused \{[^}]*\}/.exec(css)?.[0] ?? "";
	const ink = /\.tool-chip\.refused > summary \.icon,[^{]*\.tool-chip\.refused > summary \.name[^{]*\{[^}]*\}/.exec(css)?.[0] ?? "";
	assert(calm && !calm.includes("--error") && calm.includes("background: transparent;"), `a refusal's card is neutral, got ${calm || "no rule"}`);
	assert(ink.includes("color: var(--muted);") && !ink.includes("--error"), `a refusal's mark and label are in the muted ink, got ${ink || "no rule"}`);
	assert(css.includes(".tool-chip.error > summary .icon, .tool-chip.error > summary .name { color: var(--error); }"), "a failure stays red");
	assert(css.includes(".tool-chip.error > .chip-head .icon, .tool-chip.error > .chip-head .name { color: var(--error); }"), "a failure with nothing to open (no such tool) stays red too");
});

await check("a declined command says so once on the screen", () => {
	assert(typeof approval.declinesSaidOnCards === "function", "the page knows which declines their card already says");
	const declinedResult = "The user declined this command. Do not run it or retry variants of it unless the user asks.";
	const step = (id: string, status = "error", result = declinedResult) => ({ kind: "tool", id, name: "bash", args: { command: "rm notes.txt" }, status, result });
	const card = (id: string, done?: string) => ({ kind: "approval", id, requestId: `r-${id}`, uiKind: "confirm", title: "Run this command?", ...(done ? { done } : {}) });
	const items = [
		{ kind: "user", id: "u1", text: "Remove the notes." }, step("t1"), card("a1", "Decline"),
		{ kind: "user", id: "u2", text: "Remove both." }, step("t2"), step("t3"), card("a2", "Decline"), card("a3", "No"),
		{ kind: "user", id: "u3", text: "Run one, not the other." }, step("t4", "done", "ok"), step("t5"), card("a4", "Approve"), card("a5", "Decline"),
		{ kind: "user", id: "u4", text: "A step with no card." }, step("t6"),
		{ kind: "user", id: "u5", text: "A card nobody answered." }, step("t7"), card("a7"),
	];
	const said = approval.declinesSaidOnCards(items);
	assert(["t1", "t2", "t3", "t5"].every((id) => said.has(id)) && !["t4", "t6", "t7"].some((id) => said.has(id)), `each declined step whose turn has its declined card, got ${JSON.stringify([...said])}`);
	const beside = decode(chip(step("t1"), { saidOnCard: true }));
	assert(chipName(beside) === "⌨️ Not run" && chipSummary(beside) === "rm notes.txt" && chipIcon(beside) === "⊘" && !beside.includes("<details") && !beside.includes("You declined") && !beside.includes("Nothing ran"), `beside its card, the step is its label alone, with nothing to open, got ${beside}`);
	const long = `find ~/Documents/reports -name '*.csv' -mtime +30 -print0 | xargs -0 rm -v ${"--interactive=never ".repeat(8)}# old exports`;
	const longBeside = decode(chip({ ...step("t8"), args: { command: long } }, { saidOnCard: true }));
	assert(labelOnly(longBeside) && chipSummary(longBeside).endsWith("…") && longBeside.includes(`<span class="summary" title="${long}">`), `a long declined command can still be read in full on its label, got ${longBeside}`);
	const alone = decode(chip(step("t6")));
	assert(alone.includes("<details") && bodyText(alone) === "You declined this command.", `with no card beside it, the step says it when opened, got ${bodyText(alone)}`);
	const room = fs.readFileSync(new URL("../../web-ui/src/components/in-room-chat.tsx", import.meta.url), "utf8");
	assert(/declinesSaidOnCards\(items\)/.test(room) && /<Message [^>]*saidOnCard=\{/.test(room), "the room's chat tells each step whether its card says it");
});

await check("a screen reader hears the state in words, not the mark's name", () => {
	const cases: Array<[string, string, Record<string, unknown>, Record<string, unknown>?]> = [
		["Refused", "⊘", { name: "read", status: "error", args: { path: "~/.ssh/id_rsa" }, result: "Content policy blocked tool 'read': blocked SSH private-key access. Do not try this file or value again another way." }],
		["Failed", "✗", { name: "read", status: "error", args: { path: "missing.txt" }, result: "ENOENT: no such file or directory, access '/Users/a/missing.txt'" }],
		["Stopped", "■", { name: "bash", status: "stopped", args: { command: "sleep 25" } }],
		["Done", "✓", { name: "read", status: "done", args: { path: "notes.txt" }, result: "x" }],
		["Refused", "⊘", { name: "bash", status: "error", args: { command: "rm notes.txt" }, result: "The user declined this command. Do not run it." }, { saidOnCard: true }],
		["Failed", "✗", { name: "open_browser", status: "error", args: {}, result: "Tool open_browser not found" }],
	];
	for (const [word, mark, item, props] of cases) {
		const html = decode(chip(item, props));
		assert(html.includes(`<span class="icon" aria-hidden="true">${mark}</span><span class="sr-only">${word}</span>`), `${word}: the mark is hidden from a screen reader, which hears the word, got ${/<span class="icon"[^]*?<span class="name">/.exec(html)?.[0] ?? html}`);
	}
	const page = (status: string) => ({ kind: "tool", id: `p-${status}`, name: "fetch_url", args: { url: "https://a.example.com" }, status, result: status === "error" ? "Couldn't read page: the site answered 404 Not Found." : "ok", details: { title: "A" } });
	const bundles: Array<[string, string, string[]]> = [["Done", "✓", ["done", "error"]], ["Failed", "✗", ["error", "error"]], ["Stopped", "■", ["stopped", "stopped"]]];
	for (const [word, mark, statuses] of bundles) {
		const html = decode(renderToStaticMarkup(createElement(message.ToolBundle, { items: statuses.map((status, n) => ({ ...page(status), id: `p-${n}` })) })));
		assert(html.startsWith(`<div class="bubble-row"><details class="tool-chip tool-bundle`) && html.includes(`<summary><span class="icon" aria-hidden="true">${mark}</span><span class="sr-only">${word}</span>`), `a bundle's mark too (${word}), got ${html.slice(0, 300)}`);
	}
	const css = fs.readFileSync(new URL("../../web-ui/src/styles.css", import.meta.url), "utf8");
	assert(/\.sr-only \{[^}]*position: absolute;[^}]*clip: rect\(0, 0, 0, 0\);/.test(css), "the words are for assistive technology only: nothing visible changes");
});

await check("a group of steps that were all refused reads as a refusal; a real failure or a step that worked keeps the group's look", () => {
	const off = "Web search is switched off in AI setup under Web search. Turn it back on there to use it.";
	const search = (id: string, result: string, status = "error") => ({ kind: "tool", id, name: "web_search", args: { query: `query ${id}` }, status, result, details: status === "error" ? { configured: false, provider: "disabled" } : {} });
	const page = (id: string, result: string, status = "error") => ({ kind: "tool", id, name: "fetch_url", args: { url: `https://${id}.example.com` }, status, result, details: status === "done" ? { title: id } : {} });
	const blocked = "Content policy blocked tool 'fetch_url': blocked GitHub token-looking value. Do not try this file or value again another way.";
	const bundle = (items: Record<string, unknown>[]) => decode(renderToStaticMarkup(createElement(message.ToolBundle, { items })));
	const head = (html: string) => /<summary>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? "";
	// Web search switched off, searched twice: the group reads as each search does.
	const searches = bundle([search("s1", off), search("s2", off)]);
	assert(searches.includes('<details class="tool-chip tool-bundle refused">') && head(searches).includes('<span class="icon" aria-hidden="true">⊘</span><span class="sr-only">Refused</span><span class="name">🔍 Couldn\'t search the web</span>') && !searches.includes("Web search failed") && !head(searches).includes("✗"), `two refused searches read as a refusal, got ${head(searches)}`);
	assert(searches.split('<details class="tool-chip refused">').length === 3, "each search inside is a refusal too");
	const pages = bundle([page("a", blocked), page("b", blocked)]);
	assert(pages.includes('<details class="tool-chip tool-bundle refused">') && head(pages).includes('<span class="name">🌐 Couldn\'t read the pages</span>') && head(pages).includes(">⊘<"), `two refused page reads read as a refusal, got ${head(pages)}`);
	// A real failure among them keeps the group red, with its words.
	const mixedFailure = bundle([search("s3", off), search("s4", "Web search failed: timeout")]);
	assert(mixedFailure.includes('<details class="tool-chip tool-bundle error">') && head(mixedFailure).includes(">✗<") && head(mixedFailure).includes("🔍 Web search failed"), `a refused and a failed search stay a failure, got ${head(mixedFailure)}`);
	// A step that worked keeps the group's done look, the refusal counted beside it as before.
	const mixedDone = bundle([page("c", "ok", "done"), page("d", blocked)]);
	assert(mixedDone.includes('<details class="tool-chip tool-bundle done">') && head(mixedDone).includes(">✓<") && head(mixedDone).includes("🌐 Read 1 page") && head(mixedDone).includes("· 1 failed"), `a read that worked and a refused one keep the done look, got ${head(mixedDone)}`);
	// Only the page's look changes: the model still gets the error flag for a search switched off.
	const tool = fs.readFileSync(new URL("../../../pi-package/extensions/web-search/index.ts", import.meta.url), "utf8");
	assert(/if \(provider === "disabled"\) \{[\s\S]*?isError: true,/.test(tool), "a search switched off is still an error for the model");
});

await check("a formatted .md read wraps a long word inside its box, so the conversation never scrolls sideways", async () => {
	const { chromium } = await import("playwright");
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("  (Chromium not installed: the layout part of this section is skipped)");
		return;
	}
	const css = fs.readFileSync(new URL("../../web-ui/src/styles.css", import.meta.url), "utf8");
	// A long word (a path, a link, a hash) wraps; a code line wraps too, as code in a step always has; a wide table keeps its own sideways scroll.
	const read = chip({ name: "read", status: "done", args: { path: `docs/${"b".repeat(120)}.md` }, result: "a".repeat(300) });
	const wide = chip({ name: "read", status: "done", args: { path: "docs/wide.md" }, result: ["```", `x=${"y".repeat(400)}`, "```", "", `| ${Array.from({ length: 12 }, (_, n) => `column-${n}-${"z".repeat(20)}`).join(" | ")} |`, `|${" --- |".repeat(12)}`, `| ${Array.from({ length: 12 }, () => "v".repeat(30)).join(" | ")} |`].join("\n") });
	const browser = await chromium.launch();
	const measured: Array<{ width: number; scroll: number; shown: number; preWraps: boolean; tableScrolls: boolean }> = [];
	try {
		for (const width of [1280, 390]) {
			const page = await browser.newPage({ viewport: { width, height: 800 } });
			await page.setContent(`<!doctype html><html data-theme="light"><head><style>${css}</style></head><body><div class="bubble-row">${read}</div><div class="bubble-row">${wide}</div></body></html>`);
			await page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
			measured.push({ width, ...(await page.evaluate(() => {
				const root = document.scrollingElement!;
				const pre = document.querySelector(".md-result pre")!;
				const frame = document.querySelector(".md-result .md-table-scroll")!;
				return { scroll: root.scrollWidth, shown: root.clientWidth, preWraps: pre.scrollWidth <= pre.clientWidth, tableScrolls: frame.scrollWidth > frame.clientWidth };
			})) });
			await page.close();
		}
	} finally {
		await browser.close();
	}
	const sideways = measured.filter((m) => m.scroll > m.shown);
	assert(sideways.length === 0, `the conversation scrolls sideways: ${sideways.map((m) => `at ${m.width} px, ${m.scroll} for ${m.shown}`).join("; ")}`);
	assert(measured.every((m) => m.preWraps && m.tableScrolls), `a long code line wraps inside the box and a wide table scrolls inside its own frame, got ${JSON.stringify(measured)}`);
});

await check("a running command counts on from when it began, after a reload too", async () => {
	// The card reads the step's start time, so its first picture already counts from it.
	const shown = chip({ name: "bash", status: "running", args: { command: "sleep 40" }, startedAt: Date.now() - 12_400 });
	assert(/<span class="chip-running-for">12 s<\/span>/.test(shown), `a command that began 12 s ago says so at once, got ${shown}`);
	const { chromium } = await import("playwright");
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("  (Chromium not installed: the reload part of this section is skipped)");
		return;
	}
	const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-step-time-"));
	const home = path.join(tempRoot, "home");
	const agentDir = path.join(home, ".exxperts", "agent");
	const appDir = path.join(home, ".exxperts", "app");
	const agentsRoot = path.join(appDir, "personalized-agents");
	const workspaceRoot = path.join(tempRoot, "workspace");
	for (const dir of [agentDir, agentsRoot, workspaceRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// The model runs one long command, then answers once its result is back.
	const gateway = http.createServer((req, res) => {
		if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			let parsed: any = {};
			try { parsed = JSON.parse(body); } catch {}
			const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
			const sse = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			const base = { id: "cmpl_step_time", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			if (!messages.some((m) => m?.role === "tool")) {
				sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_long", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "sleep 40" }) } }] }, finish_reason: null }] });
				sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
			} else {
				sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] });
				sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 5, total_tokens: 155 } });
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", () => resolve()));
	const gatewayPort = (gateway.address() as { port: number }).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-step-time-key" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }), { mode: 0o600 });
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const api = async (pathname: string, init: AuthedFetchInit = {}) => {
		const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : null };
	};
	let server: ChildProcessWithoutNullStreams | undefined;
	const output: string[] = [];
	const browser = await chromium.launch();
	try {
		server = spawn("npx", ["tsx", "src/index.ts"], { shell: process.platform === "win32", ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: smokeHomeEnv(home, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: path.resolve(webServerDir, "..", ".."), EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv });
		server.stdout.on("data", (chunk) => output.push(String(chunk)));
		server.stderr.on("data", (chunk) => output.push(String(chunk)));
		const until = async (predicate: () => Promise<boolean>, label: string, timeoutMs = 30_000) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (await predicate()) return;
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
			throw new Error(`timed out waiting until ${label}`);
		};
		await until(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "the server is ready");
		const room = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Long Command Desk", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
		assert(room.status === 201, `the room is created, got ${room.status}`);
		const roomId = String(room.body?.agent?.id ?? "");
		const folder = await api(`/api/persistent-agents/${encodeURIComponent(roomId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: workspaceRoot, workspaceAccessMode: "localFiles", bashEnabled: true }) });
		assert(folder.status === 200, `the room gets a folder with Bash on, got ${folder.status}`);
		assert((await api(`/api/persistent-agents/${encodeURIComponent(roomId)}/bash-settings`, { method: "PUT", body: JSON.stringify({ autoApprove: true }) })).status === 200, "commands run without asking");
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		const enter = async () => {
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			if (await page.locator(".whats-new-close").count()) await page.locator(".whats-new-close").click();
			await page.locator(".persistent-agent-card").filter({ hasText: "Long Command Desk" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await page.locator('button[title="Send"], .stop-btn').first().waitFor({ timeout: 15_000 });
			await page.waitForTimeout(800);
		};
		const seconds = async () => {
			const text = (await page.locator(".chip-running-for").first().textContent().catch(() => null)) ?? "";
			const match = /^(?:(\d+) min )?(\d+) s$/.exec(text.trim());
			return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : -1;
		};
		await enter();
		await page.locator("textarea").first().fill("Run the long check.");
		await page.locator("textarea").first().press("Enter");
		await until(async () => (await seconds()) >= 6, "the command has run 6 s");
		const before = await seconds();
		await enter();
		await page.locator(".chip-running-for, .tool-chip").first().waitFor({ timeout: 15_000 });
		await until(async () => (await seconds()) >= 0, "the card shows its time again", 5_000).catch(() => {});
		const after = await seconds();
		assert(after >= before, `after a reload the command's time counts on from ${before} s, got ${after < 0 ? "no time" : `${after} s`}`);
		await page.close();
		// A browser whose clock runs 130 s ahead of the server's, as on a shared server: a command that just began counts from 0 s.
		const skewedRoom = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Skewed Clock Desk", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
		const skewedId = String(skewedRoom.body?.agent?.id ?? "");
		assert(skewedRoom.status === 201 && (await api(`/api/persistent-agents/${encodeURIComponent(skewedId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: workspaceRoot, workspaceAccessMode: "localFiles", bashEnabled: true }) })).status === 200 && (await api(`/api/persistent-agents/${encodeURIComponent(skewedId)}/bash-settings`, { method: "PUT", body: JSON.stringify({ autoApprove: true }) })).status === 200, "a second room with Bash on, commands run without asking");
		const skewed = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		await skewed.addInitScript(() => { const real = Date.now.bind(Date); Date.now = () => real() + 130_000; });
		await skewed.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await skewed.waitForLoadState("networkidle");
		if (await skewed.locator(".whats-new-close").count()) await skewed.locator(".whats-new-close").click();
		await skewed.locator(".persistent-agent-card").filter({ hasText: "Skewed Clock Desk" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		await skewed.locator('button[title="Send"], .stop-btn').first().waitFor({ timeout: 15_000 });
		await skewed.locator("textarea").first().fill("Run the long check.");
		await skewed.locator("textarea").first().press("Enter");
		const shownTime = skewed.locator(".chip-running-for").first();
		await shownTime.waitFor({ timeout: 15_000 });
		const firstShown = ((await shownTime.textContent()) ?? "").trim();
		assert(/^\d s$/.test(firstShown), `with the browser's clock ahead, a command that just began counts from 0 s, got ${JSON.stringify(firstShown)}`);
		// After a reload the running command is replayed before any live step: it still counts in seconds, not from 2 min 10 s.
		const replayed = new Promise<void>((resolve) => skewed.on("websocket", (ws) => ws.on("framereceived", (frame) => { if (String(frame.payload).includes('"turn_reattach_replay_done"')) resolve(); })));
		await skewed.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await skewed.waitForLoadState("networkidle");
		if (await skewed.locator(".whats-new-close").count()) await skewed.locator(".whats-new-close").click();
		await skewed.locator(".persistent-agent-card").filter({ hasText: "Skewed Clock Desk" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		// The card can show before the replay dates it; its next tick shows the replayed start.
		await replayed;
		await skewed.waitForTimeout(1_500);
		const reloadShown = ((await shownTime.textContent()) ?? "").trim();
		assert(/^\d{1,2} s$/.test(reloadShown), `with the browser's clock ahead, a command replayed after a reload counts on in seconds, got ${JSON.stringify(reloadShown)}`);
		await skewed.close();
	} catch (error) {
		console.error(output.join("").slice(-3000));
		throw error;
	} finally {
		await browser.close();
		await stopSmokeServer(server);
		gateway.close();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

console.log("step cards smoke passed");
