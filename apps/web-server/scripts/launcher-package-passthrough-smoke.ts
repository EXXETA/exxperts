// Launcher package-command passthrough (GitHub issue #1): `exxperts install|
// remove|uninstall|update|list|config` are runtime package-manager commands,
// not rooms — the launcher must route them to the CLI runtime (like `setup`)
// instead of falling through to the rooms picker. `--help` without a package
// command must still show the launcher usage, while `exxperts install --help`
// must reach the runtime's install help (routing sits before the --help check).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-launcher-pkg-home-"));

const runtimeCli = path.join(repoRoot, "runtime", "packages", "coding-agent", "dist", "cli.js");
if (!fs.existsSync(runtimeCli)) {
	throw new Error(`runtime CLI not built (${runtimeCli}); run \`npm run build\` first`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, label: string): void {
	assert(haystack.includes(needle), `${label}: expected output to include ${JSON.stringify(needle)}; got:\n${haystack}`);
}

function assertNotIncludes(haystack: string, needle: string, label: string): void {
	assert(!haystack.includes(needle), `${label}: expected output not to include ${JSON.stringify(needle)}; got:\n${haystack}`);
}

function runLauncher(args: string[]): { status: number | null; output: string } {
	const result = spawnSync(process.execPath, [path.join(repoRoot, "bin", "exxperts.cjs"), ...args], {
		cwd: tempHome,
		env: {
			...process.env,
			HOME: tempHome,
			USERPROFILE: tempHome,
		},
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
	});
	if (result.error) throw result.error;
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// 1. `exxperts list` routes to the runtime package manager (fresh HOME → empty).
{
	const { status, output } = runLauncher(["list"]);
	assert(status === 0, `exxperts list: expected exit 0, got ${status}:\n${output}`);
	assertIncludes(output, "No packages installed.", "exxperts list");
	assertNotIncludes(output, "rooms picker", "exxperts list (must not print launcher usage)");
}

// 2. `exxperts --help` (no package command) still shows the launcher usage.
{
	const { status, output } = runLauncher(["--help"]);
	assert(status === 0, `exxperts --help: expected exit 0, got ${status}:\n${output}`);
	assertIncludes(output, "rooms picker", "exxperts --help");
	assertIncludes(output, "install|remove|update|list|config", "exxperts --help (package commands listed)");
}

// 3. `exxperts install --help` reaches the runtime's install help — proves the
//    passthrough sits before the launcher's --help check.
{
	const { status, output } = runLauncher(["install", "--help"]);
	assert(status === 0, `exxperts install --help: expected exit 0, got ${status}:\n${output}`);
	assertIncludes(output, "install <source>", "exxperts install --help");
	assertNotIncludes(output, "rooms picker", "exxperts install --help (must not print launcher usage)");
}

// 4. `exxperts uninstall` (runtime alias for remove) routes as well: with no
//    source it must answer with the runtime's remove usage, not the picker.
{
	const { output } = runLauncher(["uninstall"]);
	assertIncludes(output, "remove <source>", "exxperts uninstall");
	assertNotIncludes(output, "rooms picker", "exxperts uninstall (must not print launcher usage)");
}

fs.rmSync(tempHome, { recursive: true, force: true });
console.log("launcher-package-passthrough-smoke: OK");
