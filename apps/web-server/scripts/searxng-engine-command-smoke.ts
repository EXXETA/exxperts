// The search helper and the container engine it drives.
//
// An app opened from the Dock gets a bare PATH, so the helper finds the engine
// command by its install location and then runs it with that folder on PATH:
// docker fetches registry logins through helpers installed next to it, and
// without the folder an image download fails. This drives the helper with a
// stub engine named outright (SEARXNG_CONTAINER_CLI) under that bare PATH, and
// proves the stub's answer reaches the app's one-word runtime check and the
// stub saw its own folder on PATH.
//
// Run: node scripts/run-smokes.mjs searxng-engine-command

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const helper = path.join(repoRoot, "scripts", "searxng.mjs");

if (process.platform === "win32") {
	// The stub engine is a shell script; Windows cannot run one without a shell.
	console.log("searxng engine command smoke skipped: the stub engine is a shell script, which Windows cannot run");
	process.exit(0);
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-searxng-engine-"));
const binDir = path.join(tempHome, "engine-bin");
fs.mkdirSync(binDir);
const stub = path.join(binDir, "podman");
const seenPath = path.join(tempHome, "seen-path");

function runtimeWith(infoExit: number): string {
	fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s' "$PATH" > '${seenPath}'\n[ "$1" = info ] && exit ${infoExit}\nexit 0\n`, { mode: 0o755 });
	const res = spawnSync(process.execPath, [helper, "runtime"], {
		encoding: "utf8",
		env: { HOME: tempHome, EXXPERTS_STATE_HOME: tempHome, PATH: "/usr/bin:/bin", SEARXNG_CONTAINER_CLI: stub },
	});
	assert(res.status === 0, `runtime exited ${res.status}: ${res.stderr}`);
	return res.stdout.trim();
}

try {
	assert(runtimeWith(0) === "up", "an engine whose info answers reads as up");
	const seen = fs.readFileSync(seenPath, "utf8").split(path.delimiter);
	assert(seen[0] === binDir, `the engine runs with its own folder first on PATH, saw ${seen.join(path.delimiter)}`);
	assert(seen.includes("/usr/bin"), "the PATH it was given is kept behind that folder");
	assert(runtimeWith(1) === "stopped", "an engine whose info fails reads as stopped");
	console.log("searxng engine command smoke: ok");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
