// Test-only, loaded with `node --import` by server-stop-smoke for its live
// tail row: once the answer to a message carrying the marker has ended, the
// server signals its own stop and the runtime's post-turn work is held open
// past the stop's close (its 2 s wait, then its 1 s endings ceiling), ending
// inside the 500 ms the stop gives its closes. Keep the marker and the times in
// step with server-stop-smoke.ts.
const TAIL = "stop-smoke:tail";
const HOLD_MS = 3_250;

const runtime = await import("@exxeta/exxperts-runtime");
const prompt = runtime.AgentSession.prototype.prompt;
runtime.AgentSession.prototype.prompt = async function (text, options) {
	await prompt.call(this, text, options);
	if (!String(text).includes(TAIL)) return;
	process.kill(process.pid, "SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
};
