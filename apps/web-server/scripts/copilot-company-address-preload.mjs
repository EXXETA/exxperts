// Test-only, loaded with `node --import` by copilot-company-address-smoke: stands
// in for GitHub, so no sign-in leaves the machine.
//
// Every Copilot device-code request (https://<host>/login/device/code) appends
// its host to SMOKE_COPILOT_ASKED and is answered here, by the host's first label:
// - `nothing`: no answer at all, as for an address with no server behind it;
// - `notgithub`: a web page's 404, as for a server that is not a GitHub;
// - `stall`: never answers, as for a server that takes the request and hangs;
// - `slow`: a code after 3 seconds;
// - any other: a code, so the runtime hands back the code page. The sign-in then
//   asks for its token: `declined` answers that the person declined,
//   `pollrefused` refuses that request itself (403), `refused` gives a token
//   that the Copilot token request refuses (403), `ok` and `listfails`
//   complete the sign-in,
//   `late` completes it once the file `<SMOKE_COPILOT_HELD>.go` exists (its
//   Copilot token request writes SMOKE_COPILOT_HELD when it starts waiting, and
//   `<SMOKE_COPILOT_HELD>.answered` as it answers),
//   and any other host keeps the sign-in waiting until it is cancelled.
//   github.com keeps it waiting too, unless the file SMOKE_COPILOT_PERSONAL
//   exists: then it completes as a personal sign-in.
// As GitHub's do, a company sign-in's Copilot token names no address, and a
// personal one's names `proxy.individual.smoke.invalid`. Every Copilot model
// list request appends its host to SMOKE_COPILOT_MODELS, which tells whose
// sign-in the app holds and where it asked. The list is COPILOT_MODEL_ROWS,
// at a company's `copilot-api.<domain>` or at the personal address; anywhere
// else, as at the personal-accounts address a token naming none falls back
// to, it is refused (401). At `copilot-api.listfails.<domain>` it fails (503),
// with the request's token in the answer's body. While the file
// SMOKE_COPILOT_LIST exists, the list is the model ids it holds as a JSON
// array, each an enabled chat model, in place of COPILOT_MODEL_ROWS.
//
// It also registers `smoke-prompt`, a sign-in with an optional prompt like
// Copilot's, which appends its answer to SMOKE_PROMPT_ANSWERS and waits until
// it is cancelled: another provider's sign-in, to show it still answers blank.
import fs from "node:fs";
import { registerOAuthProvider } from "@exxeta/exxperts-ai/oauth";

const asked = process.env.SMOKE_COPILOT_ASKED;
const held = process.env.SMOKE_COPILOT_HELD;
const models = process.env.SMOKE_COPILOT_MODELS;
const answers = process.env.SMOKE_PROMPT_ANSWERS;
const personal = process.env.SMOKE_COPILOT_PERSONAL;
const listFile = process.env.SMOKE_COPILOT_LIST;

/** An account's list, shaped as Copilot's: what the app offers from it is the catalogue's chat models with no policy or an enabled one. */
const COPILOT_MODEL_ROWS = [
	{ id: "claude-haiku-4.5", capabilities: { type: "chat" }, policy: { state: "enabled" } },
	{ id: "claude-opus-5", capabilities: { type: "chat" }, policy: { state: "enabled" } },
	{ id: "claude-sonnet-5.5", capabilities: { type: "chat" }, policy: { state: "enabled" } },
	{ id: "gpt-6-sol", capabilities: { type: "chat" }, policy: { state: "enabled" } },
	{ id: "gpt-5.3-codex", capabilities: { type: "chat" } },
	{ id: "claude-opus-5.5", capabilities: { type: "chat" }, policy: { state: "disabled" } },
	{ id: "gpt-4o-mini", capabilities: { type: "chat" } },
	{ id: "text-embedding-3-small", capabilities: { type: "embeddings" } },
];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

if (asked) {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const label = url.hostname.split(".")[0];
		if (url.pathname === "/login/device/code") {
			fs.appendFileSync(asked, `${url.hostname}\n`);
			if (label === "nothing") throw new TypeError("fetch failed");
			if (label === "notgithub") return new Response("<html>Not Found</html>", { status: 404, statusText: "Not Found" });
			if (label === "stall") return new Promise(() => {});
			if (label === "slow") await new Promise((resolve) => setTimeout(resolve, 3000));
			return json({ device_code: `device-${url.hostname}`, user_code: "SMOKE-0001", verification_uri: `https://${url.hostname}/login/device`, interval: 1, expires_in: 900 });
		}
		if (url.pathname === "/login/oauth/access_token") {
			if (label === "declined") return json({ error: "access_denied", error_description: "The user has denied your application access." });
			if (label === "pollrefused") return new Response("Forbidden", { status: 403, statusText: "Forbidden" });
			if (label === "refused" || label === "ok" || label === "late" || label === "listfails") return json({ access_token: "smoke-github-token" });
			if (url.hostname === "github.com" && personal && fs.existsSync(personal)) return json({ access_token: "smoke-github-token" });
			return json({ error: "authorization_pending" });
		}
		if (url.pathname === "/copilot_internal/v2/token") {
			const domain = url.hostname.replace(/^api\./, "");
			const domainLabel = domain.split(".")[0];
			if (domainLabel === "late" && held) {
				fs.writeFileSync(held, domain);
				while (!fs.existsSync(`${held}.go`)) await new Promise((resolve) => setTimeout(resolve, 20));
				fs.writeFileSync(`${held}.answered`, "");
			}
			const expires_at = Math.floor(Date.now() / 1000) + 3600;
			if (domainLabel === "ok" || domainLabel === "late" || domainLabel === "listfails") return json({ token: `tid=smoke-${domainLabel};exp=9999999999;sku=enterprise`, expires_at });
			if (domain === "github.com") return json({ token: "tid=smoke-personal;exp=9999999999;proxy-ep=proxy.individual.smoke.invalid", expires_at });
			return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403, statusText: "Forbidden" });
		}
		if (url.pathname === "/models" && models) {
			fs.appendFileSync(models, `${url.hostname}\n`);
			if (url.hostname.startsWith("copilot-api.listfails.")) {
				const authorization = new Headers(init?.headers).get("authorization");
				return new Response(JSON.stringify({ message: `Service unavailable for ${authorization}` }), { status: 503, statusText: "Service Unavailable" });
			}
			if (!url.hostname.startsWith("copilot-api.") && url.hostname !== "api.individual.smoke.invalid") return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401, statusText: "Unauthorized" });
			if (listFile && fs.existsSync(listFile)) return json({ data: JSON.parse(fs.readFileSync(listFile, "utf8")).map((id) => ({ id, capabilities: { type: "chat" }, policy: { state: "enabled" } })) });
			return json({ data: COPILOT_MODEL_ROWS });
		}
		return realFetch(input, init);
	};
}

if (answers) {
	registerOAuthProvider({
		id: "smoke-prompt",
		name: "Smoke Prompt",
		async login(callbacks) {
			const answer = await callbacks.onPrompt({ message: "An optional question", allowEmpty: true });
			fs.appendFileSync(answers, `${JSON.stringify(answer)}\n`);
			callbacks.onAuth({ url: "https://sign-in.invalid/smoke" });
			await callbacks.onManualCodeInput();
			throw new Error("this provider never completes a sign-in");
		},
		async refreshToken(credentials) {
			return credentials;
		},
		getApiKey: (credentials) => credentials.access,
	});
}
