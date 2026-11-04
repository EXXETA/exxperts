// How a room's step cards read in the chat, rendered as the page renders them:
// a step's result shows as written unless it is a Markdown document; find and
// search say what they looked for; a write or an edit says what it did in
// plain words; a long command ends with "…" and says how long it has run; a
// resolved command card says what the person decided; the captions and the
// closed card stay readable; a step that did not run names its state, and a
// failed one what went wrong; an opened step says its reason once, as a plain
// line; a finished card of one step opens straight to what the step shows,
// and one with nothing to show does not open; a command that chains several
// things is named by itself in code wherever its step shows, and its question
// reads one line whole and a script, or a clipped command, by its first line
// over the server's text; a question shows no Details for a command (a
// specialist's keeps them), a command's box of six whole lines, and its
// answers under everything at the right; at phone width a folded card's
// sentence takes a second line, and a folded turn is the same card; a
// refusal reads calm and apart from a failure; a declined command is
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
import { STOPPED_BEFORE_ANSWER_SENTENCE } from "../src/turn-ended-by.js";
import { readPageStyles } from "./page-styles.js";

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
const workCard: any = await import(new URL("../../web-ui/src/components/work-card.tsx", import.meta.url).href);

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
// The room draws its steps in a work card: one stretch of items, as the room's chat passes them.
// Drawn once, as a string: React's note that a layout effect does not run there is not the card's.
// `markup` is as React writes it, for a browser to read; `card` decoded, for a check to read.
const markup = (items: Record<string, unknown>[], props: Record<string, unknown> = {}): string => {
	const error = console.error;
	console.error = (...args: unknown[]) => { if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) error(...args); };
	try {
		return renderToStaticMarkup(createElement(workCard.WorkStretch, { items, live: false, elsewhere: false, keyboardApprovalId: null, onResolve: () => undefined, ...props }));
	} finally {
		console.error = error;
	}
};
const card = (items: Record<string, unknown>[], props: Record<string, unknown> = {}): string => decode(markup(items, props));
// Each row of a card: its state and its words, tags dropped.
const cardRows = (html: string) => [...html.matchAll(/<div class="wk-row[^"]*" data-s="([^"]+)">([\s\S]*?)<span class="wk-mk">/g)].map((match) => ({ state: match[1], words: match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(), square: /wk-row-ic"><svg[^>]*><rect /.test(match[2]) }));
const toolItem = (id: string, item: Record<string, unknown>) => ({ kind: "tool", id, args: {}, ...item });

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

await check("a specialist's notes keep their single line breaks", () => {
	const source = fs.readFileSync(new URL("../../web-ui/src/components/Message.tsx", import.meta.url), "utf8");
	assert(source.includes("<MarkdownRenderer answer>{summary}</MarkdownRenderer>"), "the notes render as an answer");
});

await check("the approval questions have one source", async () => {
	const titles = await import("../src/room-approval-titles.js");
	assert(titles.handOffApprovalSubject("Have a specialist create an SVG chart?") === "an SVG chart" && titles.handOffApprovalSubject("Run this command?") === null, "an old hand-off question is read in one place");
	for (const file of ["../src/thread-items-by-id.ts", "../../web-ui/src/components/Approval.tsx", "../src/persistent-room-bash-approval.ts"]) {
		const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
		assert(source.includes("room-approval-titles") && !/[`/^]Have a specialist create/.test(source) && !source.includes('"Run this command?"'), `${file} takes the questions from room-approval-titles.ts`);
	}
	// Specialists are switched off: the old card and the refused change request say so in the same words.
	for (const file of ["../src/room-socket.ts", "../../web-ui/src/components/work-card.tsx"]) {
		const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
		assert(source.includes("SPECIALISTS_OFF_SENTENCE") && !source.includes("Specialists are switched off,"), `${file} takes the specialists-off sentence from room-approval-titles.ts`);
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
	assert(card("Run this command?", true).includes("<button"), "a question still open keeps its buttons");
	const app = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	assert(/items=\{shownItems\}/.test(app) && /withUnansweredApprovals\(items, liveApprovalIds\)/.test(app), "the room's chat shows its items with ended questions resolved");
	const resolve = app.slice(app.indexOf("const resolveApproval = useCallback"), app.indexOf("const openApprovalPreview"));
	assert(/if \(!liveApprovalIdsRef\.current\.has\(requestId\)\) return;/.test(resolve), "an answer to a question that ended is never sent or recorded");
});

await check("an old hand-off card left waiting says specialists are switched off, in the room's card", async () => {
	const titles = await import("../src/room-approval-titles.js");
	// An old conversation as the room draws it after a reload: the hand-off step
	// that was under way is stopped, so its card is a row of its own, and no
	// window answers it any more.
	const handOff = "Have a specialist create an SVG diagram?";
	const rowsFor = (ask: Record<string, unknown>) => cardRows(card(approval.withUnansweredApprovals([toolItem("t1", { name: "delegate_task", status: "stopped", args: { template: "diagram-svg" } }), { kind: "approval", id: "a1", requestId: "r1", uiKind: "confirm", ...ask }] as any, new Set())));
	const left = rowsFor({ title: handOff });
	const said = left.filter((row) => row.words.includes(titles.SPECIALISTS_OFF_SENTENCE));
	assert(said.length === 1 && said[0].words === titles.SPECIALISTS_OFF_SENTENCE && said[0].state === "denied" && said[0].square && !left.some((row) => row.words.includes("Not answered")), `the old hand-off card says once, by itself and with the Stopped row's square, that specialists are switched off, got ${JSON.stringify(left)}`);
	// Saved while its turn was still under way and never closed (the app quit), the step still reads running, so the card is that step's row.
	const running = cardRows(card(approval.withUnansweredApprovals([toolItem("t2", { name: "delegate_task", status: "running", args: { template: "diagram-svg" }, startedAt: 1_000 }), { kind: "approval", id: "a2", requestId: "r2", uiKind: "confirm", title: handOff }] as any, new Set())));
	assert(running.length === 1 && running[0].state === "denied" && running[0].words === titles.SPECIALISTS_OFF_SENTENCE && running[0].square, `the old hand-off card on a step saved running says, with the square, specialists are switched off, by itself, got ${JSON.stringify(running)}`);
	// Its neighbours keep their own words: any other question left waiting, and a hand-off the person answered or stopped.
	const other = rowsFor({ title: "Overwrite notes.txt?" });
	assert(other.some((row) => row.words === "Not answered · Overwrite notes.txt?" && !row.square) && !JSON.stringify(other).includes(titles.SPECIALISTS_OFF_SENTENCE), `any other question left waiting reads Not answered, got ${JSON.stringify(other)}`);
	const declined = rowsFor({ title: handOff, done: "No" });
	assert(declined.some((row) => row.words === `Not done · you said no · ${handOff}` && !row.square) && !JSON.stringify(declined).includes(titles.SPECIALISTS_OFF_SENTENCE), `a hand-off the person said no to says so, got ${JSON.stringify(declined)}`);
	const stopped = rowsFor({ title: handOff, stopped: true });
	assert(stopped.some((row) => row.words === `Not done · you pressed Stop · ${handOff}` && !row.square) && !JSON.stringify(stopped).includes(titles.SPECIALISTS_OFF_SENTENCE), `a hand-off Stop closed says so, got ${JSON.stringify(stopped)}`);
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

await check("a step whose card Stop closed reads Not run, or Not handed off, in the person's words", () => {
	const stopAnswered = decode(chip({ name: "bash", status: "error", args: { command: "rm report-old.txt" }, result: STOPPED_BEFORE_ANSWER_SENTENCE }));
	assert(chipName(stopAnswered) === "⌨️ Not run" && chipSummary(stopAnswered) === "rm report-old.txt" && dotted(stopAnswered) && chipIcon(stopAnswered) === "⊘" && bodyText(stopAnswered) === "You pressed Stop before answering.", `a command whose card Stop closed reads Not run, got ${chipName(stopAnswered)} / ${chipIcon(stopAnswered)} / ${bodyText(stopAnswered)}`);
	const stopAnsweredHandOff = decode(chip({ name: "delegate_task", status: "error", args: { template: "diagram-svg" }, result: STOPPED_BEFORE_ANSWER_SENTENCE }));
	assert(chipName(stopAnsweredHandOff) === "🤝 Not handed off", `a hand-off whose card Stop closed reads Not handed off, got ${chipName(stopAnsweredHandOff)}`);
});

await check("Stop's note under an answer, new or saved in the older words, is the answer's muted line", () => {
	const stopLine = (html: string) => /<div class="answer-stop-line">([^<]*)<\/div>/.exec(html)?.[1] ?? null;
	for (const note of ["You stopped this answer.", "Response interrupted by Stop."]) {
		const answered = decode(renderToStaticMarkup(createElement(message.Message, { item: { kind: "assistant", id: "a1", text: `Half an answer.\n\n_${note}_` } })));
		assert(stopLine(answered) === "You stopped this answer." && answered.includes("Half an answer.") && !answered.includes("Response interrupted by Stop."), `an answer ending in "${note}" draws the stop line, got ${answered}`);
		const alone = decode(renderToStaticMarkup(createElement(message.Message, { item: { kind: "system", id: "s1", text: note } })));
		assert(stopLine(alone) === "You stopped this answer.", `Stop before any words, "${note}", is the same line, got ${alone}`);
	}
	const other = decode(renderToStaticMarkup(createElement(message.Message, { item: { kind: "assistant", id: "a2", text: "An answer.\n\n_Response interrupted: the connection was lost._" } })));
	assert(stopLine(other) === null, "another note under an answer stays in the answer");
});

await check("in a window another took the room from, a running step reads Continued in another window", () => {
	const elsewhere = decode(chip({ name: "bash", status: "running", args: { command: "sleep 25; echo never" } }, { elsewhere: true }));
	assert(chipName(elsewhere) === "⌨️ Continued in another window" && chipSummary(elsewhere) === "sleep 25; echo never" && dotted(elsewhere) && chipIcon(elsewhere) === "↗" && !elsewhere.includes('class="spinner"') && !elsewhere.includes("Stopped") && !elsewhere.includes("Running"), `a step another window took reads Continued in another window, got ${chipName(elsewhere)} / ${chipIcon(elsewhere)}`);
	// A finished step keeps its own state there, and a running one here still runs.
	const finished = decode(chip({ name: "bash", status: "done", args: { command: "echo done" }, result: "done" }, { elsewhere: true }));
	assert(chipName(finished) === "⌨️ Ran command", `a finished step keeps its state in that window, got ${chipName(finished)}`);
	const here = decode(chip({ name: "bash", status: "running", args: { command: "sleep 25; echo never" } }));
	assert(here.includes('class="spinner"') && !here.includes("another window"), "a running step in the window that has the room still runs");
	const bundle = decode(renderToStaticMarkup(createElement(message.ToolBundle, { items: [{ kind: "tool", id: "w1", name: "web_search", status: "done", args: { query: "a" }, result: "x" }, { kind: "tool", id: "w2", name: "web_search", status: "running", args: { query: "b" } }], elsewhere: true })));
	assert(bundle.includes("Continued in another window") && !bundle.includes('class="spinner"'), "a running search run reads Continued in another window there");
	// The room's card: the running row reads so, with no spinner; a finished row keeps its own words.
	const there = card([toolItem("c1", { name: "bash", status: "done", args: { command: "echo done" }, result: "done" }), toolItem("c2", { name: "bash", status: "running", args: { command: "sleep 25; echo never" } })], { live: true, elsewhere: true });
	const rows = cardRows(there);
	assert(rows.length === 2 && rows[0].state === "done" && rows[1].state === "elsewhere" && rows[1].words.startsWith("Continued in another window") && !there.includes("wk-spin"), `in the card, a running step another window took reads Continued in another window, got ${JSON.stringify(rows)}`);
	const stillHere = cardRows(card([toolItem("c2", { name: "bash", status: "running", args: { command: "sleep 25; echo never" } })], { live: true }));
	assert(stillHere[0]?.state === "running", `in the window that has the room the card's step still runs, got ${JSON.stringify(stillHere)}`);
});

await check("a step being written shows in the card from its first frame: a command reads Command, a file its size so far", () => {
	const rows = cardRows(card([toolItem("w1", { name: "bash", status: "writing", args: { command: "git status" } }), toolItem("w2", { name: "write", status: "writing", args: { path: "/p/docs/report.md", sizeSoFar: 4300 } })], { live: true }));
	assert(rows[0]?.state === "writing" && rows[0].words === "Command git status", `a command being written reads Command and the command, got ${JSON.stringify(rows[0])}`);
	assert(rows[1]?.state === "writing" && rows[1].words === "Writing report.md4.2 KB", `a file being written names it and its size so far, got ${JSON.stringify(rows[1])}`);
	// Once it runs it says what it does, and its time.
	const running = cardRows(card([toolItem("w1", { name: "bash", status: "running", args: { command: "git status" }, startedAt: Date.now() - 3_200 })], { live: true }));
	assert(running[0]?.state === "running" && !running[0].words.startsWith("Command") && running[0].words.endsWith("3 s"), `a command that runs says what it does and for how long, got ${JSON.stringify(running[0])}`);
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
	assert(failed.includes('<span class="label">Error</span>') && failed.includes('<pre class="raw-result">npm ERR! missing script: test'), `a failed command's output keeps its caption and box, got ${failed}`);
	const contents = decode(chip({ name: "read", status: "done", args: { path: "notes.txt" }, result: "line one" }));
	assert(contents.includes('<span class="label">Result</span>') && contents.includes('<pre class="raw-result">line one</pre>'), "a file's contents keep theirs");
	const saved = decode(chip({ name: "write", status: "done", args: { path: "/Users/x/docs/report.md" }, result: "Successfully wrote 37 bytes to /Users/x/docs/report.md" }));
	assert(bodyText(saved) === "Saved report.md." && saved.includes('<div class="chip-line">') && !saved.includes('<span class="label">'), `a write's plain line has no caption or box either, got ${saved}`);
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
});

await check("a declined command says so once on the screen", () => {
	const declinedResult = "The user declined this command. Do not run it or retry variants of it unless the user asks.";
	const step = (id: string, status = "error", result = declinedResult) => toolItem(id, { name: "bash", args: { command: "rm notes.txt" }, status, result });
	// The command question as the room's server asks it, the command under its fence.
	const ask = (id: string, done?: string) => ({ kind: "approval", id, requestId: `r-${id}`, uiKind: "confirm", title: "Run this command?", message: "Runs in: /work\n\n─── Command (written by the room's model; the app has not verified it) ───\nrm notes.txt", ...(done ? { done } : {}) });
	// The step and its question are one row of the card, which says it once.
	const one = card([step("t1"), ask("a1", "Decline")]);
	const rows = cardRows(one);
	assert(rows.length === 1 && rows[0].state === "denied" && rows[0].words.startsWith("Not run · you said no · rm") && !one.includes("You declined"), `a declined command is one row that says so once, got ${JSON.stringify(rows)}`);
	// Two declined, one run: each its own row, each said once.
	const mixed = cardRows(card([step("t4", "done", "ok"), step("t5"), ask("a4", "Approve"), ask("a5", "Decline")]));
	assert(mixed.length === 2 && mixed[0].state === "done" && mixed[1].words.startsWith("Not run · you said no"), `an approved and a declined command, one row each, got ${JSON.stringify(mixed)}`);
	// With no question beside it, the declined step still says it did not run.
	const alone = cardRows(card([step("t6")]));
	assert(alone.length === 1 && alone[0].words.startsWith("Not run · you said no"), `a declined step with no question, got ${JSON.stringify(alone)}`);
	const room = fs.readFileSync(new URL("../../web-ui/src/components/in-room-chat.tsx", import.meta.url), "utf8");
	assert(/<WorkStretch [^>]*items=\{run\}/.test(room), "the room's chat draws its steps as work cards");
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
	const css = readPageStyles();
	// A long word (a path, a link, a hash) wraps; a code line wraps too, as code in a step always has; a wide table keeps its own sideways scroll.
	const result = (text: string) => renderToStaticMarkup(createElement(message.ResultBody, { markdown: true, text }));
	const read = result("a".repeat(300));
	const wide = result(["```", `x=${"y".repeat(400)}`, "```", "", `| ${Array.from({ length: 12 }, (_, n) => `column-${n}-${"z".repeat(20)}`).join(" | ")} |`, `|${" --- |".repeat(12)}`, `| ${Array.from({ length: 12 }, () => "v".repeat(30)).join(" | ")} |`].join("\n"));
	const browser = await chromium.launch();
	const measured: Array<{ width: number; scroll: number; shown: number; preWraps: boolean; tableScrolls: boolean }> = [];
	try {
		for (const width of [1280, 390]) {
			const page = await browser.newPage({ viewport: { width, height: 800 } });
			// What a step's row opens to in the room's card: its result in the card's box.
			const opened = (body: string) => `<div class="bubble-row"><div class="wk-card" data-open="1" data-live="0"><div class="wk-body"><div class="wk-in"><div class="wk-rows"><div class="wk-out">${body}</div></div></div></div></div></div>`;
			await page.setContent(`<!doctype html><html data-theme="light"><head><style>${css}</style></head><body><div class="messages">${opened(read)}${opened(wide)}</div></body></html>`);
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

await check("an old hand-off card's off line shows in full on a phone, beside a row that keeps its one line", async () => {
	const { chromium } = await import("playwright");
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("  (Chromium not installed: this section is skipped)");
		return;
	}
	const css = readPageStyles();
	const old = (ask: Record<string, unknown>) => approval.withUnansweredApprovals([toolItem("w1", { name: "delegate_task", status: "stopped", args: { template: "diagram-svg" } }), { kind: "approval", id: "w2", requestId: "w2", uiKind: "confirm", ...ask }] as any, new Set());
	// Opened, as the person sees it after a click on the card's head.
	const opened = (items: unknown[]) => markup(items as Record<string, unknown>[]).replace('data-open="0"', 'data-open="1"');
	const browser = await chromium.launch();
	const measured: Array<{ width: number; off: { cut: boolean; text: string }; other: { lines: number } }> = [];
	try {
		for (const width of [1280, 390]) {
			const page = await browser.newPage({ viewport: { width, height: 800 } });
			await page.setContent(`<!doctype html><html data-theme="light"><head><style>${css}</style></head><body><div class="messages">${opened(old({ title: "Have a specialist create an SVG diagram?" }))}${opened(old({ title: `Overwrite ${"quarterly-report-final-".repeat(4)}notes.txt?` }))}</div></body></html>`);
			measured.push({ width, ...(await page.evaluate(() => {
				const [first, second] = [...document.querySelectorAll(".wk-card")];
				const offText = [...first.querySelectorAll(".wk-tx")].at(-1) as HTMLElement;
				const otherText = [...second.querySelectorAll(".wk-tx")].at(-1) as HTMLElement;
				const otherLine = parseFloat(getComputedStyle(otherText).lineHeight) || 20;
				return { off: { cut: offText.scrollWidth > offText.clientWidth, text: offText.textContent ?? "" }, other: { lines: Math.round(otherText.getBoundingClientRect().height / otherLine) } };
			})) });
			await page.close();
		}
	} finally {
		await browser.close();
	}
	const titles = await import("../src/room-approval-titles.js");
	assert(measured.every((m) => !m.off.cut && m.off.text === titles.SPECIALISTS_OFF_SENTENCE), `the off line is never cut, got ${JSON.stringify(measured)}`);
	assert(measured.every((m) => m.other.lines === 1), `another question's row keeps its one line, got ${JSON.stringify(measured)}`);
});

// Opening one is a click: thinking-open-smoke and memory-recall-chip-smoke open one in a room.
await check("a finished card of one step says its step's sentence once and opens straight to what the step shows", () => {
	const rows = (html: string) => (html.match(/class="wk-row"/g) ?? []).length;
	const label = (html: string) => /<span class="wk-lbl ?[^"]*">([^<]*)<\/span>/.exec(html)?.[1] ?? "";
	const command = card([toolItem("o1", { name: "bash", status: "done", args: { command: "npm test" }, result: "12 passed", startedAt: 1_000, endedAt: 2_200 })], { endTs: 3_000 });
	assert(rows(command) === 0 && command.includes('class="wk-rows wk-solo"') && label(command) === "Ran npm test", `one command: its own sentence on the head, no row repeating it, got ${command}`);
	assert(/<button type="button" class="wk-head" aria-expanded="false">[\s\S]*wk-caret/.test(command) && !command.includes("12 passed"), `one command: the head opens it, with its arrow; folded, its output is not drawn yet, got ${command}`);
	const file = card([toolItem("o2", { name: "read", status: "done", args: { path: "notes.txt" }, result: "first line\nsecond line" })], { endTs: 3_000 });
	assert(rows(file) === 0 && label(file) === "Read notes.txt" && file.includes("wk-caret"), `one file read: its name on the head, no row, got ${file}`);
	// The provider's own search keeps no pages yet: nothing to show, so no arrow and nothing to click.
	const search = card([toolItem("o3", { name: "web_search", status: "done", args: { query: "node lts release" } })], { endTs: 3_000 });
	assert(!search.includes("<button") && !search.includes("wk-caret") && search.includes('<div class="wk-head">') && search.includes("Searched the web for node lts release") && search.includes('data-open="0"'), `one search with nothing to show: no arrow, does not open, got ${search}`);
	// One that failed says so on its head, with the failed mark, and opens the same way.
	const failed = card([toolItem("o6", { name: "bash", status: "error", args: { command: "npm test" }, result: "exit 1: 3 tests failed" })], { endTs: 3_000 });
	assert(rows(failed) === 0 && label(failed) === "Couldn't run npm test" && failed.includes("wk-bad") && !failed.includes("wk-ok") && failed.includes("wk-caret"), `one failed command: its own sentence, the failed mark, no row, got ${failed}`);
	// Its neighbours keep their rows: two steps; one that did not run, whose row says why; one still running.
	const two = cardRows(card([toolItem("o4", { name: "bash", status: "done", args: { command: "ls" }, result: "a" }), toolItem("o5", { name: "read", status: "done", args: { path: "a.ts" }, result: "x" })], { endTs: 3_000 }));
	assert(two.length === 2, `two steps: two rows as before, got ${JSON.stringify(two)}`);
	const declined = card([toolItem("o8", { name: "bash", status: "error", args: { command: "rm notes.txt" }, result: "The user declined this command. Do not run it or retry variants of it unless the user asks." })], { endTs: 3_000 });
	assert(cardRows(declined).length === 1 && cardRows(declined)[0].state === "denied" && !declined.includes("wk-bad"), `one declined command keeps its calm row and no failed mark, got ${declined}`);
	const live = cardRows(card([toolItem("o7", { name: "bash", status: "running", args: { command: "sleep 9" } })], { live: true }));
	assert(live.length === 1 && live[0].state === "running", `one running step keeps its row while it runs, got ${JSON.stringify(live)}`);
});

await check("a chained command is named by itself, in code, wherever its step shows; one program keeps its plain words", () => {
	const chained = "cd src && npm test";
	const code = `<code class="wk-code">${chained}</code>`;
	const bash = (id: string, status: string, extra: Record<string, unknown> = {}) => toolItem(id, { name: "bash", status, args: { command: chained }, ...extra });
	// Each row of a card with its markup: its state and what its words are drawn with.
	const rowsOf = (html: string) => [...html.matchAll(/<div class="wk-row[^"]*" data-s="([^"]+)">([\s\S]*?)<span class="wk-mk">/g)].map((match) => ({ state: match[1], html: match[2], words: match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() }));
	const headOfCard = (html: string) => /<(button|div)[^>]*class="wk-head"[\s\S]*?<\/\1>/.exec(html)?.[0] ?? "";
	const several = rowsOf(card([bash("c1", "done", { result: "ok" }), toolItem("c2", { name: "bash", status: "done", args: { command: "npm test" }, result: "ok" })], { endTs: 3_000 }));
	assert(several.length === 2 && several[0].html.includes(code) && several[0].words.startsWith(`Ran ${chained}`), `a row in a card of several steps: Ran and the command in code, got ${JSON.stringify(several[0])}`);
	assert(several[1].html.includes("<b>npm test</b>") && !several[1].html.includes("wk-code"), `one program keeps its plain words, got ${JSON.stringify(several[1])}`);
	const sole = headOfCard(card([bash("c3", "done", { result: "ok" })], { endTs: 3_000 }));
	assert(/class="wk-lbl[^"]*">Ran <code class="wk-code">cd src && npm test<\/code><\/span>/.test(sole), `the head of a one-step card: Ran and the command in code, got ${sole}`);
	const soleFailed = headOfCard(card([bash("c4", "error", { result: "exit 1" })], { endTs: 3_000 }));
	assert(/class="wk-lbl[^"]*">Couldn't run <code class="wk-code">cd src && npm test<\/code><\/span>/.test(soleFailed), `the head of a one-step card that failed, got ${soleFailed}`);
	const plainHead = headOfCard(card([toolItem("c5", { name: "bash", status: "done", args: { command: "npm test" }, result: "ok" })], { endTs: 3_000 }));
	assert(/class="wk-lbl[^"]*">Ran npm test<\/span>/.test(plainHead), `one program's head stays plain words, got ${plainHead}`);
	const notRun = rowsOf(card([bash("c6", "error", { result: "The user declined this command. Do not run it or retry variants of it unless the user asks." })]));
	assert(notRun[0]?.state === "denied" && notRun[0].html.includes(code) && notRun[0].words.startsWith("Not run · you said no · "), `a not-run row, got ${JSON.stringify(notRun)}`);
	const stopped = rowsOf(card([bash("c7", "stopped")]));
	assert(stopped[0]?.state === "stopped" && stopped[0].html.includes(code) && stopped[0].words === `Stopped · Running ${chained}`, `a stopped row, got ${JSON.stringify(stopped)}`);
	const elsewhere = rowsOf(card([bash("c8", "running")], { live: true, elsewhere: true }));
	assert(elsewhere[0]?.state === "elsewhere" && elsewhere[0].html.includes(code), `a row another window goes on with, got ${JSON.stringify(elsewhere)}`);
	const running = rowsOf(card([bash("c9", "running")], { live: true }));
	assert(running[0]?.state === "running" && running[0].html.includes(`class="wk-tx wk-sweep">Running ${code}`), `a running row sweeps over the command too, got ${JSON.stringify(running)}`);
	const dated = rowsOf(card([toolItem("c10", { name: "bash", status: "done", args: { command: 'echo "$(date)"' }, result: "x" }), toolItem("c11", { name: "bash", status: "done", args: { command: "echo '$(date)'" }, result: "x" })], { endTs: 3_000 }));
	assert(dated[0]?.html.includes('<code class="wk-code">echo "$(date)"</code>') && dated[1]?.words.startsWith("Ran echo") && !dated[1].html.includes("wk-code"), `a second program in double quotes is named in code, one in single quotes is not, got ${JSON.stringify(dated)}`);
});

// One command waiting for the person, its question as the room's server asks it (`asked`: the server's text, when it differs).
const askingItems = (command: string, asked = command) => [toolItem("q1", { name: "bash", status: "running", args: { command } }), { kind: "approval", id: "a1", requestId: "r1", uiKind: "confirm", title: "Run this command?", message: `Runs in: /work\nYou can auto-approve bash for this room in Room settings, Folder.\n\n─── Command (written by the room's model; the app has not verified it) ───\n${asked}` }];
const asking = (command: string, asked = command) => card(askingItems(command, asked), { live: true });

await check("the question before a chained command: one line is its title whole; a script or a clipped command keeps a one-line title over the server's text", () => {
	const question = (html: string) => ({ title: /<div class="(wk-tx[^"]*)">([\s\S]*?)<\/div>/.exec(html), sub: /<div class="wk-ask-sub">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? null });
	const codeOf = (title: RegExpExecArray | null) => /<code class="wk-code">([\s\S]*?)<\/code>/.exec(title?.[2] ?? "")?.[1] ?? null;
	// One line: the whole command, never cut, and not said again under it.
	const oneLine = question(asking("cd src && npm test"));
	assert(oneLine.title?.[1] === "wk-tx" && oneLine.title[2] === 'Run <code class="wk-code">cd src && npm test</code>' && oneLine.sub === null, `a one-line chained question, got ${JSON.stringify(oneLine)}`);
	const longLine = `${"npm run build && ".repeat(40)}npm test`;
	const long = question(asking(longLine));
	assert(longLine.length > 300 && longLine.length < 1_200 && codeOf(long.title) === longLine && long.sub === null, `a long one-line chained question is its title whole, got ${JSON.stringify(long)}`);
	// One program: as before, its plain words over the command.
	const plain = question(asking("npm test"));
	assert(plain.title?.[2] === "Run <b>npm test</b>" && plain.sub === "npm test", `one program's question, got ${JSON.stringify(plain)}`);
	// A script: its first line on one line, the server's text under it.
	const script = "python3 - <<'PY'\nimport json\nprint(1)\nPY";
	const many = question(asking(script));
	assert(many.title?.[1] === "wk-tx wk-one" && codeOf(many.title) === "python3 - <<'PY' …" && many.sub === script, `a script's question, got ${JSON.stringify(many)}`);
	// Over 1,200 characters the server clips it and says so: the script's form, with its clip line, one line or many.
	const clip = (text: string) => `${text.slice(0, 1_200)}\n[command preview clipped]`;
	const hugeLine = `echo start && echo ${"x".repeat(1_500)}`;
	const clippedLine = question(asking(hugeLine, clip(hugeLine)));
	assert(clippedLine.title?.[1] === "wk-tx wk-one" && codeOf(clippedLine.title) === `${hugeLine.slice(0, 300)} …` && clippedLine.sub === clip(hugeLine), `a clipped one-line question, got ${JSON.stringify({ title: clippedLine.title?.[1], code: codeOf(clippedLine.title), subEnd: clippedLine.sub?.slice(-40) })}`);
	const hugeScript = `cat <<'EOF' > notes.txt\n${"a line of notes\n".repeat(100)}EOF`;
	const clippedScript = question(asking(hugeScript, clip(hugeScript)));
	assert(clippedScript.title?.[1] === "wk-tx wk-one" && codeOf(clippedScript.title) === "cat <<'EOF' > notes.txt …" && clippedScript.sub?.endsWith("\n[command preview clipped]"), `a clipped script's question, got ${JSON.stringify({ title: clippedScript.title?.[1], code: codeOf(clippedScript.title), subEnd: clippedScript.sub?.slice(-40) })}`);
	const hugePlain = `echo ${"x".repeat(1_500)}`;
	const clippedPlain = question(asking(hugePlain, clip(hugePlain)));
	assert(clippedPlain.title?.[1] === "wk-tx wk-one" && clippedPlain.sub?.endsWith("\n[command preview clipped]"), `a clipped one-program question keeps the clip line under a one-line title, got ${JSON.stringify({ title: clippedPlain.title?.[1], subEnd: clippedPlain.sub?.slice(-40) })}`);
});

await check("a one-line chained question's title keeps the command's own spaces and wraps whole; a script's stays on one line", async () => {
	const { chromium } = await import("playwright");
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("  (Chromium not installed: this section is skipped)");
		return;
	}
	const spaced = "printf '%s' 'a  b\tc' && pwd";
	const longLine = `${"npm run build && ".repeat(12)}npm test`;
	const script = "python3 - <<'PY'\nimport json\nprint(1)\nPY";
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
		// The markup as React writes it (not decoded): the browser reads its escapes.
		const cards = [spaced, longLine, script].map((command) => markup(askingItems(command), { live: true }));
		await page.setContent(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>${readPageStyles()}</style></head><body><div class="messages">${cards.map((html, n) => `<div id="c${n}">${html}</div>`).join("")}</div></body></html>`);
		const got: Array<{ code: string; whole: boolean; lines: number }> = await page.evaluate(`[0, 1, 2].map((n) => {
			const title = document.querySelector("#c" + n + " .wk-ask .wk-tx");
			const code = title.querySelector(".wk-code");
			const line = parseFloat(getComputedStyle(title).lineHeight);
			return { code: code.innerText, whole: title.scrollWidth <= title.clientWidth + 1, lines: Math.round(title.getBoundingClientRect().height / line) };
		})`);
		assert(got[0].code === spaced, `the title shows the command's doubled space and tab as the server sends them, got ${JSON.stringify(got[0])}`);
		assert(got[1].code === longLine && got[1].whole && got[1].lines > 1, `a long one-line command wraps whole at 390 px, never cut, got ${JSON.stringify(got[1])}`);
		assert(got[2].code === "python3 - <<'PY' …" && got[2].lines === 1, `a script's title stays on one line, got ${JSON.stringify(got[2])}`);
	} finally {
		await browser.close();
	}
});

// The questions a person meets: five commands, a typed answer (no room tool asks one yet; memory's edit asks with this placeholder) and a specialist's.
const sixLineScript = "python3 - <<'PY'\nimport json\ndata = {\"a\": 1}\nprint(json.dumps(data))\nprint(\"done\")\nPY";
const clipped = (text: string) => `${text.slice(0, 1_200)}\n[command preview clipped]`;
const longScript = `cat <<'EOF' > release-notes.md\n${"- Item: a line of release notes\n".repeat(80)}EOF`;
const questionCommands: Array<[string, string, string?]> = [
	["short chain", "cd src && npm test"],
	["long chain", `${"npm run build && ".repeat(12)}npm test`],
	["six-line script", sixLineScript],
	["clipped", longScript, clipped(longScript)],
	["npm test", "npm test"],
];
const typedAnswer = [{ kind: "approval", id: "a-typed", requestId: "r-typed", uiKind: "input", title: "Edit the fact", placeholder: "The fact as it should read" }];
const specialistAsk = [toolItem("d1", { name: "delegate_task", status: "running", args: { template: "chart-html", brief: "Chart the totals." } }), {
	kind: "approval", id: "a-spec", requestId: "r-spec", uiKind: "confirm", title: "Have a specialist create a chart?",
	message: "A separate specialist runs this task in isolation: no memory access, no web access, no shell.\n\nIt can only write into one new folder made for this task: tasks/chart/ (at most 10 files). Approving starts it and grants that folder write access.\n\n─── Brief it will receive (written by the room's model; the app has not verified anything below this line) ───\nChart the totals.",
}];

await check("a command question shows no Details and none of the app's facts; a specialist's keeps its Details", () => {
	for (const [name, command, asked] of questionCommands) {
		const html = asking(command, asked);
		const ask = /<div class="wk-row wk-ask"[\s\S]*$/.exec(html)?.[0] ?? "";
		assert(ask.includes("Allow") && !ask.includes("wk-ask-more") && !ask.includes("Details") && !ask.includes("wk-ask-facts") && !ask.includes("Runs in") && !ask.includes("auto-approve"), `the ${name} question shows no Details, no "Runs in" and no auto-approve line, got ${ask}`);
	}
	const specialist = card(specialistAsk, { live: true });
	assert(/<button type="button" class="wk-ask-more" aria-expanded="false">Details<\/button>/.test(specialist) && !specialist.includes("wk-ask-facts"), `the specialist's question keeps Details, closed, got ${specialist}`);
});

await check("a question's answers sit under everything at its right, and a command's box holds six whole lines", async () => {
	const { chromium } = await import("playwright");
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("  (Chromium not installed: this section is skipped)");
		return;
	}
	const cards = [...questionCommands.map(([, command, asked]) => markup(askingItems(command, asked), { live: true })), markup(typedAnswer, { live: true }), markup(specialistAsk, { live: true })];
	const names = [...questionCommands.map(([name]) => name), "typed answer", "specialist"];
	const browser = await chromium.launch();
	try {
		for (const width of [1280, 390]) {
			const page = await browser.newPage({ viewport: { width, height: 900 } });
			// Each card at the room's column width, as the page lays it out, not shrunk to its words.
			await page.setContent(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>${readPageStyles()}</style></head><body><div class="messages">${cards.map((html, n) => `<div id="c${n}" style="width: 100%">${html}</div>`).join("")}</div></body></html>`);
			const rowWidth = await page.locator("#c0 .wk-ask").evaluate((row) => row.getBoundingClientRect().width);
			assert(rowWidth > (width === 1280 ? 700 : 300), `at ${width} px the question spans the card, got ${rowWidth} px`);
			const got: Array<{ below: boolean; right: boolean; order: string; lines: number | null; scrolls: boolean | null }> = await page.evaluate(`[${cards.map((_, n) => n).join(",")}].map((n) => {
				const row = document.querySelector("#c" + n + " .wk-ask");
				const buttons = row.querySelector(".wk-ask-btns").getBoundingClientRect();
				// Every part of the question but its icon and its answers: its title, the command's box, the facts, a text box.
				const above = [...row.querySelectorAll(".wk-tx, .wk-ask-sub, .wk-ask-meta, .wk-ask-more, .wk-ask-facts, .wk-ask-input")].map((el) => el.getBoundingClientRect().bottom);
				const style = getComputedStyle(row);
				const inner = row.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
				const box = row.querySelector(".wk-ask-sub");
				const line = box ? parseFloat(getComputedStyle(box).lineHeight) : 0;
				return {
					below: above.length > 0 && buttons.top >= Math.max(...above) - 0.5,
					right: Math.abs(buttons.right - inner) <= 1,
					order: [...row.querySelectorAll(".wk-btn")].map((button) => button.firstChild.textContent).join(" "),
					lines: box ? Math.round(box.clientHeight / line * 10) / 10 : null,
					scrolls: box ? box.scrollHeight > box.clientHeight + 1 : null,
				};
			})`);
			for (const [n, row] of got.entries()) {
				assert(row.below && row.right, `at ${width} px the ${names[n]} question's answers sit under everything at its right, got ${JSON.stringify(row)}`);
				assert(row.order === (names[n] === "typed answer" ? "Cancel Submit" : "Deny Allow"), `at ${width} px the ${names[n]} question keeps its answers' order, got ${row.order}`);
			}
			const script = got[names.indexOf("six-line script")];
			const clip = got[names.indexOf("clipped")];
			// At 1280 px no line of the script wraps: its six lines fit whole. A longer command scrolls in a box of exactly six lines.
			if (width === 1280) assert(script.lines === 6 && script.scrolls === false, `at 1280 px the six-line script fits its box whole, got ${JSON.stringify(script)}`);
			assert(clip.lines === 6 && clip.scrolls === true, `at ${width} px a longer command scrolls in a box of six whole lines, got ${JSON.stringify(clip)}`);
			await page.close();
		}
	} finally {
		await browser.close();
	}
});

/** Draws `element` in a JSDOM window with a React root, for a check that clicks as the person does. */
async function onLivePage(body: (draw: (element: unknown) => Promise<HTMLElement>, act: (work: () => void | Promise<void>) => Promise<void>) => Promise<void>): Promise<void> {
	const { JSDOM } = await import("jsdom");
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	const globals = globalThis as any;
	globals.window = dom.window;
	globals.document = dom.window.document;
	// Node 21 and later have a global navigator, which React reads once a window exists; Node 20 has none.
	const ownNavigator = !("navigator" in globalThis);
	if (ownNavigator) globals.navigator = dom.window.navigator;
	globals.IS_REACT_ACT_ENVIRONMENT = true;
	// An open thought's box follows its size; JSDOM lays nothing out, so nothing changes size.
	const ownResizeObserver = !("ResizeObserver" in globalThis);
	if (ownResizeObserver) globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
	const { createRoot } = pageRequire("react-dom/client");
	const { act } = pageRequire("react");
	const roots: any[] = [];
	try {
		await body(async (element) => {
			const container = dom.window.document.createElement("div");
			dom.window.document.body.append(container);
			const root = createRoot(container);
			roots.push(root);
			await act(async () => root.render(element));
			return container;
		}, (work) => act(async () => { await work(); }));
		for (const root of roots) await act(async () => root.unmount());
	} finally {
		delete globals.window;
		delete globals.document;
		if (ownNavigator) delete globals.navigator;
		if (ownResizeObserver) delete globals.ResizeObserver;
		delete globals.IS_REACT_ACT_ENVIRONMENT;
	}
}

const thoughtItem = (id: string, ts: number, ms: number) => ({ kind: "thinking", id, ts, ms });
const stretch = (items: Record<string, unknown>[]) => createElement(workCard.WorkStretch, { items, live: false, endTs: 9_000, elsewhere: false, keyboardApprovalId: null, onResolve: () => undefined });
// An opened card's rows, its thoughts' boxes and its step's output, in the order the page shows them.
const shownRows = (container: HTMLElement) => [...container.querySelectorAll(".wk-in .wk-row, .wk-in .wk-line, .wk-in .wk-out")].map((el) => {
	const words = (el.textContent ?? "").replace(/\s+/g, " ").trim();
	if (el.classList.contains("wk-row")) return `row ${el.getAttribute("data-s")}: ${(el.querySelector(".wk-tx")?.textContent ?? "").replace(/\s+/g, " ").trim()}`;
	if (el.classList.contains("wk-out-thought")) return "thought box";
	return `${el.classList.contains("wk-line") ? "line" : "output"}: ${words}`;
});
const headOf = (container: HTMLElement) => ({
	label: container.querySelector(".wk-head .wk-lbl")?.textContent ?? "",
	button: !!container.querySelector("button.wk-head"),
	mark: container.querySelector(".wk-head .wk-hmk .wk-ok") ? "check" : container.querySelector(".wk-head .wk-hmk .wk-bad") ? "failed" : "none",
	open: container.querySelector(".wk-card")?.getAttribute("data-open") === "1",
});

// A card of the model's thinking and one step, opened with one click on its head as the person does.
const openCard = async (act: (work: () => void | Promise<void>) => Promise<void>, container: HTMLElement) => {
	await act(() => (container.querySelector("button.wk-head") as HTMLButtonElement).click());
	return shownRows(container);
};

await check("thought and one step that worked: the step's sentence and check on the head, one click to the thought's row and the step's row, open to its output", () => onLivePage(async (draw, act) => {
	const done = await draw(stretch([thoughtItem("t1-think", 1_000, 2_000), toolItem("t1-read", { name: "read", status: "done", args: { path: "notes.txt" }, result: "first line", startedAt: 3_000, endedAt: 3_100 })]));
	assert(JSON.stringify(headOf(done)) === JSON.stringify({ label: "Read notes.txt", button: true, mark: "check", open: false }), `closed: the read's sentence and its check, got ${JSON.stringify(headOf(done))}`);
	assert(!done.querySelector(".wk-out"), `closed: its output is not drawn yet, got ${done.innerHTML}`);
	const rows = await openCard(act, done);
	// Opened, its rows carry the marks, as a card of several steps' do.
	assert(JSON.stringify(rows) === JSON.stringify(["row done: Thought for 2 s", "row done: Read notes.txt", "output: first line"]) && headOf(done).mark === "none", `opened with one click: the thought's row, then the read's row already open to its output, got ${JSON.stringify(rows)} / ${JSON.stringify(headOf(done))}`);
}));

await check("thought and one failed step: its own sentence and failed mark on the head, one click to the thought, the step's failed row, why it failed and the output", () => onLivePage(async (draw, act) => {
	const missing = "ENOENT: no such file or directory, access '/Users/a/missing.txt'";
	const failed = await draw(stretch([thoughtItem("t2-think", 1_000, 2_000), toolItem("t2-read", { name: "read", status: "error", args: { path: "missing.txt" }, result: missing, startedAt: 3_000, endedAt: 3_300 })]));
	assert(JSON.stringify(headOf(failed)) === JSON.stringify({ label: "Couldn't read missing.txt", button: true, mark: "failed", open: false }), `closed: its own sentence and the failed mark, not "1 failed", got ${JSON.stringify(headOf(failed))}`);
	const rows = await openCard(act, failed);
	assert(JSON.stringify(rows) === JSON.stringify(["row done: Thought for 2 s", "row failed: Couldn't read missing.txt", "line: There is no file called missing.txt.", `output: ${missing}`]) && failed.querySelector('.wk-row[data-s="failed"] .wk-bad'), `opened: the thought's row, the failed row with its mark, why it failed, the output, got ${JSON.stringify(rows)}`);
	// A failure with no known cause: its command and what came back.
	const command = await draw(stretch([thoughtItem("t2-think-run", 1_000, 2_000), toolItem("t2-run", { name: "bash", status: "error", args: { command: "npm test" }, result: "exit 1: 3 tests failed", startedAt: 3_000, endedAt: 4_000 })]));
	assert(headOf(command).label === "Couldn't run npm test" && headOf(command).mark === "failed", `a failed command, closed: its own sentence, got ${JSON.stringify(headOf(command))}`);
	const commandRows = await openCard(act, command);
	assert(JSON.stringify(commandRows) === JSON.stringify(["row done: Thought for 2 s", "row failed: Couldn't run npm test", "output: npm testexit 1: 3 tests failed"]), `a failed command, opened: the thought's row, the failed row and the output, got ${JSON.stringify(commandRows)}`);
}));

await check("think, step, think again: the step's sentence on the head, opened the rows in the order they happened", () => onLivePage(async (draw, act) => {
	const again = await draw(stretch([thoughtItem("t3-think", 1_000, 2_000), toolItem("t3-run", { name: "bash", status: "done", args: { command: "npm test" }, result: "12 passed", startedAt: 3_000, endedAt: 4_000 }), thoughtItem("t3-again", 5_000, 1_000)]));
	assert(headOf(again).label === "Ran npm test", `closed: the command's sentence, got ${JSON.stringify(headOf(again))}`);
	const rows = await openCard(act, again);
	assert(JSON.stringify(rows) === JSON.stringify(["row done: Thought for 2 s", "row done: Ran npm test", "output: npm test12 passed", "row done: Thought for 1 s"]), `opened: thought, the command's row open to its output, thought, got ${JSON.stringify(rows)}`);
}));

await check("thought and one step with nothing to show: the card still opens, so the thought stays in reach", () => onLivePage(async (draw, act) => {
	const bare = await draw(stretch([thoughtItem("t4-think", 1_000, 2_000), toolItem("t4-search", { name: "web_search", status: "done", args: { query: "node lts release" } })]));
	assert(headOf(bare).label === "Searched the web for node lts release" && headOf(bare).button, `closed: the search's sentence, and it opens, got ${JSON.stringify(headOf(bare))}`);
	const rows = await openCard(act, bare);
	assert(JSON.stringify(rows) === JSON.stringify(["row done: Thought for 2 s", "row done: Searched the web for node lts release"]) && headOf(bare).open, `opened: the thought's row and the search's, got ${JSON.stringify(rows)}`);
}));

await check("thought and a step that did not run, still runs, or two steps: the rows as before", () => onLivePage(async (draw, act) => {
	const declined = await draw(stretch([thoughtItem("t5-think", 1_000, 2_000), toolItem("t5-run", { name: "bash", status: "error", args: { command: "rm notes.txt" }, result: "The user declined this command. Do not run it or retry variants of it unless the user asks." })]));
	const declinedRows = await openCard(act, declined);
	assert(declinedRows.length === 2 && declinedRows[1].startsWith("row denied: Not run · you said no") && headOf(declined).label === "1 step not run", `a declined command keeps its calm row, got ${JSON.stringify(declinedRows)} / ${JSON.stringify(headOf(declined))}`);
	const stopped = await draw(stretch([thoughtItem("t6-think", 1_000, 2_000), toolItem("t6-run", { name: "bash", status: "stopped", args: { command: "sleep 9" } })]));
	const stoppedRows = await openCard(act, stopped);
	assert(stoppedRows.length === 2 && stoppedRows[1].startsWith("row stopped: Stopped"), `a stopped command keeps its row, got ${JSON.stringify(stoppedRows)}`);
	const running = await draw(createElement(workCard.WorkStretch, { items: [thoughtItem("t7-think", 1_000, 2_000), toolItem("t7-run", { name: "bash", status: "running", args: { command: "sleep 9" }, startedAt: Date.now() })], live: true, elsewhere: false, keyboardApprovalId: null, onResolve: () => undefined }));
	assert(JSON.stringify(shownRows(running).map((row) => row.split(":")[0])) === JSON.stringify(["row done", "row running"]) && headOf(running).label === "Working", `a running command: the live card's rows, got ${JSON.stringify(shownRows(running))}`);
	const two = await draw(stretch([thoughtItem("t8-think", 1_000, 2_000), toolItem("t8-ls", { name: "ls", status: "done", args: { path: "." }, result: "a" }), toolItem("t8-read", { name: "read", status: "done", args: { path: "a.ts" }, result: "x" })]));
	const twoRows = await openCard(act, two);
	assert(twoRows.length === 3 && twoRows[1].startsWith("row done: Listed the folder") && twoRows[2].startsWith("row done: Read a.ts") && headOf(two).label === "Listed a folder, read a file", `two steps: as before, got ${JSON.stringify(twoRows)} / ${JSON.stringify(headOf(two))}`);
}));

await check("at phone width a folded card's sentence takes a second line; a short one, and a folded turn, keep a card's height", async () => {
	const { chromium } = await import("playwright");
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("  (Chromium not installed: this section is skipped)");
		return;
	}
	const search = card([toolItem("p1", { name: "web_search", status: "done", args: { query: "node lts release" } })], { endTs: Date.now() });
	const three = [toolItem("p2", { name: "bash", status: "done", args: { command: "ls" }, result: "a\nb" }), toolItem("p3", { name: "bash", status: "done", args: { command: "sleep 4" }, result: "" }), toolItem("p4", { name: "read", status: "done", args: { path: "notes.txt" }, result: "x" })];
	const steps = card(three, { endTs: Date.now() });
	const short = card([toolItem("p5", { name: "bash", status: "done", args: { command: "npm test" }, result: "ok" })], { endTs: Date.now() });
	const endless = card([toolItem("p6", { name: "web_search", status: "done", args: { query: "node lts release ".repeat(8).trim() } })], { endTs: Date.now() });
	const turn = decode(renderToStaticMarkup(createElement(workCard.TurnCard, { foldId: "worked:p", steps: three.map((item) => ({ kind: "step", item })), ms: 6_300 })));
	const fontsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web-ui/public/fonts");
	const browser = await chromium.launch();
	try {
		const measure = async (width: number) => {
			const page = await browser.newPage({ viewport: { width, height: 900 } });
			// Served from a made-up origin so the stylesheet's /fonts/ load the page's own font: wrapping is measured in it.
			await page.route("http://cards.test/**", (route) => {
				const url = new URL(route.request().url());
				if (url.pathname.startsWith("/fonts/")) return route.fulfill({ body: fs.readFileSync(path.join(fontsDir, path.basename(url.pathname))) });
				return route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>${readPageStyles()}</style></head><body><div class="messages">${[search, steps, short, endless].map((html, n) => `<div id="c${n}">${html}</div>`).join("")}<div id="c4">${turn}</div></div></body></html>` });
			});
			await page.goto("http://cards.test/");
			await page.evaluate("document.fonts.ready.then(() => Promise.all([...document.fonts].map((font) => font.load())))");
			// A plain string: the compiler's helpers for named functions do not exist in the page.
			const got: Array<{ words: string; whole: boolean; lines: number; cut: boolean; height: number; border: string }> = await page.evaluate(`[0, 1, 2, 3, 4].map((n) => {
				const card = document.querySelector("#c" + n + " .wk-card");
				const label = card.querySelector(".wk-head .wk-lbl");
				const line = parseFloat(getComputedStyle(label).lineHeight);
				return { words: label.textContent, whole: label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1, lines: Math.round(label.getBoundingClientRect().height / line), cut: label.scrollHeight > label.clientHeight + 1, height: card.querySelector(".wk-head").getBoundingClientRect().height, border: getComputedStyle(card).borderTopWidth + " " + getComputedStyle(card).borderTopStyle };
			})`);
			await page.close();
			return got;
		};
		const [phone, desk] = [await measure(390), await measure(1280)];
		assert(phone[0].whole && phone[0].lines <= 2, `at 390 px the folded search shows its whole sentence "${phone[0].words}", got ${JSON.stringify(phone[0])}`);
		assert(phone[2].lines === 1 && Math.abs(phone[2].height - desk[2].height) < 0.05, `a short sentence stays one line, its card as tall as on a desktop, got ${JSON.stringify([phone[2], desk[2]])}`);
		assert(phone[3].lines === 2 && phone[3].cut, `a sentence longer than two lines is cut after the second, got ${JSON.stringify(phone[3])}`);
		assert(desk.every((card) => card.lines === 1), `on a desktop every folded sentence is one line, got ${JSON.stringify(desk)}`);
		// A folded turn is the same card as a folded stretch: its border and its height.
		for (const [at, cards] of [[390, phone], [1280, desk]] as const) {
			assert(cards[4].border === cards[1].border && cards[4].border.endsWith("solid") && Math.abs(cards[4].height - cards[1].height) < 0.05, `at ${at} px a folded turn has a folded stretch's border and height, got ${JSON.stringify([cards[4], cards[1]])}`);
		}
	} finally {
		await browser.close();
	}
});

await check("in a card of a thought and one step, opened, the thought's box and the step's output sit where a card of several steps puts them, and its time lines up with its rows'", async () => {
	const { chromium } = await import("playwright");
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("  (Chromium not installed: this section is skipped)");
		return;
	}
	const thoughts: any = await import(new URL("../../web-ui/src/thinking-text-store.ts", import.meta.url).href);
	const read = (id: string) => toolItem(id, { name: "read", status: "done", args: { path: "notes.txt" }, result: "first line", startedAt: 3_000, endedAt: 3_100 });
	// Each card opened as the person opens it: its head, then its thought's row; in the card of two steps, its read's row by hand too, which the other card opens with itself.
	const opened: string[] = [];
	await onLivePage(async (draw, act) => {
		for (const items of [[thoughtItem("b1-think", 1_000, 2_000), read("b1-read")], [thoughtItem("b2-think", 1_000, 2_000), read("b2-read"), toolItem("b2-ls", { name: "ls", status: "done", args: { path: "." }, result: "a", startedAt: 4_000, endedAt: 4_200 })]]) {
			for (const item of items) if (item.kind === "thinking") thoughts.thinkingTextStore.set(item.id, "Look at the notes first.");
			const container = await draw(stretch(items));
			await act(() => (container.querySelector("button.wk-head") as HTMLButtonElement).click());
			const [thought, step] = [...container.querySelectorAll(".wk-row button.wk-open")] as HTMLButtonElement[];
			await act(() => thought.click());
			if (items.length > 2) await act(() => step.click());
			opened.push(container.innerHTML);
		}
	});
	const fontsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web-ui/public/fonts");
	const browser = await chromium.launch();
	try {
		for (const width of [1280, 390]) {
			const page = await browser.newPage({ viewport: { width, height: 900 } });
			await page.route("http://cards.test/**", (route) => {
				const url = new URL(route.request().url());
				if (url.pathname.startsWith("/fonts/")) return route.fulfill({ body: fs.readFileSync(path.join(fontsDir, path.basename(url.pathname))) });
				return route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>${readPageStyles()}</style></head><body><div class="messages">${opened.map((html, n) => `<div id="c${n}">${html}</div>`).join("")}</div></body></html>` });
			});
			await page.goto("http://cards.test/");
			const left = (selector: string) => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? Math.round((el.getBoundingClientRect().left - el.closest(".wk-card").getBoundingClientRect().left) * 100) / 100 : null; })()`);
			const got = { thought: await left("#c0 .wk-out-thought"), otherThought: await left("#c1 .wk-out-thought"), output: await left("#c0 .wk-out:not(.wk-out-thought)"), otherOutput: await left("#c1 .wk-out:not(.wk-out-thought)") };
			// Opened, its rows carry the marks, so its head gives up the mark's place and its time lines up with theirs.
			const rights = (card: string) => page.evaluate(`[...document.querySelectorAll("${card} .wk-head .wk-time, ${card} .wk-row .wk-meta")].filter((time) => time.textContent.trim()).map((time) => Math.round(time.getBoundingClientRect().right))`) as Promise<number[]>;
			const [oneStep, twoSteps] = [await rights("#c0"), await rights("#c1")];
			await page.close();
			assert(got.thought !== null && got.thought === got.otherThought, `at ${width} px the opened thought's box sits where a two-step card puts its own, got ${JSON.stringify(got)}`);
			assert(got.output !== null && got.output === got.otherOutput, `at ${width} px the step's output sits where an opened row of a two-step card puts it, got ${JSON.stringify(got)}`);
			for (const [what, times] of [["a thought and one step", oneStep], ["two steps", twoSteps]] as const) {
				assert(times.length >= 2 && times.every((right) => Math.abs(right - times[0]) <= 1), `at ${width} px an opened card of ${what} lines its time up with its rows' times, got ${JSON.stringify(times)}`);
			}
		}
	} finally {
		await browser.close();
	}
});

await check("a running command counts on from when it began, after a reload too", async () => {
	// The card reads the step's start time, so its first picture already counts from it.
	const shown = card([toolItem("t1", { name: "bash", status: "running", args: { command: "sleep 40" }, startedAt: Date.now() - 12_400 })], { live: true });
	assert(/<span class="wk-meta">12 s<\/span>/.test(shown), `a command that began 12 s ago says so at once, got ${shown}`);
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
			await page.locator(".persistent-agent-card").filter({ hasText: "Long Command Desk" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await page.locator('button[title="Send"], .stop-btn').first().waitFor({ timeout: 15_000 });
			await page.waitForTimeout(800);
		};
		// Enter sends only while Send is enabled, and Send waits for the room's connection: entering a room can replace
		// its socket at once, and Send shows before the new one is up.
		const sendInRoom = async (on: typeof page, text: string) => {
			const box = on.locator("textarea").first();
			await box.fill(text);
			await until(() => on.getByRole("button", { name: "Send", exact: true }).isEnabled(), "Send is enabled with the message typed");
			await box.press("Enter");
		};
		const seconds = async () => {
			const text = (await page.locator('.wk-row[data-s="running"] .wk-meta').first().textContent().catch(() => null)) ?? "";
			const match = /^(?:(\d+) min )?(\d+) s$/.exec(text.trim());
			return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : -1;
		};
		await enter();
		await sendInRoom(page, "Run the long check.");
		await until(async () => (await seconds()) >= 6, "the command has run 6 s");
		const before = await seconds();
		await enter();
		await page.locator(".wk-row").first().waitFor({ timeout: 15_000 });
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
		await skewed.locator(".persistent-agent-card").filter({ hasText: "Skewed Clock Desk" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
		await skewed.locator('button[title="Send"], .stop-btn').first().waitFor({ timeout: 15_000 });
		await sendInRoom(skewed, "Run the long check.");
		const shownTime = skewed.locator('.wk-row[data-s="running"] .wk-meta').first();
		await shownTime.waitFor({ timeout: 15_000 });
		const firstShown = ((await shownTime.textContent()) ?? "").trim();
		assert(/^\d s$/.test(firstShown), `with the browser's clock ahead, a command that just began counts from 0 s, got ${JSON.stringify(firstShown)}`);
		// After a reload the running command is replayed before any live step: it still counts in seconds, not from 2 min 10 s.
		const replayed = new Promise<void>((resolve) => skewed.on("websocket", (ws) => ws.on("framereceived", (frame) => { if (String(frame.payload).includes('"turn_reattach_replay_done"')) resolve(); })));
		await skewed.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await skewed.waitForLoadState("networkidle");
		if (await skewed.locator(".whats-new-close").count()) await skewed.locator(".whats-new-close").click();
		await skewed.locator(".persistent-agent-card").filter({ hasText: "Skewed Clock Desk" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
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
