/**
 * Why a room's connector call failed, when the connector or the way to it
 * failed: one home for the codes the room keeps on the step
 * (pi-package/extensions/mcp/room-scope.ts), the line the person reads
 * (apps/web-ui/src/step-lines.ts) and the words the model gets where ours
 * replace the adapter's. A call one of ours ended keeps its own end
 * (connector-call-ends.ts). No imports: the page reads this file.
 */

export type ConnectorCallFailure =
	| "cant-connect"
	| "needs-sign-in"
	| "needs-sign-in-or-key"
	| "not-allowed"
	| "sign-in-expired"
	| "key-refused"
	| "key-not-allowed"
	| "no-permission"
	| "refused"
	| "no-such-tool"
	| "removed"
	| "bad-input"
	| "connector-error"
	| "model-declined";

const FAILURES: ReadonlySet<string> = new Set<ConnectorCallFailure>(["cant-connect", "needs-sign-in", "needs-sign-in-or-key", "not-allowed", "sign-in-expired", "key-refused", "key-not-allowed", "no-permission", "refused", "no-such-tool", "removed", "bad-input", "connector-error", "model-declined"]);

/** The failure a connector step's details name, or null for a step that has none. */
export function connectorCallFailure(details: unknown): ConnectorCallFailure | null {
	const failure = (details as { failure?: unknown } | null | undefined)?.failure;
	return typeof failure === "string" && FAILURES.has(failure) ? (failure as ConnectorCallFailure) : null;
}

/**
 * A 401 or 403 the way to the connector answered a call with, as the adapter
 * keeps it on a failed call: only a status the transport's own error carried,
 * never one in the connector's answer (scripts/patch-mcp-adapter.mjs, patch 25).
 * Null when it kept none.
 */
export function refusalStatus(details: unknown): 401 | 403 | null {
	const status = (details as { httpStatus?: unknown } | null | undefined)?.httpStatus;
	return status === 401 || status === 403 ? status : null;
}

/**
 * What the connector's entry says about its way in, read only on a refusal:
 * whether it carries a key or any header (every header may be a key), whether
 * it signs in through its service, and whether a sign-in is stored for it.
 * Whether each exists, never what it holds.
 */
export interface ConnectorAccessFacts {
	carriesKey: boolean;
	signsIn: boolean;
	signedIn: boolean;
}

/**
 * A refusal, by the connector's own state and the service's answer: "sign-in"
 * where the adapter asks for a sign-in, else the service's 401 or 403. A 401
 * says the key or sign-in didn't work; a 403 that the service knew who asked
 * and said no, which a new key or sign-in may or may not change. One with no
 * key and no sign-in stored may need either, so its words name both.
 */
export function refusalFailure(refusal: "sign-in" | 401 | 403, facts: ConnectorAccessFacts): ConnectorCallFailure {
	if (facts.carriesKey) return refusal === 403 ? "key-not-allowed" : "key-refused";
	if (!facts.signsIn) return "refused";
	if (facts.signedIn) return refusal === 403 ? "no-permission" : "sign-in-expired";
	if (refusal === "sign-in") return "needs-sign-in";
	return refusal === 403 ? "not-allowed" : "needs-sign-in-or-key";
}

/** Where the page that shows the step is: at the computer itself, on a device reaching it remotely, or on a server many people share. */
export type FailureSeenFrom = "computer" | "remote" | "shared";

/** The button that opens the connector's own page from its step. */
export const OPEN_IN_SETTINGS = "Open in Settings";

/** The two parts a connector step opens to. */
export const CONNECTOR_SENT_LABEL = "What the room sent";
export const CONNECTOR_CAME_BACK_LABEL = "What came back";

/**
 * The line a failed connector step shows, by the connector's name as the
 * person knows it, and whether Open in Settings goes with it: only at the
 * computer itself, where its page can check, sign in, reconnect and change
 * the key (apps/web-ui/src/connector-rows.ts, keyRow and signInOffered).
 * Null for a failure that has no line of its own: the step's head says it
 * couldn't, and what came back says why in the connector's words.
 */
export function connectorFailureLine(failure: ConnectorCallFailure, connector: string, seenFrom: FailureSeenFrom): { line: string; opensSettings: boolean } | null {
	const wayOn = (computer: string, remote: string, shared: string) => ({ line: seenFrom === "computer" ? computer : seenFrom === "remote" ? remote : shared, opensSettings: seenFrom === "computer" });
	switch (failure) {
		case "cant-connect":
			return wayOn(`${connector} couldn't be reached. See why on its page in Settings, Connectors.`, `${connector} couldn't be reached. See why on the computer itself, in Settings, Connectors.`, `${connector} couldn't be reached. Your admin can check it.`);
		case "needs-sign-in":
			return wayOn(`${connector} needs you to sign in. Sign in on its page in Settings, Connectors.`, `${connector} needs you to sign in. Sign in on the computer itself, in Settings, Connectors.`, `${connector} needs a sign-in: tell your admin.`);
		case "needs-sign-in-or-key":
			return wayOn(`${connector} needs a sign-in or a key. Set it up on its page in Settings, Connectors, then open the room again.`, `${connector} needs a sign-in or a key. Set it up on the computer itself, in Settings, Connectors, then open the room again.`, `${connector} needs a sign-in or a key: tell your admin.`);
		case "not-allowed":
			return wayOn(`${connector} didn't allow this. If it needs a sign-in or a key, set it up on its page in Settings, Connectors, then open the room again.`, `${connector} didn't allow this. If it needs a sign-in or a key, set it up on the computer itself, in Settings, Connectors, then open the room again.`, `${connector} didn't allow this. Your admin can check it.`);
		// "Expired" would be untrue for a sign-in the service withdrew.
		case "sign-in-expired":
			return wayOn(`${connector}'s sign-in no longer works. Reconnect on its page in Settings, Connectors.`, `${connector}'s sign-in no longer works. Reconnect on the computer itself, in Settings, Connectors.`, `${connector}'s sign-in no longer works. Your admin can check it.`);
		case "key-refused":
			return wayOn(`${connector} turned down its key. Change the key on its page in Settings, Connectors, then open the room again.`, `${connector} turned down its key. Change the key on the computer itself, in Settings, Connectors, then open the room again.`, `${connector} turned down its key. Your admin can check it.`);
		case "key-not-allowed":
			return wayOn(`${connector} didn't allow this with its key. If you have a key that's allowed to, change it on its page in Settings, Connectors, then open the room again.`, `${connector} didn't allow this with its key. If you have a key that's allowed to, change it on the computer itself, in Settings, Connectors, then open the room again.`, `${connector} didn't allow this with its key. Your admin can check it.`);
		case "no-permission":
			return wayOn(`${connector} says your account can't do this. Ask for access there, or sign in with another account on its page in Settings, Connectors.`, `${connector} says your account can't do this. Ask for access there, or sign in with another account on the computer itself, in Settings, Connectors.`, `${connector} says your account can't do this. Your admin can check it.`);
		case "refused":
			return { line: `${connector} turned the connection down.`, opensSettings: false };
		case "no-such-tool":
			return { line: `${connector} has no tool by that name.`, opensSettings: false };
		case "bad-input":
			return { line: `${connector} couldn't take what the assistant sent.`, opensSettings: false };
		case "removed":
			return { line: `${connector} was removed, so the assistant can't use it.`, opensSettings: false };
		case "model-declined":
			return { line: `You said no, so ${connector} didn't get to use this room's model.`, opensSettings: false };
		case "connector-error":
			return null;
	}
}

/** The line for a tool no connector of the room has, by the name the assistant asked for: the step names no connector, so it can't say whose. */
export function unknownToolLine(tool: string): string {
	return `This room has no connector tool called ${tool}.`;
}

/** A 403 is the service's answer to who asked, not a passing fault: the same call gets the same answer. */
const NOT_AGAIN = "Don't try the same call again unless the person changes its sign-in or key.";

/**
 * The words the model gets in place of the adapter's, for the failures where
 * the transport's words would mislead it; null keeps the adapter's, whose
 * search hint and expected parameters help it try again. `named`: the
 * connector as the person knows it with its key beside it ("Toy web (toy-web)").
 * `shared`: a server many people share, where only the admin sets connectors up.
 */
export function connectorFailureModelWords(failure: ConnectorCallFailure, named: string, shared: boolean): string | null {
	const settings = shared ? "the admin of this server can check it" : "they can see why on its page in Settings, Connectors";
	switch (failure) {
		case "cant-connect":
			return `${named} couldn't be reached, so the call didn't run. Tell the person; ${settings}.`;
		case "needs-sign-in":
			return `${named} needs a sign-in before this room can use it. Tell the person; the sign-in happens outside this conversation.`;
		case "needs-sign-in-or-key":
			return `${named} needs a sign-in or a key before this room can use it, so the call didn't run. Tell the person; ${shared ? "the admin of this server can check it" : "they can set one up on its page in Settings, Connectors, and the room must be opened again after that"}.`;
		case "not-allowed":
			return `${named} didn't allow this call, so it didn't run. Tell the person; ${shared ? "the admin of this server can check it" : "if it needs a sign-in or a key, they can set it up on its page in Settings, Connectors, and the room must be opened again after that"}. ${NOT_AGAIN}`;
		case "sign-in-expired":
			return `${named}'s sign-in has expired or was withdrawn, so the call didn't run. Tell the person; ${shared ? "the admin of this server can check it" : "they can reconnect it on its page in Settings, Connectors"}.`;
		case "key-refused":
			return `${named} turned down its key, so the call didn't run. Tell the person; ${shared ? "the admin of this server can check it" : "the key can be changed on its page in Settings, Connectors, and the room must be opened again after that"}.`;
		case "key-not-allowed":
			return `${named} didn't allow this call with its key, so it didn't run. Tell the person; ${shared ? "the admin of this server can check it" : "a key that is allowed to do this can be set on its page in Settings, Connectors, and the room must be opened again after that"}. ${NOT_AGAIN}`;
		case "no-permission":
			return `${named} says the signed-in account isn't allowed to do this, so the call didn't run. Tell the person; ${shared ? "the admin of this server can check it" : "they can ask for access there, or sign in with another account"}. ${NOT_AGAIN}`;
		case "refused":
			return `${named} turned the connection down, so the call didn't run. Tell the person; nothing in this app can change that.`;
		case "removed":
			return `${named} was removed from the connectors, so no room can use it. ${shared ? "Only the admin of this server can add it again." : "It can only be added again in Settings, Connectors."}`;
		case "model-declined":
			return `The person said no to ${named} using this room's model, so the call didn't finish. Don't try it again unless the person asks.`;
		case "no-such-tool":
		case "bad-input":
		case "connector-error":
			return null;
	}
}
