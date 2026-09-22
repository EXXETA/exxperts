#!/usr/bin/env node
// Unit smoke for the update panel's time-left wording (src/update-time-left.ts):
// the one module is compiled with esbuild's transform into a temp file and its
// edge cases are asserted. One ok line per case; exits 1 on the first failure.
//
//   npm run smoke:time-left
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(pkgRoot, "package.json"));
const esbuild = require("esbuild");

const source = fs.readFileSync(path.join(pkgRoot, "src", "update-time-left.ts"), "utf8");
const { code } = await esbuild.transform(source, { loader: "ts", format: "esm", target: "node20" });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-time-left-"));
const tmpFile = path.join(tmpDir, "update-time-left.mjs");
fs.writeFileSync(tmpFile, code);

let failed = false;
try {
  const { timeLeftText } = await import(pathToFileURL(tmpFile).href);
  const MB = 1024 * 1024;
  const cases = [
    ["no data yet", { movedBytes: 0, seconds: 0, remainingBytes: 50 * MB }, null],
    ["zero rate", { movedBytes: 0, seconds: 10, remainingBytes: 50 * MB }, null],
    ["under 3 s of data", { movedBytes: 5 * MB, seconds: 2.9, remainingBytes: 50 * MB }, null],
    ["negative remaining", { movedBytes: 5 * MB, seconds: 5, remainingBytes: -1 }, null],
    ["under 10 s", { movedBytes: 10 * MB, seconds: 5, remainingBytes: 15 * MB }, "less than 10 seconds left"],
    ["seconds round down to 10", { movedBytes: 10 * MB, seconds: 5, remainingBytes: 24 * MB }, "about 10 seconds left"],
    ["seconds round up to 15", { movedBytes: 10 * MB, seconds: 5, remainingBytes: 26 * MB }, "about 15 seconds left"],
    ["55 seconds stays seconds", { movedBytes: 10 * MB, seconds: 5, remainingBytes: 110 * MB }, "about 55 seconds left"],
    ["58 seconds is a minute", { movedBytes: 10 * MB, seconds: 5, remainingBytes: 116 * MB }, "about 1 minute left"],
    ["1 minute", { movedBytes: 10 * MB, seconds: 5, remainingBytes: 120 * MB }, "about 1 minute left"],
    ["minutes", { movedBytes: 1 * MB, seconds: 5, remainingBytes: 24 * MB }, "about 2 minutes left"],
    ["many minutes", { movedBytes: 1 * MB, seconds: 5, remainingBytes: 300 * MB }, "about 25 minutes left"],
    ["1 hour", { movedBytes: 1 * MB, seconds: 10, remainingBytes: 360 * MB }, "about 1 hour left"],
    ["59.6 minutes is an hour", { movedBytes: 1 * MB, seconds: 10, remainingBytes: 357.6 * MB }, "about 1 hour left"],
    ["hours", { movedBytes: 1 * MB, seconds: 10, remainingBytes: 720 * MB }, "about 2 hours left"],
    ["zero remaining", { movedBytes: 10 * MB, seconds: 5, remainingBytes: 0 }, "less than 10 seconds left"],
  ];
  for (const [name, input, expected] of cases) {
    const got = timeLeftText(input);
    if (got !== expected) {
      console.error(`FAIL ${name}: ${JSON.stringify(input)} gave ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
      failed = true;
      break;
    }
    console.log(`ok ${name}: ${JSON.stringify(got)}`);
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
