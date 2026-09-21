import crypto from "node:crypto";
import { estimateTokens } from "./token-estimate.js";

export type PromptDiagnosticsSurface = "persistent-room" | "persistent-worker";

export type PromptComponentType =
	| "persistent-l0"
	| "persistent-l1a"
	| "persistent-instructions"
	| "persistent-l1b"
	| "persistent-l2"
	| "persistent-boot"
	| "generic-base-system"
	| "append-system"
	| "context-file"
	| "skill"
	| "extension-system-mutation"
	| "tool-snippet"
	| "provider-tool-schema"
	| "capability-policy"
	| "restored-live-thread-context"
	| "message-context"
	| "session-system-prompt"
	| "final-system-prompt"
	| "provider-payload"
	| "worker-raw-system-prompt"
	| "worker-trigger-prompt";

export interface PromptTextFingerprint {
	algorithm: "sha256";
	value: string;
}

export interface PromptComponentSource {
	path?: string;
	"function"?: string;
	extension?: string;
	toolName?: string;
}

export type PromptComponentMetadataValue = string | number | boolean | string[];
export type PromptComponentMetadata = Record<string, PromptComponentMetadataValue>;

export interface RedactedPromptComponent {
	id: string;
	type: PromptComponentType;
	source?: PromptComponentSource;
	included: boolean;
	excludedReason?: string;
	chars: number;
	bytes: number;
	estimatedTokens: number;
	hash: PromptTextFingerprint;
	metadata?: PromptComponentMetadata;
}

export interface PromptDiagnosticsModel {
	provider: string;
	model: string;
	label?: string;
}

export interface PromptDiagnosticsIsolation {
	rawSystemPrompt?: boolean;
	noTools?: boolean;
	noContextFiles?: boolean;
	noSkills?: boolean;
	noExtensions?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
}

export interface PromptDiagnosticsUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: number;
}

export interface PromptAssemblyTotals {
	componentCount: number;
	includedComponentCount: number;
	chars: number;
	bytes: number;
	estimatedTokens: number;
	activeToolCount?: number;
	providerToolSchemaBytes?: number;
	messageCount?: number;
}

export interface PromptAssemblyManifest {
	schemaVersion: 1;
	manifestId: string;
	createdAt: string;
	surface: PromptDiagnosticsSurface;
	agentId: string;
	conversationId?: string;
	sessionId?: string | null;
	threadId?: string;
	turnId?: string;
	relatedManifestId?: string;
	processKey?: string;
	model?: PromptDiagnosticsModel;
	isolation?: PromptDiagnosticsIsolation;
	totals: PromptAssemblyTotals;
	components: RedactedPromptComponent[];
	usage?: PromptDiagnosticsUsage;
	warnings: string[];
}

export interface ComponentFromTextInput {
	id: string;
	type: PromptComponentType;
	text: string;
	source?: PromptComponentSource;
	included?: boolean;
	excludedReason?: string;
	metadata?: PromptComponentMetadata;
}

export interface CreatePromptAssemblyManifestInput {
	surface: PromptDiagnosticsSurface;
	agentId: string;
	conversationId?: string;
	sessionId?: string | null;
	threadId?: string;
	turnId?: string;
	relatedManifestId?: string;
	processKey?: string;
	model?: PromptDiagnosticsModel;
	isolation?: PromptDiagnosticsIsolation;
	components: RedactedPromptComponent[];
	usage?: PromptDiagnosticsUsage;
	warnings?: string[];
	createdAt?: Date | string;
	manifestId?: string;
	totals?: Partial<Pick<PromptAssemblyTotals, "activeToolCount" | "providerToolSchemaBytes" | "messageCount">>;
}

export const FORBIDDEN_PROMPT_DIAGNOSTIC_KEYS = ["text", "content", "prompt", "payload", "preview"] as const;

type ForbiddenPromptDiagnosticKey = typeof FORBIDDEN_PROMPT_DIAGNOSTIC_KEYS[number];

const FORBIDDEN_KEY_SET = new Set<string>(FORBIDDEN_PROMPT_DIAGNOSTIC_KEYS);

export function estimateTextTokens(text: string): number {
	return estimateTokens(text);
}

export function fingerprintText(text: string): PromptTextFingerprint {
	return {
		algorithm: "sha256",
		value: crypto.createHash("sha256").update(text, "utf-8").digest("hex"),
	};
}

export function componentFromText(input: ComponentFromTextInput): RedactedPromptComponent {
	const metadata = sanitizeMetadata(input.metadata);
	return withoutUndefined({
		id: input.id,
		type: input.type,
		source: sanitizeSource(input.source),
		included: input.included ?? true,
		excludedReason: input.excludedReason,
		chars: input.text.length,
		bytes: Buffer.byteLength(input.text, "utf-8"),
		estimatedTokens: estimateTextTokens(input.text),
		hash: fingerprintText(input.text),
		metadata,
	});
}

export function createPromptAssemblyManifest(input: CreatePromptAssemblyManifestInput): PromptAssemblyManifest {
	const components = input.components.map(cloneComponent);
	const includedComponents = components.filter((component) => component.included);
	const totals: PromptAssemblyTotals = withoutUndefined({
		componentCount: components.length,
		includedComponentCount: includedComponents.length,
		chars: sum(includedComponents, (component) => component.chars),
		bytes: sum(includedComponents, (component) => component.bytes),
		estimatedTokens: sum(includedComponents, (component) => component.estimatedTokens),
		activeToolCount: input.totals?.activeToolCount,
		providerToolSchemaBytes: input.totals?.providerToolSchemaBytes,
		messageCount: input.totals?.messageCount,
	});
	const manifest: PromptAssemblyManifest = withoutUndefined({
		schemaVersion: 1 as const,
		manifestId: input.manifestId ?? crypto.randomUUID(),
		createdAt: typeof input.createdAt === "string" ? input.createdAt : (input.createdAt ?? new Date()).toISOString(),
		surface: input.surface,
		agentId: input.agentId,
		conversationId: input.conversationId,
		sessionId: input.sessionId,
		threadId: input.threadId,
		turnId: input.turnId,
		relatedManifestId: input.relatedManifestId,
		processKey: input.processKey,
		model: input.model ? { ...input.model } : undefined,
		isolation: input.isolation ? { ...input.isolation } : undefined,
		totals,
		components,
		usage: input.usage ? { ...input.usage } : undefined,
		warnings: [...(input.warnings ?? [])],
	});
	assertNoForbiddenDiagnosticKeys(manifest);
	return manifest;
}

export function findForbiddenDiagnosticKeys(value: unknown, forbiddenKeys: readonly string[] = FORBIDDEN_PROMPT_DIAGNOSTIC_KEYS): string[] {
	const forbidden = new Set(forbiddenKeys.map((key) => key.toLowerCase()));
	const found = new Set<string>();
	const seen = new Set<object>();
	const visit = (node: unknown) => {
		if (node == null || typeof node !== "object") return;
		if (seen.has(node)) return;
		seen.add(node);
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
			if (forbidden.has(key.toLowerCase())) found.add(key);
			visit(child);
		}
	};
	visit(value);
	return [...found].sort();
}

export function assertNoForbiddenDiagnosticKeys(value: unknown, forbiddenKeys: readonly string[] = FORBIDDEN_PROMPT_DIAGNOSTIC_KEYS): void {
	const found = findForbiddenDiagnosticKeys(value, forbiddenKeys);
	if (found.length > 0) throw new Error(`prompt diagnostics contain forbidden raw-text key(s): ${found.join(", ")}`);
}

function sanitizeSource(source: PromptComponentSource | undefined): PromptComponentSource | undefined {
	if (!source) return undefined;
	return withoutUndefined({
		path: source.path,
		"function": source["function"],
		extension: source.extension,
		toolName: source.toolName,
	});
}

function sanitizeMetadata(metadata: PromptComponentMetadata | undefined): PromptComponentMetadata | undefined {
	if (!metadata) return undefined;
	const next: PromptComponentMetadata = {};
	for (const [key, value] of Object.entries(metadata)) {
		assertSafeMetadataKey(key);
		next[key] = Array.isArray(value) ? [...value] : value;
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

function assertSafeMetadataKey(key: string): void {
	if (FORBIDDEN_KEY_SET.has(key.toLowerCase() as ForbiddenPromptDiagnosticKey)) {
		throw new Error(`prompt diagnostics metadata key is forbidden because it may carry raw text: ${key}`);
	}
}

function cloneComponent(component: RedactedPromptComponent): RedactedPromptComponent {
	const cloned = withoutUndefined({
		id: component.id,
		type: component.type,
		source: sanitizeSource(component.source),
		included: component.included,
		excludedReason: component.excludedReason,
		chars: component.chars,
		bytes: component.bytes,
		estimatedTokens: component.estimatedTokens,
		hash: { ...component.hash },
		metadata: sanitizeMetadata(component.metadata),
	});
	assertNoForbiddenDiagnosticKeys(cloned);
	return cloned;
}

function sum<T>(items: T[], select: (item: T) => number): number {
	return items.reduce((total, item) => total + select(item), 0);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}
