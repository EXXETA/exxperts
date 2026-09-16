const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The folder that holds the `.exxperts` tree, and the ONLY thing a data
// profile or a moved data folder relocates. EXXPERTS_STATE_HOME names it (the
// moved folder, or ~/.exxperts-<name> for a loaded profile); unset, it is the
// login home. HOME is deliberately not part of this: the browser cache,
// ~/.agents/skills, ~/.config/mcp, the container tools and every dotfile a
// spawned tool reads stay with the person, not with the profile.
function stateHome() {
  const fromEnv = process.env.EXXPERTS_STATE_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return os.homedir();
}

function productAppStateRoot() {
  return path.join(stateHome(), ".exxperts", "app");
}

function productAppStatePath(...segments) {
  return path.join(productAppStateRoot(), ...segments);
}

function ensureProductAppStateRoot() {
  const root = productAppStateRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function ensureProductAppStateDir(...segments) {
  const dir = productAppStatePath(...segments);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function ensureProductAppUserDirs() {
  ensureProductAppStateRoot();
  ensureProductAppStateDir("agents");
  ensureProductAppStateDir("skills");
}

function cliLauncherStateDir() {
  const fromEnv = process.env.EXXPERTS_LAUNCHER_STATE_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return productAppStatePath("run", "cli");
}

function ensureCliLauncherStateDir() {
  const dir = cliLauncherStateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function cliLauncherStatePath(...segments) {
  return path.join(cliLauncherStateDir(), ...segments);
}

module.exports = {
  stateHome,
  productAppStateRoot,
  productAppStatePath,
  ensureProductAppStateRoot,
  ensureProductAppStateDir,
  ensureProductAppUserDirs,
  cliLauncherStateDir,
  ensureCliLauncherStateDir,
  cliLauncherStatePath,
};
