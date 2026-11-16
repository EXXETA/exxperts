// PowerShell's own errors as plain text (room-box/windows/error-text.ts), on
// any computer, fed the blocks a real PC wrote (windows-error-samples.ts).
// Rows: a block alone, after other output, and with output between its line,
// its start, its pieces and its end, passed as it comes; the output cut at
// every place into two chunks, nothing raw passed on meanwhile; entities and
// escapes, other records dropped; pieces that aren't well formed or are too
// long, a block start that isn't well formed and a block that never closes;
// and output with no block.
import { ErrorTextTurner, PIECE_LIMIT } from "../src/room-box/windows/error-text.js";
import { AFTER, AFTER_TEXT, ALONE, ALONE_TEXT, LOCATION, MARKER, RAW } from "./windows-error-samples.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function row(name: string, body: () => void): void {
	try {
		body();
		console.log(`ok: ${name}`);
	} catch (error) {
		console.error(`FAIL: ${name}\n${(error as Error).stack}`);
		process.exit(1);
	}
}

const show = (value: unknown) => JSON.stringify(value);

/** What the turner passes on for each chunk, and at the end. */
function turned(chunks: string[]): string[] {
	const turner = new ErrorTextTurner();
	return [...chunks.map((chunk) => turner.push(chunk)), turner.end()];
}
const whole = (chunks: string[]) => turned(chunks).join("");

const START = ALONE.slice(0, ALONE.indexOf("<S "));
const FIRST = ALONE.slice(START.length, ALONE.indexOf("</S>") + "</S>".length);
const FIRST_TEXT = ALONE_TEXT.slice(0, ALONE_TEXT.indexOf("\r\n") + 2);
const LATER = ALONE.slice(START.length + FIRST.length, -"</Objs>".length);
const LATER_TEXT = ALONE_TEXT.slice(FIRST_TEXT.length);

row("a missing program's block alone is its text", () => {
	const out = whole([MARKER + ALONE]);
	assert(out === ALONE_TEXT, show(out));
});

row("after other output, the output stays and the block is its text, in one chunk or two", () => {
	for (const chunks of [[LOCATION + MARKER + AFTER], [LOCATION, MARKER + AFTER]]) {
		const out = whole(chunks);
		assert(out === LOCATION + AFTER_TEXT, `${chunks.length}: ${show(out)}`);
	}
	// Output that comes between the line and its block passes as it comes.
	const between = turned([MARKER + "after-a-failure\r\n", ALONE]);
	assert(between[0] === "after-a-failure\r\n" && between.join("") === "after-a-failure\r\n" + ALONE_TEXT, show(between));
	// And output after the block passes too.
	assert(whole([MARKER + ALONE + "\r\nnext\r\n"]) === `${ALONE_TEXT}\r\nnext\r\n`, "the output after a block");
});

row("cut into two chunks at every place, the output is the same and nothing raw is passed on meanwhile", () => {
	for (const [raw, text] of [[LOCATION + MARKER + AFTER, LOCATION + AFTER_TEXT], [MARKER + "50%" + ALONE, "50%" + ALONE_TEXT]]) {
		for (let cut = 0; cut <= raw.length; cut++) {
			const parts = turned([raw.slice(0, cut), raw.slice(cut)]);
			assert(parts.join("") === text, `cut at ${cut}: ${show(parts)}`);
			const leaked = parts.find((part) => RAW.test(part));
			assert(leaked === undefined, `cut at ${cut}, raw passed on: ${show(leaked)}`);
		}
	}
});

row("output between the block's start, its pieces and its end passes where it came, as it comes", () => {
	const parts = turned([MARKER + START, "a\r\n", FIRST, "tick\r\n", LATER, "b", "</Objs>", "after\r\n"]);
	assert(show(parts) === show(["", "a\r\n", FIRST_TEXT, "tick\r\n", LATER_TEXT, "b", "", "after\r\n", ""]), show(parts));
	// A piece cut by the output takes it in, and is still its text.
	const cut = FIRST.indexOf(" is not");
	const inside = whole([MARKER + START + FIRST.slice(0, cut), "!", FIRST.slice(cut) + LATER + "</Objs>"]);
	assert(inside === `${FIRST_TEXT.slice(0, cut - "<S S=\"Error\">".length)}!${FIRST_TEXT.slice(cut - "<S S=\"Error\">".length)}${LATER_TEXT}`, show(inside));
});

row("entities and escapes are undone, an empty piece is no text, other records are dropped", () => {
	const block = `<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><S N="Activity">loading</S><Obj N="Inner" RefId="1"><MS /></Obj><Obj N="Empty" RefId="2" /></MS></Obj><S S="Error">a &lt;b&gt; &amp; &quot;c&quot; &#65;&#x42; d_x005F_x000D_e_x0009_f_x000D__x000A_</S><S S="Warning" /><S S="Error">g_x000A_</S></Objs>`;
	for (const chunks of [[MARKER + block], [MARKER + block.slice(0, 150), block.slice(150)]]) {
		const out = whole(chunks);
		assert(out === 'a <b> & "c" AB d_x000D_e\tf\r\ng\n', show(out));
	}
});

row("a piece that isn't well formed or is too long passes as it came, and the pieces around it are their text", () => {
	for (const bad of [
		FIRST.replace("cmdlet, function", "cmdlet & function"),
		FIRST.replace("cmdlet, function", "cmdlet &nbsp; function"),
		FIRST.replace("<S S=\"Error\">", "<S S=Error>"),
		FIRST.replace("<S S=\"Error\">", "<S S=\"Error\" S=\"Warning\">"),
		FIRST.replace("<S S=\"Error\">", "<S S=\"Error\"><!-- a note -->"),
		FIRST.replace("cmdlet, function", "cmdlet, <B>function</B>"),
	]) {
		for (const chunks of [[MARKER + START + bad + LATER + "</Objs>"], [MARKER + START, bad.slice(0, 20), bad.slice(20) + LATER, "</Objs>"]]) {
			const out = whole(chunks);
			assert(out === bad + LATER_TEXT, `${bad}: ${show(out)}`);
		}
	}
	const long = `<S S="Error">${"x".repeat(PIECE_LIMIT)}</S>`;
	const parts = turned([MARKER + START + long.slice(0, 1000), long.slice(1000)]);
	assert(parts.join("") === long && parts[0] === "", `a piece too long: ${parts.map((part) => part.length)}`);
	// The allowed neighbour: under the limit, the same piece is its text.
	assert(whole([MARKER + START + `<S S="Error">${"x".repeat(1000)}</S></Objs>`]) === "x".repeat(1000), "a long piece within the limit");
});

row("a block start that isn't well formed passes as it came with its line; a block that never closes and a line with no block lose only the markup", () => {
	const broken = MARKER + ALONE.replace('Version="1.1.0.1"', "Version=1.1.0.1");
	assert(whole([broken]) === broken, "a block start that isn't well formed");
	assert(whole([MARKER + ALONE.slice(0, -"</Objs>".length)]) === ALONE_TEXT, "a block that never closes");
	// As when the command is stopped after its first error.
	assert(whole([`${MARKER}after-a-failure\r\n`]) === "after-a-failure\r\n", "a line with no block");
});

row("output with no block passes as it came", () => {
	const saved = `<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S>saved with Export-Clixml</S></Objs>\r\n`;
	for (const text of ["plain-text\r\n", "C# notes\r\n#", "#< CLIXML is a header\r\n", saved, `${LOCATION}${saved}`]) {
		for (const chunks of [[text], [text.slice(0, 5), text.slice(5)]]) {
			const out = whole(chunks);
			assert(out === text, `${show(chunks)}: ${show(out)}`);
		}
	}
	// A chunk that ends in what may start the line is held only until the next shows it isn't.
	const parts = turned(["50% #", "1 done\r\n"]);
	assert(parts[0] === "50% " && parts[1] === "#1 done\r\n", show(parts));
});

console.log("windows-error-text-smoke: ok");
