// The smoke runner (scripts/run-smokes.mjs) puts this file in NODE_OPTIONS for
// every smoke but those in KEEP_REAL_FLUSH, so the smoke and every Node process
// it starts (npx, tsx, its servers) load it first. Loaded that way, with the
// runner's temp folder in its address, it makes fs.fsyncSync answer without
// flushing the drive. On a Mac each flush empties the drive's cache, about 4 ms,
// and the smokes make tens of thousands; none cuts the power, so none needs the
// bytes on the drive itself. The kill-at-write smokes prove the order of the
// flush calls from their own trace (kill-at-write-harness.ts), which still sees
// every call: their preload loads after this one and wraps it.
//
// It refuses to load unless the process's home is inside that temp folder, where
// the runner makes each smoke's home: a person's app never runs there. The folder
// comes in the address, not from the process's own temp folder, since a smoke
// may start a process with another TMPDIR (tripwire/run.ts, skills-upload-smoke.ts).
// Imported with no temp folder, as the runner and smoke-no-flush-smoke.ts do, it
// changes nothing and only gives the list and the option below.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

/** Smokes that run with the real flush, so a battery still makes it. */
export const KEEP_REAL_FLUSH = [
	// The fsync row asks this drive to flush a file and a folder; under the no-op it would pass without asking.
	"folder-contract-smoke.ts",
	"folder-contract-faults-smoke.ts",
	// One run end to end with every flush real: a room made, turns saved, a rename, Remember.
	"room-state-message-smoke.ts",
];

/** Where the no-op keeps its count of the flushes it skipped, for smoke-no-flush-smoke.ts. */
export const SKIPPED_FLUSHES = Symbol.for("exxperts.smoke-no-flush.skipped");

/** The NODE_OPTIONS a smoke runs with: nodeOptions, plus this file for a smoke not on the list, whose home is inside tempFolder. */
export function noFlushNodeOptions(nodeOptions, smokeName, tempFolder) {
	if (KEEP_REAL_FLUSH.includes(smokeName)) return nodeOptions;
	const address = new URL(import.meta.url);
	address.search = new URLSearchParams({ temp: tempFolder }).toString();
	return [nodeOptions, `--import=${address.href}`].filter(Boolean).join(" ");
}

function realPath(folder) {
	try {
		return fs.realpathSync.native(folder);
	} catch {
		return undefined;
	}
}

const tempFolder = new URL(import.meta.url).searchParams.get("temp");
if (tempFolder !== null) {
	const home = realPath(os.homedir());
	const temp = realPath(tempFolder);
	const fromTemp = home && temp ? path.relative(temp, home) : "..";
	if (fromTemp === "" || fromTemp.startsWith("..") || path.isAbsolute(fromTemp)) {
		throw new Error(`smoke-no-flush-preload.mjs refused: the home ${os.homedir()} is not inside the smokes' temp folder ${tempFolder}, so this process keeps every flush`);
	}
	const skipped = { calls: 0 };
	globalThis[SKIPPED_FLUSHES] = skipped;
	fs.fsyncSync = function fsyncSync(fd) {
		// A closed or wrong descriptor still fails as the real flush would.
		fs.fstatSync(fd);
		skipped.calls += 1;
	};
	// So a named import of fsyncSync from node:fs gets the no-op too.
	syncBuiltinESMExports();
}
