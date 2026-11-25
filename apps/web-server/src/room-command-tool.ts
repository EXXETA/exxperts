import fs from "node:fs";

import { findEnvKeys, getProviders } from "@exxeta/exxperts-ai";
import { AuthStorage, type BashOperations, createBashToolDefinition, createLocalBashOperations, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, findShellConfig, getAgentDir, SettingsManager, type ToolDefinition } from "@exxeta/exxperts-runtime";
import { Type } from "typebox";
import { readCatalogCredentialValues } from "./openai-compatible-gateway-catalog.js";
import { PERSISTENT_ROOM_POWERSHELL_BLOCKED_SENTENCE } from "./persistent-room-shell-missing.js";
import { NotNowCount } from "./room-box/folder-question.js";
import { createOutsideTool, type OutsideToolOptions } from "./room-box/outside-tool.js";
import { type SpillPlace, withPrivateSpill } from "./room-box/spill.js";
import { PLAIN_COMMAND_WRAPPER, PLAIN_POWERSHELL_ARGS, plainPowerShellEnvironment } from "./room-box/windows/command-line.js";
import { WINDOWS_COMMAND_INPUT, WINDOWS_COMMAND_SNIPPET, WINDOWS_COMMAND_TOO_LONG, WINDOWS_READ_SPILL_LINE, windowsCommandDescription } from "./room-box/windows/model-lines.js";
import { systemPowerShell } from "./room-box/windows/windows-places.js";
import { isSharedServer } from "./server-hooks.js";

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

/** The shell a room's commands without protection run in. */
export type PlainShell = { kind: "bash" } | { kind: "powershell"; program: string };

// Windows' own launcher for its Linux part, told by where it lies: no bash to run commands in (scripts/doctor.mjs passes over the same folders).
const LINUX_LAUNCHER = /\\(?:system32|sysnative|syswow64|windowsapps)\\bash\.exe$/i;

/**
 * Which shell, in one place. Bash as always, but on a Windows PC where no bash
 * is found beside Windows' own launcher: Windows PowerShell 5.1 there. The
 * person's own shell path or prefix keeps bash, their failures included. A
 * shared server, whose process gate refuses a lookup's start, and a computer
 * without Windows PowerShell look nothing up.
 */
export function plainShell(): PlainShell {
	if (isSharedServer()) return { kind: "bash" };
	const { shellPath, shellCommandPrefix } = personalShellSettings();
	if (shellPath || shellCommandPrefix) return { kind: "bash" };
	const program = systemPowerShell(process.env);
	if (program === undefined || !fs.existsSync(program)) return { kind: "bash" };
	const bash = findShellConfig();
	return bash !== null && !LINUX_LAUNCHER.test(bash.shell) ? { kind: "bash" } : { kind: "powershell", program };
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

/** Whether the shell a command runs in is there: for bash, the runtime's lookup; PowerShell was there at the bind. */
function shellFound(plain: PlainShell, shellPath: string | undefined): boolean {
	if (plain.kind === "powershell") return true;
	try {
		return findShellConfig(shellPath) !== null;
	} catch {
		return false;
	}
}

/** A command that started nothing: the record of what ran leaves it out. */
class CommandNotStarted extends Error {}

// How Windows refuses a program's start: no right to it, or a company's rule, which has no code of its own in Node.
const START_REFUSED = new Set(["EACCES", "EPERM", "UNKNOWN"]);

/** The plain layer: the person's environment with the token and keys out. On a Mac only the outside tool holds it. `log` gets the error of a start Windows refused. */
function plainCommandOperations(plain: PlainShell, shellPath: string | undefined, log: (raw: string) => void): BashOperations {
	const withoutSecrets = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
		const secrets = appSecretVariables();
		return Object.fromEntries(Object.entries(environment).filter(([name]) => !secrets.has(name.toUpperCase())));
	};
	if (plain.kind === "bash") {
		const local = createLocalBashOperations({ shellPath });
		return { exec: (command, cwd, options) => local.exec(command, cwd, { ...options, env: withoutSecrets(options.env ?? process.env) }) };
	}
	const local = createLocalBashOperations({ shell: { shell: plain.program, args: PLAIN_POWERSHELL_ARGS } });
	return {
		async exec(command, cwd, options) {
			const env = plainPowerShellEnvironment(command, withoutSecrets(options.env ?? process.env));
			if (env === undefined) throw new CommandNotStarted(WINDOWS_COMMAND_TOO_LONG);
			try {
				return await local.exec(PLAIN_COMMAND_WRAPPER, cwd, { ...options, env });
			} catch (error) {
				const { code, message, syscall } = error as NodeJS.ErrnoException;
				if (!syscall?.startsWith("spawn") || !START_REFUSED.has(String(code))) throw error;
				log(message);
				throw new CommandNotStarted(PERSISTENT_ROOM_POWERSHELL_BLOCKED_SENTENCE);
			}
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
 * The command tool where commands run in Windows PowerShell 5.1, in the Windows
 * box or without it: still named `bash`, with PowerShell's texts, and no
 * command prefix: the person's prefix is bash.
 */
function powerShellTool(cwd: string, operations: BashOperations, boxed: boolean): ToolDefinition<any, any> {
	const tool: ToolDefinition<any, any> = createBashToolDefinition(cwd, { operations });
	return {
		...tool,
		description: windowsCommandDescription({ lines: DEFAULT_MAX_LINES, kilobytes: DEFAULT_MAX_BYTES / 1024, timeoutSeconds: 600 }, boxed), // The runtime bash tool's own default.
		promptSnippet: WINDOWS_COMMAND_SNIPPET,
		parameters: Type.Object({ ...tool.parameters.properties, command: Type.String({ description: WINDOWS_COMMAND_INPUT }) }),
	};
}

/** What a session passes where a box runs its commands. */
export interface RoomCommandBox {
	box: CommandBox;
	/** `notNow` is the count the room's asks share; a count of its own when none is given. */
	outside: Omit<OutsideToolOptions, "notStarted" | "shellFound" | "notNow" | "commandsOff" | "besideWindowsBox"> & { notNow?: NotNowCount };
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
 * for a live turn at the computer only. Everywhere else `bash` runs plain, in
 * `plain`: asked once, at the bind, since the tool's text is fixed there too.
 * `log` gets what a refused start of PowerShell said, for the server's log.
 */
export function createRoomCommandTools(cwd: string, boxed?: RoomCommandBox, commandsOff: () => string | null = () => null, plain: PlainShell = plainShell(), log: (raw: string) => void = () => {}): RoomCommandTools {
	const { shellPath, shellCommandPrefix } = personalShellSettings();
	rememberCredentialVariables();
	const notStarted = new Set<string>();
	/** The one way a tool runs its plain layer: a call that started nothing is noted. */
	const noted = (tool: ToolDefinition<any, any>): ToolDefinition<any, any> => ({
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
			} catch (error) {
				if (error instanceof CommandNotStarted) notStarted.add(toolCallId);
				throw error;
			}
		},
	});
	const operations = plainCommandOperations(plain, shellPath, log);
	// The tool is there from the start in a room that may ask for commands, so a yes reaches this answer; until then it runs nothing.
	const gated = (tool: ToolDefinition<any, any>): ToolDefinition<any, any> => ({
		...tool,
		// A command can make or change what the calls beside it read, so a message with one runs its calls in the model's order.
		executionMode: "sequential",
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
		const bash = plain.kind === "powershell" ? powerShellTool(cwd, operations, false) : createBashToolDefinition(cwd, { commandPrefix: shellCommandPrefix, operations });
		return { tools: [gated(noted(bash))], started: (toolCallId) => !notStarted.has(toolCallId), personSpoke: () => {} };
	}
	const windows = boxed.box.kind === "windows";
	const spills = (tool: ToolDefinition<any, any>) => withPrivateSpill(tool, boxed.box, (toolCallId) => notStarted.add(toolCallId), windows ? WINDOWS_READ_SPILL_LINE : undefined);
	const bash = gated(windows ? powerShellTool(cwd, boxed.box.operations(), true) : createBashToolDefinition(cwd, { commandPrefix: shellCommandPrefix, operations: boxed.box.operations() }));
	const outside = createOutsideTool(cwd, operations, { ...boxed.outside, notNow: boxed.outside.notNow ?? new NotNowCount(), notStarted: (toolCallId) => notStarted.add(toolCallId), shellFound: () => shellFound(plain, shellPath), commandsOff, besideWindowsBox: windows ? plain.kind : undefined });
	return {
		tools: [spills(bash), spills(noted(outside.tool))],
		started: (toolCallId) => !notStarted.has(toolCallId),
		personSpoke: outside.personSpoke,
	};
}
