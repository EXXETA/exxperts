// The tripwire's positive control: the four ways server code reaches a file or
// starts a program, each in the form the server's own modules use. A named
// import of a built-in is a binding fixed when its module loads, so these
// prove the recorder's wrappers reach such bindings too.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export function namedSyncImports(file: string): void {
	if (existsSync(file)) readFileSync(file, "utf8");
}

export async function namedPromisesImport(file: string): Promise<void> {
	await stat(file);
}

export function defaultImportNative(file: string): void {
	fs.realpathSync.native(file);
}

export async function startInFolder(file: string): Promise<void> {
	const child = spawn("/bin/test", ["-e", path.basename(file)], { cwd: path.dirname(file), stdio: "ignore" });
	await new Promise((resolve) => child.once("close", resolve));
}
