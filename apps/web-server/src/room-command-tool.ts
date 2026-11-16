import { findEnvKeys, getProviders } from "@exxeta/exxperts-ai";
import { AuthStorage, type BashOperations, createBashToolDefinition, createLocalBashOperations, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, findShellConfig, getAgentDir, SettingsManager, type ToolDefinition } from "@exxeta/exxperts-runtime";
import { Type } from "typebox";
import { readCatalogCredentialValues } from "./openai-compatible-gateway-catalog.js";
import { NotNowCount } from "./room-box/folder-question.js";
import { createOutsideTool, type OutsideToolOptions } from "./room-box/outside-tool.js";
import { type SpillPlace, withPrivateSpill } from "./room-box/spill.js";
import { WINDOWS_COMMAND_INPUT, WINDOWS_COMMAND_SNIPPET, WINDOWS_READ_SPILL_LINE, windowsCommandDescription } from "./room-box/windows/model-lines.js";

// Secrets no provider table lists: the app's sign-in token, which lets a
// command call the app's own port, and the Bedrock key the runtime reads
// beside its table.
const APP_SECRET_VARIABLES = ["EXXPERTS_AUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"];

// In the provider table, but they are the tokens of a person's own tools, such
// as gh, so commands keep them; the sandbox's allow list settles them later.
const PERSONAL_TOOL_TOKENS = new Set(["GH_TOKEN", "GITHUB_TOKEN", "HF_TOKEN"]);

/**
 * The shell and the command prefix a room's commands run with: the person's
 * global settings only. A folder's settings.json can name them too, but a
 * folder may be someone else's download, and every command would go through
 * a program it chose, or carry a line the approval card never shows.
 */
export function personalShellSettings(): { shellPath?: string; shellCommandPrefix?: string } {
	const agentDir = getAgentDir();
	const { shellPath, shellCommandPrefix } = SettingsManager.create(agentDir, agentDir).getGlobalSettings();
	return { shellPath, shellCommandPrefix };
}

// Every variable models.json and auth.json have named since the server
// started; the names only, never a key. A session signs in with what it read
// when it was bound, whatever the files say later, so a file that changes or
// stops parsing frees nothing: only a restart drops a name.
const credentialVariables = new Set<string>();

function rememberCredentialVariables(): void {
	const stored = Object.values(AuthStorage.create().getAll()).flatMap((credential) => (credential.type === "api_key" ? [credential.key] : []));
	for (const value of [...readCatalogCredentialValues(), ...stored]) {
		if (process.env[value]) credentialVariables.add(value);
	}
}

/**
 * The variables that hold a secret of the app's, upper-cased: Windows ignores
 * a variable name's case. The runtime's own table answers for each provider
 * by the names set right now, and a credential in models.json or auth.json
 * can name a variable too, read again here so a key saved after a session was
 * bound counts from the next command. AWS access keys and the like stay: the
 * runtime calls them ambient, and they are the person's own.
 */
function appSecretVariables(): Set<string> {
	rememberCredentialVariables();
	const tableNames = getProviders().flatMap((provider) => findEnvKeys(provider) ?? []).filter((name) => !PERSONAL_TOOL_TOKENS.has(name));
	const names = [...APP_SECRET_VARIABLES, ...tableNames, ...credentialVariables];
	return new Set(names.map((name) => name.toUpperCase()));
}

/** The plain layer: the person's environment with the token and keys out. On a Mac only the outside tool holds it. */
function shellFound(shellPath: string | undefined): boolean {
	try {
		return findShellConfig(shellPath) !== null;
	} catch {
		return false;
	}
}

function plainCommandOperations(shellPath: string | undefined): BashOperations {
	const local = createLocalBashOperations({ shellPath });
	return {
		exec(command, cwd, options) {
			const secrets = appSecretVariables();
			const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([name]) => !secrets.has(name.toUpperCase())));
			return local.exec(command, cwd, { ...options, env });
		},
	};
}

/** A box a room's commands run in: the Mac's (RoomBox, room-box/box-session.ts) or Windows' (WindowsRoomBox, room-box/windows/windows-engine.ts). */
export interface CommandBox extends SpillPlace {
	operations(): BashOperations;
	/** The Windows box runs commands in Windows PowerShell 5.1; the Mac's box, which has none, runs them in bash. */
	readonly kind?: "windows";
}

/**
 * The command tool for the Windows box: still named `bash`, with the texts of
 * Windows PowerShell 5.1, and no command prefix: the person's prefix is bash.
 */
function powerShellTool(cwd: string, operations: BashOperations): ToolDefinition<any, any> {
	const tool: ToolDefinition<any, any> = createBashToolDefinition(cwd, { operations });
	return {
		...tool,
		description: windowsCommandDescription({ lines: DEFAULT_MAX_LINES, kilobytes: DEFAULT_MAX_BYTES / 1024, timeoutSeconds: 600 }), // The runtime bash tool's own default.
		promptSnippet: WINDOWS_COMMAND_SNIPPET,
		parameters: Type.Object({ ...tool.parameters.properties, command: Type.String({ description: WINDOWS_COMMAND_INPUT }) }),
	};
}

/** What a session passes where a box runs its commands. */
export interface RoomCommandBox {
	box: CommandBox;
	/** `notNow` is the count the room's asks share; a count of its own when none is given. */
	outside: Omit<OutsideToolOptions, "notStarted" | "shellFound" | "notNow" | "commandsOff"> & { notNow?: NotNowCount };
}

export interface RoomCommandTools {
	tools: ToolDefinition<any, any>[];
	/** Whether a call reached the point of running something, for the record of what ran. */
	started: (toolCallId: string) => boolean;
	/** The person wrote: the outside tool's Decline counts begin again. */
	personSpoke: () => void;
}

/**
 * A room's command tools. A customTools entry replaces the built-in of the same
 * name, which reads a folder's settings and hands a command the whole
 * environment. Offered only where the session's tool list has them. On a
 * person's Mac `bash` runs in the box; `run_outside_box` is the separate way out,
 * for a live turn at the computer only. Everywhere else `bash` runs plain.
 */
export function createRoomCommandTools(cwd: string, boxed?: RoomCommandBox, commandsOff: () => string | null = () => null): RoomCommandTools {
	const { shellPath, shellCommandPrefix } = personalShellSettings();
	rememberCredentialVariables();
	const notStarted = new Set<string>();
	// The tool is there from the start in a room that may ask for commands, so a yes reaches this answer; until then it runs nothing.
	const gated = (tool: ToolDefinition<any, any>): ToolDefinition<any, any> => ({
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const off = commandsOff();
			if (off) {
				notStarted.add(toolCallId);
				throw new Error(off);
			}
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
	if (!boxed) {
		return { tools: [gated(createBashToolDefinition(cwd, { commandPrefix: shellCommandPrefix, operations: plainCommandOperations(shellPath) }))], started: (toolCallId) => !notStarted.has(toolCallId), personSpoke: () => {} };
	}
	const windows = boxed.box.kind === "windows";
	const spills = (tool: ToolDefinition<any, any>) => withPrivateSpill(tool, boxed.box, (toolCallId) => notStarted.add(toolCallId), windows ? WINDOWS_READ_SPILL_LINE : undefined);
	const bash = gated(windows ? powerShellTool(cwd, boxed.box.operations()) : createBashToolDefinition(cwd, { commandPrefix: shellCommandPrefix, operations: boxed.box.operations() }));
	const outside = createOutsideTool(cwd, plainCommandOperations(shellPath), { ...boxed.outside, notNow: boxed.outside.notNow ?? new NotNowCount(), notStarted: (toolCallId) => notStarted.add(toolCallId), shellFound: () => shellFound(shellPath), commandsOff, besideWindowsBox: windows });
	return {
		tools: [spills(bash), spills(outside.tool)],
		started: (toolCallId) => !notStarted.has(toolCallId),
		personSpoke: outside.personSpoke,
	};
}
