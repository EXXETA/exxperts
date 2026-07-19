import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
	assertNoForbiddenDiagnosticKeys,
	componentFromText,
	createPromptAssemblyManifest,
	estimateTextTokens,
	findForbiddenDiagnosticKeys,
	fingerprintText,
} = await import("../src/prompt-diagnostics.js");
const {
	clearPromptAssemblyManifests,
	listPromptAssemblyManifests,
	recordPromptAssemblyManifest,
} = await import("../src/prompt-diagnostics-store.js");
const { persistentAgentRuntimeEnvelope } = await import("../src/persistent-agents.js");
const permissionsExt = (await import("../../../pi-package/extensions/permissions/index.js")).default;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function expectThrows(fn: () => unknown, expected: RegExp, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return;
	}
	throw new Error(`${label}: expected error`);
}

async function loadPermissionToolCallHandler(env: Record<string, string | undefined>): Promise<(event: any, ctx: any) => Promise<any>> {
	const previous: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) previous[key] = process.env[key];
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		const handlers: Array<(event: any, ctx: any) => Promise<any>> = [];
		await permissionsExt({
			on(eventName: string, handler: (event: any, ctx: any) => Promise<any>) {
				if (eventName === "tool_call") handlers.push(handler);
			},
		} as any);
		assert(handlers.length === 1, "permissions extension should register one tool_call handler");
		return handlers[0];
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const diagnosticsAgentId = "prompt-smoke-room";

async function runPermissionSmoke(): Promise<void> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-permissions-smoke-"));
	const previousActiveAgent = process.env.EXXETA_ACTIVE_AGENT;
	try {
		process.env.EXXETA_ACTIVE_AGENT = diagnosticsAgentId;
		const businessHandler = await loadPermissionToolCallHandler({
			EXXETA_PERSONA: "business",
			EXXETA_PERSISTENT_ROOM_SESSION: undefined,
			EXXETA_PERSISTENT_ROOM_AGENT: undefined,
			EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS: undefined,
		});
		for (const toolName of ["read", "ls", "find", "write_markdown_file", "read_spreadsheet"]) {
			const result = await businessHandler({ toolName, input: {} }, { cwd: tmp });
			assert(result?.block === true, `business persona without persistent-room markers should block ${toolName}`);
		}

		const persistentRoomHandler = await loadPermissionToolCallHandler({
			EXXETA_PERSONA: "business",
			EXXETA_PERSISTENT_ROOM_SESSION: "1",
			EXXETA_PERSISTENT_ROOM_AGENT: "wolfgang",
			EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE: "bounded",
			EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS: "ls,find,read,write_markdown_file,read_spreadsheet",
		});
		for (const toolName of ["ls", "find", "read", "write_markdown_file", "read_spreadsheet"]) {
			const result = await persistentRoomHandler({ toolName, input: {} }, { cwd: tmp });
			assert(!result?.block, `selected persistent-room workspace marker should allow ${toolName}`);
		}
		for (const toolName of ["grep", "write", "edit", "bash"]) {
			const result = await persistentRoomHandler({ toolName, input: {} }, { cwd: tmp });
			assert(result?.block === true, `selected persistent-room workspace marker should still block ${toolName}`);
		}

		// read_skill sits on the policy baseline (field bug 2026-07-11: the L2 index
		// advertised it but this gate blocked it — the tool never reached the room).
		assert(!(await businessHandler({ toolName: "read_skill", input: {} }, { cwd: tmp }))?.block, "policy baseline should allow read_skill without persistent-room markers");
		assert(!(await persistentRoomHandler({ toolName: "read_skill", input: {} }, { cwd: tmp }))?.block, "policy baseline should allow read_skill in persistent rooms");

		const badAgentHandler = await loadPermissionToolCallHandler({
			EXXETA_PERSONA: "business",
			EXXETA_PERSISTENT_ROOM_SESSION: "1",
			EXXETA_PERSISTENT_ROOM_AGENT: "../wolfgang",
			EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS: "ls,find,read",
		});
		assert((await badAgentHandler({ toolName: "read", input: {} }, { cwd: tmp }))?.block === true, "invalid persistent-room agent marker should not allow read");

		const badBundleHandler = await loadPermissionToolCallHandler({
			EXXETA_PERSONA: "business",
			EXXETA_PERSISTENT_ROOM_SESSION: "1",
			EXXETA_PERSISTENT_ROOM_AGENT: "wolfgang",
			EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE: "bounded",
			EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS: "ls,find,read,grep",
		});
		assert((await badBundleHandler({ toolName: "read", input: {} }, { cwd: tmp }))?.block === true, "invalid persistent-room workspace tool bundle should not allow read");

		const localFilesHandler = await loadPermissionToolCallHandler({
			EXXETA_PERSONA: "business",
			EXXETA_PERSISTENT_ROOM_SESSION: "1",
			EXXETA_PERSISTENT_ROOM_AGENT: "wolfgang",
			EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE: "localFiles",
			EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS: "read,ls,find,grep,write,edit,read_spreadsheet",
		});
		for (const toolName of ["read", "ls", "find", "grep", "write", "edit", "read_spreadsheet"]) {
			const result = await localFilesHandler({ toolName, input: {} }, { cwd: tmp });
			assert(!result?.block, `local-files persistent-room marker should allow ${toolName}`);
		}
		assert((await localFilesHandler({ toolName: "bash", input: {} }, { cwd: tmp }))?.block === true, "local-files persistent-room marker should still block bash");
	} finally {
		if (previousActiveAgent === undefined) delete process.env.EXXETA_ACTIVE_AGENT;
		else process.env.EXXETA_ACTIVE_AGENT = previousActiveAgent;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

const privateSentinel = "PRIVATE_PROMPT_DIAGNOSTICS_SENTINEL_π_SHOULD_NOT_LEAK";
const rawText = `System prompt body with ${privateSentinel} and unicode π.`;
const excludedRawText = `Excluded context ${privateSentinel} must still be hashed only.`;
const expectedHash = crypto.createHash("sha256").update(rawText, "utf-8").digest("hex");

try {
	assert(estimateTextTokens("") === 0, "empty string should estimate zero tokens");
	assert(estimateTextTokens("12345") === 2, "token estimate should use ceil(chars / 4)");
	assert(fingerprintText(rawText).value === expectedHash, "fingerprintText should use sha256 over utf-8 text");

	const tinyL2 = persistentAgentRuntimeEnvelope(new Date("2026-05-27T00:00:00.000Z"));
	assert(!tinyL2.includes("Active workspace capability"), "no-policy L2 should keep tiny runtime envelope without capability snippet");
	const capabilityL2 = persistentAgentRuntimeEnvelope(new Date("2026-05-27T00:00:00.000Z"), {
		workspaceAccessMode: "bounded",
		workspaceLabel: "workspace",
		rootCount: 1,
		pathAccess: "workspace-only",
		availableToolNames: ["ls", "find", "read", "write_markdown_file", "read_spreadsheet"],
		writeEnabled: true,
		bashEnabled: false,
		nativePiFilesystemToolsEnabled: false,
	});
	assert(capabilityL2.includes("## Active workspace capability"), "active workspace tools should add L2 capability snippet");
	assert(capabilityL2.includes("Workspace mode: Bounded workspace"), "bounded capability snippet should name bounded mode");
	assert(capabilityL2.includes("Workspace tools: ls, find, read, write_markdown_file, read_spreadsheet"), "capability snippet should list workspace tools");
	assert(capabilityL2.includes("Write scope: Markdown files only inside the selected workspace via write_markdown_file"), "capability snippet should state bounded Markdown write scope");
	assert(capabilityL2.includes("Bash/shell access: disabled"), "capability snippet should state bash disabled");
	assert(!capabilityL2.includes("/tmp/") && !capabilityL2.includes("/Users/"), "capability snippet should not include raw full paths");
	const localFilesCapabilityL2 = persistentAgentRuntimeEnvelope(new Date("2026-05-27T00:00:00.000Z"), {
		workspaceAccessMode: "localFiles",
		workspaceLabel: "workspace",
		rootCount: 1,
		pathAccess: "local-files",
		availableToolNames: ["read", "ls", "find", "grep", "write", "edit", "read_spreadsheet"],
		writeEnabled: true,
		bashEnabled: false,
		nativePiFilesystemToolsEnabled: true,
	});
	assert(localFilesCapabilityL2.includes("Workspace mode: Full access"), "local-files capability snippet should name Full access mode");
	assert(localFilesCapabilityL2.includes("Relative paths resolve from that folder"), "local-files capability snippet should explain cwd-relative paths");
	assert(localFilesCapabilityL2.includes("Explicit absolute paths and `~` home paths are allowed"), "local-files capability snippet should allow explicit external paths");
	assert(localFilesCapabilityL2.includes("Bash/shell access: disabled"), "local-files capability snippet should keep bash disabled");
	assert(!localFilesCapabilityL2.includes("/tmp/") && !localFilesCapabilityL2.includes("/Users/"), "local-files capability snippet should not include raw full paths");
	const localFilesBashCapabilityL2 = persistentAgentRuntimeEnvelope(new Date("2026-05-27T00:00:00.000Z"), {
		workspaceAccessMode: "localFiles",
		workspaceLabel: "workspace",
		rootCount: 1,
		pathAccess: "local-files",
		availableToolNames: [],
		writeEnabled: false,
		bashEnabled: true,
		nativePiFilesystemToolsEnabled: true,
	});
	assert(localFilesBashCapabilityL2.includes("Workspace tools: none"), "bash-only capability snippet should allow ordinary file tools to be off");
	assert(localFilesBashCapabilityL2.includes("Bash/shell access: enabled"), "local-files capability snippet should reflect explicit bash enabled");
	await runPermissionSmoke();

	const included = componentFromText({
		id: "persistent-l0:test",
		type: "persistent-l0",
		text: rawText,
		source: { "function": "persistentAgentPlatformKernel" },
		metadata: { sectionCount: 3, hasMemory: true, labels: ["platform", "kernel"] },
	});
	assert(included.included === true, "component should default to included");
	assert(included.chars === rawText.length, "component should report JS string chars");
	assert(included.bytes === Buffer.byteLength(rawText, "utf-8"), "component should report utf-8 bytes");
	assert(included.estimatedTokens === Math.ceil(rawText.length / 4), "component should report estimated tokens");
	assert(included.hash.algorithm === "sha256" && included.hash.value === expectedHash, "component should report sha256 hash");
	assert(!("text" in included), "component must not expose text field");
	assert(!("content" in included), "component must not expose content field");
	assert(!("prompt" in included), "component must not expose prompt field");
	assert(!("payload" in included), "component must not expose payload field");
	assert(!("preview" in included), "component must not expose preview field");

	const excluded = componentFromText({
		id: "context-file:excluded-test",
		type: "context-file",
		text: excludedRawText,
		included: false,
		excludedReason: "persistent-room diagnostics checkpoint test",
		source: { path: "/private/project/AGENTS.md" },
		metadata: { reasonCode: "test_only" },
	});
	assert(excluded.included === false, "excluded component should preserve included=false");
	assert(excluded.chars === excludedRawText.length, "excluded component should still report its own safe counts");

	const messageContext = componentFromText({
		id: "message-context:test",
		type: "message-context",
		text: "role/user sizes only",
		metadata: { messageCount: 2 },
	});

	const capabilityPolicy = componentFromText({
		id: "persistent-room:capability-policy",
		type: "capability-policy",
		text: [
			"rootCount=1",
			"allowedTools=",
			"writeEnabled=false",
			"denySegments=.git,.exxeta,.exxperts,node_modules",
		].join("\n"),
		included: false,
		excludedReason: "policy_metadata_snapshot_not_counted_in_prompt_totals",
		source: { "function": "readPersistentRoomCapabilityPolicy" },
		metadata: {
			policyId: "prcp_smoke",
			rootCount: 1,
			rootBasenames: ["workspace"],
			rootPathHashes: ["a".repeat(64)],
			allowedToolNames: [],
			writeEnabled: false,
			denySegmentCount: 4,
			deniedRootKinds: ["repo-root", "persistent-agents-root", "persistent-agent-root", "exxeta-state-root"],
		},
	});
	assert(capabilityPolicy.type === "capability-policy", "capability-policy component type should be accepted");
	assert(capabilityPolicy.included === false, "capability-policy component should remain excluded from prompt totals");
	assert(capabilityPolicy.source && !("path" in capabilityPolicy.source), "capability-policy source must not use source.path");

	const activeToolNames = ["ls", "find", "read", "write_markdown_file", "read_spreadsheet"];
	const activeCapabilityPolicy = componentFromText({
		id: "persistent-room:capability-policy-active",
		type: "capability-policy",
		text: [
			"rootCount=1",
			"allowedTools=ls,find,read,write_markdown_file,read_spreadsheet",
			"writeEnabled=true",
			"denySegments=.git,.exxeta,.exxperts,node_modules",
		].join("\n"),
		included: false,
		excludedReason: "policy_metadata_snapshot_not_counted_in_prompt_totals",
		source: { "function": "readPersistentRoomCapabilityPolicy" },
		metadata: {
			policyId: "prcp_active_smoke",
			rootCount: 1,
			rootBasenames: ["workspace"],
			rootPathHashes: ["b".repeat(64)],
			allowedToolNames: activeToolNames,
			writeEnabled: true,
			denySegmentCount: 4,
			deniedRootKinds: ["repo-root", "persistent-agents-root", "persistent-agent-root", "exxeta-state-root"],
		},
	});
	const activeToolsComponent = componentFromText({
		id: "persistent-room:active-tools-active",
		type: "tool-snippet",
		text: activeToolNames.join("\n"),
		included: false,
		excludedReason: "tool_registry_snapshot_not_counted_in_prompt_totals",
		source: { "function": "AgentSession.getActiveToolNames" },
		metadata: { activeToolCount: 5, activeToolNames },
	});
	const registeredToolsComponent = componentFromText({
		id: "persistent-room:registered-tools-active",
		type: "tool-snippet",
		text: activeToolNames.join("\n"),
		included: false,
		excludedReason: "tool_registry_snapshot_not_counted_in_prompt_totals",
		source: { "function": "AgentSession.getAllTools" },
		metadata: { registeredToolCount: 4, registeredToolNames: activeToolNames },
	});
	const providerSchemaTexts = activeToolNames.map((toolName) => JSON.stringify({
		name: toolName,
		description: `${toolName} selected-workspace schema snapshot`,
		parameters: { type: "object" },
	}));
	const providerSchemaBytes = providerSchemaTexts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf-8"), 0);
	const providerSchemaComponents = activeToolNames.map((toolName, index) => componentFromText({
		id: `provider-tool-schema:${toolName}`,
		type: "provider-tool-schema",
		text: providerSchemaTexts[index],
		included: false,
		excludedReason: "provider_schema_snapshot_not_counted_in_prompt_totals",
		source: { toolName },
		metadata: { toolName, active: true },
	}));

	const finalSystemPrompt = componentFromText({
		id: "persistent-room:final-system-prompt-turn-001",
		type: "final-system-prompt",
		text: `Final mutated system prompt with ${privateSentinel} measured only.`,
		source: { "function": "before_agent_start_diagnostics_smoke" },
		metadata: { phase: "before_agent_start_final", turnOrdinal: 1 },
	});
	assert(finalSystemPrompt.type === "final-system-prompt", "final-system-prompt component type should be accepted");

	const turnMessageContextText = [
		"messages=3",
		"user=1",
		"assistant=1",
		"tool=1",
		"custom=0",
		"chars=128",
		"bytes=128",
	].join("\n");
	const turnMessageContext = componentFromText({
		id: "persistent-room:message-context-turn-001",
		type: "message-context",
		text: turnMessageContextText,
		source: { "function": "persistentRoomPromptDiagnosticsExt.context" },
		metadata: {
			phase: "context",
			providerCallIndex: 1,
			messageCount: 3,
			userMessageCount: 1,
			assistantMessageCount: 1,
			toolResultMessageCount: 1,
			customMessageCount: 0,
			aggregateChars: 128,
			aggregateBytes: 128,
			aggregateEstimatedTokens: 32,
		},
	});
	assert(turnMessageContext.type === "message-context", "message-context component type should be accepted for per-turn aggregate counts");

	const restoredTranscriptSentinel = "RESTORED_LIVE_THREAD_RAW_TRANSCRIPT_SENTINEL_SHOULD_NOT_LEAK";
	const restoredLiveThreadBlock = [
		"[RESTORED PERSISTENT ROOM LIVE THREAD CONTEXT]",
		"This persistent-agent room was resumed from its saved live-thread transcript.",
		"Use this bounded excerpt only as continuation context for the current thread.",
		`User: ${restoredTranscriptSentinel}`,
		"[/RESTORED PERSISTENT ROOM LIVE THREAD CONTEXT]",
	].join("\n");
	const restoredLiveThreadContext = componentFromText({
		id: "persistent-room:turn-smoke-001:restored-live-thread-context",
		type: "restored-live-thread-context",
		text: restoredLiveThreadBlock,
		source: { "function": "withPersistentRoomRestoredLiveThreadContext" },
		metadata: {
			phase: "restored_live_thread_context",
			sourceItemCount: 5,
			eligibleItemCount: 4,
			includedItemCount: 3,
			omittedOlderCount: 1,
			truncatedMessageCount: 1,
			maxRestoredMessages: 24,
			maxRestoredTotalChars: 12000,
			maxRestoredMessageChars: 1200,
			messageCountTruncated: true,
			totalCharsTruncated: false,
			firstPromptOnly: true,
			durability: "uncheckpointed_thread_context_not_l1b_memory",
		},
	});
	assert(restoredLiveThreadContext.type === "restored-live-thread-context", "restored-live-thread-context component type should be accepted");
	assert(restoredLiveThreadContext.metadata?.sourceItemCount === 5, "restored-live-thread-context metadata should include sourceItemCount");
	assert(restoredLiveThreadContext.metadata?.eligibleItemCount === 4, "restored-live-thread-context metadata should include eligibleItemCount");
	assert(restoredLiveThreadContext.metadata?.includedItemCount === 3, "restored-live-thread-context metadata should include includedItemCount");
	assert(restoredLiveThreadContext.metadata?.omittedOlderCount === 1, "restored-live-thread-context metadata should include omittedOlderCount");
	assert(restoredLiveThreadContext.metadata?.truncatedMessageCount === 1, "restored-live-thread-context metadata should include truncatedMessageCount");
	assert(restoredLiveThreadContext.metadata?.maxRestoredMessages === 24, "restored-live-thread-context metadata should include maxRestoredMessages");
	assert(restoredLiveThreadContext.metadata?.maxRestoredTotalChars === 12000, "restored-live-thread-context metadata should include maxRestoredTotalChars");
	assert(restoredLiveThreadContext.metadata?.maxRestoredMessageChars === 1200, "restored-live-thread-context metadata should include maxRestoredMessageChars");
	assert(restoredLiveThreadContext.metadata?.messageCountTruncated === true, "restored-live-thread-context metadata should include messageCountTruncated");
	assert(restoredLiveThreadContext.metadata?.totalCharsTruncated === false, "restored-live-thread-context metadata should include totalCharsTruncated");
	assert(restoredLiveThreadContext.metadata?.firstPromptOnly === true, "restored-live-thread-context metadata should include firstPromptOnly");
	assert(restoredLiveThreadContext.metadata?.durability === "uncheckpointed_thread_context_not_l1b_memory", "restored-live-thread-context metadata should include durability");
	assert(!JSON.stringify(restoredLiveThreadContext.metadata).includes(restoredTranscriptSentinel), "restored-live-thread-context metadata must not include raw transcript strings");

	const manifest = createPromptAssemblyManifest({
		manifestId: "prompt-diagnostics-smoke-manifest",
		createdAt: "2026-05-25T00:00:00.000Z",
		surface: "persistent-room",
		agentId: diagnosticsAgentId,
		conversationId: "conv-smoke",
		sessionId: null,
		processKey: "persistent-room-session-create",
		model: { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5" },
		isolation: { rawSystemPrompt: true, noTools: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		components: [included, excluded, messageContext, capabilityPolicy],
		totals: { activeToolCount: 0, providerToolSchemaBytes: 0, messageCount: 2 },
		warnings: ["smoke-only warning without private content"],
	});
	assert(manifest.schemaVersion === 1, "manifest should expose explicit schema version");
	assert(manifest.components.length === 4, "manifest should include all components");
	assert(manifest.totals.componentCount === 4, "manifest componentCount should include included and excluded components");
	assert(manifest.totals.includedComponentCount === 2, "manifest includedComponentCount should count only included components");
	assert(manifest.totals.chars === included.chars + messageContext.chars, "manifest chars should sum included components only");
	assert(manifest.totals.bytes === included.bytes + messageContext.bytes, "manifest bytes should sum included components only");
	assert(manifest.totals.estimatedTokens === included.estimatedTokens + messageContext.estimatedTokens, "manifest tokens should sum included components only");
	assert(manifest.totals.activeToolCount === 0, "manifest should preserve safe optional totals");
	assert(manifest.totals.providerToolSchemaBytes === 0, "no-policy manifest should preserve zero provider schema bytes");
	assert(manifest.isolation?.noTools === true, "no-policy manifest should mark noTools isolation true");
	assert(manifest.totals.messageCount === 2, "manifest should preserve safe message count");

	const activeManifest = createPromptAssemblyManifest({
		manifestId: "prompt-diagnostics-active-tools-smoke-manifest",
		createdAt: "2026-05-25T00:00:10.000Z",
		surface: "persistent-room",
		agentId: diagnosticsAgentId,
		conversationId: "conv-active-tools-smoke",
		sessionId: null,
		processKey: "persistent-room-session-create",
		model: { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5" },
		isolation: { rawSystemPrompt: true, noTools: false, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		components: [activeCapabilityPolicy, activeToolsComponent, registeredToolsComponent, ...providerSchemaComponents],
		totals: { activeToolCount: 5, providerToolSchemaBytes: providerSchemaBytes },
	});
	assert(activeManifest.isolation?.noTools === false, "active workspace tools manifest should not claim noTools isolation");
	assert(activeManifest.totals.activeToolCount === 5, "active workspace tools manifest should report active tool count");
	assert(activeManifest.totals.providerToolSchemaBytes && activeManifest.totals.providerToolSchemaBytes > 0, "active workspace tools manifest should report provider schema bytes");
	const activeToolComponent = activeManifest.components.find((component) => component.id === "persistent-room:active-tools-active");
	assert((activeToolComponent?.metadata?.activeToolNames as string[] | undefined)?.join(",") === "ls,find,read,write_markdown_file,read_spreadsheet", "active diagnostics should list workspace tools");
	const registeredToolComponent = activeManifest.components.find((component) => component.id === "persistent-room:registered-tools-active");
	assert((registeredToolComponent?.metadata?.registeredToolNames as string[] | undefined)?.join(",") === "ls,find,read,write_markdown_file,read_spreadsheet", "registered diagnostics should list workspace tools");
	assert(activeManifest.components.filter((component) => component.type === "provider-tool-schema").length === 5, "active diagnostics should include provider schemas for workspace tools");
	assert(activeCapabilityPolicy.included === false, "active capability-policy component should remain excluded from prompt totals");
	const activeSerialized = JSON.stringify(activeManifest);
	assert(!activeSerialized.includes("/tmp/") && !activeSerialized.includes("/Users/") && !activeSerialized.includes("personalized-agents"), "active diagnostics must not include raw root/repo/persistent-agent paths");
	assert(activeSerialized.includes("workspace") && activeSerialized.includes("b".repeat(64)), "active diagnostics should retain redacted basename and root hash");

	const turnManifest = createPromptAssemblyManifest({
		manifestId: "prompt-diagnostics-turn-smoke-manifest",
		createdAt: "2026-05-25T00:00:30.000Z",
		surface: "persistent-room",
		agentId: diagnosticsAgentId,
		conversationId: "conv-smoke",
		sessionId: null,
		turnId: "turn-smoke-001",
		relatedManifestId: manifest.manifestId,
		processKey: "persistent-room-turn",
		model: { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5" },
		components: [restoredLiveThreadContext, finalSystemPrompt, turnMessageContext],
		warnings: [],
	});
	assert(turnManifest.processKey === "persistent-room-turn", "per-turn manifest should preserve persistent-room-turn process key");
	assert(turnManifest.turnId === "turn-smoke-001", "per-turn manifest should preserve turnId");
	assert(turnManifest.relatedManifestId === manifest.manifestId, "per-turn manifest should preserve relatedManifestId");
	assert(turnManifest.components.some((component) => component.type === "restored-live-thread-context"), "per-turn manifest should include restored-live-thread-context component");
	assert(turnManifest.components.some((component) => component.type === "final-system-prompt"), "per-turn manifest should include final-system-prompt component");
	assert(turnManifest.components.some((component) => component.type === "message-context"), "per-turn manifest should include message-context component");
	assert(turnManifest.totals.chars === restoredLiveThreadContext.chars + finalSystemPrompt.chars + turnMessageContext.chars, "per-turn manifest totals should include restored live-thread context, final prompt, and message context aggregates");
	const serializedTurnManifest = JSON.stringify(turnManifest);
	assert(!serializedTurnManifest.includes(restoredTranscriptSentinel), "serialized manifest must not include restored live-thread raw transcript strings");

	assertNoForbiddenDiagnosticKeys(manifest);
	assertNoForbiddenDiagnosticKeys(activeManifest);
	assertNoForbiddenDiagnosticKeys(turnManifest);
	assert(findForbiddenDiagnosticKeys({ estimatedTokens: 1, systemPromptChars: 2 }).length === 0, "guard should not reject safe compound metadata names");
	assert(findForbiddenDiagnosticKeys({ metadata: { text: "leak" } }).join(",") === "text", "guard should detect exact forbidden raw-text keys");
	expectThrows(
		() => componentFromText({ id: "bad", type: "persistent-l1b", text: "safe measurement input", metadata: { content: "not allowed" } as any }),
		/metadata key is forbidden/,
		"component metadata content key should be rejected",
	);

	clearPromptAssemblyManifests({ maxManifests: 4 });
	recordPromptAssemblyManifest(manifest, { maxManifests: 4 });
	recordPromptAssemblyManifest(turnManifest, { maxManifests: 4 });
	const workerManifest = createPromptAssemblyManifest({
		manifestId: "prompt-diagnostics-worker-smoke-manifest",
		createdAt: "2026-05-25T00:01:00.000Z",
		surface: "persistent-worker",
		agentId: diagnosticsAgentId,
		conversationId: "conv-worker-smoke",
		processKey: "worker-smoke",
		components: [componentFromText({ id: "worker-trigger:test", type: "worker-trigger-prompt", text: "trigger sentinel is measured only" })],
	});
	recordPromptAssemblyManifest(workerManifest, { maxManifests: 4 });
	const otherConversationManifest = createPromptAssemblyManifest({
		manifestId: "prompt-diagnostics-other-conversation-smoke-manifest",
		createdAt: "2026-05-25T00:02:00.000Z",
		surface: "persistent-room",
		agentId: diagnosticsAgentId,
		conversationId: "conv-other-smoke",
		components: [componentFromText({ id: "persistent-l2:other", type: "persistent-l2", text: "other conversation measured only" })],
	});
	recordPromptAssemblyManifest(otherConversationManifest, { maxManifests: 4 });
	const retained = listPromptAssemblyManifests({ agentId: diagnosticsAgentId });
	assert(retained.length === 4, "store should list recorded manifests for an agent newest-first");
	assert(retained[0].manifestId === "prompt-diagnostics-other-conversation-smoke-manifest", "store should return newest manifests first");
	const retainedSmokeConversation = listPromptAssemblyManifests({ agentId: diagnosticsAgentId, conversationId: "conv-smoke" });
	assert(retainedSmokeConversation.length === 2, "store should let session-create and per-turn manifests coexist for one conversation");
	assert(retainedSmokeConversation.some((item) => item.processKey === "persistent-room-session-create"), "store should retain session-create manifest alongside per-turn manifest");
	const retainedTurn = retainedSmokeConversation.find((item) => item.processKey === "persistent-room-turn");
	assert(retainedTurn != null, "store should list per-turn manifest by conversation");
	assert(retainedTurn.turnId === "turn-smoke-001", "store should preserve per-turn turnId through list filtering");
	assert(retainedTurn.relatedManifestId === manifest.manifestId, "relatedManifestId should survive store clone/list behavior");
	assert(listPromptAssemblyManifests({ agentId: diagnosticsAgentId, surface: "persistent-room" }).length === 3, "relatedManifestId should not affect surface filtering");
	assert(listPromptAssemblyManifests({ agentId: diagnosticsAgentId, surface: "persistent-worker" }).length === 1, "store should filter by surface");
	assert(listPromptAssemblyManifests({ agentId: "other-agent" }).length === 0, "store should filter by agentId");
	retained[0].warnings.push("mutated returned clone");
	assert(!listPromptAssemblyManifests({ agentId: diagnosticsAgentId })[0].warnings.includes("mutated returned clone"), "store should not expose mutable retained objects");
	recordPromptAssemblyManifest(createPromptAssemblyManifest({
		manifestId: "prompt-diagnostics-retention-smoke-manifest",
		createdAt: "2026-05-25T00:03:00.000Z",
		surface: "persistent-room",
		agentId: diagnosticsAgentId,
		conversationId: "conv-retention-smoke",
		components: [componentFromText({ id: "persistent-boot:retention", type: "persistent-boot", text: "retention measured only" })],
	}), { maxManifests: 4 });
	const bounded = listPromptAssemblyManifests({ agentId: diagnosticsAgentId });
	assert(bounded.length === 4, "store should retain only the configured bounded manifest count");
	assert(!bounded.some((item) => item.manifestId === "prompt-diagnostics-smoke-manifest"), "store should evict the oldest manifest when bounded");
	assert(bounded.some((item) => item.manifestId === "prompt-diagnostics-turn-smoke-manifest"), "bounded store should still retain newer per-turn manifest");

	const serialized = JSON.stringify({ manifest, activeManifest, turnManifest, retained, bounded });
	assert(!serialized.includes(privateSentinel), "serialized diagnostics must not include the private raw input sentinel");
	assert(!serialized.includes(rawText), "serialized diagnostics must not include raw included text");
	assert(!serialized.includes(excludedRawText), "serialized diagnostics must not include raw excluded text");
	const parsed = JSON.parse(serialized);
	assertNoForbiddenDiagnosticKeys(parsed);

	console.log("prompt diagnostics smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}
