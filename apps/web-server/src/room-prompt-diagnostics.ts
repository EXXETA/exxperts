import path from "node:path";
import type { createAgentSession, DefaultResourceLoader } from "@exxeta/exxperts-runtime";
import type { buildPersistentAgentBootContext } from "./persistent-agents.js";
import { resolvePersistentRoomCapabilityPolicy, persistentRoomCapabilityPolicyView } from "./persistent-room-workspace-policy.js";
import { type PromptDiagnosticsSurface, type PromptComponentType, type PromptDiagnosticsModel, type RedactedPromptComponent, componentFromText, createPromptAssemblyManifest } from "./prompt-diagnostics.js";
import { recordPromptAssemblyManifest } from "./prompt-diagnostics-store.js";

function parsePromptDiagnosticsSurface(value: unknown): PromptDiagnosticsSurface | undefined {
	if (value == null || value === "") return undefined;
	const surface = String(value).trim();
	if (surface === "persistent-room" || surface === "persistent-worker") return surface;
	throw new Error("surface must be persistent-room or persistent-worker");
}

function safeDiagnosticIdPart(value: string): string {
	return value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 120) || "unknown";
}

function persistentLayerComponentType(layerId: string): PromptComponentType {
	if (layerId === "l0") return "persistent-l0";
	if (layerId === "l1a") return "persistent-l1a";
	if (layerId === "instructions") return "persistent-instructions";
	if (layerId === "l1b") return "persistent-l1b";
	if (layerId === "l2") return "persistent-l2";
	return "append-system";
}

type PromptDiagnosticsSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

function recordPersistentRoomPromptDiagnostics(input: {
	agentId: string;
	conversationId: string;
	bootContext: ReturnType<typeof buildPersistentAgentBootContext>;
	model: PromptDiagnosticsModel;
	loader: DefaultResourceLoader;
	session: PromptDiagnosticsSession;
}): void {
	const components: RedactedPromptComponent[] = [];
	for (const layer of input.bootContext.layers) {
		components.push(componentFromText({
			id: `persistent-room:${layer.id}`,
			type: persistentLayerComponentType(layer.id),
			text: layer.content,
			source: { "function": layer.id === "l0" ? "persistentAgentPlatformKernel" : layer.id === "l2" ? "persistentAgentRuntimeEnvelope" : "buildPersistentAgentBootContext" },
			metadata: {
				layerId: layer.id,
				title: layer.title,
				// The instructions layer is one prompt piece made of up to two
				// texts; the parts say which one a number belongs to.
				...(layer.id === "instructions" ? {
					includesGlobal: input.bootContext.instructionsParts.includesGlobal,
					...(input.bootContext.instructionsParts.globalEstimatedTokens != null ? { globalEstimatedTokens: input.bootContext.instructionsParts.globalEstimatedTokens } : {}),
					...(input.bootContext.instructionsParts.roomEstimatedTokens != null ? { roomEstimatedTokens: input.bootContext.instructionsParts.roomEstimatedTokens } : {}),
				} : {}),
			},
		}));
	}
	components.push(componentFromText({
		id: "persistent-room:boot",
		type: "persistent-boot",
		text: input.bootContext.systemPrompt,
		included: false,
		excludedReason: "aggregate_snapshot_not_counted_in_totals",
		source: { "function": "buildPersistentAgentBootContext" },
		metadata: { layerCount: input.bootContext.layers.length },
	}));

	const appendSystemPrompts = input.loader.getAppendSystemPrompt();
	appendSystemPrompts.forEach((appendPrompt, index) => {
		if (appendPrompt === input.bootContext.systemPrompt) return;
		components.push(componentFromText({
			id: `append-system:${index + 1}`,
			type: "append-system",
			text: appendPrompt,
			source: { "function": "DefaultResourceLoader.getAppendSystemPrompt" },
			metadata: { appendIndex: index + 1 },
		}));
	});

	const contextFiles = input.loader.getAgentsFiles().agentsFiles;
	contextFiles.forEach((file, index) => {
		const text = typeof file.content === "string" ? file.content : "";
		components.push(componentFromText({
			id: `context-file:${index + 1}`,
			type: "context-file",
			text,
			source: { path: typeof file.path === "string" ? file.path : undefined },
			metadata: { index: index + 1, basename: typeof file.path === "string" ? path.basename(file.path) : "unknown" },
		}));
	});

	const skills = input.loader.getSkills().skills;
	skills.forEach((skill, index) => {
		const skillName = String(skill?.name ?? `skill-${index + 1}`);
		const skillPath = typeof skill?.filePath === "string" ? skill.filePath : undefined;
		components.push(componentFromText({
			id: `skill:${safeDiagnosticIdPart(skillName || String(index + 1))}`,
			type: "skill",
			text: [skillName, skillPath ?? ""].join("\n"),
			included: false,
			excludedReason: "safe_metadata_only_skill_body_not_loaded",
			source: { path: skillPath },
			metadata: { index: index + 1, skillName, disableModelInvocation: Boolean(skill?.disableModelInvocation) },
		}));
	});

	const policyResolution = resolvePersistentRoomCapabilityPolicy(input.agentId, input.conversationId);
	const policy = policyResolution.policy;
	if (policy) {
		const policyView = persistentRoomCapabilityPolicyView(policy);
		const rootBasenames = policyView.roots.map((root) => root.basename);
		const rootPathHashes = policyView.roots.map((root) => root.pathHash.value);
		const deniedRootKinds = policy.deniedRoots.map((root) => root.kind);
		components.push(componentFromText({
			id: "persistent-room:capability-policy",
			type: "capability-policy",
			text: [
				`rootCount=${policyView.rootCount}`,
				`allowedTools=${policyView.allowedToolNames.join(",")}`,
				`writeEnabled=${policyView.writeEnabled}`,
				`denySegments=${policyView.denySegments.join(",")}`,
			].join("\n"),
			included: false,
			excludedReason: "policy_metadata_snapshot_not_counted_in_prompt_totals",
			source: { "function": "resolvePersistentRoomCapabilityPolicy" },
			metadata: {
				policyId: policyView.policyId,
				policyResolutionSource: policyResolution.source,
				rootCount: policyView.rootCount,
				rootBasenames,
				rootPathHashes,
				allowedToolNames: policyView.allowedToolNames,
				writeEnabled: policyView.writeEnabled,
				denySegmentCount: policyView.denySegments.length,
				deniedRootKinds,
			},
		}));
	}

	const activeToolNames = input.session.getActiveToolNames();
	const registeredTools = input.session.getAllTools();
	components.push(componentFromText({
		id: "persistent-room:active-tools",
		type: "tool-snippet",
		text: activeToolNames.join("\n"),
		included: false,
		excludedReason: "tool_registry_snapshot_not_counted_in_prompt_totals",
		source: { "function": "AgentSession.getActiveToolNames" },
		metadata: { activeToolCount: activeToolNames.length, activeToolNames },
	}));
	components.push(componentFromText({
		id: "persistent-room:registered-tools",
		type: "tool-snippet",
		text: registeredTools.map((tool) => String(tool?.name ?? "")).filter(Boolean).join("\n"),
		included: false,
		excludedReason: "tool_registry_snapshot_not_counted_in_prompt_totals",
		source: { "function": "AgentSession.getAllTools" },
		metadata: { registeredToolCount: registeredTools.length, registeredToolNames: registeredTools.map((tool) => String(tool?.name ?? "")).filter(Boolean) },
	}));

	let providerToolSchemaBytes = 0;
	for (const tool of registeredTools) {
		const toolName = String(tool?.name ?? "").trim();
		if (!toolName) continue;
		const schemaSnapshot = JSON.stringify({ name: toolName, description: tool?.description ?? "", parameters: tool?.parameters ?? null });
		providerToolSchemaBytes += Buffer.byteLength(schemaSnapshot, "utf-8");
		components.push(componentFromText({
			id: `provider-tool-schema:${safeDiagnosticIdPart(toolName)}`,
			type: "provider-tool-schema",
			text: schemaSnapshot,
			included: false,
			excludedReason: "provider_schema_snapshot_not_counted_in_prompt_totals",
			source: { toolName, path: typeof tool?.sourceInfo?.path === "string" ? tool.sourceInfo.path : undefined },
			metadata: { toolName, active: activeToolNames.includes(toolName) },
		}));
	}

	if (typeof input.session?.systemPrompt === "string") {
		components.push(componentFromText({
			id: "persistent-room:session-system-prompt-pre-start",
			type: "session-system-prompt",
			text: input.session.systemPrompt,
			included: false,
			excludedReason: "aggregate_snapshot_not_counted_in_totals",
			source: { "function": "AgentSession.systemPrompt" },
			metadata: { phase: "pre_start" },
		}));
	}

	recordPromptAssemblyManifest(createPromptAssemblyManifest({
		surface: "persistent-room",
		agentId: input.agentId,
		conversationId: input.conversationId,
		model: input.model,
		processKey: "persistent-room-session-create",
		isolation: {
			rawSystemPrompt: true,
			noTools: activeToolNames.length === 0,
			noContextFiles: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
		components,
		totals: { activeToolCount: activeToolNames.length, providerToolSchemaBytes },
	}));
}

export { parsePromptDiagnosticsSurface, recordPersistentRoomPromptDiagnostics, safeDiagnosticIdPart };
