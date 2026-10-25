// A company gateway's bare 403 (no provider words) may be a key the gateway
// does not accept, or a model it does not offer: the line says both, names
// where the key is replaced (on a shared server, the admin), and the key's
// button is offered, while AI setup does not mark the key refused. A worded
// 403, and any 403 from a provider that is not a gateway, keep the
// region-or-plan reading. The memory probes and the log line read it the
// same way. Details shows the gateway's own words, or none when it sent no
// body. Pure reads in a throwaway HOME with one gateway saved, and one local
// endpoint that answers 403.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const failures: string[] = [];
function check(condition: unknown, message: string): void {
	if (!condition) failures.push(message);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-gateway-403-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home });
delete process.env.EXXPERTS_STATE_HOME;
delete process.env.EXXPERTS_DATA_DIR;
const appDir = path.join(home, ".exxperts", "app");
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "openai-compatible-gateways.json"), JSON.stringify({
	version: 1,
	gateways: [{ id: "acme-gw", providerId: "acme-gw", label: "Acme gateway", baseUrl: "http://127.0.0.1:9/v1", roomModels: [{ modelId: "acme-model", label: "Acme Model" }], maintenanceModel: "acme-model" }],
}, null, 2));

try {
	const causes = await import("../src/model-call-causes.js");
	const lines = await import("../../web-ui/src/turn-failure-line.js");
	const copy = await import("../../web-ui/src/memory-v2-copy.js");
	const CAUSE = "refused this request: the gateway may not accept the saved key, or the model may not be offered to you";
	const BARE = ["HTTP 403 Forbidden", '403 {"message":"Forbidden"}', "status code 403"];
	const WORDED = ['403 {"type":"error","error":{"type":"permission_error","message":"Country, region, or territory not supported"}}', '403 {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}'];

	for (const words of BARE) {
		const onGateway = causes.classifyModelFailure(new Error(words), { provider: "acme-gw" } as never) as { cause: string; detail?: string };
		check(onGateway.cause === "unreachable" && onGateway.detail === "gateway-refused", `a gateway's bare 403 is the gateway refusing, got ${JSON.stringify(onGateway)} for ${words}`);
		const onOpenAi = causes.classifyModelFailure(new Error(words), { provider: "openai" } as never) as { detail?: string };
		check(onOpenAi.detail === "region-or-plan", `a provider's bare 403 keeps region or plan, got ${JSON.stringify(onOpenAi)} for ${words}`);
		check(causes.turnFailureOf(words, false, "acme-gw") === "gateway-refused", `the chat reads a gateway's bare 403 as the gateway refusing, got ${causes.turnFailureOf(words, false, "acme-gw")}`);
	}
	for (const words of WORDED) {
		const onGateway = causes.classifyModelFailure(new Error(words), { provider: "acme-gw" } as never) as { detail?: string };
		check(onGateway.detail === "region-or-plan", `a worded 403 through a gateway keeps region or plan, got ${JSON.stringify(onGateway)}`);
	}

	const chat = lines.failureLineText(lines.turnFailureLine("Acme Model", "gateway-refused", "acme-gw"), "lost");
	check(chat === `Acme Model ${CAUSE}. Nothing was lost. Replace the gateway's key in Settings, AI setup, or choose another model in Room settings, Model.`, `the chat's line names where the key is replaced, got "${chat}"`);
	const shared = lines.failureLineText(lines.turnFailureLine("Acme Model", "gateway-refused", "acme-gw", undefined, true), "lost");
	check(shared === `Acme Model ${CAUSE}. Nothing was lost. Tell your admin, or choose another model in Room settings, Model.`, `on a shared server the chat's line sends the person to the admin, got "${shared}"`);

	// The log line and the memory probes read it with the provider too.
	const logged = (causes.providerFailureLogFields as (error: unknown, provider?: string) => { cause?: string } | undefined)(new Error("HTTP 403 Forbidden"), "acme-gw");
	check(logged?.cause === "unreachable:gateway-refused", `the log line reads a gateway's bare 403 as the gateway refusing, got ${JSON.stringify(logged)}`);
	let probed: unknown;
	try {
		await causes.callWithPatience(async () => { throw new Error('500 {"error":{"message":"Internal server error"}}'); }, { model: { provider: "acme-gw", model: "acme-model", label: "Acme Model" }, sleep: async () => {}, probe: async () => { throw new Error("HTTP 403 Forbidden"); } });
	} catch (error) {
		probed = error;
	}
	check((probed as { details?: { detail?: string } } | undefined)?.details?.detail === "gateway-refused", `a probe's bare 403 on a gateway is the gateway refusing, got ${JSON.stringify((probed as { details?: unknown } | undefined)?.details)}`);
	const nameOf = (causes as Record<string, unknown>).gatewayNameOf as ((provider: string) => string | undefined) | undefined;
	check(typeof nameOf === "function" && nameOf("acme-gw") === "Acme gateway" && nameOf("openai") === undefined, `a gateway is named as AI setup names it, a provider that is none is not, got ${typeof nameOf === "function" ? JSON.stringify([nameOf("acme-gw"), nameOf("openai")]) : "no function"}`);

	let thrown: unknown;
	try {
		await causes.callWithPatience(async () => { throw new Error("HTTP 403 Forbidden"); }, { model: { provider: "acme-gw", model: "acme-model", label: "Acme Model" }, sleep: async () => {} });
	} catch (error) {
		thrown = error;
	}
	const notice = thrown as { message?: string; details?: { detail?: string; key?: string } } | undefined;
	check(notice?.details?.detail === "gateway-refused", `the Memory notice's cause, got ${JSON.stringify(notice?.details)}`);
	check(notice?.message === `Acme Model ${CAUSE}. Nothing was lost.`, `the Memory notice's sentence, got "${notice?.message}"`);
	check(notice?.details?.key === "refused", `the Memory notice offers the key's button, got ${JSON.stringify(notice?.details)}`);
	// The 403 may be the model, not the key: AI setup does not mark the gateway's key refused.
	check(causes.keyRefusalOf("acme-gw") === undefined, `AI setup keeps the gateway's key unmarked, got ${JSON.stringify(causes.keyRefusalOf("acme-gw"))}`);
	check((copy.memoryModelStopWhy as (...args: unknown[]) => string)("gateway-refused") === CAUSE, `the memory cards' cause, got "${(copy.memoryModelStopWhy as (...args: unknown[]) => string)("gateway-refused")}"`);
	check(copy.memoryModelSignInLabel("refused") === "Replace key", "the cards' key button reads Replace key");

	// Details: the gateway's own words when its body has some, through the runtime as a room's call goes; none when it sent no body.
	const { complete } = await import("@exxeta/exxperts-ai");
	const endpoint = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(403, { "content-type": "application/json" });
			res.end(req.url?.startsWith("/worded/") ? JSON.stringify({ message: "Forbidden" }) : "");
		});
	});
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	try {
		const port = (endpoint.address() as AddressInfo).port;
		const ask = async (route: string) => {
			const model = { id: "acme-model", name: "Acme Model", api: "openai-completions", provider: "acme-gw", baseUrl: `http://127.0.0.1:${port}/${route}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
			const answer = await complete(model as never, { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] }, { apiKey: "synthetic-gateway-key" });
			return String(answer.errorMessage ?? "");
		};
		const worded = await ask("worded");
		check(lines.providerSentence(worded) === "Forbidden", `Details shows the gateway's own words, got ${JSON.stringify(lines.providerSentence(worded))} from ${JSON.stringify(worded)}`);
		check(causes.turnFailureOf(worded, false, "acme-gw") === "gateway-refused", `the gateway's words keep the bare 403's reading, got ${causes.turnFailureOf(worded, false, "acme-gw")}`);
		const empty = await ask("empty");
		check(lines.providerSentence(empty) === undefined, `no Details when the gateway sent no body, got ${JSON.stringify(lines.providerSentence(empty))} from ${JSON.stringify(empty)}`);
		check(causes.turnFailureOf(empty, false, "acme-gw") === "gateway-refused", `a bodiless 403 keeps the bare 403's reading, got ${causes.turnFailureOf(empty, false, "acme-gw")}`);
	} finally {
		endpoint.close();
	}
} finally {
	fs.rmSync(home, { recursive: true, force: true });
}

if (failures.length > 0) throw new Error(`gateway bare 403:\n  ${failures.join("\n  ")}`);
console.log("gateway bare 403 smoke: ok");
