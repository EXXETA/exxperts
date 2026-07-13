import { chooseLocalFolder, chooseMacosFolder, type LocalFolderPickerRunner } from "../src/local-folder-picker.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
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
		return { stdout: "/Users/example/Workspace Folder/\n", stderr: "" };
	};
	const selected = await chooseMacosFolder({ platform: "darwin", runner: selectedRunner, timeoutMs: 1234, osascriptPath: "/custom/osascript" });
	assert(selected.ok && !selected.cancelled, `selected folder should succeed: ${JSON.stringify(selected)}`);
	assert(selected.path === "/Users/example/Workspace Folder/", `selected path should be trimmed, got ${selected.path}`);
	assert(capturedCommand === "/custom/osascript", `runner should receive configured osascript path, got ${capturedCommand}`);
	assert(capturedArgs.length === 2 && capturedArgs[0] === "-e", `runner should receive osascript -e args, got ${capturedArgs.join(" ")}`);
	assert(capturedArgs[1]?.includes("choose folder"), "osascript should invoke native choose folder dialog");
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
		const error = new Error("Command failed: zenity") as NodeJS.ErrnoException & { code: unknown };
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

	console.log("system choose-folder smoke passed");
}

await main();
