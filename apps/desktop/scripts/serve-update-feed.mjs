#!/usr/bin/env node
// Local update feed for testing the one-click updater end to end, before any
// real release exists.
//
//   node scripts/serve-update-feed.mjs [--dir dist-app] [--port 8060]
//
// Serves the packaged artifacts directory (latest-mac.yml / latest.yml, zip,
// dmg, setup exe, blockmaps) statically, and answers "/" with the
// GitHub-API-shaped JSON the update-notice layer expects, its tag taken from
// the channel file in the directory. Point an OLDER installed build at it:
//
//   EXXPERTS_DESKTOP_UPDATE_FEED=http://127.0.0.1:8060/ \
//     /Applications/exxperts.app/Contents/MacOS/exxperts
//
// then Check for Updates -> Install and restart exercises the full flow
// (check, verified download, quit, install, relaunch) against this host.
// On macOS BOTH builds must be Developer ID signed (package.mjs --sign-mac);
// Squirrel.Mac refuses unsigned updates. On Windows use the NSIS-installed
// app (the portable zip deliberately keeps the manual path).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(desktopRoot, argValue("--dir", "dist-app"));
const port = Number(argValue("--port", "8060"));

const channelFile = ["latest-mac.yml", "latest.yml"]
  .map((f) => path.join(dir, f))
  .find((p) => fs.existsSync(p));
if (!channelFile) {
  console.error(`[feed] no latest-mac.yml or latest.yml in ${dir}; package a build first (scripts/package.mjs).`);
  process.exit(1);
}
const version = /^version:\s*(\S+)/m.exec(fs.readFileSync(channelFile, "utf8"))?.[1];
if (!version) {
  console.error(`[feed] could not read a version from ${channelFile}.`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  if (pathname === "/") {
    // The update-notice layer's check (GitHub releases/latest shape).
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ tag_name: `v${version}`, prerelease: false, draft: false }));
    console.log(`[feed] notice check -> v${version}`);
    return;
  }
  // Static artifacts for electron-updater; names never contain separators.
  const file = path.join(dir, path.basename(pathname));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404;
    res.end("not found");
    console.log(`[feed] 404 ${pathname}`);
    return;
  }
  res.setHeader("content-type", "application/octet-stream");
  res.setHeader("content-length", fs.statSync(file).size);
  fs.createReadStream(file).pipe(res);
  console.log(`[feed] serving ${path.basename(file)}`);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[feed] v${version} from ${dir}`);
  console.log(`[feed] set EXXPERTS_DESKTOP_UPDATE_FEED=http://127.0.0.1:${port}/ on the OLDER build and use Check for Updates`);
});
