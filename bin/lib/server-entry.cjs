// How to start the web server under an app root, shared by the web launcher
// and the desktop app so both always pick the same entry.
//
// The bundled server (apps/web-server/dist/server.mjs, built by the release
// pipeline through scripts/bundle-server.mjs) runs with plain node. It is used
// in an installed tree; in a checkout, where the root has a .git entry (the
// test doctor.mjs uses for a clone), a hand-built bundle may be stale, so the
// current TypeScript source runs through tsx unless EXXPERTS_SERVER_BUNDLE=1
// asks for the bundle.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

// tsxLoader: run the source with tsx's loader flags, so the spawned process
// is the server itself, instead of through tsx's CLI wrapper, which spawns
// the server as a grandchild.
function serverLaunchArgs(root, { tsxLoader = false, env = process.env } = {}) {
  const bundled = path.join(root, "apps", "web-server", "dist", "server.mjs");
  const checkout = fs.existsSync(path.join(root, ".git"));
  if (fs.existsSync(bundled) && (!checkout || env.EXXPERTS_SERVER_BUNDLE === "1")) return [bundled];

  const source = path.join(root, "apps", "web-server", "src", "index.ts");
  const requireFromRoot = createRequire(path.join(root, "package.json"));
  if (!tsxLoader) return [requireFromRoot.resolve("tsx/cli"), source];
  const tsxDir = path.dirname(requireFromRoot.resolve("tsx/package.json"));
  return [
    "--require", path.join(tsxDir, "dist", "preflight.cjs"),
    "--import", pathToFileURL(path.join(tsxDir, "dist", "loader.mjs")).href,
    source,
  ];
}

module.exports = { serverLaunchArgs };
