import { applyCuts, cutAnswerPart, isShared, keyOfId, landTurnItems, legacyInsertIndex, mergeSaveById, pickAnswerPart, readRemovedIds, readShownPrompt, readTurnKey, REMOVED_IDS_CAP, type ThreadItem, type TurnPlace } from "../src/thread-items-by-id.js";
import { createTurnStepLog, withFrameIds } from "../src/persistent-room-turn-steps.js";
import { createTurnFrameCoalescer } from "../src/turn-frame-coalescer.js";
import { createWebClientEventProjector } from "../src/web-client-event-projection.js";

// The rules for items the page and the server name alike, without a server:
// the checks on what a page sends, the landing by id, the merge of a save by
// id, the pick rule for a stopped part, the old merge's limit in a mixed
// thread, the accepted cuts, and the keyed step log (parts, ids, echo,
// order).

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const ids = (items: readonly unknown[]): string => items.map((item: any) => item.id).join(",");
const byId = (items: readonly unknown[], id: string): any => items.find((item: any) => item.id === id);
const failed: string[] = [];
function row(name: string, run: () => void): void {
	try {
		run();
		console.log(`ok ${name}`);
	} catch (error) {
		failed.push(`${name}: ${(error as Error).message}`);
		console.log(`FAIL ${name}: ${(error as Error).message}`);
	}
}

const q = (id: string, text: string): ThreadItem => ({ kind: "user", id, text, ts: 1 });
const a = (id: string, text: string, extra: ThreadItem = {}): ThreadItem => ({ kind: "assistant", id, text, streaming: false, ts: 2, ...extra });
const step = (id: string, status: string, result?: string, extra: ThreadItem = {}): ThreadItem => ({ kind: "tool", id, name: "bash", args: { command: "ls" }, status, ...(result !== undefined ? { result } : {}), ...extra });
const took = (id: string, text: string): ThreadItem => ({ kind: "user", id, text, ts: 3, steered: true });
const none = new Set<string>();
const always = () => true;
const place = (key: string, recentKeys: string[], startAnchorId: string | null | undefined = undefined, continued = false): TurnPlace => ({ key, continued, startAnchorId, recentKeys });

// --- What a page sends, checked where it enters.
row("limits: a turn key is letters, digits and _ up to 80, no hyphen", () => {
	assert(readTurnKey("m1abc_2") === "m1abc_2", "a plain key is taken");
	for (const bad of ["m1-a", "", "x".repeat(81), 12, null, "m1 a", "m1.a"]) assert(readTurnKey(bad) === undefined, `refused: ${JSON.stringify(bad)}`);
	assert(readTurnKey("x".repeat(80)) !== undefined, "80 characters are taken");
});
row("limits: server-named ids read back to their key; page ids are not shared", () => {
	assert(keyOfId("k1-a2") === "k1" && keyOfId("k1-t3") === "k1" && keyOfId("k1-p1") === "k1" && keyOfId("k1-partial") === "k1" && keyOfId("k1-failure") === "k1" && keyOfId("k1-declined-2") === "k1", "every server form has its key");
	assert(keyOfId("k1") === undefined && keyOfId("k1-x") === undefined && keyOfId("k1-a") === undefined, "other forms have none");
	assert(isShared({ id: "k1-a1" }) && isShared({ id: "x", landed: true }), "a server form or the mark is shared");
	assert(!isShared({ id: "detached-assistant-turn_1" }) && !isShared({ id: "m1abc" }) && !isShared(null), "old landings and page ids are not");
});
row("limits: removed ids are checked one by one and capped", () => {
	const raw = ["k1", "k1-a1", 7, "", "with space", "x".repeat(201), "k1", ...Array.from({ length: 300 }, (_, n) => `r${n}`)];
	const read = readRemovedIds(raw);
	assert(read[0] === "k1" && read[1] === "k1-a1" && read[2] === "r0", `bad entries dropped alone and repeats once, got ${read.slice(0, 3)}`);
	assert(read.length === REMOVED_IDS_CAP, `capped at ${REMOVED_IDS_CAP}, got ${read.length}`);
	assert(readRemovedIds("k1").length === 0 && readRemovedIds(undefined).length === 0, "no list is none");
});
row("shown keeps every well-formed file chip and drops a bad one alone", () => {
	const files = Array.from({ length: 21 }, (_, n) => ({ name: `f${n}.txt`, bytes: n, extension: "txt" }));
	const shown = readShownPrompt({ text: "", files });
	assert(shown && shown.text === "" && shown.files.length === 21, `21 chips kept, got ${shown?.files.length}`);
	const bad = readShownPrompt({ text: "Look", files: [...files.slice(0, 20), { name: "", bytes: -1, extension: 3 }] });
	assert(bad && bad.files.length === 20 && bad.text === "Look", `the bad chip goes alone, got ${bad?.files.length}`);
	assert(readShownPrompt("text") === undefined && readShownPrompt([]) === undefined, "a shown that is no object is none");
});

// --- The landing by id.
row("a landing stamps the question the page saved and adds the turn after it", () => {
	const file = [q("k0", "Earlier"), a("k0-a1", "Earlier answer", { landed: true }), q("k1", "Run it")];
	const landed = landTurnItems(file, [q("k1", "Run it"), step("k1-t1", "done", "ok")], place("k1", ["k0", "k1"]), none);
	assert(ids(landed) === "k0,k0-a1,k1,k1-t1", `in order, got ${ids(landed)}`);
	assert(byId(landed, "k1").landed === true && byId(landed, "k1-t1").landed === true, "both carry the mark");
	// An older save from before the question: the question and its step come back.
	const merged = mergeSaveById(landed, [q("k0", "Earlier"), a("k0-a1", "Earlier answer")], none, always);
	assert(ids(merged) === "k0,k0-a1,k1,k1-t1", `the older save keeps them, got ${ids(merged)}`);
	// A save naming the question removed keeps it out.
	const handedBack = mergeSaveById(landed, [q("k0", "Earlier"), a("k0-a1", "Earlier answer")], new Set(["k1"]), always);
	assert(ids(handedBack) === "k0,k0-a1,k1-t1", `a removed question stays out, got ${ids(handedBack)}`);
});
row("a files-only question the page never saved lands with its chips, where its turn goes", () => {
	const file = [q("k0", "Earlier"), a("k0-a1", "Fine", { landed: true })];
	const own = [{ kind: "user", id: "k1", text: "", attachments: [{ name: "a.pdf", bytes: 1, extension: "pdf" }, { name: "b.pdf", bytes: 2, extension: "pdf" }] }, a("k1-a1", "Both read.")];
	const landed = landTurnItems(file, own, place("k1", ["k0", "k1"], "k0-a1"), none);
	assert(ids(landed) === "k0,k0-a1,k1,k1-a1" && byId(landed, "k1").attachments.length === 2, `the question with both chips, then the answer, got ${ids(landed)}`);
});
row("a late save of the three questions keeps each turn's items in its own turn", () => {
	let file: ThreadItem[] = [];
	file = landTurnItems(file, [q("k1", "One"), took("s1", "And this"), a("k1-a1", "First answer")], place("k1", ["k1"], null), none);
	file = landTurnItems(file, [q("k2", "Two"), a("k2-a1", "Second answer")], place("k2", ["k1", "k2"], "k1-a1"), none);
	file = landTurnItems(file, [q("k3", "Three"), a("k3-a1", "Third answer")], place("k3", ["k1", "k2", "k3"], "k2-a1"), none);
	const merged = mergeSaveById(file, [q("k1", "One"), q("k2", "Two"), q("k3", "Three")], none, always);
	assert(ids(merged) === "k1,s1,k1-a1,k2,k2-a1,k3,k3-a1", `each item stays in its turn, got ${ids(merged)}`);
});
row("a part whose words repeat in a later part stays, and the mark survives each merge", () => {
	let file = landTurnItems([q("k1", "Check")], [q("k1", "Check"), a("k1-a1", "Checking."), step("k1-t1", "done", "ok"), a("k1-a2", "Checking. The result is ready.")], place("k1", ["k1"], null), none);
	file = mergeSaveById(file, [q("k1", "Check"), a("k1-a1", "Checking."), step("k1-t1", "done", "ok"), a("k1-a2", "Checking. The result is ready.")], none, always);
	assert(file.filter((item) => item.landed === true).length === 4, "the marks come from the file, not the save");
	const older = mergeSaveById(file, [q("k1", "Check")], none, always);
	assert(ids(older) === "k1,k1-a1,k1-t1,k1-a2", `both parts and the step stay, in order, got ${ids(older)}`);
});
row("a save with the answer but not the step and the taken message brings both back, before the answer", () => {
	const file = landTurnItems([q("k1", "Check")], [q("k1", "Check"), step("k1-t1", "done", "ok"), took("s1", "Faster"), a("k1-a1", "Done.")], place("k1", ["k1"], null), none);
	for (const answer of [a("k1-a1", "Done."), a("k1-a1", "Done.", { landed: true })]) {
		const merged = mergeSaveById(file, [q("k1", "Check"), answer], none, always);
		assert(ids(merged) === "k1,k1-t1,s1,k1-a1", `step and taken message come back before the answer, got ${ids(merged)}`);
	}
});
row("bringing back a missing item moves nothing the save holds", () => {
	const turn = [q("k1", "Go"), a("k1-a1", "Part one."), step("k1-t1", "done", "1"), took("s1", "Also this"), a("k1-a2", "Part two."), step("k1-t2", "done", "2"), a("k1-a3", "Part three.")];
	const file = landTurnItems([q("k1", "Go")], turn, place("k1", ["k1"], null), none);
	const merged = mergeSaveById(file, turn.filter((item) => item.id !== "s1"), none, always);
	assert(ids(merged) === "k1,k1-a1,k1-t1,s1,k1-a2,k1-t2,k1-a3", `the taken message goes back in its place, got ${ids(merged)}`);
	const older = mergeSaveById(merged, [q("k1", "Go")], none, always);
	assert(ids(older) === "k1,k1-a1,k1-t1,s1,k1-a2,k1-t2,k1-a3", `every item comes back from a save of only the question, got ${ids(older)}`);
});
row("a Try again lands after its start anchor, writes no question, and both turns survive an older save", () => {
	let file = landTurnItems([q("k1", "Fix it")], [q("k1", "Fix it"), step("k1-t1", "error", "boom")], place("k1", ["k1"], null), none);
	// The page's own failure line, then the Try again with its own key.
	file = [...file, { kind: "system", id: "m9", text: "The answer failed.", level: "error" }];
	file = landTurnItems(file, [step("c2-t1", "done", "ok"), a("c2-a1", "Fixed.")], place("c2", ["k1", "c2"], "m9", true), none);
	assert(ids(file) === "k1,k1-t1,m9,c2-t1,c2-a1", `right after the failure line, got ${ids(file)}`);
	const older = mergeSaveById(file, [q("k1", "Fix it")], none, always);
	assert(ids(older) === "k1,k1-t1,c2-t1,c2-a1", `both steps and the answer stay in order (the page's own line was the page's), got ${ids(older)}`);
	const anchorGone = landTurnItems([q("k1", "Fix it"), step("k1-t1", "error", "boom", { landed: true })], [step("c3-t1", "done", "ok")], place("c3", ["k1", "c3"], "gone", true), none);
	assert(ids(anchorGone) === "k1,k1-t1,c3-t1", `without its anchor, after the earlier turn, got ${ids(anchorGone)}`);
});
row("two runs of one command keep their own results, paired by id", () => {
	const file = landTurnItems([q("k1", "Twice")], [q("k1", "Twice"), step("k1-t1", "done", "first"), step("k1-t2", "done", "second"), a("k1-a1", "Ran twice.")], place("k1", ["k1"], null), none);
	const merged = mergeSaveById(file, [q("k1", "Twice"), step("k1-t2", "running"), a("k1-a1", "Ran twice.")], none, always);
	assert(ids(merged) === "k1,k1-t1,k1-t2,k1-a1", `the first run comes back once, got ${ids(merged)}`);
	assert(byId(merged, "k1-t1").result === "first" && byId(merged, "k1-t2").result === "second" && byId(merged, "k1-t2").status === "done", "each keeps its own result, finished");
});
row("a part the page froze short keeps its words; the unseen rest never comes back, the lead-in stays whole", () => {
	const file = landTurnItems([q("k1", "Go")], [q("k1", "Go"), a("k1-a1", "Lead-in."), step("k1-t1", "done", "ok"), a("k1-a2", "The result is ready. More detail.")], place("k1", ["k1"], null), none);
	const frozen = mergeSaveById(file, [q("k1", "Go"), a("k1-a1", "Lead-in."), step("k1-t1", "done", "ok"), a("k1-a2", "The result is ready.", { stoppedAt: 20 })], none, always);
	const older = mergeSaveById(frozen, [q("k1", "Go")], none, always);
	assert(byId(older, "k1-a1").text === "Lead-in.", "the lead-in stays whole");
	assert(byId(older, "k1-a2").text === "The result is ready." && byId(older, "k1-a2").stoppedAt === 20, `the frozen words stay, got ${JSON.stringify(byId(older, "k1-a2"))}`);
});
row("a part the server cut keeps the cut against a save holding the whole text", () => {
	const file = landTurnItems([q("k1", "Go")], [q("k1", "Go"), a("k1-a1", "Shown words. Unseen words.")], place("k1", ["k1"], null), none);
	const cut = applyCuts(file, new Map([["k1-a1", 12]]));
	assert(cut.applied.join() === "k1-a1" && byId(cut.items, "k1-a1").text === "Shown words." && byId(cut.items, "k1-a1").stoppedAt === 12, `the cut applies, got ${JSON.stringify(byId(cut.items, "k1-a1"))}`);
	const merged = mergeSaveById(cut.items, [q("k1", "Go"), a("k1-a1", "Shown words. Unseen words.")], none, always);
	assert(byId(merged, "k1-a1").text === "Shown words." && byId(merged, "k1-a1").stoppedAt === 12, `the whole text does not come back, got ${JSON.stringify(byId(merged, "k1-a1"))}`);
	const notThere = applyCuts([q("k1", "Go")], new Map([["k1-a1", 12]]));
	assert(notThere.applied.length === 0, "a cut whose part the list lacks stays pending");
	const toNothing = applyCuts(file, new Map([["k1-a1", 0]]));
	assert(toNothing.gone.join() === "k1-a1" && !byId(toNothing.items, "k1-a1"), "a part cut to nothing goes");
});
row("of two stopped copies the shorter words win and the Stop note stays", () => {
	const words = "w".repeat(200);
	const server = { ...a("k1-a1", words.slice(0, 100)), stoppedAt: 100 };
	const page = a("k1-a1", `${words}\n\n[Stopped]`, { stoppedAt: 200 });
	const picked = pickAnswerPart(server, page, true);
	assert(picked.stoppedAt === 100 && picked.text === `${words.slice(0, 100)}\n\n[Stopped]`, `100 characters, then the note, got ${picked.stoppedAt}`);
});
row("a Stop note the page saved stays beside the server's cut, though its stop count no longer counts", () => {
	const server = a("k1-a1", "Shown words.", { stoppedAt: 12, landed: true });
	const page = a("k1-a1", "Shown words.\n\n_Stopped._", { stoppedAt: 12 });
	const picked = pickAnswerPart(server, page, false);
	assert(picked.text === "Shown words.\n\n_Stopped._" && picked.stoppedAt === 12, `the note stays, got ${JSON.stringify(picked)}`);
	const unstoppedServer = pickAnswerPart(a("k1-a1", "Whole answer.", { landed: true }), a("k1-a1", "Whole\n\n_Stopped._", { stoppedAt: 5 }), false);
	assert(unstoppedServer.text === "Whole answer." && unstoppedServer.stoppedAt === undefined, `a refused stop adds nothing to a whole answer, got ${JSON.stringify(unstoppedServer)}`);
});
row("a stale unstopped save keeps the saved Stop note and its 40 characters", () => {
	const words = "x".repeat(80);
	const file = [q("k1", "Go"), a("k1-a1", `${words.slice(0, 40)} [Stopped]`, { stoppedAt: 40, landed: true })];
	const merged = mergeSaveById(file, [q("k1", "Go"), a("k1-a1", words)], none, always);
	assert(byId(merged, "k1-a1").text === `${words.slice(0, 40)} [Stopped]` && byId(merged, "k1-a1").stoppedAt === 40, `kept, got ${JSON.stringify(byId(merged, "k1-a1"))}`);
});
row("a stop count from an old window shortens nothing once a newer turn exists", () => {
	const file = [q("k1", "Go"), a("k1-a1", "Whole older answer.", { landed: true })];
	const merged = mergeSaveById(file, [q("k1", "Go"), a("k1-a1", "Whole", { stoppedAt: 5 })], none, (key) => key === "k2");
	assert(byId(merged, "k1-a1").text === "Whole older answer." && byId(merged, "k1-a1").stoppedAt === undefined, `the older answer stays whole, got ${JSON.stringify(byId(merged, "k1-a1"))}`);
	const cutHere = cutAnswerPart(a("k1-a1", "Whole answer [Stopped]", { stoppedAt: 12 }), 5);
	assert(cutHere.text === "Whole [Stopped]" && cutHere.stoppedAt === 5, `a server cut keeps the note, got ${JSON.stringify(cutHere)}`);
});
row("a removed id stays out of the save that names it and of an older save after it", () => {
	const file = landTurnItems([q("k0", "Earlier"), q("k1", "Refused")], [q("k1", "Refused")], place("k1", ["k0", "k1"]), none);
	const removal = mergeSaveById(file, [q("k0", "Earlier"), q("k1", "Refused")], new Set(["k1"]), always);
	assert(ids(removal) === "k0", `the named id goes, got ${ids(removal)}`);
	// The server remembers it: the older save that still holds it, merged with the remembered removal.
	const older = mergeSaveById(removal, [q("k0", "Earlier"), q("k1", "Refused")], new Set(["k1"]), always);
	assert(ids(older) === "k0", `it stays out, got ${ids(older)}`);
	const relanded = landTurnItems(older, [q("k1", "Refused"), a("k1-a1", "Late")], place("k1", ["k0", "k1"]), new Set(["k1"]));
	assert(ids(relanded) === "k0,k1-a1", `a landing skips it too, got ${ids(relanded)}`);
});
row("in a mixed thread the old answer comes back before the keyed question, keyed items stay in place", () => {
	const file = [q("u1", "Old question"), a("detached-assistant-turn_1", "Old answer"), q("k2", "New", ), step("k2-t1", "done", "ok", { landed: true }), a("k2-a1", "One.", { landed: true }), a("k2-a2", "Two.", { landed: true })];
	const save = [q("u1", "Old question"), q("k2", "New"), step("k2-t1", "done", "ok"), a("k2-a1", "One."), a("k2-a2", "Two.")];
	const merged = mergeSaveById(file, save, none, always);
	// The old merge's restore point would be the end; the limit puts it before the first shared item after it.
	const at = legacyInsertIndex(merged, file, "detached-assistant-turn_1", merged.length);
	const firstShared = merged.findIndex((item) => isShared(item));
	assert(at === firstShared && ids(merged.slice(at)) === "k2-t1,k2-a1,k2-a2", `before the keyed items, got ${at} in ${ids(merged)}`);
	assert(legacyInsertIndex(merged, [a("detached-x", "x")], "detached-x", 3) === 3, "with no shared item after it the old rule stands");
});
row("a landed declined notice goes beside a card the page saved later, and an older save does not bring it back", () => {
	const notice = { kind: "system", id: "k1-declined-1", text: "While you were away, the room asked to run a command. It did not run, because nobody was there to approve it.", level: "info" };
	const card = { kind: "approval", id: "m5", title: "Run this command?", done: false };
	const file = landTurnItems([q("k1", "Go")], [q("k1", "Go"), step("k1-t1", "stopped"), notice], place("k1", ["k1"], null), none);
	assert(byId(file, "k1-declined-1"), "the landing wrote the notice");
	const withCard = mergeSaveById(file, [q("k1", "Go"), card, step("k1-t1", "stopped")], none, always);
	assert(byId(withCard, "m5") && !byId(withCard, "k1-declined-1"), `the card stays, the notice goes, got ${ids(withCard)}`);
	const older = mergeSaveById(file, [q("k1", "Go"), card], none, always);
	assert(!byId(older, "k1-declined-1"), `an older save with the card brings no notice back, got ${ids(older)}`);
	const noCard = mergeSaveById(file, [q("k1", "Go")], none, always);
	assert(byId(noCard, "k1-declined-1"), "without the card the notice stays");
});

// --- The keyed step log: parts, ids on frames, order and the echo.
const textMessage = (blocks: any[], stopReason = "stop") => ({ role: "assistant", content: blocks, stopReason });
const startFrame = { type: "message_start", message: { role: "assistant" } };
const update = (event: any) => ({ type: "message_update", assistantMessageEvent: event });
row("frames: a message opens part a1; text after a shown step opens a2; the step's opening frame names t1", () => {
	const log = createTurnStepLog("k1");
	assert(log.frame(startFrame).itemId === "k1-a1", "message_start names a1");
	assert(log.frame(update({ type: "text_start", contentIndex: 0 })).itemId === undefined, "the first text_start continues a1");
	log.frame(update({ type: "text_delta", contentIndex: 0, delta: "Checking." }));
	const call = { type: "toolCall", id: "call_1", name: "bash", arguments: {} };
	assert(log.frame(update({ type: "toolcall_start", contentIndex: 1, partial: { content: [{}, call] } })).itemId === "k1-t1", "the call's first frame names t1");
	const end = log.frame(update({ type: "toolcall_end", contentIndex: 1, toolCall: call }));
	assert(end.itemId === "k1-t1" && !end.opens, `a later frame of the call names it without opening it, got ${JSON.stringify(end)}`);
	log.note(textMessage([{ type: "text", text: "Checking." }, call], "toolUse"));
	log.note({ role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false });
	assert(log.frame(startFrame).itemId === "k1-a2", "the next message names a2");
	log.note(textMessage([{ type: "text", text: "All good." }]));
	const items = log.keyedItems();
	assert(ids(items) === "k1-a1,k1-t1,k1-a2", `parts and the step in order, got ${ids(items)}`);
	assert(byId(items, "k1-t1").status === "done" && byId(items, "k1-t1").result === "ok", "the step finished with its result");
	assert(ids(log.keyedItems()) === ids(items), "reading twice names the same ids");
});
// What the page receives for a stream of runtime events: the step log, the projection, the ids and the coalescer, with its window driven by hand.
const wire = (key: string, events: Array<() => any>): any[] => {
	const log = createTurnStepLog(key);
	const project = createWebClientEventProjector(() => 0);
	const sent: any[] = [];
	const windows: Array<() => void> = [];
	const coalescer = createTurnFrameCoalescer((frame) => sent.push(frame), (fn) => { windows.push(fn); return 0; });
	// Each event is built when it is handled: the provider fills the shared partial in as its chunks arrive.
	for (const next of events) {
		const event = next();
		coalescer.push({ type: "event", event: withFrameIds(project(event), log.frame(event), undefined) });
	}
	while (windows.length) windows.shift()!();
	coalescer.flush();
	return sent.map((frame) => frame.event?.assistantMessageEvent ?? frame.event);
};
row("frames: a call named after its first frames is named on a frame that reaches the page, and no heartbeat carries the id", () => {
	const wrong: string[] = [];
	for (const [label, before, named] of [["id late", { id: "", name: "bash" }, { id: "call_9" }], ["name late", { id: "call_9", name: "" }, { name: "bash" }]] as const) {
		const block: any = { type: "toolCall", ...before, arguments: {} };
		const partial = { role: "assistant", content: [block] };
		const sent = wire("k3", [
			() => startFrame,
			() => update({ type: "toolcall_start", contentIndex: 0, partial }),
			() => update({ type: "toolcall_delta", contentIndex: 0, delta: "", partial }),
			() => { Object.assign(block, named, { arguments: { command: "ls" } }); return update({ type: "toolcall_delta", contentIndex: 0, delta: "{\"command\":\"ls", partial }); },
			() => { block.arguments = { command: "ls -l" }; return update({ type: "toolcall_delta", contentIndex: 0, delta: " -l", partial }); },
			() => { block.arguments = { command: "ls -la" }; return update({ type: "toolcall_delta", contentIndex: 0, delta: "a", partial }); },
			// Nothing new to show: the projection sends a heartbeat.
			() => update({ type: "toolcall_delta", contentIndex: 0, delta: "", partial }),
		]);
		const firstNamed = sent.find((frame) => frame.id === "call_9");
		if (firstNamed?.itemId !== "k3-t1") wrong.push(`${label}: the first frame naming the call names the step, got ${JSON.stringify(sent)}`);
		if (!sent.every((frame) => !frame.itemId || frame.id === "call_9" || frame.type === "message_start")) wrong.push(`${label}: no heartbeat carries the id, got ${JSON.stringify(sent)}`);
	}
	assert(wrong.length === 0, wrong.join("; "));
});
row("frames: no key, no ids; a retried attempt gives its part number back", () => {
	const plain = createTurnStepLog();
	assert(plain.frame(startFrame).itemId === undefined && plain.keyedItems().length === 0, "an old-style turn names nothing");
	const log = createTurnStepLog("k1");
	log.frame(startFrame);
	log.note(textMessage([{ type: "text", text: "Half" }], "error"), { retrying: true });
	assert(log.frame(startFrame).itemId === "k1-a1", "the retry streams under the same part id");
	log.note(textMessage([{ type: "text", text: "Whole answer." }]));
	assert(ids(log.keyedItems()) === "k1-a1" && byId(log.keyedItems(), "k1-a1").text === "Whole answer.", "one part, the retry's words");
});
row("a hidden failing call and a shown call land in the order the page showed them", () => {
	const log = createTurnStepLog("k1");
	log.frame(startFrame);
	const hidden = { type: "toolCall", id: "call_m", name: "memory_search", arguments: { query: "x" } };
	const shown = { type: "toolCall", id: "call_b", name: "bash", arguments: { command: "ls" } };
	log.note(textMessage([hidden, shown], "toolUse"));
	log.note({ role: "toolResult", toolCallId: "call_b", toolName: "bash", content: [{ type: "text", text: "files" }], isError: false });
	log.note({ role: "toolResult", toolCallId: "call_m", toolName: "memory_search", content: [{ type: "text", text: "no index" }], isError: true });
	const items = log.keyedItems();
	assert(items.map((item: any) => item.name).join() === "bash,memory_search", `the shown card, then the error card, got ${items.map((item: any) => item.name)}`);
	assert(new Set(ids(items).split(",")).size === 2 && ids(log.keyedItems()) === ids(items), "each has its own lasting id");
});
row("a summary that repeats a non-streamed answer within 30 s is an echo; a different one is a part", () => {
	const log = createTurnStepLog("k1");
	log.frame(startFrame);
	log.frame(update({ type: "text_delta", contentIndex: 0, delta: "The answer." }));
	log.note(textMessage([{ type: "text", text: "The answer." }]), { now: 1_000 });
	log.frame(startFrame);
	const echo = log.note(textMessage([{ type: "text", text: "The  answer." }]), { now: 5_000 });
	assert(echo.echoOf === "k1-a1", `the repeat answers echoOf a1, got ${JSON.stringify(echo)}`);
	log.frame(startFrame);
	const other = log.note(textMessage([{ type: "text", text: "A different summary." }]), { now: 6_000 });
	assert(other.echoOf === undefined, "a different summary is no echo");
	assert(ids(log.keyedItems()) === "k1-a1,k1-a3", `one part for the echo pair, a second for the new words, got ${ids(log.keyedItems())}`);
	const late = createTurnStepLog("k2");
	late.frame(startFrame);
	late.frame(update({ type: "text_delta", contentIndex: 0, delta: "Same." }));
	late.note(textMessage([{ type: "text", text: "Same." }]), { now: 0 });
	late.frame(startFrame);
	assert(late.note(textMessage([{ type: "text", text: "Same." }]), { now: 31_000 }).echoOf === undefined, "past the window it is a part of its own");
});
row("a Stop across stretches cuts where the page stopped; later stretches go, cut to nothing", () => {
	const log = createTurnStepLog("k1");
	log.frame(startFrame);
	log.frame(update({ type: "text_delta", contentIndex: 0, delta: "First." }));
	log.frame(update({ type: "thinking_start", contentIndex: 1 }));
	log.frame(update({ type: "text_start", contentIndex: 2 }));
	log.note(textMessage([{ type: "text", text: "First." }, { type: "thinking", thinking: "hm" }, { type: "text", text: "Second part." }], "aborted"), { shownAtStop: 3 });
	const items = log.keyedItems();
	assert(byId(items, "k1-a1").text === "Fir" && byId(items, "k1-a1").stoppedAt === 3, `the shown words, got ${JSON.stringify(byId(items, "k1-a1"))}`);
	assert(byId(items, "k1-a2").text === "" && byId(items, "k1-a2").stoppedAt === 0, "the unseen stretch is cut to nothing");
	const after = createTurnStepLog("k2");
	after.frame(startFrame);
	after.note(textMessage([{ type: "text", text: "Shown here. Unseen there." }]));
	const cuts = after.cutLastMessage(11);
	assert(JSON.stringify(cuts) === JSON.stringify([{ id: "k2-a1", kept: 11 }]) && byId(after.keyedItems(), "k2-a1").text === "Shown here.", `a reveal cut after the message ended, got ${JSON.stringify(cuts)}`);
	assert(after.cutNamedPart("k2-a1", 5) === "Shown" && after.cutNamedPart("k2-a9", 1) === undefined, "a named cut answers the words kept, or nothing");
});

if (failed.length > 0) {
	console.error(`${failed.length} rule rows failed:\n${failed.join("\n")}`);
	process.exit(1);
}
console.log("thread items by id: all rows passed");
