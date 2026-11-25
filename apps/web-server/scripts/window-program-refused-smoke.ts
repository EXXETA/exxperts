// LibreOffice in a protected room on a Mac: the rule that refuses its start,
// as text, and what the model reads after a command, from the command's output
// as it came and how it ended. No box starts here: the real sandbox's rows, with
// a stand-in app bundle, are in room-box-turn-end-smoke.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileRules, profileRules } from "../src/room-box/box-rules.js";
import { type CommandEnd, readCommandOutput, refusedLines } from "../src/room-box/box-session.js";
import { boxModelLine, boxRefusedLine, LIBREOFFICE_REFUSED_LINE, RUN_OUTSIDE_BOX_TOOL_NAME } from "../src/room-box/card-text.js";
import { createRoomCommandTools } from "../src/room-command-tool.js";
import { windowsBoxModelLine } from "../src/room-box/windows/model-lines.js";

const failures: string[] = [];
let passed = 0;
function row(name: string, body: () => void): void {
	try {
		body();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  FAIL ${name}: ${(error as Error).message}`);
	}
}
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const FOLDER_LINE = boxRefusedLine(true);
const APP = "/Applications/LibreOffice.app/Contents/MacOS/soffice";

/** What the model reads after a command that printed these chunks and ended so. */
function linesAfter(command: string, chunks: string[], end: CommandEnd): string[] {
	const output = readCommandOutput();
	for (const chunk of chunks) output.read(Buffer.from(chunk));
	return refusedLines(command, output.end(), end, true);
}
function expectLines(command: string, chunks: string[], end: CommandEnd, expected: string[]): void {
	const got = linesAfter(command, chunks, end);
	assert(JSON.stringify(got) === JSON.stringify(expected), `${command} | ${JSON.stringify(chunks).slice(0, 200)} | ${end}: ${JSON.stringify(got)}`);
}

row("the rule is the program's place in any app bundle, for a room's commands alone", () => {
	const temp = path.join(fs.realpathSync(os.tmpdir()), "places");
	const places = { temp: `${temp}/t`, caches: `${temp}/c`, shim: `${temp}/s`, gitTemplate: `${temp}/g` };
	const rules = profileRules({ folder: `${temp}/room`, canChangeFiles: true, alsoAllowed: [], skillFolders: [], places }, [`${temp}/room`, places.temp, places.caches]);
	const found = /^\(deny process-exec \(regex (".*")\)\)$/m.exec(rules)?.[1];
	assert(found, `the rules: ${rules}`);
	const refuses = new RegExp(JSON.parse(found) as string);
	for (const place of [APP, "/Users/ana/Applications/LibreOffice.app/Contents/MacOS/soffice", "/Volumes/Work/My Apps/Office Copy.app/Contents/MacOS/soffice"]) assert(refuses.test(place), `not refused: ${place}`);
	for (const place of ["/Applications/LibreOffice.app/Contents/MacOS/gengal", "/opt/homebrew/bin/soffice", "/Applications/LibreOffice.app/Contents/Resources/soffice", "/a/Officexapp/Contents/MacOS/soffice", `${APP}.bin`, `${APP}/x`, "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"]) assert(!refuses.test(place), `refused: ${place}`);
	const forFiles = fileRules({ roots: [{ path: `${temp}/room`, access: "write" }], writes: true, closedBelow: [], asksNothing: false, program: [] }).profileRules;
	assert(!forFiles.includes("process-exec"), `the file program's rules: ${forFiles}`);
});

row("a refused start, in the words of what tried it, gives the LibreOffice line in place of the folder line", () => {
	const said = [
		`/bin/bash: ${APP}: Operation not permitted\n`,
		`/bin/bash: line 0: exec: ${APP}: cannot execute: Operation not permitted\n`,
		`/opt/homebrew/bin/soffice: line 2: ${APP}: Operation not permitted\n`,
		"/bin/bash: /usr/local/bin/soffice: Operation not permitted\n",
		"/bin/bash: /Users/ana/My Apps/Office Copy.app/Contents/MacOS/soffice: Operation not permitted\n",
		`zsh:1: operation not permitted: ${APP}\n`,
		`PermissionError: [Errno 1] Operation not permitted: '${APP}'\n`,
		"PermissionError: [Errno 1] Operation not permitted: 'soffice'\n",
		"env: soffice: Operation not permitted\n",
		"timeout: failed to run command ‘soffice’: Operation not permitted\n",
		`Can't exec "${APP}": Operation not permitted at convert.pl line 3.`,
	];
	for (const text of said) {
		for (const end of [126, 1, "failed"] as const) expectLines("./convert.sh", [text], end, [LIBREOFFICE_REFUSED_LINE]);
		// Every way the output can come in two pieces.
		for (let cut = 1; cut < text.length; cut++) expectLines("./convert.sh", [text.slice(0, cut), text.slice(cut)], 1, [LIBREOFFICE_REFUSED_LINE]);
	}
	// Through a pipe the command ends well: without the swap it would read the folder line, as any command that prints the words does.
	expectLines(`${APP} --headless 2>&1 | tail -3`, [`/bin/bash: ${APP}: Operation not permitted\n`], 0, [LIBREOFFICE_REFUSED_LINE]);
});

row("a failed command that printed nothing gives it when the shell's code says a program was not allowed to start and the command names LibreOffice's", () => {
	for (const command of [`${APP} --headless --convert-to pdf deck.pptx >/dev/null 2>&1`, "soffice --version &>/dev/null", 'S="/Applications/LibreOffice.app/Contents/MacOS/soffice"; "$S" --version 2>/dev/null']) expectLines(command, [], 126, [LIBREOFFICE_REFUSED_LINE]);
	// Neighbours: nothing started, nothing named, or not there; a silent failure reads the folder line, as before.
	for (const [command, end] of [["which soffice", 1], [`test -x ${APP}`, 1], ["soffice --version 2>/dev/null", 127], ["python3 build.py; soffice --version 2>/dev/null", "failed"], ["./convert.sh 2>/dev/null", 126], ["./soffice.py 2>/dev/null", 126], ["./my-soffice 2>/dev/null", 126], ["soffice/convert.sh 2>/dev/null", 126]] as const) expectLines(command, [], end, [FOLDER_LINE]);
});

row("another place's refusal keeps the folder line, letter for letter, and gets both lines beside LibreOffice's", () => {
	const place = "/bin/bash: /Users/ana/Documents/deck.pdf: Operation not permitted\n";
	expectLines("soffice --version; echo x > /Users/ana/Documents/deck.pdf", [place], 1, [FOLDER_LINE]);
	for (const text of ["open: Operation not permitted: '/Users/ana/soffice.py'\n", "cp: /Users/ana/soffice/deck.pdf: Operation not permitted\n", "cp: /Users/ana/about-soffice: Operation not permitted\n", "soffice failed: mkdir: /Users/ana/out: Operation not permitted\n", "PermissionError: [Errno 1] Operation not permitted: '/Users/ana/a' -> '/Users/ana/soffice'\n"]) expectLines("./convert.sh", [text], 1, [FOLDER_LINE]);
	const refused = `/bin/bash: ${APP}: Operation not permitted\n`;
	for (const chunks of [[refused, place], [place, refused], [refused + place], [`{"first": "${APP}: Operation not permitted", "then": "/Users/ana/x: Operation not permitted"}`]]) expectLines("./convert.sh", chunks, 1, [LIBREOFFICE_REFUSED_LINE, FOLDER_LINE]);
});

row("a command that only mentions LibreOffice, ended well or was stopped reads nothing new", () => {
	for (const [text, end] of [["Error: source file could not be loaded (soffice)\n", 1], ["soffice: command not found\n", 127], [`${APP}\n`, 0], ["soffice: converted deck.pptx\n", 0], ["soffice: still working\n", "failed"]] as const) expectLines(`${APP} --version`, [text], end, []);
	expectLines("soffice --version >/dev/null 2>&1", [], 0, []);
	const refused = `/bin/bash: ${APP}: Operation not permitted\n`;
	expectLines("./convert.sh", [], "stopped", []);
	expectLines("soffice >/dev/null 2>&1", [], "stopped", []);
	expectLines("./convert.sh", [refused], "stopped", []);
	// Another place's refusal before a stop reads as before.
	expectLines("./convert.sh", [refused, "cp: /Users/ana/x: Operation not permitted\n"], "stopped", [FOLDER_LINE]);
});

row("a refusal in output with no newline is still read, and a lot of it doesn't slow the read", () => {
	const filler = "x".repeat(40_000);
	const words = "cp: /Users/ana/x: Operation not permitted";
	// The line is read in pieces past its limit: the words cut at every place by a piece's end.
	for (let cut = 1; cut < words.length; cut++) expectLines("./convert.sh", ["y".repeat(70_000) + words.slice(0, cut), words.slice(cut) + filler], 1, [FOLDER_LINE]);
	expectLines("./convert.sh", [filler, ` ${APP}: Operation not permitted `, filler], 1, [LIBREOFFICE_REFUSED_LINE]);
	const started = Date.now();
	expectLines("./convert.sh", Array.from({ length: 160 }, () => "operation not permitted: /a".repeat(2_400)), 1, [FOLDER_LINE]);
	assert(Date.now() - started < 10_000, `10 MB of the words took ${Date.now() - started} ms`);
});

row("the line names the way out by its tool's name, and nothing the model reads with every answer names LibreOffice, on a Mac or on Windows", () => {
	assert(LIBREOFFICE_REFUSED_LINE === "LibreOffice can't start inside this room's protection. If the task needs it and you have run_outside_box, ask for that program alone, on files in the room's folder; otherwise go on without it and say what you couldn't check." && LIBREOFFICE_REFUSED_LINE.includes(RUN_OUTSIDE_BOX_TOOL_NAME), LIBREOFFICE_REFUSED_LINE);
	const list = { folders: [], sites: [] };
	const tools = [undefined, "windows"].flatMap((kind) => createRoomCommandTools(os.tmpdir(), { box: { kind, operations: () => ({}) } as any, outside: { questions: {} as any, setOffered: () => {} } }).tools);
	assert(tools.some((tool) => tool.name === RUN_OUTSIDE_BOX_TOOL_NAME), `the tools: ${tools.map((tool) => tool.name)}`);
	const standing = [...[true, false].flatMap((asks) => [true, false].flatMap((free) => [boxModelLine(list, asks, free), windowsBoxModelLine(list, asks, free)])), ...tools.map((tool) => JSON.stringify([tool.description, (tool as { promptSnippet?: string }).promptSnippet, (tool as { promptGuidelines?: string[] }).promptGuidelines, tool.parameters]))];
	for (const text of standing) assert(!/libreoffice|soffice/i.test(text), text);
});

console.log(`window program refused smoke: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  failed: ${failure}`);
process.exit(failures.length ? 1 : 0);
