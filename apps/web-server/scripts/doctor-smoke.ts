// Doctor CLI contract: `exxperts doctor` is the one health check across all
// three install types. This smoke proves (1) the clone profile passes on a
// built repo and prints its install-type line and section headers, (2) the
// archive profile skips the clone-only checks and still exits 0 (the exit-code
// contract: optional layers and network probes are warnings, never failures,
// so a healthy CI machine always gets exit 0), (3) the launcher routes
// `exxperts doctor` through to the script and `doctor --help` prints usage
// without running checks, (4) the launcher's setup interception is limited to
// the literal "chromium"/"search" subcommands: any other `exxperts setup <x>`
// must still reach the runtime CLI, and (5) the setup guardrails: bare `setup`
// prints a launcher-side usage listing all targets, `setup chromium --help`
// prints usage without downloading, and stray arguments are rejected.
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

	// 3. The launcher routes `exxperts doctor` through to the script.
	{
		const { status, output } = run("bin/exxperts.cjs", ["doctor", "--profile", "clone"]);
		assert(status === 0, `exxperts doctor --profile clone: expected exit 0, got ${status}:\n${output}`);
		assertIncludes(output, "install type: clone", "exxperts doctor (routed to doctor.mjs)");
	}

	// 4. `doctor --help` prints usage fast (no checks run) and exits 0.
	{
		const { status, output } = run("bin/exxperts.cjs", ["doctor", "--help"]);
		assert(status === 0, `exxperts doctor --help: expected exit 0, got ${status}:\n${output}`);
		assertIncludes(output, "Usage: exxperts doctor", "exxperts doctor --help (usage line)");
		assertNotIncludes(output, "install type:", "exxperts doctor --help (must not run the checks)");
	}

	// 5. Only the literal "chromium"/"search" setup subcommands are intercepted:
	//    any other target must reach the runtime CLI's setup handler unchanged.
	//    The expected wording is coupled to the runtime's setup handler in
	//    runtime/packages/coding-agent/src/cli/setup-openai-compatible.ts; if
	//    this assertion starts failing on the needle, check that file first.
	{
		const { output } = run("bin/exxperts.cjs", ["setup", "nonsense"]);
		assertIncludes(output, "Unknown setup target: nonsense", "exxperts setup nonsense (must reach the runtime CLI)");
		assertNotIncludes(output, "Downloading headless Chromium", "exxperts setup nonsense (must not run the chromium installer)");
		assertNotIncludes(output, "SearXNG", "exxperts setup nonsense (must not run the search helper)");
	}

	// 6. Bare `exxperts setup` prints the three-target usage in the launcher and
	//    never reaches the runtime (whose usage only knows openai-compatible).
	{
		const { status, output } = run("bin/exxperts.cjs", ["setup"]);
		assert(status === 0, `exxperts setup: expected exit 0, got ${status}:\n${output}`);
		assertIncludes(output, "chromium", "exxperts setup (usage lists chromium)");
		assertIncludes(output, "search", "exxperts setup (usage lists search)");
		assertIncludes(output, "openai-compatible", "exxperts setup (usage lists openai-compatible)");
		assertNotIncludes(output, "Unknown setup target", "exxperts setup (must not reach the runtime CLI)");
		assertNotIncludes(output, "Downloading headless Chromium", "exxperts setup (must not start a download)");
	}

	// 7. `setup chromium --help` prints usage without downloading; extra args are
	//    rejected instead of silently starting a 150 MB download.
	{
		const { status, output } = run("bin/exxperts.cjs", ["setup", "chromium", "--help"]);
		assert(status === 0, `exxperts setup chromium --help: expected exit 0, got ${status}:\n${output}`);
		assertIncludes(output, "Usage: exxperts setup chromium", "setup chromium --help (usage line)");
		assertNotIncludes(output, "Downloading headless Chromium", "setup chromium --help (must not download)");
	}
	{
		const { status, output } = run("bin/exxperts.cjs", ["setup", "chromium", "bogus"]);
		assert(status === 1, `exxperts setup chromium bogus: expected exit 1, got ${status}:\n${output}`);
		assertIncludes(output, "unexpected argument", "setup chromium bogus (rejection message)");
		assertNotIncludes(output, "Downloading headless Chromium", "setup chromium bogus (must not download)");
	}

	console.log("doctor-smoke: OK");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
