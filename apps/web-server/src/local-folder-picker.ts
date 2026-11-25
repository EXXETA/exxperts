import { execFile } from "node:child_process";

import { systemPowerShell } from "./room-box/windows/windows-places.js";

const DEFAULT_OSASCRIPT_PATH = "/usr/bin/osascript";
const DEFAULT_ZENITY_PATH = "zenity";
/** Where the Windows window's script finds the folder to start at: set only on that window's own process, and dropped before the window opens. */
const FOLDER_START_VARIABLE = "EXXPERTS_FOLDER_START";

/**
 * What the dialog is being opened for. The caller says the purpose, never the
 * words: the prompt a person reads is decided here, once, for all three
 * platforms. An unknown purpose falls back to the workspace prompt, so a
 * stale or hostile client can never put text of its own into a native dialog.
 */
export type FolderPickerPurpose = "workspace" | "data-folder" | "room-asks" | "save-to";

export const DEFAULT_FOLDER_PICKER_PROMPT = "Choose this room's folder";

// A Map, not an object literal: a plain lookup would answer "toString" and
// every other prototype key with something that is not a prompt at all.
const FOLDER_PICKER_PROMPTS = new Map<FolderPickerPurpose, string>([
	["workspace", DEFAULT_FOLDER_PICKER_PROMPT],
	["data-folder", "Choose the exxperts data folder"],
	// A room's own ask, from its card in the conversation.
	["room-asks", "Choose a folder for this room"],
	// Where a file from the conversation is saved: the room gets nothing from it.
	["save-to", "Choose where to save it"],
]);

export function folderPickerPrompt(purpose: unknown): string {
	if (typeof purpose !== "string") return DEFAULT_FOLDER_PICKER_PROMPT;
	return FOLDER_PICKER_PROMPTS.get(purpose as FolderPickerPurpose) ?? DEFAULT_FOLDER_PICKER_PROMPT;
}

// The macOS folder window, from a JavaScript for Automation script. It is
// still the "choose folder" of Standard Additions, which brings the window to
// the front and takes the clicks and keys; but osascript alone has no menus,
// and on a Mac Cut, Copy and Paste reach a text field only through an Edit
// menu, so Cmd+V did nothing in New Folder or in Go to Folder (Cmd+Shift+G).
// The script installs an Edit menu first. (Opening NSOpenPanel directly gets
// the menu too, but its window never becomes the active one: the sidebar and
// the keyboard stay dead.) A cancel throws the same -128 error as before. The
// prompt travels as a JSON string literal, which is valid JavaScript for any
// text. The folder to start at is never script text: it comes as the
// script's first argument, after `--`, and the chosen folder goes back as JSON,
// so any name comes back exactly.
export function macosChooseFolderScript(prompt: string): string {
	return [
		"function run(argv) {",
		'ObjC.import("AppKit");',
		"const bar = $.NSMenu.alloc.init;",
		"const editItem = $.NSMenuItem.alloc.init;",
		"bar.addItem(editItem);",
		'const edit = $.NSMenu.alloc.initWithTitle("Edit");',
		'for (const [title, action, key] of [["Undo", "undo:", "z"], ["Redo", "redo:", "Z"], ["Cut", "cut:", "x"], ["Copy", "copy:", "c"], ["Paste", "paste:", "v"], ["Select All", "selectAll:", "a"]]) edit.addItemWithTitleActionKeyEquivalent(title, action, key);',
		"editItem.submenu = edit;",
		"$.NSApplication.sharedApplication.mainMenu = bar;",
		"const app = Application.currentApplication();",
		"app.includeStandardAdditions = true;",
		`const options = { withPrompt: ${JSON.stringify(prompt)} };`,
		"if (argv[0]) options.defaultLocation = Path(argv[0]);",
		"const chosen = app.chooseFolder(options).toString();",
		// AppleScript's POSIX path of a folder ends in a slash; keep that shape.
		'return JSON.stringify(chosen.endsWith("/") ? chosen : chosen + "/");',
		"}",
	].join("\n");
}

/** osascript's arguments: the script, then the folder to start at as data after `--`, empty for none. */
export function macosChooseFolderArgs(prompt: string, startAt?: string): string[] {
	return ["-l", "JavaScript", "-e", macosChooseFolderScript(prompt), "--", startAt ?? ""];
}

// zenity prints the selected path on stdout and exits 0; cancel exits 1 with empty stdout.
// The title and the folder to start at ride in their own argv entries, so no shell ever sees them; the closing slash opens inside the folder.
function linuxChooseFolderArgs(prompt: string, startAt?: string): string[] {
	return ["--file-selection", "--directory", `--title=${prompt}`, ...(startAt ? [`--filename=${startAt.replace(/\/+$/, "")}/`] : [])];
}

// The C# the Windows script hands Add-Type. Lift finds the window the dialog owns, notes once whether it was already always on
// top and which program was in front, then marks it always on top (SetWindowPos with
// HWND_TOPMOST, no move, no resize, no activation) and asks for the front. Seen is the note:
// closed words and a program name cut to letters, digits, dot, dash and underscore. It sits
// inside a single-quoted PowerShell string, so it never holds a single quote.
const WINDOW_TO_FRONT = [
	'[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
	'[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
	'[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
	'[DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr h);',
	'[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);',
	'[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
	'[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
	'[DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);',
	'static string onTopBefore = "unknown";',
	'static string frontBefore = "unknown";',
	'static string inFrontAfter = "unknown";',
	"static IntPtr Owned(IntPtr owner) {",
	"  int n = 0;",
	"  for (IntPtr h = GetTopWindow(IntPtr.Zero); h != IntPtr.Zero && n < 5000; h = GetWindow(h, 2), n++) {",
	"    if (GetWindow(h, 4) == owner && IsWindowVisible(h)) return h;",
	"  }",
	"  return IntPtr.Zero;",
	"}",
	"static string Program(IntPtr h) {",
	'  if (h == IntPtr.Zero) return "nothing";',
	"  uint pid; GetWindowThreadProcessId(h, out pid);",
	'  try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "unknown"; }',
	"}",
	"public static int Lift(IntPtr owner, int tries) {",
	"  IntPtr d = Owned(owner);",
	"  if (d == IntPtr.Zero) return 0;",
	'  if (tries == 0) { onTopBefore = (GetWindowLong(d, -20) & 8) != 0 ? "yes" : "no"; frontBefore = Program(GetForegroundWindow()); }',
	"  SetWindowPos(d, new IntPtr(-1), 0, 0, 0, 0, 0x13);",
	"  if (GetForegroundWindow() != d) SetForegroundWindow(d);",
	"  bool inFront = GetForegroundWindow() == d;",
	'  inFrontAfter = inFront ? "yes" : "no";',
	"  return inFront ? 2 : 1;",
	"}",
	"public static string Seen() {",
	'  string name = System.Text.RegularExpressions.Regex.Replace(frontBefore, "[^A-Za-z0-9._-]", "_");',
	"  if (name.Length > 40) name = name.Substring(0, 40);",
	'  return "on-top-before=" + onTopBefore + " front=" + name + " in-front-after=" + inFrontAfter;',
	"}",
].join("\n");

/**
 * The note the Windows script writes once per window, read whole: whether the window was
 * already always on top, which program was in front, and whether the window was in front
 * after. Nothing else on that output is read, so no path can travel this way.
 */
const WINDOW_NOTE = /^folder-window: on-top-before=(yes|no|unknown) front=[A-Za-z0-9._-]{1,40} in-front-after=(yes|no|unknown|failed)$/;

/**
 * At most one note into the server's log, at warn: the desktop's log shows nothing quieter.
 * The app is imported when a note comes, not when this module loads, so loading the picker
 * never builds the server app ahead of its place in server-load-order.ts.
 */
function logWindowNote(stderr: string): Promise<void> {
	const note = stderr.split(/\r?\n/).find((line) => WINDOW_NOTE.test(line));
	if (!note) return Promise.resolve();
	return import("./server-app.js").then(({ app }) => app.log.warn(note)).catch(() => {});
}

// Prints "OK:<path>" or "CANCEL" so selection, cancellation, and failure are unambiguous.
// The TopMost owner form alone did not keep the dialog from opening behind the browser, so
// once the window shows, the script marks the window itself always on top and asks Windows
// to put it in front (WINDOW_TO_FRONT). That part runs inside its own try: if it cannot
// start (a PowerShell that allows no native calls, a missing type), the window opens as it
// did before. It sends no keys and touches no other program's window. After the window, it
// writes one note on its error output (WINDOW_NOTE), never on its ordinary output.
// The script is passed via -EncodedCommand and uses only single-quoted strings: an inline
// -Command argument with embedded double quotes gets \"-escaped by Node's Windows arg
// quoting and powershell.exe mis-parses that, so the script never ran on real machines.
// The description is single-quoted too, so a quote inside it is doubled the PowerShell way.
// The folder to start at is read from the window's own environment, never from the
// script, so the encoded command is the same for every folder; the chosen folder comes
// back as JSON with every character past ASCII escaped, so any name survives the pipe.
export function windowsChooseFolderEncodedCommand(prompt: string): string {
	const script = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
		`$dialog.Description = '${prompt.replace(/'/g, "''")}'`,
		"$dialog.ShowNewFolderButton = $true",
		`$start = $env:${FOLDER_START_VARIABLE}`,
		`Remove-Item -LiteralPath Env:${FOLDER_START_VARIABLE} -ErrorAction SilentlyContinue`,
		"if ($start) { $dialog.SelectedPath = $start }",
		"$owner = New-Object System.Windows.Forms.Form",
		"$owner.TopMost = $true",
		// A timer on the window's own thread: its ticks run while the window is open, and each looks for it until it is in front, five tries at most, or five seconds pass without it.
		"$lift = $null",
		`try { Add-Type -IgnoreWarnings -ErrorAction Stop -Namespace FolderPick -Name Win -MemberDefinition '${WINDOW_TO_FRONT}'; $tries = @{ found = 0; ticks = 0 }; $lift = New-Object System.Windows.Forms.Timer; $lift.Interval = 100; $lift.add_Tick({ try { $tries.ticks++; $r = [FolderPick.Win]::Lift($owner.Handle, $tries.found); if ($r -gt 0) { $tries.found++ }; if ($r -eq 2 -or $tries.found -ge 5 -or $tries.ticks -ge 50) { $lift.Stop() } } catch { $lift.Stop() } }); $lift.Start() } catch { $lift = $null }`,
		"if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $json = ConvertTo-Json -Compress -InputObject ([string]$dialog.SelectedPath); $out = New-Object System.Text.StringBuilder; foreach ($ch in $json.ToCharArray()) { if ([int]$ch -gt 127) { [void]$out.Append('\\u' + ([int]$ch).ToString('x4')) } else { [void]$out.Append($ch) } }; Write-Output ('OK:' + $out.ToString()) } else { Write-Output 'CANCEL' }",
		// The empty line first: a line glued to something else on the error output would not be read.
		"try { $seen = 'on-top-before=unknown front=unknown in-front-after=failed'; if ($lift) { $lift.Stop(); $seen = [FolderPick.Win]::Seen() }; [Console]::Error.WriteLine(); [Console]::Error.WriteLine('folder-window: ' + $seen) } catch {}",
	].join("; ");
	return Buffer.from(script, "utf16le").toString("base64");
}

/** `timeoutMs` 0 waits as long as the window is open. `signal` closes it. `env`, where given, is the window's whole environment. */
export type LocalFolderPickerRunner = (command: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;

export type LocalFolderPickerResult =
	| { ok: true; supported: true; cancelled: false; path: string }
	| { ok: true; supported: true; cancelled: true; path: null }
	| { ok: false; supported: false; cancelled: false; code: "unsupported_platform" | "folder_chooser_unavailable"; error: string }
	| { ok: false; supported: true; cancelled: false; code: "folder_chooser_timeout" | "choose_folder_failed" | "folder_chooser_stopped"; error: string };

export interface ChooseMacosFolderOptions {
	platform?: NodeJS.Platform;
	runner?: LocalFolderPickerRunner;
	/** How long the window may stay open; left out or null, as long as the person needs. */
	timeoutMs?: number | null;
	/** Closes the window, as Stop or the turn's end does for a room's card. */
	signal?: AbortSignal;
	osascriptPath?: string;
	/** The line the dialog shows; the workspace prompt when nobody says otherwise. */
	prompt?: string;
	/** The folder the window opens at, as the server judged it; never text from the page. */
	startAt?: string;
}

export interface ChooseLocalFolderOptions extends ChooseMacosFolderOptions {
	powershellPath?: string;
	zenityPath?: string;
}

function defaultFolderPickerRunner(command: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(command, args, {
			timeout: options.timeoutMs,
			...(options.signal ? { signal: options.signal } : {}),
			...(options.env ? { env: options.env } : {}),
			killSignal: "SIGTERM",
			maxBuffer: 64 * 1024,
			windowsHide: true,
		}, (error, stdout, stderr) => {
			if (error) {
				reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
				return;
			}
			resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/** A cancel, read from the number osascript ends its error with: never from the error's message, which holds the command line and its start folder. */
function isUserCancellation(stderr: string): boolean {
	return /\(-128\)$/.test(stderr.trim().split("\n").at(-1) ?? "");
}

function isMissingOsascript(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "EACCES";
}

/** No time limit unless a caller sets one: the window stays until the person answers or its signal closes it. */
function runnerOptions(options: ChooseMacosFolderOptions): { timeoutMs: number; signal?: AbortSignal } {
	return { timeoutMs: options.timeoutMs ?? 0, ...(options.signal ? { signal: options.signal } : {}) };
}

const STOPPED: LocalFolderPickerResult = { ok: false, supported: true, cancelled: false, code: "folder_chooser_stopped", error: "The folder window was closed." };

/** A folder the window sent back as JSON, or null for anything else. */
function chosenFromJson(text: string): string | null {
	try {
		const chosen: unknown = JSON.parse(text);
		return typeof chosen === "string" && chosen !== "" ? chosen : null;
	} catch {
		return null;
	}
}

function isTimeout(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	const signal = (error as { signal?: unknown } | undefined)?.signal;
	const killed = (error as { killed?: unknown } | undefined)?.killed;
	return code === "ETIMEDOUT" || signal === "SIGTERM" || killed === true;
}

/**
 * The Mac's folder window. One that fails to open at its start folder opens
 * once more where macOS last was: a pick there is the person's own, and the
 * caller holds any pick that isn't the folder it suggested.
 */
export async function chooseMacosFolder(options: ChooseMacosFolderOptions = {}): Promise<LocalFolderPickerResult> {
	const first = await chooseMacosFolderOnce(options);
	if (options.startAt && !first.ok && first.code === "choose_folder_failed" && !options.signal?.aborted) return chooseMacosFolderOnce({ ...options, startAt: undefined });
	return first;
}

async function chooseMacosFolderOnce(options: ChooseMacosFolderOptions): Promise<LocalFolderPickerResult> {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") {
		return {
			ok: false,
			supported: false,
			cancelled: false,
			code: "unsupported_platform",
			error: "Folder chooser is only available on macOS. Enter the path manually.",
		};
	}

	const runner = options.runner ?? defaultFolderPickerRunner;
	const osascriptPath = options.osascriptPath ?? DEFAULT_OSASCRIPT_PATH;
	const prompt = options.prompt ?? DEFAULT_FOLDER_PICKER_PROMPT;

	try {
		const result = await runner(osascriptPath, macosChooseFolderArgs(prompt, options.startAt), runnerOptions(options));
		const selectedPath = chosenFromJson(result.stdout.trim());
		if (!selectedPath) {
			return {
				ok: false,
				supported: true,
				cancelled: false,
				code: "choose_folder_failed",
				error: "Folder chooser did not return a folder path. Enter the path manually.",
			};
		}
		return { ok: true, supported: true, cancelled: false, path: selectedPath };
	} catch (error) {
		const stderr = String((error as { stderr?: unknown } | undefined)?.stderr ?? "");
		if (options.signal?.aborted) return STOPPED;
		if (isUserCancellation(stderr)) return { ok: true, supported: true, cancelled: true, path: null };
		if (isMissingOsascript(error)) {
			return {
				ok: false,
				supported: false,
				cancelled: false,
				code: "folder_chooser_unavailable",
				error: "macOS folder chooser is unavailable. Enter the path manually.",
			};
		}
		if (isTimeout(error)) {
			return {
				ok: false,
				supported: true,
				cancelled: false,
				code: "folder_chooser_timeout",
				error: "Folder chooser timed out. Enter the path manually.",
			};
		}
		return {
			ok: false,
			supported: true,
			cancelled: false,
			code: "choose_folder_failed",
			error: "Folder chooser failed. Enter the path manually.",
		};
	}
}

/** The Windows window's own environment: the server's, with the folder to start at, or without one. */
function windowsWindowEnvironment(startAt: string | undefined): NodeJS.ProcessEnv {
	const env = { ...process.env };
	// Windows reads a name in any case: every spelling of it goes.
	for (const key of Object.keys(env)) if (key.toUpperCase() === FOLDER_START_VARIABLE) delete env[key];
	return startAt ? { ...env, [FOLDER_START_VARIABLE]: startAt } : env;
}

async function chooseWindowsFolder(options: ChooseLocalFolderOptions = {}): Promise<LocalFolderPickerResult> {
	const runner = options.runner ?? defaultFolderPickerRunner;
	// Windows PowerShell under Windows' own folder, never one a search of PATH finds first.
	const powershellPath = options.powershellPath ?? systemPowerShell(process.env);
	const prompt = options.prompt ?? DEFAULT_FOLDER_PICKER_PROMPT;
	if (powershellPath === undefined) {
		return { ok: false, supported: false, cancelled: false, code: "folder_chooser_unavailable", error: "Windows folder chooser is unavailable. Enter the path manually." };
	}

	try {
		const result = await runner(powershellPath, ["-NoProfile", "-STA", "-EncodedCommand", windowsChooseFolderEncodedCommand(prompt)], { ...runnerOptions(options), env: windowsWindowEnvironment(options.startAt) });
		await logWindowNote(result.stderr);
		const output = result.stdout.trim();
		if (output === "CANCEL") return { ok: true, supported: true, cancelled: true, path: null };
		if (output.startsWith("OK:")) {
			const selectedPath = chosenFromJson(output.slice(3));
			if (selectedPath) return { ok: true, supported: true, cancelled: false, path: selectedPath };
		}
		return {
			ok: false,
			supported: true,
			cancelled: false,
			code: "choose_folder_failed",
			error: "Folder chooser did not return a folder path. Enter the path manually.",
		};
	} catch (error) {
		await logWindowNote(String((error as { stderr?: unknown } | undefined)?.stderr ?? ""));
		if (options.signal?.aborted) return STOPPED;
		if (isMissingOsascript(error)) {
			return {
				ok: false,
				supported: false,
				cancelled: false,
				code: "folder_chooser_unavailable",
				error: "Windows folder chooser is unavailable. Enter the path manually.",
			};
		}
		if (isTimeout(error)) {
			return {
				ok: false,
				supported: true,
				cancelled: false,
				code: "folder_chooser_timeout",
				error: "Folder chooser timed out. Enter the path manually.",
			};
		}
		return {
			ok: false,
			supported: true,
			cancelled: false,
			code: "choose_folder_failed",
			error: "Folder chooser failed. Enter the path manually.",
		};
	}
}

// zenity exits 1 both on cancel and on some real failures; cancel is the exit-1 case with empty stdout.
function isZenityCancellation(error: unknown): boolean {
	const code = (error as { code?: unknown } | undefined)?.code;
	const stdout = String((error as { stdout?: unknown } | undefined)?.stdout ?? "");
	return code === 1 && stdout.trim() === "";
}

async function chooseLinuxFolder(options: ChooseLocalFolderOptions = {}): Promise<LocalFolderPickerResult> {
	const runner = options.runner ?? defaultFolderPickerRunner;
	const zenityPath = options.zenityPath ?? DEFAULT_ZENITY_PATH;
	const prompt = options.prompt ?? DEFAULT_FOLDER_PICKER_PROMPT;
	// With no display (a container, a server over SSH) zenity exits 1 with
	// nothing printed, which reads as a cancel: say there is no window, so the
	// page offers the typed path.
	if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
		return {
			ok: false,
			supported: false,
			cancelled: false,
			code: "folder_chooser_unavailable",
			error: "Folder chooser is unavailable because there is no display. Enter the path manually.",
		};
	}

	try {
		const result = await runner(zenityPath, linuxChooseFolderArgs(prompt, options.startAt), runnerOptions(options));
		const selectedPath = result.stdout.trim();
		if (!selectedPath) {
			return {
				ok: false,
				supported: true,
				cancelled: false,
				code: "choose_folder_failed",
				error: "Folder chooser did not return a folder path. Enter the path manually.",
			};
		}
		return { ok: true, supported: true, cancelled: false, path: selectedPath };
	} catch (error) {
		if (options.signal?.aborted) return STOPPED;
		if (isMissingOsascript(error)) {
			return {
				ok: false,
				supported: false,
				cancelled: false,
				code: "folder_chooser_unavailable",
				error: "Folder chooser is unavailable because zenity is not installed. Enter the path manually.",
			};
		}
		if (isTimeout(error)) {
			return {
				ok: false,
				supported: true,
				cancelled: false,
				code: "folder_chooser_timeout",
				error: "Folder chooser timed out. Enter the path manually.",
			};
		}
		if (isZenityCancellation(error)) return { ok: true, supported: true, cancelled: true, path: null };
		return {
			ok: false,
			supported: true,
			cancelled: false,
			code: "choose_folder_failed",
			error: "Folder chooser failed. Enter the path manually.",
		};
	}
}

// Platform dispatcher used by the web server; the macOS path is unchanged.
export async function chooseLocalFolder(options: ChooseLocalFolderOptions = {}): Promise<LocalFolderPickerResult> {
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") return chooseMacosFolder(options);
	if (platform === "win32") return chooseWindowsFolder(options);
	if (platform === "linux") return chooseLinuxFolder(options);
	return {
		ok: false,
		supported: false,
		cancelled: false,
		code: "unsupported_platform",
		error: "Folder chooser is only available on macOS, Windows, and Linux. Enter the path manually.",
	};
}
