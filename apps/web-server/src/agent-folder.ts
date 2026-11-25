import os from "node:os";
import path from "node:path";

import { stateHome } from "../../../pi-package/product-state-paths.js";

/**
 * The agent folder (the sign-in file, the connector settings, the library),
 * read as the runtime's `getAgentDir()` reads it
 * (runtime/packages/coding-agent/src/config.ts), without loading the runtime,
 * so a small program that bundles a module naming it carries no runtime.
 * `EXXPERTS_CODING_AGENT_DIR` moves it, a leading `~` read as the login home;
 * unset, it is `.exxperts/agent` in the state tree. A row in
 * apps/web-server/scripts/persistent-room-workspace-policy-smoke.ts pins it
 * equal to `getAgentDir()`.
 */
export function agentFolderPath(): string {
	const moved = process.env.EXXPERTS_CODING_AGENT_DIR;
	if (!moved) return path.join(stateHome(), ".exxperts", "agent");
	if (moved === "~") return os.homedir();
	return moved.startsWith("~/") ? os.homedir() + moved.slice(1) : moved;
}
