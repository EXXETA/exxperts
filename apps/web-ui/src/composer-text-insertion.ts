export function insertTextAtSelection(
	value: string,
	text: string,
	selectionStart: number,
	selectionEnd: number,
): { value: string; caret: number } {
	const start = Math.max(0, Math.min(value.length, selectionStart));
	const end = Math.max(start, Math.min(value.length, selectionEnd));
	return {
		value: value.slice(0, start) + text + value.slice(end),
		caret: start + text.length,
	};
}
