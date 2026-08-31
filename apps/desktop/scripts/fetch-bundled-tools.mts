// Fetches the ripgrep binary the desktop app bundles, for the packaging
// TARGET (not the build host), into build/tools — electron-builder picks that
// directory up as the "tools" extraResource and the app shell points the
// server at it via EXXETA_BUNDLED_TOOLS_DIR.
//
// The binary is deliberately NOT in the repo: it comes through the runtime's
// own tools-manager download path, so the pinned version and per-asset
// SHA-256 in tools-manager.ts stay the single source of truth and the build
// fails on any checksum mismatch, exactly like a runtime download would.
//
// Run from the REPO ROOT (tsx resolves the runtime source imports):
//   npx tsx apps/desktop/scripts/fetch-bundled-tools.mts --target darwin-arm64|win-x64
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadToolForTarget } from "../../../runtime/packages/coding-agent/src/utils/tools-manager.js";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const targetIndex = argv.indexOf("--target");
const target = targetIndex !== -1 ? argv[targetIndex + 1] : null;

const TARGETS: Record<string, { platform: string; arch: string; binary: string }> = {
  "darwin-arm64": { platform: "darwin", arch: "arm64", binary: "rg" },
  "win-x64": { platform: "win32", arch: "x64", binary: "rg.exe" },
};

const spec = target ? TARGETS[target] : undefined;
if (!spec) {
  console.error(`[fetch-bundled-tools] usage: --target ${Object.keys(TARGETS).join("|")}`);
  process.exit(2);
}

// Rebuilt from scratch every run, mirroring the payload staging: a stale or
// wrong-target binary can never ride into the app.
const toolsDir = path.join(desktopRoot, "build", "tools");
fs.rmSync(toolsDir, { recursive: true, force: true });

console.log(`[fetch-bundled-tools] downloading ripgrep for ${target} (pinned + checksum-verified by the runtime tools-manager)...`);
const binaryPath = await downloadToolForTarget("rg", spec.platform, spec.arch, toolsDir);

const expected = path.join(toolsDir, spec.binary);
if (path.resolve(binaryPath) !== expected || !fs.existsSync(expected)) {
  console.error(`[fetch-bundled-tools] expected ${expected}, got ${binaryPath}`);
  process.exit(1);
}
console.log(`[fetch-bundled-tools] staged ${expected}`);
