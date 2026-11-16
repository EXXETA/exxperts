/**
 * The questions a room asks the person before it acts, read back by the away
 * note and by the card's resolved line. No imports: the page reads this file.
 */

/** The command approval card's title. */
export const PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE = "Run this command?";

/** A connector tool's approval card title. */
export function connectorApprovalTitle(tool: string, connector: string): string {
	return `Use ${tool} in ${connector}?`;
}

/** What a connector tool's card asked to use ("Delete project in Asana"); null for any other question. */
export function connectorApprovalSubject(title: string): string | null {
	return /^Use (.+ in .+)\?$/.exec(title)?.[1] ?? null;
}

/** The connector question's first line, for a tool the connector doesn't mark read-only. */
export function connectorRiskLine(connector: string): string {
	return `This may change or delete something in ${connector}.`;
}

/** Over what the room would send, which the room wrote itself; `cut`: how many characters at its end aren't shown, said here because the answers work without scrolling to the end. */
export function connectorSentLabel(cut: number): string {
	const label = "What the room would send. It wrote this itself, and the app hasn't checked it.";
	return cut > 0 ? `${label} ${cut.toLocaleString("en-US")} characters cut at the end.` : label;
}

/** Under what the room would send, where its end was cut. */
export function connectorCutLine(cut: number): string {
	return `Cut here: ${cut.toLocaleString("en-US")} more characters aren't shown.`;
}

/** Under the question where Allow for this room is offered, by that answer's label and what it asks to use ("Create task in Asana"). */
export function connectorAllowRoomLine(answer: string, use: string): string {
	return `${answer}: it can then use ${use} without asking, also when you're away.`;
}

/** What an old hand-off question asked a specialist to create ("an SVG chart"); null for any other question. */
export function handOffApprovalSubject(title: string): string | null {
	return /^Have a specialist create (.+)\?$/.exec(title)?.[1] ?? null;
}

/** Specialists are switched off: what an old hand-off card, or a change request from a page opened before, says now. */
export const SPECIALISTS_OFF_SENTENCE = "Specialists are switched off, so nothing was started.";
