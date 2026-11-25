/**
 * What a connector says about one of its tools: its own title and whether it
 * only reads. Read from the live connection by the room's gate on every call,
 * and from the adapter's saved tool list for the Connectors page, which keeps
 * them as the connector gave them (scripts/patch-mcp-adapter.mjs, patch 16).
 * One rule for both, so a tool the page lists as read-only is one the gate
 * lets run without asking.
 */

/** A tool as the protocol gives it, live or saved; anything in it may be missing or of another type. */
export type MarkedTool = { title?: unknown; annotations?: { title?: unknown; readOnlyHint?: unknown; destructiveHint?: unknown } | null } | null | undefined;

/** Read-only and not destructive, in the protocol's own true and false; anything else is unknown, and unknown asks. */
export function marksReadOnly(tool: MarkedTool): boolean {
	const marks = tool?.annotations;
	return marks?.readOnlyHint === true && (marks.destructiveHint === undefined || marks.destructiveHint === false);
}

/** The tool's own title, else the one its marks carry; null when it gives none. */
export function toolOwnTitle(tool: MarkedTool): string | null {
	for (const title of [tool?.title, tool?.annotations?.title]) {
		if (typeof title === "string" && title.trim()) return title.trim();
	}
	return null;
}
