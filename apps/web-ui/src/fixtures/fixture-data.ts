import type { CreateRoomFormValues } from "../components/create-room-panel";
import type { InRoomChatUsage } from "../components/in-room-chat";
import type { LauncherRoomThread } from "../components/launcher-room-card";
import type { ProductSidebarActive } from "../components/product-shell";
import type { ChatItem, ContextHealthStatus, PersistentAgentAiProfileSelectionStatus, PersistentAgentStatus, WebChatModelOption, WebChatModelStatus } from "../types";

export const FIXTURE_DEFAULT_AGENT_ID = "personal-coordinator";
export const FIXTURE_DEFAULT_AGENT_LABEL = "Personal Coordinator";

const now = "2026-06-02T10:30:00.000Z";
const yesterday = "2026-06-01T16:10:00.000Z";

export const fixtureModelOptions: WebChatModelOption[] = [
	{ provider: "fixture-ai", model: "strategy-large", label: "Fixture AI — Strategy Large", recommended: true, contextWindow: 272000 },
	{ provider: "fixture-ai", model: "fast-draft", label: "Fixture AI — Fast Draft", contextWindow: 128000 },
];

export const readyModelStatus: WebChatModelStatus = {
	ready: true,
	selected: fixtureModelOptions[0],
	recommended: fixtureModelOptions[0],
	models: fixtureModelOptions,
	activeProfileId: "fixture-profile",
	activeProfileLabel: "Fixture Profile",
	roomRecommended: fixtureModelOptions[0],
	roomModels: fixtureModelOptions,
	message: null,
};

export const noModelStatus: WebChatModelStatus = {
	ready: false,
	selected: null,
	recommended: null,
	models: [],
	activeProfileId: "fixture-profile",
	activeProfileLabel: "Fixture Profile",
	roomRecommended: null,
	roomModels: [],
	message: "No fixture models are available for this profile.",
};

export const readyAiProfileStatus: PersistentAgentAiProfileSelectionStatus = {
	activeProfileId: "fixture-profile",
	activeProfile: {
		id: "fixture-profile",
		label: "Fixture Profile",
		kind: "builtin",
		active: true,
		ready: true,
		message: null,
		provider: { id: "fixture-ai", configured: true, source: "stored", label: "Fixture keychain" },
		requiredModels: [
			{ provider: "fixture-ai", model: "strategy-large", label: "Strategy Large", purpose: "Room chat", present: true, authConfigured: true },
		],
	},
	profiles: [
		{
			id: "fixture-profile",
			label: "Fixture Profile",
			kind: "builtin",
			active: true,
			ready: true,
			message: null,
			provider: { id: "fixture-ai", configured: true, source: "stored", label: "Fixture keychain" },
			requiredModels: [
				{ provider: "fixture-ai", model: "strategy-large", label: "Strategy Large", purpose: "Room chat", present: true, authConfigured: true },
			],
		},
	],
	state: { path: "~/.exxperts/app/persistent-agent-ai-profile.json", source: "file", message: null },
};

export const notConfiguredAiProfileStatus: PersistentAgentAiProfileSelectionStatus = {
	activeProfileId: "fixture-profile",
	activeProfile: {
		id: "fixture-profile",
		label: "Fixture Profile",
		kind: "builtin",
		active: true,
		ready: false,
		message: "Connect a provider before selecting a profile.",
		provider: { id: "fixture-ai", configured: false, source: "stored", label: "Fixture keychain" },
		requiredModels: [
			{ provider: "fixture-ai", model: "strategy-large", label: "Strategy Large", purpose: "Room chat", present: false, authConfigured: false },
		],
	},
	profiles: [
		{
			id: "fixture-profile",
			label: "Fixture Profile",
			kind: "builtin",
			active: true,
			ready: false,
			message: "Connect a provider before selecting a profile.",
			provider: { id: "fixture-ai", configured: false, source: "stored", label: "Fixture keychain" },
			requiredModels: [
				{ provider: "fixture-ai", model: "strategy-large", label: "Strategy Large", purpose: "Room chat", present: false, authConfigured: false },
			],
		},
	],
	state: { path: "~/.exxperts/app/persistent-agent-ai-profile.json", source: "default", message: "No AI profile selected yet." },
};

function roomStatus(overrides: Partial<PersistentAgentStatus> & Pick<PersistentAgentStatus, "id" | "displayName" | "status">): PersistentAgentStatus {
	const runtimeModel = overrides.runtime?.model ?? { provider: "fixture-ai", model: "strategy-large", label: "Fixture AI — Strategy Large" };
	return {
		id: overrides.id,
		exists: overrides.exists ?? true,
		status: overrides.status,
		root: `fixture://rooms/${overrides.id}`,
		runtime: overrides.runtime ?? {
			schemaVersion: 1,
			agentId: overrides.id,
			state: "idle",
			activeThreadId: null,
			model: runtimeModel,
			updatedAt: Date.parse(now),
		},
		activeThread: overrides.activeThread ?? null,
		displayName: overrides.displayName,
		description: overrides.description ?? "Synthetic persistent-room fixture.",
		role: overrides.role ?? "Synthetic fixture room",
		model: overrides.model ?? { provider: "fixture-ai", model: "strategy-large" },
		l1a: overrides.l1a ?? { path: `fixture://rooms/${overrides.id}/l1a`, exists: true, bytes: 2048 },
		l1b: overrides.l1b ?? { path: `fixture://rooms/${overrides.id}/l1b`, exists: true, bytes: 4096, sections: ["profile", "working-context"], missingSections: [] },
		sectionRegistry: overrides.sectionRegistry ?? { path: `fixture://rooms/${overrides.id}/sections`, exists: true, missingSections: [] },
		recentContext: overrides.recentContext ?? { fullEntries: 9, softCap: 24, hardCap: 40 },
		memoryStatus: overrides.memoryStatus ?? {
			recentContextCount: 9,
			recentContextSoftCap: 24,
			recentContextHardCap: 40,
			recentContextLevel: "ok",
			lastCheckpointId: "fixture-checkpoint-001",
			lastCheckpointAt: yesterday,
		},
		scheduleSummary: overrides.scheduleSummary ?? {
			executionEnabled: false,
			totalCount: 0,
			enabledCount: 0,
			nextRunAt: null,
			lastRunAt: null,
			lastStatus: null,
			lastError: null,
		},
		promptBudget: overrides.promptBudget,
		errors: overrides.errors ?? [],
		warnings: overrides.warnings ?? [],
	};
}

const personalCoordinator = roomStatus({
	id: FIXTURE_DEFAULT_AGENT_ID,
	displayName: FIXTURE_DEFAULT_AGENT_LABEL,
	status: "ready",
	description: "Synthetic default room for fixture review.",
});

const oneReadyRoom = roomStatus({
	id: "strategy-room",
	displayName: "Strategy Room",
	status: "ready",
	memoryStatus: {
		recentContextCount: 14,
		recentContextSoftCap: 24,
		recentContextHardCap: 40,
		recentContextLevel: "ok",
		lastCheckpointId: "fixture-checkpoint-002",
		lastCheckpointAt: now,
	},
});

const deliveryRoomA = roomStatus({ id: "delivery-room-a", displayName: "Delivery Room", status: "ready" });
const deliveryRoomB = roomStatus({
	id: "delivery-room-b",
	displayName: "Delivery Room",
	status: "ready",
	memoryStatus: {
		recentContextCount: 21,
		recentContextSoftCap: 24,
		recentContextHardCap: 40,
		recentContextLevel: "approaching_soft_cap",
		lastCheckpointId: "fixture-checkpoint-003",
		lastCheckpointAt: yesterday,
	},
});
const researchRoom = roomStatus({ id: "research-room", displayName: "Research Room", status: "ready" });

const standbyRoom = roomStatus({
	id: "standby-room",
	displayName: "Standby Room",
	status: "ready",
	runtime: {
		schemaVersion: 1,
		agentId: "standby-room",
		state: "standby",
		activeThreadId: "fixture-thread-standby",
		model: { provider: "fixture-ai", model: "strategy-large", label: "Fixture AI — Strategy Large" },
		updatedAt: Date.parse(now),
	},
});

const needsAbsorbRoom = roomStatus({
	id: "memory-review-room",
	displayName: "Memory Review Room",
	status: "needs_absorb",
	memoryStatus: {
		recentContextCount: 24,
		recentContextSoftCap: 24,
		recentContextHardCap: 40,
		recentContextLevel: "at_soft_cap",
		lastCheckpointId: "fixture-checkpoint-004",
		lastCheckpointAt: yesterday,
	},
	warnings: ["Fixture warning: recent context is at soft cap."],
});

const errorRoom = roomStatus({
	id: "attention-room",
	displayName: "Attention Room",
	status: "error",
	errors: ["Fixture error: synthetic room diagnostics require attention."],
	memoryStatus: {
		recentContextCount: 3,
		recentContextSoftCap: 24,
		recentContextHardCap: 40,
		recentContextLevel: "ok",
		lastCheckpointId: null,
		lastCheckpointAt: null,
	},
});

const setupNeededRoom = roomStatus({
	id: "setup-needed-room",
	displayName: "Setup Needed Room",
	status: "ready",
});

const liveLikeEmptyMemory = {
	recentContextCount: 0,
	recentContextSoftCap: 7,
	recentContextHardCap: 10,
	recentContextLevel: "empty" as const,
	lastCheckpointId: null,
	lastCheckpointAt: null,
};

const liveLikeRecentContext = { fullEntries: 0, softCap: 7, hardCap: 10 };

const liveLikeAdaRoom = roomStatus({
	id: "fixture-ada-room",
	displayName: "Ada",
	status: "ready",
	recentContext: liveLikeRecentContext,
	memoryStatus: liveLikeEmptyMemory,
});

const liveLikeNocturneRoom = roomStatus({
	id: "fixture-nocturne-room",
	displayName: "Nocturne",
	status: "ready",
	recentContext: liveLikeRecentContext,
	memoryStatus: liveLikeEmptyMemory,
});

const liveLikeZephyrRoom = roomStatus({
	id: "fixture-zephyr-room",
	displayName: "Zephyr",
	status: "ready",
	recentContext: { fullEntries: 1, softCap: 7, hardCap: 10 },
	memoryStatus: {
		recentContextCount: 1,
		recentContextSoftCap: 7,
		recentContextHardCap: 10,
		recentContextLevel: "ok",
		lastCheckpointId: "fixture-checkpoint-live-like-001",
		lastCheckpointAt: "2026-06-03T12:44:04.427Z",
	},
});

export const standbyThread: LauncherRoomThread = {
	state: "standby",
	agentId: standbyRoom.id,
	displayName: standbyRoom.displayName ?? standbyRoom.id,
	conversationId: "fixture-thread-standby",
	model: fixtureModelOptions[0],
	items: [],
};

export interface HomeFixtureState {
	kind: "home";
	id: string;
	label: string;
	description: string;
	statuses: PersistentAgentStatus[];
	modelStatus: WebChatModelStatus;
	aiProfileStatus: PersistentAgentAiProfileSelectionStatus;
	thread: LauncherRoomThread | null;
	live: boolean;
}

export interface SidebarFixtureState {
	kind: "sidebar";
	id: string;
	label: string;
	description: string;
	active: ProductSidebarActive;
	connected: boolean;
}

export interface CreateRoomFixtureState {
	kind: "create-room";
	id: string;
	label: string;
	description: string;
	values: CreateRoomFormValues;
	open: boolean;
	submitting?: boolean;
	error?: string | null;
	successName?: string | null;
}

export interface InRoomChatActionItem {
	label: string;
	title?: string;
	disabled?: boolean;
}

export interface InRoomChatFixtureState {
	kind: "in-room-chat";
	id: string;
	label: string;
	description: string;
	activeDisplay: string;
	ownerSecondary?: string | null;
	connected: boolean;
	busy: boolean;
	usage: InRoomChatUsage;
	currentModelLabel?: string | null;
	items: ChatItem[];
	inputValue: string;
	composerPlaceholder?: string;
	contextHealth?: ContextHealthStatus | null;
	topbarActions?: InRoomChatActionItem[];
	composerRightActions?: InRoomChatActionItem[];
}

export interface TaskCardsFixtureState {
	kind: "task-cards";
	id: string;
	label: string;
	description: string;
}

export type FixtureState = HomeFixtureState | SidebarFixtureState | CreateRoomFixtureState | InRoomChatFixtureState | TaskCardsFixtureState;

export const sidebarFixtureStates: SidebarFixtureState[] = [
	{ kind: "sidebar", id: "sidebar-home", label: "ProductSidebar / Home active", description: "Product navigation with Home selected.", active: "home", connected: true },
	{ kind: "sidebar", id: "sidebar-ai-setup", label: "ProductSidebar / AI setup active", description: "Product navigation with AI setup selected.", active: "ai-setup", connected: true },
	{ kind: "sidebar", id: "sidebar-dashboard", label: "ProductSidebar / Dashboard active", description: "Product navigation with Dashboard selected.", active: "dashboard", connected: true },
];

export const homeFixtureStates: HomeFixtureState[] = [
	{
		kind: "home",
		id: "home-empty",
		label: "Home / no active rooms",
		description: "Home layout with static fixture data and an empty room list.",
		statuses: [],
		modelStatus: readyModelStatus,
		aiProfileStatus: readyAiProfileStatus,
		thread: null,
		live: false,
	},
	{
		kind: "home",
		id: "home-one-ready-room",
		label: "Home / one ready room",
		description: "One synthetic ready room with available fixture models.",
		statuses: [oneReadyRoom],
		modelStatus: readyModelStatus,
		aiProfileStatus: readyAiProfileStatus,
		thread: null,
		live: false,
	},
	{
		kind: "home",
		id: "home-duplicate-names",
		label: "Home / duplicate room names",
		description: "Multiple rooms include duplicate display names with distinct synthetic agent IDs.",
		statuses: [personalCoordinator, deliveryRoomA, deliveryRoomB, researchRoom],
		modelStatus: readyModelStatus,
		aiProfileStatus: readyAiProfileStatus,
		thread: null,
		live: false,
	},
	{
		kind: "home",
		id: "home-live-like-metadata",
		label: "Home / live-like metadata alignment",
		description: "Three ready synthetic rooms matching the live empty-empty-checkpoint metadata pattern.",
		statuses: [liveLikeAdaRoom, liveLikeNocturneRoom, liveLikeZephyrRoom],
		modelStatus: readyModelStatus,
		aiProfileStatus: readyAiProfileStatus,
		thread: null,
		live: false,
	},
	{
		kind: "home",
		id: "home-mixed-statuses",
		label: "Home / mixed statuses",
		description: "Ready, standby-like, needs-absorb, and error states rendered together.",
		statuses: [personalCoordinator, standbyRoom, needsAbsorbRoom, errorRoom],
		modelStatus: readyModelStatus,
		aiProfileStatus: readyAiProfileStatus,
		thread: standbyThread,
		live: false,
	},
	{
		kind: "home",
		id: "home-ai-setup-needed",
		label: "Home / AI setup needed or no model",
		description: "A ready room when the active fixture AI profile has no available model.",
		statuses: [setupNeededRoom],
		modelStatus: noModelStatus,
		aiProfileStatus: notConfiguredAiProfileStatus,
		thread: null,
		live: false,
	},
];

const emptyCreateRoomValues: CreateRoomFormValues = {
	personalAgentName: "",
	confirmPersonalAgentName: "",
	userName: "",
	preferredAddress: "",
};

const strategyRoomValues: CreateRoomFormValues = {
	personalAgentName: "Strategy Room",
	confirmPersonalAgentName: "Strategy Room",
	userName: "Alex Example",
	preferredAddress: "Alex",
};

export const createRoomFixtureStates: CreateRoomFixtureState[] = [
	{
		kind: "create-room",
		id: "create-room-empty",
		label: "Create room / empty form",
		description: "The live + New room screen with an open empty form.",
		values: emptyCreateRoomValues,
		open: true,
	},
	{
		kind: "create-room",
		id: "create-room-closed",
		label: "Create room / closed form",
		description: "The simple closed/cancelled state before a successful create.",
		values: emptyCreateRoomValues,
		open: false,
	},
	{
		kind: "create-room",
		id: "create-room-partial",
		label: "Create room / partially filled",
		description: "Partially entered synthetic room details before validation.",
		values: {
			personalAgentName: "Strategy Room",
			confirmPersonalAgentName: "Strategy",
			userName: "Alex Example",
			preferredAddress: "Alex",
		},
		open: true,
	},
	{
		kind: "create-room",
		id: "create-room-validation-error",
		label: "Create room / validation error",
		description: "Client-side confirmation mismatch using synthetic values.",
		values: {
			personalAgentName: "Strategy Room",
			confirmPersonalAgentName: "Research Room",
			userName: "Alex Example",
			preferredAddress: "Alex",
		},
		open: true,
		error: "Personal agent name confirmation must match.",
	},
	{
		kind: "create-room",
		id: "create-room-submitting",
		label: "Create room / submitting",
		description: "Synthetic loading state with the primary action disabled.",
		values: strategyRoomValues,
		open: true,
		submitting: true,
	},
	{
		kind: "create-room",
		id: "create-room-server-error",
		label: "Create room / server error",
		description: "Synthetic server/API error rendered by the current form.",
		values: strategyRoomValues,
		open: true,
		error: "A fixture room with this name already exists.",
	},
	{
		kind: "create-room",
		id: "create-room-success",
		label: "Create room / success confirmation",
		description: "Current post-create success message with the form closed.",
		values: emptyCreateRoomValues,
		open: false,
		successName: "Strategy Room",
	},
];



const emptyChatUsage: InRoomChatUsage = {
	turns: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	totalTokens: 0,
};

const activeChatUsage: InRoomChatUsage = {
	turns: 4,
	input: 12840,
	output: 3420,
	cacheRead: 8200,
	cacheWrite: 0,
	cost: 0.18,
	totalTokens: 22600,
};

const contextHealthGreen: ContextHealthStatus = {
	tokens: 32000,
	contextWindow: 272000,
	checkpointTokens: 125000,
	checkpointPercent: 25.6,
	zone: "green",
	source: "runtime-context-usage",
};

const contextHealthYellow: ContextHealthStatus = {
	tokens: 105000,
	contextWindow: 272000,
	checkpointTokens: 125000,
	checkpointPercent: 84,
	zone: "yellow",
	source: "runtime-context-usage",
};

const contextHealthRed: ContextHealthStatus = {
	tokens: 121000,
	contextWindow: 272000,
	checkpointTokens: 125000,
	checkpointPercent: 96.8,
	zone: "red",
	source: "runtime-context-usage",
};

const contextHealthUnknown: ContextHealthStatus = {
	tokens: null,
	contextWindow: 272000,
	checkpointTokens: 125000,
	checkpointPercent: null,
	zone: "unknown",
	source: "unknown",
};

function chatFixture(overrides: Omit<InRoomChatFixtureState, "kind" | "connected" | "currentModelLabel"> & Partial<Pick<InRoomChatFixtureState, "connected" | "currentModelLabel">>): InRoomChatFixtureState {
	return {
		kind: "in-room-chat",
		connected: true,
		currentModelLabel: fixtureModelOptions[0].label,
		...overrides,
	};
}

const activeConversationItems: ChatItem[] = [
	{ kind: "system", id: "fixture-system-context", text: "Recent room context loaded for this synthetic session.", level: "info" },
	{ kind: "user", id: "fixture-user-brief", text: "Can you turn the notes from today's strategy discussion into a clear decision record?" },
	{
		kind: "assistant",
		id: "fixture-assistant-brief",
		text: "Yes. I would structure it as:\n\n1. **Decision** — what was agreed.\n2. **Rationale** — why this direction is preferable.\n3. **Open questions** — what still needs evidence.\n4. **Next actions** — owners and timing.\n\nThe main gap is the evidence behind the customer segment priority, so I would ask the research room to validate that before the final version.",
	},
];

const markdownStressItems: ChatItem[] = [
	{
		kind: "user",
		id: "fixture-user-long-prompt",
		text: "I have a long prompt with several constraints. Please keep the answer concise, explain trade-offs, preserve the client's language where possible, avoid overclaiming the evidence, and give me something I can paste into a working document. The audience is mixed: leadership wants the strategic headline, while delivery needs concrete next steps. Also flag anything that should not be presented as a fact yet.",
	},
	{
		kind: "assistant",
		id: "fixture-assistant-markdown",
		text: "## Recommended framing\n\nUse a short decision-led opening, then separate confirmed facts from working assumptions. The safest phrasing is to say the team has **prioritized** a segment, not that the segment has been proven. This keeps leadership oriented without hiding uncertainty from the delivery team.\n\n### Draft structure\n\n- Lead with the practical decision.\n- Keep evidence qualifiers visible.\n- Convert risks into owner-based next steps.\n  - Name the owner when the follow-up is known.\n  - Mark the item as an assumption when evidence is still directional.\n\n1. State the decision in one calm sentence.\n2. Add the rationale and confidence level.\n3. Close with the next action and review point.\n\n> Working assumption: the segment priority is directionally supported, but the pricing evidence should not be presented as final.\n\nInline code such as `priority_segment_confidence` should remain readable without breaking the column, and longer links or identifiers should wrap safely.\n\n```ts\ntype DecisionRecord = {\n  decision: string;\n  rationale: string[];\n  openQuestions: string[];\n  confidence: \"confirmed\" | \"directional\" | \"unknown\";\n};\n\nconst synthesizedReviewLine = \"Segment priority is directionally supported by fixture notes, but pricing confidence remains intentionally provisional until a named owner validates the assumption in the next review cycle.\";\n```\n\n| Area | Status | Recommended wording | Owner note |\n| --- | --- | --- | --- |\n| Segment choice | Draft | Directionally supported by current notes; not yet proven as the only viable segment. | Ask the research room to validate the confidence level. |\n| Offer narrative | Ready | Keep concise and decision-led so leadership can repeat it consistently. | This room can include it in the decision record. |\n| Delivery plan | Pending | Convert each risk into a named follow-up action before presenting the plan. | Delivery lead should confirm sequencing. |\n\n---\n\nThe final answer should feel useful now while making the remaining uncertainty easy to spot.",
	},
];

const mermaidDiagramItems: ChatItem[] = [
	{ kind: "user", id: "fixture-user-mermaid-diagram", text: "Can you show me the decision-record review flow as a diagram?" },
	{
		kind: "assistant",
		id: "fixture-assistant-mermaid-diagram",
		text: "Here is the simplest version:\n\n```mermaid\nflowchart LR\n    Notes[Meeting notes] --> Draft[Draft record]\n    Draft --> Review[Team review]\n    Review --> Approved[Approved record]\n    Review --> Revise[Revise draft]\n    Revise --> Draft\n    Approved --> Share[Share with leadership]\n```\n\nOnce approved, the record can be saved as an artifact and shared.",
	},
];

const mermaidRepairItems: ChatItem[] = [
	{ kind: "user", id: "fixture-user-mermaid-repair", text: "Show the runtime request flow as a diagram." },
	{
		kind: "assistant",
		id: "fixture-assistant-mermaid-repair",
		text: "```mermaid\nflowchart LR\n    User[Employee<br/>\"Book 6 hours on project X\"]\n    Agent[Time Booking Agent<br/>understands intent]\n    API[Semantic / Action API<br/>business-level interface]\n    User --> Agent --> API\n```",
	},
];

const mermaidBrokenItems: ChatItem[] = [
	{ kind: "user", id: "fixture-user-mermaid-broken", text: "Diagram the pipeline please." },
	{
		kind: "assistant",
		id: "fixture-assistant-mermaid-broken",
		text: "Here is a first pass:\n\n```mermaid\nzorpchart TB\n    this is not a real mermaid diagram !!!\n    A --> --> B ??? {{{\n```\n\nRender failure degrades to the source as a plain code block.",
	},
];

const mermaidStreamingItems: ChatItem[] = [
	{ kind: "user", id: "fixture-user-mermaid-streaming", text: "Sketch the escalation flow." },
	{
		kind: "assistant",
		id: "fixture-assistant-mermaid-streaming",
		streaming: true,
		text: "Coming right up:\n\n```mermaid\nflowchart TD\n    Agent[Agent] --> Check{Confident?}\n    Check -->|Yes| Answer[Answer]\n    Check -->|No| Human[Escalate to human]\n```",
	},
];

const foldedUserPromptItems: ChatItem[] = [
	{
		kind: "user",
		id: "fixture-user-folded-prompt",
		text: "Please turn this pasted workshop capture into a decision memo.\n\n1. Keep the first paragraph short enough for a sponsor to read quickly.\n2. Separate confirmed decisions from working assumptions.\n3. Preserve the team's wording when it carries political nuance.\n4. Avoid claiming the market evidence is conclusive.\n5. Convert risks into named follow-up actions.\n6. Include a section for unresolved questions.\n7. End with a calm recommendation that can be shared in the next steering meeting.\n\nThe team is aligned on the direction, but the confidence level is uneven across customer segments, delivery capacity, and pricing evidence. I need a version that is useful without sounding more certain than we are.",
	},
	{
		kind: "assistant",
		id: "fixture-assistant-folded-prompt-response",
		text: "I would draft it as a decision memo with three sections: confirmed decisions, working assumptions, and follow-up actions. The key is to keep confidence qualifiers visible while still giving leadership a clear next step.",
	},
];

const thinkingAfterSendItems: ChatItem[] = [
	{ kind: "user", id: "fixture-user-thinking", text: "Can you draft the decision record from today's notes?" },
];

const streamingItems: ChatItem[] = [
	{ kind: "user", id: "fixture-user-streaming", text: "Draft the first version and keep going until the outline is complete." },
	{ kind: "assistant", id: "fixture-assistant-streaming", text: "I’ll start with the decision summary, then map each open question to the evidence we still need", streaming: true },
];

const workspaceToolStackItems: ChatItem[] = [
	{ kind: "user", id: "fixture-user-workspace-tools", text: "Look through the workspace notes and summarize the decision evidence." },
	{ kind: "tool", id: "fixture-tool-ls-1", name: "ls", args: { path: "workspace" }, status: "done", result: "notes\nsrc\nplanning" },
	{ kind: "tool", id: "fixture-tool-find-1", name: "find", args: { path: "workspace/notes", pattern: "*.md" }, status: "done", result: "workspace/notes/segment-priority.md\nworkspace/notes/pricing-confidence.md\nworkspace/notes/delivery-risks.md" },
	{ kind: "tool", id: "fixture-tool-read-1", name: "read", args: { path: "workspace/notes/segment-priority.md" }, status: "done", result: "Segment priority is directionally supported by recent workshop notes and two customer interviews." },
	{ kind: "tool", id: "fixture-tool-read-2", name: "read", args: { path: "workspace/notes/pricing-confidence.md" }, status: "done", result: "Pricing confidence is intentionally provisional. The team needs one more validation pass before presenting it as fact." },
	{ kind: "tool", id: "fixture-tool-find-2", name: "find", args: { path: "workspace/planning", pattern: "*decision*" }, status: "done", result: "workspace/planning/decision-record-outline.md" },
	{ kind: "tool", id: "fixture-tool-read-3", name: "read", args: { path: "workspace/planning/decision-record-outline.md" }, status: "done", result: "Decision record outline: decision, rationale, open questions, next actions." },
	{
		kind: "assistant",
		id: "fixture-assistant-workspace-tools",
		text: "I found enough synthetic workspace evidence to draft a cautious decision record. The segment priority can be described as directionally supported, while pricing should stay clearly marked as a working assumption until the next validation pass.",
	},
];

const toolActivityItems: ChatItem[] = [
	{ kind: "user", id: "fixture-user-tools", text: "Check the knowledge base and show me what tool activity looks like." },
	{ kind: "tool", id: "fixture-tool-running", name: "kb_search", args: { vault: "Strategy notes", query: "segment priority evidence" }, status: "running" },
	{ kind: "tool", id: "fixture-tool-done", name: "read", args: { path: "fixture-notes/market-summary.md" }, status: "done", result: "Found three notes that support the segment priority, but two are directional rather than conclusive." },
	{ kind: "tool", id: "fixture-tool-bash", name: "bash", args: { command: "wc -l workspace/notes/*.md" }, status: "done", result: "  42 workspace/notes/segment-priority.md\n  38 workspace/notes/pricing-confidence.md\n  51 workspace/notes/delivery-risks.md\n 131 total" },
	{ kind: "tool", id: "fixture-tool-grep", name: "grep", args: { path: "workspace/notes", pattern: "pricing" }, status: "done", result: Array.from({ length: 40 }, (_, i) => `workspace/notes/pricing-confidence.md:${i + 1}: pricing evidence line ${i + 1} for the long scrollable output state`).join("\n") },
	{ kind: "tool", id: "fixture-tool-write-doc", name: "write_markdown_file", args: { path: "workspace/planning/decision-memo.md", content: "# Decision memo\n\nDraft body…", overwrite: false }, status: "done", result: "Wrote workspace/planning/decision-memo.md (2 sections)." },
	{ kind: "tool", id: "fixture-tool-unknown", name: "summarize_meeting", args: { title: "Steering sync" }, status: "done", result: "Summary stored." },
	{ kind: "tool", id: "fixture-tool-error", name: "web_lookup", args: { query: "fixture market benchmark" }, status: "error", result: "Synthetic lookup unavailable in this fixture." },
	{
		kind: "assistant",
		id: "fixture-assistant-tools",
		text: "Two of the three assumptions are supported by internal notes. The pricing assumption remains weak and should be presented as a hypothesis.",
	},
];

const approvalItems: ChatItem[] = [
	{ kind: "user", id: "fixture-user-approval", text: "Prepare the checkpoint summary and ask me before applying it." },
	{
		kind: "approval",
		id: "fixture-approval-active",
		requestId: "fixture-approval-request",
		uiKind: "confirm",
		title: "Apply memory checkpoint?",
		message: "This fixture approval represents a human-in-the-loop decision card.",
		detail: "Title: Strategy room checkpoint\nReason: Capture decisions and open questions\nOverwrite: No",
	},
	{
		kind: "approval",
		id: "fixture-approval-resolved",
		requestId: "fixture-approval-resolved-request",
		uiKind: "select",
		title: "Choose next room action",
		message: "Resolved approval cards stay visible as part of the chat record.",
		options: ["Continue", "Rest"],
		done: "Continue",
	},
	{
		kind: "approval",
		id: "fixture-approval-delegate",
		requestId: "fixture-approval-delegate-request",
		uiKind: "confirm",
		title: "Have a specialist create a slide deck?",
		// Live delegate approvals arrive as `message` (ui.confirm's second arg).
		message: [
			"A separate specialist runs this task in isolation: no memory access, no web access, no shell.",
			"",
			"It can only write into one new folder made for this task: tasks/tsk-fixture01/ (at most 8 files). Approving starts it and grants that folder write access.",
			"",
			"The result lands on a task card. Keep it by adding it to the conversation or saving it to your workspace.",
			"",
			"─── Brief it will receive (written by the room's model; the app has not verified anything below this line) ───",
			"Task brief: Turn the Q3 roadmap notes into a six-slide deck for the steering meeting. Lead with the two decisions we need, keep one message per slide.",
		].join("\n"),
	},
];

export const inRoomChatFixtureStates: InRoomChatFixtureState[] = [
	chatFixture({
		id: "in-room-empty",
		label: "In-room / empty persistent room",
		description: "Full room shell with an empty message canvas and prompt affordance in the composer only.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · room memory ready",
		busy: false,
		usage: emptyChatUsage,
		items: [],
		inputValue: "",
		composerRightActions: [
			{ label: "Memento", title: "Forget this conversation and start fresh" },
			{ label: "Checkpoint", title: "Send a message before checkpointing", disabled: true },
		],
	}),
	chatFixture({
		id: "in-room-thinking-after-send",
		label: "In-room / thinking after send",
		description: "User message followed by the symbol-only in-stream thinking indicator before any response artifact appears.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · waiting for response",
		busy: true,
		usage: { ...emptyChatUsage, turns: 1, input: 180, totalTokens: 180 },
		items: thinkingAfterSendItems,
		inputValue: "",
		composerPlaceholder: "Working… Enter to queue",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-active-conversation",
		label: "In-room / active conversation",
		description: "Core reading surface with green under-prompt context rail: 32K tokens · 26% checkpoint.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · active thread",
		busy: false,
		usage: activeChatUsage,
		contextHealth: contextHealthGreen,
		items: activeConversationItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-context-health-yellow",
		label: "In-room / context health yellow",
		description: "Under-prompt context rail near the checkpoint threshold: 105K tokens · 84% checkpoint.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · checkpoint approaching",
		busy: false,
		usage: { ...activeChatUsage, totalTokens: 105000 },
		contextHealth: contextHealthYellow,
		items: activeConversationItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-context-health-red",
		label: "In-room / context health red",
		description: "Under-prompt context rail at checkpoint threshold: 121K tokens · 97% checkpoint.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · checkpoint recommended",
		busy: false,
		usage: { ...activeChatUsage, totalTokens: 121000 },
		contextHealth: contextHealthRed,
		items: activeConversationItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-context-health-measuring",
		label: "In-room / context health measuring",
		description: "Under-prompt context rail when exact context position is unavailable: Context measuring · checkpoint 125K.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · context measuring",
		busy: false,
		usage: emptyChatUsage,
		contextHealth: contextHealthUnknown,
		items: [],
		inputValue: "",
		composerRightActions: [
			{ label: "Memento", title: "Forget this conversation and start fresh" },
			{ label: "Checkpoint", title: "Send a message before checkpointing", disabled: true },
		],
	}),
	chatFixture({
		id: "in-room-markdown-stress",
		label: "In-room / long prompt and markdown stress",
		description: "Long user prompt plus assistant markdown stress: headings, nested lists, blockquote, inline code, long code line, horizontal rule, and a wider table.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · markdown stress state",
		busy: false,
		usage: { ...activeChatUsage, turns: 2, input: 9800, output: 2100, totalTokens: 15400 },
		items: markdownStressItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-mermaid-diagram",
		label: "In-room / Mermaid diagram",
		description: "Room answer with an inline Mermaid code fence rendered as an in-chat diagram.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · diagram rendering",
		busy: false,
		usage: { ...activeChatUsage, turns: 2, input: 7600, output: 1600, totalTokens: 12800 },
		items: mermaidDiagramItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-mermaid-repair",
		label: "In-room / Mermaid repaired",
		description: "Malformed Mermaid labels are auto-corrected for display with source disclosure.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · diagram repair",
		busy: false,
		usage: { ...activeChatUsage, turns: 2, input: 7600, output: 1600, totalTokens: 12800 },
		items: mermaidRepairItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-mermaid-broken",
		label: "In-room / Mermaid fallback",
		description: "Unrenderable Mermaid degrades to a plain code block — never a broken or blank box.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · diagram fallback",
		busy: false,
		usage: { ...activeChatUsage, turns: 2, input: 7600, output: 1600, totalTokens: 12800 },
		items: mermaidBrokenItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-mermaid-streaming",
		label: "In-room / Mermaid while streaming",
		description: "A Mermaid fence in a still-streaming message stays a code block; the diagram renders only once the message completes.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · generating",
		busy: true,
		usage: { ...activeChatUsage, turns: 2, input: 7600, output: 1600, totalTokens: 12800 },
		items: mermaidStreamingItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-folded-user-prompt",
		label: "In-room / folded long user prompt",
		description: "Dedicated state for a pasted multiline user prompt that folds locally with Show more / Show less.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · folded prompt coverage",
		busy: false,
		usage: { ...activeChatUsage, turns: 2, input: 11200, output: 900, totalTokens: 13400 },
		items: foldedUserPromptItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-streaming-busy",
		label: "In-room / streaming busy",
		description: "Busy header, streaming assistant item, and composer placeholder coverage.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · generating",
		busy: true,
		usage: { ...activeChatUsage, turns: 5, input: 14300, output: 3600, totalTokens: 23800 },
		items: streamingItems,
		inputValue: "Follow-up while it works",
		composerPlaceholder: "Working… Enter to queue",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-workspace-tool-stack",
		label: "In-room / workspace tool stack",
		description: "Several consecutive successful ls/find/read chips followed by the final assistant answer.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · workspace tools",
		busy: false,
		usage: { ...activeChatUsage, turns: 3, input: 16200, output: 2400, totalTokens: 21100 },
		items: workspaceToolStackItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-tool-activity",
		label: "In-room / tool activity",
		description: "Running, done, and error tool chips inside a persistent room, including human tool labels, an unknown-tool fallback, and a long scrollable output.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · tool activity",
		busy: false,
		usage: { ...activeChatUsage, turns: 6, input: 18200, output: 5200, totalTokens: 28100 },
		items: toolActivityItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-approval-request",
		label: "In-room / approval request",
		description: "Active and resolved human-in-the-loop approval cards with inert fixture callbacks.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · approval pending",
		busy: false,
		usage: { ...activeChatUsage, turns: 3, input: 8700, output: 1800, totalTokens: 12600 },
		items: approvalItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
	chatFixture({
		id: "in-room-sidebar-context",
		label: "In-room / persistent-room sidebar context",
		description: "Current persistent-room sidebar baseline with Home anchor.",
		activeDisplay: "Strategy Room",
		ownerSecondary: "Persistent room · sidebar hierarchy visible",
		busy: false,
		usage: activeChatUsage,
		items: activeConversationItems,
		inputValue: "",
		composerRightActions: [{ label: "Memento" }, { label: "Checkpoint" }],
	}),
];

export const taskCardsFixtureStates: TaskCardsFixtureState[] = [
	{
		kind: "task-cards",
		id: "task-cards",
		label: "Specialist / task cards",
		description: "The delegation family beside the chat: running, done, stopped, and the kept thread item.",
	},
];

export const fixtureStates: FixtureState[] = [...sidebarFixtureStates, ...homeFixtureStates, ...createRoomFixtureStates, ...inRoomChatFixtureStates, ...taskCardsFixtureStates];
