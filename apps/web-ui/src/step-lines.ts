/**
 * What the person reads on a failed step's card. A tool's refusal is written
 * for the model, which keeps it; the card shows one plain line per known cause,
 * and tells a refusal (the app's rules, the room's settings or the person kept
 * the step from running) from a failure (the step ran and did not work).
 */
import { contentPolicyPlainLine } from "../../../pi-package/extensions/content-policy/words";
import { STOPPED_BEFORE_ANSWER_SENTENCE } from "../../web-server/src/turn-ended-by";
import { BOX_FAULT_SENTENCE, NOBODY_TO_OPEN_PAGE, PAGE_DECLINED, RUN_OUTSIDE_BOX_TOOL_NAME } from "../../web-server/src/room-box/card-text";
import { connectorApprovalTitle, connectorBlockedLine } from "../../web-server/src/room-approval-titles";
import { connectorAwayNote, declinedQuestionNoteText } from "../../web-server/src/thread-items-by-id";
import { connectorCallEnd, connectorCallEndLine } from "../../web-server/src/connector-call-ends";
import { connectorCallFailure, connectorFailureLine, unknownToolLine } from "../../web-server/src/connector-call-failures";

/** The step a refusal came from: its tool, what it was asked, and the details the tool sent back. */
type Step = { name?: string; args?: any; details?: any };

// The connector gate's answers when a call did not run (mcp/room-scope.ts): the person's No, and a card nobody
// could answer, which ends with what the model must do; a change there must change its match here.
const CONNECTOR_DECLINED = /^(You declined this, so nothing changed in .+?\.)(?: |$)/;
const CONNECTOR_UNANSWERED = / Nothing was sent to (.+?)\. Leave this undone and say so\.$/;

type Line = string | ((match: RegExpExecArray, step: Step) => string | null);

/** Whether a step ran a command, in the room's box or outside it: both read and fold the same way. */
export function isCommandStep(name: string | undefined): boolean {
	return name === "bash" || name === RUN_OUTSIDE_BOX_TOOL_NAME;
}

/** The last part of a path, a file or a folder name, on either separator: the one reading for the step cards. */
export function lastName(path: string): string {
	return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** A tool's internal name in readable words, "open_browser" as "Open browser": the card never shows the raw name. */
export function readableToolName(name: string): string {
	const words = name.replace(/_/g, " ").trim() || "Tool";
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

// The runtime's answer when the model asks for a tool the room does not have:
// the step's label says it ("No such tool"), so it has no line of its own.
const NO_SUCH_TOOL = /^Tool (\S+) not found$/;

// The stop's answer to a turn's questions: STOP_QUESTIONS_SENTENCE in server-stop.ts.
const STOPPED_BEFORE_ASKING = /^exxperts is stopping, so questions cannot be answered now\./;

// The answer the person's Stop gives a turn's open question.
const STOPPED_BEFORE_ANSWER = new RegExp(`^${STOPPED_BEFORE_ANSWER_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

const CONNECTOR_OFF = "This connector is not on for this room. You can turn it on in Room settings, Connectors.";

/** The skills folder's line while the room's commands are off. */
export const SKILLS_FOLDER_COMMANDS_OFF_LINE = "Opens to this room only while Commands is on (Room settings, Folder).";

// Each pattern is a sentence the tools write (persistent-room-workspace-tools.ts,
// the runtime's file tools, mcp/room-scope.ts, persistent-room-skill-tool.ts,
// persistent-room-shelf-tools.ts, persistent-room-bash-approval.ts, fetch_url,
// web-search, the message room-socket.ts gives a turn's questions when the person leaves, and
// the one server-stop.ts gives them when exxperts stops, and the one turn-ended-by.ts gives
// them when the person presses Stop);
// a change there must change its match here. The specialist hand-off's sentences
// stay matched for old conversations, though no tool writes them now. The line never repeats the
// label's words: the label already says the step did not happen.
const REFUSED_LINES: Array<[RegExp, Line]> = [
	[/looks like a secret file or the app's own data, so rooms don't open it/, "Blocked: a secret file or the app's own data"],
	// The running answer's own temp lies in the app's data: its card says what a closed path's says.
	[/is in this answer's temporary folder, which only commands can open\./, "Blocked: a secret file or the app's own data"],
	[/^Path is blocked by workspace policy\./, "Blocked: a secret file or the app's own data"],
	[/can be read but not changed by rooms/, "Read only: rooms can read this file but not change it"],
	[/which opens to this room only while its terminal \(Bash\) is on/, SKILLS_FOLDER_COMMANDS_OFF_LINE],
	[/which a background run can't open\./, "A run in the background can't open the skills folder."],
	[/is in the app's skills folder\. A room can't change a skill's folder/, "A room can't change a skill's files, and reads only the skills that are on in it."],
	[/rooms can read it only while Bash is on, and never change it\./, "Read only: rooms never change this file."],
	[/^Path is outside the selected workspace\./, "That is outside this room's folder."],
	[/^Connector ".*" is not enabled for this room\./, CONNECTOR_OFF],
	[/^That answer involves a connector that is not enabled for this room\./, CONNECTOR_OFF],
	[/^No MCP connectors are enabled for this room\./, "No connector is on for this room. You can turn one on in Room settings, Connectors."],
	[/^Tool "[^"]*" (?:belongs to a connector that is not enabled for|is not available in) this room\./, CONNECTOR_OFF],
	[/^Skill "[^"]*" is not enabled for this room\./, "This skill is not on for this room. You can turn it on in Room settings, Skills."],
	[/^The user declined this command\./, "You declined this command."],
	[STOPPED_BEFORE_ASKING, "exxperts was stopping, so it could not ask you."],
	[STOPPED_BEFORE_ANSWER, "You pressed Stop before answering."],
	[/^File already exists in selected workspace\./, "That file is already there; the room did not overwrite it."],
	// Switched off in AI setup, or off on a shared server: the tool's own sentence already says who turns it back on, and where.
	[/^(Web search is switched off in AI setup under Web search\. Turn it back on there to use it\.|Web search is off on this server\. Your admin can turn it on under Web search\.)/, (match) => match[1]],
	// A room runs one specialist at a time (room-socket.ts), so the count is usually 1.
	[/^The specialist limit \((\d+) at a time\) is reached\./, (match) => (match[1] === "1" ? "1 specialist is already working. Try again when it finishes." : `${match[1]} specialists are already working. Try again when one finishes.`)],
];

// The runtime's check of what the assistant sent against the tool's description, before the tool starts (runtime/packages/ai/src/utils/validation.ts).
const RUNTIME_INPUT_REFUSAL = /^Validation failed for tool "/;

/** Whether the runtime refused what the assistant sent before the tool started: its text is the model's, and the step's line says it. */
export function inputRefusedByRuntime(result: unknown): boolean {
	return typeof result === "string" && RUNTIME_INPUT_REFUSAL.test(result);
}

const FAILED_LINES: Array<[RegExp, Line]> = [
	// Folder mode names what is missing as Full access does, from the step's own path.
	[/^File not found in selected workspace\./, (_match, step) => (lastName(String(step.args?.path ?? "")) ? `There is no file called ${lastName(String(step.args.path))}.` : null)],
	[/^Path not found in selected workspace\./, (_match, step) => (lastName(String(step.args?.path ?? "")) ? `There is no file or folder called ${lastName(String(step.args.path))}.` : null)],
	[/^Grep pattern is not a valid JavaScript regular expression\./, "That search pattern could not be read."],
	[/^Path not found: (.+)$/, (match) => `There is no file or folder called ${lastName(match[1])}.`],
	[/^ENOENT: no such file or directory, \w+ '([^']*)'/, (match) => `There is no file called ${lastName(match[1])}.`],
	[/^Could not find the exact text in (.+?)\. The old text must match exactly/, (match) => `The text to change was not found in ${match[1]}; nothing was changed.`],
	[/^"([^"]*)" is a native Pi tool\./, (match) => `${match[1]} is one of the room's own tools, not a connector's.`],
	[RUNTIME_INPUT_REFUSAL, "The assistant sent something this tool couldn't use, so nothing ran."],
	[/^This room has no files\W+(?:so )?there is nothing to search\./, "This room has no files to search."],
	// fetch_url: the model also gets what the site sent back; the card keeps what the site answered.
	[/^Couldn't read page: the site answered ([^\n]*\.)(?:\n|$)/, (match) => `The site answered ${match[1]}`],
	[/^Cannot read "[^"]*" \S+ content type "application\/pdf" is not textual/, "It is a PDF file."],
	[/^Cannot read "[^"]*" \S+ content type "[^"]*" is not textual/, "It is a file, not a page of text."],
	[/^Fetch failed: Request to \S+ failed: fetch failed/, "Nothing answered at that address."],
	[/^"([^"]*)" is not a specialist template\./, (match) => `No specialist called "${match[1]}" in this room.`],
];

/**
 * A connector call that did not run because the person blocked the tool, said no or nobody was there to: the
 * line its row says, the blocked line by the gate's code, the gate's own first sentence for a No, the away
 * note's for a card nobody answered. Null for any other step, a card Stop answered among them.
 */
export function connectorNotRunLine(step: Step & { result?: unknown }): string | null {
	const result = step.result;
	if ((step.name !== "mcp" && typeof step.details?.connectorId !== "string") || typeof result !== "string") return null;
	// A tool the person blocked on its connector's page, by what its card would have asked to use.
	if (step.details?.error === "connector_tool_blocked" && typeof step.details.use === "string" && step.details.use) return connectorBlockedLine(step.details.use);
	const declined = CONNECTOR_DECLINED.exec(result);
	if (declined) return declined[1];
	const connector = CONNECTOR_UNANSWERED.exec(result)?.[1];
	if (!connector || stoppedBeforeAsking(result) || stoppedBeforeAnswer(result)) return null;
	// What the card asked to use, as the gate keeps it with the refusal.
	if (typeof step.details?.use === "string" && step.details.use) return connectorAwayNote(step.details.use);
	// A step saved before the gate kept it: the tool's words rebuilt, without the connector's prefix the room calls it by.
	const tool = String(step.args?.tool ?? "");
	const server = String(step.details?.server ?? "");
	const prefix = `${server.replace(/-/g, "_")}_`;
	return declinedQuestionNoteText(connectorApprovalTitle(readableToolName(server && tool.startsWith(prefix) ? tool.slice(prefix.length) : tool), connector));
}

/**
 * A connector call the answer's stop or a time limit ended: its line, by the
 * connector's name the room kept with it (mcp/room-scope.ts). The step's result
 * is what the model was told, so the card shows this line in its place. Null
 * for any other step.
 */
export function connectorCallEndedLine(step: Step): string | null {
	const end = connectorCallEnd(step.details);
	const connector = step.details?.connector;
	return end && typeof connector === "string" && connector ? connectorCallEndLine(end, connector) : null;
}

/** A connector call the person kept from running (their No to it using the room's model): not run, never failed. */
export function connectorCallRefused(step: Step): boolean {
	return connectorCallFailure(step.details) === "model-declined";
}

/**
 * A connector call that failed for a reason the room kept with it
 * (connector-call-failures.ts): its line by the connector's name, and the
 * connector whose own page its Open in Settings opens, only at the computer
 * itself. A No to the connector's use of the room's model reads as a refusal.
 * Null for any other step, and for a failure with no line of its own.
 */
export function connectorFailedLine(step: Step, sharedServer = false, remote = false): { line: string; refused: boolean; opensConnector?: string } | null {
	const failure = connectorCallFailure(step.details);
	const connector = step.details?.connector;
	// A tool no connector of the room has: the name the assistant asked for, in place of the search hint meant for it.
	const asked = step.details?.requestedTool;
	if (failure === "no-such-tool" && !connector && typeof asked === "string" && asked) return { line: unknownToolLine(asked), refused: false };
	if (!failure || typeof connector !== "string" || !connector) return null;
	const said = connectorFailureLine(failure, connector, sharedServer ? "shared" : remote ? "remote" : "computer");
	if (!said) return null;
	const id = step.details?.connectorId;
	return { line: said.line, refused: connectorCallRefused(step), ...(said.opensSettings && typeof id === "string" && id ? { opensConnector: id } : {}) };
}

/** What a failed step's card says: its plain line, whether the step was refused rather than failed, and a connector whose page its line opens. Null when the result has no known cause. `sharedServer`: the page is on a server many people share; `remote`: a device reaching the computer remotely. */
export function stepOutcome(result: string, step: Step = {}, sharedServer = false, remote = false): { line: string; refused: boolean; opensConnector?: string } | null {
	const policy = contentPolicyPlainLine(result);
	if (policy) return { line: policy, refused: true };
	const connectorNotRun = connectorNotRunLine({ ...step, result });
	if (connectorNotRun) return { line: connectorNotRun, refused: true };
	if (boxFault({ ...step, result })) return { line: BOX_FAULT_SENTENCE, refused: false };
	if (nobodyToApprove(result)) {
		const line = step.name === "delegate_task" ? "Nobody was there to approve it, so nothing was handed off." : isCommandStep(step.name) ? "Nobody was there to approve it, so the command did not run." : "Nobody was there to approve it.";
		return { line, refused: true };
	}
	const callEnded = connectorCallEndedLine(step);
	if (callEnded) return { line: callEnded, refused: false };
	const connectorFailed = connectorFailedLine(step, sharedServer, remote);
	if (connectorFailed) return connectorFailed;
	// The connector adapter's sign-in refusals vary in wording; its error code does not.
	// On a shared server connector sign-ins are off, so the person is sent to the admin.
	if (step.details?.error === "auth_required") return { line: sharedServer ? "This connector needs a sign-in: tell your admin." : "This connector needs you to sign in: Settings, Connectors.", refused: false };
	for (const [lines, refused] of [[REFUSED_LINES, true], [FAILED_LINES, false]] as const) {
		for (const [pattern, line] of lines) {
			const match = pattern.exec(result);
			if (!match) continue;
			const said = typeof line === "string" ? line : line(match, step);
			return said ? { line: said, refused } : null;
		}
	}
	return null;
}

/** The plain line for a failed step's result, or null when the result has no known cause. */
export function stepPlainLine(result: string, step: Step = {}, sharedServer = false): string | null {
	return stepOutcome(result, step, sharedServer)?.line ?? null;
}

/** The tool a step asked for that the room does not have, by its internal name; null for any other result. */
export function missingToolName(result: string | undefined): string | null {
	return typeof result === "string" ? (NO_SUCH_TOOL.exec(result)?.[1] ?? null) : null;
}

/** Why the web reader didn't open a page: the person said no on its card, or nobody was there to answer it. Null for any other step. */
export function pageNotOpened(step: Step & { status?: string; result?: unknown }): "declined" | "nobody" | null {
	if (step.name !== "fetch_url" || step.status !== "error" || typeof step.result !== "string") return null;
	if (step.result.startsWith(PAGE_DECLINED)) return "declined";
	if (step.result.startsWith(NOBODY_TO_OPEN_PAGE)) return "nobody";
	return null;
}

/** A command the person declined on its card, by the reason the approval guard writes. */
export function commandDeclined(result: string | undefined): boolean {
	return typeof result === "string" && result.startsWith("The user declined this command.");
}

/** A command that never ran because the room's box didn't start. The whole result, on a failed command: a file or a command's output can quote the sentence. */
export function boxFault(step: Step & { status?: string; result?: unknown }): boolean {
	return isCommandStep(step.name) && step.status === "error" && step.result === BOX_FAULT_SENTENCE;
}

/** A step that asked for approval while nobody was there to give it: the room's away answer, or a hand-off or a command asked with no page to ask on. */
export function nobodyToApprove(result: string | undefined): boolean {
	return typeof result === "string" && (result.startsWith("The user left the room while this response was being written") || result.startsWith("Delegation requires the interactive room UI; there is no user here to approve it.") || result.startsWith("Running commands requires the interactive room UI; there is no user here to approve them."));
}

/** A step whose question exxperts declined because it was stopping. */
export function stoppedBeforeAsking(result: string | undefined): boolean {
	return typeof result === "string" && STOPPED_BEFORE_ASKING.test(result);
}

/** A step whose question the person's Stop answered: it did not happen. */
export function stoppedBeforeAnswer(result: string | undefined): boolean {
	return typeof result === "string" && result.startsWith(STOPPED_BEFORE_ANSWER_SENTENCE);
}

/** A command ended by Stop: the shell tool ends its result with this line. */
export function commandAborted(result: string | undefined): boolean {
	return typeof result === "string" && /(?:^|\n\n)Command aborted$/.test(result);
}
