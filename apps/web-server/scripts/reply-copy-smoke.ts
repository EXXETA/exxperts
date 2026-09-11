// Smoke for the web-ui reply copy grouping (apps/web-ui/src/reply-copy.ts):
// one copy button per reply, under its last text segment, copying every
// segment, and none until the reply has settled.
//
// Run: npm run smokes -- reply-copy   (or tsx this file)

import { copyableReplyText, replyCopyTargets, type ReplyCopyTarget } from "../../web-ui/src/reply-copy.js";
import type { ChatItem } from "../../web-ui/src/types.js";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		console.log(`  ok  ${name}`);
	} else {
		failures += 1;
		console.error(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}

const user = (id: string, text = "question"): ChatItem => ({ kind: "user", id, text });
const assistant = (id: string, text: string, streaming?: boolean, ts?: number): ChatItem => ({ kind: "assistant", id, text, ...(streaming ? { streaming } : {}), ...(ts === undefined ? {} : { ts }) });
const tool = (id: string, status: "running" | "done" | "error" | "stopped" = "done"): ChatItem => ({ kind: "tool", id, name: "read_file", args: {}, status });
const system = (id: string): ChatItem => ({ kind: "system", id, text: "note" });

// Text-only view of the targets: every case below that is about placement
// and copy text uses items without `ts`, so no target carries one.
function expectTargets(name: string, items: ChatItem[], want: Record<string, string>, busy = false): void {
	const got = Object.fromEntries([...replyCopyTargets(items, busy)].map(([id, target]) => [id, target.text]));
	const noStrayTs = [...replyCopyTargets(items, busy).values()].every((target) => target.ts === undefined);
	check(name, JSON.stringify(got) === JSON.stringify(want) && noStrayTs, { got, want });
}
function expectFullTargets(name: string, items: ChatItem[], want: Record<string, ReplyCopyTarget>, busy = false): void {
	const got = Object.fromEntries(replyCopyTargets(items, busy));
	check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

console.log("reply copy targets:");

check("a picture is left out of the copied text and its blank lines collapse", copyableReplyText("Here is a picture.\n\n![wide banner](/api/persistent-agents/r/files/wide.svg)\n\nDone.") === "Here is a picture.\n\nDone.");
check("a picture inline in a sentence is dropped and the words around it stay", copyableReplyText("See ![alt](x.png) here.") === "See  here.");
check("text without pictures is untouched apart from trimming", copyableReplyText("  plain **markdown**\n") === "plain **markdown**");
check("a fenced block keeps its blank lines and its image example", copyableReplyText("Intro.\n\n```python\ndef a():\n    pass\n\n\ndef b():\n    pass\n```\n\n![p](/x.png)\n\nDone.") === "Intro.\n\n```python\ndef a():\n    pass\n\n\ndef b():\n    pass\n```\n\nDone.");
check("an inline code span showing the image syntax is kept", copyableReplyText("Write `![alt](image.png)` to embed a picture.") === "Write `![alt](image.png)` to embed a picture.");
expectTargets("a reply that is only a picture carries no button", [user("u1"), assistant("a1", "![p](/api/persistent-agents/r/files/p.png)")], {});

expectTargets("single-segment reply carries its own text", [user("u1"), assistant("a1", "Hello there.")], { a1: "Hello there." });

expectTargets(
	"multi-segment reply with tools between: one target on the last segment, every segment joined by a blank line",
	[user("u1"), assistant("a1", "Let me look."), tool("t1"), tool("t2"), assistant("a2", "Found it."), tool("t3"), assistant("a3", "Done.")],
	{ a3: "Let me look.\n\nFound it.\n\nDone." },
);

expectTargets(
	"two replies separated by a user item get one target each",
	[user("u1"), assistant("a1", "First."), tool("t1"), assistant("a2", "First, cont."), user("u2"), assistant("a3", "Second.")],
	{ a2: "First.\n\nFirst, cont.", a3: "Second." },
);

expectTargets(
	"a leading reply before any user item is a reply of its own",
	[assistant("a0", "Welcome back."), user("u1"), assistant("a1", "Sure.")],
	{ a0: "Welcome back.", a1: "Sure." },
);

expectTargets(
	"a streaming segment holds the whole reply's button back",
	[user("u1"), assistant("a1", "Working"), tool("t1"), assistant("a2", "still wri", true)],
	{},
);

expectTargets(
	"a running tool holds the whole reply's button back",
	[user("u1"), assistant("a1", "Looking."), tool("t1", "running")],
	{},
);

expectTargets(
	"a stopped tool (cut off by an abort or a failed turn) does not hold the button",
	[user("u1"), assistant("a1", "Looking."), tool("t1", "stopped"), assistant("a2", "Cut short.")],
	{ a2: "Looking.\n\nCut short." },
);

expectTargets(
	"a failed tool does not hold the button",
	[user("u1"), assistant("a1", "Trying."), tool("t1", "error"), assistant("a2", "That failed.")],
	{ a2: "Trying.\n\nThat failed." },
);

expectTargets(
	"a reply that ends on a tool call with no trailing text keeps the button under its last paragraph",
	[user("u1"), assistant("a1", "Saving that."), tool("t1"), tool("t2")],
	{ a1: "Saving that." },
);

expectTargets(
	"a greeting as the only reply waits while the turn is in flight",
	[assistant("a0", "Welcome back.")],
	{},
	true,
);

expectTargets(
	"busy with the last reply still streaming: the settled earlier reply keeps its button",
	[user("u1"), assistant("a1", "Earlier."), tool("t1"), assistant("a2", "Earlier, cont."), user("u2"), assistant("a3", "Writing", true)],
	{ a2: "Earlier.\n\nEarlier, cont." },
	true,
);

expectTargets(
	"empty segments are skipped and never carry the button",
	[user("u1"), assistant("a1", "Text."), tool("t1"), assistant("a2", ""), assistant("a3", "   ")],
	{ a1: "Text." },
);

expectTargets(
	"tool, approval, system and task items contribute no text",
	[
		user("u1"),
		assistant("a1", "Before."),
		tool("t1"),
		{ kind: "approval", id: "ap1", requestId: "r1", uiKind: "confirm", title: "ok?", done: "yes" },
		system("s1"),
		{ kind: "task", id: "task1", taskId: "task_1", template: "summary", templateLabel: "Summary", title: "Write the summary", summary: "Wrote it.", artifacts: [], generatedAt: "2026-09-10T12:00:00.000Z", transferred: true },
		assistant("a2", "After."),
	],
	{ a2: "Before.\n\nAfter." },
);

expectTargets(
	"a settled last reply with the turn still in flight waits; earlier replies keep theirs",
	[user("u1"), assistant("a1", "Earlier."), user("u2"), assistant("a2", "Landed, turn not yet ended.")],
	{ a1: "Earlier." },
	true,
);

expectTargets(
	"a transcript that ends on the user's prompt has nothing to copy for it while busy",
	[user("u1"), assistant("a1", "Earlier."), user("u2")],
	{ a1: "Earlier." },
	true,
);

expectTargets("an empty transcript has no targets", [], {});

console.log("reply start time:");

expectFullTargets(
	"the reply's time is the earliest ts among its segments, not the target segment's own",
	[user("u1"), assistant("a1", "First.", false, 1_000), tool("t1"), assistant("a2", "Second.", false, 2_000), assistant("a3", "Third.", false, 3_000)],
	{ a3: { text: "First.\n\nSecond.\n\nThird.", ts: 1_000 } },
);

expectFullTargets(
	"segments out of clock order still yield the smallest ts",
	[user("u1"), assistant("a1", "First.", false, 5_000), assistant("a2", "Second.", false, 4_000)],
	{ a2: { text: "First.\n\nSecond.", ts: 4_000 } },
);

expectFullTargets(
	"an empty segment still contributes its ts to the reply start",
	[user("u1"), assistant("a1", "", false, 500), tool("t1"), assistant("a2", "Text.", false, 2_000)],
	{ a2: { text: "Text.", ts: 500 } },
);

expectFullTargets(
	"segments without ts leave the reply without a time",
	[user("u1"), assistant("a1", "Old."), assistant("a2", "Older still.")],
	{ a2: { text: "Old.\n\nOlder still." } },
);

expectFullTargets(
	"a mix of stamped and unstamped segments takes the earliest stamp; each reply keeps its own",
	[user("u1"), assistant("a1", "One."), assistant("a2", "Two.", false, 7_000), user("u2"), assistant("a3", "Three.", false, 9_000)],
	{ a2: { text: "One.\n\nTwo.", ts: 7_000 }, a3: { text: "Three.", ts: 9_000 } },
);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nreply copy smoke passed");
