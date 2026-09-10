import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getToolPath resolves in order: bundled (EXXETA_BUNDLED_TOOLS_DIR, set by a
// host app that ships the binary) -> the managed bin dir -> system PATH.
// TOOLS_DIR binds at module load, so every test imports a fresh module after
// pointing the agent dir at a temp location; the bundled dir is read per call.

const exe = process.platform === "win32" ? ".exe" : "";

let tempRoot: string;
let agentDir: string;
let bundledDir: string;
let savedAgentDir: string | undefined;
let savedBundledDir: string | undefined;

async function loadToolsManager() {
	vi.resetModules();
	return await import("../src/utils/tools-manager.js");
}

function placeBinary(dir: string, name: string, mode = 0o755): string {
	const filePath = join(dir, name + exe);
	writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
	chmodSync(filePath, mode);
	return filePath;
}

describe("bundled tool lookup", () => {
	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "tools-manager-bundled-"));
		agentDir = join(tempRoot, "agent");
		bundledDir = join(tempRoot, "bundled");
		mkdirSync(join(agentDir, "bin"), { recursive: true });
		mkdirSync(bundledDir, { recursive: true });
		savedAgentDir = process.env.EXXPERTS_CODING_AGENT_DIR;
		savedBundledDir = process.env.EXXETA_BUNDLED_TOOLS_DIR;
		process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
		delete process.env.EXXETA_BUNDLED_TOOLS_DIR;
	});

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env.EXXPERTS_CODING_AGENT_DIR;
		else process.env.EXXPERTS_CODING_AGENT_DIR = savedAgentDir;
		if (savedBundledDir === undefined) delete process.env.EXXETA_BUNDLED_TOOLS_DIR;
		else process.env.EXXETA_BUNDLED_TOOLS_DIR = savedBundledDir;
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("prefers the bundled binary over an already-downloaded one", async () => {
		placeBinary(join(agentDir, "bin"), "rg");
		const bundledRg = placeBinary(bundledDir, "rg");
		process.env.EXXETA_BUNDLED_TOOLS_DIR = bundledDir;

		const { getToolPath } = await loadToolsManager();
		expect(getToolPath("rg")).toBe(bundledRg);
	});

	it("falls through to the normal lookup when the bundled dir lacks the binary", async () => {
		const downloadedRg = placeBinary(join(agentDir, "bin"), "rg");
		process.env.EXXETA_BUNDLED_TOOLS_DIR = bundledDir; // exists, but empty

		const { getToolPath } = await loadToolsManager();
		expect(getToolPath("rg")).toBe(downloadedRg);

		// And with the env var pointing nowhere at all
		process.env.EXXETA_BUNDLED_TOOLS_DIR = join(tempRoot, "does-not-exist");
		expect(getToolPath("rg")).toBe(downloadedRg);
	});

	it("resolves exactly as before when the env var is unset", async () => {
		const downloadedRg = placeBinary(join(agentDir, "bin"), "rg");
		// A binary sitting in what WOULD be the bundled dir must not be found
		placeBinary(bundledDir, "rg");

		const { getToolPath } = await loadToolsManager();
		expect(getToolPath("rg")).toBe(downloadedRg);
	});

	it.skipIf(process.platform === "win32")("ignores a bundled file that is not executable", async () => {
		const downloadedRg = placeBinary(join(agentDir, "bin"), "rg");
		placeBinary(bundledDir, "rg", 0o644);
		process.env.EXXETA_BUNDLED_TOOLS_DIR = bundledDir;

		const { getToolPath } = await loadToolsManager();
		expect(getToolPath("rg")).toBe(downloadedRg);
	});

	it("applies the same lookup to fd", async () => {
		placeBinary(join(agentDir, "bin"), "fd");
		const bundledFd = placeBinary(bundledDir, "fd");
		process.env.EXXETA_BUNDLED_TOOLS_DIR = bundledDir;

		const { getToolPath } = await loadToolsManager();
		expect(getToolPath("fd")).toBe(bundledFd);
	});
});
