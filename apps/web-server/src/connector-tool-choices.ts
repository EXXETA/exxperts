/**
 * What each connector tool may do, as the person chose it on the connector's
 * page or with Always allow on the question before a call: the one reader and
 * writer of `mcp-tool-choices.json` in the app's agent folder. A choice counts
 * in every room where the connector is on; the room's gate reads it on every
 * call (pi-package/extensions/mcp/room-scope.ts).
 *
 * The file holds only what the person chose: no file, or no entry for a tool,
 * is nothing chosen, and the tool then does what its connector's marks say.
 * A file that is there but can't be read is unknown, never empty: the gate
 * then asks before every tool, nothing is written over it, and the page says
 * so, and why: one written by a newer version of the app, or one it can't
 * read at all. Only the latter can be reset, by the person, which sets it
 * aside under another name and starts again with nothing chosen. A shared
 * server never reads or writes it.
 *
 * Its own file, not the connector's entry: a connector can live in a file
 * other apps share, and its `excludeTools` is part of the saved tool list's
 * identity, so writing there would empty the page's tool list.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateHome } from "../../../pi-package/product-state-paths.js";
import { CONNECTOR_TOOL_CHOICES, type ConnectorToolChoice } from "./room-approval-titles.js";
import { isSharedServer } from "./server-hooks.js";

/**
 * One tool's choice. An Always allow keeps `where`, the connector's pin when
 * it was given, and `readOnly` when the tool was marked read-only then: it
 * counts only while both still hold.
 */
export interface StoredToolChoice {
	choice: ConnectorToolChoice;
	where?: string;
	readOnly?: true;
}

/** A connector's choices, by each tool's own name on the connector. */
export type ConnectorToolChoices = Record<string, StoredToolChoice>;

/** Why the file can't be read: a newer version of the app wrote it (its schemaVersion is above ours), or it can't be read at all. */
export type ToolChoicesUnreadable = "newer" | "cannot-read";

export type ToolChoicesRead = { readable: true; connectors: Record<string, ConnectorToolChoices> } | { readable: false; why: ToolChoicesUnreadable };

/** The file is there and can't be read: nothing is written over it. */
export class ToolChoicesUnreadableError extends Error {
	constructor(readonly why: ToolChoicesUnreadable) {
		super(`the connector tool choices file can't be read (${why})`);
	}
}

const SCHEMA_VERSION = 1;

const NAME_MAX_CHARS = 200;
const PIN = /^[0-9a-f]{64}$/;

/** A tool's or a connector's name as the file keeps it. */
export function isToolChoiceName(name: unknown): name is string {
	return typeof name === "string" && name.length > 0 && name.length <= NAME_MAX_CHARS;
}

export function isConnectorToolChoice(value: unknown): value is ConnectorToolChoice {
	return (CONNECTOR_TOOL_CHOICES as readonly unknown[]).includes(value);
}

/**
 * Where a connector's entry says it is: its address, or the program with its
 * arguments, working folder and settings, whatever selects what runs. The
 * question compares it before and after its answer, and an open room with the
 * entry it connected from.
 */
export function connectorWhere(definition: Record<string, unknown> | undefined): string {
	return JSON.stringify([definition?.url ?? null, definition?.command ?? null, definition?.args ?? null, definition?.cwd ?? null, definition?.env ?? null]);
}

/** The connector's pin: a hash of where it is, never the entry itself, which can hold a key. The page names the connector it showed by it. */
export function connectorPin(definition: Record<string, unknown> | undefined): string {
	return createHash("sha256").update(connectorWhere(definition)).digest("hex");
}

function choicesPath(): string {
	if (!process.env.PI_CODING_AGENT_DIR) process.env.PI_CODING_AGENT_DIR = path.join(stateHome(), ".exxperts", "agent");
	return path.join(process.env.PI_CODING_AGENT_DIR, "mcp-tool-choices.json");
}

/** Sets a record's own key: a tool may be named like an object's own members ("__proto__"), which plain assignment would not keep. */
function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/** One connector's tools read leniently: a malformed entry is nothing chosen for that tool. */
function toolsRead(raw: unknown): ConnectorToolChoices {
	const tools: ConnectorToolChoices = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return tools;
	for (const [tool, entry] of Object.entries(raw as Record<string, unknown>)) {
		const { choice, where, readOnly } = (entry ?? {}) as Record<string, unknown>;
		if (!isToolChoiceName(tool) || !isConnectorToolChoice(choice)) continue;
		setOwn(tools, tool, { choice, ...(choice === "allow" && typeof where === "string" && PIN.test(where) ? { where } : {}), ...(choice === "allow" && readOnly === true ? { readOnly: true as const } : {}) });
	}
	return tools;
}

/** Every connector's choices as the file holds them now. No file is nothing chosen; a file that can't be read or isn't this shape is unreadable. */
export function readConnectorToolChoices(): ToolChoicesRead {
	if (isSharedServer()) return { readable: true, connectors: {} };
	let text: string;
	try {
		text = fs.readFileSync(choicesPath(), "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		return code === "ENOENT" || code === "ENOTDIR" ? { readable: true, connectors: {} } : { readable: false, why: "cannot-read" };
	}
	let raw: any;
	try {
		raw = JSON.parse(text);
	} catch {
		return { readable: false, why: "cannot-read" };
	}
	if (raw && typeof raw === "object" && Number.isInteger(raw.schemaVersion) && raw.schemaVersion > SCHEMA_VERSION) return { readable: false, why: "newer" };
	if (!raw || typeof raw !== "object" || raw.schemaVersion !== SCHEMA_VERSION || !raw.connectors || typeof raw.connectors !== "object" || Array.isArray(raw.connectors)) return { readable: false, why: "cannot-read" };
	const connectors: Record<string, ConnectorToolChoices> = {};
	for (const [connector, entry] of Object.entries(raw.connectors as Record<string, unknown>)) {
		if (!isToolChoiceName(connector)) continue;
		const tools = toolsRead((entry as { tools?: unknown } | null)?.tools);
		if (Object.keys(tools).length > 0) setOwn(connectors, connector, tools);
	}
	return { readable: true, connectors };
}

/** A connector's choices in a readable read, as its own key only: a connector may be named like an object's own members. */
export function connectorChoicesIn(read: Extract<ToolChoicesRead, { readable: true }>, connector: string): ConnectorToolChoices {
	return Object.hasOwn(read.connectors, connector) ? read.connectors[connector] : {};
}

/** A tool's stored choice, or null when nothing is chosen for it. */
export function toolChoiceIn(read: Extract<ToolChoicesRead, { readable: true }>, connector: string, tool: string): StoredToolChoice | null {
	const tools = connectorChoicesIn(read, connector);
	return Object.hasOwn(tools, tool) ? tools[tool] : null;
}

/** A connector's choices as the page reads them: each tool's choice alone. */
export function toolChoicesShown(tools: ConnectorToolChoices): Record<string, ConnectorToolChoice> {
	return Object.fromEntries(Object.entries(tools).map(([tool, stored]) => [tool, stored.choice]));
}

/** Reads, changes one connector's choices and writes, in one synchronous step through a temporary file. The connector's choices before. */
function changeConnector(connector: string, change: (tools: ConnectorToolChoices) => ConnectorToolChoices): ConnectorToolChoices {
	if (isSharedServer()) throw new Error("a shared server keeps no connector tool choices");
	const read = readConnectorToolChoices();
	if (!read.readable) throw new ToolChoicesUnreadableError(read.why);
	const before = connectorChoicesIn(read, connector);
	const after = change({ ...before });
	if (JSON.stringify(after) === JSON.stringify(before)) return before;
	const connectors = { ...read.connectors };
	if (Object.keys(after).length > 0) setOwn(connectors, connector, after);
	else delete connectors[connector];
	const file = choicesPath();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	const shaped = Object.fromEntries(Object.entries(connectors).map(([name, tools]) => [name, { tools }]));
	fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, connectors: shaped }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
	return before;
}

/** Sets or clears (null) the given tools' choices of one connector; the connector's choices after. Throws when the file can't be read. */
export function setConnectorToolChoices(connector: string, changes: Record<string, StoredToolChoice | null>): ConnectorToolChoices {
	let after: ConnectorToolChoices = {};
	changeConnector(connector, (tools) => {
		for (const [tool, choice] of Object.entries(changes)) {
			if (choice) setOwn(tools, tool, choice);
			else delete tools[tool];
		}
		after = tools;
		return tools;
	});
	return after;
}

/**
 * Forgets a connector's choices: all of them when it is removed, so one added
 * later by the name starts clean, or its Always allows when it moved, as they
 * were given for where it was. `undo` puts back what this took. Throws when
 * the file can't be read, so nothing is taken from a file that wasn't read.
 */
export function forgetConnectorToolChoices(connector: string, which: "all" | "allow"): { undo: () => void } {
	if (isSharedServer()) return { undo: () => {} };
	const before = changeConnector(connector, (tools) => (which === "all" ? {} : Object.fromEntries(Object.entries(tools).filter(([, stored]) => stored.choice !== "allow"))));
	return { undo: () => void changeConnector(connector, (tools) => ({ ...tools, ...before })) };
}

/**
 * The person's reset of a file that can't be read: it is set aside beside
 * itself, under a name no file has, never deleted or written over, and the
 * choices start again with nothing chosen. Read again first: a file that can
 * be read now, or one a newer version wrote, is left as it is. What happened.
 */
export function setUnreadableToolChoicesAside(): "set-aside" | "readable" | "newer" {
	if (isSharedServer()) throw new Error("a shared server keeps no connector tool choices");
	const read = readConnectorToolChoices();
	if (read.readable) return "readable";
	if (read.why === "newer") return "newer";
	const file = choicesPath();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	let aside = `${file}.unreadable-${stamp}`;
	for (let n = 2; fs.existsSync(aside); n += 1) aside = `${file}.unreadable-${stamp}-${n}`;
	fs.renameSync(file, aside);
	return "set-aside";
}
