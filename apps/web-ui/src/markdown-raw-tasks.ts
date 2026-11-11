// RAW Markdown: the task button works on the text itself. Every selected
// non-empty line moves on its own: plain or bullet -> "[ ]", "[ ]" -> "[x]",
// "[x]" -> "[ ]". Indentation, the bullet character and the text are kept.

export interface TaskToggleResult {
	value: string;
	selectionStart: number;
	selectionEnd: number;
}

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](?:\s+|$)/;
const BULLET = /^(\s*(?:[-*+]|\d+[.)])\s+)/;

function withMark(prefix: string, mark: string, rest: string): string {
	return rest === "" ? prefix + mark : `${prefix}${mark} ${rest}`;
}

function nextLine(line: string): string {
	const task = TASK.exec(line);
	if (task) return withMark(task[1], task[2] === " " ? "[x]" : "[ ]", line.slice(task[0].length));
	const bullet = BULLET.exec(line);
	if (bullet) return withMark(bullet[1], "[ ]", line.slice(bullet[0].length));
	const indent = /^\s*/.exec(line)?.[0] ?? "";
	return withMark(`${indent}- `, "[ ]", line.slice(indent.length));
}

/** True when the line holding `position` is a task item, open or done. */
export function isTaskLine(value: string, position: number): boolean {
	const start = value.lastIndexOf("\n", position - 1) + 1;
	const end = value.indexOf("\n", position);
	return TASK.test(value.slice(start, end === -1 ? value.length : end));
}

export function cycleTaskLines(value: string, start: number, end: number): TaskToggleResult {
	const from = Math.min(start, end);
	// A selection that only reaches the start of a line does not include that line.
	let to = Math.max(start, end);
	if (to > from && value[to - 1] === "\n") to -= 1;
	const blockStart = value.lastIndexOf("\n", from - 1) + 1;
	const lineEnd = value.indexOf("\n", to);
	const blockEnd = lineEnd === -1 ? value.length : lineEnd;
	const lines = value.slice(blockStart, blockEnd).split("\n");
	if (lines.every((line) => line.trim() === "")) return { value, selectionStart: start, selectionEnd: end };
	const changed = lines.map((line) => (line.trim() === "" ? line : nextLine(line))).join("\n");
	const next = value.slice(0, blockStart) + changed + value.slice(blockEnd);
	if (start === end) {
		const caret = blockStart + changed.length;
		return { value: next, selectionStart: caret, selectionEnd: caret };
	}
	return { value: next, selectionStart: blockStart, selectionEnd: blockStart + changed.length };
}
