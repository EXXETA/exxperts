// A gateway that refuses during setup says why, and the person reads why.
//
// Setting up a gateway lists its models first. When the gateway refuses that
// list it usually explains itself in the answer (a budget used up, a model
// group the key may not use), and the setup used to drop the explanation and
// show only the status code. This stands up a gateway that refuses /models in
// the shapes seen in the field and proves the reason reaches the message:
// LiteLLM's budget refusal, a FastAPI-style detail, a long multi-line text, a
// whole HTML page (which says nothing a person can use, so the status line
// stays), and a rejected key (which keeps its own plain sentence).
//
// Run: node scripts/run-smokes.mjs gateway-refusal-reason

import { createServer } from "node:http";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const budget = "Budget has been exceeded! TeamMember=00000000-0000-4000-8000-000000000000:1000 Current cost: 40.23051339999999, Max budget: 40.0";
const answers: Record<string, { status: number; type: string; body: string }> = {
	"/budget/models": { status: 422, type: "application/json", body: JSON.stringify({ error: { message: budget, type: "budget_exceeded", param: null, code: "422" } }) },
	"/detail/models": { status: 400, type: "application/json", body: JSON.stringify({ detail: "Model group not allowed for this key." }) },
	"/long/models": { status: 429, type: "text/plain", body: `Too many requests.\nTry again later.${" Retry".repeat(200)}` },
	"/html/models": { status: 502, type: "text/html", body: "<html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1></body></html>" },
	"/key/models": { status: 401, type: "application/json", body: JSON.stringify({ error: { message: "Authentication Error, invalid key" } }) },
	"/framework/models": { status: 422, type: "application/json", body: JSON.stringify({ statusCode: 422, error: "Unprocessable Entity", message: "Budget exceeded for team member" }) },
	"/bom/models": { status: 422, type: "application/json", body: `\uFEFF${JSON.stringify({ error: { message: "after the mark" } })}` },
	"/broken/models": { status: 422, type: "application/json", body: '{"error": {"message": "cut off' },
	"/emoji/models": { status: 429, type: "text/plain", body: "😀".repeat(400) },
	"/missing/models": { status: 404, type: "application/json", body: JSON.stringify({ message: "Not Found" }) },
	"/echo/models": { status: 422, type: "text/plain", body: "Invalid header Authorization: Bearer test-key-0123456789" },
};

const server = createServer((req, res) => {
	const answer = answers[req.url ?? ""];
	res.statusCode = answer?.status ?? 404;
	res.setHeader("content-type", answer?.type ?? "text/plain");
	res.end(answer?.body ?? "not found");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const { discoverGatewayModels } = await import("../src/openai-compatible-gateway-detect.js");

async function refusal(path: string): Promise<string> {
	try {
		await discoverGatewayModels(`${root}${path}`, "test-key-0123456789");
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error(`${path}: the setup should have failed`);
}

try {
	const budgetMessage = await refusal("/budget");
	assert(budgetMessage === "The gateway refused: this key's budget is used up (40.23 of 40.00).", `the budget reason reaches the person in plain words, rounded, with no status code and no member id, got: ${budgetMessage}`);

	const detailMessage = await refusal("/detail");
	assert(detailMessage === "The gateway refused: Model group not allowed for this key.", `a FastAPI-style detail is read, got: ${detailMessage}`);

	const longMessage = await refusal("/long");
	assert(longMessage.startsWith("The gateway refused: Too many requests. Try again later."), `a multi-line reason becomes one line, got: ${longMessage}`);
	assert(!longMessage.includes("\n") && longMessage.length <= 400, `a long reason is cut to one short line, got ${longMessage.length} characters`);

	const htmlMessage = await refusal("/html");
	assert(htmlMessage === `The gateway answered 502 for ${root}/html/models.`, `an HTML page is not a reason, got: ${htmlMessage}`);

	const keyMessage = await refusal("/key");
	assert(keyMessage === "The gateway rejected the API key.", `a rejected key keeps its own sentence, got: ${keyMessage}`);

	const frameworkMessage = await refusal("/framework");
	assert(frameworkMessage === "The gateway refused: Budget exceeded for team member", `a status phrase in error does not hide the message, got: ${frameworkMessage}`);

	const bomMessage = await refusal("/bom");
	assert(bomMessage === "The gateway refused: after the mark", `a byte-order mark before the JSON is skipped, got: ${bomMessage}`);

	const brokenMessage = await refusal("/broken");
	assert(brokenMessage === `The gateway answered 422 for ${root}/broken/models.`, `JSON that does not parse is never shown raw, got: ${brokenMessage}`);

	const emojiMessage = await refusal("/emoji");
	const halves = emojiMessage.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
	assert(!/[\uD800-\uDFFF]/.test(halves), `the cut never splits a character, got: ${emojiMessage.slice(-8)}`);

	const missingMessage = await refusal("/missing");
	assert(missingMessage === `The gateway answered 404 for ${root}/missing/models.`, `a 404 keeps the address, which is what helps, got: ${missingMessage}`);

	const echoMessage = await refusal("/echo");
	assert(!echoMessage.includes("test-key-0123456789") && echoMessage.includes("Bearer …"), `an echoed key is masked, got: ${echoMessage}`);

	console.log("gateway refusal reason smoke: ok");
} finally {
	server.close();
}
