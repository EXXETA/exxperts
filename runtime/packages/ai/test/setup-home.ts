// Every test file starts with its home pointed at a fresh temporary
// directory. The suite's helper (test/oauth.ts) reads ~/.pi/agent/auth.json,
// refreshes the OAuth tokens it finds there and writes them back, and the
// live tests then call the real services with them: on 2026-09-22 a plain
// "vitest --run" rotated a real ChatGPT token and sent real requests. With an
// empty home those tests skip. Set EXXPERTS_LIVE_TESTS=1 to run them against
// the real home on purpose.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.EXXPERTS_LIVE_TESTS !== "1") {
	const home = mkdtempSync(join(tmpdir(), "exxperts-ai-tests-"));
	process.env.HOME = home;
	if (process.platform === "win32") process.env.USERPROFILE = home;
}
