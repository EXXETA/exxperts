// Every write step of Forget and the turn after a torn session append, killed, restarted and checked (kill-at-write-harness.ts says how).
import os from "node:os";
import { runKillMatrix } from "./kill-at-write-harness.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: it needs longer there than the 300 seconds the runner gives each smoke");
	process.exit(0);
}

await runKillMatrix(["forget", "turn"]);
