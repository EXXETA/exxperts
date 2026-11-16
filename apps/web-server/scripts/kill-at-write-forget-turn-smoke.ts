// Every write step of Forget and the turn after a torn session append, killed, restarted and checked (kill-at-write-harness.ts says how).
import { runKillMatrix } from "./kill-at-write-harness.js";

await runKillMatrix(["forget", "turn"]);
