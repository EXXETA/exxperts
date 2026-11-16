// Every write step of Remember, killed, restarted and checked (kill-at-write-harness.ts says how).
import { runKillMatrix } from "./kill-at-write-harness.js";

await runKillMatrix(["remember"]);
