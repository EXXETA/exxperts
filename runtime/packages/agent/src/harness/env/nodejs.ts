import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type ExecutionEnv, FileError, type FileInfo, type FileKind } from "../types.js";

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function fileKindFromStats(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	throw new FileError("invalid", "Unsupported file type");
}

function fileInfoFromStats(
	path: string,
	stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): FileInfo {
	return {
		name: basename(path) || path,
		path,
		kind: fileKindFromStats(stats),
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, path?: string): FileError {
	if (error instanceof FileError) return error;
	if (isNodeError(error)) {
		const message = error.message;
		switch (error.code) {
			case "ENOENT":
				return new FileError("not_found", message, path, { cause: error });
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, { cause: error });
			case "ENOTDIR":
				return new FileError("not_directory", message, path, { cause: error });
			case "EISDIR":
				return new FileError("is_directory", message, path, { cause: error });
			case "EINVAL":
				return new FileError("invalid", message, path, { cause: error });
		}
	}
	return new FileError("unknown", error instanceof Error ? error.message : String(error), path, { cause: error });
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
	return await new Promise((resolve) => {
		let stdout = "";
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
		const timeout = setTimeout(() => {
			if (child.pid) killProcessTree(child.pid);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve({ stdout: "", status: null });
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			resolve({ stdout, status });
		});
	});
}

async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000)
			: await runCommand("which", ["bash"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

// Windows: derive Git Bash from git's own install location. git.exe is usually
// on PATH while bash.exe deliberately is not (Git's recommended setup), and
// no-admin per-user installs live under AppData instead of Program Files, so
// <install root>\cmd\git.exe -> <install root>\bin\bash.exe is the reliable route.
async function findGitBashViaGit(): Promise<string | null> {
	const result = await runCommand("where", ["git.exe"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	if (!firstMatch) return null;
	const candidate = join(dirname(dirname(firstMatch)), "bin", "bash.exe");
	return (await pathExists(candidate)) ? candidate : null;
}

async function getShellConfig(customShellPath?: string): Promise<{ shell: string; args: string[] }> {
	if (customShellPath) {
		if (await pathExists(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return { shell: candidate, args: ["-c"] };
			}
		}
		const bashNearGit = await findGitBashViaGit();
		if (bashNearGit) {
			return { shell: bashNearGit, args: ["-c"] };
		}
		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			return { shell: bashOnPath, args: ["-c"] };
		}
		throw new Error("No bash shell found");
	}

	if (await pathExists("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}
	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}
	return { shell: "sh", args: ["-c"] };
}

function getShellEnv(baseEnv?: NodeJS.ProcessEnv, extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors.
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
	}
}

export class NodeExecutionEnv implements ExecutionEnv {
	cwd: string;
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;

	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeout?: number;
			signal?: AbortSignal;
			onStdout?: (chunk: string) => void;
			onStderr?: (chunk: string) => void;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const { shell, args } = await getShellConfig(this.shellPath);

		return await new Promise((resolvePromise, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			const child = spawn(shell, [...args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: getShellEnv(this.shellEnv, options?.env),
				stdio: ["ignore", "pipe", "pipe"],
			});

			const timeoutId =
				typeof options?.timeout === "number"
					? setTimeout(() => {
							timedOut = true;
							if (child.pid) {
								killProcessTree(child.pid);
							}
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};
			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
				options?.onStdout?.(chunk);
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
				options?.onStderr?.(chunk);
			});

			child.on("error", (error) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) options.signal.removeEventListener("abort", onAbort);
				if (settled) return;
				settled = true;
				reject(error);
			});

			child.on("close", (code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) options.signal.removeEventListener("abort", onAbort);
				if (settled) return;
				settled = true;
				if (options?.signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				if (timedOut) {
					reject(new Error(`timeout:${options?.timeout}`));
					return;
				}
				resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
			});
		});
	}

	async readTextFile(path: string): Promise<string> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return await readFile(resolved, "utf8");
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async readBinaryFile(path: string): Promise<Uint8Array> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return await readFile(resolved);
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			await writeFile(resolved, content);
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async fileInfo(path: string): Promise<FileInfo> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async listDir(path: string): Promise<FileInfo[]> {
		const resolved = resolvePath(this.cwd, path);
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const entryPath = resolve(resolved, entry.name);
				try {
					infos.push(fileInfoFromStats(entryPath, await lstat(entryPath)));
				} catch (error) {
					if (error instanceof FileError && error.code === "invalid") continue;
					throw error;
				}
			}
			return infos;
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async realPath(path: string): Promise<string> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return await realpath(resolved);
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.fileInfo(path);
			return true;
		} catch (error) {
			if (error instanceof FileError && error.code === "not_found") return false;
			throw error;
		}
	}

	async createDir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await mkdir(resolvePath(this.cwd, path), { recursive: options?.recursive });
	}

	async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
		} catch (error) {
			throw toFileError(error, resolved);
		}
	}

	async createTempDir(prefix: string = "tmp-"): Promise<string> {
		return await mkdtemp(join(tmpdir(), prefix));
	}

	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<string> {
		const dir = await this.createTempDir("tmp-");
		const filePath = join(dir, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		await writeFile(filePath, "");
		return filePath;
	}

	async cleanup(): Promise<void> {
		// nothing to clean up for the local node implementation
	}
}
