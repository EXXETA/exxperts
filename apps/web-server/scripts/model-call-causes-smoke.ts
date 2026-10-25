// One reading of a failed call to the Memory model, and one patience.
//
// Pins the cause of every provider failure the facts files list (Remember's
// 8a table, Memorize's 6.1), in the words the providers and the runtime really
// send, and the patience every Memory model call gets: busy is waited out a
// bounded number of times with the next try's time published; signed out, out
// of quota and no longer offered end at once; a rate limit that outlasts the
// patience is "still busy"; a stall gets two more tries and a timeout one
// (each can cost the whole ceiling), then the probe; a refusal or a request
// too large is handed back untouched for the caller's own ladder.
//
// Offline: no server, no provider, no network. The clock and the sleep are fakes.

import {
	callWithPatience,
	classifyModelFailure,
	ModelUnreachableError,
	modelNotOffered,
	patienceSpent,
	PATIENCE_WAITS_MS,
	roomCallWait,
	signInFailed,
	turnFailureOf,
	withRoomCallWait,
	type PatienceWait,
} from "../src/model-call-causes.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IsolatedPersistentAgentWorkerTurnError } from "../src/persistent-agent-worker-runtime.js";
import { failureLineText, providerSentence, turnFailureLine as turnFailureParts } from "../../web-ui/src/turn-failure-line.js";
// A chat line's text as it is first said, nothing of the message lost.
const turnFailureLine = (...args: Parameters<typeof turnFailureParts>): string => failureLineText(turnFailureParts(...args), "lost");
// The very function the page's Memory lines read a worker failure with (App.tsx, maintenanceCredentialLine).
import { signInFailed as pageSignInFailed } from "../src/model-not-offered.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const workerError = (message: string) => new IsolatedPersistentAgentWorkerTurnError("checkpoint compression worker", "error", message);
const model = { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5" };

// --- The causes ---------------------------------------------------------------

const table: Array<[unknown, string, string?]> = [
	// busy
	[workerError('429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'), "busy", "rate-limit"],
	[workerError("RateLimitError: litellm.RateLimitError: AnthropicException"), "busy", "rate-limit"],
	[workerError("ThrottlingException: Too many tokens, please wait before trying again."), "busy", "rate-limit"],
	[workerError("429 Too Many Requests"), "busy", "too-many-requests"],
	[workerError('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), "busy", "overload"],
	[workerError('500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'), "busy", "server-error"],
	[workerError("502 Bad Gateway"), "busy", "server-error"],
	[workerError("504 Gateway Timeout"), "busy", "server-error"],
	[workerError("503 Service Unavailable"), "busy", "server-error"],
	[workerError("Connection error."), "busy", "connection"],
	[workerError("terminated"), "busy", "connection"],
	[workerError("read ECONNRESET"), "busy", "connection"],
	[workerError("getaddrinfo ENOTFOUND api.anthropic.com"), "busy", "connection"],
	[workerError("fetch failed"), "busy", "connection"],
	// a status number inside a rate limit's own words is a count, not a sign-in
	[workerError("429 Rate limit reached for gpt-6 in organization org-x on tokens per min (TPM): Limit 30000, Used 29600, Requested 401. Please try again in 802ms."), "busy", "rate-limit"],
	[workerError('403 {"error":{"message":"rate limit exceeded for this credential, slow down"}}'), "busy", "rate-limit"],
	// Gemini's per-minute limit says "quota" and names its wait: it is a rate limit
	[workerError('429 {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. Please retry in 32.5s.","status":"RESOURCE_EXHAUSTED"}}'), "busy", "rate-limit"],
	[new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "it ran past its 480 second limit and was stopped", { reason: "timed-out" }), "busy", "timed-out"],
	[new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "it stopped answering for 90 seconds", { reason: "stalled" }), "busy", "stalled"],
	// unreachable
	[workerError('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), "unreachable", "signed-out"],
	[workerError('403 {"type":"error","error":{"type":"permission_error"}}'), "unreachable", "region-or-plan"],
	[workerError("litellm.AuthenticationError: Error code: 401"), "unreachable", "signed-out"],
	[workerError("HTTP 403 Forbidden"), "unreachable", "region-or-plan"],
	[new Error("No API key found for anthropic"), "unreachable", "signed-out"],
	[new Error("checkpoint compression model provider not connected: anthropic/claude-sonnet-5"), "unreachable", "signed-out"],
	[Object.assign(new Error("This room's memory model is signed out."), { code: "provider_signed_out" }), "unreachable", "signed-out"],
	[workerError("429 You exceeded your current quota, please check your plan and billing details. insufficient_quota"), "unreachable", "quota"],
	// A bare quota or resource exhausted with no wait is a per-minute limit (Google's 429, on Vertex or through a gateway): busy, and asked again.
	[workerError("RESOURCE_EXHAUSTED: resource exhausted"), "busy", "rate-limit"],
	[workerError('429 {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}'), "busy", "rate-limit"],
	[workerError("litellm.RateLimitError: VertexAIException - Resource has been exhausted (e.g. check quota)."), "busy", "rate-limit"],
	// A spent plan, credit or budget, in each provider's own words, is out of quota.
	[workerError("429 You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min."), "unreachable", "quota"],
	[workerError("429 You have hit your ChatGPT usage limit (pro plan). Try again in 158 min."), "unreachable", "quota"],
	[workerError('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'), "unreachable", "quota"],
	[workerError('422 {"error":{"message":"Budget has been exceeded! Current cost: 40.23, Max budget: 40.0","type":"budget_exceeded","param":null,"code":"422"}}'), "unreachable", "quota"],
	[workerError("litellm.BudgetExceededError: ExceededBudget: User=abc over budget"), "unreachable", "quota"],
	// LiteLLM's key, team and organization budgets, as its auth checks word them.
	[workerError("litellm.BudgetExceededError: Budget has been exceeded! Key=sk-...abcd Current cost: 40.23, Max budget: 40.0"), "unreachable", "quota"],
	[workerError("litellm.BudgetExceededError: ExceededBudget: Key over 1d budget. Spend=$12.0000, Limit=$10.00"), "unreachable", "quota"],
	[workerError("litellm.BudgetExceededError: ExceededBudget: Team=t1 over 30d budget. Spend=$12.0000, Limit=$10.00"), "unreachable", "quota"],
	[workerError("litellm.BudgetExceededError: Budget has been exceeded! Organization=o1 Current cost: 101, Max budget: 100"), "unreachable", "quota"],
	// A key or credential without access to one model: that model is not offered to it, signing in again cannot help.
	[workerError("403 Your API key does not have access to this model"), "unreachable", "not-offered"],
	[workerError("403 This credential's organization has no access to model gpt-6-sol"), "unreachable", "not-offered"],
	[new Error("checkpoint compression model not found: anthropic/claude-sonnet-4"), "unreachable", "not-offered"],
	[workerError('404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-old"}}'), "unreachable", "not-offered"],
	[Object.assign(new Error("This room's memory model is no longer offered."), { code: "room_model_unavailable" }), "unreachable", "not-offered"],
	// refused
	[workerError("the model refused to answer this request"), "refused"],
	[workerError("Provider finish_reason: content_filter"), "refused"],
	[workerError("incomplete: content_filter"), "refused"],
	// too large
	[workerError('400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}'), "too-large"],
	[workerError("Request too large for gpt-6 in organization org-x on tokens per min (TPM): Limit 30000, Requested 90000. rate_limit_exceeded"), "too-large"],
	// cancelled, and the rest
	[new IsolatedPersistentAgentWorkerTurnError("w", "aborted", undefined), "cancelled"],
	[workerError("the model returned an error without a message"), "other"],
	[workerError("Request used 4290 tokens"), "other"],
];
const misread: string[] = [];
for (const [error, cause, detail] of table) {
	const failure = classifyModelFailure(error);
	const words = error instanceof Error ? error.message : String(error);
	if (failure.cause !== cause || (detail && !("detail" in failure && failure.detail === detail))) misread.push(`"${words}" is ${cause}${detail ? `/${detail}` : ""}, got ${JSON.stringify(failure)}`);
}
assert(misread.length === 0, `misread failures:\n${misread.join("\n")}`);
pass(`${table.length} provider failures each read as their cause`);

// A model the provider does not serve, whatever its id holds: dots, a slash,
// a colon, backticks or quotes around it. Anything else that names a model (a
// parameter, a full model, a size, a rate limit, a sign-in, ChatGPT's
// not-on-account words) is never read as not offered.
const notOfferedWords = [
	"The model 'claude-opus-4.6' does not exist",
	"The model `openai/gpt-6.1-sol` does not exist.",
	"The model `llama3.1:70b` does not exist",
	"model gpt-6.1-sol does not exist",
	'404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-4.6"}}',
	"404 The requested model claude-opus-4.6 was not found",
];
// OpenAI's words for a model this key or project cannot use, retired or not: not available to it, never "no longer offered".
const noAccessWords = [
	"The model `gpt-6.1-sol` does not exist or you do not have access to it.",
	"The model `gpt-5.6-terra` does not exist or you do not have access to it.",
	"The model \"openai/gpt-6.1-sol\" does not exist or you do not have access to it.",
	"The model `us.anthropic.claude-opus-4-6-v1:0` does not exist or you do not have access to it.",
	'404 {"error":{"message":"The model `gpt-6.1-sol` does not exist or you do not have access to it.","type":"invalid_request_error","param":null}}',
	'{"detail":"The model `gpt-6.1-sol` does not exist or you do not have access to it."}',
	"403 Project `proj_x1` does not have access to model `gpt-6.1-sol`",
];
const notNotOfferedWords: Array<[string, string]> = [
	["Unsupported parameter: 'temperature' is not supported with this model.", "other"],
	["Unsupported value: 'reasoning.effort' does not support 'minimal' with the 'gpt-6.1-sol' model.", "other"],
	["reasoning.effort 'xhigh' is not supported for this model", "other"],
	["Selected model is at capacity. Please try a different model.", "other"],
	["400 Bad Request", "other"],
	["This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.", "too-large"],
	["Rate limit reached for gpt-6.1-sol in organization org-x on tokens per min (TPM): Limit 30000, Used 29600, Requested 900.", "busy"],
	["401 Incorrect API key provided: sk-...abcd. You can find your API key at https://platform.openai.com/account/api-keys.", "unreachable/signed-out"],
	["The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", "unreachable/not-on-account"],
	["The model answered. The file report.v2.md does not exist.", "other"],
	["404 Not Found. The model gpt-6.1-sol answered.", "other"],
	["The project `proj_x1` does not exist or you do not have access to it.", "other"],
	["404 Not Found: POST https://gateway.example.com/v1/model/info", "other"],
	["404 Not Found: POST https://api.example.com/v1/models/model-router/x", "other"],
];
const misnamed: string[] = [];
for (const words of notOfferedWords) {
	const failure = classifyModelFailure(workerError(words));
	if (!modelNotOffered(words) || failure.cause !== "unreachable" || failure.detail !== "not-offered") misnamed.push(`${JSON.stringify(words)} is not offered, got ${JSON.stringify(failure)}`);
}
for (const [words, read] of notNotOfferedWords) {
	const failure = classifyModelFailure(workerError(words));
	const got = "detail" in failure && failure.cause === "unreachable" ? `${failure.cause}/${failure.detail}` : failure.cause;
	if (modelNotOffered(words) || got !== read) misnamed.push(`${JSON.stringify(words)} is ${read}, never not offered, got ${got}`);
}
for (const words of noAccessWords) {
	const failure = classifyModelFailure(workerError(words));
	if (failure.cause !== "unreachable" || failure.detail !== "not-on-account") misnamed.push(`${JSON.stringify(words)} is not available to this key, got ${JSON.stringify(failure)}`);
}
assert(misnamed.length === 0, `the not-offered matcher:\n${misnamed.join("\n")}`);
pass(`a model not offered reads so whatever its id holds (${notOfferedWords.length}), a model this key cannot use reads as not available (${noAccessWords.length}), and ${notNotOfferedWords.length} other failures never read as not offered`);

// --- Each provider's documented failures, as the runtime hands them on --------
//
// The bodies and texts each provider documents for its errors, in the words its
// client turns them into and with the status and error type the runtime keeps
// beside them. Each must read as its kind; the status counts only where the
// words name nothing known.

type Delivered = { provider: string; words: string; status?: number; type?: string; kind: string };
// The Anthropic and OpenAI clients lead with the status; the body follows as JSON (Anthropic) or as its message (OpenAI).
const anthropic = (status: number, type: string, message: string): Delivered => ({ provider: "Anthropic", words: `${status} ${JSON.stringify({ type: "error", error: { type, message }, request_id: "req_011CSHoEeqs5C35K2UUqR7Fy" })}`, status, type, kind: "" });
const openai = (provider: string, status: number, message: string, type?: string): Delivered => ({ provider, words: `${status} ${message}`, status, ...(type ? { type } : {}), kind: "" });
// Google's client throws the body itself, with no status in front.
const google = (provider: string, code: number, status: string, message: string): Delivered => ({ provider, words: JSON.stringify({ error: { code, message, status } }), status: code, type: status, kind: "" });
// The runtime writes a Bedrock exception as a plain prefix, or the exception's own name, before its message.
const bedrock = (status: number, name: string, words: string): Delivered => ({ provider: "Bedrock", words, status, type: name, kind: "" });
// The runtime writes a Mistral failure as "Mistral API error (status): body".
const mistral = (status: number, body: unknown): Delivered => ({ provider: "Mistral", words: `Mistral API error (${status}): ${JSON.stringify(body)}`, status, kind: "" });
// The OpenAI client reads a body with no "error" field as no body; the runtime puts the body after it.
const unreadBody = (provider: string, status: number, body: unknown): Delivered => ({ provider, words: `${status} status code (no body)\n${JSON.stringify(body)}`, status, kind: "" });
const reads = (kind: string, delivered: Delivered): Delivered => ({ ...delivered, kind });

const documented: Delivered[] = [
	// Anthropic's docs: one type per status, the body shape and its example.
	reads("unreachable/signed-out", anthropic(401, "authentication_error", "invalid x-api-key")),
	reads("unreachable/quota", anthropic(402, "billing_error", "There's an issue with your billing or payment information.")),
	reads("unreachable/region-or-plan", anthropic(403, "permission_error", "Your API key does not have permission to use the specified resource.")),
	reads("unreachable/not-offered", anthropic(404, "not_found_error", "The requested resource could not be found.")),
	reads("too-large", anthropic(413, "request_too_large", "Request exceeds the maximum allowed number of bytes.")),
	reads("busy/rate-limit", anthropic(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit")),
	reads("busy/server-error", anthropic(500, "api_error", "Internal server error")),
	reads("busy/server-error", anthropic(504, "timeout_error", "Request timed out")),
	reads("busy/overload", anthropic(529, "overloaded_error", "Overloaded")),
	// Anthropic's docs, an error event in a stream: no status.
	reads("busy/overload", { provider: "Anthropic", words: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), type: "overloaded_error", kind: "" }),
	// OpenAI's docs, its error codes.
	reads("unreachable/signed-out", openai("OpenAI", 401, "Invalid Authentication", "invalid_api_key")),
	reads("unreachable/signed-out", openai("OpenAI", 401, "Incorrect API key provided: sk-abc12***************************cdef. You can find your API key at https://platform.openai.com/account/api-keys.", "invalid_api_key")),
	reads("unreachable/signed-out", openai("OpenAI", 401, "You must be a member of an organization to use the API.")),
	reads("unreachable/signed-out", openai("OpenAI", 401, "IP not authorized")),
	reads("unreachable/region-or-plan", openai("OpenAI", 403, "Country, region, or territory not supported", "unsupported_country_region_territory")),
	reads("unreachable/quota", openai("OpenAI", 429, "Credit balance exhausted")),
	reads("busy/rate-limit", openai("OpenAI", 429, "Rate limit reached for requests", "rate_limit_exceeded")),
	reads("busy/too-many-requests", openai("OpenAI", 429, "Slow down")),
	reads("unreachable/quota", openai("OpenAI", 429, "Organization spend limit reached")),
	reads("unreachable/quota", openai("OpenAI", 429, "Project spend limit reached")),
	reads("unreachable/quota", openai("OpenAI", 429, "Organization usage limit reached")),
	reads("unreachable/quota", openai("OpenAI", 429, "You exceeded your current quota, please check your plan and billing details.", "insufficient_quota")),
	reads("busy/server-error", openai("OpenAI", 500, "The server had an error while processing your request. Sorry about that!", "server_error")),
	reads("busy/overload", openai("OpenAI", 503, "Model temporarily overloaded")),
	// OpenAI's Responses API docs: a failed response in the stream, as the runtime words it.
	reads("busy/server-error", { provider: "OpenAI Responses", words: "server_error: The server had an error while processing your request.", kind: "" }),
	reads("busy/rate-limit", { provider: "OpenAI Responses", words: "rate_limit_exceeded: Rate limit reached for requests", kind: "" }),
	reads("unreachable/quota", { provider: "OpenAI Responses", words: "Error Code insufficient_quota: You exceeded your current quota, please check your plan and billing details.", kind: "" }),
	// Azure OpenAI's docs.
	reads("unreachable/signed-out", openai("Azure OpenAI", 401, "Access denied due to invalid subscription key or wrong API endpoint. Make sure to provide a valid key for an active subscription and use a correct regional API endpoint for your resource.", "401")),
	reads("unreachable/not-offered", openai("Azure OpenAI", 404, "The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again.", "DeploymentNotFound")),
	reads("busy/rate-limit", openai("Azure OpenAI", 429, "Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-10-21 have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 6 seconds.", "429")),
	reads("refused", openai("Azure OpenAI", 400, "The response was filtered due to the prompt triggering Azure OpenAI's content management policy. Please modify your prompt and retry.", "content_filter")),
	// The ChatGPT sign-in (Codex): its usage limit, as the runtime words it, and statuses with no status in the words.
	reads("unreachable/quota", { provider: "Codex", words: "You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min.", status: 429, type: "usage_limit_reached", kind: "" }),
	reads("unreachable/signed-out", { provider: "Codex", words: "Unauthorized", status: 401, kind: "" }),
	reads("busy/server-error", { provider: "Codex", words: "An error occurred while processing your request.", status: 500, kind: "" }),
	// Google's (Gemini API) docs: the status string and its code, the body as the client throws it.
	reads("unreachable/signed-out", google("Gemini", 400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.")),
	reads("unreachable/region-or-plan", google("Gemini", 400, "FAILED_PRECONDITION", "User location is not supported for the API use.")),
	reads("unreachable/region-or-plan", google("Gemini", 400, "FAILED_PRECONDITION", "Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.")),
	reads("unreachable/quota", google("Gemini", 402, "PAYMENT_REQUIRED", "Your Prepay credit balance is depleted.")),
	reads("unreachable/region-or-plan", google("Gemini", 403, "PERMISSION_DENIED", "Your API key doesn't have the required permissions.")),
	reads("unreachable/not-offered", google("Gemini", 404, "NOT_FOUND", "models/gemini-9.0-scripted is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.")),
	reads("busy/rate-limit", google("Gemini", 429, "RESOURCE_EXHAUSTED", "You've exceeded the rate limit.")),
	reads("busy/server-error", google("Gemini", 500, "INTERNAL", "An internal error has occurred. Please retry or report in https://developers.generativeai.google/guide/troubleshooting")),
	reads("busy/overload", google("Gemini", 503, "UNAVAILABLE", "The model is overloaded. Please try again later.")),
	reads("busy/server-error", google("Gemini", 504, "DEADLINE_EXCEEDED", "Deadline expired before operation could complete.")),
	// Vertex AI's docs: the same shapes.
	reads("busy/rate-limit", google("Vertex AI", 429, "RESOURCE_EXHAUSTED", "Resource exhausted. Please try again later.")),
	reads("unreachable/region-or-plan", google("Vertex AI", 403, "PERMISSION_DENIED", "Permission 'aiplatform.endpoints.predict' denied on resource '//aiplatform.googleapis.com/projects/scripted/locations/us-central1/publishers/google/models/gemini-scripted' (or it may not exist).")),
	// Amazon Bedrock's docs: each exception and its status.
	reads("unreachable/region-or-plan", bedrock(403, "AccessDeniedException", "AccessDeniedException: You don't have access to the model with the specified model ID.")),
	reads("unreachable/not-offered", bedrock(404, "ResourceNotFoundException", "ResourceNotFoundException: The requested resource could not be found.")),
	reads("busy/rate-limit", bedrock(429, "ThrottlingException", "Throttling error: Too many requests, please wait before trying again.")),
	reads("busy/too-many-requests", bedrock(429, "ModelNotReadyException", "ModelNotReadyException: The model specified in the request is not ready to serve inference requests.")),
	reads("busy/server-error", bedrock(500, "InternalServerException", "Internal server error: An internal server error occurred.")),
	reads("busy/server-error", bedrock(503, "ServiceUnavailableException", "Service unavailable: The service isn't currently available.")),
	reads("too-large", bedrock(400, "ValidationException", "Validation error: Input is too long for requested model.")),
	reads("other", bedrock(408, "ModelTimeoutException", "ModelTimeoutException: The request took too long to process.")),
	// Mistral's docs: its error body.
	reads("unreachable/signed-out", mistral(401, { message: "Unauthorized", request_id: "scripted" })),
	reads("busy/rate-limit", mistral(429, { message: "Requests rate limit exceeded" })),
	reads("too-large", mistral(400, { object: "error", message: "Prompt contains 40000 tokens, too large for model with 32768 maximum context length", type: "invalid_request_error", param: null, code: null })),
	reads("busy/server-error", mistral(503, { object: "error", message: "Service unavailable", type: "internal_server_error", param: null, code: null })),
	// Cloudflare Workers AI's docs: each error's name and code, in its body with no "error" field.
	reads("unreachable/not-offered", unreadBody("Cloudflare", 404, { errors: [{ message: "AiError: Invalid model ID", code: 3042 }], success: false })),
	reads("too-large", unreadBody("Cloudflare", 413, { errors: [{ message: "AiError: Request too large", code: 3006 }], success: false })),
	reads("unreachable/quota", unreadBody("Cloudflare", 429, { errors: [{ message: "AiError: Account limited: you have used up your daily free allocation of 10,000 neurons", code: 3036 }], success: false })),
	reads("busy/too-many-requests", unreadBody("Cloudflare", 429, { errors: [{ message: "AiError: Capacity temporarily exceeded, please try again", code: 3040 }], success: false })),
	reads("unreachable/region-or-plan", unreadBody("Cloudflare", 403, { errors: [{ message: "AiError: Account not allowed for private model", code: 5018 }], success: false })),
	// A company gateway's docs (AWS API Gateway, Kong): a bare body with a message.
	reads("unreachable/region-or-plan", unreadBody("API Gateway", 403, { message: "Forbidden" })),
	reads("busy/too-many-requests", unreadBody("API Gateway", 429, { message: "Too Many Requests" })),
	reads("busy/server-error", unreadBody("API Gateway", 504, { message: "Endpoint request timed out" })),
	reads("unreachable/signed-out", unreadBody("Kong", 401, { message: "No API key found in request" })),
	reads("busy/rate-limit", unreadBody("Kong", 429, { message: "API rate limit exceeded" })),
	// LiteLLM's docs: its exception per status, through its OpenAI-shaped proxy.
	reads("unreachable/signed-out", openai("LiteLLM", 401, "litellm.AuthenticationError: AuthenticationError: OpenAIException - Incorrect API key provided")),
	reads("unreachable/quota", openai("LiteLLM", 402, "litellm.PaymentRequiredError: PaymentRequiredError")),
	reads("unreachable/region-or-plan", openai("LiteLLM", 403, "litellm.PermissionDeniedError: PermissionDeniedError")),
	reads("unreachable/not-offered", openai("LiteLLM", 404, "litellm.NotFoundError: NotFoundError: OpenAIException - The model `gpt-scripted` does not exist")),
	reads("busy/rate-limit", openai("LiteLLM", 429, "litellm.RateLimitError: RateLimitError: OpenAIException - Rate limit reached")),
	reads("busy/server-error", openai("LiteLLM", 503, "litellm.ServiceUnavailableError: ServiceUnavailableError")),
	reads("too-large", openai("LiteLLM", 400, "litellm.ContextWindowExceededError: ContextWindowExceededError: OpenAIException - This model's maximum context length is 8192 tokens.")),
	reads("refused", openai("LiteLLM", 400, "litellm.ContentPolicyViolationError: ContentPolicyViolationError: AzureException - The response was filtered due to the prompt triggering Azure OpenAI's content management policy.")),
	// Ollama's docs: its error strings, through its OpenAI-compatible endpoint.
	reads("unreachable/not-offered", openai("Ollama", 404, 'model "llama9-scripted" not found, try pulling it first')),
	reads("busy/server-error", openai("Ollama", 500, "the model failed to generate a response")),
	reads("busy/server-error", openai("Ollama", 502, "an error was encountered while running the model")),
];
const kindOf = (failure: ReturnType<typeof classifyModelFailure>) => ("detail" in failure ? `${failure.cause}/${failure.detail}` : failure.cause);
const documentedMisread: string[] = [];
for (const delivered of documented) {
	const failure = classifyModelFailure(new IsolatedPersistentAgentWorkerTurnError("w", "error", delivered.words, { errorStatus: delivered.status, errorType: delivered.type }));
	if (kindOf(failure) !== delivered.kind) documentedMisread.push(`${delivered.provider} ${delivered.status ?? "-"} "${delivered.words.slice(0, 120)}" is ${delivered.kind}, got ${kindOf(failure)}`);
}
assert(documentedMisread.length === 0, `documented provider failures misread:\n${documentedMisread.join("\n")}`);
pass(`${documented.length} documented provider failures, as the runtime hands them on, each read as their kind`);

// The runtime keeps the status and the error type each provider's client hands up, from the client's own error.
{
	const { default: Anthropic } = await import("@anthropic-ai/sdk");
	const { default: OpenAI } = await import("openai");
	const { ApiError } = await import("@google/genai");
	const { ThrottlingException } = await import("@aws-sdk/client-bedrock-runtime");
	const { SDKError } = await import("@mistralai/mistralai/models/errors/sdkerror.js");
	const { providerErrorFields } = (await import("@exxeta/exxperts-ai")) as { providerErrorFields?: (error: unknown) => { errorStatus?: number; errorType?: string } };
	assert(typeof providerErrorFields === "function", "the runtime reads a failed call's status and error type");
	const headers = new Headers();
	const mistralBody = JSON.stringify({ object: "error", message: "Invalid model", type: "invalid_request_error", param: null, code: null });
	const mistralResponse = new Response(mistralBody, { status: 400, headers: { "content-type": "application/json" } });
	const thrown: Array<[string, unknown, { errorStatus?: number; errorType?: string }]> = [
		["Anthropic", Anthropic.APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" } }, undefined, headers), { errorStatus: 429, errorType: "rate_limit_error" }],
		["Anthropic, in a stream", new Anthropic.APIError(undefined, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, headers), { errorType: "overloaded_error" }],
		["OpenAI", OpenAI.APIError.generate(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota", param: null } }, undefined, headers), { errorStatus: 429, errorType: "insufficient_quota" }],
		["a gateway with an empty type", OpenAI.APIError.generate(402, { error: { message: "litellm.PaymentRequiredError", type: "None", param: "None", code: "402" } }, undefined, headers), { errorStatus: 402 }],
		["Google", new ApiError({ message: JSON.stringify({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }), status: 503 }), { errorStatus: 503, errorType: "UNAVAILABLE" }],
		["Bedrock", new ThrottlingException({ message: "Too many requests, please wait before trying again.", $metadata: { httpStatusCode: 429 } }), { errorStatus: 429, errorType: "ThrottlingException" }],
		["Mistral", new SDKError("API error occurred", { response: mistralResponse, request: new Request("http://127.0.0.1/"), body: mistralBody }), { errorStatus: 400, errorType: "invalid_request_error" }],
		["a dropped connection", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), {}],
	];
	for (const [client, error, expected] of thrown) {
		const got = providerErrorFields(error);
		assert(JSON.stringify(got) === JSON.stringify(expected), `${client}: the runtime keeps ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
	}
	pass("the runtime keeps the status and the error type from each client's own error: Anthropic, OpenAI, Google, Bedrock, Mistral");
}

// A status only counts where the words name nothing: every failure the words read keeps its kind whatever status rides along.
{
	const changed: string[] = [];
	for (const [error, cause, detail] of table) {
		if (!(error instanceof IsolatedPersistentAgentWorkerTurnError) || error.reason) continue;
		const wordsOnly = kindOf(classifyModelFailure(error));
		if (wordsOnly === "other" || wordsOnly === "cancelled") continue;
		for (const status of [401, 402, 403, 404, 413, 429, 500, 503, 529]) {
			const withStatus = kindOf(classifyModelFailure(new IsolatedPersistentAgentWorkerTurnError("w", "error", error.providerMessage, { errorStatus: status })));
			if (withStatus !== wordsOnly) changed.push(`"${error.providerMessage}" with ${status} became ${withStatus}, read ${wordsOnly}${detail ? ` (${cause}/${detail})` : ""}`);
		}
	}
	assert(changed.length === 0, `a status changed what the words already read:\n${changed.join("\n")}`);
	pass("a status never changes a failure its words already read");
}

// Words that name nothing, with a status that does: each mapped status reads as its kind, in the chat as in Memory.
{
	const unknown = "Something unusual happened.";
	const byStatus: Array<[number, string, string]> = [
		[401, "unreachable/signed-out", "signed-out"],
		[402, "unreachable/quota", "quota"],
		[403, "unreachable/region-or-plan", "region-or-plan"],
		[404, "unreachable/not-offered", "not-offered"],
		[413, "too-large", "other"],
		[429, "busy/too-many-requests", "other"],
		[500, "busy/server-error", "other"],
		[502, "busy/server-error", "other"],
		[503, "busy/server-error", "other"],
		[504, "busy/server-error", "other"],
		[529, "busy/overload", "other"],
		[400, "other", "other"],
		[409, "other", "other"],
		[422, "other", "other"],
	];
	const wrong: string[] = [];
	for (const [status, kind, chat] of byStatus) {
		const memory = kindOf(classifyModelFailure(new IsolatedPersistentAgentWorkerTurnError("w", "error", unknown, { errorStatus: status })));
		if (memory !== kind) wrong.push(`${status} reads ${kind} in Memory, got ${memory}`);
		const turn = turnFailureOf(unknown, false, "openai", false, { errorStatus: status });
		if (turn !== chat) wrong.push(`${status} reads ${chat} in the chat, got ${turn}`);
	}
	// Retried by the runtime, a busy status is still busy in the chat.
	for (const status of [429, 529]) if (turnFailureOf(unknown, true, "openai", false, { errorStatus: status }) !== "still-busy") wrong.push(`${status} after the runtime's retries is still busy, got ${turnFailureOf(unknown, true, "openai", false, { errorStatus: status })}`);
	// The ChatGPT sign-in's client asks a 429 again itself, so the runtime does not: still busy all the same; its 5xx keeps the plain line, and another API's 429 needs the runtime's own tries.
	const codex = (status: number, api = "openai-codex-responses") => turnFailureOf(unknown, false, "openai-codex", false, { errorStatus: status, api });
	if (codex(429) !== "still-busy" || codex(503) !== "other" || codex(429, "openai-responses") !== "other") wrong.push(`the client's own tries: 429 still busy, 503 other, another API's 429 other, got ${codex(429)}, ${codex(503)}, ${codex(429, "openai-responses")}`);
	// Without a status, the same words name nothing.
	if (kindOf(classifyModelFailure(workerError(unknown))) !== "other" || turnFailureOf(unknown, false, "openai") !== "other") wrong.push("words that name nothing, with no status, read as other");
	// A 429 names its wait when the words do.
	const waited = classifyModelFailure(new IsolatedPersistentAgentWorkerTurnError("w", "error", "Please try again in 20s.", { errorStatus: 429 }));
	if (!(waited.cause === "busy" && waited.detail === "too-many-requests" && waited.waitMs === 20_000)) wrong.push(`a 429 keeps the wait its words name, got ${JSON.stringify(waited)}`);
	assert(wrong.length === 0, `statuses misread:\n${wrong.join("\n")}`);
	pass("words that name nothing read as their status says: 401, 402, 403, 404, 413, 429, 500, 502, 503, 504 and 529; any other status stays as it was");
}

// --- Patience -----------------------------------------------------------------

function fakeClock() {
	let at = Date.parse("2026-10-08T10:00:00.000Z");
	const slept: number[] = [];
	return {
		slept,
		now: () => new Date(at),
		sleep: async (ms: number) => { slept.push(ms); at += ms; },
	};
}

function scripted(failures: unknown[], answer = "ok") {
	let calls = 0;
	return {
		get calls() { return calls; },
		call: async () => {
			calls += 1;
			const next = failures.shift();
			if (next !== undefined) throw next;
			return answer;
		},
	};
}

async function rejects(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to fail");
}

{
	const clock = fakeClock();
	const waits: Array<PatienceWait | null> = [];
	const fake = scripted([workerError("429 rate_limit_error"), workerError("429 rate_limit_error")]);
	const result = await callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, onWait: (wait) => waits.push(wait) });
	assert(result === "ok" && fake.calls === 3, `a 429 twice, then the answer: three calls, got ${fake.calls}`);
	assert(clock.slept.join(",") === `${PATIENCE_WAITS_MS[0]},${PATIENCE_WAITS_MS[1]}`, `the waits follow the schedule, got ${clock.slept.join(",")}`);
	const shown = waits.filter((wait): wait is PatienceWait => wait !== null);
	assert(shown.length === 2 && shown[0]!.attempt === 2 && shown[1]!.attempt === 3, "each wait is published with the try that comes next");
	assert(shown[0]!.nextTryAt === "2026-10-08T10:00:15.000Z" && shown[1]!.nextTryAt === "2026-10-08T10:00:45.000Z", `each wait names the next try's time, got ${shown.map((wait) => wait.nextTryAt).join(", ")}`);
	assert(!shown[0]!.again && shown[1]!.again === true, "the second wait is marked as again: busy was already said");
	const afterUnreached = scripted([workerError("Connection error."), workerError("429 rate_limit_error"), workerError("429 rate_limit_error")]);
	const unreachedClock = fakeClock();
	const unreachedWaits: PatienceWait[] = [];
	await callWithPatience(afterUnreached.call, { model, sleep: unreachedClock.sleep, now: unreachedClock.now, probe: async () => "ok", onWait: (wait) => { if (wait) unreachedWaits.push(wait); } });
	assert(unreachedWaits.map((wait) => `${wait.cause}${wait.again ? "+again" : ""}`).join(",") === "unreached,busy,busy+again", `after an unreached wait the first busy wait is not marked again, got ${JSON.stringify(unreachedWaits)}`);
	assert(waits[waits.length - 1] === null, "the wait line is cleared once the call answered");
	pass("a busy model is waited out, and the line names the next try's time on each try");
}

{
	const clock = fakeClock();
	const fake = scripted([workerError("429 rate_limit_error. Please try again in 50s")]);
	await callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now });
	assert(clock.slept[0] === 50_000, `a wait the provider names is kept, got ${clock.slept[0]}`);
	const short = scripted([workerError("429 rate_limit_error. retry after 2 seconds")]);
	const shortClock = fakeClock();
	await callWithPatience(short.call, { model, sleep: shortClock.sleep, now: shortClock.now });
	assert(shortClock.slept[0] === 15_000, `a named wait below the floor is raised to it, got ${shortClock.slept[0]}`);
	const gemini = classifyModelFailure(workerError("RESOURCE_EXHAUSTED: You exceeded your current quota. Please retry in 32.5s."));
	assert(gemini.cause === "busy" && gemini.waitMs === 32_500, `Gemini's per-minute limit keeps the wait it names, got ${JSON.stringify(gemini)}`);
	// Google's per-minute 429 names no wait: a Memory model call is asked again, and gets through.
	const google = scripted([workerError('429 {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}')]);
	const googleClock = fakeClock();
	assert(await callWithPatience(google.call, { model, sleep: googleClock.sleep, now: googleClock.now }) === "ok" && google.calls === 2, `Google's per-minute limit is waited out, got ${google.calls} calls`);
	// A chat turn reads them the same way: the spent-credit words stop the runtime's retries, a bare quota does not.
	for (const words of ['429 {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}', "RESOURCE_EXHAUSTED: resource exhausted", "429 quota"]) {
		assert(turnFailureOf(words, false, "") !== "quota", `a bare quota in chat is not a spent one: "${words}" -> ${turnFailureOf(words, false, "")}`);
	}
	// A refusal that comes after part of an answer is still a refusal: "try again" would bring it back.
	for (const words of ["the model refused to answer this request", "Provider finish_reason: content_filter"]) {
		assert(turnFailureOf(words, false, "", true) === "refused", `a refusal after part of an answer reads as a refusal: "${words}" -> ${turnFailureOf(words, false, "", true)}`);
	}
	assert(turnFailureOf("terminated", false, "", true) === "cut-off", `an answer cut off part way stays cut off, got ${turnFailureOf("terminated", false, "", true)}`);
	for (const words of ["429 You exceeded your current quota, please check your plan and billing details. insufficient_quota", "Your credit balance is too low to access the Anthropic API.", "429 You have hit your ChatGPT usage limit (plus plan).", "Budget has been exceeded! Current cost: 40.23, Max budget: 40.0"]) {
		assert(turnFailureOf(words, false, "") === "quota", `the spent-credit words stop the retries in chat: "${words}" -> ${turnFailureOf(words, false, "")}`);
	}
	pass("a wait the provider names is used, within its bounds");
}

{
	// A first call that could not connect waits about 15 s under a true line, then asks the probe:
	// no answer is the notice; an answer makes it a blip (a network switch), waited out as busy.
	// The probe goes after the wait, since a network switch fails it too while it lasts.
	for (const message of ["fetch failed", "connect ECONNREFUSED 127.0.0.1:9", "getaddrinfo ENOTFOUND gateway.example", "fetch failed: ECONNREFUSED", "Connection error."]) {
		const clock = fakeClock();
		const waits: Array<PatienceWait | null> = [];
		const fake = scripted([workerError(message), workerError(message)]);
		let probes = 0;
		const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, onWait: (wait) => waits.push(wait), probe: async () => { probes += 1; throw workerError(message); } }));
		assert(error instanceof ModelUnreachableError && error.details.detail === "not-answering" && fake.calls === 1 && probes === 1, `a dead address ("${message}") is not answering after one wait, got ${String(error)} after ${fake.calls} call(s) and ${probes} probe(s)`);
		assert(clock.slept.join(",") === String(PATIENCE_WAITS_MS[0]), `the notice comes after the first wait, about 15 s, got ${clock.slept.join(",")}`);
		assert(waits[0]?.cause === "unreached" && waits[0].nextTryAt === "2026-10-08T10:00:15.000Z" && waits.at(-1) === null, `the wait is said at once as unreached, and cleared for the notice, got ${JSON.stringify(waits)}`);
	}
	for (const message of ["Connection error.", "fetch failed"]) {
		const clock = fakeClock();
		const blip = scripted([workerError(message)]);
		let probes = 0;
		// The probe fails while the switch lasts: it answers only once the first wait has passed.
		const probe = async () => { probes += 1; if (clock.slept.length === 0) throw workerError(message); return "ok"; };
		const result = await callWithPatience(blip.call, { model, sleep: clock.sleep, now: clock.now, probe });
		assert(result === "ok" && blip.calls === 2 && probes === 1 && clock.slept.length === 1, `a first call's "${message}" with the probe answering after the wait is a blip, waited out, got ${blip.calls} call(s), ${probes} probe(s), ${clock.slept.length} wait(s)`);
		const again = scripted([workerError(message), workerError(message)]);
		const againClock = fakeClock();
		const againWaits: PatienceWait[] = [];
		assert(await callWithPatience(again.call, { model, sleep: againClock.sleep, now: againClock.now, probe: async () => "ok", onWait: (wait) => { if (wait) againWaits.push(wait); } }) === "ok" && again.calls === 3, `a blip that fails once more is waited out as busy, got ${again.calls} call(s)`);
		assert(againWaits.map((wait) => wait.cause).join(",") === "unreached,busy" && againClock.slept.join(",") === `${PATIENCE_WAITS_MS[0]},${PATIENCE_WAITS_MS[1]}`, `then the busy line, on the busy schedule, got ${JSON.stringify(againWaits)} ${againClock.slept.join(",")}`);
		const bare = scripted([workerError(message)]);
		const bareClock = fakeClock();
		assert(await callWithPatience(bare.call, { model, sleep: bareClock.sleep, now: bareClock.now }) === "ok" && bareClock.slept.length === 1, `without a probe, a first call's "${message}" is waited out`);
	}
	{
		// A probe that meets a busy model after the unreached wait: the model answered, busy, so it is waited out, never "not answering".
		const clock = fakeClock();
		const fake = scripted([workerError("Connection error.")]);
		const result = await callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, probe: async () => { throw workerError('529 {"type":"error","error":{"type":"overloaded_error"}}'); } });
		assert(result === "ok" && fake.calls === 2, `a busy probe after the unreached wait goes on, got ${fake.calls} call(s)`);
		// A cancel that lands just as the probe answers: the wait line comes down, and no further call starts.
		{
			const controller = new AbortController();
			const answered = scripted([workerError("Connection error.")]);
			const answeredClock = fakeClock();
			const lines: Array<PatienceWait | null> = [];
			await rejects(callWithPatience(answered.call, { model, signal: controller.signal, sleep: answeredClock.sleep, now: answeredClock.now, onWait: (wait) => lines.push(wait), probe: async () => { controller.abort(); return "ok"; } }));
			assert(answered.calls === 1 && lines.length > 0 && lines[lines.length - 1] === null, `a cancel right after the probe answered takes the wait down, got ${JSON.stringify(lines.map((wait) => wait?.cause ?? null))} after ${answered.calls} call(s)`);
		}
		// A probe that timed out, went silent or dropped did not answer: the notice, with no further call.
		for (const [label, probeError] of [
			["timed out", new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "ran past its limit", { reason: "timed-out" })],
			["went silent", new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "stopped answering", { reason: "stalled" })],
			["dropped", workerError("read ECONNRESET")],
		] as const) {
			const silent = scripted([workerError("Connection error.")]);
			const silentClock = fakeClock();
			const ended = await rejects(callWithPatience(silent.call, { model, sleep: silentClock.sleep, now: silentClock.now, probe: async () => { throw probeError; } }));
			assert(ended instanceof ModelUnreachableError && ended.details.detail === "not-answering" && silent.calls === 1, `a probe that ${label} after the unreached wait is not an answer: the notice, got ${(ended as Error)?.message} after ${silent.calls} call(s)`);
		}
		// The line is taken down while the next try runs: the model may be answering it.
		const events: string[] = [];
		const busy = scripted([workerError("429 rate_limit_error")]);
		const busyClock = fakeClock();
		await callWithPatience(async () => { events.push("call"); return busy.call(); }, { model, sleep: busyClock.sleep, now: busyClock.now, onWait: (wait) => events.push(wait ? "wait" : "clear") });
		assert(events.join(",") === "call,wait,clear,call", `the wait is cleared before the next try, got ${events.join(",")}`);
		// Cancel during the first-call probe: the probe gets the signal, and no call starts after it.
		const controller = new AbortController();
		const cancelled = scripted([workerError("Connection error.")]);
		const cancelClock = fakeClock();
		let probeSignal: AbortSignal | undefined;
		const stopped = await rejects(callWithPatience(cancelled.call, { model, sleep: cancelClock.sleep, now: cancelClock.now, signal: controller.signal, probe: async (signal?: AbortSignal) => { probeSignal = signal; controller.abort(); return "ok"; } }));
		assert(cancelled.calls === 1 && probeSignal === controller.signal && !(stopped instanceof ModelUnreachableError), `a cancel during the probe starts no further call and the probe has the signal, got ${cancelled.calls} call(s), signal ${probeSignal === controller.signal}`);
	}
	{
		// A caller with its own probe for the end of the patience (Memorize's fold, sort and placement) still gets the first-call probe.
		const clock = fakeClock();
		const fake = scripted([workerError("Connection error."), workerError("Connection error.")]);
		let probes = 0;
		const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, connectProbe: async () => { probes += 1; throw workerError("Connection error."); } }));
		assert(error instanceof ModelUnreachableError && error.details.detail === "not-answering" && fake.calls === 1 && probes === 1 && clock.slept.length === 1, `a dead address with only the first-call probe is the notice after one wait, got ${String(error)} after ${fake.calls} call(s)`);
		const server = scripted(Array.from({ length: 6 }, () => workerError("502 Bad Gateway")));
		const serverClock = fakeClock();
		let serverProbes = 0;
		const spent = await rejects(callWithPatience(server.call, { model, sleep: serverClock.sleep, now: serverClock.now, connectProbe: async () => { serverProbes += 1; return "ok"; } }));
		assert(patienceSpent(spent) && serverProbes === 0, "the first-call probe is not the end-of-patience probe: a server error past the patience is handed back spent, for the caller's own probe");
	}
	const clock = fakeClock();
	const dropped = scripted([workerError("terminated")]);
	assert(await callWithPatience(dropped.call, { model, sleep: clock.sleep, now: clock.now }) === "ok" && clock.slept.length === 1, "a connection that dropped after it opened is waited out");
	const later = scripted([workerError("terminated"), workerError("fetch failed")]);
	const laterClock = fakeClock();
	assert(await callWithPatience(later.call, { model, sleep: laterClock.sleep, now: laterClock.now }) === "ok" && later.calls === 3, "a refused connection after one that opened is waited out too: the server may be restarting");
	pass("a dead address is the notice after one said wait of about 15 s; a blip on the first call and a dropped connection are waited out");
}

{
	const clock = fakeClock();
	const fake = scripted(Array.from({ length: 6 }, () => workerError('529 {"type":"error","error":{"type":"overloaded_error"}}')));
	const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now }));
	assert(error instanceof ModelUnreachableError, `six overloads end unreachable, got ${String(error)}`);
	assert(error.details.detail === "still-busy" && error.code === "model_unreachable" && error.statusCode === 503, `the cause is "still busy", got ${JSON.stringify(error.details)}`);
	assert(fake.calls === 6, `five retries after the first call, got ${fake.calls} calls`);
	const total = clock.slept.reduce((sum, ms) => sum + ms, 0);
	assert(total === PATIENCE_WAITS_MS.reduce((sum, ms) => sum + ms, 0) && total >= 5 * 60_000 && total <= 7 * 60_000, `about six minutes of patience, got ${total / 1000} s`);
	pass("a model busy past about six minutes of tries is unreachable, as 'still busy'");
}

{
	// A provider incident mixes its kinds (an overload, then a server error,
	// then a dropped connection): one budget for all of them, not one each.
	const kinds = ['529 {"type":"error","error":{"type":"overloaded_error"}}', '500 {"type":"error","error":{"type":"api_error"}}', "read ECONNRESET"];
	const clock = fakeClock();
	const waits: PatienceWait[] = [];
	const fake = scripted(Array.from({ length: 12 }, (_, index) => workerError(kinds[index % kinds.length]!)));
	const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, onWait: (wait) => { if (wait) waits.push(wait); } }));
	assert(fake.calls === 6, `a mixed incident gets five retries in all, got ${fake.calls} calls`);
	const total = clock.slept.reduce((sum, ms) => sum + ms, 0);
	assert(total <= 7 * 60_000, `a mixed incident is about six minutes of patience, got ${total / 1000} s`);
	assert(waits.map((wait) => wait.attempt).join(",") === "2,3,4,5,6", `the tries count across kinds, got ${waits.map((wait) => wait.attempt).join(",")}`);
	assert(patienceSpent(error), `without a probe, the last dropped connection is handed back spent, got ${String(error)}`);
	const overloadLast = scripted([kinds[1], kinds[2], kinds[0], kinds[1], kinds[2], kinds[0]].map((words) => workerError(words!)));
	const overloadClock = fakeClock();
	const stillBusy = await rejects(callWithPatience(overloadLast.call, { model, sleep: overloadClock.sleep, now: overloadClock.now }));
	assert(overloadLast.calls === 6 && stillBusy instanceof ModelUnreachableError && stillBusy.details.detail === "still-busy", `ending on an overload is still busy, got ${overloadLast.calls} calls, ${String(stillBusy)}`);
	pass("the busy kinds share one budget of five retries, about six minutes");
}

for (const [words, detail] of [["401 authentication_error", "signed-out"], ["insufficient_quota", "quota"], ["model not found: x/y", "not-offered"]] as const) {
	const clock = fakeClock();
	const fake = scripted([workerError(words)]);
	const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now }));
	assert(error instanceof ModelUnreachableError && error.details.detail === detail, `"${words}" ends at once as ${detail}, got ${String(error)}`);
	assert(fake.calls === 1 && clock.slept.length === 0, `"${words}" is never retried`);
	assert(error.message.includes("Claude Sonnet 5") && !error.message.includes(words), "the sentence names the model and never the provider's raw words");
}
pass("signed out, out of quota and no longer offered end at once, in the product's words");

{
	// A key connection says which way its key is gone; a sign-in stays signed out.
	const keyModel = { provider: "openai", model: "gpt-5.5", label: "GPT-5.5" };
	const clock = fakeClock();
	const refused = await rejects(callWithPatience(scripted([workerError("401 Incorrect API key provided")]).call, { model: keyModel, sleep: clock.sleep, now: clock.now }));
	assert(refused instanceof ModelUnreachableError && refused.details.detail === "signed-out" && refused.details.key === "refused" && refused.message === "GPT-5.5 cannot answer because its provider did not accept the saved key. Nothing was lost.", `a 401 on a key is the saved key refused, got ${String(refused)} ${JSON.stringify((refused as any)?.details)}`);
	const missing = new ModelUnreachableError("signed-out", keyModel, new Error("No API key found for openai"));
	assert(missing.details.key === "missing" && missing.message === "GPT-5.5 cannot answer because its provider has no key saved. Nothing was lost.", `no key found is the key missing, got ${missing.message}`);
	assert(new ModelUnreachableError("signed-out", { provider: "gateway-synthetic", model: "m", label: "Gateway Model" }).details.key === "missing", "a gateway refused before any call has no key saved");
	const signedOut = new ModelUnreachableError("signed-out", model, workerError("401 authentication_error"));
	assert(signedOut.details.key === undefined && signedOut.message === "Claude Sonnet 5 cannot answer because its provider is signed out. Nothing was lost.", `a sign-in stays signed out, got ${signedOut.message}`);
	const claudeKey = { provider: "anthropic-api-key", model: "claude-opus-5-5", label: "Claude Opus 5.5" };
	const workspace = workerError('400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace."}}');
	const noWorkspace = await rejects(callWithPatience(scripted([workspace]).call, { model: claudeKey, sleep: clock.sleep, now: clock.now }));
	assert(noWorkspace instanceof ModelUnreachableError && noWorkspace.details.key === "no-workspace" && noWorkspace.message === "Claude Opus 5.5 cannot answer because its key isn't tied to a workspace. Nothing was lost.", `Anthropic's workspace 400 is its own case, never signed out, got ${String(noWorkspace)}`);
	assert(classifyModelFailure(new Error("The api key field in this request was ignored")).cause === "other" && !signInFailed("Set the OAuth scope or a credential helper in your config"), "words that only name an API key, OAuth or a credential are not a sign-in");
	pass("a key connection's Memory model says no key saved, the saved key refused, or a key outside a workspace; a sign-in says signed out; a passing mention of an API key is not a sign-in");
}

{
	// The runtime's own words, verbatim: every provider's stream without a key
	// (runtime/packages/ai/src/providers/anthropic.ts and the rest), and the
	// session's check for a sign-in it cannot use (agent-session.ts).
	const noKey = (provider: string) => `No API key for provider: ${provider}`;
	const expired = (provider: string) => `Authentication failed for "${provider}". Credentials may have expired or network is unavailable. Run '/login ${provider}' to re-authenticate.`;
	const signIns = [model, { provider: "openai-codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol" }];
	const keys = [{ provider: "openai", model: "gpt-5.5", label: "GPT-5.5" }, { provider: "anthropic-api-key", model: "claude-opus-5-5", label: "Claude Opus 5.5" }];
	for (const words of [...signIns.flatMap((m) => [noKey(m.provider), expired(m.provider)]), ...keys.map((m) => noKey(m.provider))]) {
		const failure = classifyModelFailure(workerError(words));
		assert(failure.cause === "unreachable" && failure.detail === "signed-out", `"${words}" reads as a credential gone, got ${JSON.stringify(failure)}`);
		assert(pageSignInFailed(words), `the page's Memory line reads "${words}" as a key or sign-in`);
	}
	for (const m of signIns) {
		for (const words of [noKey(m.provider), expired(m.provider)]) {
			const clock = fakeClock();
			const error = await rejects(callWithPatience(scripted([workerError(words)]).call, { model: m, sleep: clock.sleep, now: clock.now }));
			assert(error instanceof ModelUnreachableError && error.details.key === undefined && error.message === `${m.label} cannot answer because its provider is signed out. Nothing was lost.`, `a sign-in's "${words}" says signed out, got ${String(error)}`);
		}
	}
	for (const m of keys) {
		const clock = fakeClock();
		const error = await rejects(callWithPatience(scripted([workerError(noKey(m.provider))]).call, { model: m, sleep: clock.sleep, now: clock.now }));
		assert(error instanceof ModelUnreachableError && error.details.key === "missing" && error.message === `${m.label} cannot answer because its provider has no key saved. Nothing was lost.`, `a key connection's "${noKey(m.provider)}" says no key saved, got ${String(error)}`);
	}
	for (const words of ["Pick a provider: No API key for provider is configured here", "Authentication failed for the proxy", "Credentials may have expired"]) {
		assert(classifyModelFailure(new Error(words)).cause === "other" && !pageSignInFailed(words), `"${words}" is not the runtime's phrase, so not a sign-in`);
	}
	pass("the runtime's \"No API key for provider\" and \"Authentication failed ... Credentials may have expired\" say signed out on a sign-in and no key saved on a key, on the server and on the page");
}

{
	const stall = () => new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "stopped answering", { reason: "stalled" });
	const clock = fakeClock();
	const fake = scripted([stall(), stall(), stall()]);
	let probes = 0;
	const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, probe: async () => { probes += 1; throw workerError("Connection error."); } }));
	assert(fake.calls === 3, `a stall is tried at most twice more, got ${fake.calls} calls`);
	assert(probes === 1 && error instanceof ModelUnreachableError && error.details.detail === "not-answering", `then the probe; no answer is "not answering", got ${String(error)}`);

	const timeout = () => new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "ran past its limit", { reason: "timed-out" });
	const timedOut = scripted([timeout(), timeout()]);
	const timedClock = fakeClock();
	const handedBack = await rejects(callWithPatience(timedOut.call, { model, sleep: timedClock.sleep, now: timedClock.now, probe: async () => "OK" }));
	assert(timedOut.calls === 2, `a timeout is tried at most once more, got ${timedOut.calls} calls`);
	assert(handedBack instanceof IsolatedPersistentAgentWorkerTurnError && patienceSpent(handedBack), "a probe that answers hands the failure back as this request's own, marked spent");

	const noProbe = scripted([workerError("502 Bad Gateway"), workerError("502 Bad Gateway"), workerError("502 Bad Gateway"), workerError("502 Bad Gateway"), workerError("502 Bad Gateway"), workerError("502 Bad Gateway")]);
	const noProbeClock = fakeClock();
	const spent = await rejects(callWithPatience(noProbe.call, { model, sleep: noProbeClock.sleep, now: noProbeClock.now }));
	assert(noProbe.calls === 6 && patienceSpent(spent) && !(spent instanceof ModelUnreachableError), "without a probe, a server error past the patience is handed back marked spent, for the caller's own probe");
	pass("a stall gets two more tries and a timeout one, then the probe decides; the worst case per call is bounded");
}

{
	for (const words of ["the model refused to answer this request", "prompt is too long: 300000 tokens > 200000 maximum", "the model returned an error without a message"]) {
		const fake = scripted([workerError(words)]);
		const clock = fakeClock();
		const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now }));
		assert(fake.calls === 1 && clock.slept.length === 0, `"${words}" is not waited out`);
		assert(error instanceof IsolatedPersistentAgentWorkerTurnError && !patienceSpent(error), `"${words}" is handed back untouched`);
	}
	const controller = new AbortController();
	const fake = scripted([workerError("429 rate_limit_error")]);
	const sleep = async () => { controller.abort(); };
	const error = await rejects(callWithPatience(fake.call, { model, sleep, signal: controller.signal }));
	assert(fake.calls === 1 && error instanceof IsolatedPersistentAgentWorkerTurnError, "a cancel during a wait ends the patience, with no further call");
	pass("a refusal, a request too large and an unknown failure are handed back untouched; a cancel ends the wait");
}

{
	// The first read, the discussion and the sign-off pass the room's model
	// lock, which carries no label; Remember passes the chat's label, the
	// provider and the name joined by a dash. Either way the notice names the
	// model as the app shows it.
	const bare = new ModelUnreachableError("not-answering", { provider: "anthropic", model: "claude-sonnet-5-5" });
	assert(bare.message === "Claude Sonnet 5.5 isn't answering right now. Nothing was lost.", `a model lock without a label is named as the app shows it, got "${bare.message}"`);
	const wire = new ModelUnreachableError("quota", { provider: "anthropic", model: "claude-sonnet-5-5", label: "Anthropic / Claude \u2014 Claude Sonnet 5.5" });
	assert(wire.message === "Claude Sonnet 5.5 has reached your plan's usage limit. Nothing was lost. Try again later.", `a label with its provider is named without it, got "${wire.message}"`);
	const gateway = new ModelUnreachableError("not-offered", { provider: "gateway-acme", model: "moonshotai.kimi-k2.5" });
	assert(gateway.message === "Kimi K2.5 is no longer offered. Nothing was lost.", `a gateway's raw id is tidied, got "${gateway.message}"`);
	const fake = scripted([workerError("litellm.AuthenticationError: Error code: 401")]);
	const clock = fakeClock();
	const signedOut = await rejects(callWithPatience(fake.call, { model: { provider: "openai-codex", model: "gpt-6.1-sol" }, sleep: clock.sleep, now: clock.now }));
	assert(signedOut instanceof ModelUnreachableError && signedOut.message === "GPT-6.1 Sol cannot answer because its provider is signed out. Nothing was lost.", `a patient call without a label names the model as the app shows it, got "${String((signedOut as Error).message)}"`);
	assert(signedOut.details.model === "gpt-6.1-sol" && signedOut.details.label === undefined, "the details keep the lock as it came");
	pass("the notice names the model as the app shows it, never its raw id or its provider label");
}

// A room's flows wait apart: Memorize's wait is never shown on Review's status, and one call ending never takes down another's.
{
	const waitOf = (at: string): PatienceWait => ({ cause: "busy", detail: "rate-limit", attempt: 2, nextTryAt: at });
	let endReview!: () => void;
	let endAbsorb!: () => void;
	const absorb = withRoomCallWait("flows-room", "absorb", (onWait) => { onWait(waitOf("2026-10-11T01:00:00.000Z")); return new Promise<void>((resolve) => { endAbsorb = resolve; }); });
	const review = withRoomCallWait("flows-room", "review", (onWait) => { onWait(waitOf("2026-10-11T01:02:00.000Z")); return new Promise<void>((resolve) => { endReview = resolve; }); });
	const second = withRoomCallWait("flows-room", "absorb", (onWait) => { onWait(waitOf("2026-10-11T00:59:00.000Z")); return Promise.resolve(); });
	await second;
	assert(roomCallWait("flows-room", "absorb")?.nextTryAt === "2026-10-11T01:00:00.000Z", `a call that ended leaves the wait of the one still waiting, got ${JSON.stringify(roomCallWait("flows-room", "absorb"))}`);
	assert(roomCallWait("flows-room", "review")?.nextTryAt === "2026-10-11T01:02:00.000Z", "each flow says its own wait");
	endReview();
	await review;
	assert(roomCallWait("flows-room", "review") === undefined && roomCallWait("flows-room", "absorb")?.nextTryAt === "2026-10-11T01:00:00.000Z", "Review's call ending leaves Memorize's wait as it was");
	endAbsorb();
	await absorb;
	assert(roomCallWait("flows-room", "absorb") === undefined, "the wait is gone once the last call ended");
	pass("a room's flows and calls wait apart: one ending never takes down another's wait");
}

// A model that could not be reached is said the same way in the chat and in the Memory model's notice:
// over the internet when no connection opened, on this computer when its address is local.
{
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-model-call-causes-"));
	process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "local-llm": { baseUrl: "http://localhost:11434/v1" }, "lan-llm": { baseUrl: "http://192.168.1.20:11434/v1" } } }));
	try {
		const internet = "Claude Sonnet 5 could not be reached. Nothing was lost. Check your internet connection, then try again.";
		const local = "Qwen could not be reached on this computer. Nothing was lost. Check that the app running it is open, then try again.";
		const neverOpened = new ModelUnreachableError("not-answering", model, workerError("fetch failed"));
		assert(neverOpened.message === internet && neverOpened.details.unreached === "connection", `a connection that never opened says so, got "${neverOpened.message}" ${JSON.stringify(neverOpened.details)}`);
		const dropped = new ModelUnreachableError("not-answering", model, workerError("terminated"));
		assert(dropped.message === "Claude Sonnet 5 isn't answering right now. Nothing was lost." && dropped.details.unreached === undefined, `a model reached and then silent is not answering, got "${dropped.message}"`);
		const onThisComputer = new ModelUnreachableError("not-answering", { provider: "local-llm", model: "qwen", label: "Qwen" }, workerError("terminated"));
		assert(onThisComputer.message === local && onThisComputer.details.unreached === "local-connection", `a model on this computer names the app running it, got "${onThisComputer.message}"`);
		const onTheNetwork = new ModelUnreachableError("not-answering", { provider: "lan-llm", model: "qwen", label: "Qwen" }, workerError("connect ECONNREFUSED 192.168.1.20:11434"));
		assert(onTheNetwork.message === internet.replace("Claude Sonnet 5", "Qwen"), `another computer on the network is not this computer, got "${onTheNetwork.message}"`);
		const clock = fakeClock();
		const dead = await rejects(callWithPatience(scripted([workerError("fetch failed")]).call, { model, sleep: clock.sleep, now: clock.now, probe: async () => { throw workerError("fetch failed"); } }));
		assert(dead instanceof ModelUnreachableError && dead.message === internet, `a dead address ends in the same sentence, got "${String((dead as Error).message)}"`);

		assert(turnFailureOf("fetch failed", false, "anthropic") === "connection", "a chat turn that could not connect is a connection failure");
		assert(turnFailureOf("connect ECONNREFUSED 127.0.0.1:11434", false, "local-llm") === "local-connection", "a chat turn on a model on this computer is its own failure");
		assert(turnFailureOf("connect ECONNREFUSED 192.168.1.20:11434", false, "lan-llm") === "connection", "a model on another computer is reached over the network");
		assert(turnFailureLine("Claude Sonnet 5", "connection", "anthropic") === internet, "the chat's line is the notice's sentence");
		assert(turnFailureLine("Qwen", "local-connection", "local-llm") === local, `the chat's line for a model on this computer, got "${turnFailureLine("Qwen", "local-connection", "local-llm")}"`);
		pass("a model that could not be reached says so, in the chat and the notice alike, on this computer too");

		assert(turnFailureLine("GPT-5.5", "quota", "openai-codex") === "GPT-5.5 has reached its usage limit or run out of credit. Nothing was lost. Choose another model in Room settings, Model.", `a spent usage limit says what to do next, got "${turnFailureLine("GPT-5.5", "quota", "openai-codex")}"`);
		assert(turnFailureLine("Claude Sonnet 5", "quota", "anthropic-api-key") === "Claude Sonnet 5 has reached its usage limit or run out of credit. Nothing was lost. Check the balance at console.anthropic.com, or choose another model in Room settings, Model.", "a Claude key's spent credit keeps the balance line");
		// A line with no way on (saved before it was known, or a hand-back) on a shared server points to the admin, never to the Claude console.
		for (const provider of ["anthropic-api-key", "openai"]) {
			const sharedLine = turnFailureLine("Claude Sonnet 5", "quota", provider, undefined, true);
			assert(sharedLine === "Claude Sonnet 5 has reached its usage limit or run out of credit. Nothing was lost. Tell your admin, or choose another model in Room settings, Model.", `a quota with no way on, on a shared server, tells the admin, got "${sharedLine}"`);
		}
		pass("a spent usage limit says what to do next, and a Claude key names its balance");

		const perMinute = "429 Request too large for gpt-4o in organization org-scripted on tokens per min (TPM): Limit 30000, Requested 45000. The input or output tokens must be reduced in order to run successfully.";
		assert(turnFailureOf(perMinute, true, "openai") === "too-large", `a request larger than the per-minute limit is its own cause, got ${turnFailureOf(perMinute, true, "openai")}`);
		assert(turnFailureLine("GPT-4o", "too-large", "openai") === "GPT-4o can't take this much at once on your account. Nothing was lost. Remember, then continue, or choose another model in Room settings, Model.", "it says how to make it smaller");
		assert(turnFailureOf("429 Rate limit reached for gpt-4o in organization org-scripted on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 2s.", true, "openai") === "still-busy", "a plain per-minute rate limit stays busy");
		pass("a request larger than the per-minute limit says so; a plain rate limit stays busy");
	} finally {
		delete process.env.EXXPERTS_CODING_AGENT_DIR;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
}

// A refusal and an answer cut off mid-way each say what happened, not "could not answer" or "could not be reached".
{
	assert(turnFailureOf("the model refused to answer this request", false, "anthropic") === "refused", `a refusal is its own cause, got ${turnFailureOf("the model refused to answer this request", false, "anthropic")}`);
	assert(turnFailureLine("Claude Sonnet 5", "refused", "anthropic") === "Claude Sonnet 5 declined to answer this message. Nothing was lost. You can reword it, or choose another model in Room settings, Model.", `the refusal line, got "${turnFailureLine("Claude Sonnet 5", "refused", "anthropic")}"`);
	assert(turnFailureOf("terminated", true, "anthropic", true) === "cut-off", `a failure after part of an answer is its own cause, got ${turnFailureOf("terminated", true, "anthropic", true)}`);
	assert(turnFailureOf("terminated", true, "anthropic", false) === "connection", "a failure before any answer is still the connection");
	assert(turnFailureLine("Claude Sonnet 5", "cut-off", "anthropic") === "Claude Sonnet 5 stopped in the middle of its answer. Nothing was lost. Try again.", `the cut-off line, got "${turnFailureLine("Claude Sonnet 5", "cut-off", "anthropic")}"`);
	pass("a refusal and an answer cut off mid-way each say what happened");
}

// Details is the provider's sentence: no HTML, no status in front, model ids kept, a cut said, the runtime's words plain.
{
	const html = providerSentence("503 <html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>");
	assert(html === "503 Service Temporarily Unavailable", `an HTML page keeps its title alone, got ${JSON.stringify(html)}`);
	assert(providerSentence("429 You exceeded your current quota, please check your plan and billing details.") === "You exceeded your current quota, please check your plan and billing details.", "a leading status is dropped");
	const modelId = providerSentence('404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-haiku-5-5-20261001-scripted-preview"}}');
	assert(modelId === "model: claude-haiku-5-5-20261001-scripted-preview", `a model id is never masked, got ${JSON.stringify(modelId)}`);
	assert(providerSentence("Refused key sk-ant-api03-abcdefghijklmnop and token Bearer abc.def and id AbCdEfGhIjKlMnOpQrStUvWxYz012345.") === "Refused key sk-… and token Bearer … and id ….", `key shapes are masked, got ${JSON.stringify(providerSentence("Refused key sk-ant-api03-abcdefghijklmnop and token Bearer abc.def and id AbCdEfGhIjKlMnOpQrStUvWxYz012345."))}`);
	const long = providerSentence(`The gateway says ${"one two three four five six seven eight nine ten ".repeat(12)}and so on.`)!;
	assert(long.length <= 500 && long.endsWith("…") && !/\s…$/.test(long) && /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)…$/.test(long), `a cut ends with "…" after a whole word, got ${JSON.stringify(long.slice(-40))}`);
	for (const words of ["terminated", "TypeError: terminated"]) assert(providerSentence(words) === "The connection closed before the answer arrived.", `a connection that closed reads plainly, got ${JSON.stringify(providerSentence(words))} for "${words}"`);
	// No connection was ever made (nothing listening, a name that does not resolve): nothing to show under Details.
	for (const words of ["Connection error.", "APIConnectionError: Connection error."]) assert(providerSentence(words) === undefined, `the runtime's "${words}" gives no Details, got ${JSON.stringify(providerSentence(words))}`);
	// The ChatGPT sign-in's own fetch hands up Node's words for a request that never connected.
	for (const words of ["fetch failed", "TypeError: fetch failed", "fetch failed: ECONNREFUSED"]) assert(providerSentence(words) === undefined, `Node's "${words}" gives no Details, got ${JSON.stringify(providerSentence(words))}`);
	pass("Details is the provider's sentence: no HTML, no status, model ids kept, a cut said, a closed connection plain, none for a connection never made");
}

// One reading of a failure's status for Review and the log line: the status the error carries, else every shape its words name it in.
{
	const causes = await import("../src/model-call-causes.js") as Record<string, unknown>;
	const statusOf = causes.failureStatusOf as ((error: unknown) => number | undefined) | undefined;
	const logFields = causes.providerFailureLogFields as (error: unknown) => { status?: number } | undefined;
	const shapes: Array<[unknown, number | undefined]> = [
		[new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}'), 400],
		[new Error("Error: 400 Bad request"), 400],
		[new Error("BadRequestError: 400 Bad request"), 400],
		[new Error("500 Internal Server Error"), 500],
		[new Error('Mistral API error (400): {"object":"error","message":"Bad request"}'), 400],
		[new Error("HTTP 403 Forbidden"), 403],
		[new Error("HTTP/1.1 503 Service Unavailable"), 503],
		[new Error("Request failed with status code 404"), 404],
		[new Error("upstream answered status_code=429"), 429],
		[Object.assign(new Error("Bad request"), { status: 400 }), 400],
		[Object.assign(new Error("Bad gateway"), { statusCode: 502 }), 502],
		[Object.assign(new Error("Slow down"), { errorStatus: 429 }), 429],
		[new Error("Something unusual happened on our side."), undefined],
		[new Error("The prompt used 4290 tokens."), undefined],
	];
	assert(typeof statusOf === "function", "model-call-causes exports the one status reader, failureStatusOf");
	const misread = shapes.flatMap(([error, status]) => {
		const words = error instanceof Error ? error.message : String(error);
		const read = statusOf!(error);
		const logged = logFields(error)?.status;
		return read === status && logged === status ? [] : [`${JSON.stringify(words)}: read ${read}, logged ${logged}, want ${status}`];
	});
	assert(misread.length === 0, `the status of a failure, read once for Review and the log line:\n  ${misread.join("\n  ")}`);
	const reviewSource = fs.readFileSync(new URL("../src/review-run.ts", import.meta.url), "utf8");
	assert(/\bfailureStatusOf\(/.test(reviewSource) && !/function failureStatus\(/.test(reviewSource), "Review reads the status with the one reader, not its own");
	pass("a failure's status is read once, for Review and the log line, in every shape either read: a leading status, an error class's, \"(400)\", \"HTTP 403\", \"status code 404\", or the status the error carries");
}

console.log("model call causes smoke passed");
