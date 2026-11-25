/**
 * How a connector's call ended when one of ours ended it: the turn's stop, no
 * sign of life for too long, too long in all, or its connector's removal
 * (connector-close-all.ts). One home for the codes the
 * adapter writes (scripts/patch-mcp-adapter.mjs, patches 15 and 21; patch 15's limits these
 * words name: change the two together), what the model is told
 * (pi-package/extensions/mcp/room-scope.ts) and the line the person reads
 * (apps/web-ui/src/step-lines.ts). No imports: the page reads this file.
 */

export type ConnectorCallEnd = "stopped" | "no_answer" | "too_long" | "removed";

const ENDS: ReadonlySet<string> = new Set<ConnectorCallEnd>(["stopped", "no_answer", "too_long", "removed"]);

/** The end a connector step's details name, or null for a step that ended any other way. */
export function connectorCallEnd(details: unknown): ConnectorCallEnd | null {
	const error = (details as { error?: unknown } | null | undefined)?.error;
	return typeof error === "string" && ENDS.has(error) ? (error as ConnectorCallEnd) : null;
}

/** What the model is told as the step's result. The stop names no cause: Stop, the away limit, a scheduled run's limit and a server stop all end the same signal. */
export const CONNECTOR_CALL_END_RESULTS: Readonly<Record<ConnectorCallEnd, string>> = {
	stopped: "This call was stopped while it was running. The connector was asked to stop and may have done part of the work. Do not run it again unless the person asks.",
	no_answer: "The connector sent nothing for 5 minutes, so the call was stopped. It may have done part of the work. Tell the person; do not repeat it unasked.",
	too_long: "The connector ran for 60 minutes, so the call was stopped. It may have done part of the work. Tell the person; do not repeat it unasked.",
	removed: "The connector was removed while this call ran, so the call was stopped. It may have done part of the work. Tell the person; the connector is no longer available, so do not try it again.",
};

/** The line under the step, by the connector's name as its cards show it. */
export function connectorCallEndLine(end: ConnectorCallEnd, connector: string): string {
	if (end === "stopped") return `Stopped. ${connector} may already have done part of the work.`;
	if (end === "removed") return `${connector} was removed, so this step was stopped. It may already have done part of the work.`;
	if (end === "no_answer") return `${connector} didn't answer for 5 minutes, so this step was stopped. It may already have done part of the work.`;
	return `${connector} took more than an hour, so this step was stopped. It may already have done part of the work.`;
}
