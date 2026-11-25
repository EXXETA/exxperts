// Unit tests for the window's sign-in after a profile switch
// (src/profile-switch-load.ts), with the rejections electron's loadURL gives.
//
//   node --test --import tsx apps/desktop/scripts/profile-switch-load.test.mjs   (from the repository root)
import assert from "node:assert/strict";
import { test } from "node:test";

import { isTakenOver, loadPastTakeovers, SIGN_IN_LOAD_TRIES } from "../src/profile-switch-load.ts";

const loadError = (code, errno) => Object.assign(new Error(`${code} (${errno}) loading 'http://localhost:8787/'`), { code, errno });
const takenOver = () => loadError("ERR_ABORTED", -3);

/** A window whose loads answer with each outcome in turn (an error rejects), with its steps in order. */
function windowOf(...outcomes) {
  const steps = [];
  const load = async () => {
    steps.push("load");
    const outcome = outcomes.shift();
    if (outcome) throw outcome;
  };
  const settled = async () => {
    await null;
    steps.push("settled");
  };
  return { steps, signIn: () => loadPastTakeovers(load, settled) };
}

test("a load nothing took over is asked once", async () => {
  const win = windowOf(null);
  await win.signIn();
  assert.deepEqual(win.steps, ["load"]);
});

test("a load the page's navigation took over is asked again once that has ended, and the switch is no failure", async () => {
  const win = windowOf(takenOver(), null);
  await win.signIn();
  assert.deepEqual(win.steps, ["load", "settled", "load"]);
});

test("a second navigation is outlasted too", async () => {
  const win = windowOf(takenOver(), takenOver(), null);
  await win.signIn();
  assert.deepEqual(win.steps, ["load", "settled", "load", "settled", "load"]);
});

test("a server that does not answer is a failure at once", async () => {
  const refused = loadError("ERR_CONNECTION_REFUSED", -102);
  const win = windowOf(refused);
  await assert.rejects(win.signIn(), refused);
  assert.deepEqual(win.steps, ["load"]);
});

test("a server gone after a takeover is a failure", async () => {
  const refused = loadError("ERR_CONNECTION_REFUSED", -102);
  const win = windowOf(takenOver(), refused);
  await assert.rejects(win.signIn(), refused);
  assert.deepEqual(win.steps, ["load", "settled", "load"]);
});

test("a load that never finishes is a failure", async () => {
  const win = windowOf(...Array.from({ length: SIGN_IN_LOAD_TRIES + 1 }, takenOver));
  await assert.rejects(win.signIn(), { code: "ERR_ABORTED" });
  assert.equal(win.steps.filter((step) => step === "load").length, SIGN_IN_LOAD_TRIES);
});

test("only electron's aborted code is a takeover", () => {
  assert.equal(isTakenOver(takenOver()), true);
  for (const other of [loadError("ERR_FAILED", -2), loadError("ERR_CONNECTION_REFUSED", -102), new Error("The exxperts server did not become ready on port 8787 within 60s."), undefined, null]) assert.equal(isTakenOver(other), false);
});
