// Unit tests for what the shell's text windows show of a sign-in address
// (src/window-text.ts), and for the windows themselves (src/health.ts) on a
// stand-in electron, server folder and update feed. Every token is invented.
//
//   node --test --import tsx apps/desktop/scripts/window-text.test.mjs   (from the repository root)
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { maskTokens } from "../src/window-text.ts";

const TOKEN = "invented-sign-in-word";

test("an address with a token alone keeps all but its value", () => {
  assert.equal(
    maskTokens(`ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:8787/auth/session?token=${TOKEN}'`),
    "ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:8787/auth/session?token=[redacted]'",
  );
});

test("the parameters beside the token stay", () => {
  assert.equal(
    maskTokens(`loading 'http://localhost:8787/auth/session?from=tray&token=${TOKEN}&room=harbor#top' failed`),
    "loading 'http://localhost:8787/auth/session?from=tray&token=[redacted]&room=harbor#top' failed",
  );
});

test("a token with encoded signs goes whole", () => {
  assert.equal(
    maskTokens("loading 'http://localhost:8787/auth/session?token=in%26vented%20%27one%27(2)%23x'"),
    "loading 'http://localhost:8787/auth/session?token=[redacted]'",
  );
});

test("a token with the signs encoding leaves goes whole", () => {
  assert.equal(
    maskTokens("Open http://localhost:8787/auth/session?token=it's-invented!(*~) to sign in"),
    "Open http://localhost:8787/auth/session?token=[redacted] to sign in",
  );
});

test("an address encoded inside another one shows no token", () => {
  assert.equal(
    maskTokens(`GET /open?next=%2Fauth%2Fsession%3Ftoken%3D${TOKEN} answered 500`),
    "GET /open?next=%2Fauth%2Fsession%3Ftoken%3D[redacted] answered 500",
  );
});

test("two addresses in one text are both masked", () => {
  assert.equal(
    maskTokens(`'/auth/session?token=${TOKEN}' then "/auth/session?token=second-invented"`),
    "'/auth/session?token=[redacted]' then \"/auth/session?token=[redacted]\"",
  );
});

test("a log tail keeps its lines", () => {
  assert.equal(
    maskTokens(`exxperts running at http://localhost:8787\nOpen this link once to sign a browser in:\nhttp://localhost:8787/auth/session?token=${TOKEN}\n\n{"level":40,"msg":"stopping","url":"/auth/session?token=${TOKEN}"}`),
    "exxperts running at http://localhost:8787\nOpen this link once to sign a browser in:\nhttp://localhost:8787/auth/session?token=[redacted]\n\n{\"level\":40,\"msg\":\"stopping\",\"url\":\"/auth/session?token=[redacted]\"}",
  );
});

test("a text without a token is unchanged, and so is a masked one", () => {
  for (const text of [
    "",
    "The exxperts server did not become ready on port 8787 within 60s.",
    "No auth token appeared at /Users/someone/.exxperts/app/auth-token; cannot sign the window in.",
    "ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:8787/?room=harbor&view=memory'",
    "usage: 1200 tokens = 3 pages",
    "http://localhost:8787/auth/session?token=[redacted]",
  ]) assert.equal(maskTokens(text), text);
});

// The windows, on a stand-in electron. It is put in place before health.ts is
// loaded: outside the app the real package only gives a program's path.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-window-text-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
fs.mkdirSync(path.join(scratch, "scripts"));
fs.writeFileSync(
  path.join(scratch, "scripts", "doctor.mjs"),
  `console.log("Node ok");\nconsole.error("last sign-in: http://localhost:8787/auth/session?token=${TOKEN}");\n`,
);
process.env.EXXPERTS_DESKTOP_SERVER_ROOT = scratch;
process.env.EXXPERTS_DESKTOP_NODE = process.execPath;
process.env.EXXPERTS_DESKTOP_SCRATCH_HOME = scratch;
globalThis.fetch = async () => {
  throw new Error("no network here");
};

/** Everything a text window was given to show, in order. */
class StandInWindow {
  constructor(options) {
    this.shown = [options.title];
    this.webContents = {
      executeJavaScript: async (script) => {
        this.shown.push(script);
      },
    };
  }
  showInactive() {}
  setMenuBarVisibility() {}
  isDestroyed() {
    return false;
  }
  async loadURL(url) {
    this.shown.push(decodeURIComponent(url));
  }
}
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: { isPackaged: false, getVersion: () => "0.0.0" }, BrowserWindow: StandInWindow };
  return load.call(this, request, ...rest);
};
const { showHealthCheck, showTextWindow } = createRequire(import.meta.url)("../src/health.ts");

const link = `http://localhost:8787/auth/session?token=${TOKEN}`;

test("a text window shows no token in its title, its heading or its text", () => {
  const win = showTextWindow(`title ${link}`, `heading loading '${link}'`, `body ${link}\n<the last line>`);
  const shown = win.shown.join("\n");
  assert.ok(!shown.includes(TOKEN), shown);
  for (const part of ["title ", "heading loading '", "body "]) assert.ok(shown.includes(`${part}http://localhost:8787/auth/session?token=[redacted]`), part);
  assert.ok(shown.includes("&lt;the last line&gt;"));
});

test("the health check shows its output without a token", async () => {
  const shown = (await showHealthCheck()).shown.join("\n");
  assert.ok(shown.includes("Node ok") && shown.includes("Everything required is healthy."), shown);
  assert.ok(shown.includes("last sign-in: http://localhost:8787/auth/session?token=[redacted]"), shown);
  assert.ok(!shown.includes(TOKEN));
});
