// The one command. `exxperts` with no word starts the app and opens the
// browser; `--help` prints exactly two lines; every word of the removed
// terminal app, and any word it does not know, prints the one removal line and
// exits 1; the hidden pieces (--version, web, --port, --no-open, setup
// chromium, doctor) still work and appear in no help. A start that fails says why:
// the launcher's own reason, then the failing start checks of
// scripts/doctor.mjs, never a stack. Throwaway HOMEs; the browser is a fake
// `open`/`xdg-open` on PATH that writes down the address it was given.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, smokeHomeEnv, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, symlinkOrSkip } from "./smoke-server-process.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-one-command-")));
const home = path.join(tempRoot, "home");
fs.mkdirSync(home, { recursive: true });

const HELP = "Usage: exxperts\nOpens exxperts in your browser. Everything else is in the app.\n";
const REMOVED = "The terminal app and its commands were removed in exxperts 0.15. Run `exxperts` to open the app; everything else is in the app.\n";
const VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version as string;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A rooms folder exported by the caller, or set in the checkout's .env,
// would point the started app at rooms outside the throwaway home, so every
// run here pins it inside that home (.env never replaces a value already set).
const homeEnv = (forHome: string, extra: Record<string, string | undefined> = {}) => smokeHomeEnv(forHome, { EXXETA_PERSISTENT_AGENTS_ROOT: path.join(forHome, "rooms"), ...extra });

function run(entry: string, args: string[], env: Record<string, string | undefined> = homeEnv(home)): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [entry, ...args], { cwd: tempRoot, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 120_000 });
	if (result.error) throw result.error;
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const exxperts = path.join(repoRoot, "bin", "exxperts.cjs");
const show = (args: string[]) => `exxperts ${args.join(" ")}`.trim();
// A stack trace's frames, or Node's "Require stack" list.
const hasStack = (text: string) => /^\s+at .+[:(]/m.test(text) || text.includes("Require stack");

let server: ChildProcessWithoutNullStreams | undefined;
try {
	// --- The help: exactly the two lines, exit 0, through every way in.
	for (const [entry, args] of [[exxperts, ["--help"]], [exxperts, ["-h"]], [exxperts, ["web", "--help"]], [path.join(repoRoot, "bin", "exxperts-web.cjs"), ["--help"]]] as const) {
		const result = run(entry, [...args]);
		assert(result.status === 0 && result.stdout === HELP && result.stderr === "", `${path.basename(entry)} ${args.join(" ")}: expected the two help lines and exit 0, got ${result.status} ${JSON.stringify(result)}`);
		assert(!result.stdout.includes("doctor"), `${path.basename(entry)} ${args.join(" ")}: the help must not name the hidden doctor`);
	}

	// --- Every removed word, and any unknown one: the one line, exit 1.
	const removed = [["cli"], ["exxcode"], ["exxperts-cli"], ["remote"], ["remote", "status"], ["setup"], ["setup", "search"], ["setup", "openai-compatible"], ["web", "setup"], ["install", "npm:example"], ["remove", "npm:example"], ["update"], ["list"], ["config"], ["ui"], ["nonsense"], ["--bogus"], ["cli", "--help"]];
	for (const args of removed) {
		const result = run(exxperts, args);
		assert(result.status === 1 && result.stderr === REMOVED && result.stdout === "", `${show(args)}: expected the removal line and exit 1, got ${result.status} ${JSON.stringify(result)}`);
	}
	assert(!fs.existsSync(path.join(home, ".exxperts")), "a removed word must not create the data folder");

	// --- The hidden pieces work.
	const version = run(exxperts, ["--version"]);
	assert(version.status === 0 && version.stdout === `exxperts ${VERSION}\n`, `exxperts --version: got ${JSON.stringify(version)}`);
	const chromiumHelp = run(exxperts, ["setup", "chromium", "--help"]);
	assert(chromiumHelp.status === 0 && chromiumHelp.stdout.startsWith("Usage: exxperts setup chromium") && !chromiumHelp.stdout.includes("Downloading"), `exxperts setup chromium --help: got ${JSON.stringify(chromiumHelp)}`);
	const chromiumStray = run(exxperts, ["setup", "chromium", "bogus"]);
	assert(chromiumStray.status === 1 && chromiumStray.stderr.includes("unexpected argument") && !chromiumStray.stdout.includes("Downloading"), `exxperts setup chromium bogus: got ${JSON.stringify(chromiumStray)}`);
	const noPortValue = run(exxperts, ["--port"]);
	assert(noPortValue.status === 2 && noPortValue.stderr === "--port requires a value\n", `exxperts --port: got ${JSON.stringify(noPortValue)}`);
	// `exxperts doctor` runs the full health check with its arguments and exits
	// with its code: 0 on this built clone (a writable npm prefix keeps the
	// prefix check steady, as in doctor-smoke), 2 for a bad --profile.
	const npmPrefix = path.join(tempRoot, "npm-prefix");
	fs.mkdirSync(npmPrefix);
	const doctor = run(exxperts, ["doctor"], homeEnv(home, { npm_config_prefix: npmPrefix }));
	assert(doctor.status === 0 && doctor.stdout.startsWith("exxperts health check") && doctor.stdout.includes("install type: clone") && doctor.stdout.includes("All required checks passed"), `exxperts doctor: expected the health check and exit 0, got ${doctor.status} ${JSON.stringify(doctor)}`);
	const doctorBadProfile = run(exxperts, ["doctor", "--profile", "bogus"]);
	assert(doctorBadProfile.status === 2 && doctorBadProfile.stderr.startsWith("Usage: node scripts/doctor.mjs") && doctorBadProfile.stdout === "", `exxperts doctor --profile bogus: expected the health check's usage and exit 2, got ${JSON.stringify(doctorBadProfile)}`);

	// --- Bare `exxperts` starts the app and opens the browser at the sign-in link.
	if (process.platform === "win32") {
		console.log("one-command smoke: the browser start is skipped on Windows (the launcher opens it through cmd start, which no fake on PATH replaces)");
	} else {
		const fakeBin = path.join(tempRoot, "fake-bin");
		const opened = path.join(tempRoot, "opened.log");
		fs.mkdirSync(fakeBin);
		for (const name of ["open", "xdg-open"]) fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opened}'\n`, { mode: 0o755 });
		const port = await freePort();
		server = spawn(process.execPath, [exxperts, "--port", String(port)], {
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: tempRoot,
			env: homeEnv(home, { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`, EXXPERTS_AUTH_TOKEN: undefined }) as NodeJS.ProcessEnv,
		});
		let output = "";
		server.stdout.on("data", (chunk) => { output += String(chunk); });
		server.stderr.on("data", (chunk) => { output += String(chunk); });
		const deadline = Date.now() + 180_000;
		while (!fs.existsSync(opened) && server.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
		assert(fs.existsSync(opened), `bare exxperts must open the browser once the app answers, got exit ${server.exitCode}:\n${output}`);
		const health = await fetch(`http://localhost:${port}/healthz`);
		assert(health.ok, `the app must answer on its port, got ${health.status}`);
		const link = fs.readFileSync(opened, "utf8").trim();
		assert(new RegExp(`^http://localhost:${port}/auth/session\\?token=.+`).test(link), `the browser must open at the sign-in link, got ${JSON.stringify(link)}`);
		await stopSmokeServer(server);
		server = undefined;
	}

	// --- A failed start says why: an unwritable data folder.
	if (process.platform === "win32" || process.getuid?.() === 0) {
		console.log("one-command smoke: the unwritable data folder is skipped (Windows, or running as root, where permissions do not hold)");
	} else {
		const lockedHome = path.join(tempRoot, "locked-home");
		const appDir = path.join(lockedHome, ".exxperts", "app");
		fs.mkdirSync(appDir, { recursive: true });
		fs.chmodSync(appDir, 0o500);
		try {
			const result = run(exxperts, ["--no-open", "--port", String(await freePort())], homeEnv(lockedHome));
			const text = result.stdout + result.stderr;
			assert(result.status === 1, `an unwritable data folder must fail the start with exit 1, got ${result.status}:\n${text}`);
			assert(result.stderr.startsWith("Could not create the exxperts data folders: EACCES"), `the launcher's own reason comes first, got:\n${text}`);
			assert(text.includes(`✗ state dirs not writable by this user: ${path.join(lockedHome, ".exxperts", "app")}`), `the failing start check is named, got:\n${text}`);
			assert(!text.includes("✓") && !text.includes("Optional features"), `only failing checks are shown, got:\n${text}`);
			assert(!hasStack(text), `no stack, got:\n${text}`);
		} finally {
			fs.chmodSync(appDir, 0o700);
		}
	}

	// --- A failed start the launcher cannot explain itself: a clone whose
	// dependencies were never installed. The start checks name the fix.
	{
		const clone = path.join(tempRoot, "bare-clone");
		fs.mkdirSync(path.join(clone, ".git"), { recursive: true });
		fs.mkdirSync(path.join(clone, "scripts"));
		fs.cpSync(path.join(repoRoot, "bin"), path.join(clone, "bin"), { recursive: true });
		fs.copyFileSync(path.join(repoRoot, "scripts", "doctor.mjs"), path.join(clone, "scripts", "doctor.mjs"));
		fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(clone, "package.json"));
		const cloneHome = path.join(tempRoot, "clone-home");
		fs.mkdirSync(cloneHome);
		const result = run(path.join(clone, "bin", "exxperts.cjs"), ["--no-open", "--port", String(await freePort())], homeEnv(cloneHome));
		const text = result.stdout + result.stderr;
		assert(result.status === 1, `a clone without dependencies must fail the start with exit 1, got ${result.status}:\n${text}`);
		assert(result.stderr.startsWith("Could not start exxperts: Cannot find module"), `the launcher's own reason comes first, got:\n${text}`);
		assert(text.includes("✗ npm dependencies missing") && text.includes("fix: run `npm install` from the repo root"), `the missing dependencies are named with their fix, got:\n${text}`);
		assert(text.includes("✗ runtime not built, the server will not start"), `the unbuilt runtime is named, got:\n${text}`);
		assert(!hasStack(text), `no stack, got:\n${text}`);

		// The same clone with its dependencies found, where the server itself
		// dies while starting (as when the runtime was never built): Node's
		// crash dump comes down to its error line, then the start checks.
		if (symlinkOrSkip(path.join(repoRoot, "node_modules"), path.join(clone, "node_modules"), "one-command smoke", "the server dying while starting", "dir")) {
			fs.mkdirSync(path.join(clone, "apps", "web-server", "src"), { recursive: true });
			fs.writeFileSync(path.join(clone, "apps", "web-server", "src", "index.ts"), 'import "@exxeta/no-such-package";\n');
			const dying = run(path.join(clone, "bin", "exxperts.cjs"), ["--no-open", "--port", String(await freePort())], homeEnv(cloneHome));
			const dyingText = dying.stdout + dying.stderr;
			assert(dying.status === 1, `a server dying while starting must fail the start with exit 1, got ${dying.status}:\n${dyingText}`);
			assert(/^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package '@exxeta\/no-such-package'/m.test(dying.stderr), `the server's error line is shown, got:\n${dyingText}`);
			assert(dying.stderr.includes("The exxperts server stopped while starting (exit code 1).") && dyingText.includes("✗ runtime not built, the server will not start"), `the launcher's reason and the start checks follow, got:\n${dyingText}`);
			assert(!hasStack(dyingText) && !dyingText.includes("Node.js v") && !/^\s*\^+\s*$/m.test(dyingText), `no stack and no crash dump, got:\n${dyingText}`);

			// The same with no frames at all: Node then prints the error inspected
			// ("[Error …] {", its fields) between the same excerpt and footer.
			const frameless = run(path.join(clone, "bin", "exxperts.cjs"), ["--no-open", "--port", String(await freePort())], homeEnv(cloneHome, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --stack-trace-limit=0`.trim() }));
			const framelessText = frameless.stdout + frameless.stderr;
			assert(frameless.status === 1 && /^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package '@exxeta\/no-such-package'/m.test(frameless.stderr) && frameless.stderr.includes("The exxperts server stopped while starting (exit code 1)."), `without frames, the server's error line and the launcher's reason are shown, got ${frameless.status}:\n${framelessText}`);
			assert(!framelessText.includes("Node.js v") && !/^\s*\^+\s*$/m.test(framelessText) && !framelessText.includes("triggerUncaughtException") && !framelessText.includes("code: '"), `without frames, no crash dump either, got:\n${framelessText}`);

			// The same, but the server dies only after the launcher has said the
			// first start is slow: still no crash dump.
			fs.writeFileSync(path.join(clone, "apps", "web-server", "src", "index.ts"), 'await new Promise((resolve) => setTimeout(resolve, 15_000));\nawait import("@exxeta/no-such-package");\n');
			const slow = run(path.join(clone, "bin", "exxperts.cjs"), ["--no-open", "--port", String(await freePort())], homeEnv(cloneHome));
			const slowText = slow.stdout + slow.stderr;
			assert(slow.status === 1 && slowText.includes("The first start after an install or update can be slow; still waiting."), `a slow server dying while starting must fail the start with exit 1 after the slow notice, got ${slow.status}:\n${slowText}`);
			assert(slow.stderr.includes("Cannot find package '@exxeta/no-such-package'") && slow.stderr.includes("The exxperts server stopped while starting (exit code 1)."), `the server's error line and the launcher's reason are shown, got:\n${slowText}`);
			assert(!hasStack(slowText) && !slowText.includes("Node.js v"), `no stack after the slow notice either, got:\n${slowText}`);
		}
	}

	console.log("one-command smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
