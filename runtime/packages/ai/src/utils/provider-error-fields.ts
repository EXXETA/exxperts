/**
 * The HTTP status and the provider's own error type of a failed call, read
 * from the error its client threw. A failed message carries them beside its
 * words, so a reader can tell what happened even when the words name nothing
 * it knows.
 *
 * Each client keeps them in its own place: the Anthropic and OpenAI clients
 * as `status` with the body under `error`, Google's as `status` with the body
 * as its message, Mistral's as `statusCode` with the body as text, the AWS
 * client under `$metadata` with the type as the error's name. A fetch-based
 * provider throws an error shaped like the OpenAI client's.
 */
export interface ProviderErrorFields {
	errorStatus?: number;
	errorType?: string;
}

/** A type or code as a provider writes it ("rate_limit_error", "ThrottlingException"); never a sentence. */
const ERROR_TYPE = /^[A-Za-z][\w.-]{0,63}$/;

function errorTypeOf(value: unknown): string | undefined {
	// A Python gateway writes an empty type as "None".
	return typeof value === "string" && ERROR_TYPE.test(value) && !/^(?:none|null|undefined)$/i.test(value) ? value : undefined;
}

function statusOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

function parsed(text: unknown): unknown {
	if (typeof text !== "string" || !text.trim().startsWith("{")) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The type in a body: Anthropic's `{error: {type}}`, OpenAI's `{code, type}` (the code is the finer one), Google's `{error: {status}}`. */
function bodyType(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const record = body as Record<string, unknown>;
	const inner = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : undefined;
	if (inner) return errorTypeOf(inner.type) ?? errorTypeOf(inner.code) ?? errorTypeOf(inner.status);
	return errorTypeOf(record.code) ?? (record.type === "error" ? undefined : errorTypeOf(record.type));
}

export function providerErrorFields(error: unknown): ProviderErrorFields {
	if (!error || typeof error !== "object") return {};
	const thrown = error as Record<string, unknown>;
	const metadata = thrown.$metadata && typeof thrown.$metadata === "object" ? (thrown.$metadata as Record<string, unknown>) : undefined;
	const errorStatus = statusOf(thrown.status) ?? statusOf(thrown.statusCode) ?? statusOf(metadata?.httpStatusCode);
	const errorType = metadata
		? errorTypeOf(thrown.name)
		: (bodyType(thrown.error) ?? bodyType(parsed(thrown.body)) ?? bodyType(parsed(thrown.message)));
	return { ...(errorStatus !== undefined ? { errorStatus } : {}), ...(errorType ? { errorType } : {}) };
}
