import { execFile } from "node:child_process";

const MACOS_CHOOSE_FOLDER_SCRIPT = 'POSIX path of (choose folder with prompt "Choose workspace folder")';
const DEFAULT_CHOOSE_FOLDER_TIMEOUT_MS = 60_000;
const DEFAULT_OSASCRIPT_PATH = "/usr/bin/osascript";
const DEFAULT_POWERSHELL_PATH = "powershell.exe";
const DEFAULT_ZENITY_PATH = "zenity";

// zenity prints the selected path on stdout and exits 0; cancel exits 1 with empty stdout.
const LINUX_CHOOSE_FOLDER_ARGS = ["--file-selection", "--directory", '--title=Choose workspace folder'];

// Prints "OK:<path>" or "CANCEL" so selection, cancellation, and failure are unambiguous.
// The TopMost owner form keeps the dialog from opening behind the terminal/browser.
const WINDOWS_CHOOSE_FOLDER_SCRIPT = [
	"Add-Type -AssemblyName System.Windows.Forms",
	"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
	"$dialog.Description = 'Choose workspace folder'",
	"$dialog.ShowNewFolderButton = $true",
	"$owner = New-Object System.Windows.Forms.Form",
	"$owner.TopMost = $true",
	'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ("OK:" + $dialog.SelectedPath) } else { Write-Output "CANCEL" }',
].join("; ");

export type LocalFolderPickerRunner = (command: string, args: string[], options: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string }>;

export type LocalFolderPickerResult =
	| { ok: true; supported: true; cancelled: false; path: string }
	| { ok: true; supported: true; cancelled: true; path: null }
	| { ok: false; supported: false; cancelled: false; code: "unsupported_platform" | "folder_chooser_unavailable"; error: string }
	| { ok: false; supported: true; cancelled: false; code: "folder_chooser_timeout" | "choose_folder_failed"; error: string };

export interface ChooseMacosFolderOptions {
	platform?: NodeJS.Platform;
	runner?: LocalFolderPickerRunner;
	timeoutMs?: number;
	osascriptPath?: string;
}

export interface ChooseLocalFolderOptions extends ChooseMacosFolderOptions {
	powershellPath?: string;
	zenityPath?: string;
}

function defaultFolderPickerRunner(command: string, args: string[], options: { timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(command, args, {
			timeout: options.timeoutMs,
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

function isUserCancellation(error: unknown, stderr: string): boolean {
	const message = `${error instanceof Error ? error.message : String(error ?? "")}\n${stderr}`;
	return /user canceled|user cancelled|\(-128\)|-128/i.test(message);
}

function isMissingOsascript(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "EACCES";
}

function isTimeout(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	const signal = (error as { signal?: unknown } | undefined)?.signal;
	const killed = (error as { killed?: unknown } | undefined)?.killed;
	return code === "ETIMEDOUT" || signal === "SIGTERM" || killed === true;
}

export async function chooseMacosFolder(options: ChooseMacosFolderOptions = {}): Promise<LocalFolderPickerResult> {
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
	const timeoutMs = options.timeoutMs ?? DEFAULT_CHOOSE_FOLDER_TIMEOUT_MS;
	const osascriptPath = options.osascriptPath ?? DEFAULT_OSASCRIPT_PATH;

	try {
		const result = await runner(osascriptPath, ["-e", MACOS_CHOOSE_FOLDER_SCRIPT], { timeoutMs });
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
		const stderr = String((error as { stderr?: unknown } | undefined)?.stderr ?? "");
		if (isUserCancellation(error, stderr)) return { ok: true, supported: true, cancelled: true, path: null };
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

async function chooseWindowsFolder(options: ChooseLocalFolderOptions = {}): Promise<LocalFolderPickerResult> {
	const runner = options.runner ?? defaultFolderPickerRunner;
	const timeoutMs = options.timeoutMs ?? DEFAULT_CHOOSE_FOLDER_TIMEOUT_MS;
	const powershellPath = options.powershellPath ?? DEFAULT_POWERSHELL_PATH;

	try {
		const result = await runner(powershellPath, ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_CHOOSE_FOLDER_SCRIPT], { timeoutMs });
		const output = result.stdout.trim();
		if (output === "CANCEL") return { ok: true, supported: true, cancelled: true, path: null };
		if (output.startsWith("OK:")) {
			const selectedPath = output.slice(3).trim();
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
	const timeoutMs = options.timeoutMs ?? DEFAULT_CHOOSE_FOLDER_TIMEOUT_MS;
	const zenityPath = options.zenityPath ?? DEFAULT_ZENITY_PATH;

	try {
		const result = await runner(zenityPath, LINUX_CHOOSE_FOLDER_ARGS, { timeoutMs });
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
