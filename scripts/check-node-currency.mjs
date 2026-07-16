#!/usr/bin/env node
// Checks the vendored-Node pin (scripts/release-node-version.json) against
// nodejs.org's release index. Shipping a bundled runtime means we own its
// patch cadence: this exits 1 when the pin is behind a *security* release in
// the same major line, and only warns on ordinary newer patches. The weekly
// node-currency workflow runs this so the pin cannot silently rot, and the
// release workflow runs it so a tagged release cannot ship a Node with known
// holes.
//
// Usage:
//   node scripts/check-node-currency.mjs
//   node scripts/check-node-currency.mjs --pin 24.16.0   (testing override,
//     checks the given version instead of the JSON pin; used to exercise the
//     failure path without editing the pin file)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const INDEX_URL = "https://nodejs.org/dist/index.json";
const FETCH_TIMEOUT_MS = 30_000;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Numeric three-component compare; lexicographic compare would order
// 24.9.0 after 24.18.0.
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function readPin() {
  const pinArgIndex = process.argv.indexOf("--pin");
  if (pinArgIndex !== -1) {
    const pin = process.argv[pinArgIndex + 1];
    if (!pin) {
      console.error("error: --pin requires a version argument, e.g. --pin 24.16.0");
      process.exit(2);
    }
    console.log(`(using --pin override ${pin} instead of scripts/release-node-version.json)`);
    return pin;
  }
  const pinFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-node-version.json");
  let raw;
  try {
    raw = readFileSync(pinFile, "utf8");
  } catch (err) {
    console.error(`error: could not read ${pinFile}: ${err.message}`);
    process.exit(2);
  }
  const pin = JSON.parse(raw).version;
  if (typeof pin !== "string") {
    console.error(`error: ${pinFile} must have shape {"version":"X.Y.Z"}`);
    process.exit(2);
  }
  return pin;
}

async function fetchIndex() {
  let res;
  try {
    res = await fetch(INDEX_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    console.error(`error: could not fetch ${INDEX_URL}: ${err.cause?.message ?? err.message}`);
    console.error("This check needs network access to nodejs.org; retry or check proxy/TLS settings.");
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`error: ${INDEX_URL} responded ${res.status} ${res.statusText}`);
    process.exit(2);
  }
  return res.json();
}

const pin = readPin();
const pinned = parseVersion(pin);
if (!pinned) {
  console.error(`error: pinned version "${pin}" is not a plain X.Y.Z version`);
  process.exit(2);
}

const index = await fetchIndex();

// Every release in the pinned major line, from the official index. Entries
// look like { version: "v24.18.0", security: false, ... }.
const sameMajor = index
  .map((r) => ({ version: parseVersion(r.version), security: r.security === true }))
  .filter((r) => r.version && r.version[0] === pinned[0]);

if (!sameMajor.some((r) => compareVersions(r.version, pinned) === 0)) {
  console.error(`error: pinned Node ${pin} does not exist in the nodejs.org release index.`);
  console.error("Check scripts/release-node-version.json for a typo.");
  process.exit(1);
}

const newer = sameMajor.filter((r) => compareVersions(r.version, pinned) > 0);
const newerSecurity = newer.filter((r) => r.security);

const fmt = (r) => r.version.join(".");

if (newerSecurity.length > 0) {
  console.error(`Pinned Node ${pin} is behind ${newerSecurity.length} security release(s) in the ${pinned[0]}.x line:`);
  for (const r of newerSecurity) console.error(`  - ${fmt(r)} (security)`);
  console.error(`Fix: bump scripts/release-node-version.json to ${fmt(newer[0])} and cut a new release.`);
  process.exit(1);
}

if (newer.length > 0) {
  console.log(`Pinned Node ${pin} is behind ${newer.length} newer non-security release(s) in the ${pinned[0]}.x line (latest ${fmt(newer[0])}).`);
  console.log("No security releases missed; bump scripts/release-node-version.json at the next convenient release.");
} else {
  console.log(`Pinned Node ${pin} is the latest release in the ${pinned[0]}.x line.`);
}
