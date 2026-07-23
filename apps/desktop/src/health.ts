// Health Check menu item: runs the existing doctor script and shows its
// output in a monospace window. The structured doctor --json panel is a later
// arc; this keeps v1 at "the same doctor you would run in a terminal".
import { spawn } from "node:child_process";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { nodeBinary, serverEnv, serverRoot } from "./server";
import { checkForUpdate, getAvailableUpdate } from "./update-check";

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

export function runDoctor(): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const root = serverRoot();
    const child = spawn(nodeBinary(), [path.join(root, "scripts", "doctor.mjs")], {
      cwd: root,
      env: serverEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => { output += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { output += c.toString("utf8"); });
    child.on("error", (err) => resolve({ output: `Could not run the health check: ${err.message}`, exitCode: null }));
    child.on("exit", (code) => resolve({ output: output.replace(ANSI, ""), exitCode: code }));
  });
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function showTextWindow(title: string, heading: string, body: string, parent?: BrowserWindow): BrowserWindow {
  const win = new BrowserWindow({
    width: 780,
    height: 560,
    title,
    parent,
    webPreferences: { sandbox: true },
  });
  win.setMenuBarVisibility(false);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; background: #0d0d0f; color: #e8e8ec; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 14px; font-weight: 600; padding: 14px 18px 0; margin: 0; }
  pre { padding: 10px 18px 18px; margin: 0; white-space: pre-wrap; word-break: break-word; }
</style></head><body><h1>${escapeHtml(heading)}</h1><pre>${escapeHtml(body)}</pre></body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

export async function showHealthCheck(parent?: BrowserWindow): Promise<BrowserWindow> {
  const win = showTextWindow("exxperts health check", "Health check", "Running the health check...", parent);
  // Idempotent: safe to apply both when the check lands and again after the
  // doctor render (which replaces the pre wholesale).
  const prependUpdateLine = async () => {
    const update = getAvailableUpdate();
    if (!update || win.isDestroyed()) return;
    const updateLine = `An update is available: exxperts v${update.version}\nDownload: ${update.url}\n\n`;
    await win.webContents.executeJavaScript(
      `{ const pre = document.querySelector("pre");
         if (!pre.textContent.startsWith("An update is available")) pre.textContent = ${JSON.stringify(updateLine)} + pre.textContent; }
       true`,
    ).catch(() => undefined);
  };
  // The update check piggybacks this user-initiated network moment (there is
  // no background polling). It renders independently when it lands: doctor
  // output must never wait up to 10s behind a hung feed.
  const updatePromise = checkForUpdate(app.getVersion()).catch(() => "error" as const).then(prependUpdateLine);
  const { output, exitCode } = await runDoctor();
  if (!win.isDestroyed()) {
    const verdict = exitCode === 0 ? "Everything required is healthy." : "Some required checks failed.";
    await win.webContents.executeJavaScript(
      `document.querySelector("h1").textContent = ${JSON.stringify(`Health check: ${verdict}`)};
       document.querySelector("pre").textContent = ${JSON.stringify(output.trim() || "(no output)")};
       document.querySelector("pre").textContent.length`,
    ).catch(() => undefined);
  }
  // Cover the race where the check landed BEFORE the doctor render replaced
  // the pre: wait for it, then re-apply (no-op when no update or already
  // present).
  await updatePromise;
  await prependUpdateLine();
  return win;
}
