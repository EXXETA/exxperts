// Fold quality bench — the scripted models of the offline run.
//
// A scripted model is a function from the fold prompt to a reply, the same
// contract the real worker fulfils, so the bench's loop never learns whether it
// is talking to a provider. Each one reads the prompt the way a model would:
// the session it was given and the entries it may address are BOTH read back
// out of the assembled prompt — the entries by the id each one carries in its
// own first line — so a prompt that stopped carrying either would show up as a
// scripted run that suddenly scores nothing.
//
// Three of them, and each is there to prove a different thing:
//   - `exact` answers with the operations the fixture planted, so a scorer that
//     reports anything but a perfect run is a scorer with a bug in it;
//   - `lazy` adds every line it sees as a new entry and never supersedes,
//     closes, pins or drops — the failure mode the design is most afraid of,
//     and the run where the scorer must visibly say so;
//   - `decorated` answers with the same operations as `exact`, wrapped in
//     prose under `### **Bold**` headings, so the reply parser's fence and
//     narrative handling is exercised on every run, not only in its own smoke.
//
// None of them talks to a provider, a route or the disk.

import { readPlantDirectives, type PlantDirective } from "./fold-fixtures.mjs";

/** The one contract: prompt in, reply out. The real worker fulfils it too. */
export type ScriptedFoldModel = (prompt: string) => string;

export const SCRIPTED_FOLD_VARIANTS = ["exact", "lazy", "decorated"] as const;
export type ScriptedFoldVariant = (typeof SCRIPTED_FOLD_VARIANTS)[number];

/** One addressable entry of the prompt's memory, read back the way a model reads it. */
interface PromptArea {
	id: string;
	topic: string;
	pinned: boolean;
	firstLine: string;
}

const SECTION_SPLIT = /\n\n---\n\n/;

function promptSection(prompt: string, heading: string): string {
	const parts = prompt.split(SECTION_SPLIT);
	const found = parts.find((part) => part.trimStart().startsWith(heading));
	if (!found) throw new Error(`the fold prompt carries no "${heading}" section`);
	return found.slice(found.indexOf("\n") + 1).trim();
}

/** The session the prompt gave, verbatim: the scripted model reads nothing else about it. */
export function sessionFromPrompt(prompt: string): string {
	const parts = prompt.split(SECTION_SPLIT);
	const found = parts.find((part) => part.trimStart().startsWith("## Material: The Session To Fold"));
	if (!found) throw new Error('the fold prompt carries no "## Material: The Session To Fold" section');
	return found.slice(found.indexOf("\n") + 1).trim();
}

/**
 * The entry's address as the fold prompt writes it: `- [m-0031 · saved
 * 2026-08-02] …`, `- [m-0032 · pinned · saved …] …` for a pinned one, and
 * `· updated 2026-09-01` after the saved date once a fold rewrote it.
 */
const ENTRY_ADDRESS = /^(?:\s*(?:[-*+]|\d+[.)])\s+)?\[([^\]\s·]+)((?:\s+·\s+[^\]·]+)*)\]\s*([\s\S]*)$/;

/** The addressable entries, read back off the memory the prompt carries. */
export function areasFromPrompt(prompt: string): PromptArea[] {
	const body = promptSection(prompt, "## Material: Core Memory As The Room Reads It");
	const rows: PromptArea[] = [];
	let topic = "";
	for (const line of body.split("\n")) {
		const section = /^##\s+(.+?)\s*$/.exec(line);
		if (section) { topic = section[1] === "Active Items" ? "Active Items" : "General"; continue; }
		const heading = /^###\s+(.+?)\s*$/.exec(line);
		if (heading) { topic = heading[1]; continue; }
		const row = ENTRY_ADDRESS.exec(line.trim());
		if (row) rows.push({ id: row[1], topic, pinned: /·\s+pinned\b/.test(row[2]), firstLine: row[3] });
	}
	return rows;
}

/**
 * A directive's target as an entry id: either an id written out, or `@MARKER`
 * — the entry an earlier session of this same run added, found by the marker it
 * carries. The second shape is how a correction reaches the entry it corrects
 * without the fixture knowing, before the run, what id that entry will get.
 */
function resolveTarget(target: string | undefined, areas: PromptArea[]): string | undefined {
	if (!target) return undefined;
	if (!target.startsWith("@")) return target;
	const marker = target.slice(1);
	return areas.find((area) => area.firstLine.includes(marker))?.id;
}

interface ScriptedOp {
	op: string;
	[field: string]: unknown;
}

function opsFromDirectives(directives: PlantDirective[], areas: PromptArea[]): ScriptedOp[] {
	const ops: ScriptedOp[] = [];
	for (const directive of directives) {
		const id = resolveTarget(directive.target, areas);
		switch (directive.op) {
			case "add":
				ops.push({ op: "add", topic: directive.topic ?? "General", kind: directive.kind === "practice" ? "practice" : directive.kind === "item" ? "item" : "fact", text: `- ${directive.line}` });
				break;
			case "update":
			case "supersede":
				if (id) ops.push({ op: directive.op, id, text: `- ${directive.line}` });
				break;
			case "close":
				if (id) ops.push({ op: "close", id });
				break;
			case "pin":
			case "unpin":
				if (id) ops.push({ op: directive.op, id, because: directive.quote ?? "" });
				break;
			case "drop":
				// A drop says the session changes nothing, so it travels alone.
				return [{ op: "drop", reason: directive.reason ?? "nothing in this session outlives it" }];
			case "none":
				break;
		}
	}
	return ops;
}

function fence(ops: ScriptedOp[]): string {
	return ["```json", JSON.stringify({ ops }, null, 2), "```"].join("\n");
}

/** The operations the fixture planted, answered plainly: the run that proves the scorer. */
export const exactFoldModel: ScriptedFoldModel = (prompt) => {
	const ops = opsFromDirectives(readPlantDirectives(sessionFromPrompt(prompt)), areasFromPrompt(prompt));
	const narrative = ops.length === 1 && ops[0].op === "drop"
		? "This session holds nothing that outlives it."
		: `This session leaves ${ops.length} change${ops.length === 1 ? "" : "s"} behind; everything else was working noise.`;
	return `${narrative}\n\n${fence(ops)}`;
};

/**
 * Everything becomes a new entry: no supersede, no close, no pin, no drop, and
 * the session's noise lands in memory beside its substance. Mechanically valid
 * — which is the point: the bench's verdict on it has to come from the scores,
 * not from the validator.
 */
export const lazyFoldModel: ScriptedFoldModel = (prompt) => {
	const directives = readPlantDirectives(sessionFromPrompt(prompt));
	const ops: ScriptedOp[] = directives
		.filter((directive) => directive.line)
		.slice(0, 12)
		.map((directive) => ({ op: "add", topic: "General", kind: "fact", text: `- ${directive.line}` }));
	return `Kept everything this session said, under one topic.\n\n${fence(ops)}`;
};

/** The same operations as `exact`, buried in prose and bold headings. */
export const decoratedFoldModel: ScriptedFoldModel = (prompt) => {
	const ops = opsFromDirectives(readPlantDirectives(sessionFromPrompt(prompt)), areasFromPrompt(prompt));
	return [
		"### **What this session leaves behind**",
		"",
		"The sitting produced a small number of durable points; the rest was working noise and belongs nowhere.",
		"",
		"### **How I folded it**",
		"",
		"Each point went to the entry that already carries its subject where there was one, and to a new entry where there was not.",
		"",
		"### **Operations**",
		"",
		fence(ops),
	].join("\n");
};

export const SCRIPTED_FOLD_MODELS: Record<ScriptedFoldVariant, ScriptedFoldModel> = {
	exact: exactFoldModel,
	lazy: lazyFoldModel,
	decorated: decoratedFoldModel,
};

/**
 * A reply that names an entry the memory does not hold: the refusal rehearsal,
 * so the bench exercises the validator's refusal path and the Retry Notice on
 * every offline run instead of only when a real model happens to slip.
 */
export const refusingThenExactFoldModel = (): ScriptedFoldModel => {
	let asked = 0;
	return (prompt) => {
		asked += 1;
		if (asked === 1) return `A first attempt.\n\n${fence([{ op: "update", id: "m-9999", text: "- An entry this memory does not hold." }])}`;
		return exactFoldModel(prompt);
	};
};
