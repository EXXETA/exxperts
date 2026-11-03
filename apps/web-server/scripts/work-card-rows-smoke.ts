// Smoke for the rows of the room's work card, as the page words them
// (apps/web-ui/src/work-look.ts): a common read-only command reads as what it
// does, one other program as "Ran <program>", and a line that chains or wraps
// several things as "Ran" and the line itself, in code; a folded card says what its steps
// did, from the steps alone; each finished row has its own time and result;
// a finished turn of several stretches folds into the same card, its head
// the head a card of all its steps has, with the turn's time.
//
// Run: npm run smokes -- work-card-rows   (or tsx this file)

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		console.log(`  ok  ${name}`);
	} else {
		failures += 1;
		console.error(`FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
	}
}

const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
(globalThis as any).React = pageRequire("react");
// Page modules: loaded at run time, as the server build compiles scripts without JSX.
const look: any = await import(new URL("../../web-ui/src/work-look.ts", import.meta.url).href);
const workCard: any = await import(new URL("../../web-ui/src/components/work-card.tsx", import.meta.url).href);
const { createElement } = pageRequire("react");
const { renderToStaticMarkup } = pageRequire("react-dom/server");

// --- A command in plain words: past, present and as a question asks it. A name in code reads between backticks.
const said = (command: string) => {
	const { verbs, name, where, code } = look.commandSentence(look.commandAction(command));
	return [verbs[2], code ? `\`${name}\`` : name, where ? `in ${where}` : ""].filter(Boolean).join(" ");
};
const sentences: Array<[string, string]> = [
	["ls", "Listed the folder"],
	["ls -la src/", "Listed src"],
	["cd config && ls", "Listed config"],
	["cd src && ls", "Listed src"],
	["dir", "Listed the folder"],
	["Get-ChildItem -Path C:\\work\\src", "Listed src"],
	["cat config/limits.json", "Read limits.json"],
	["head -n 20 server.ts", "Read server.ts"],
	["Get-Content -Tail 5 app.log", "Read app.log"],
	["cat a.ts b.ts", "Read 2 files"],
	["grep -rn limit src", "Searched the code for “limit” in src"],
	["grep -n 'rate limit' .", "Searched the code for “rate limit”"],
	["rg -A 3 rateLimit", "Searched the code for “rateLimit”"],
	["Select-String -Pattern limit -Path *.ts", "Searched the code for “limit” in *.ts"],
	["findstr /s /i limit *.ts", "Searched the code for “limit” in *.ts"],
	["git grep -n limit", "Searched the code for “limit”"],
	["git status", "Checked what changed"],
	["git -C repo status --short", "Checked what changed"],
	["git diff -- src/limits.ts", "Looked at the changes in limits.ts"],
	["git log --oneline -5", "Read the history"],
];
for (const [command, expected] of sentences) check(`"${command}" reads "${expected}"`, said(command) === expected, said(command));
// Any other one program says which program ran; a line that chains or wraps several things is named by itself.
const others: Array<[string, string]> = [
	["npm test", "Ran npm test"],
	["rm report-old.txt", "Ran rm"],
	["FOO=1 node build.js", "Ran node"],
	["cd src && npm test", "Ran `cd src && npm test`"],
	["sleep 3 && ls", "Ran `sleep 3 && ls`"],
	["grep -rn limit src | head", "Ran `grep -rn limit src | head`"],
	["cat notes.txt > copy.txt", "Ran `cat notes.txt > copy.txt`"],
	["for f in *.md; do wc -l \"$f\"; done", "Ran `for f in *.md; do wc -l \"$f\"; done`"],
	// A second program inside double quotes runs; in single quotes, or escaped, it is only words, as is a variable.
	["echo \"$(date)\"", "Ran `echo \"$(date)\"`"],
	["echo \"`date`\"", "Ran `echo \"`date`\"`"],
	["echo '$(date)'", "Ran echo"],
	["echo \"\\$(date)\"", "Ran echo"],
	["echo \"$HOME\"", "Ran echo"],
	// Escaped, an operator's character is only a word's, beside the same character unescaped.
	["echo \\$(date)", "Ran echo"],
	["echo $(date)", "Ran `echo $(date)`"],
	["echo a\\|b", "Ran echo"],
	["echo a|b", "Ran `echo a|b`"],
	["type C:\\work\\notes.txt", "Read notes.txt"],
	// A script of several lines: its first line, then "…".
	["python3 - <<'PY'\nimport json\nprint(1)\nPY", "Ran `python3 - <<'PY' …`"],
	["ls\npwd", "Ran `ls …`"],
];
for (const [command, expected] of others) check(`${JSON.stringify(command)} reads "${expected}"`, said(command) === expected, said(command));
{
	const longLine = `${"npm run build && ".repeat(25)}npm test`;
	const { name, code } = look.commandSentence(look.commandAction(longLine));
	check("a one-line chain over 300 characters is cut at 300", longLine.length > 300 && code === true && name === longLine.slice(0, 300), name);
	const longScript = `${"x".repeat(400)}\nsecond line`;
	const script = look.commandSentence(look.commandAction(longScript));
	check("a script's first line over 300 characters is cut at 300, then \"…\"", script.code === true && script.name === `${"x".repeat(300)} …`, script.name);
	check("a chained command counts as a command on the folded line", look.itemKind({ kind: "tool", id: "c", name: "bash", args: { command: "cd src && npm test" }, status: "done" }) === "command");
}
check("a listing by command counts as listing a folder on the folded line", look.foldedWords([{ item: { kind: "tool", id: "a", name: "bash", args: { command: "ls src" }, status: "done" } }, { item: { kind: "tool", id: "b", name: "bash", args: { command: "npm test" }, status: "done" } }]) === "Listed a folder, ran a command");

// --- A folded card's sentence: at most three kinds, then what did not work.
{
	const tool = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ item: { kind: "tool", id: `${name}-${Math.random()}`, name, args, status: "done", ...extra } });
	const steps = [tool("read", { path: "a.ts" }), tool("read", { path: "b.ts" }), tool("grep", { pattern: "limit" }), tool("web_search", { query: "node" }), tool("ls", { path: "src" })];
	check("a folded card names three kinds and then how many more", look.foldedWords(steps) === "Read 2 files, searched once, searched the web and 1 more", look.foldedWords(steps));
	const failed = [tool("read", { path: "a.ts" }), tool("bash", { command: "npm test" }, { status: "error", result: "exit 1" }), tool("bash", { command: "rm x" }, { status: "stopped" })];
	check("what failed or did not run follows what was done", look.foldedWords(failed) === "Read a file · 1 failed, 1 not run", look.foldedWords(failed));
	const searchOnce = [tool("web_search", { query: "node lts release" })];
	check("a card whose one step searched the web says what for, as its row does", look.foldedWords(searchOnce) === "Searched the web for node lts release", look.foldedWords(searchOnce));
	const searchTwice = [tool("web_search", { query: "node lts" }), tool("web_search", { query: "node 24" })];
	check("two searches still count", look.foldedWords(searchTwice) === "Searched the web 2 times", look.foldedWords(searchTwice));
	const searchFailed = [tool("web_search", { query: "node lts" }, { status: "error", result: "search failed" })];
	check("a search that failed says so, not what it looked for", look.foldedWords(searchFailed) === "1 failed", look.foldedWords(searchFailed));
	check("a card whose only step did not run says so", look.foldedWords([tool("bash", { command: "rm x" }, { status: "stopped" })]) === "1 step not run", look.foldedWords([tool("bash", { command: "rm x" }, { status: "stopped" })]));
	const asked = { kind: "approval", id: "q1", requestId: "r1", uiKind: "confirm", title: "Run this command?", done: "No" };
	check("a step its question was declined for did not run", look.stepState({ kind: "tool", id: "s1", name: "bash", args: { command: "rm x" }, status: "running" }, asked) === "denied");
	check("a step still being written is writing", look.stepState({ kind: "tool", id: "s1", name: "bash", args: { command: "rm" }, status: "writing" }, undefined) === "writing");
}

// --- A finished row's own time and result.
{
	const row = (extra: Record<string, unknown>) => ({ kind: "tool", id: "s1", name: "bash", args: { command: "ls" }, status: "done", result: "a\nb\nc", startedAt: 10_000, ...extra });
	check("a row's own time", look.stepTime(row({ endedAt: 11_200 })) === "1.2 s", look.stepTime(row({ endedAt: 11_200 })));
	check("a step of a few milliseconds reads as under a tenth of a second", look.stepTime(row({ endedAt: 10_004 })) === "<0.1 s", look.stepTime(row({ endedAt: 10_004 })));
	check("a row whose end time is not known shows no time", look.stepTime(row({})) === "", look.stepTime(row({})));
	check("a command's result in a few words", look.stepResultWords(row({})) === "3 lines", look.stepResultWords(row({})));
	check("a search with nothing found", look.stepResultWords({ ...row({}), name: "grep", args: { pattern: "x" }, result: "No matches found" }) === "no matches");
	check("a provider's search, with no pages kept, says nothing more", look.stepResultWords({ ...row({}), name: "web_search", args: { query: "node" }, result: undefined }) === "");
}

// --- A question in the row of the step that asks it.
{
	const FENCE = "─── Command (written by the room's model; the app has not verified it) ───";
	const command = (id: string, text: string, status = "running") => ({ kind: "tool", id, name: "bash", args: { command: text }, status });
	const asks = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ kind: "approval", id: `q-${id}`, requestId: `r-${id}`, uiKind: "confirm", title: "Run this command?", message: `Runs in: /work\n\n${FENCE}\n${text}`, ...extra });
	const owners = (items: unknown[]) => look.workPieces(items).map((piece: any) => (piece.kind === "step" ? `${piece.item.id}:${piece.ask?.requestId ?? "-"}` : `${piece.kind}:${piece.item.requestId ?? piece.item.id}`));
	const same = (got: string[], want: string[]) => JSON.stringify(got) === JSON.stringify(want);

	// Two commands in one message are both placed before the first asks; the first asks first.
	const two = owners([command("a", "ls src"), command("b", "rm -rf build"), asks("a", "ls src"), asks("b", "rm -rf build")]);
	check("two commands in one message: each question sits in its own command's row", same(two, ["a:r-a", "b:r-b"]), two);
	const first = owners([command("a", "ls src"), command("b", "rm -rf build"), asks("a", "ls src")]);
	check("two commands, the first asking: its question is in the first row, the second has none yet", same(first, ["a:r-a", "b:-"]), first);
	const one = owners([command("a", "npm test"), asks("a", "npm test")]);
	check("one command and its question: in its row", same(one, ["a:r-a"]), one);
	const saved = owners([command("a", "npm test", "done"), asks("a", "npm test", { done: "Approve" })]);
	check("after a reload, a run command keeps its answered question in its row", same(saved, ["a:r-a"]), saved);
	const long = "echo " + "x".repeat(1500);
	const clipped = owners([command("a", long), asks("a", `${long.slice(0, 1200)}\n[command preview clipped]`)]);
	check("a long command whose question shows it clipped: in its row", same(clipped, ["a:r-a"]), clipped);
	const stray = owners([command("a", "ls src"), asks("x", "cat secrets.txt")]);
	check("a command question no step on the card asks: its own row, never another command's", same(stray, ["a:-", "ask:r-x"]), stray);
	// A hand-off's own step is not drawn: its question must not join an earlier finished step.
	const handOff = { kind: "approval", id: "q-h", requestId: "r-h", uiKind: "confirm", title: "Hand off to a researcher?", message: "Details" };
	const after = owners([{ kind: "tool", id: "r", name: "read", args: { path: "a.ts" }, status: "done" }, handOff]);
	check("a question after a finished step whose own step is not drawn: its own row", same(after, ["r:-", "ask:r-h"]), after);
	const answered = owners([{ kind: "tool", id: "r", name: "read", args: { path: "a.ts" }, status: "done" }, { ...handOff, done: "Approve" }]);
	check("answered, it keeps its own row, so the answer stays on the card", same(answered, ["r:-", "ask:r-h"]), answered);
}

// --- A finished turn of several stretches folds into the card one stretch folds into.
{
	const tool = (id: string, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ kind: "tool", id, name, args, status: "done", result: "x", startedAt: 10_000, endedAt: 10_500, ...extra });
	const turn = (items: Record<string, any>[], open = false) => renderToStaticMarkup(createElement(workCard.TurnCard, { foldId: `worked:${Math.random()}`, steps: items.map((item) => ({ kind: "step", item })), ms: 2_100 }, open ? "the cards" : null));
	// Drawn once, as a string: React's note that a layout effect does not run there is not the card's.
	const stretch = (items: Record<string, any>[]) => {
		const error = console.error;
		console.error = (...args: unknown[]) => { if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) error(...args); };
		try {
			return renderToStaticMarkup(createElement(workCard.WorkStretch, { items, live: false, endTs: 12_100, elsewhere: false, keyboardApprovalId: null, onResolve: () => undefined }));
		} finally {
			console.error = error;
		}
	};
	const head = (html: string) => /<button[^>]*class="wk-head"[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
	const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	const steps = [tool("a", "ls", { path: "src" }), tool("b", "read", { path: "notes.md" })];
	const folded = turn(steps);
	check("a folded turn is a bordered card, not a line", folded.includes('class="wk-card wk-turn"') && !folded.includes("wk-worked"), folded);
	check("a folded turn's head reads as a folded stretch of the same steps does: their icons, the sentence, the time, the check and the arrow", head(folded) !== "" && head(folded) === head(stretch(steps)), { turn: head(folded), stretch: head(stretch(steps)) });
	check("a folded turn says what was done and how long the turn took", words(head(folded)) === "Listed a folder, read a file 2.1 s" && (head(folded).match(/wk-stack/g) ?? []).length === 2 && head(folded).includes("wk-ok"), words(head(folded)));
	check("no Worked for on a folded turn", !/Worked/.test(words(folded)), words(folded));
	const failed = [tool("a", "ls", { path: "src" }), tool("b", "bash", { command: "npm test" }, { status: "error", result: "exit 1" })];
	check("a folded turn with a failed step reads as a folded stretch with one: the failed mark, not the check, the failure in its words", head(turn(failed)) === head(stretch(failed)) && head(turn(failed)).includes("wk-bad") && !head(turn(failed)).includes("wk-ok") && words(head(turn(failed))).includes("1 failed"), head(turn(failed)));
	const declined = [tool("a", "ls", { path: "src" }), tool("b", "bash", { command: "rm x" }, { status: "error", result: "The user declined this command. Do not run it or retry variants of it unless the user asks." })];
	check("a step the person declined is no failure: no failed mark", !head(turn(declined)).includes("wk-bad") && head(turn(declined)) === head(stretch(declined)), head(turn(declined)));
	// Opening it is the person's click: thinking-open-smoke opens one in the room.
	check("folded, the turn's cards are not drawn", !turn(steps, true).includes("the cards"));
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nwork-card-rows smoke passed");
