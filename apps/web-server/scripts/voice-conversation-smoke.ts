// Smoke for conversation mode's pure parts: the sentence splitter that turns
// a streamed markdown reply into speech, the filler planner that decides what
// the app says while the model is silent, the language guess, the talk key
// and the hint the server appends to a spoken turn. No audio, no DOM, no
// models.
//
// Run: npm run smokes -- voice-conversation   (or tsx this file)

import { cleanForSpeech, SentenceSplitter } from "../../web-ui/src/voice/spoken-text.js";
import { DEFAULT_TALK_KEY, formatTalkKey, isTalkKeyDown, modifiersOf, modifiersOnlyTalkKey, NO_MODIFIERS, parseTalkKey, releasesTalkKey, serializeTalkKey, talkKeyFromEvent, unionModifiers } from "../../web-ui/src/voice/talk-key.js";
import { FillerPlanner, guessLanguage } from "../../web-ui/src/voice/filler.js";
import { SPOKEN_CONVERSATION_HINT, withSpokenConversationHint } from "../src/voice.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Stream a reply in awkward slices, the way a model delivers it. */
function stream(text: string, size = 7): string[] {
	const splitter = new SentenceSplitter();
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(...splitter.push(text.slice(i, i + size)));
	const rest = splitter.flush();
	if (rest) out.push(rest);
	return out;
}

// Sentences arrive whole, as soon as they end.
const plain = stream("Found it. Two points matter for you. First, remote work is a right up to three days a week.");
assert(plain.length === 3 && plain[0] === "Found it." && plain[2].startsWith("First, remote work"), `plain prose splits by sentence: ${JSON.stringify(plain)}`);

// Abbreviations and numbers do not end a sentence.
const german = stream("Das gilt z.B. für Nr. 5 und Version 3.5 der Richtlinie. Der 3. Punkt folgt morgen.");
assert(german.length === 2, `abbreviations and numbers stay inside their sentence: ${JSON.stringify(german)}`);
assert(german[0].includes("z.B.") && german[0].includes("3.5"), "the abbreviation and the version number are kept");

// Markdown is read as prose: headings and list markers vanish, links keep their text.
const markdown = stream("## Summary\n\n- The **budget** is approved.\n- See [the minutes](https://example.com/m) for details.\n\nDone.");
assert(markdown[0] === "Summary", `a heading is spoken as its words: ${JSON.stringify(markdown)}`);
assert(markdown.includes("The budget is approved.") && markdown.includes("See the minutes for details."), `list items are spoken without markers or URLs: ${JSON.stringify(markdown)}`);
assert(markdown[markdown.length - 1] === "Done.", "the trailing sentence is flushed");

// Code and tables are not read aloud, and a fence is never cut in half.
const code = stream("Run this:\n\n```bash\necho one. two. three.\n```\n\nThen you are done.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
assert(!code.some((s) => /echo|one\. two/.test(s)), `code is silent: ${JSON.stringify(code)}`);
assert(code.includes("Run this:") && code.includes("Then you are done."), `prose around code is spoken: ${JSON.stringify(code)}`);
assert(!code.some((s) => /\|/.test(s) || /^a b$/.test(s)), `tables are silent: ${JSON.stringify(code)}`);
assert(cleanForSpeech("**bold** and `code` and *it*") === "bold and code and it", "emphasis and inline code read as their text");

// Language guess: the pronunciation of the app's own lines follows the user.
assert(guessLanguage("Was steht im neuen Betriebsratsvertrag zur Heimarbeit?") === "de", "German question is German");
assert(guessLanguage("What does the new agreement say about remote work?") === "en", "English question is English");
assert(guessLanguage("Betriebsrat Homeoffice", "de") === "de", "no signal keeps the previous language");

// Filler: speak only while the model is silent, once per kind, no double Okay.
const planner = new FillerPlanner();
planner.startTurn();
const search = planner.planForTools([{ name: "memory_recall", args: {} }, { name: "web_search", args: { query: "works council remote work" } }], "en");
assert(search.speak === 'Okay, searching the web for "works council remote work".', `first tool opens with Okay and the query: ${search.speak}`);
assert(search.label === "Searching the web", "the bar shows the search label");
assert(planner.planForTools([{ name: "web_search", args: { query: "again" } }], "en").speak === null, "a second search in the same turn says nothing more");
const page = planner.planForTools([{ name: "fetch_url", args: { url: "https://www.bundesanzeiger.de/x" } }], "en");
assert(page.speak === "Reading a page from bundesanzeiger.de." && page.label === "Reading a page", `a new kind gets one line without a second Okay: ${page.speak}`);
planner.onModelText();
assert(planner.planForTools([{ name: "kb_search", args: {} }], "en").speak === null, "once the model has spoken the app stays quiet");
assert(planner.planForTools([{ name: "kb_search", args: {} }], "en").label === "Knowledge base", "but the bar still shows what runs");

planner.startTurn();
const ack = planner.acknowledgement("de");
assert(ack === "Okay." && planner.acknowledgement("de") === "Verstanden.", "acknowledgements rotate");
const afterAck = planner.planForTools([{ name: "web_search", args: { query: "Betriebsrat" } }], "de");
assert(afterAck.speak === "Ich suche im Web nach „Betriebsrat“.", `after an acknowledgement the tool line has no second Okay: ${afterAck.speak}`);
planner.startTurn();
assert(planner.planForTools([{ name: "memory_recall", args: {} }], "de").speak === null, "memory housekeeping is silent");
assert(planner.planForTools([{ name: "delegate_task", args: {} }], "de").speak === "Okay, ich gebe das an einen Spezialisten weiter.", "delegation is announced in German");
assert(planner.planForTools([{ name: "something_new", args: {} }], "en").speak === "Working on it.", "unknown tools get a generic line");

// The talk key: parsed, shown, matched on the way down and on the way up, recorded.
const key = parseTalkKey(DEFAULT_TALK_KEY)!;
assert(key.alt && !key.ctrl && !key.shift && !key.meta && key.code === "Space", "the default is Alt+Space");
assert(parseTalkKey("Space") === null && parseTalkKey("Alt+") === null && parseTalkKey("Hyper+Space") === null, "a plain key, a bare modifier and an unknown modifier are not talk keys");
assert(serializeTalkKey(parseTalkKey("Shift+Ctrl+KeyV")!) === "Ctrl+Shift+KeyV", "modifiers serialise in one order");
assert(formatTalkKey("Alt+Space", true) === "⌥ Space" && formatTalkKey("Ctrl+Shift+KeyV", false) === "Ctrl+Shift+V" && formatTalkKey("Meta+Digit1", true) === "⌘ 1", "labels read as keys, not codes");
const press = (o: Partial<{ code: string; key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>) => ({ code: "", key: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
assert(isTalkKeyDown(press({ code: "Space", altKey: true }), key), "Alt+Space is the talk key going down");
assert(!isTalkKeyDown(press({ code: "Space", altKey: true, shiftKey: true }), key), "an extra modifier is a different combination");
assert(!isTalkKeyDown(press({ code: "Space" }), key), "Space alone is typing");
assert(releasesTalkKey(press({ code: "Space", key: " " }), key), "releasing the key ends the hold");
assert(releasesTalkKey(press({ code: "AltLeft", key: "Alt" }), key), "releasing a needed modifier ends the hold");
assert(!releasesTalkKey(press({ code: "ShiftLeft", key: "Shift" }), key), "releasing an unrelated key does not");
assert(talkKeyFromEvent(press({ code: "KeyV", key: "v", ctrlKey: true, shiftKey: true })) === "Ctrl+Shift+KeyV", "recording a combination");
assert(talkKeyFromEvent(press({ code: "KeyV", key: "v" })) === null, "a key without a modifier is not recorded");
assert(talkKeyFromEvent(press({ code: "AltLeft", key: "Alt", altKey: true })) === null, "a modifier alone is not recorded");

// Modifiers on their own, the way Handy allows: two or more, completing on the last one's key-down.
const ctrlAlt = parseTalkKey("Ctrl+Alt")!;
assert(ctrlAlt.ctrl && ctrlAlt.alt && ctrlAlt.code === "", "Ctrl+Alt is a talk key with no key of its own");
assert(parseTalkKey("Alt") === null && parseTalkKey("Alt+Alt") === null, "a single modifier is not, nor the same one twice");
assert(isTalkKeyDown(press({ code: "AltLeft", key: "Alt", ctrlKey: true, altKey: true }), ctrlAlt), "the second modifier going down completes Ctrl+Alt");
assert(!isTalkKeyDown(press({ code: "ControlLeft", key: "Control", ctrlKey: true }), ctrlAlt), "the first modifier alone does not");
assert(!isTalkKeyDown(press({ code: "KeyA", key: "a", ctrlKey: true, altKey: true }), ctrlAlt), "a letter typed while both are held does not start a second hold");
assert(!isTalkKeyDown(press({ code: "AltLeft", key: "Alt", ctrlKey: true, altKey: true, shiftKey: true }), ctrlAlt), "an extra modifier is a different combination");
assert(releasesTalkKey(press({ code: "ControlLeft", key: "Control" }), ctrlAlt) && !releasesTalkKey(press({ code: "Space", key: " " }), ctrlAlt), "letting go of either modifier ends the hold; other keys do not");
const fnShift = parseTalkKey("Fn+Shift")!;
assert(fnShift.fn && fnShift.shift && isTalkKeyDown(press({ code: "ShiftLeft", key: "Shift", shiftKey: true }), fnShift, true), "Fn is a modifier when the browser reports it, tracked by the caller");
assert(!isTalkKeyDown(press({ code: "ShiftLeft", key: "Shift", shiftKey: true }), fnShift, false), "without Fn, Shift alone is not the key");
assert(releasesTalkKey(press({ code: "Fn", key: "Fn" }), fnShift), "letting go of Fn ends the hold");
assert(formatTalkKey("Ctrl+Alt", true) === "⌃ ⌥" && formatTalkKey("Fn+Shift", true) === "fn ⇧" && formatTalkKey("Ctrl+Alt", false) === "Ctrl+Alt", "modifier-only labels");
// Recording: modifiers gathered while held, taken on release; one alone is refused.
let heldMods = unionModifiers(NO_MODIFIERS, modifiersOf(press({ code: "ControlLeft", key: "Control", ctrlKey: true })));
assert(modifiersOnlyTalkKey(heldMods) === null, "one modifier released is not enough");
heldMods = unionModifiers(heldMods, modifiersOf(press({ code: "AltLeft", key: "Alt", ctrlKey: true, altKey: true })));
assert(modifiersOnlyTalkKey(heldMods) === "Ctrl+Alt", "two gathered modifiers record as Ctrl+Alt");
assert(modifiersOnlyTalkKey(unionModifiers(NO_MODIFIERS, modifiersOf(press({ code: "ShiftLeft", key: "Shift", shiftKey: true }), true))) === "Fn+Shift", "Fn gathers with Shift, and leads");

// The hint: only on spoken turns, appended, never replacing the text.
assert(withSpokenConversationHint("hello", false) === "hello", "typed turns are untouched");
const spoken = withSpokenConversationHint("hello", true);
assert(spoken.startsWith("hello\n\n") && spoken.endsWith(SPOKEN_CONVERSATION_HINT), "spoken turns carry the hint after the text");
assert(!/narrat|announce|say what/i.test(SPOKEN_CONVERSATION_HINT), "the hint never asks the model to narrate its steps");

console.log("voice-conversation-smoke: OK");
