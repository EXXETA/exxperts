// The health check's contract: scripts/doctor.mjs is the one health check
// across all three install types (the desktop app's Health Check runs it).
// This smoke proves (1) the clone profile passes on a built repo and prints
// its install-type line and section headers, (2) the archive profile skips
// the clone-only checks and still exits 0 (the exit-code contract: optional
// layers and network probes are warnings, never failures, so a healthy CI
// machine always gets exit 0), (3) `--help` prints usage without running
// checks, and (4) the launcher's start checks (`--start-checks`) print
// nothing and exit 0 on a healthy clone. one-command-smoke.ts holds the
// failing side, through a failed `exxperts` start.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-doctor-home-"));
// A writable npm prefix keeps the clone profile's prefix-writability check
// deterministic under the temp HOME (the real default can be root-owned).
const tempPrefix = path.join(tempHome, "npm-prefix");
fs.mkdirSync(tempPrefix, { recursive: true });

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

function run(entry: string, args: string[]): { status: number | null; output: string } {
	const result = spawnSync(process.execPath, [path.join(repoRoot, entry), ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			HOME: tempHome,
			USERPROFILE: tempHome,
			npm_config_prefix: tempPrefix,
		},
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 120_000,
	});
	if (result.error) throw result.error;
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

try {
	// 1. Clone profile on a built repo: exit 0, install-type line, section headers,
	//    and the clone-only section present.
	{
		const { status, output } = run("scripts/doctor.mjs", ["--profile", "clone"]);
		assert(status === 0, `doctor --profile clone: expected exit 0, got ${status}:\n${output}`);
		assertIncludes(output, "install type: clone", "doctor --profile clone (install-type line)");
		assertIncludes(output, "Runtime and state", "doctor --profile clone (section header)");
		// Doctor says which tree it just judged: the data folder it resolved the
		// way the launchers do, and the profile loaded inside it.
		assertIncludes(output, `Data folder: ${tempHome}`, "doctor --profile clone (data folder line)");
		assertIncludes(output, "Loaded profile: standard", "doctor --profile clone (loaded profile line)");
		assertIncludes(output, "Clone (source install)", "doctor --profile clone (clone section)");
		assertIncludes(output, "Optional features", "doctor --profile clone (section header)");
		assertIncludes(output, "Network", "doctor --profile clone (section header)");
		assertIncludes(output, "All required checks passed", "doctor --profile clone (verdict)");
	}

	// 2. Archive profile forced on the repo tree: clone-only checks must not run,
	//    and the exit-code contract still yields 0 (the missing vendor/node is a
	//    warning under a --profile override, and optional layers never fail).
	{
		const { status, output } = run("scripts/doctor.mjs", ["--profile", "archive"]);
		assert(status === 0, `doctor --profile archive: expected exit 0, got ${status}:\n${output}`);
		assertIncludes(output, "install type: archive", "doctor --profile archive (install-type line)");
		assertIncludes(output, "Prebuilt archive install", "doctor --profile archive (archive section)");
		assertNotIncludes(output, "Clone (source install)", "doctor --profile archive (no clone section)");
		assertNotIncludes(output, "runtime built", "doctor --profile archive (no clone-only checks)");
		assertNotIncludes(output, "npm dependencies", "doctor --profile archive (no clone-only checks)");
	}

	// 3. `--help` prints usage fast (no checks run) and exits 0.
	{
		const { status, output } = run("scripts/doctor.mjs", ["--help"]);
		assert(status === 0, `doctor --help: expected exit 0, got ${status}:\n${output}`);
		assertIncludes(output, "Usage: node scripts/doctor.mjs", "doctor --help (usage line)");
		assertNotIncludes(output, "install type:", "doctor --help (must not run the checks)");
	}

	// 4. The start checks on a healthy clone: nothing to say, exit 0. Only a
	//    failing check prints, so a failed start shows only what is wrong.
	{
		const { status, output } = run("scripts/doctor.mjs", ["--start-checks"]);
		assert(status === 0, `doctor --start-checks: expected exit 0, got ${status}:\n${output}`);
		assert(output.trim() === "", `doctor --start-checks on a healthy clone must print nothing, got:\n${output}`);
	}

	console.log("doctor-smoke: OK");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
