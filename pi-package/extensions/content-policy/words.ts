/**
 * The words of a content-policy block, shared with the page: the model reads
 * the block reason, the person reads one plain line on the step's card.
 * No Node imports, so the page can load it.
 */

/** `inText`: the line when the match was in the text a tool would write, not in a path or a name. */
export const RULE_WORDS: Record<string, { reason: string; plain: string; inText: string }> = {
	"dot-env": { reason: "blocked .env access", plain: "Blocked: a .env file", inText: "Blocked: the text mentions a .env file" },
	"pem-file": { reason: "blocked PEM private-key/certificate file access", plain: "Blocked: a PEM key or certificate file", inText: "Blocked: the text mentions a PEM key or certificate file" },
	"id-rsa": { reason: "blocked SSH private-key access", plain: "Blocked: an SSH private key", inText: "Blocked: the text mentions an SSH private key" },
	"password-assignment": { reason: "blocked password assignment/value pattern", plain: "Blocked: a password", inText: "Blocked: the text holds what looks like a password" },
	"secret-label-value": { reason: "blocked API key/token-looking argument", plain: "Blocked: an API key or token", inText: "Blocked: the text holds what looks like an API key" },
	"openai-key": { reason: "blocked OpenAI-style API key", plain: "Blocked: an API key", inText: "Blocked: the text holds what looks like an API key" },
	"github-token": { reason: "blocked GitHub token-looking value", plain: "Blocked: a GitHub token", inText: "Blocked: the text holds what looks like a GitHub token" },
	"slack-token": { reason: "blocked Slack token-looking value", plain: "Blocked: a Slack token", inText: "Blocked: the text holds what looks like a Slack token" },
	"aws-access-key": { reason: "blocked AWS access-key-looking value", plain: "Blocked: an AWS access key", inText: "Blocked: the text holds what looks like an AWS access key" },
	"jwt-token": { reason: "blocked JWT/token-looking value", plain: "Blocked: a sign-in token", inText: "Blocked: the text holds what looks like a sign-in token" },
};

const IN_TEXT = ", found in the text";

/** A rule added in content-policy.json. */
export const CUSTOM_RULE_LINE = "Blocked by the content policy";

const REASON_HEAD = /^Content policy blocked tool '[^']*': /;

/** What the model reads. "Do not try again" names only the blocked thing, so the room still tries the other files it may use. */
export function contentPolicyBlockReason(toolName: string, ruleReason: string, inText = false): string {
	return `Content policy blocked tool '${toolName}': ${ruleReason}${inText ? IN_TEXT : ""}. Do not try this file or value again another way; other files you are allowed to use are fine. Explain the constraint to the user and ask for a safe alternative.`;
}

/** The person's line for a step's result, or null when the result is no content-policy block. Older conversations' wording reads the same. */
export function contentPolicyPlainLine(result: string): string | null {
	const head = REASON_HEAD.exec(result);
	if (!head) return null;
	const rest = result.slice(head[0].length);
	const end = rest.indexOf(". ");
	const said = end < 0 ? rest.replace(/\.$/, "") : rest.slice(0, end);
	const inText = said.endsWith(IN_TEXT);
	const reason = inText ? said.slice(0, -IN_TEXT.length) : said;
	const words = Object.values(RULE_WORDS).find((candidate) => candidate.reason === reason);
	return words ? (inText ? words.inText : words.plain) : CUSTOM_RULE_LINE;
}
