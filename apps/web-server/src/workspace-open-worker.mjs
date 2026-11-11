// Private Windows dispatcher. The parent supplies one already-guarded path.
import path from "node:path";

async function openFile(file) {
	if (process.platform !== "win32" || process.arch !== "x64") return { accepted: false, code: "opener_unavailable" };
	let initialize, uninitialize, setLastError, getLastError, shellExecute;
	try {
		const { default: koffi } = await import("koffi");
		if (koffi.version !== "2.16.2") return { accepted: false, code: "opener_unavailable" };
		const infoType = koffi.struct("T4_SHELLEXECUTEINFOW", {
			cbSize: "uint32_t", fMask: "uint32_t", hwnd: "void *", lpVerb: "const char16_t *", lpFile: "const char16_t *",
			lpParameters: "const char16_t *", lpDirectory: "const char16_t *", nShow: "int32_t", hInstApp: "void *", lpIDList: "void *",
			lpClass: "const char16_t *", hkeyClass: "void *", dwHotKey: "uint32_t", hIcon: "void *", hProcess: "void *",
		});
		const names = ["cbSize", "fMask", "hwnd", "lpVerb", "lpFile", "lpParameters", "lpDirectory", "nShow", "hInstApp", "lpIDList", "lpClass", "hkeyClass", "dwHotKey", "hIcon", "hProcess"];
		const offsets = [0, 4, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104];
		if (koffi.sizeof(infoType) !== 112 || names.some((name, i) => koffi.offsetof(infoType, name) !== offsets[i])) return { accepted: false, code: "opener_unavailable" };
		const kernel = koffi.load("kernel32.dll");
		const getSystemDirectory = kernel.func("uint32_t __stdcall GetSystemDirectoryW(_Out_ char16_t *buffer, uint32_t size)");
		setLastError = kernel.func("void __stdcall SetLastError(uint32_t code)");
		getLastError = kernel.func("uint32_t __stdcall GetLastError(void)");
		const buffer = Buffer.alloc(65_536);
		const length = getSystemDirectory(buffer, 32_768);
		if (!Number.isInteger(length) || length < 1 || length >= 32_768) return { accepted: false, code: "opener_unavailable" };
		const directory = buffer.toString("utf16le", 0, length * 2);
		if (!/^[A-Za-z]:\\/.test(directory) || !path.win32.isAbsolute(directory)) return { accepted: false, code: "opener_unavailable" };
		const ole = koffi.load(path.win32.join(directory, "ole32.dll"));
		const shell = koffi.load(path.win32.join(directory, "shell32.dll"));
		initialize = ole.func("int32_t __stdcall CoInitializeEx(void *reserved, uint32_t flags)");
		uninitialize = ole.func("void __stdcall CoUninitialize(void)");
		shellExecute = shell.func("int32_t __stdcall ShellExecuteExW(_Inout_ T4_SHELLEXECUTEINFOW *info)");
	} catch { return { accepted: false, code: "opener_unavailable" }; }
	let initialized = false;
	try {
		const status = initialize(null, 0x6);
		if (status !== 0 && status !== 1) return { accepted: false, code: "opener_unavailable" };
		initialized = true;
		const info = { cbSize: 112, fMask: 0x500, hwnd: null, lpVerb: "open", lpFile: file, lpParameters: null, lpDirectory: null, nShow: 1,
			hInstApp: null, lpIDList: null, lpClass: null, hkeyClass: null, dwHotKey: 0, hIcon: null, hProcess: null };
		setLastError(0);
		const accepted = shellExecute(info);
		const error = accepted ? 0 : getLastError();
		if (accepted) return { accepted: true };
		if ([1155, 126, 1157, 1459].includes(error)) return { accepted: false, code: "opener_unavailable" };
		if (error === 1460) return { accepted: false, code: "open_timeout" };
		return { accepted: false, code: "open_failed" };
	} catch { return { accepted: false, code: "open_failed" }; }
	finally { if (initialized) uninitialize(); }
}

let received = false;
process.on("message", async (message) => {
	if (received) return;
	received = true;
	const valid = message && typeof message === "object" && !Array.isArray(message)
		&& Object.keys(message).length === 1 && typeof message.path === "string" && message.path.length > 0
		&& !message.path.includes("\0") && /^[A-Za-z]:\\/.test(message.path)
		&& path.win32.isAbsolute(message.path) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(message.path)
		&& message.path.slice(3).split("\\").every((part) => part && part !== "." && part !== ".." && !/[<>:"/\\|?*\x00-\x1f]/.test(part)
			&& !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
	const result = valid ? await openFile(message.path) : { accepted: false, code: "open_failed" };
	process.send?.(result, () => process.disconnect?.());
});
