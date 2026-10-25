/**
 * What the person reads on a failed step's card. A tool's refusal is written
 * for the model, which keeps it; the card shows one plain line per known cause,
 * and tells a refusal (the app's rules, the room's settings or the person kept
 * the step from running) from a failure (the step ran and did not work).
 */
import { contentPolicyPlainLine } from "../../../pi-package/extensions/content-policy/words";

/** The step a refusal came from: its tool, what it was asked, and the details the tool sent back. */
type Step = { name?: string; args?: any; details?: any };

type Line = string | ((match: RegExpExecArray, step: Step) => string | null);

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

const CONNECTOR_OFF = "This connector is not on for this room. You can turn it on in Room settings, Connectors.";

// Each pattern is a sentence the tools write (persistent-room-workspace-tools.ts,
// the runtime's file tools, mcp/room-scope.ts, persistent-room-skill-tool.ts,
// persistent-room-shelf-tools.ts, persistent-room-bash-approval.ts, persistent-room-delegate-tool.ts, fetch_url,
// web-search, the message index.ts gives a turn's questions when the person leaves, and
// the one server-stop.ts gives them when exxperts stops);
// a change there must change its match here. The line never repeats the
// label's words: the label already says the step did not happen.
const REFUSED_LINES: Array<[RegExp, Line]> = [
	[/looks like a secret file or the app's own data, so rooms don't open it/, "Blocked: a secret file or the app's own data"],
	[/^Path is blocked by workspace policy\./, "Blocked: a secret file or the app's own data"],
	[/can be read but not changed by rooms/, "Read only: rooms can read this file but not change it"],
	[/which opens to this room only while its terminal \(Bash\) is on/, "Opens to this room only with Bash on (Room settings, Workspace, Edit workspace)"],
	[/which a background run can't open\./, "A run in the background can't open the skills folder."],
	[/rooms can read it only while Bash is on, and never change it\./, "Read only: rooms never change this file."],
	[/^Path is outside the selected workspace\./, "That is outside this room's folder."],
	[/^Connector "[^"]*" is not enabled for this room\./, CONNECTOR_OFF],
	[/^That answer involves a connector that is not enabled for this room\./, CONNECTOR_OFF],
	[/^No MCP connectors are enabled for this room\./, "No connector is on for this room. You can turn one on in Room settings, Connectors."],
	[/^Tool "[^"]*" (?:belongs to a connector that is not enabled for|is not available in) this room\./, CONNECTOR_OFF],
	[/^Skill "[^"]*" is not enabled for this room\./, "This skill is not on for this room. You can turn it on in Room settings, Skills."],
	[/^The user declined this command\./, "You declined this command."],
	[STOPPED_BEFORE_ASKING, "exxperts was stopping, so it could not ask you."],
	[/^File already exists in selected workspace\./, "That file is already there; the room did not overwrite it."],
	// Switched off in AI setup: the tool's own sentence already says where to turn it back on.
	[/^(Web search is switched off in AI setup under Web search\. Turn it back on there to use it\.)/, (match) => match[1]],
	// A room runs one specialist at a time (index.ts), so the count is usually 1.
	[/^The specialist limit \((\d+) at a time\) is reached\./, (match) => (match[1] === "1" ? "1 specialist is already working. Try again when it finishes." : `${match[1]} specialists are already working. Try again when one finishes.`)],
];

const FAILED_LINES: Array<[RegExp, Line]> = [
	// Folder mode names what is missing as Full access does, from the step's own path.
	[/^File not found in selected workspace\./, (_match, step) => (lastName(String(step.args?.path ?? "")) ? `There is no file called ${lastName(String(step.args.path))}.` : null)],
	[/^Path not found in selected workspace\./, (_match, step) => (lastName(String(step.args?.path ?? "")) ? `There is no file or folder called ${lastName(String(step.args.path))}.` : null)],
	[/^Grep pattern is not a valid JavaScript regular expression\./, "That search pattern could not be read."],
	[/^Path not found: (.+)$/, (match) => `There is no file or folder called ${lastName(match[1])}.`],
	[/^ENOENT: no such file or directory, \w+ '([^']*)'/, (match) => `There is no file called ${lastName(match[1])}.`],
	[/^Could not find the exact text in (.+?)\. The old text must match exactly/, (match) => `The text to change was not found in ${match[1]}; nothing was changed.`],
	[/^"([^"]*)" is a native Pi tool\./, (match) => `${match[1]} is one of the room's own tools, not a connector's.`],
	[/^This room has no files\W+(?:so )?there is nothing to search\./, "This room has no files to search."],
	// fetch_url: the model also gets what the site sent back; the card keeps what the site answered.
	[/^Couldn't read page: the site answered ([^\n]*\.)(?:\n|$)/, (match) => `The site answered ${match[1]}`],
	[/^Cannot read "[^"]*" \S+ content type "application\/pdf" is not textual/, "It is a PDF file."],
	[/^Cannot read "[^"]*" \S+ content type "[^"]*" is not textual/, "It is a file, not a page of text."],
	[/^Fetch failed: Request to \S+ failed: fetch failed/, "Nothing answered at that address."],
	[/^"([^"]*)" is not a specialist template\./, (match) => `No specialist called "${match[1]}" in this room.`],
];

/** What a failed step's card says: its plain line, and whether the step was refused rather than failed. Null when the result has no known cause. `sharedServer`: the page is on a server many people share. */
export function stepOutcome(result: string, step: Step = {}, sharedServer = false): { line: string; refused: boolean } | null {
	const policy = contentPolicyPlainLine(result);
	if (policy) return { line: policy, refused: true };
	if (nobodyToApprove(result)) {
		const line = step.name === "delegate_task" ? "Nobody was there to approve it, so nothing was handed off." : step.name === "bash" ? "Nobody was there to approve it, so the command did not run." : "Nobody was there to approve it.";
		return { line, refused: true };
	}
	// The connector adapter's sign-in refusals vary in wording; its error code does not.
	// On a shared server only the admin can sign a connector in.
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

/** A command the person declined on its card, by the reason the approval guard writes. */
export function commandDeclined(result: string | undefined): boolean {
	return typeof result === "string" && result.startsWith("The user declined this command.");
}

/** A step that asked for approval while nobody was there to give it: the room's away answer, or a hand-off or a command asked with no page to ask on. */
export function nobodyToApprove(result: string | undefined): boolean {
	return typeof result === "string" && (result.startsWith("The user left the room while this response was being written") || result.startsWith("Delegation requires the interactive room UI; there is no user here to approve it.") || result.startsWith("Running commands requires the interactive room UI; there is no user here to approve them."));
}

/** A step whose question exxperts declined because it was stopping. */
export function stoppedBeforeAsking(result: string | undefined): boolean {
	return typeof result === "string" && STOPPED_BEFORE_ASKING.test(result);
}

/** A command ended by Stop: the shell tool ends its result with this line. */
export function commandAborted(result: string | undefined): boolean {
	return typeof result === "string" && /(?:^|\n\n)Command aborted$/.test(result);
}
