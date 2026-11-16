// Every write step of room create, killed, restarted and checked (kill-at-write-harness.ts says how).
import { runKillMatrix } from "./kill-at-write-harness.js";

await runKillMatrix(["create", "create on a shared server"]);
