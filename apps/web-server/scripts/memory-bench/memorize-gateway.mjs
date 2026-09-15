// Synthetic OpenAI-compatible SSE gateway for Memorize end-to-end runs.
// The leg is chosen by POST /control/leg {"leg":"..."}; the step (assessment
// vs proposal) is detected from the worker's trigger prompt.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const PORT = Number(process.env.GATEWAY_PORT || 8952);
const BENCH = path.dirname(new URL(import.meta.url).pathname);
const LOG = path.join(BENCH, "gateway-requests.jsonl");
fs.writeFileSync(LOG, "");
const faithful = fs.readFileSync(path.join(BENCH, "faithful-proposal.md"), "utf-8");
const budgetFit = fs.readFileSync(path.join(BENCH, "budgetfit-proposal.md"), "utf-8");
const assessment = fs.readFileSync(path.join(BENCH, "assessment.md"), "utf-8");
let leg = process.env.LEG || "faithful-fast";
const tok = (t) => Math.ceil(t.length / 4);
function text(m) { const c = m?.content; return typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : ""; }
function sse(res, p) { res.write(`data: ${JSON.stringify(p)}\n\n`); }
// Stream `body` in chunks of ~chunkTokens at `tps` tokens per second; cutAt = token count to stop with finish_reason length.
function stream(res, base, body, { tps = Infinity, cutAt = Infinity, dropAt = Infinity, promptTokens = 68000 } = {}) {
	return new Promise((resolve) => {
		const chunkChars = 200; // ~50 tokens
		let pos = 0; let sentTokens = 0;
		const started = Date.now();
		const tick = () => {
			if (res.destroyed) return resolve("client-gone");
			if (sentTokens >= dropAt) { res.socket.destroy(); return resolve("dropped"); }
			if (pos >= body.length || sentTokens >= cutAt) {
				const cut = sentTokens >= cutAt && pos < body.length;
				sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: cut ? "length" : "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: sentTokens, total_tokens: promptTokens + sentTokens } });
				res.write("data: [DONE]\n\n"); res.end();
				return resolve(cut ? "cut" : "stop");
			}
			const piece = body.slice(pos, pos + chunkChars); pos += chunkChars; sentTokens += tok(piece);
			sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
			if (tps === Infinity) setImmediate(tick); else setTimeout(tick, (tok(piece) / tps) * 1000);
		};
		tick();
	});
}
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => { body += c; });
	req.on("end", async () => {
		if (req.method === "POST" && req.url === "/control/leg") { leg = JSON.parse(body).leg; res.writeHead(204).end(); return; }
		if (req.method === "GET" && req.url === "/control/requests") { res.writeHead(200, { "content-type": "application/json" }).end(fs.readFileSync(LOG, "utf-8")); return; }
		if (req.method !== "POST" || !String(req.url).endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
		let parsed = {}; try { parsed = JSON.parse(body); } catch {}
		const messages = parsed.messages ?? [];
		const lastUser = text(messages[messages.map((m) => m.role).lastIndexOf("user")] ?? {});
		const system = text(messages.find((m) => m.role === "system") ?? {}) + text(messages.find((m) => m.role === "developer") ?? {});
		const step = /assessment now/i.test(lastUser) ? "assess" : /Proposal now/i.test(lastUser) ? "propose" : "other";
		const base = { id: `chatcmpl_${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: parsed.model };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
		const started = Date.now();
		let outcome;
		const maxTokens = parsed.max_tokens ?? parsed.max_completion_tokens ?? null;
		if (step === "assess") outcome = leg === "assess-drop" ? await stream(res, base, assessment, { dropAt: 20 }) : await stream(res, base, assessment);
		else if (leg === "cut16k") outcome = await stream(res, base, faithful, { cutAt: 16384 });
		else if (leg === "cut-at-max") outcome = await stream(res, base, faithful, { cutAt: maxTokens ?? 16384 });
		else if (leg === "decorated") outcome = await stream(res, base, faithful.replace(/^### (Mode|Primacy Map|Section-Level Change Log|Entry-Level Detail|Compression Metrics|Warnings|Candidate L1b)$/gm, "### **$1**"));
		else if (leg === "faithful-fast") outcome = await stream(res, base, faithful);
		else if (leg === "budgetfit-fast") outcome = await stream(res, base, budgetFit);
		else if (leg === "budgetfit-80tps") outcome = await stream(res, base, budgetFit, { tps: 80 });
		else if (leg === "drop-midstream") outcome = await stream(res, base, faithful, { dropAt: 3000 });
		else outcome = await stream(res, base, "Unknown leg.");
		const rec = { at: new Date().toISOString(), step, leg, outcome, ms: Date.now() - started, promptChars: system.length + lastUser.length, promptTokensEst: tok(system) + tok(lastUser), max_tokens: parsed.max_tokens ?? null, max_completion_tokens: parsed.max_completion_tokens ?? null, stream: parsed.stream ?? null, roles: messages.map((m) => m.role + ":" + text(m).length), lastUserHead: lastUser.slice(0, 160) };
		fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
		console.log(JSON.stringify(rec));
	});
});
server.listen(PORT, "127.0.0.1", () => console.log(`memorize gateway on ${PORT}, leg=${leg}`));
