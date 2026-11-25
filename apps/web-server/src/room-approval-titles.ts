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

/** The connector question's first line, for a tool the connector marks neither read-only nor as not destructive. */
export function connectorRiskLine(connector: string): string {
	return `This may change or delete something in ${connector}.`;
}

/** The softer first line, for a tool the connector marks as not destructive and not read-only. */
export function connectorChangeLine(connector: string): string {
	return `This may change something in ${connector}.`;
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

/** The tool a connector question asks to use, by its title and the connector's name as the card shows them; null when the title isn't that question's. */
export function connectorApprovalTool(title: string, connector: string): string | null {
	const end = ` in ${connector}?`;
	return title.startsWith("Use ") && title.endsWith(end) && title.length > 4 + end.length ? title.slice(4, -end.length) : null;
}

/** What a connector's tool may do, as the person sets it on the connector's page: the same in every room where the connector is on. */
export const CONNECTOR_TOOL_CHOICES = ["allow", "ask", "blocked"] as const;
export type ConnectorToolChoice = (typeof CONNECTOR_TOOL_CHOICES)[number];

/** Each choice's words, on the connector's page and, for "allow", as the question's lasting answer. */
export const CONNECTOR_CHOICE_WORDS: Readonly<Record<ConnectorToolChoice, string>> = { allow: "Always allow", ask: "Ask first", blocked: "Blocked" };

/** Under the question where Always allow is offered: how far that answer reaches. */
export function connectorAlwaysAllowLine(tool: string, connector: string): string {
	return `${CONNECTOR_CHOICE_WORDS.allow} lets ${tool} run without asking in every room where ${connector} is on, also when you're away.`;
}

/** A blocked tool's stopped step, by what it asked to use ("Delete project in Asana"). */
export function connectorBlockedLine(use: string): string {
	return `Didn't run: ${use} is blocked. You can change this in Settings, Connectors.`;
}

/** What an old hand-off question asked a specialist to create ("an SVG chart"); null for any other question. */
export function handOffApprovalSubject(title: string): string | null {
	return /^Have a specialist create (.+)\?$/.exec(title)?.[1] ?? null;
}

/** Specialists are switched off: what an old hand-off card, or a change request from a page opened before, says now. */
export const SPECIALISTS_OFF_SENTENCE = "Specialists are switched off, so nothing was started.";
