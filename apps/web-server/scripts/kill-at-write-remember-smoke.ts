// Every write step of Remember, killed, restarted and checked (kill-at-write-harness.ts says how).
import os from "node:os";
import { runKillMatrix } from "./kill-at-write-harness.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: it ran past 300 seconds there");
	process.exit(0);
}

await runKillMatrix(["remember"]);
