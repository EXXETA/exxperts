import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findShellConfig,
	getShellConfig,
	isNoShellFoundMessage,
	setShellLookupPlatformForTests,
} from "../src/utils/shell.js";

// The Windows lookup walked on any machine: the platform is faked, and the
// Program Files folder points at a temp dir. The path the lookup builds there
// uses backslashes, which on macOS and Linux is one file name, so a link by
// that name stands in for an installed Git Bash.
describe.skipIf(process.platform === "win32")("shell lookup on a faked Windows", () => {
	let dir: string;
	const saved = { ProgramFiles: process.env.ProgramFiles, x86: process.env["ProgramFiles(x86)"], LOCALAPPDATA: process.env.LOCALAPPDATA };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "shell-lookup-"));
		mkdirSync(join(dir, "pf"));
		process.env.ProgramFiles = join(dir, "pf");
		delete process.env["ProgramFiles(x86)"];
		delete process.env.LOCALAPPDATA;
		setShellLookupPlatformForTests("win32");
	});

	afterEach(() => {
		setShellLookupPlatformForTests(undefined);
		for (const [key, value] of [["ProgramFiles", saved.ProgramFiles], ["ProgramFiles(x86)", saved.x86], ["LOCALAPPDATA", saved.LOCALAPPDATA]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds no shell, then finds one installed after the first look", () => {
		expect(findShellConfig()).toBeNull();
		let message = "";
		try {
			getShellConfig();
		} catch (error) {
			message = (error as Error).message;
		}
		expect(isNoShellFoundMessage(message)).toBe(true);

		const gitBash = `${join(dir, "pf")}\\Git\\bin\\bash.exe`;
		symlinkSync("/bin/sh", gitBash);
		expect(findShellConfig()).toEqual({ shell: gitBash, args: ["-c"] });
		expect(getShellConfig().shell).toBe(gitBash);
	});

	it("does not take a custom shell path that does not exist for no shell", () => {
		expect(() => findShellConfig(join(dir, "no-such-bash.exe"))).toThrow(/^Custom shell path not found/);
	});

	it("leaves the real platform alone once the fake is cleared", () => {
		setShellLookupPlatformForTests(undefined);
		expect(findShellConfig()).not.toBeNull();
	});
});

describe("shell lookup with a custom shell path", () => {
	it("does not take a path that does not exist for no shell", () => {
		expect(() => findShellConfig(join(tmpdir(), "shell-lookup-no-such-bash"))).toThrow(/^Custom shell path not found/);
	});
});

describe("isNoShellFoundMessage", () => {
	it("knows only the lookup's own failure", () => {
		expect(isNoShellFoundMessage("Command exited with code 127")).toBe(false);
		expect(isNoShellFoundMessage("Custom shell path not found: /x")).toBe(false);
	});
});
