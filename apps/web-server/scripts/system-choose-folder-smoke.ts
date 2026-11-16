import childProcess from "node:child_process";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";

import type { LocalFolderPickerRunner } from "../src/local-folder-picker.js";
import { SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// The route's rows start the computer's window through execFile: a stand-in holds each start open until the row answers it, as a person would, and closes it on its signal as execFile does.
type WindowStart = { program: string; timeout: unknown; signal: AbortSignal | undefined; answer: (stdout: string) => void };
const windowStarts: WindowStart[] = [];
const realExecFile = childProcess.execFile;
(childProcess as any).execFile = (command: string, args: readonly string[], options: { timeout?: unknown; signal?: AbortSignal } | undefined, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
	const program = command.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
	if (!["osascript", "zenity", "powershell.exe"].includes(program)) return (realExecFile as any)(command, args, options, callback);
	let done = false;
	const finish = (error: Error | null, stdout: string) => {
		if (done) return;
		done = true;
		setImmediate(() => callback(error, stdout, ""));
	};
	options?.signal?.addEventListener("abort", () => finish(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }), ""), { once: true });
	windowStarts.push({ program, timeout: options?.timeout, signal: options?.signal, answer: (stdout) => finish(null, stdout) });
	return { kill() {}, on() {} } as any;
};
syncBuiltinESMExports();
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV);
const { chooseLocalFolder, chooseMacosFolder, folderPickerPrompt } = await import("../src/local-folder-picker.js");
const { app } = await import("../src/server-app.js");
await import("../src/room-routes.js");
app.log.level = "silent";
// What the server writes to its log, read where it is written: after the level is set, which replaces the methods.
const logged: string[] = [];
app.log.warn = ((...parts: unknown[]) => {
	logged.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
}) as typeof app.log.warn;
const waitUntil = waitEvery(50, 10_000);
const failedRows: string[] = [];
/** One row of the new rules: a failure is named and the next row still runs. */
async function row(name: string, body: () => Promise<void>): Promise<void> {
	try {
		await body();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failedRows.push(name);
		console.log(`  FAIL ${name}: ${(error as Error).message}`);
	}
}

/**
 * Reads a script's quotes and brackets as its language does: a string runs to
 * its closing quote (PowerShell doubles a quote inside one, C# escapes with a
 * backslash), and every bracket outside strings closes in order. False for one
 * unclosed quote or stray bracket.
 */
function balanced(text: string, quote: "'" | '"'): boolean {
	const opens: string[] = [];
	const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (quote === '"' && ch === "\\") i++;
			else if (ch === quote && quote === "'" && text[i + 1] === "'") i++;
			else if (ch === quote) inString = false;
			continue;
		}
		if (ch === quote) inString = true;
		else if ("({[".includes(ch)) opens.push(ch);
		else if (ch in pairs && opens.pop() !== pairs[ch]) return false;
	}
	return !inString && opens.length === 0;
}

/** The C# the script hands Add-Type, the one place a double quote may stand: inside a single-quoted PowerShell string. */
const MEMBER_DEFINITION = /-MemberDefinition '([^']*)'/;
const outsideMemberDefinition = (script: string) => script.replace(MEMBER_DEFINITION, "-MemberDefinition ''");

// What the Windows window prints for a pick: OK: and the path as JSON, every character past ASCII escaped.
const windowsChose = (folder: string) => `OK:${JSON.stringify(folder).replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)}\r\n`;
const SYSTEM_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

async function main(): Promise<void> {
	// Windows PowerShell is found under Windows' own folder, as Windows names it.
	process.env.SystemRoot = "C:\\Windows";
	const unsupported = await chooseMacosFolder({ platform: "linux" });
	assert(!unsupported.ok, "non-macOS platform should be unsupported");
	assert(unsupported.supported === false, "unsupported platform should report supported=false");
	assert(unsupported.code === "unsupported_platform", `unexpected unsupported code: ${JSON.stringify(unsupported)}`);

	let capturedCommand = "";
	let capturedArgs: string[] = [];
	let capturedTimeout = 0;
	const selectedRunner: LocalFolderPickerRunner = async (command, args, options) => {
		capturedCommand = command;
		capturedArgs = args;
		capturedTimeout = options.timeoutMs;
		return { stdout: `${JSON.stringify("/Users/example/Workspace Folder /")}\n`, stderr: "" };
	};
	const selected = await chooseMacosFolder({ platform: "darwin", runner: selectedRunner, timeoutMs: 1234, osascriptPath: "/custom/osascript" });
	assert(selected.ok && !selected.cancelled, `selected folder should succeed: ${JSON.stringify(selected)}`);
	assert(selected.path === "/Users/example/Workspace Folder /", `selected path should come back exactly, a name ending in a space too, got ${selected.path}`);
	assert(capturedCommand === "/custom/osascript", `runner should receive configured osascript path, got ${capturedCommand}`);
	assert(capturedArgs.length === 6 && capturedArgs[0] === "-l" && capturedArgs[1] === "JavaScript" && capturedArgs[2] === "-e" && capturedArgs[4] === "--" && capturedArgs[5] === "", `runner should receive osascript -l JavaScript -e <script> -- "", got ${capturedArgs.join(" ")}`);
	// A bare path is no longer what the script prints: it is refused, never taken as a folder.
	const bare = await chooseMacosFolder({ platform: "darwin", runner: async () => ({ stdout: "/Users/example/Workspace Folder/\n", stderr: "" }) });
	assert(!bare.ok && bare.code === "choose_folder_failed", `a bare path should fail safely: ${JSON.stringify(bare)}`);
	assert(capturedTimeout === 1234, `runner should receive timeout, got ${capturedTimeout}`);

	const cancelledRunner: LocalFolderPickerRunner = async () => {
		const error = new Error("Command failed: osascript");
		throw Object.assign(error, { stderr: "execution error: User canceled. (-128)" });
	};
	const cancelled = await chooseMacosFolder({ platform: "darwin", runner: cancelledRunner });
	assert(cancelled.ok && cancelled.cancelled === true && cancelled.path === null, `cancelled dialog should be a clean cancellation: ${JSON.stringify(cancelled)}`);

	const missingRunner: LocalFolderPickerRunner = async () => {
		const error = new Error("spawn osascript ENOENT") as NodeJS.ErrnoException;
		error.code = "ENOENT";
		throw error;
	};
	const missing = await chooseMacosFolder({ platform: "darwin", runner: missingRunner });
	assert(!missing.ok && missing.supported === false && missing.code === "folder_chooser_unavailable", `missing osascript should be unavailable: ${JSON.stringify(missing)}`);

	const timeoutRunner: LocalFolderPickerRunner = async () => {
		const error = new Error("Command timed out") as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
		error.code = "ETIMEDOUT";
		error.killed = true;
		error.signal = "SIGTERM";
		throw error;
	};
	const timedOut = await chooseMacosFolder({ platform: "darwin", runner: timeoutRunner });
	assert(!timedOut.ok && timedOut.supported === true && timedOut.code === "folder_chooser_timeout", `timeout should be normalized: ${JSON.stringify(timedOut)}`);

	const emptyRunner: LocalFolderPickerRunner = async () => ({ stdout: "\n", stderr: "" });
	const empty = await chooseMacosFolder({ platform: "darwin", runner: emptyRunner });
	assert(!empty.ok && empty.supported === true && empty.code === "choose_folder_failed", `empty stdout should fail safely: ${JSON.stringify(empty)}`);

	let linuxCommand = "";
	let linuxArgs: string[] = [];
	let linuxTimeout = 0;
	const linuxSelectedRunner: LocalFolderPickerRunner = async (command, args, options) => {
		linuxCommand = command;
		linuxArgs = args;
		linuxTimeout = options.timeoutMs;
		return { stdout: "/home/example/Workspace Folder\n", stderr: "" };
	};
	const linuxSelected = await chooseLocalFolder({ platform: "linux", runner: linuxSelectedRunner, timeoutMs: 4321, zenityPath: "/custom/zenity" });
	assert(linuxSelected.ok && !linuxSelected.cancelled, `linux selected folder should succeed: ${JSON.stringify(linuxSelected)}`);
	assert(linuxSelected.path === "/home/example/Workspace Folder", `linux selected path should be trimmed, got ${linuxSelected.path}`);
	assert(linuxCommand === "/custom/zenity", `runner should receive configured zenity path, got ${linuxCommand}`);
	assert(linuxArgs.includes("--file-selection") && linuxArgs.includes("--directory"), `zenity should receive directory-selection args, got ${linuxArgs.join(" ")}`);
	assert(linuxArgs.some((arg) => arg.startsWith("--title=")), `zenity should receive a title arg, got ${linuxArgs.join(" ")}`);
	assert(linuxTimeout === 4321, `linux runner should receive timeout, got ${linuxTimeout}`);

	const linuxCancelledRunner: LocalFolderPickerRunner = async () => {
		const error = new Error("Command failed: zenity") as Error & { code: unknown };
		error.code = 1;
		throw Object.assign(error, { stdout: "", stderr: "" });
	};
	const linuxCancelled = await chooseLocalFolder({ platform: "linux", runner: linuxCancelledRunner });
	assert(linuxCancelled.ok && linuxCancelled.cancelled === true && linuxCancelled.path === null, `zenity exit 1 with empty stdout should be a clean cancellation: ${JSON.stringify(linuxCancelled)}`);

	const linuxMissingRunner: LocalFolderPickerRunner = async () => {
		const error = new Error("spawn zenity ENOENT") as NodeJS.ErrnoException;
		error.code = "ENOENT";
		throw error;
	};
	const linuxMissing = await chooseLocalFolder({ platform: "linux", runner: linuxMissingRunner });
	assert(!linuxMissing.ok && linuxMissing.supported === false && linuxMissing.code === "folder_chooser_unavailable", `missing zenity should be unavailable: ${JSON.stringify(linuxMissing)}`);
	assert(!linuxMissing.ok && /zenity/i.test(linuxMissing.error) && /manually/i.test(linuxMissing.error), `missing zenity message should mention zenity and manual entry: ${JSON.stringify(linuxMissing)}`);

	const linuxTimeoutRunner: LocalFolderPickerRunner = async () => {
		const error = new Error("Command timed out") as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
		error.code = "ETIMEDOUT";
		error.killed = true;
		error.signal = "SIGTERM";
		throw error;
	};
	const linuxTimedOut = await chooseLocalFolder({ platform: "linux", runner: linuxTimeoutRunner });
	assert(!linuxTimedOut.ok && linuxTimedOut.supported === true && linuxTimedOut.code === "folder_chooser_timeout", `linux timeout should be normalized: ${JSON.stringify(linuxTimedOut)}`);

	// Windows: the script must travel as -EncodedCommand with no double quotes anywhere.
	// An inline -Command argument with embedded double quotes gets \"-escaped by Node's
	// Windows arg quoting and powershell.exe mis-parses it; this pins the fix.
	let windowsCommand = "";
	let windowsArgs: string[] = [];
	const windowsSelectedRunner: LocalFolderPickerRunner = async (command, args) => {
		windowsCommand = command;
		windowsArgs = args;
		return { stdout: windowsChose("C:\\Users\\example\\Workspace Folder"), stderr: "" };
	};
	const windowsSelected = await chooseLocalFolder({ platform: "win32", runner: windowsSelectedRunner, powershellPath: "powershell.exe" });
	assert(windowsSelected.ok && !windowsSelected.cancelled, `windows selected folder should succeed: ${JSON.stringify(windowsSelected)}`);
	assert(windowsSelected.path === "C:\\Users\\example\\Workspace Folder", `windows selected path should strip the OK: sentinel, got ${windowsSelected.path}`);
	const windowsBare = await chooseLocalFolder({ platform: "win32", runner: async () => ({ stdout: "OK:C:\\Users\\example\r\n", stderr: "" }) });
	assert(!windowsBare.ok && windowsBare.code === "choose_folder_failed", `a bare Windows path should fail safely: ${JSON.stringify(windowsBare)}`);
	assert(windowsCommand === "powershell.exe", `runner should receive powershell path, got ${windowsCommand}`);
	const encodedIndex = windowsArgs.indexOf("-EncodedCommand");
	assert(encodedIndex >= 0 && typeof windowsArgs[encodedIndex + 1] === "string", `powershell should receive -EncodedCommand, got ${windowsArgs.join(" ")}`);
	assert(!windowsArgs.includes("-Command"), `powershell must not receive an inline -Command, got ${windowsArgs.join(" ")}`);
	const decodedScript = Buffer.from(windowsArgs[encodedIndex + 1], "base64").toString("utf16le");
	assert(decodedScript.includes("FolderBrowserDialog"), "decoded script should open the folder browser dialog");
	assert(decodedScript.includes("'OK:'") && decodedScript.includes("'CANCEL'"), "decoded script should print the OK:/CANCEL sentinels");
	assert(!outsideMemberDefinition(decodedScript).includes('"'), `decoded script must not contain double quotes outside the C# it hands Add-Type (the quoting surface that broke the picker): ${decodedScript}`);

	const windowsCancelledRunner: LocalFolderPickerRunner = async () => ({ stdout: "CANCEL\r\n", stderr: "" });
	const windowsCancelled = await chooseLocalFolder({ platform: "win32", runner: windowsCancelledRunner });
	assert(windowsCancelled.ok && windowsCancelled.cancelled === true && windowsCancelled.path === null, `windows CANCEL output should be a clean cancellation: ${JSON.stringify(windowsCancelled)}`);

	const windowsMissingRunner: LocalFolderPickerRunner = async () => {
		const error = new Error("spawn powershell.exe ENOENT") as NodeJS.ErrnoException;
		error.code = "ENOENT";
		throw error;
	};
	const windowsMissing = await chooseLocalFolder({ platform: "win32", runner: windowsMissingRunner });
	assert(!windowsMissing.ok && windowsMissing.supported === false && windowsMissing.code === "folder_chooser_unavailable", `missing powershell should be unavailable: ${JSON.stringify(windowsMissing)}`);

	const windowsGarbledRunner: LocalFolderPickerRunner = async () => ({ stdout: "At line:1 char:3 parse error\r\n", stderr: "" });
	const windowsGarbled = await chooseLocalFolder({ platform: "win32", runner: windowsGarbledRunner });
	assert(!windowsGarbled.ok && windowsGarbled.supported === true && windowsGarbled.code === "choose_folder_failed", `garbled windows output should fail safely: ${JSON.stringify(windowsGarbled)}`);

	// Saving a file to a folder gives the room nothing, so its window doesn't say it does.
	assert(folderPickerPrompt("save-to") === "Choose where to save it", `the save-to prompt, got ${folderPickerPrompt("save-to")}`);

	// Only the known purposes get a prompt of their own: anything else lands
	// on the workspace wording rather than putting a client's text into a native
	// dialog.
	for (const unknown of [undefined, null, "", "toString", "constructor", "Data-Folder", 7, { purpose: "data-folder" }]) {
		assert(folderPickerPrompt(unknown) === "Choose this room's folder", `unknown purpose ${JSON.stringify(unknown)} should fall back to the workspace prompt`);
	}

	// Each platform must carry the chosen prompt into its own dialog.
	let promptedMacArgs: string[] = [];
	await chooseMacosFolder({
		platform: "darwin",
		prompt: folderPickerPrompt("data-folder"),
		runner: async (_command, args) => {
			promptedMacArgs = args;
			return { stdout: `${JSON.stringify("/Users/example/Data/")}\n`, stderr: "" };
		},
	});
	assert(promptedMacArgs[3]?.includes('withPrompt: "Choose the exxperts data folder"'), `osascript should carry the data-folder prompt, got ${promptedMacArgs[3]}`);

	let promptedLinuxArgs: string[] = [];
	await chooseLocalFolder({
		platform: "linux",
		prompt: folderPickerPrompt("data-folder"),
		runner: async (_command, args) => {
			promptedLinuxArgs = args;
			return { stdout: "/home/example/Data\n", stderr: "" };
		},
	});
	assert(promptedLinuxArgs.includes("--title=Choose the exxperts data folder"), `zenity should carry the data-folder title, got ${promptedLinuxArgs.join(" ")}`);

	let promptedWindowsArgs: string[] = [];
	await chooseLocalFolder({
		platform: "win32",
		prompt: folderPickerPrompt("data-folder"),
		runner: async (_command, args) => {
			promptedWindowsArgs = args;
			return { stdout: windowsChose("C:\\Users\\example\\Data"), stderr: "" };
		},
	});
	const promptedIndex = promptedWindowsArgs.indexOf("-EncodedCommand");
	const promptedScript = Buffer.from(promptedWindowsArgs[promptedIndex + 1], "base64").toString("utf16le");
	assert(promptedScript.includes("$dialog.Description = 'Choose the exxperts data folder'"), `powershell should carry the data-folder description, got ${promptedScript}`);
	assert(!outsideMemberDefinition(promptedScript).includes('"'), `the data-folder script must stay free of double quotes: ${promptedScript}`);

	// A quote in a prompt stays inside its string on every platform.
	let quotedMacArgs: string[] = [];
	await chooseMacosFolder({
		platform: "darwin",
		prompt: 'Choose "the" folder',
		runner: async (_command, args) => {
			quotedMacArgs = args;
			return { stdout: `${JSON.stringify("/Users/example/Data/")}\n`, stderr: "" };
		},
	});
	assert(quotedMacArgs[3]?.includes('withPrompt: "Choose \\"the\\" folder"'), `osascript should escape a quoted prompt, got ${quotedMacArgs[3]}`);

	let quotedWindowsArgs: string[] = [];
	await chooseLocalFolder({
		platform: "win32",
		prompt: "Choose Anna's folder",
		runner: async (_command, args) => {
			quotedWindowsArgs = args;
			return { stdout: windowsChose("C:\\Users\\example\\Data"), stderr: "" };
		},
	});
	const quotedIndex = quotedWindowsArgs.indexOf("-EncodedCommand");
	const quotedScript = Buffer.from(quotedWindowsArgs[quotedIndex + 1], "base64").toString("utf16le");
	assert(quotedScript.includes("$dialog.Description = 'Choose Anna''s folder'"), `powershell should double an apostrophe in the prompt, got ${quotedScript}`);

	// The folder to start at is data, never script text: the same script for every folder, the folder only after -- or in the window's own variable.
	const starts = ["/Users/ana/Ana's files", "/Users/ana/Ana’s files", "/Users/ana/$(id)", "/Users/ana/`id`", "/Users/ana/a;b", "/Users/ana/100%", "/Users/ana/Fotos 📷", "/Users/ana/Отчёты", "/Users/ana/報告"];
	const macScripts = new Set<string>();
	for (const start of starts) {
		let args: string[] = [];
		const chosen = await chooseMacosFolder({ platform: "darwin", startAt: start, runner: async (_command, given) => {
			args = given;
			return { stdout: `${JSON.stringify(`${start}/`)}\n`, stderr: "" };
		} });
		assert(args[4] === "--" && args[5] === start && args.length === 6, `the Mac's start folder rides after --, got ${JSON.stringify(args.slice(4))}`);
		assert(!args[3].includes(start.slice("/Users/ana/".length)), `the Mac script holds the start folder ${start}`);
		macScripts.add(args[3]);
		assert(chosen.ok && chosen.path === `${start}/`, `the Mac's pick comes back exactly: ${JSON.stringify(chosen)}`);
	}
	assert(macScripts.size === 1, `the Mac script differs across start folders: ${macScripts.size}`);
	const windowsCommands = new Set<string>();
	process.env.EXXPERTS_FOLDER_START = "C:\\Users\\ana\\left over";
	for (const start of starts.map((folder) => `C:${folder.replace(/\//g, "\\")}`)) {
		let command = "";
		let args: string[] = [];
		let env: NodeJS.ProcessEnv | undefined;
		const chosen = await chooseLocalFolder({ platform: "win32", startAt: start, runner: async (given, givenArgs, options) => {
			command = given;
			args = givenArgs;
			env = options.env;
			return { stdout: windowsChose(start), stderr: "" };
		} });
		assert(command === SYSTEM_POWERSHELL, `PowerShell starts by its full path, got ${command}`);
		assert(env?.EXXPERTS_FOLDER_START === start, `the start folder rides in the window's own variable, got ${JSON.stringify(env?.EXXPERTS_FOLDER_START)}`);
		const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
		assert(!script.includes(start.slice("C:\\Users\\ana\\".length)) && !outsideMemberDefinition(script).includes('"'), `the Windows script holds the start folder or a double quote: ${start}`);
		assert(script.includes("Remove-Item -LiteralPath Env:EXXPERTS_FOLDER_START") && script.indexOf("Remove-Item") < script.indexOf("ShowDialog"), "the variable goes before the window opens");
		windowsCommands.add(args.join(" "));
		assert(chosen.ok && chosen.path === start, `the Windows pick comes back exactly: ${JSON.stringify(chosen)} for ${start}`);
	}
	assert(windowsCommands.size === 1, `the Windows command differs across start folders: ${windowsCommands.size}`);
	// Windows reads a variable's name in any case: one the server holds in another case goes too.
	process.env.exxperts_folder_start = "C:\\Users\\ana\\other case";
	const startKeys = (env: NodeJS.ProcessEnv | undefined) => Object.keys(env ?? {}).filter((key) => key.toUpperCase() === "EXXPERTS_FOLDER_START");
	let startEnv: NodeJS.ProcessEnv | undefined;
	await chooseLocalFolder({ platform: "win32", startAt: "C:\\Users\\ana\\Reports", runner: async (_command, _args, options) => {
		startEnv = options.env;
		return { stdout: "CANCEL\r\n", stderr: "" };
	} });
	assert(JSON.stringify(startKeys(startEnv)) === JSON.stringify(["EXXPERTS_FOLDER_START"]) && startEnv?.EXXPERTS_FOLDER_START === "C:\\Users\\ana\\Reports", `a window with a start folder holds it once, in one case: ${JSON.stringify(startKeys(startEnv))}`);
	let noStartEnv: NodeJS.ProcessEnv | undefined;
	await chooseLocalFolder({ platform: "win32", runner: async (_command, _args, options) => {
		noStartEnv = options.env;
		return { stdout: "CANCEL\r\n", stderr: "" };
	} });
	assert(noStartEnv !== undefined && startKeys(noStartEnv).length === 0, `a window with no start folder gets none, even one the server's own environment held in any case: ${JSON.stringify(startKeys(noStartEnv))}`);
	delete process.env.EXXPERTS_FOLDER_START;
	delete process.env.exxperts_folder_start;
	// With no full Windows folder named, the window is unavailable: no PowerShell found on PATH starts.
	process.env.SystemRoot = "Windows";
	let started = false;
	const noRoot = await chooseLocalFolder({ platform: "win32", runner: async () => {
		started = true;
		return { stdout: "CANCEL\r\n", stderr: "" };
	} });
	assert(!started && !noRoot.ok && noRoot.code === "folder_chooser_unavailable", `no full SystemRoot: ${JSON.stringify(noRoot)}`);
	process.env.SystemRoot = "C:\\Windows";
	// Linux: its own argument, closing with a slash so the window opens inside the folder.
	let linuxStartArgs: string[] = [];
	await chooseLocalFolder({ platform: "linux", startAt: "/home/ana/a;b", runner: async (_command, args) => {
		linuxStartArgs = args;
		return { stdout: "/home/ana/a;b\n", stderr: "" };
	} });
	assert(linuxStartArgs.at(-1) === "--filename=/home/ana/a;b/", `zenity's start folder, got ${JSON.stringify(linuxStartArgs)}`);

	// A window that can't open at its start folder opens once more with none; a cancel there is not tried again.
	const tries: string[] = [];
	const retried = await chooseMacosFolder({ platform: "darwin", startAt: "/Users/ana/Gone", runner: async (_command, args) => {
		tries.push(args[5]);
		if (args[5]) throw Object.assign(new Error("Command failed"), { stderr: "execution error: Can't get folder. (-1728)" });
		return { stdout: `${JSON.stringify("/Users/ana/Documents/")}\n`, stderr: "" };
	} });
	assert(JSON.stringify(tries) === JSON.stringify(["/Users/ana/Gone", ""]) && retried.ok && retried.path === "/Users/ana/Documents/", `the retry: ${JSON.stringify({ tries, retried })}`);
	tries.length = 0;
	const cancelledOnce = await chooseMacosFolder({ platform: "darwin", startAt: "/Users/ana/Reports", runner: async (_command, args) => {
		tries.push(args[5]);
		throw Object.assign(new Error("Command failed"), { stderr: "execution error: User canceled. (-128)" });
	} });
	assert(tries.length === 1 && cancelledOnce.ok && cancelledOnce.cancelled, `a cancel at the start folder: ${JSON.stringify({ tries, cancelledOnce })}`);
	// A start folder whose name reads like a cancel: a failure there is still a failure, tried again with no start folder, since the cancel is read only from what macOS says.
	tries.length = 0;
	const oddStart = "/Users/ana/Q-128 user canceled (-128)";
	const oddName = await chooseMacosFolder({ platform: "darwin", startAt: oddStart, runner: async (_command, args) => {
		tries.push(args[5]);
		if (args[5]) throw Object.assign(new Error(`Command failed: osascript ${args.join(" ")}\nexecution error: Can't get folder. (-1728)`), { stderr: "execution error: Can't get folder. (-1728)" });
		return { stdout: `${JSON.stringify("/Users/ana/Documents/")}\n`, stderr: "" };
	} });
	assert(JSON.stringify(tries) === JSON.stringify([oddStart, ""]) && oddName.ok && !oddName.cancelled && oddName.path === "/Users/ana/Documents/", `a failure at a start folder named like a cancel: ${JSON.stringify({ tries, oddName })}`);

	// Windows: the folder window puts itself in front. Today's statements stay, in order, each whole; the new part is one guarded statement before the window opens, and the note one after it.
	await row("the Windows window's script: today's statements whole, the new part one guarded statement, the note after the window, every quote and bracket closed", async () => {
		const todays = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
			"$dialog.Description = 'Choose this room''s folder'",
			"$dialog.ShowNewFolderButton = $true",
			"$start = $env:EXXPERTS_FOLDER_START",
			"Remove-Item -LiteralPath Env:EXXPERTS_FOLDER_START -ErrorAction SilentlyContinue",
			"if ($start) { $dialog.SelectedPath = $start }",
			"$owner = New-Object System.Windows.Forms.Form",
			"$owner.TopMost = $true",
			"if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $json = ConvertTo-Json -Compress -InputObject ([string]$dialog.SelectedPath); $out = New-Object System.Text.StringBuilder; foreach ($ch in $json.ToCharArray()) { if ([int]$ch -gt 127) { [void]$out.Append('\\u' + ([int]$ch).ToString('x4')) } else { [void]$out.Append($ch) } }; Write-Output ('OK:' + $out.ToString()) } else { Write-Output 'CANCEL' }",
		];
		let frontArgs: string[] = [];
		await chooseLocalFolder({ platform: "win32", runner: async (_command, args) => {
			frontArgs = args;
			return { stdout: "CANCEL\r\n", stderr: "" };
		} });
		const front = Buffer.from(frontArgs[frontArgs.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
		let at = -1;
		for (const statement of todays) {
			const found = front.indexOf(`${statement}; `, at + 1) >= 0 ? front.indexOf(`${statement}; `, at + 1) : front.indexOf(statement, at + 1);
			assert(found > at && (found === 0 || front.slice(found - 2, found) === "; "), `today's statement is still whole and in order: ${statement}`);
			at = found;
		}
		const owned = front.indexOf("$owner.TopMost = $true; ") + "$owner.TopMost = $true; ".length;
		const opens = front.indexOf("; if ($dialog.ShowDialog($owner)");
		const guard = front.slice(owned, opens);
		assert(guard.startsWith("$lift = $null; try { Add-Type ") && guard.endsWith("} catch { $lift = $null }") && balanced(guard.slice("$lift = $null; ".length), "'"), `the new part is one try with its catch, closed before the window opens: ${guard.slice(0, 80)}...${guard.slice(-40)}`);
		assert(front.indexOf("$start = $env:EXXPERTS_FOLDER_START") < owned, "the start folder is read from the window's own environment before the new part, outside it");
		const after = front.slice(front.indexOf("Write-Output 'CANCEL' }") + "Write-Output 'CANCEL' }".length);
		assert(after.startsWith("; try { ") && after.endsWith(" } catch {}") && after.includes("[Console]::Error.WriteLine(") && balanced(after.slice(2), "'"), `the note is one guarded statement after the window: ${after}`);
		assert(!front.includes("Write-Error") && !front.includes("Write-Host") && front.split("Write-Output").length === 3, "the script's ordinary output stays OK: or CANCEL, nothing else");
		assert(balanced(front, "'"), "PowerShell reads every single-quoted string and bracket of the script closed");
		const memberDefinition = MEMBER_DEFINITION.exec(front)?.[1] ?? "";
		assert(memberDefinition.includes("SetWindowPos") && memberDefinition.includes("SetForegroundWindow") && balanced(memberDefinition, '"'), "the C# the script hands Add-Type puts the window on top and asks for the front, its strings and brackets closed");
		for (const never of ["keybd_event", "SendKeys", "AttachThreadInput", "BringWindowToTop", "Start-Process"]) assert(!front.includes(never), `the script sends no keys, joins no other program's input and starts nothing: ${never}`);
		assert(frontArgs.join(" ").length < 32_000, `the command fits a Windows command line: ${frontArgs.join(" ").length}`);
	});

	// The note: one line of a fixed shape on the error output, taken once into the log beside a pick, a cancel or a failure; the result never changes for it, and nothing else on that output reaches the log.
	await row("the note beside a pick, a cancel and a failure reaches the log once and changes no result; any other error output is dropped, and nothing of the chosen folder is logged", async () => {
		const NOTE = "folder-window: on-top-before=no front=chrome in-front-after=yes";
		const picked = "C:\\Users\\ana\\Private Reports";
		logged.length = 0;
		const pickWithNote = await chooseLocalFolder({ platform: "win32", runner: async () => ({ stdout: windowsChose(picked), stderr: `\r\n${NOTE}\r\n` }) });
		assert(pickWithNote.ok && !pickWithNote.cancelled && pickWithNote.path === picked, `a note beside OK: leaves the pick: ${JSON.stringify(pickWithNote)}`);
		assert(JSON.stringify(logged) === JSON.stringify([NOTE]), `a note beside OK: reaches the log once: ${JSON.stringify(logged)}`);
		logged.length = 0;
		const cancelWithNote = await chooseLocalFolder({ platform: "win32", runner: async () => ({ stdout: "CANCEL\r\n", stderr: `${NOTE}\r\n` }) });
		assert(cancelWithNote.ok && cancelWithNote.cancelled, `a note beside CANCEL leaves the cancel: ${JSON.stringify(cancelWithNote)}`);
		assert(JSON.stringify(logged) === JSON.stringify([NOTE]), `a note beside CANCEL reaches the log once: ${JSON.stringify(logged)}`);
		logged.length = 0;
		const failWithNote = await chooseLocalFolder({ platform: "win32", runner: async () => {
			throw Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: `${NOTE}\r\n` });
		} });
		assert(!failWithNote.ok && failWithNote.code === "choose_folder_failed", `a note beside a failure leaves the failure: ${JSON.stringify(failWithNote)}`);
		assert(JSON.stringify(logged) === JSON.stringify([NOTE]), `a note beside a failure reaches the log once: ${JSON.stringify(logged)}`);
		logged.length = 0;
		const noisy = [
			"#< CLIXML",
			`<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">${picked}_x000D__x000A_</S></Objs>`,
			`folder-window: on-top-before=no front=${picked} in-front-after=yes`,
			`folder-window: on-top-before=no front=chrome in-front-after=yes ${picked}`,
			`  ${NOTE}`,
			"folder-window: on-top-before=maybe front=chrome in-front-after=yes",
			NOTE,
			"folder-window: on-top-before=yes front=explorer in-front-after=no",
		].join("\r\n");
		const pickWithNoise = await chooseLocalFolder({ platform: "win32", runner: async () => ({ stdout: windowsChose(picked), stderr: noisy }) });
		assert(pickWithNoise.ok && pickWithNoise.path === picked, `noise on the error output leaves the pick: ${JSON.stringify(pickWithNoise)}`);
		assert(JSON.stringify(logged) === JSON.stringify([NOTE]), `of the error output only the first line of the note's exact shape reaches the log: ${JSON.stringify(logged)}`);
		logged.length = 0;
		await chooseLocalFolder({ platform: "win32", runner: async () => ({ stdout: windowsChose(picked), stderr: `${picked}\r\n` }) });
		assert(logged.length === 0, `an error output with no note logs nothing: ${JSON.stringify(logged)}`);
	});

	// No time limit, and the window closes when nobody can answer it any more: the request went, or the server stops. The four places all ask the route; Room settings and the chat both ask for the room's folder.
	await app.listen({ port: 0, host: "127.0.0.1" });
	const port = (app.server.address() as AddressInfo).port;
	const press = (purpose: string) => {
		let answer: (value: { status: number; body: string }) => void = () => {};
		const answered = new Promise<{ status: number; body: string }>((resolve) => { answer = resolve; });
		const request = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/system/choose-folder", agent: false, headers: { ...SMOKE_AUTH_HEADERS, "content-type": "application/json", "x-exxperts-local-action": "choose-folder" } }, (response) => {
			let body = "";
			response.on("data", (chunk) => { body += String(chunk); });
			response.on("end", () => answer({ status: response.statusCode ?? 0, body }));
		});
		request.on("error", () => answer({ status: 0, body: "" }));
		request.end(JSON.stringify({ purpose }));
		return { request, answered };
	};
	const opened = async (count: number) => {
		await waitUntil(() => windowStarts.length >= count, "the route opened the window");
		return windowStarts[count - 1];
	};
	const chose = (program: string, folder: string) => (program === "powershell.exe" ? windowsChose(folder) : program === "zenity" ? `${folder}\n` : `${JSON.stringify(folder)}\n`);
	await row("the route's window has no time limit for the room's folder, the data folder and Save to", async () => {
		for (const purpose of ["workspace", "data-folder", "save-to"]) {
			const { answered } = press(purpose);
			const start = await opened(windowStarts.length + 1);
			assert(!start.timeout, `the window for ${purpose} has no time limit: ${String(start.timeout)}`);
			start.answer(chose(start.program, `/Users/ana/${purpose}/`));
			const { status, body } = await answered;
			assert(status === 200 && JSON.parse(body).path === `/Users/ana/${purpose}/`, `the pick for ${purpose} comes back: ${status} ${body}`);
		}
	});

	await row("the window closes when its request goes before the answer", async () => {
		const { request, answered } = press("workspace");
		const start = await opened(windowStarts.length + 1);
		assert(start.signal && !start.signal.aborted, "a window the page still waits on stays open");
		request.destroy();
		await waitUntil(() => start.signal?.aborted === true, "the window closed once its request went");
		await answered;
	});
	await row("a finished pick is not closed after its answer", async () => {
		const connections = () => new Promise<number>((resolve) => app.server.getConnections((_error, count) => resolve(count)));
		const before = await connections();
		const { answered } = press("workspace");
		const start = await opened(windowStarts.length + 1);
		start.answer(chose(start.program, "/Users/ana/Picked/"));
		const { status } = await answered;
		assert(status === 200, `a pick answers: ${status}`);
		// The answer is sent and its connection closes: a window that already answered is never told to close.
		await waitUntil(async () => (await connections()) === before, "the answered request's connection closed");
		assert(start.signal !== undefined && !start.signal.aborted, `a finished pick is not aborted afterwards: ${String(start.signal?.aborted)}`);
	});
	await row("the server's stop closes a waiting window, and the window never holds the stop", async () => {
		const { answered } = press("workspace");
		const start = await opened(windowStarts.length + 1);
		const stopped = app.close().then(() => true);
		await waitUntil(() => start.signal?.aborted === true, "the server's stop closed the waiting window");
		await waitUntil(() => Promise.race([stopped, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))]), "the server stopped with a window open");
		await answered;
	});

	if (failedRows.length > 0) {
		console.log(`system choose-folder smoke failed: ${failedRows.length} row(s)`);
		// A window a failed row left open would hold the process.
		process.exit(1);
	}
	console.log("system choose-folder smoke passed");
}

await main();
