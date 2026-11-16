// Every long-lived holder of state in the server's memory is on one list, with
// what a restart does to it (restart-holders-list.ts). A holder not on the list
// fails here, and so does a list line whose holder has gone, so a new Map cannot
// land with nobody having asked what a restart does to it.
//
// What counts as a holder is restart-holders-detect.ts'. This reads the flat
// files of src, the server every edition shares; a folder below src is outside
// this list.
//
// The rows below run the detection on planted sources, so a hole in it fails here
// and not on the day a holder slips through.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findHolders, listProblems, type ListFiles } from "./restart-holders-detect.js";
import { RESTART_HOLDERS, type RestartHolder } from "./restart-holders-list.js";
import { KNOWN_CASES } from "./restart-known-cases.js";

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const FILES: ListFiles = { list: "restart-holders-list.ts", knownCases: "restart-known-cases.ts" };

function detectionRows(): void {
	const holdersOf = (text: string, other = "") => findHolders(new Map([["a.ts", text], ["b.ts", other]]));
	assert.deepEqual([...holdersOf("const fresh = new Map<string, string>();")], ["a.ts:fresh"], "an empty Map is a holder, written to or not");
	assert.deepEqual([...holdersOf("export const seen = new Set<string>();")], ["a.ts:seen"], "an exported empty Set is a holder");
	assert.deepEqual([...holdersOf("const held = new WeakMap<object, string>();")], ["a.ts:held"], "a WeakMap is a holder");
	assert.deepEqual([...holdersOf("let count = 0;")], ["a.ts:count"], "a let is a holder");
	assert.deepEqual([...holdersOf("const list: string[] = [];\nexport function add(x: string) { list.push(x); }")], ["a.ts:list"], "an array that is pushed to is a holder");
	assert.deepEqual([...holdersOf("const state = { n: 0 };\nexport function bump() { state.n = 1; }")], ["a.ts:state"], "an object written to is a holder");
	assert.deepEqual([...holdersOf("const byId: Record<string, string> = {};\nexport function drop(id: string) { delete byId[id]; }")], ["a.ts:byId"], "an object a key is deleted from is a holder");
	assert.deepEqual([...holdersOf("const limiter = makeLimiter(3);")], ["a.ts:limiter"], "a make call may keep state in its closure");
	assert.deepEqual([...holdersOf("const store = createStore();")], ["a.ts:store"], "a create call may keep state in its closure");
	assert.deepEqual([...holdersOf("class Bag {}\nconst bag = new Bag();")], ["a.ts:bag"], "any other object made with new is a holder");
	assert.deepEqual([...holdersOf("const wrapped = new Map<string, string>() as ReadonlyMap<string, string>;")], ["a.ts:wrapped"], "a cast hides nothing");
	assert.deepEqual([...holdersOf("export const shared = { n: 0 };", `import { shared } from "./a.js";\nshared.n = 2;`)], ["a.ts:shared"], "a change from an importing file counts");
	// The allowed neighbours: tables and constants stay off the list.
	assert.deepEqual([...holdersOf("const TABLE = new Map([[\"a\", 1]]);")], [], "a filled Map nothing changes is a table");
	assert.deepEqual([...holdersOf("const WORDS = [\"a\", \"b\"];\nconst LABELS = { a: 1 };\nconst FIXED = Object.freeze({ a: 1 });\nconst PATTERN = new RegExp(\"a\");\nconst sorter = new Intl.Collator();\nconst size = compute();")], [], "constants are no holders");
	assert.deepEqual([...holdersOf("export const local = [\"a\"];", "const local: string[] = [];\nlocal.push(\"b\");")].sort(), ["b.ts:local"], "another file's own name changes nothing here");
	assert.deepEqual([...holdersOf("export function run() { const inner = new Map<string, string>(); return inner; }")], [], "a Map inside a function is that call's own");

	const lines: RestartHolder[] = [{ holder: "a.ts:kept", fate: "cache", why: "rebuilt from files" }];
	assert.deepEqual(listProblems(new Set(["a.ts:kept"]), lines, new Set(), FILES), [], "a holder on the list is fine");
	assert.match(listProblems(new Set(["a.ts:kept", "a.ts:fresh"]), lines, new Set(), FILES).join(), /a\.ts:fresh is not on the list/, "a holder not on the list fails");
	assert.match(listProblems(new Set(), lines, new Set(), FILES).join(), /a\.ts:kept is on the list but no such holder exists/, "a line whose holder went fails");
	assert.match(listProblems(new Set(["a.ts:kept"]), [...lines, ...lines], new Set(), FILES).join(), /listed twice/, "a doubled line fails");
	const gap: RestartHolder = { holder: "a.ts:kept", fate: "gap", meets: "words lost", knownCase: "some-case" };
	assert.match(listProblems(new Set(["a.ts:kept"]), [gap], new Set(), FILES).join(), /known case some-case is not/, "a gap with no known case fails");
	assert.deepEqual(listProblems(new Set(["a.ts:kept"]), [gap], new Set(["some-case"]), FILES), [], "a gap with its known case is fine");
}

detectionRows();
const sources = new Map(fs.readdirSync(sourceDir).filter((name) => name.endsWith(".ts")).map((name) => [name, fs.readFileSync(path.join(sourceDir, name), "utf-8")]));
const found = findHolders(sources);
const problems = listProblems(found, RESTART_HOLDERS, new Set(KNOWN_CASES.map((known) => known.id)), FILES);
if (process.env.RESTART_HOLDERS_SHOW) for (const holder of [...found].sort()) console.log(holder);
for (const problem of problems) console.error(`PROBLEM ${problem}`);
const counts = [...new Set(RESTART_HOLDERS.map((line) => line.fate))].map((fate) => `${RESTART_HOLDERS.filter((line) => line.fate === fate).length} ${fate}`).join(", ");
console.log(`restart holders: ${found.size} found in ${sources.size} files, ${RESTART_HOLDERS.length} listed (${counts}), ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
