/**
 * Content policy extension — first slice.
 *
 * Scans outbound tool-call arguments before execution and blocks obvious
 * sensitive-file/secret patterns. This is intentionally local and narrow:
 * no org policy, RBAC, approvals, or central administration yet.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@exxeta/exxperts-runtime";
import { productAppStatePath } from "../../product-state-paths.js";
import { contentPolicyBlockReason, RULE_WORDS } from "./words.js";

interface RuleConfig {
	id?: string;
	pattern?: string;
	flags?: string;
	reason?: string;
	enabled?: boolean;
}

interface ContentPolicyConfig {
	enabled?: boolean;
	logPath?: string;
	disabledRuleIds?: string[];
	rules?: RuleConfig[];
}

interface Rule {
	id: string;
	pattern: RegExp;
	reason: string;
	// When present, a pattern hit is only a candidate: the value it captured
	// must also pass this check before the rule counts as matched.
	accept?: (match: RegExpMatchArray) => boolean;
}

interface MatchResult {
	rule: Rule;
	matchedText: string;
}

const CONFIG_PATH = productAppStatePath("content-policy.json");
const DEFAULT_LOG_PATH = productAppStatePath("content-policy-blocks.jsonl");
const INTERNAL_COORDINATION_TOOLS = new Set(["start_handoff", "return_handoff", "delegate"]);

// The label rules below look at the value that follows "label: " or
// "label = ". Ordinary source code puts identifiers, type names and env
// references there; a leaked credential puts a random-looking string there.
// Tool arguments are scanned as JSON text, so a double quote inside file
// content arrives as \" and a newline arrives as \n.
const SECRET_LABEL = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|secret[_-]?key|client[_-]?secret)\b/;
const QUOTED_VALUE = /(?:[rbufRBUF]{1,2})?(?:\\?["']|`)(?<quoted>[^"'`\\\s]+)(?=\\?["']|`)/;
const BARE_TOKEN_VALUE = /(?<bare>[A-Za-z0-9_./+=:@~-]+)/;
const BARE_PASSWORD_VALUE = /(?<bare>[A-Za-z0-9_./+=:@~!#$%^*-]+)/;

function labelValuePattern(label: RegExp, bare: RegExp): RegExp {
	return new RegExp(`${label.source}\\s*[:=]\\s*(?:${QUOTED_VALUE.source}|${bare.source})`, "i");
}

// Sample values, template references and documentation stand-ins. A word
// only counts as a stand-in when it is a whole segment of the value
// (your_api_key_here, sk_test_...), never as a substring of a credential.
const PLACEHOLDER_WORDS = new Set(["your", "changeme", "change", "redacted", "example", "placeholder", "dummy", "test", "sample", "fake", "secret", "todo", "fixme", "replace", "insert"]);
const PLACEHOLDER_MARKS = /xxx|\.\.\.|\*\*\*/i;
const TEMPLATE_REFERENCE = /[<>{}]|\$[{(A-Za-z_]|%[({A-Za-z]/;

function looksLikePlaceholder(value: string): boolean {
	if (TEMPLATE_REFERENCE.test(value) || PLACEHOLDER_MARKS.test(value) || /^(.)\1*$/.test(value)) return true;
	return value.split(/[_\-./:@+=~ ]/).some((segment) => PLACEHOLDER_WORDS.has(segment.toLowerCase()));
}

function hasLettersAndDigits(value: string): boolean {
	return /[A-Za-z]/.test(value) && /\d/.test(value);
}

// Identifiers, member paths, file paths, URLs and resource names are code,
// never credentials. A code piece carries at most two runs of digits
// (sha256, utf8ToBase64); a credential interleaves digits throughout or is
// a long hex string.
function looksLikeCodeReference(value: string): boolean {
	if (/^(?:[a-z][a-z0-9+.-]*:\/\/|arn:aws:)/i.test(value)) return true;
	const pieces = value.replace(/^(?:\.{0,2}|~)\//, "").split(/[./]/);
	return pieces.every((piece) => /^[\w$-]+$/.test(piece) && (piece.match(/\d+/g) ?? []).length <= 2 && !/^[0-9a-f]{16,}$/i.test(piece));
}

// A quoted literal is already suspicious on its own; a bare value must also
// fail to read as code before it counts.
function isSecretShaped(value: string, minLength: number, quoted: boolean): boolean {
	if (value.length < minLength || !hasLettersAndDigits(value) || looksLikePlaceholder(value)) return false;
	return quoted || !looksLikeCodeReference(value);
}

function acceptSecretLabelValue(match: RegExpMatchArray): boolean {
	const { quoted, bare } = match.groups ?? {};
	if (quoted !== undefined) return isSecretShaped(quoted, 12, true);
	if (bare !== undefined) return isSecretShaped(bare, 16, false);
	return false;
}

function acceptPasswordValue(match: RegExpMatchArray): boolean {
	const { quoted, bare } = match.groups ?? {};
	if (quoted !== undefined) return quoted.length >= 4 && !looksLikePlaceholder(quoted);
	if (bare !== undefined) return isSecretShaped(bare, 8, false);
	return false;
}

const DEFAULT_RULES: Rule[] = [
	// Block secret-bearing .env files but allow common documentation templates
	// such as .env.example, .env.sample, .env.template, and .env.dist; a word
	// character before the dot (process.env, os.environ) is code, not a file.
	{ id: "dot-env", pattern: /(?<![A-Za-z0-9_])\.env(?!\.(?:example|sample|template|dist)\b)(?:$|["'\\/.,}\]\w-])/i, reason: RULE_WORDS["dot-env"].reason },
	{ id: "pem-file", pattern: /\.pem(?:$|["'\\/.,}\]])/i, reason: RULE_WORDS["pem-file"].reason },
	{ id: "id-rsa", pattern: /id_rsa(?:$|["'\\/.,}\]\w-])/i, reason: RULE_WORDS["id-rsa"].reason },
	{
		id: "password-assignment",
		pattern: labelValuePattern(/\bpassword\b/, BARE_PASSWORD_VALUE),
		accept: acceptPasswordValue,
		reason: RULE_WORDS["password-assignment"].reason,
	},
	{
		id: "secret-label-value",
		pattern: labelValuePattern(SECRET_LABEL, BARE_TOKEN_VALUE),
		accept: acceptSecretLabelValue,
		reason: RULE_WORDS["secret-label-value"].reason,
	},
	{ id: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, reason: RULE_WORDS["openai-key"].reason },
	{ id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/i, reason: RULE_WORDS["github-token"].reason },
	{ id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i, reason: RULE_WORDS["slack-token"].reason },
	{ id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: RULE_WORDS["aws-access-key"].reason },
	{ id: "jwt-token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, reason: RULE_WORDS["jwt-token"].reason },
];

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function loadConfig(): ContentPolicyConfig {
	try {
		if (!fs.existsSync(CONFIG_PATH)) return {};
		const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function compileRule(config: RuleConfig, index: number): Rule | null {
	if (config.enabled === false || !config.pattern) return null;
	try {
		return {
			id: config.id || `custom-${index + 1}`,
			pattern: new RegExp(config.pattern, config.flags || "i"),
			reason: config.reason || "blocked by local content policy",
		};
	} catch {
		return null;
	}
}

export function buildPolicy(config: ContentPolicyConfig = loadConfig()): { enabled: boolean; logPath: string; rules: Rule[] } {
	const disabled = new Set((config.disabledRuleIds || []).map((id) => String(id).trim()).filter(Boolean));
	const defaults = DEFAULT_RULES.filter((rule) => !disabled.has(rule.id));
	const custom = (config.rules || []).map(compileRule).filter((rule): rule is Rule => Boolean(rule));
	return {
		enabled: config.enabled !== false,
		logPath: expandHome(config.logPath || DEFAULT_LOG_PATH),
		rules: [...defaults, ...custom],
	};
}

function stableStringify(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return String(value);
	}
}

export function shouldScanTool(toolName: string | undefined): boolean {
	if (!toolName) return true;
	return !INTERNAL_COORDINATION_TOOLS.has(toolName);
}

export function scanArguments(args: unknown, rules: Rule[]): MatchResult | null {
	const text = stableStringify(args);
	for (const rule of rules) {
		if (!rule.accept) {
			const match = text.match(rule.pattern);
			if (match) return { rule, matchedText: match[0] || "" };
			continue;
		}
		// A rejected candidate must not hide a later hit in the same text.
		const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
		for (const match of text.matchAll(new RegExp(rule.pattern.source, flags))) {
			if (rule.accept(match)) return { rule, matchedText: match[0] || "" };
		}
	}
	return null;
}

// The arguments that carry text a tool would write, as opposed to a path, a name or a command.
const TEXT_ARGUMENTS = new Set(["content", "text", "newText", "oldText", "new_text", "old_text", "edits"]);

/** Whether the rule matched only in the text a tool would write, so the person's line can say so. */
export function matchedOnlyInText(args: unknown, rule: Rule): boolean {
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	const entries = Object.entries(args as Record<string, unknown>);
	if (!entries.some(([key]) => TEXT_ARGUMENTS.has(key))) return false;
	return !scanArguments(Object.fromEntries(entries.filter(([key]) => !TEXT_ARGUMENTS.has(key))), [rule]);
}

// The log keeps which tool a rule stopped, when and where, never the
// arguments' text: they may quote a person's conversation or a secret. A log
// written before this rule had a preview of them, removed once here.
function stripArgumentPreviews(logPath: string): void {
	try {
		const raw = fs.readFileSync(logPath, "utf-8");
		if (!raw.includes('"argumentsPreview"')) return;
		const rows: string[] = [];
		for (const line of raw.split("\n")) {
			try {
				const { argumentsPreview: _preview, ...row } = JSON.parse(line);
				rows.push(`${JSON.stringify(row)}\n`);
			} catch {
				// A line that does not read is dropped with its text.
			}
		}
		const tmp = `${logPath}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, rows.join(""), { mode: 0o600 });
		fs.renameSync(tmp, logPath);
	} catch {
		// No log yet, or one that cannot be rewritten: the next start tries again.
	}
}

function appendBlockedAttempt(logPath: string, row: Record<string, unknown>): void {
	try {
		fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
		fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
		try {
			fs.chmodSync(logPath, 0o600);
		} catch {
			// Best effort; append still succeeded.
		}
	} catch {
		// Do not fail open/closed differently because logging failed. The tool call
		// remains blocked by the hook return value.
	}
}

export default function (pi: ExtensionAPI) {
	const policy = buildPolicy();
	stripArgumentPreviews(policy.logPath);

	// Enforcement happens in the tool_call hook below; we intentionally do not
	// surface a "content policy: on" status line in the UI.

	pi.on("tool_call", async (event, ctx) => {
		if (!policy.enabled) return undefined;
		if (!shouldScanTool(event.toolName)) return undefined;

		const input = (event as any).input ?? (event as any).arguments ?? {};
		const match = scanArguments(input, policy.rules);
		if (!match) return undefined;

		appendBlockedAttempt(policy.logPath, {
			ts: new Date().toISOString(),
			cwd: ctx.cwd,
			tool: event.toolName,
			ruleId: match.rule.id,
			reason: match.rule.reason,
		});

		// The reason is for the model; the page shows the person one plain line on the step's card (words.ts).
		return { block: true, reason: contentPolicyBlockReason(event.toolName, match.rule.reason, matchedOnlyInText(input, match.rule)) };
	});
}
