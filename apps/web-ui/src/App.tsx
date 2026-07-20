import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Sidebar } from "./components/Sidebar";
import { AssetsPanel } from "./components/assets-panel";
import { AssetViewerFooter } from "./components/asset-viewer-footer";
import { assetDisplayTitle, assetTemplateShortName, projectAssetRows, type AssetLedgerRowInput, type AssetRowView } from "./assets-panel";
import { Dashboard } from "./components/Dashboard";
import { Memory } from "./components/Memory";
import { InRoomChatShellView } from "./components/in-room-chat";
import { CreateRoomPanel } from "./components/create-room-panel";
import { useEscapeKey } from "./components/use-escape-key";
import { PersistentAgentCard } from "./components/launcher-room-card";
import { firstWordOfLabel, ProductSidebar, strandedBySwitchCount, type ThemeMode } from "./components/product-shell";
import { ConnectorsPage } from "./components/ConnectorsPage";
import { SkillsPage } from "./components/SkillsPage";
import { Preview } from "./components/Preview";
import { Help } from "./components/Help";
import { MarkdownRenderer } from "./components/Markdown";
import { RoomsGuide } from "./components/RoomsGuide";
import { RoomSettingsModal } from "./components/RoomSettingsModal";
import { AddProviderPanel, ApiKeyForm, ConfigureProfileModal, GatewayApproveModelsModal, GatewayConfigModal, useProviderLogin } from "./components/add-provider-panel";
import { apiFetch, fetchJson } from "./api";
import { modelDisplayName as canonicalModelDisplayName } from "./model-names";
import type { ApprovalPreviewData } from "./approval-preview";
import type { AbsorbApprovalResponse, AbsorbAssessmentResponse, AbsorbAvailability, AbsorbDiscussionMessage, AbsorbDiscussionSignoffResponse, AbsorbDiscussionTokenBudget, AbsorbDiscussionTurnResponse, AbsorbProposalResponse, AbsorbProposalSourceMetadata, AbsorbReviewAction, AbsorbReviewEntryChange, AbsorbReviewSectionChange, AuthStatusResponse, ChatItem, CheckpointApprovalResponse, CheckpointProposalResponse, ContextHealthStatus, LoginProviderCatalogEntry, PersistentAgentAiProfileSelectionStatus, PersistentAgentAiProfileStatus, PersistentAgentArchiveResponse, PersistentAgentCreateRequest, PersistentAgentCreateResponse, PersistentAgentId, PersistentAgentMementoBoundaryResponse, PersistentAgentStatus, PersistentAgentThreadOrigin, PersistentAgentThreadRecord, StructuralReviewApprovalResponse, StructuralReviewAssessmentResponse, StructuralReviewAvailability, StructuralReviewDiscussionMessage, StructuralReviewDiscussionSignoffResponse, StructuralReviewDiscussionTokenBudget, StructuralReviewDiscussionTurnResponse, StructuralReviewMemoryMapRow, StructuralReviewProposalResponse, StructuralReviewSourceMetadata, WebChatModelOption, WebChatModelStatus } from "./types";
import { archivePersistentRoom, fetchPersistentRoomMaintenanceSettings } from "./persistent-room-management-api";
import { createAssistantStreamState, DEFAULT_REVEAL_PACING, isAssistantStreamActive, reduceAssistantStream, type AssistantStreamAction, type AssistantStreamEffect, type AssistantStreamState, type RevealPacing } from "./assistant-stream";
import { consultStack, createConsultState, reduceConsult, type ConsultAction, type ConsultExchange, type ConsultState } from "./consult-stream";
import { createTaskState, reduceTask, type TaskAction, type TaskState } from "./task-stream";
import { ConsultDock } from "./components/delegation-card";
import { TaskRunView } from "./components/task-run-view";
import { ArtifactViewer } from "./components/ArtifactViewer";
// The handoff grammar + queue helpers are the ONE shared source of truth, imported
// straight from the server workspace's pure module (no node/server deps; vite
// bundles it) so transfer here and the checkpoint formatter there agree exactly.
import { buildConsultHandoffBlockFromStack, composeOutgoingPromptWithHandoffs, readConsultHandoffQueue, type ConsultHandoffExchange } from "../../web-server/src/consult-handoff";
import { buildSpecialistHandoffBlock } from "../../web-server/src/specialist-handoff";
import type { MentionCandidateRoom } from "./mention-popover";

type MainView = "home" | "chat" | "dashboard" | "ai-setup" | "connectors" | "memory" | "skills";
type CheckpointDensity = "compact" | "standard" | "rich";
type AbsorbWorkflowStep = "closed" | "checking" | "assessing" | "assessment" | "discussing" | "signing_off" | "proposing" | "proposal" | "approving" | "saved" | "unavailable" | "error";
type StructuralReviewWorkflowStep = "closed" | "checking" | "assessing" | "assessment" | "discussing" | "signing_off" | "proposing" | "proposal" | "approving" | "saved" | "unavailable" | "error";
type AbsorbWorkflowState = {
	step: AbsorbWorkflowStep;
	target: MaintainTarget | null;
	availability: AbsorbAvailability | null;
	assessment: AbsorbAssessmentResponse | null;
	proposal: AbsorbProposalResponse | null;
	approvalResult: AbsorbApprovalResponse | null;
	discussionMessages?: AbsorbDiscussionMessage[];
	discussionTokenBudget?: AbsorbDiscussionTokenBudget | null;
	discussionSending?: boolean;
	// Non-fatal server notes from a successful turn; rendered amber, never red.
	discussionWarnings?: string | null;
	assessmentHandoff?: AbsorbDiscussionSignoffResponse["assessmentHandoff"] | null;
	// Room setting known up front so automation is disclosed BEFORE the write,
	// not after (the flow otherwise promises "nothing is saved yet").
	fastPathEnabled?: boolean;
	fastPathApplied?: boolean;
	fastPathBlockedReasons?: string[];
	// Approval failed because memory changed underneath: the shown proposal can
	// no longer be applied, so the approve action is disarmed until a redraft.
	proposalStale?: boolean;
	error: string | null;
};

const CLOSED_ABSORB_WORKFLOW: AbsorbWorkflowState = {
	step: "closed",
	target: null,
	availability: null,
	assessment: null,
	proposal: null,
	approvalResult: null,
	error: null,
};

type StructuralReviewWorkflowState = {
	step: StructuralReviewWorkflowStep;
	target: MaintainTarget | null;
	availability: StructuralReviewAvailability | null;
	assessment: StructuralReviewAssessmentResponse | null;
	proposal: StructuralReviewProposalResponse | null;
	approvalResult: StructuralReviewApprovalResponse | null;
	discussionMessages?: StructuralReviewDiscussionMessage[];
	discussionTokenBudget?: StructuralReviewDiscussionTokenBudget | null;
	discussionSending?: boolean;
	// Non-fatal server notes from a successful turn; rendered amber, never red.
	discussionWarnings?: string | null;
	assessmentHandoff?: StructuralReviewDiscussionSignoffResponse["assessmentHandoff"] | null;
	// Room setting known up front so automation is disclosed BEFORE the write,
	// not after (the flow otherwise promises "nothing is saved yet").
	fastPathEnabled?: boolean;
	fastPathApplied?: boolean;
	fastPathBlockedReasons?: string[];
	// Approval failed because memory changed underneath: the shown proposal can
	// no longer be applied, so the approve action is disarmed until a redraft.
	proposalStale?: boolean;
	error: string | null;
};

const CLOSED_STRUCTURAL_REVIEW_WORKFLOW: StructuralReviewWorkflowState = {
	step: "closed",
	target: null,
	availability: null,
	assessment: null,
	proposal: null,
	approvalResult: null,
	error: null,
};

function meaningfulMaintenanceWarnings(warnings: string[]): string[] {
	return warnings.filter((warning) => !/no memory has been written/i.test(warning));
}

// The worker's free-form Warnings section usually carries mild hedges
// ("word counts are approximate"), so it is shown, not gating. Used to decide
// whether the saved screen displays worker notes after an auto-apply.
function maintenanceWorkerNotes(warningsField: string): string {
	const normalized = warningsField.replace(/^[\s\-*•]+/, "").replace(/[\s.]+$/, "").trim().toLowerCase();
	const noneLike = !normalized
		|| normalized === "none"
		|| normalized === "none detected"
		|| normalized === "none noted"
		|| normalized === "none, or concise uncertainty flags";
	return noneLike ? "" : warningsField.trim();
}

// Fast-path gate: structural/deterministic problems block, and so does any
// mention of must-keep memory in the worker's Warnings section — that is the
// vocabulary the maintenance constitutions require when protected memory is
// touched. Free-form hedges do not block; they surface as worker notes.
function maintenanceFastPathBlockers(proposal: { candidateValidation: { valid: boolean; warnings: string[] }; warnings: string[]; fields: { warnings: string } }): string[] {
	const blockers: string[] = [];
	if (!proposal.candidateValidation.valid) blockers.push("the candidate memory failed validation");
	blockers.push(...proposal.candidateValidation.warnings);
	blockers.push(...meaningfulMaintenanceWarnings(proposal.warnings));
	if (/must.?keep/i.test(proposal.fields.warnings)) {
		const text = proposal.fields.warnings.trim();
		blockers.push(`the proposal's Warnings section mentions must-keep memory: "${text.length > 220 ? `${text.slice(0, 220)}…` : text}"`);
	}
	return blockers;
}

// The transcript-elision notice (checkpoint-compression.ts) is a quality
// hedge, not a defect: it fires on long tool-heavy sessions — exactly where
// the one-click path matters most — elision never touches the user's own
// messages, and the entry lands in Recent Context where Learn re-reviews it.
// So it is disclosed on the saved line instead of forcing the full preview.
function isTranscriptElisionWarning(warning: string): boolean {
	return /trimmed to fit the compression budget/i.test(warning);
}

// Quick-checkpoint gate (same shape as the maintenance fast path): only
// deterministic problems block — parse warnings from the worker, or an
// incomplete proposal. The server stamps every propose response with the
// informational "no memory has been written" line; that is status, not a
// problem, so it is filtered out like the maintenance gate does. The
// transcript-elision notice does not block either — the user chose the
// no-preview path — it is appended to the saved system line instead.
// Anything blocked falls back to the full preview with the reasons named.
function quickCheckpointBlockers(proposal: CheckpointProposalResponse): string[] {
	const blockers: string[] = meaningfulMaintenanceWarnings(proposal.warnings).filter((warning) => !isTranscriptElisionWarning(warning));
	if (!proposal.fields.sessionArc.trim()) blockers.push("the proposal is missing its session arc");
	if (!proposal.fields.body.trim()) blockers.push("the proposal is missing its body");
	return blockers;
}

const CHECKPOINT_REMEMBER_MAX_CHARS = 500;
const ABSORB_WAITING_MESSAGES = [
	"Absorbing wisdom…",
	"Meditating on recent sessions…",
	"Letting the lessons settle…",
	"Filing memories where they belong…",
	"Distilling what mattered…",
	"Choosing what to carry forward…",
	"Turning sessions into knowledge…",
	"Beepbopping memory…",
];
const STRUCTURAL_REVIEW_WAITING_MESSAGES = [
	"Finding dense signal…",
	"Pruning the bonsai…",
	"Weighing every memory…",
	"Folding duplicates together…",
	"Tightening the threads…",
	"Checking what still rings true…",
	"Letting go of the stale bits…",
	"Polishing what stays…",
];
const STRUCTURAL_REVIEW_LOADING_MESSAGES = [
	"Reviewing deep memory…",
	"Reading the memory map…",
	"Walking the archive shelves…",
	"Looking for stale threads…",
	"Measuring density and drift…",
	"Listening for what still matters…",
];
const ABSORB_LOADING_MESSAGES = [
	"Connecting to the Matrix…",
	"Inferencing really hard…",
	"Listening for memory signal…",
	"Sorting signal from glitter…",
	"Compressing the universe gently…",
	"Asking the neurons to focus…",
	"Untangling recent sessions…",
	"Finding the good bits…",
	"Meditating on what happened…",
	"Rereading the recent chapters…",
	"Looking for lessons worth keeping…",
	"Dusting off the archive shelves…",
];
const CHECKPOINT_DENSITY_OPTIONS: Array<{ id: CheckpointDensity; label: string; budget: string }> = [
	{ id: "compact", label: "Compact", budget: "Just the essentials" },
	{ id: "standard", label: "Standard", budget: "The decisions and threads that matter" },
	{ id: "rich", label: "Rich", budget: "A fuller record of the session" },
];
type PersistentAgentThread = {
	state: "live" | "standby";
	agentId: PersistentAgentId;
	displayName: string;
	conversationId: string;
	model: WebChatModelOption;
	items: ChatItem[];
};
type PersistentAgentTarget = { id: PersistentAgentId; displayName?: string };
type MaintainTarget = { agentId: PersistentAgentId; displayName: string };
type PersistentChatConfig = Pick<PersistentAgentThread, "agentId" | "displayName" | "conversationId" | "model"> | null;

interface SessionUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens: number;
}

function threadRecordToLocalThread(record: PersistentAgentThreadRecord, fallbackDisplayName = "Persistent room"): PersistentAgentThread {
	if (record.state === "closed") throw new Error("This room thread is closed and cannot be resumed.");
	const model: WebChatModelOption = { provider: record.model.provider, model: record.model.model, label: record.model.label || `${record.model.provider}/${record.model.model}` };
	return {
		state: record.state === "active" ? "live" : "standby",
		agentId: record.agentId,
		displayName: fallbackDisplayName,
		conversationId: record.threadId,
		model,
		items: Array.isArray(record.items) ? record.items as ChatItem[] : [],
	};
}

// Consult MR-5: reconstruct which consult items still show the pending hint when
// a thread is restored — the `count` most recent consult items in the transcript,
// since each un-consumed transfer contributes exactly one queued block and one
// (trailing) consult item.
function deriveTrailingConsultIds(items: ChatItem[], count: number): Set<string> {
	const ids = new Set<string>();
	if (count <= 0) return ids;
	for (let i = items.length - 1; i >= 0 && ids.size < count; i--) {
		const item = items[i];
		if (item.kind === "consult") ids.add(item.id);
	}
	return ids;
}

const ZERO_USAGE: SessionUsage = {
	turns: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	totalTokens: 0,
};

let __nextId = 1;
const nid = () => `i_${Date.now().toString(36)}_${__nextId++}_${Math.random().toString(36).slice(2, 7)}`;

// The reveal band is a taste knob, not physics: `localStorage.setItem(
// "exxperts.revealSpeed", "brisk" | "instant")` overrides the default
// reading-speed band without a rebuild (reload to apply). Cached — useRef
// initializer expressions run on every render and this reads localStorage.
let cachedRevealPacing: RevealPacing | null = null;
function readRevealPacing(): RevealPacing {
	if (cachedRevealPacing) return cachedRevealPacing;
	cachedRevealPacing = DEFAULT_REVEAL_PACING;
	try {
		const value = localStorage.getItem("exxperts.revealSpeed");
		if (value === "brisk") cachedRevealPacing = { ...DEFAULT_REVEAL_PACING, minCharsPerSec: 90, maxCharsPerSec: 150 };
		if (value === "instant") cachedRevealPacing = { ...DEFAULT_REVEAL_PACING, minCharsPerSec: 1e6, maxCharsPerSec: 1e6 };
	} catch {}
	return cachedRevealPacing;
}
const newConversationId = () => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
const DIRECT_RESUME_INCOMPATIBLE_MODEL_MESSAGE = "This standby thread is locked to a model that is not available in the active AI profile. Select a compatible AI profile to resume it.";

function formatDirectResumeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error ?? "");
	if (/model is not approved/i.test(message)) return DIRECT_RESUME_INCOMPATIBLE_MODEL_MESSAGE;
	return message || "Could not resume this standby thread.";
}

function hasUserInput(items: ChatItem[]): boolean {
	return items.some((item) => item.kind === "user" && item.text.trim().length > 0);
}

function hasUserVisibleTurn(items: ChatItem[]): boolean {
	return items.some((item) => (item.kind === "user" || item.kind === "assistant") && item.text.trim().length > 0);
}
// A stored width means the user dragged the divider. The old key also captured
// auto-persisted defaults, which would mask the equal-split open size forever,
// so the key is bumped once instead of migrating those values.
const KNOWLEDGE_PANE_WIDTH_STORAGE_KEY = "exxperts.rightPane.width";
const RIGHT_PANE_MIN_WIDTH = 360;
// Keep at least this much of the workbench for the chat column when the pane
// grows; without it a wide pane can squeeze the chat (a 1fr track) to zero.
const RIGHT_PANE_MIN_CHAT_WIDTH = 360;
const RIGHT_PANE_RESIZER_WIDTH = 8;

function getRightPaneMaxWidth(hostWidth?: number) {
	// Clamp against the workbench (chat + divider + pane) when we can measure
	// it; the window is only a bootstrap fallback (initial state, no ref yet).
	if (typeof hostWidth === "number" && hostWidth > 0) {
		return Math.floor(hostWidth - RIGHT_PANE_RESIZER_WIDTH - RIGHT_PANE_MIN_CHAT_WIDTH);
	}
	if (typeof window === "undefined") return 820;
	return Math.floor(window.innerWidth * 0.7);
}

function clampRightPaneWidth(width: number, hostWidth?: number) {
	const max = Math.max(RIGHT_PANE_MIN_WIDTH, getRightPaneMaxWidth(hostWidth));
	return Math.max(RIGHT_PANE_MIN_WIDTH, Math.min(max, Math.round(width)));
}

function getDefaultKnowledgePaneWidth() {
	if (typeof window === "undefined") return 520;
	return clampRightPaneWidth(window.innerWidth * 0.5);
}

function equalSplitPaneWidth(hostWidth?: number) {
	// The pane opens sharing the workbench with the chat half and half; the
	// sidebar sits outside the workbench, so this splits what they share.
	if (typeof hostWidth === "number" && hostWidth > 0) {
		return clampRightPaneWidth(Math.floor((hostWidth - RIGHT_PANE_RESIZER_WIDTH) / 2), hostWidth);
	}
	return getDefaultKnowledgePaneWidth();
}

function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return (n / 1000).toFixed(1) + "k";
	if (n < 1_000_000) return Math.round(n / 1000) + "k";
	return (n / 1_000_000).toFixed(1) + "M";
}
function fmtCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return "<$0.01";
	return "$" + n.toFixed(2);
}

function authSourceLabel(source?: AuthStatusResponse["providers"][number]["source"], label?: string): string {
	if (source === "stored") return "stored locally";
	if (source === "environment") return `environment variable${label ? `: ${label}` : ""}`;
	if (source === "runtime") return label || "runtime override";
	if (source === "fallback") return label || "custom provider config";
	if (source === "models_json_key" || source === "models_json_command") return label || "models.json";
	return "not connected";
}

function persistentRoomModels(status: WebChatModelStatus | null): WebChatModelOption[] {
	return status?.roomModels?.length ? status.roomModels : status?.models ?? [];
}

function persistentRoomRecommended(status: WebChatModelStatus | null): WebChatModelOption | undefined {
	return status?.roomRecommended ?? persistentRoomModels(status)[0];
}

function homeAiProfileStatus(modelStatus: WebChatModelStatus | null, aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null): { message: string; ready: boolean | undefined } | null {
	if (!modelStatus && !aiProfileStatus) return null;
	const configured = aiProfileStatus ? aiProfileStatus.state.source !== "default" : true;
	if (!configured) return { message: "AI setup needed", ready: false };
	const activeProfile = aiProfileStatus?.activeProfile;
	const ready = activeProfile ? activeProfile.ready : modelStatus?.ready;
	// Name the broken profile only when it is specifically the problem; with
	// nothing signed in at all the honest message is provider-neutral.
	const anySignedIn = aiProfileStatus?.profiles?.some((profile) => profile.provider.configured) ?? true;
	if (!anySignedIn) return { message: "AI setup needed", ready };
	const label = modelStatus?.activeProfileLabel || activeProfile?.label || "AI profile";
	return { message: `${label} setup needed`, ready };
}

function compactDateTime(value: string | null | undefined): string {
	if (!value) return "none yet";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const now = new Date();
	const sameDay = date.toDateString() === now.toDateString();
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (sameDay) return `today ${time}`;
	if (date.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function memoryLevelLabel(level: PersistentAgentStatus["memoryStatus"]["recentContextLevel"]): string {
	if (level === "hard_cap") return "hard cap reached";
	if (level === "at_soft_cap") return "soft cap reached";
	if (level === "approaching_soft_cap") return "consolidation soon";
	if (level === "empty") return "empty";
	return "healthy";
}

function fetchPersistentAgentStatuses(): Promise<PersistentAgentStatus[]> {
	return fetchJson<PersistentAgentStatus[]>("/api/persistent-agents");
}

function createPersistentAgent(request: PersistentAgentCreateRequest): Promise<PersistentAgentCreateResponse> {
	return fetchJson<PersistentAgentCreateResponse>("/api/persistent-agents", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
}

function absorbBaseUrl(agentId: PersistentAgentId): string {
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/absorb`;
}

function fetchAbsorbStatus(agentId: PersistentAgentId): Promise<AbsorbAvailability> {
	return fetchJson<AbsorbAvailability>(`${absorbBaseUrl(agentId)}/status`);
}

function requestAbsorbAssessment(agentId: PersistentAgentId): Promise<AbsorbAssessmentResponse> {
	return fetchJson<AbsorbAssessmentResponse>(`${absorbBaseUrl(agentId)}/assess`, { method: "POST" });
}

function requestAbsorbProposal(agentId: PersistentAgentId, assessmentMarkdown: string, options?: { assessmentHandoff?: AbsorbDiscussionSignoffResponse["assessmentHandoff"]; source?: AbsorbProposalSourceMetadata }): Promise<AbsorbProposalResponse> {
	return fetchJson<AbsorbProposalResponse>(`${absorbBaseUrl(agentId)}/propose`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ assessmentMarkdown, ...(options?.assessmentHandoff ? { assessmentHandoff: options.assessmentHandoff } : {}), ...(options?.source ? { source: options.source } : {}) }),
	});
}

function requestAbsorbDiscussionTurn(agentId: PersistentAgentId, request: { source: AbsorbProposalSourceMetadata; assessmentMarkdown: string; messages: AbsorbDiscussionMessage[]; userMessage: string }): Promise<AbsorbDiscussionTurnResponse> {
	return fetchJson<AbsorbDiscussionTurnResponse>(`${absorbBaseUrl(agentId)}/discuss`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
}

function requestAbsorbDiscussionSignoff(agentId: PersistentAgentId, request: { source: AbsorbProposalSourceMetadata; assessmentMarkdown: string; messages: AbsorbDiscussionMessage[]; userMessage?: string }): Promise<AbsorbDiscussionSignoffResponse> {
	return fetchJson<AbsorbDiscussionSignoffResponse>(`${absorbBaseUrl(agentId)}/discuss/signoff`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
}

function requestAbsorbApproval(agentId: PersistentAgentId, proposal: AbsorbProposalResponse): Promise<AbsorbApprovalResponse> {
	return fetchJson<AbsorbApprovalResponse>(`${absorbBaseUrl(agentId)}/approve`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ proposal, approvedCandidateL1b: proposal.fields.candidateL1b }),
	});
}

function structuralReviewBaseUrl(agentId: PersistentAgentId): string {
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/structural-review`;
}

function fetchStructuralReviewStatus(agentId: PersistentAgentId): Promise<StructuralReviewAvailability> {
	return fetchJson<StructuralReviewAvailability>(`${structuralReviewBaseUrl(agentId)}/status`);
}

function requestStructuralReviewAssessment(agentId: PersistentAgentId): Promise<StructuralReviewAssessmentResponse> {
	return fetchJson<StructuralReviewAssessmentResponse>(`${structuralReviewBaseUrl(agentId)}/assess`, { method: "POST" });
}

function requestStructuralReviewProposal(agentId: PersistentAgentId, assessmentMarkdown: string, options?: { assessmentHandoff?: StructuralReviewDiscussionSignoffResponse["assessmentHandoff"]; source?: StructuralReviewSourceMetadata }): Promise<StructuralReviewProposalResponse> {
	return fetchJson<StructuralReviewProposalResponse>(`${structuralReviewBaseUrl(agentId)}/propose`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ assessmentMarkdown, ...(options?.assessmentHandoff ? { assessmentHandoff: options.assessmentHandoff } : {}), ...(options?.source ? { source: options.source } : {}) }),
	});
}

function requestStructuralReviewDiscussionTurn(agentId: PersistentAgentId, request: { source: StructuralReviewSourceMetadata; assessmentMarkdown: string; messages: StructuralReviewDiscussionMessage[]; userMessage: string }): Promise<StructuralReviewDiscussionTurnResponse> {
	return fetchJson<StructuralReviewDiscussionTurnResponse>(`${structuralReviewBaseUrl(agentId)}/discuss`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
}

function requestStructuralReviewDiscussionSignoff(agentId: PersistentAgentId, request: { source: StructuralReviewSourceMetadata; assessmentMarkdown: string; messages: StructuralReviewDiscussionMessage[]; userMessage?: string }): Promise<StructuralReviewDiscussionSignoffResponse> {
	return fetchJson<StructuralReviewDiscussionSignoffResponse>(`${structuralReviewBaseUrl(agentId)}/discuss/signoff`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
}

function requestStructuralReviewApproval(agentId: PersistentAgentId, proposal: StructuralReviewProposalResponse): Promise<StructuralReviewApprovalResponse> {
	return fetchJson<StructuralReviewApprovalResponse>(`${structuralReviewBaseUrl(agentId)}/approve`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ proposal, approvedCandidateReviewTargetL1b: proposal.fields.candidateReviewTargetL1b }),
	});
}

// Registry labels look like "Anthropic / Claude — Opus 4.8"; canonicalise to
// the display-wide model name ("Claude Opus 4.8") via the shared module.
function modelDisplayName(model: { label?: string; model: string; provider?: string }): string {
	return canonicalModelDisplayName({ model: model.model, modelLabel: model.label, provider: model.provider }) || model.model;
}

// The per-profile model catalog, in product vocabulary: the room-model choices,
// plus the fixed models behind Learn (absorb) and Review Memory (structural review).
function AiProfileModelsDetail({ profile }: { profile: PersistentAgentAiProfileStatus }) {
	const roomModels = profile.processes?.persistentRoom.models ?? [];
	const forPurpose = (token: string) => profile.requiredModels.filter((model) => (model.purpose ?? "").split("/").includes(token)).map(modelDisplayName);
	const learnModels = forPurpose("absorb");
	const reviewModels = forPurpose("structural-review");
	return (
		<div className="ai-profile-models" role="presentation">
			<div className="ai-profile-models-row"><span>Rooms</span><span>{roomModels.map(modelDisplayName).join(", ") || "no room models listed"}</span></div>
			{learnModels.length > 0 && <div className="ai-profile-models-row"><span>Learn</span><span>{learnModels.join(", ")}</span></div>}
			{reviewModels.length > 0 && <div className="ai-profile-models-row"><span>Review Memory</span><span>{reviewModels.join(", ")}</span></div>}
			<div className="ai-profile-models-row"><span>Connection</span><span>{profile.provider.configured ? `signed in · ${authSourceLabel(profile.provider.source, profile.provider.label)}` : "not signed in"}</span></div>
		</div>
	);
}

function AiProfileSwitcherSection({ status, onSelect, onRefresh, onRefreshAuth, standbyLockedModels }: { status: PersistentAgentAiProfileSelectionStatus | null; onSelect: (profileId: string) => Promise<void>; onRefresh: () => void; onRefreshAuth: () => void; standbyLockedModels?: Array<{ provider: string; model: string }> }) {
	const [switchingId, setSwitchingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [modelsOpenId, setModelsOpenId] = useState<string | null>(null);
	const [editProfile, setEditProfile] = useState<PersistentAgentAiProfileStatus | null>(null);
	const [gatewayEditOpen, setGatewayEditOpen] = useState(false);
	const [gatewayApproveOpen, setGatewayApproveOpen] = useState(false);
	const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
	const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
	const [removing, setRemoving] = useState(false);
	const [keyProfileId, setKeyProfileId] = useState<string | null>(null);
	const [loginCatalog, setLoginCatalog] = useState<LoginProviderCatalogEntry[] | null>(null);
	const notConfigured = status ? status.state.source === "default" : false;

	// Refetched when the profile SET changes (not on every status refresh):
	// setting up a gateway or custom provider adds catalog entries the
	// auth-type lookup must know about.
	const profileSetKey = status?.profiles.map((profile) => profile.id).join(",") ?? "";
	useEffect(() => {
		fetchJson<{ providers: LoginProviderCatalogEntry[] }>("/api/auth/providers")
			.then((result) => setLoginCatalog(result.providers))
			.catch(() => {});
	}, [profileSetKey]);

	// OAuth is the default when the catalog has not loaded — that keeps the
	// built-in subscription rows' labels sensible even if the lookup fails.
	function providerUsesOAuth(providerId: string): boolean {
		const entry = loginCatalog?.find((provider) => provider.id === providerId);
		return entry ? entry.authTypes.includes("oauth") : true;
	}

	function providerAcceptsApiKey(providerId: string): boolean {
		const entry = loginCatalog?.find((provider) => provider.id === providerId);
		return entry?.authTypes.includes("api_key") ?? false;
	}

	// Browser sign-in shares the same state machine as the Add-provider panel
	// (URL + device-code instructions + 2s polling live in useProviderLogin).
	// API-key providers (OpenAI-compatible gateways, custom providers) get an
	// inline key form instead.
	const login = useProviderLogin(() => {
		onRefresh();
		onRefreshAuth();
	});

	async function signIn(profile: PersistentAgentAiProfileStatus) {
		setError(null);
		// Resolve the auth type from the live catalog even when the initial
		// fetch has not landed yet, so API-key providers are never misrouted
		// into the OAuth flow.
		let catalog = loginCatalog;
		if (!catalog) {
			try {
				catalog = (await fetchJson<{ providers: LoginProviderCatalogEntry[] }>("/api/auth/providers")).providers;
				setLoginCatalog(catalog);
			} catch {}
		}
		const entry = catalog?.find((provider) => provider.id === profile.provider.id);
		if (entry && !entry.authTypes.includes("oauth")) {
			setKeyProfileId(keyProfileId === profile.id ? null : profile.id);
			return;
		}
		await login.signIn(profile.provider.id);
	}

	async function saveApiKey(profile: PersistentAgentAiProfileStatus, key: string) {
		setError(null);
		try {
			await fetchJson("/api/auth/api-key", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: profile.provider.id, key }),
			});
			setKeyProfileId(null);
			onRefresh();
			onRefreshAuth();
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function signOut(profile: PersistentAgentAiProfileStatus) {
		setError(null);
		try {
			await fetchJson("/api/auth/logout", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: profile.provider.id }),
			});
			onRefresh();
			onRefreshAuth();
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function selectProfile(profileId: string) {
		setSwitchingId(profileId);
		setError(null);
		try {
			await onSelect(profileId);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSwitchingId(null);
		}
	}
	function closeMenu() {
		setMenuOpenId(null);
		setConfirmRemoveId(null);
	}
	useEscapeKey(closeMenu, menuOpenId !== null);
	// Resetting a built-in override restores the curated catalog; the provider
	// stays signed in.
	async function resetBuiltInModels(profile: PersistentAgentAiProfileStatus) {
		setError(null);
		try {
			await fetchJson(`/api/persistent-agent-ai-profiles/custom/${encodeURIComponent(`custom-${profile.provider.id}`)}`, { method: "DELETE" });
			onRefresh();
			onRefreshAuth();
		} catch (e) {
			setError((e as Error).message);
		}
	}
	// Removing a provider disconnects it: profile, approved models, and the
	// stored credential all go. Built-ins cannot be removed, only signed out.
	async function removeProfile(profile: PersistentAgentAiProfileStatus) {
		setRemoving(true);
		setError(null);
		try {
			const url = profile.kind === "gateway"
				? "/api/persistent-agent-ai-profiles/openai-compatible"
				: `/api/persistent-agent-ai-profiles/custom/${encodeURIComponent(profile.id)}`;
			await fetchJson(url, { method: "DELETE" });
			closeMenu();
			onRefresh();
			onRefreshAuth();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setRemoving(false);
		}
	}
	return (
		<section className="ai-setup-section ai-profile-switcher-section" aria-label="AI profile selection">
			{status ? (
				status.profiles.length > 0 ? (
					<div className="ai-profile-card" role="radiogroup" aria-label="AI profile">
						{status.profiles.map((profile) => {
							const roomModelCount = profile.processes?.persistentRoom.models.length ?? 0;
							const roomModelsLabel = `${roomModelCount} room model${roomModelCount === 1 ? "" : "s"}`;
							const strandedCount = strandedBySwitchCount(standbyLockedModels, status.activeProfile, profile);
							const signingIn = login.signingInProvider === profile.provider.id;
							// One quiet subline per row, describing the row's own state — the same
							// state reads the same on every row, active or not. "Setup needed" is
							// reserved for signed-in-but-still-broken; the strand warning swaps in
							// on hover, at the moment of decision (same rules as the settings menu).
							const notSignedInText = roomModelCount > 0 ? `not signed in · ${roomModelsLabel}` : "not signed in";
							const subline = switchingId === profile.id
								? "selecting…"
								: signingIn
									? "finish signing in in your browser…"
									: profile.ready
										? profile.active && notConfigured ? "default" : "signed in"
										: profile.provider.configured
											? "setup needed"
											: notSignedInText;
							// A selection that cannot run is not presented as one: the dot only
							// shows when the active profile is actually signed in.
							const presentedActive = profile.active && profile.provider.configured;
							const sublineWarn = !signingIn && presentedActive && !notConfigured && !profile.ready;
							const strandWarning = strandedCount > 0 && profile.ready && !profile.active && switchingId === null
								? `${strandedCount} standby room${strandedCount === 1 ? "" : "s"} can only resume on ${firstWordOfLabel(status.activeProfile.label)}`
								: null;
							const modelsOpen = modelsOpenId === profile.id;
							const title = !profile.ready
								? "Sign in to this profile before using it"
								: profile.active
									? undefined
									: "Select this AI profile. New room threads start on it; standby threads keep their model";
							return (
								<div key={profile.id} className={`ai-profile-row-group${modelsOpen ? " open" : ""}`}>
									<div
										className={`ai-profile-row${presentedActive ? " active" : ""}${profile.ready ? "" : " notready"}${strandWarning ? " has-strand" : ""}`}
										role="radio"
										aria-checked={presentedActive}
										aria-disabled={!profile.ready || undefined}
										tabIndex={profile.ready ? 0 : -1}
										title={title}
										onClick={() => {
											// Unready rows are inert; only the Sign in button starts a sign-in.
											if (!profile.ready || switchingId !== null || login.signingInProvider !== null) return;
											if (!profile.active) void selectProfile(profile.id);
										}}
										onKeyDown={(e) => {
											if (e.key !== "Enter" && e.key !== " ") return;
											e.preventDefault();
											(e.currentTarget as HTMLElement).click();
										}}
									>
										<span className="ai-profile-radio" aria-hidden="true" />
										<span className="ai-profile-text">
											<span className="ai-profile-name">{profile.label}</span>
											<span className={`ai-profile-sub sub-default${sublineWarn ? " warn" : ""}`}>{subline}</span>
											{strandWarning && <span className="ai-profile-sub sub-strand warn">{strandWarning}</span>}
										</span>
										<span className="ai-profile-side" onClick={(e) => e.stopPropagation()}>
											{roomModelCount > 0 && (
												<button
													className="ai-profile-models-toggle"
													aria-expanded={modelsOpen}
													onClick={() => setModelsOpenId(modelsOpen ? null : profile.id)}
												>
													{roomModelsLabel} {modelsOpen ? "▴" : "▾"}
												</button>
											)}
											{signingIn ? (
												<button className="ai-profile-foot-link" onClick={() => void login.cancel()}>Cancel</button>
											) : (
												<>
													{!profile.ready && (
														keyProfileId === profile.id ? (
															<button className="ai-profile-foot-link" onClick={() => setKeyProfileId(null)}>Cancel</button>
														) : (
															<button className="ai-profile-signin" disabled={login.signingInProvider !== null} onClick={() => void signIn(profile)}>
																{providerUsesOAuth(profile.provider.id) ? "Sign in →" : "Add API key →"}
															</button>
														)
													)}
													{/* Management stays reachable while a signed-in profile is broken
													    (expired token, missing model) — Sign out/Remove must not
													    disappear behind the re-sign-in button. */}
													{(profile.ready || profile.provider.configured) && (
												<span className="ai-profile-menu-anchor">
													<button
														className="ai-profile-menu-btn"
														aria-haspopup="menu"
														aria-expanded={menuOpenId === profile.id}
														aria-label={`Manage ${profile.label}`}
														onClick={() => (menuOpenId === profile.id ? closeMenu() : (setMenuOpenId(profile.id), setConfirmRemoveId(null)))}
													>···</button>
													{menuOpenId === profile.id && (
														<>
															<span className="ai-profile-menu-backdrop" onClick={closeMenu} />
															<span className="ai-profile-menu" role="menu">
																{confirmRemoveId === profile.id ? (
																	<>
																		<span className="ai-profile-menu-confirm">Remove {profile.label}? This signs out and deletes its approved models.</span>
																		<button className="ai-profile-menu-item danger" role="menuitem" disabled={removing} onClick={() => void removeProfile(profile)}>{removing ? "Removing…" : "Remove"}</button>
																		<button className="ai-profile-menu-item" role="menuitem" disabled={removing} onClick={() => setConfirmRemoveId(null)}>Keep it</button>
																	</>
																) : (
																	<>
																		<button className="ai-profile-menu-item" role="menuitem" onClick={() => { setModelsOpenId(profile.id); closeMenu(); }}>View models</button>
																		{profile.kind !== "gateway" && (
																			<button className="ai-profile-menu-item" role="menuitem" onClick={() => { setEditProfile(profile); closeMenu(); }}>Approve models</button>
																		)}
																		{profile.kind === "gateway" && (
																			<>
																				{/* Approve models edits the model set only; Edit gateway
																				    owns the base URL and API key. */}
																				<button className="ai-profile-menu-item" role="menuitem" onClick={() => { setGatewayApproveOpen(true); closeMenu(); }}>Approve models</button>
																				<button className="ai-profile-menu-item" role="menuitem" onClick={() => { setGatewayEditOpen(true); closeMenu(); }}>Edit gateway</button>
																			</>
																		)}
																		{profile.kind === "builtin" && profile.overridden && (
																			<button className="ai-profile-menu-item" role="menuitem" onClick={() => { closeMenu(); void resetBuiltInModels(profile); }}>Reset to curated models</button>
																		)}
																		{providerAcceptsApiKey(profile.provider.id) && profile.provider.configured && (
																			<button className="ai-profile-menu-item" role="menuitem" onClick={() => { setKeyProfileId(profile.id); closeMenu(); }}>Replace API key</button>
																		)}
																		<button className="ai-profile-menu-item" role="menuitem" onClick={() => { closeMenu(); void signOut(profile); }}>Sign out</button>
																		{profile.kind !== "builtin" && (
																			<button className="ai-profile-menu-item danger" role="menuitem" onClick={() => setConfirmRemoveId(profile.id)}>
																				{profile.kind === "gateway" ? "Remove gateway…" : "Remove provider…"}
																			</button>
																		)}
																	</>
																)}
															</span>
														</>
													)}
												</span>
													)}
												</>
											)}
										</span>
									</div>
									{signingIn && login.instructions && (
										<div className="add-provider-instructions ai-profile-signin-instructions">{login.instructions}</div>
									)}
									{keyProfileId === profile.id && (
										<ApiKeyForm className="ai-profile-key-form" placeholder={`${profile.label} API key or token`} onSave={(key) => saveApiKey(profile, key)} />
									)}
									{modelsOpen && <AiProfileModelsDetail profile={profile} />}
								</div>
							);
						})}
					</div>
				) : (
					<p className="cli-note">Profile status is still loading.</p>
				)
			) : (
				<p className="cli-note">Profile status is still loading.</p>
			)}
			{status?.state.message && <p className="cli-note">{status.state.message}</p>}
			{status?.customProfiles?.errors?.map((message) => <p key={message} className="cli-note">{message}</p>)}
			{(error ?? login.error) && <div className="checkpoint-proposal-error">{error ?? login.error}</div>}
			<AddProviderPanel onProfilesChanged={() => { onRefresh(); onRefreshAuth(); }} />
			{editProfile && (
				<ConfigureProfileModal
					providerId={editProfile.provider.id}
					providerName={editProfile.label}
					existingProfile={editProfile}
					allowRemove={editProfile.kind === "custom"}
					onClose={() => setEditProfile(null)}
					onSaved={() => { onRefresh(); onRefreshAuth(); }}
				/>
			)}
			{gatewayEditOpen && (
				<GatewayConfigModal
					onClose={() => setGatewayEditOpen(false)}
					onSaved={() => { onRefresh(); onRefreshAuth(); }}
				/>
			)}
			{gatewayApproveOpen && (
				<GatewayApproveModelsModal
					onClose={() => setGatewayApproveOpen(false)}
					onSaved={() => { onRefresh(); onRefreshAuth(); }}
				/>
			)}
			<div className="ai-profile-foot">
				<button className="ai-profile-foot-link ai-profile-foot-refresh" onClick={() => { onRefresh(); onRefreshAuth(); }}>Refresh</button>
			</div>
		</section>
	);
}

function Landing({ onOpenAiSetup, onOpenDashboard, onOpenConnectors, onOpenMemory, onOpenSkills, onOpenPersistentAgent, onResumePersistentAgent, onMaintainPersistentAgent, onCreatePersistentAgent, onArchiveRoom, modelStatus, persistentAgentStatuses, persistentThread, persistentLive, persistentResumeError, onRefreshPersistentAgent, theme, onToggleTheme, connected, aiProfileStatus: aiProfileSelection, onSelectAiProfile, onRefreshAiProfile, standbyLockedModels }: { onOpenAiSetup: () => void; onOpenDashboard: () => void; onOpenConnectors: () => void; onOpenMemory: () => void; onOpenSkills: () => void; onOpenPersistentAgent: (status: PersistentAgentStatus, model: WebChatModelOption) => Promise<void> | void; onResumePersistentAgent: (status: PersistentAgentStatus) => Promise<void> | void; onMaintainPersistentAgent: (target: MaintainTarget) => void; onCreatePersistentAgent: (request: PersistentAgentCreateRequest) => Promise<void>; onArchiveRoom: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentArchiveResponse>; modelStatus: WebChatModelStatus | null; persistentAgentStatuses: PersistentAgentStatus[]; persistentThread: PersistentAgentThread | null; persistentLive: boolean; persistentResumeError: string | null; onRefreshPersistentAgent: () => void; theme: ThemeMode; onToggleTheme: () => void; connected: boolean; aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null; onSelectAiProfile: (profileId: string) => Promise<void>; onRefreshAiProfile: () => void; standbyLockedModels?: Array<{ provider: string; model: string }> }) {
	const [createOpen, setCreateOpen] = useState(false);
	useEscapeKey(() => setCreateOpen(false), createOpen);
	const [settingsRoomId, setSettingsRoomId] = useState<PersistentAgentId | null>(null);
	const [helpOpen, setHelpOpen] = useState(false);
	// The modal must track the LIVE status for its room: statuses are not
	// refetched when leaving a room (a snapshot could carry stale mid-stream
	// inFlight/working flags and e.g. keep Memento disabled forever), and
	// onRefresh must be able to update what the open modal shows.
	const settingsRoom = settingsRoomId ? persistentAgentStatuses.find((status) => status.id === settingsRoomId) ?? null : null;
	const openRoomSettings = (status: PersistentAgentStatus): void => {
		setSettingsRoomId(status.id);
		onRefreshPersistentAgent();
	};

	const roomStatuses = persistentAgentStatuses
		.slice()
		.sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id));
	const firstRoomStatus = roomStatuses[0] ?? null;
	const additionalRoomStatuses = firstRoomStatus ? roomStatuses.filter((status) => status.id !== firstRoomStatus.id) : [];
	const displayNameCounts = roomStatuses.reduce((counts, status) => {
		const key = (status.displayName || "").trim().toLocaleLowerCase();
		if (!key) return counts;
		counts.set(key, (counts.get(key) ?? 0) + 1);
		return counts;
	}, new Map<string, number>());
	const hasDuplicateDisplayName = (status: PersistentAgentStatus): boolean => {
		const key = (status.displayName || "").trim().toLocaleLowerCase();
		return key ? (displayNameCounts.get(key) ?? 0) > 1 : false;
	};
	const aiProfileStatus = homeAiProfileStatus(modelStatus, aiProfileSelection);

	return (
		<div className="landing-shell with-product-sidebar">
			<ProductSidebar onHome={() => {}} onAiSetup={onOpenAiSetup} onDashboard={onOpenDashboard} onConnectors={onOpenConnectors} onMemory={onOpenMemory} onSkills={onOpenSkills} connected={connected} theme={theme} onToggleTheme={onToggleTheme} active="home" aiProfileStatus={aiProfileSelection} onSelectAiProfile={onSelectAiProfile} onRefreshAiProfile={onRefreshAiProfile} standbyLockedModels={standbyLockedModels} />
			<div className="landing home-page">
			<section className="landing-hero">
				<div className="landing-hero-head">
					<div>
						<h1>Your rooms.</h1>
						<p>{roomStatuses.length === 0 ? "Create your first room to get started." : "Pick up where you left off, or start a new room."}</p>
					</div>
					<button type="button" className="section-help-btn" aria-label="How rooms work" title="How rooms work" onClick={() => setHelpOpen(true)}>?</button>
				</div>
				{aiProfileStatus && aiProfileStatus.ready === false && (
					<button type="button" className="home-ai-profile-status setup-needed" onClick={onOpenAiSetup}>
						{aiProfileStatus.message}
					</button>
				)}
				{persistentResumeError && (
					<div className="home-resume-error" role="alert">{persistentResumeError}</div>
				)}
			</section>
			<section className={`landing-grid${roomStatuses.length === 0 ? " landing-grid--empty" : ""}`} aria-label="exxperts entry points">
				{firstRoomStatus && (
					<PersistentAgentCard key={firstRoomStatus.id} status={firstRoomStatus} modelStatus={modelStatus} aiProfileStatus={aiProfileSelection} thread={persistentThread?.agentId === firstRoomStatus.id ? persistentThread : null} live={persistentLive && persistentThread?.agentId === firstRoomStatus.id} duplicateDisplayName={hasDuplicateDisplayName(firstRoomStatus)} onEnter={onOpenPersistentAgent} onResume={onResumePersistentAgent} onMaintain={onMaintainPersistentAgent} onOpenSettings={() => openRoomSettings(firstRoomStatus)} />
				)}
				{additionalRoomStatuses.map((status) => (
					<PersistentAgentCard key={status.id} status={status} modelStatus={modelStatus} aiProfileStatus={aiProfileSelection} thread={persistentThread?.agentId === status.id ? persistentThread : null} live={persistentLive && persistentThread?.agentId === status.id} duplicateDisplayName={hasDuplicateDisplayName(status)} onEnter={onOpenPersistentAgent} onResume={onResumePersistentAgent} onMaintain={onMaintainPersistentAgent} onOpenSettings={() => openRoomSettings(status)} />
				))}
				<button type="button" className="landing-card add-room-card" onClick={() => setCreateOpen(true)} aria-label="Create a new room">
					<span className="add-room-plus" aria-hidden="true">+</span>
					<span className="add-room-label">New room</span>
				</button>
			</section>
			</div>
			{createOpen && (
				<div className="room-settings-overlay create-room-overlay" role="dialog" aria-modal="true" aria-label="Create room" onClick={() => setCreateOpen(false)}>
					<div className="room-settings-modal create-room-modal" onClick={(e) => e.stopPropagation()}>
						<div className="room-settings-head">
							<div className="room-settings-title-block">
								<div className="room-settings-title-row">
									<h2>Create a room</h2>
								</div>
							</div>
							<button className="icon-btn" onClick={() => setCreateOpen(false)} aria-label="Close">Close</button>
						</div>
						<div className="room-settings-body">
							<CreateRoomPanel onCreate={onCreatePersistentAgent} initialOpen variant="section" onCreated={() => { setCreateOpen(false); onRefreshPersistentAgent(); }} onCancel={() => setCreateOpen(false)} />
						</div>
					</div>
				</div>
			)}
			{settingsRoom && (
				<RoomSettingsModal status={settingsRoom} onClose={() => setSettingsRoomId(null)} onArchive={onArchiveRoom} onRefresh={onRefreshPersistentAgent} />
			)}
			{helpOpen && <RoomsGuide onClose={() => setHelpOpen(false)} />}
		</div>
	);
}

function AiSetupShell({ onHome, onDashboard, onConnectors, onMemory, onSkills, onRefreshAuth, aiProfileStatus, onRefreshAiProfile, onSelectAiProfile, connected, theme, onToggleTheme, standbyLockedModels }: { onHome: () => void; onDashboard: () => void; onConnectors: () => void; onMemory: () => void; onSkills: () => void; onRefreshAuth: () => void; aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null; onRefreshAiProfile: () => void; onSelectAiProfile: (profileId: string) => Promise<void>; connected: boolean; theme: ThemeMode; onToggleTheme: () => void; standbyLockedModels?: Array<{ provider: string; model: string }> }) {
	return (
		<div className="landing-shell with-product-sidebar">
			<ProductSidebar onHome={onHome} onAiSetup={() => {}} onDashboard={onDashboard} onConnectors={onConnectors} onMemory={onMemory} onSkills={onSkills} connected={connected} theme={theme} onToggleTheme={onToggleTheme} active="ai-setup" aiProfileStatus={aiProfileStatus} onSelectAiProfile={onSelectAiProfile} onRefreshAiProfile={onRefreshAiProfile} standbyLockedModels={standbyLockedModels} />
			<div className="landing ai-setup-page">
				<section className="landing-hero ai-setup-hero">
					<h1>AI setup.</h1>
					<p>Sign in and choose the profile your exxperts run on. A profile is a provider plus the models you've approved for Rooms, Learn, and Review Memory.</p>
					<p>New room threads start on the active profile. Standby threads keep their model and resume when their profile is active again.</p>
				</section>
				<AiProfileSwitcherSection status={aiProfileStatus} onSelect={onSelectAiProfile} onRefresh={onRefreshAiProfile} onRefreshAuth={onRefreshAuth} standbyLockedModels={standbyLockedModels} />
			</div>
		</div>
	);
}

function ConnectorsShell({ onHome, onAiSetup, onDashboard, onMemory, onSkills, connected, theme, onToggleTheme, aiProfileStatus, onSelectAiProfile, onRefreshAiProfile, standbyLockedModels }: { onHome: () => void; onAiSetup: () => void; onDashboard: () => void; onMemory: () => void; onSkills: () => void; connected: boolean; theme: ThemeMode; onToggleTheme: () => void; aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null; onSelectAiProfile: (profileId: string) => Promise<void>; onRefreshAiProfile: () => void; standbyLockedModels?: Array<{ provider: string; model: string }> }) {
	return (
		<div className="landing-shell with-product-sidebar">
			<ProductSidebar onHome={onHome} onAiSetup={onAiSetup} onDashboard={onDashboard} onConnectors={() => {}} onMemory={onMemory} onSkills={onSkills} connected={connected} theme={theme} onToggleTheme={onToggleTheme} active="connectors" aiProfileStatus={aiProfileStatus} onSelectAiProfile={onSelectAiProfile} onRefreshAiProfile={onRefreshAiProfile} standbyLockedModels={standbyLockedModels} />
			<div className="landing ai-setup-page connectors-page">
				<ConnectorsPage />
			</div>
		</div>
	);
}

function SkillsShell({ onHome, onAiSetup, onDashboard, onConnectors, onMemory, connected, theme, onToggleTheme, aiProfileStatus, onSelectAiProfile, onRefreshAiProfile, standbyLockedModels }: { onHome: () => void; onAiSetup: () => void; onDashboard: () => void; onConnectors: () => void; onMemory: () => void; connected: boolean; theme: ThemeMode; onToggleTheme: () => void; aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null; onSelectAiProfile: (profileId: string) => Promise<void>; onRefreshAiProfile: () => void; standbyLockedModels?: Array<{ provider: string; model: string }> }) {
	return (
		<div className="landing-shell with-product-sidebar">
			<ProductSidebar onHome={onHome} onAiSetup={onAiSetup} onDashboard={onDashboard} onConnectors={onConnectors} onMemory={onMemory} onSkills={() => {}} connected={connected} theme={theme} onToggleTheme={onToggleTheme} active="skills" aiProfileStatus={aiProfileStatus} onSelectAiProfile={onSelectAiProfile} onRefreshAiProfile={onRefreshAiProfile} standbyLockedModels={standbyLockedModels} />
			<SkillsPage />
		</div>
	);
}

function MemoryShell({ onHome, onAiSetup, onDashboard, onConnectors, onSkills, onMaintain, maintainBlocked, connected, theme, onToggleTheme, aiProfileStatus, onSelectAiProfile, onRefreshAiProfile, standbyLockedModels }: { onHome: () => void; onAiSetup: () => void; onDashboard: () => void; onConnectors: () => void; onSkills: () => void; onMaintain: (target: MaintainTarget) => void; maintainBlocked?: (agentId: PersistentAgentId) => string | null; connected: boolean; theme: ThemeMode; onToggleTheme: () => void; aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null; onSelectAiProfile: (profileId: string) => Promise<void>; onRefreshAiProfile: () => void; standbyLockedModels?: Array<{ provider: string; model: string }> }) {
	return (
		<div className="landing-shell with-product-sidebar">
			<ProductSidebar onHome={onHome} onAiSetup={onAiSetup} onDashboard={onDashboard} onConnectors={onConnectors} onMemory={() => {}} onSkills={onSkills} connected={connected} theme={theme} onToggleTheme={onToggleTheme} active="memory" aiProfileStatus={aiProfileStatus} onSelectAiProfile={onSelectAiProfile} onRefreshAiProfile={onRefreshAiProfile} standbyLockedModels={standbyLockedModels} />
			<div className="landing dashboard-page">
				<section className="landing-hero">
					<h1>Memory.</h1>
					<p>What your exxperts remember, and how it grows.</p>
				</section>
				<Memory onMaintain={onMaintain} maintainBlocked={maintainBlocked} />
			</div>
		</div>
	);
}

// In-flow replacement for window.confirm at the Maintain flow's sensitive
// moments: same visual language as the rest of the product, Escape cancels.
type MaintainConfirm = { title: string; body: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void };

function MaintainConfirmDialog({ confirm, onClose }: { confirm: MaintainConfirm; onClose: () => void }) {
	useEscapeKey(onClose, true);
	return (
		<div className="checkpoint-preview-backdrop maintain-confirm-backdrop" role="dialog" aria-modal="true" aria-label={confirm.title}>
			<section className="checkpoint-input-card maintain-confirm-card">
				<h2>{confirm.title}</h2>
				<p>{confirm.body}</p>
				<div className="checkpoint-preview-actions">
					<button className="landing-action secondary" onClick={onClose}>{confirm.cancelLabel}</button>
					<button className="landing-action" autoFocus onClick={() => { onClose(); confirm.onConfirm(); }}>{confirm.confirmLabel}</button>
				</div>
			</section>
		</div>
	);
}

// Export collision (assets contract §5): the three-button flow. Replace is the
// destructive choice; Keep both auto-suffixes server-side; no filename typing.
type ExportCollision = { fileName: string; onReplace: () => void; onKeepBoth: () => void };

function ExportCollisionDialog({ collision, onClose }: { collision: ExportCollision; onClose: () => void }) {
	useEscapeKey(onClose, true);
	return (
		<div className="checkpoint-preview-backdrop maintain-confirm-backdrop" role="dialog" aria-modal="true" aria-label="File already exists">
			<section className="checkpoint-input-card maintain-confirm-card">
				<h2>File already exists</h2>
				<p>A file called “{collision.fileName}” is already in this room's workspace.</p>
				<div className="checkpoint-preview-actions">
					<button className="landing-action secondary" autoFocus onClick={onClose}>Cancel</button>
					<button className="landing-action secondary" onClick={() => { onClose(); collision.onKeepBoth(); }}>Keep both</button>
					<button className="rs-btn rs-btn-danger" onClick={() => { onClose(); collision.onReplace(); }}>Replace</button>
				</div>
			</section>
		</div>
	);
}

// Per-task delete confirm (assets contract §4): destructive-styled, names the
// task, cancel is the safe default.
function AssetDeleteDialog({ title, onDelete, onCancel }: { title: string; onDelete: () => void; onCancel: () => void }) {
	useEscapeKey(onCancel, true);
	return (
		<div className="checkpoint-preview-backdrop maintain-confirm-backdrop" role="dialog" aria-modal="true" aria-label="Delete task files">
			<section className="checkpoint-input-card maintain-confirm-card">
				<h2>Delete “{title}”?</h2>
				<p>This removes its files for good. Anything you saved to the workspace stays.</p>
				<div className="checkpoint-preview-actions">
					<button className="landing-action secondary" autoFocus onClick={onCancel}>Cancel</button>
					<button className="rs-btn rs-btn-danger" onClick={onDelete}>Delete</button>
				</div>
			</section>
		</div>
	);
}

interface TaskStoreGcView {
	totalBytes: number;
	thresholdBytes: number;
	proposal: { candidates: { taskId: string; title?: string; startedAt?: string; bytes: number }[]; reclaimBytes: number } | null;
}

function fmtMb(bytes: number): string {
	return `${(bytes / 1_000_000).toFixed(bytes >= 100_000_000 ? 0 : 1)} MB`;
}

// Store-wide GC surfaces (assets contract §4): a quiet banner on Home once the
// safety valve's threshold is crossed, and the approval dialog that names
// exactly what would go. Nothing is deleted without the explicit confirm.
function TaskStoreGcBanner({ assessment, onReview, onDismiss }: { assessment: TaskStoreGcView; onReview: () => void; onDismiss: () => void }) {
	if (!assessment.proposal) return null;
	return (
		<div className="task-store-gc-banner" role="status">
			<span>Old specialist files are taking up {fmtMb(assessment.totalBytes)} — {fmtMb(assessment.proposal.reclaimBytes)} can be freed safely.</span>
			<button className="landing-action secondary" onClick={onReview}>Review</button>
			<button className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>✕</button>
		</div>
	);
}

function TaskStoreGcDialog({ assessment, busy, onConfirm, onClose }: { assessment: TaskStoreGcView; busy: boolean; onConfirm: () => void; onClose: () => void }) {
	useEscapeKey(onClose, true);
	const proposal = assessment.proposal;
	if (!proposal) return null;
	return (
		<div className="checkpoint-preview-backdrop maintain-confirm-backdrop" role="dialog" aria-modal="true" aria-label="Review task-store cleanup">
			<section className="checkpoint-input-card maintain-confirm-card task-store-gc-card">
				<h2>Free up task storage</h2>
				<p>These {proposal.candidates.length} are from old work no conversation refers to anymore. Deleting them frees {fmtMb(proposal.reclaimBytes)} — files in your workspace stay.</p>
				<div className="task-store-gc-list">
					{proposal.candidates.map((candidate) => (
						<div key={candidate.taskId} className="task-store-gc-row">
							<span className="task-store-gc-title">{candidate.title || candidate.taskId}</span>
							<span className="task-store-gc-meta">{candidate.startedAt ? new Date(candidate.startedAt).toLocaleDateString() : "—"} · {fmtMb(candidate.bytes)}</span>
						</div>
					))}
				</div>
				<div className="checkpoint-preview-actions">
					<button className="landing-action secondary" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
					<button className="rs-btn rs-btn-danger" disabled={busy} onClick={onConfirm}>{busy ? "Deleting…" : `Delete ${proposal.candidates.length} task folders`}</button>
				</div>
			</section>
		</div>
	);
}

// The leave-guard dialog and the native beforeunload prompt lived here until
// option 4 (2026-07-19): both warned about the leave-abort, and the abort is
// gone — a delegation belongs to the room, not to the tab that asked for it.

function MaintainChooserShell({ target, memoryStatus, onAbsorb, onPrune, onReturn, returnLabel }: { target: MaintainTarget; memoryStatus: PersistentAgentStatus["memoryStatus"] | null; onAbsorb: () => void; onPrune: () => void; onReturn: () => void; returnLabel: string }) {
	useEscapeKey(onReturn, true);
	const recentCount = memoryStatus?.recentContextCount ?? null;
	const nothingToLearn = recentCount === 0;
	return (
		<div className="absorb-workspace maintain-workspace" aria-label="Memory maintenance chooser">
			<header className="absorb-workspace-header">
				<div>
					<p className="card-kicker">Maintain · {target.displayName}</p>
					<h1>Maintain memory</h1>
					<p>Help {target.displayName} learn from recent sessions or tidy up what it already knows.</p>
					<p className="maintain-chooser-note">Both begin with a read-only assessment. You review the proposed update before it is saved; rooms with automatic memory maintenance apply clean updates on their own.</p>
				</div>
				<button className="landing-action secondary" onClick={onReturn}>{returnLabel}</button>
			</header>
			<main className="absorb-workspace-main maintain-workspace-main">
				<section className="maintain-choice-grid" aria-label="Memory maintenance workflows">
					<article className="maintain-choice-card primary">
						<div>
							<p className="card-kicker">Recent Sessions</p>
							<h2>Learn</h2>
							<p>Turn recent sessions into lasting memory. What matters becomes part of what {target.displayName} knows; the rest is cleared.</p>
						</div>
						<div className="maintain-choice-footer">
							{recentCount !== null && <span className="maintain-choice-status" title={nothingToLearn ? undefined : "Learning needs a few checkpointed sessions; the check when you start confirms this is enough."}>{nothingToLearn ? "Nothing new to learn right now" : `${recentCount} recent ${recentCount === 1 ? "session" : "sessions"} waiting`}</span>}
							<button className="landing-action" disabled={nothingToLearn} title={nothingToLearn ? "Have a session with this room first." : undefined} onClick={onAbsorb}>Start learning</button>
						</div>
					</article>
					<article className="maintain-choice-card">
						<div>
							<p className="card-kicker">Deep Memory</p>
							<h2>Review Memory</h2>
							<p>Go over what {target.displayName} keeps long-term and tighten anything stale, redundant, or overgrown.</p>
						</div>
						<div className="maintain-choice-footer">
							<button className="landing-action secondary" onClick={onPrune}>Start review</button>
						</div>
					</article>
				</section>
			</main>
		</div>
	);
}

type CheckpointApprovalEditFields = { sessionArc: string; body: string; parked: string };

function buildApprovedRecentContextMarkdown(proposal: CheckpointProposalResponse, fields: CheckpointApprovalEditFields): string {
	const heading = proposal.proposedRecentContext.split(/\r?\n/)[0]?.trim() || `### RC-DRAFT | ${fields.parked.trim().toLowerCase() === "none" ? "CLOSED" : "OPEN"} | ${new Date().toISOString().slice(0, 10)} | ${proposal.preview.title}`;
	return `${heading}\n\n**Session arc:** ${fields.sessionArc.trim()}\n\n**Body:**\n${fields.body.trim()}\n\n**Parked:**\n${fields.parked.trim() || "None"}\n`;
}

function StructuralReviewMemoryMap({ rows }: { rows: StructuralReviewMemoryMapRow[] }) {
	if (!rows.length) return <p className="absorb-help-note">No memory map rows available.</p>;
	const mainRows = rows.filter((row) => !row.area.includes(" / "));
	const totalWords = mainRows.reduce((sum, row) => sum + row.words, 0);
	const totalTokens = mainRows.reduce((sum, row) => sum + row.estimatedTokens, 0);
	function share(row: StructuralReviewMemoryMapRow): string {
		if (row.area.includes(" / ") || totalTokens <= 0) return "–";
		return `${Math.round((row.estimatedTokens / totalTokens) * 100)}%`;
	}
	return (
		<div className="structural-review-memory-map-block">
			<div className="absorb-table-wrap structural-review-memory-map">
				<table className="absorb-change-table">
					<thead><tr><th>Area</th><th>Words</th><th>Estimated tokens</th><th>% of main sections</th></tr></thead>
					<tbody>{rows.map((row, index) => <tr key={`${row.area}-${index}`}><td>{row.area}</td><td>{row.words}</td><td>{row.estimatedTokens}</td><td>{share(row)}</td></tr>)}</tbody>
				</table>
			</div>
			<div className="structural-review-map-total">
				<span>Total main sections</span>
				<strong>{totalWords} words · {totalTokens} estimated tokens</strong>
			</div>
		</div>
	);
}

// Current and proposed joined by area into one table with a Change column, so
// "what actually shrinks?" is answered directly instead of diffed by eye
// across two tables (which also stack incomparably on narrow viewports).
function StructuralReviewMemoryMapDiff({ current, proposed }: { current: StructuralReviewMemoryMapRow[]; proposed: StructuralReviewMemoryMapRow[] }) {
	const areas: string[] = [];
	const seen = new Set<string>();
	for (const row of [...current, ...proposed]) {
		if (!seen.has(row.area)) {
			seen.add(row.area);
			areas.push(row.area);
		}
	}
	if (!areas.length) return <p className="absorb-help-note">No memory map rows available.</p>;
	const currentByArea = new Map(current.map((row) => [row.area, row]));
	const proposedByArea = new Map(proposed.map((row) => [row.area, row]));
	const mainAreas = areas.filter((area) => !area.includes(" / "));
	const totalCurrent = mainAreas.reduce((sum, area) => sum + (currentByArea.get(area)?.estimatedTokens ?? 0), 0);
	const totalProposed = mainAreas.reduce((sum, area) => sum + (proposedByArea.get(area)?.estimatedTokens ?? 0), 0);
	function deltaCell(currentTokens: number | null, proposedTokens: number | null) {
		const delta = (proposedTokens ?? 0) - (currentTokens ?? 0);
		return <td className={`n ${delta < 0 ? "neg" : delta > 0 ? "pos" : ""}`}>{delta > 0 ? `+${delta}` : String(delta)}</td>;
	}
	return (
		<div className="absorb-table-wrap structural-review-memory-map">
			<table className="absorb-change-table structural-review-map-diff">
				<thead><tr><th>Area</th><th className="n">Current tokens</th><th className="n">Proposed tokens</th><th className="n">Change</th></tr></thead>
				<tbody>
					{areas.map((area, index) => {
						const currentRow = currentByArea.get(area) ?? null;
						const proposedRow = proposedByArea.get(area) ?? null;
						return (
							<tr key={`${area}-${index}`}>
								<td>{area}</td>
								<td className="n">{currentRow ? currentRow.estimatedTokens : "–"}</td>
								<td className="n">{proposedRow ? proposedRow.estimatedTokens : "–"}</td>
								{deltaCell(currentRow?.estimatedTokens ?? null, proposedRow?.estimatedTokens ?? null)}
							</tr>
						);
					})}
					<tr className="structural-review-map-diff-total">
						<td>Total main sections</td>
						<td className="n">{totalCurrent}</td>
						<td className="n">{totalProposed}</td>
						{deltaCell(totalCurrent, totalProposed)}
					</tr>
				</tbody>
			</table>
		</div>
	);
}

function StructuralReviewWorkflowShell({ state, loadingMessage, waitingMessage, onAbort, onDiscuss, onSendDiscussionMessage, onGenerateFromDiscussion, onGenerate, onApprove, onBackToDiscussion, onBackToAssessment, onRestart, returnLabel }: { state: StructuralReviewWorkflowState; loadingMessage: string; waitingMessage: string; onAbort: () => void; onDiscuss: () => void; onSendDiscussionMessage: (message: string) => void; onGenerateFromDiscussion: () => void; onGenerate: () => void; onApprove: () => void; onBackToDiscussion: () => void; onBackToAssessment: () => void; onRestart: () => void; returnLabel: string }) {
	if (state.step === "closed") return null;
	const loading = state.step === "checking" || state.step === "assessing";
	const availability = state.availability;
	const assessment = state.assessment;
	const proposal = state.proposal;
	const validation = proposal?.candidateValidation;
	const proposalWarnings = meaningfulMaintenanceWarnings([...(proposal?.warnings ?? []), ...(validation?.warnings ?? [])].filter(Boolean));
	const proposalErrors = validation?.errors ?? [];
	const metrics = proposal?.review.metrics;
	const tokenDelta = metrics ? `${metrics.reviewTargetEstimatedTokenDelta >= 0 ? "+" : ""}${metrics.reviewTargetEstimatedTokenDelta} estimated tokens` : null;
	const discussionMessages = state.discussionMessages ?? [];
	const discussionBudget = state.discussionTokenBudget;
	const targetLabel = state.target?.displayName ?? "this room";
	return (
		<div className="absorb-workspace structural-review-workspace" aria-label="Review Memory workflow">
			<header className={`absorb-workspace-header${state.step === "discussing" ? " compact" : ""}`}>
				<div>
					<p className="card-kicker">Maintain · {targetLabel}</p>
					<h1>Review Memory</h1>
					<p>A focused workspace for going over what this room keeps long-term and tightening what has drifted.</p>
				</div>
				{state.step === "approving" ? (
					<button className="landing-action secondary" disabled title="The memory update is being written and cannot be cancelled.">Updating memory…</button>
				) : state.step === "assessment" || state.step === "proposal" ? null : (
					// Assessment and proposal keep a single Cancel in their action row
					// instead of a duplicate header exit.
					<button className="landing-action secondary" onClick={onAbort}>{state.step === "saved" || state.step === "unavailable" || state.step === "error" ? returnLabel : "Cancel and return"}</button>
				)}
			</header>
			<main className="absorb-workspace-main">
				<section className="checkpoint-input-card absorb-workflow-card">
					{loading ? (
						<div className="checkpoint-generating-state absorb-loading-state">
							<p className="card-kicker">Review Memory</p>
							<h2>{loadingMessage}</h2>
							<span className="spinner spinner-lg" />
							<p>{state.step === "assessing" && availability ? `Reading deep memory. Reviewing ${availability.reviewTargetWords} words of long-term memory; this usually takes a minute or two.` : "Reading deep memory. This usually takes a minute or two."}</p>
							<p>Nothing is saved yet.</p>
						</div>
					) : state.step === "unavailable" && availability ? (
						(() => {
							const copy = structuralReviewUnavailableCopy(availability);
							return (
								<div className="checkpoint-proposal-page absorb-unavailable-state">
									<div className="checkpoint-input-heading">
										<p className="card-kicker">Review Memory</p>
										<h2>{copy.heading}</h2>
										<p>{copy.body}</p>
									</div>
									{copy.detail && (
										<details className="absorb-candidate-disclosure absorb-detail-disclosure">
											<summary>Technical detail</summary>
											<p>{copy.detail}</p>
										</details>
									)}
									<div className="checkpoint-preview-actions">
										<button className="landing-action secondary" onClick={onAbort}>{returnLabel}</button>
										<button className="landing-action" onClick={onRestart}>Back to Maintain</button>
									</div>
								</div>
							);
						})()
					) : state.step === "proposing" || state.step === "approving" || state.step === "signing_off" ? (
						<div className="checkpoint-generating-state absorb-loading-state">
							<p className="card-kicker">Review Memory</p>
							<h2>{state.step === "approving" ? "Updating memory…" : state.step === "signing_off" ? "Reading the discussion back…" : waitingMessage}</h2>
							<span className="spinner spinner-lg" />
							<p>{state.step === "approving" ? "The current memory is being archived, then replaced with the approved update." : state.step === "signing_off" ? "Your discussion is being folded into the memory update draft. Nothing is saved yet." : state.fastPathEnabled ? "Drafting the memory update. This can take a few minutes. If it passes all checks, it will be applied automatically." : "Drafting the memory update. This can take a few minutes. Nothing is saved yet."}</p>
							{state.step === "approving" && <p>This step finishes on its own and cannot be cancelled.</p>}
						</div>
					) : state.step === "saved" && state.approvalResult ? (
						<div className="checkpoint-proposal-page checkpoint-saved-page absorb-saved-state">
							<div className="checkpoint-input-heading">
								<p className="card-kicker">Review complete</p>
								<h2>Memory updated</h2>
								<p>{targetLabel === "this room" ? "This room’s long-term memory has been reviewed and tightened." : `${targetLabel}'s long-term memory has been reviewed and tightened.`}</p>
								{state.fastPathApplied && <p className="absorb-fast-path-note">Applied automatically. Automatic memory maintenance is on for this room.</p>}
								{state.fastPathApplied && state.proposal && maintenanceWorkerNotes(state.proposal.fields.warnings) && (
									<p className="absorb-fast-path-note">Notes from the update: {maintenanceWorkerNotes(state.proposal.fields.warnings)}</p>
								)}
							</div>
							<div className="absorb-result-grid structural-review-result-grid">
								<div className="absorb-result-card"><span>Deep Memory</span><strong>{tokenDelta ? tokenDelta : "Tightened"}</strong></div>
								<div className="absorb-result-card"><span>Previous memory</span><strong>Archived first</strong></div>
								<div className="absorb-result-card"><span>Audit record</span><strong>Created</strong></div>
							</div>
							{proposal && (
								<div className="absorb-proposal-sections">
									<ProposalSection title="What changed" body={proposal.review.summary || proposal.fields.summary} />
									<StructuralReviewProposalDetail title="Section-level change log" body={proposal.fields.sectionLevelChangeLog} actionColumn="Disposition" />
								</div>
							)}
							{state.approvalResult.warnings.length > 0 && <div className="checkpoint-proposal-warnings">{state.approvalResult.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
							<div className="checkpoint-preview-actions">
								<button className="landing-action" onClick={onAbort}>{returnLabel}</button>
							</div>
						</div>
					) : state.step === "error" ? (
						<div className="checkpoint-proposal-page absorb-error-state">
							<div className="checkpoint-input-heading">
								<p className="card-kicker">Review Memory</p>
								<h2>The review could not start</h2>
								<p>No memory was changed. You can start Maintain again right away.</p>
							</div>
							{state.error && <div className="checkpoint-proposal-error">{state.error}</div>}
							<div className="checkpoint-preview-actions">
								<button className="landing-action secondary" onClick={onAbort}>{returnLabel}</button>
								<button className="landing-action" onClick={onRestart}>Start Maintain again</button>
							</div>
						</div>
					) : state.step === "discussing" && assessment ? (
						<div className="checkpoint-proposal-page absorb-discussion-page structural-review-discussion-page">
							<MaintenanceDiscussion
								assessmentMarkdown={assessment.assessmentMarkdown}
								messages={discussionMessages}
								budget={discussionBudget}
								warnings={state.discussionWarnings ?? null}
								error={state.error}
								sending={Boolean(state.discussionSending)}
								emptyHint="No discussion messages yet. Ask what should be tightened, reorganized, preserved, or let go."
								placeholder="Ask about what should be tightened, reorganized, or let go…"
								onSend={onSendDiscussionMessage}
								onBack={onBackToAssessment}
								onGenerate={onGenerateFromDiscussion}
							/>
						</div>
					) : proposal ? (
						<div className="checkpoint-proposal-page absorb-proposal-page structural-review-proposal-page">
							<div className="checkpoint-input-heading checkpoint-proposal-heading">
								<p className="card-kicker">Memory update · not saved</p>
								<h2>Review memory update</h2>
								<p>Review the memory maps and candidate preview. Nothing changes until you approve the update for this room.</p>
							</div>
							<div className="absorb-review-strip">
								<div className={`absorb-review-status ${state.proposalStale ? "error" : validation?.valid ? "ok" : "error"}`}><span>Candidate check</span><strong>{state.proposalStale ? "Out of date" : validation?.valid ? "Ready to approve" : "Needs review"}</strong></div>
								{tokenDelta && <div className="absorb-review-status"><span>Token delta</span><strong>{tokenDelta}</strong></div>}
							</div>
							{proposalErrors.length > 0 && <div className="checkpoint-proposal-error">{proposalErrors.map((error) => <div key={error}>{error}</div>)}</div>}
							{state.error && <div className="checkpoint-proposal-error">{state.error}</div>}
							{proposalWarnings.length > 0 && <div className="checkpoint-proposal-warnings absorb-warning-list">{proposalWarnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
							{(state.fastPathBlockedReasons?.length ?? 0) > 0 && (
								<div className="absorb-help-note fast-path-blocked-note">
									Automatic memory maintenance is on for this room, but this proposal needs manual review because {state.fastPathBlockedReasons!.join("; ")}.
								</div>
							)}
							<div className="absorb-proposal-sections">
								<ProposalSection title="Summary" body={proposal.review.summary || proposal.fields.summary} />
								{metrics && (
									<section className="absorb-proposal-section">
										<h3>Memory map</h3>
										<StructuralReviewMemoryMapDiff current={metrics.sourceMemoryMap} proposed={metrics.candidateMemoryMap} />
									</section>
								)}
								<StructuralReviewProposalDetail title="Section-level change log" body={proposal.fields.sectionLevelChangeLog} actionColumn="Disposition" />
								<StructuralReviewProposalDetail title="Subsection / entry detail" body={proposal.fields.subsectionEntryDetail} actionColumn="Operation" />
								{proposal.fields.stalenessFlags && <ProposalDetail title="Staleness flags" body={proposal.fields.stalenessFlags} />}
								{proposal.fields.warnings && <ProposalDetail title="Proposal warnings" body={proposal.fields.warnings} />}
								<details className="absorb-candidate-disclosure">
									<summary>Full proposed memory preview</summary>
									<MarkdownPreview body={stripLeadingHtmlComments(proposal.fields.candidateReviewTargetL1b)} />
									<details className="absorb-raw-markdown-disclosure">
										<summary>Raw markdown</summary>
										<pre className="checkpoint-full-entry">{proposal.fields.candidateReviewTargetL1b}</pre>
									</details>
								</details>
							</div>
							<div className="absorb-approval-note">Approve tightens Deep Memory and Active Items only and archives the current memory first. The timeline and Recent Sessions stay exactly as they are.</div>
							<div className="checkpoint-preview-actions">
								<button className="landing-action secondary" onClick={onAbort}>Cancel</button>
								{(state.discussionMessages?.length ?? 0) > 0 && <button className="landing-action secondary" title="Return to the discussion; the transcript is kept and only this draft is dropped" onClick={onBackToDiscussion}>Back to discussion</button>}
								<button className="landing-action secondary" title="Generate a fresh memory update from the same assessment" onClick={onGenerate}>Draft again</button>
								<button className="landing-action" disabled={!validation?.valid || state.proposalStale} title={state.proposalStale ? "This draft can no longer be applied. Draft the update again to continue." : validation?.valid ? "Approve and update long-term memory" : "The candidate must pass validation before approval"} onClick={onApprove}>Approve and update memory</button>
							</div>
						</div>
					) : assessment ? (
						<div className="checkpoint-proposal-page absorb-assessment-page structural-review-assessment-page">
							<div className="checkpoint-input-heading checkpoint-proposal-heading">
								<p className="card-kicker">Review assessment</p>
								<h2>Deep Memory review</h2>
								<p>{assessment.availability.reviewTargetWords} words · {assessment.availability.reviewTargetEstimatedTokens} estimated tokens across Deep Memory and Active Items.</p>
							</div>
							{state.error && <div className="checkpoint-proposal-error">{state.error}</div>}
							<section className="absorb-assessment-section wide structural-review-map-section">
								<h3>Memory map</h3>
								<StructuralReviewMemoryMap rows={assessment.availability.memoryMap} />
							</section>
							<div className="absorb-assessment-grid absorb-assessment-flow">
								<AssessmentSection title="Looks healthy" items={assessment.fields.looksHealthy} wide />
								<AssessmentSection title="Stale or drift-prone" items={assessment.fields.staleOrDriftProne.length ? assessment.fields.staleOrDriftProne : ["None flagged"]} wide />
								<AssessmentSection title="Could be denser" items={assessment.fields.couldBeDenser} wide />
								<AssessmentSection title="Structure opportunities" items={assessment.fields.structureOpportunities} wide />
								<section className="absorb-assessment-section wide">
									<h3>Proposed direction</h3>
									<p>{assessment.fields.proposedDirection || "No direction provided."}</p>
								</section>
							</div>
							{meaningfulMaintenanceWarnings(assessment.warnings).length > 0 && <div className="checkpoint-proposal-warnings">{meaningfulMaintenanceWarnings(assessment.warnings).map((warning) => <div key={warning}>{warning}</div>)}</div>}
							{state.fastPathEnabled && <div className="absorb-help-note">Automatic memory maintenance is on for this room. If the draft passes all checks, it is applied without a second review.</div>}
							<div className="checkpoint-preview-actions">
								<button className="landing-action secondary" onClick={onAbort}>Cancel</button>
								<button className="landing-action secondary" onClick={onDiscuss}>Discuss memory</button>
								<button className="landing-action" onClick={onGenerate}>Draft memory update</button>
							</div>
						</div>
					) : null}
				</section>
			</main>
		</div>
	);
}

function AbsorbWorkflowShell({ state, loadingMessage, waitingMessage, onAbort, onDiscuss, onSendDiscussionMessage, onGenerateFromDiscussion, onGenerate, onApprove, onBackToDiscussion, onBackToAssessment, onRestart, returnLabel }: { state: AbsorbWorkflowState; loadingMessage: string; waitingMessage: string; onAbort: () => void; onDiscuss: () => void; onSendDiscussionMessage: (message: string) => void; onGenerateFromDiscussion: () => void; onGenerate: () => void; onApprove: () => void; onBackToDiscussion: () => void; onBackToAssessment: () => void; onRestart: () => void; returnLabel: string }) {
	if (state.step === "closed") return null;
	const loading = state.step === "checking" || state.step === "assessing";
	const availability = state.availability;
	const assessment = state.assessment;
	const proposal = state.proposal;
	const validation = proposal?.candidateValidation;
	const proposalWarnings = meaningfulMaintenanceWarnings([...(proposal?.warnings ?? []), ...(validation?.warnings ?? [])].filter(Boolean));
	const proposalErrors = validation?.errors ?? [];
	const stableMemoryDelta = proposal ? formatStableMemoryDelta(proposal) : null;
	const discussionMessages = state.discussionMessages ?? [];
	const discussionBudget = state.discussionTokenBudget;
	const targetLabel = state.target?.displayName ?? "this room";
	return (
		<div className="absorb-workspace" aria-label="Memory absorption workflow">
			<header className={`absorb-workspace-header${state.step === "discussing" ? " compact" : ""}`}>
				<div>
					<p className="card-kicker">Maintain · {targetLabel}</p>
					<h1>Learn</h1>
					<p>A focused workspace for deciding what this room keeps, updates, or clears.</p>
				</div>
				{state.step === "approving" ? (
					<button className="landing-action secondary" disabled title="The memory update is being written and cannot be cancelled.">Updating memory…</button>
				) : state.step === "assessment" || state.step === "proposal" ? null : (
					// Assessment and proposal keep a single Cancel in their action row
					// instead of a duplicate header exit.
					<button className="landing-action secondary" onClick={onAbort}>{state.step === "saved" || state.step === "unavailable" || state.step === "error" ? returnLabel : "Cancel and return"}</button>
				)}
			</header>
			<main className="absorb-workspace-main">
				<section className="checkpoint-input-card absorb-workflow-card">
				{loading ? (
					<div className="checkpoint-generating-state absorb-loading-state">
						<p className="card-kicker">Learn</p>
						<h2>{loadingMessage}</h2>
						<span className="spinner spinner-lg" />
						<p>{state.step === "assessing" && availability ? `Reading recent memory. Reviewing ${availability.recentContextEntryCount} recent ${availability.recentContextEntryCount === 1 ? "session" : "sessions"}; this usually takes a minute or two.` : "Reading recent memory. This usually takes a minute or two."}</p>
						<p>Nothing is saved yet.</p>
					</div>
				) : state.step === "unavailable" && availability ? (
					(() => {
						const copy = absorbUnavailableCopy(availability);
						return (
							<div className="checkpoint-proposal-page absorb-unavailable-state">
								<div className="checkpoint-input-heading">
									<p className="card-kicker">Learn</p>
									<h2>{copy.heading}</h2>
									<p>{copy.body}</p>
								</div>
								{copy.detail && (
									<details className="absorb-candidate-disclosure absorb-detail-disclosure">
										<summary>Technical detail</summary>
										<p>{copy.detail}</p>
									</details>
								)}
								<div className="checkpoint-preview-actions">
									<button className="landing-action secondary" onClick={onAbort}>{returnLabel}</button>
									<button className="landing-action" onClick={onRestart}>Back to Maintain</button>
								</div>
							</div>
						);
					})()
				) : state.step === "proposing" || state.step === "approving" || state.step === "signing_off" ? (
					<div className="checkpoint-generating-state absorb-loading-state">
						<p className="card-kicker">Learn</p>
						<h2>{state.step === "approving" ? "Updating memory…" : state.step === "signing_off" ? "Reading the discussion back…" : waitingMessage}</h2>
						<span className="spinner spinner-lg" />
						<p>{state.step === "approving" ? "The current memory is being archived, then replaced with the approved update." : state.step === "signing_off" ? "Your discussion is being folded into the memory update draft. Nothing is saved yet." : state.fastPathEnabled ? "Drafting the memory update. This can take a few minutes. If it passes all checks, it will be applied automatically." : "Drafting the memory update. This can take a few minutes. Nothing is saved yet."}</p>
						{state.step === "approving" && <p>This step finishes on its own and cannot be cancelled.</p>}
					</div>
				) : state.step === "saved" && state.approvalResult ? (
					<div className="checkpoint-proposal-page checkpoint-saved-page absorb-saved-state">
						<div className="checkpoint-input-heading">
							<p className="card-kicker">Learn complete</p>
							<h2>Memory updated</h2>
							<p>{targetLabel === "this room" ? "This room has folded its recent experience into deep memory." : `${targetLabel} has folded its recent experience into deep memory.`}</p>
							{state.fastPathApplied && <p className="absorb-fast-path-note">Applied automatically. Automatic memory maintenance is on for this room.</p>}
							{state.fastPathApplied && state.proposal && maintenanceWorkerNotes(state.proposal.fields.warnings) && (
								<p className="absorb-fast-path-note">Notes from the update: {maintenanceWorkerNotes(state.proposal.fields.warnings)}</p>
							)}
						</div>
						<div className="absorb-result-grid">
							{(() => {
								const remain = state.approvalResult.recentContextEntryCount;
								const before = proposal?.review?.keyMetrics.recentContextEntriesBefore ?? state.assessment?.availability.recentContextEntryCount ?? null;
								const cleared = before !== null && before >= remain ? `${before - remain} of ${before} cleared` : `${remain} remain`;
								return <div className="absorb-result-card"><span>Recent Sessions</span><strong title={`${remain} ${remain === 1 ? "entry remains" : "entries remain"}`}>{cleared}</strong></div>;
							})()}
							{stableMemoryDelta && <div className="absorb-result-card"><span>Deep Memory</span><strong>{stableMemoryDelta}</strong></div>}
							<div className="absorb-result-card"><span>Previous memory</span><strong>Archived first</strong></div>
							<div className="absorb-result-card"><span>Audit record</span><strong>Created</strong></div>
						</div>
						{proposal && (
							<div className="absorb-proposal-sections">
								<ProposalSection title="What changed" body={proposal.review?.summary || proposal.fields.primacyMap} />
								<SectionChangesDetail changes={proposal.review?.sectionChanges} fallback={proposal.fields.sectionLevelChangeLog} />
								<EntryChangesDetail changes={proposal.review?.entryChanges} fallback={proposal.fields.entryLevelDetail} />
							</div>
						)}
						{state.approvalResult.warnings.length > 0 && <div className="checkpoint-proposal-warnings">{state.approvalResult.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
						<div className="checkpoint-preview-actions">
							<button className="landing-action" onClick={onAbort}>{returnLabel}</button>
						</div>
					</div>
				) : state.step === "error" ? (
					<div className="checkpoint-proposal-page absorb-error-state">
						<div className="checkpoint-input-heading">
							<p className="card-kicker">Learn</p>
							<h2>Learning could not start</h2>
							<p>No memory was changed. You can start Maintain again right away.</p>
						</div>
						{state.error && <div className="checkpoint-proposal-error">{state.error}</div>}
						<div className="checkpoint-preview-actions">
							<button className="landing-action secondary" onClick={onAbort}>{returnLabel}</button>
							<button className="landing-action" onClick={onRestart}>Start Maintain again</button>
						</div>
					</div>
				) : state.step === "discussing" && assessment ? (
					<div className="checkpoint-proposal-page absorb-discussion-page">
						<MaintenanceDiscussion
							assessmentMarkdown={assessment.assessmentMarkdown}
							messages={discussionMessages}
							budget={discussionBudget}
							warnings={state.discussionWarnings ?? null}
							error={state.error}
							sending={Boolean(state.discussionSending)}
							emptyHint="No discussion messages yet. Ask what should be learned, preserved, cleared, or corrected."
							placeholder="Ask about what should be remembered, cleared, or corrected…"
							onSend={onSendDiscussionMessage}
							onBack={onBackToAssessment}
							onGenerate={onGenerateFromDiscussion}
						/>
					</div>
				) : proposal ? (
					<div className="checkpoint-proposal-page absorb-proposal-page">
						<div className="checkpoint-input-heading checkpoint-proposal-heading">
							<p className="card-kicker">Memory update · not saved</p>
							<h2>Review memory update</h2>
							<p>Review the high-level summary first. Nothing changes until you approve the candidate memory update for this room.</p>
						</div>
						<div className="absorb-review-strip">
							<div className={`absorb-review-status ${state.proposalStale ? "error" : validation?.valid ? "ok" : "error"}`}><span>Candidate check</span><strong>{state.proposalStale ? "Out of date" : validation?.valid ? "Ready to approve" : "Needs review"}</strong></div>
							{stableMemoryDelta && <div className="absorb-review-status"><span>Deep Memory delta</span><strong>{stableMemoryDelta}</strong></div>}
						</div>
						{proposalErrors.length > 0 && <div className="checkpoint-proposal-error">{proposalErrors.map((error) => <div key={error}>{error}</div>)}</div>}
						{state.error && <div className="checkpoint-proposal-error">{state.error}</div>}
						{proposalWarnings.length > 0 && <div className="checkpoint-proposal-warnings absorb-warning-list">{proposalWarnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
						{(state.fastPathBlockedReasons?.length ?? 0) > 0 && (
							<div className="absorb-help-note fast-path-blocked-note">
								Automatic memory maintenance is on for this room, but this proposal needs manual review because {state.fastPathBlockedReasons!.join("; ")}.
							</div>
						)}
						<div className="absorb-proposal-sections">
							<ProposalSection title="Summary" body={proposal.review?.summary || proposal.fields.primacyMap} />
							<SectionChangesDetail changes={proposal.review?.sectionChanges} fallback={proposal.fields.sectionLevelChangeLog} />
							<EntryChangesDetail changes={proposal.review?.entryChanges} fallback={proposal.fields.entryLevelDetail} />
							{proposal.fields.warnings && <ProposalDetail title="Proposal warnings" body={proposal.fields.warnings} />}
							<details className="absorb-candidate-disclosure">
								<summary>Full candidate memory rewrite</summary>
								<MarkdownPreview body={stripLeadingHtmlComments(proposal.fields.candidateL1b)} />
								<details className="absorb-raw-markdown-disclosure">
									<summary>Raw markdown</summary>
									<pre className="checkpoint-full-entry">{proposal.fields.candidateL1b}</pre>
								</details>
							</details>
						</div>
						<div className="absorb-approval-note">Approve writes the candidate memory update and archives the current memory first.</div>
						<div className="checkpoint-preview-actions">
							<button className="landing-action secondary" onClick={onAbort}>Cancel</button>
							{(state.discussionMessages?.length ?? 0) > 0 && <button className="landing-action secondary" title="Return to the discussion; the transcript is kept and only this draft is dropped" onClick={onBackToDiscussion}>Back to discussion</button>}
							<button className="landing-action secondary" title="Generate a fresh memory update from the same assessment" onClick={onGenerate}>Draft again</button>
							<button className="landing-action" disabled={!validation?.valid || state.proposalStale} title={state.proposalStale ? "This draft can no longer be applied. Draft the update again to continue." : validation?.valid ? "Approve and update long-term memory" : "Candidate memory must pass validation before approval"} onClick={onApprove}>Approve and update memory</button>
						</div>
					</div>
				) : assessment ? (
					<div className="checkpoint-proposal-page absorb-assessment-page">
						<div className="checkpoint-input-heading checkpoint-proposal-heading">
							<p className="card-kicker">Learn assessment</p>
							<h2>Recent Sessions review</h2>
							<p>{assessment.availability.recentContextEntryCount} recent sessions reviewed. Start with what can be cleared, then check what should be preserved.</p>
						</div>
						{state.error && <div className="checkpoint-proposal-error">{state.error}</div>}
						<div className="absorb-assessment-grid absorb-assessment-flow">
							<AssessmentSection title="What can be cleared from recent sessions" items={assessment.fields.whatToForget} wide />
							<AssessmentSection title="What should be preserved" items={assessment.fields.whatToRemember} wide />
							<section className="absorb-assessment-section wide">
								<h3>Where it will go in deep memory</h3>
								<div className="absorb-change-block"><strong>Deep Memory</strong><BulletList items={assessment.fields.stableMemoryChanges.deepMemory} /></div>
								<div className="absorb-change-block"><strong>Active Items</strong><BulletList items={assessment.fields.stableMemoryChanges.activeItems} /></div>
								<div className="absorb-change-block"><strong>Recent Sessions</strong><p>{assessment.fields.stableMemoryChanges.recentContext}</p></div>
							</section>
							{assessment.fields.needsJudgment.length > 0 && <AssessmentSection title="Needs your judgment" items={assessment.fields.needsJudgment} wide />}
						</div>
						{meaningfulMaintenanceWarnings(assessment.warnings).length > 0 && <div className="checkpoint-proposal-warnings">{meaningfulMaintenanceWarnings(assessment.warnings).map((warning) => <div key={warning}>{warning}</div>)}</div>}
						{state.fastPathEnabled && <div className="absorb-help-note">Automatic memory maintenance is on for this room. If the draft passes all checks, it is applied without a second review.</div>}
						<div className="checkpoint-preview-actions">
							<button className="landing-action secondary" onClick={onAbort}>Cancel</button>
							<button className="landing-action secondary" onClick={onDiscuss}>Discuss memory</button>
							<button className="landing-action" onClick={onGenerate}>Draft memory update</button>
						</div>
					</div>
				) : null}
				</section>
			</main>
		</div>
	);
}

// Shared discussion surface for the Learn and Review Memory workflows,
// styled to mirror the in-room chat (user bubbles right, rendered markdown
// left) without coupling to the room components.
function MaintenanceDiscussion({ assessmentMarkdown, messages, budget, warnings, error, sending, emptyHint, placeholder, onSend, onBack, onGenerate }: { assessmentMarkdown: string; messages: Array<{ role: string; content: string }>; budget: { state: string; canContinue: boolean } | null | undefined; warnings: string | null; error: string | null; sending: boolean; emptyHint: string; placeholder: string; onSend: (text: string) => void; onBack: () => void; onGenerate: () => void }) {
	const [input, setInput] = useState("");
	const transcriptRef = useRef<HTMLElement | null>(null);
	const canContinue = !budget || budget.canContinue;
	useEffect(() => {
		const el = transcriptRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages.length, sending]);
	function send() {
		const text = input.trim();
		if (!text || !canContinue || sending) return;
		setInput("");
		onSend(text);
	}
	return (
		<div className="absorb-discussion-panel">
			<div className="absorb-help-note">Temporary discussion. Discarded if you abort.</div>
			<details className="absorb-candidate-disclosure absorb-detail-disclosure absorb-assessment-summary">
				<summary>Initial assessment</summary>
				<MarkdownPreview body={assessmentMarkdown} />
			</details>
			{budget?.state === "soft_warning" && <div className="checkpoint-proposal-warnings">This discussion is approaching its token limit. Consider generating a proposal from the discussion soon.</div>}
			{budget?.state === "hard_stop" && <div className="checkpoint-proposal-error">This discussion reached its token limit. Generate a proposal from the current discussion or leave it.</div>}
			{warnings && <div className="checkpoint-proposal-warnings">{warnings}</div>}
			{error && <div className="checkpoint-proposal-error">{error}</div>}
			<section className="absorb-discussion-transcript" aria-label="Discussion transcript" ref={transcriptRef}>
				{messages.length === 0 && !sending ? <p className="absorb-discussion-empty">{emptyHint}</p> : <div className="absorb-discussion-messages">
					{messages.map((message, index) => (
						<div className={`absorb-discussion-message ${message.role}`} key={`${index}-${message.role}-${message.content.slice(0, 24)}`}>
							{message.role === "assistant" ? <MarkdownRenderer>{message.content}</MarkdownRenderer> : <p>{message.content}</p>}
						</div>
					))}
					{sending && <div className="absorb-discussion-message assistant pending" aria-live="polite"><span className="spinner" /> Thinking…</div>}
				</div>}
			</section>
			<div className="absorb-discussion-composer">
				<textarea
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							send();
						}
					}}
					placeholder={canContinue ? placeholder : "Discussion limit reached"}
					disabled={sending || !canContinue}
					rows={2}
				/>
				<button className="absorb-discussion-send" aria-label="Send" title={sending ? "Waiting for the reply…" : "Send"} disabled={!input.trim() || sending || !canContinue} onClick={send}>↑</button>
				<div className="absorb-discussion-actions">
					<button className="landing-action absorb-discussion-generate" disabled={sending || messages.length === 0} title={messages.length === 0 ? "Send at least one discussion message first" : "Generate a proposal from this discussion"} onClick={onGenerate}>Generate proposal</button>
					<button className="icon-btn" title="Return to the assessment; the discussion transcript is discarded" onClick={onBack}>Back to assessment</button>
				</div>
			</div>
		</div>
	);
}

// The candidate memory begins with an engine schema comment — hide it in the
// rendered view only; the raw markdown and saved bytes keep it.
function stripLeadingHtmlComments(markdown: string): string {
	return markdown.replace(/^(\s*<!--[\s\S]*?-->\s*)+/, "");
}

// Assessment bullets carry inline markdown (e.g. **must-keep** markers) —
// render it instead of showing raw asterisks.
function BulletList({ items }: { items: string[] }) {
	if (items.length === 0) return <p>None</p>;
	return <ul className="absorb-bullet-list">{items.map((item, index) => <li key={`${index}-${item}`}><MarkdownRenderer>{item}</MarkdownRenderer></li>)}</ul>;
}

function AssessmentSection({ title, items, wide = false }: { title: string; items: string[]; wide?: boolean }) {
	return (
		<section className={`absorb-assessment-section${wide ? " wide" : ""}`}>
			<h3>{title}</h3>
			<BulletList items={items} />
		</section>
	);
}

function ProposalSection({ title, body }: { title: string; body: string }) {
	return (
		<section className="absorb-proposal-section">
			<h3>{title}</h3>
			<MarkdownPreview body={body || "None"} />
		</section>
	);
}

function ProposalDetail({ title, body }: { title: string; body: string }) {
	return (
		<details className="absorb-candidate-disclosure absorb-detail-disclosure">
			<summary>{title}</summary>
			<StructuredProposalBody body={body || "None"} />
		</details>
	);
}

// The absorb parser folds the worker table's word counts into the description
// as a "Prior: N; Candidate: M. " prefix — lift it back out as a quiet delta
// line, falling back to the raw text when the prefix is absent.
function SectionChangeDescription({ description }: { description: string }) {
	const match = /^Prior:\s*([\d,]+);\s*Candidate:\s*([\d,]+)\.\s*(.*)$/.exec(description.trim());
	if (!match) return <>{description}</>;
	return (
		<>
			{match[3] || "No rationale provided."}
			<span className="absorb-count-delta">{match[1]} → {match[2]} words</span>
		</>
	);
}

function SectionChangesDetail({ changes, fallback }: { changes?: AbsorbReviewSectionChange[]; fallback: string }) {
	if (!changes?.length) return <ProposalDetail title="Section-level changes" body={fallback} />;
	return (
		<details className="absorb-candidate-disclosure absorb-detail-disclosure">
			<summary>Section-level changes</summary>
			<div className="absorb-table-wrap">
				<table className="absorb-change-table">
					<thead><tr><th>Memory area</th><th>Action</th><th>What changes</th></tr></thead>
					<tbody>{changes.map((change, index) => <tr key={`${change.section}-${index}`}><td>{change.section}</td><td><AbsorbActionBadge action={change.action} /></td><td><SectionChangeDescription description={change.description} /></td></tr>)}</tbody>
				</table>
			</div>
		</details>
	);
}

function EntryChangesDetail({ changes, fallback }: { changes?: AbsorbReviewEntryChange[]; fallback: string }) {
	if (!changes?.length) return <ProposalDetail title="Entry-level detail" body={fallback} />;
	return (
		<details className="absorb-candidate-disclosure absorb-detail-disclosure">
			<summary>Entry-level detail</summary>
			<div className="absorb-table-wrap">
				<table className="absorb-change-table">
					<thead><tr><th>Source</th><th>Action</th><th>Destination</th><th>Why</th></tr></thead>
					<tbody>{changes.map((change, index) => <tr key={`${change.sourceEntry}-${index}`}><td>{change.sourceEntry}</td><td><AbsorbActionBadge action={change.action} /></td><td>{change.targetSection || "–"}</td><td>{change.rationale}</td></tr>)}</tbody>
				</table>
			</div>
		</details>
	);
}

function AbsorbActionBadge({ action }: { action: AbsorbReviewAction }) {
	const label = absorbActionLabel(action);
	return <span className={`absorb-action-pill ${absorbActionTone(action)}`}>{label}</span>;
}

type StructuralReviewActionCluster = "remove" | "compress" | "reorganize" | "preserve" | "neutral";
type StructuralReviewActionKind = "prune" | "tighten" | "merge" | "move" | "preserve" | "reorganize" | "stale" | "create" | "split" | "rename" | "neutral";

function StructuralReviewActionBadge({ action }: { action: string }) {
	const kind = classifyStructuralReviewAction(action);
	const cluster = structuralReviewActionCluster(kind);
	return <span className={`structural-review-action-pill ${cluster}`} title={structuralReviewActionClusterLabel(cluster)}>{structuralReviewActionLabel(kind, action)}</span>;
}

function classifyStructuralReviewAction(value: string): StructuralReviewActionKind {
	const normalized = value.toLowerCase().replace(/[_.-]+/g, " ");
	if (/\b(stale|obsolete|outdated|drift(?:ed|ing)?|contradict(?:s|ed|ing|ory)?|flag(?:ged|ging)?)\b/.test(normalized)) return "stale";
	if (/\b(prun(?:e|ed|ing)|remov(?:e|ed|ing)|dropp?ed|drop|delet(?:e|ed|ing)|discard(?:ed|ing)?|clear(?:ed|ing)?|trimm?ed|trim)\b/.test(normalized)) return "prune";
	if (/\b(tighten(?:ed|ing)?|compress(?:ed|ing)?|condens(?:e|ed|ing)?|summari[sz](?:e|ed|ing)?|sharpen(?:ed|ing)?|densif(?:y|ied|ying)|reduce verbosity)\b/.test(normalized)) return "tighten";
	if (/\b(merg(?:e|ed|ing)|combin(?:e|ed|ing)|consolidat(?:e|ed|ing)|deduplicat(?:e|ed|ing)|de duplicat(?:e|ed|ing))\b/.test(normalized)) return "merge";
	if (/\b(mov(?:e|ed|ing)|relocat(?:e|ed|ing)|rehom(?:e|ed|ing)|transfer(?:red|ring)?)\b/.test(normalized)) return "move";
	if (/\b(split(?:ting)?|separat(?:e|ed|ing)|extract(?:ed|ing)?)\b/.test(normalized)) return "split";
	if (/\b(creat(?:e|ed|ing)|add(?:ed|ing)?|introduc(?:e|ed|ing)|new subsection|new area|new section)\b/.test(normalized)) return "create";
	if (/\b(renam(?:e|ed|ing)|retitl(?:e|ed|ing)|relabel(?:ed|ing)?)\b/.test(normalized)) return "rename";
	if (/\b(reorgani[sz](?:e|ed|ing)|restructur(?:e|ed|ing)|reorder(?:ed|ing)?|reshap(?:e|ed|ing))\b/.test(normalized)) return "reorganize";
	if (/\b(preserv(?:e|ed|ing)|keep(?:ing)?|kept|retain(?:ed|ing)?|maintain(?:ed|ing)?|no change|unchanged)\b/.test(normalized)) return "preserve";
	return "neutral";
}

function structuralReviewActionCluster(kind: StructuralReviewActionKind): StructuralReviewActionCluster {
	if (kind === "prune" || kind === "stale") return "remove";
	if (kind === "tighten") return "compress";
	if (kind === "merge" || kind === "move" || kind === "split" || kind === "rename" || kind === "reorganize") return "reorganize";
	if (kind === "create" || kind === "preserve") return "preserve";
	return "neutral";
}

function structuralReviewActionLabel(kind: StructuralReviewActionKind, fallback: string): string {
	if (kind === "prune") return "Remove";
	if (kind === "tighten") return "Tighten";
	if (kind === "merge") return "Merge";
	if (kind === "move") return "Move";
	if (kind === "preserve") return "Preserve";
	if (kind === "reorganize") return "Reorganize";
	if (kind === "stale") return "Flag stale";
	if (kind === "create") return "Create";
	if (kind === "split") return "Split";
	if (kind === "rename") return "Rename";
	return fallback.trim() || "Review";
}

function structuralReviewActionClusterLabel(cluster: StructuralReviewActionCluster): string {
	if (cluster === "remove") return "Remove / risk / stale";
	if (cluster === "compress") return "Compress / tighten";
	if (cluster === "reorganize") return "Reorganize / relocate";
	if (cluster === "preserve") return "Create / preserve";
	return "Neutral / unclassified";
}

function StructuredProposalBody({ body }: { body: string }) {
	const table = parseMarkdownTable(body);
	if (table) {
		return (
			<div className="absorb-table-wrap">
				<table className="absorb-change-table">
					<thead><tr>{table.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
					<tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{renderActionCell(cell)}</td>)}</tr>)}</tbody>
				</table>
			</div>
		);
	}
	return <MarkdownPreview body={body} />;
}

function StructuralReviewProposalDetail({ title, body, actionColumn }: { title: string; body: string; actionColumn: string }) {
	return (
		<details className="absorb-candidate-disclosure absorb-detail-disclosure">
			<summary>{title}</summary>
			<StructuralReviewProposalBody body={body || "None"} actionColumn={actionColumn} />
		</details>
	);
}

function StructuralReviewProposalBody({ body, actionColumn }: { body: string; actionColumn: string }) {
	const table = parseMarkdownTable(body);
	if (!table) return <MarkdownPreview body={body} />;
	const actionColumnIndex = table.headers.findIndex((header) => normalizeTableHeader(header) === normalizeTableHeader(actionColumn));
	return (
		<div className="absorb-table-wrap">
			<table className="absorb-change-table structural-review-change-table">
				<thead><tr>{table.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
				<tbody>
					{table.rows.map((row, rowIndex) => (
						<tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cellIndex === actionColumnIndex ? <StructuralReviewActionBadge action={cell} /> : renderInlineMarkdown(cell)}</td>)}</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function normalizeTableHeader(header: string): string {
	return header.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function MarkdownPreview({ body }: { body: string }) {
	const lines = body.split(/\r?\n/);
	const blocks: JSX.Element[] = [];
	let listItems: string[] = [];
	function flushList(key: string) {
		if (listItems.length === 0) return;
		blocks.push(<ul key={key}>{listItems.map((item, index) => <li key={`${index}-${item}`}>{renderInlineMarkdown(item)}</li>)}</ul>);
		listItems = [];
	}
	lines.forEach((line, index) => {
		const trimmed = line.trim();
		if (!trimmed) {
			flushList(`list-${index}`);
			return;
		}
		const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
		if (listMatch) {
			listItems.push(listMatch[1]);
			return;
		}
		flushList(`list-${index}`);
		const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
		if (headingMatch) {
			const level = Math.min(headingMatch[1].length + 3, 6);
			const Heading = `h${level}` as keyof JSX.IntrinsicElements;
			blocks.push(<Heading key={index}>{headingMatch[2]}</Heading>);
			return;
		}
		blocks.push(<p key={index}>{renderInlineMarkdown(trimmed)}</p>);
	});
	flushList("list-final");
	return <div className="absorb-markdown-preview">{blocks.length ? blocks : <p>None</p>}</div>;
}

function renderInlineMarkdown(text: string) {
	const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
	return parts.map((part, index) => part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : <span key={index}>{part}</span>);
}

function parseMarkdownTable(body: string): { headers: string[]; rows: string[][] } | null {
	const tableLines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("|") && line.endsWith("|"));
	if (tableLines.length < 3 || !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(tableLines[1])) return null;
	const parseRow = (line: string) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
	const headers = parseRow(tableLines[0]);
	const rows = tableLines.slice(2).map(parseRow).filter((row) => row.length === headers.length);
	return rows.length ? { headers, rows } : null;
}

function renderActionCell(cell: string) {
	const action = classifyAbsorbAction(cell);
	return action ? <span className={`absorb-action-pill ${action}`}>{cell}</span> : renderInlineMarkdown(cell);
}

function classifyAbsorbAction(value: string): "drop" | "promote" | "update" | null {
	const normalized = value.toLowerCase();
	if (/\b(drop|clear|remove|forget|discard)\b/.test(normalized)) return "drop";
	if (/\b(promote|preserve|keep|remember|carry forward)\b/.test(normalized)) return "promote";
	if (/\b(update|move|merge|consolidate|revise)\b/.test(normalized)) return "update";
	return null;
}

function absorbActionLabel(action: AbsorbReviewAction): string {
	if (action === "drop") return "Forget";
	if (action === "clear") return "Clear";
	if (action === "merge") return "Learn";
	if (action === "promote") return "Memorize";
	if (action === "update") return "Update memory";
	if (action === "preserve") return "Keep";
	if (action === "needs_judgment") return "Needs your judgment";
	return "No change";
}

function absorbActionTone(action: AbsorbReviewAction): "drop" | "promote" | "update" | "neutral" {
	if (action === "drop" || action === "clear") return "drop";
	if (action === "promote" || action === "preserve" || action === "merge") return "promote";
	if (action === "update" || action === "needs_judgment") return "update";
	return "neutral";
}

function formatStableMemoryDelta(proposal: AbsorbProposalResponse): string | null {
	const delta = proposal.review?.keyMetrics.stableMemoryDeltaTokens;
	if (typeof delta === "number") return `${delta >= 0 ? "+" : ""}${delta} estimated tokens`;
	return extractStableMemoryDelta(proposal.fields.compressionMetrics);
}

function extractStableMemoryDelta(compressionMetrics: string): string | null {
	const line = compressionMetrics.split(/\r?\n/).map((entry) => entry.replace(/^[-*]\s*/, "").trim()).find((entry) => /stable|l1b|memory/i.test(entry) && /delta|change|growth|shrink|reduction|tokens|chars|bytes/i.test(entry));
	return line ? line.replace(/^stable memory\s*:?\s*/i, "") : null;
}

// Matches only the server's actual concurrent-change messages; bare substrings
// like "stale" or "source" would misclassify unrelated transient errors and,
// via proposalStale, permanently disarm a perfectly applicable proposal.
function isStaleMaintenanceMessage(message: string): boolean {
	return /fingerprint changed|source is stale|proposal is stale|Recent Context entry count changed/i.test(message);
}

// Failures where retrying the same approval is guaranteed to fail again; the
// draft must be regenerated, so the Approve button is disarmed.
function isUnappliableProposalMessage(message: string): boolean {
	return isStaleMaintenanceMessage(message) || /token growth exceeds|hard limit|> 5%/i.test(message);
}

function formatAbsorbWorkflowError(message: string): string {
	if (isStaleMaintenanceMessage(message)) return "Memory changed while this workflow was open. No memory was updated. Please restart Maintain to review the latest memory state.";
	if (/token budget exceeded|token limit|hard_stop/i.test(message)) return "This discussion reached its token limit. Generate a proposal from the current discussion if possible, or abort and restart Maintain.";
	return message;
}

// The unavailable screens branch on the server's reason: the entry-count story
// is only true for missing context, and "this unlocks on its own" is false for
// profile or setup problems. The raw server message stays reachable in a
// collapsed technical-detail disclosure.
function absorbUnavailableCopy(availability: AbsorbAvailability): { heading: string; body: string; detail: string | null } {
	if (availability.reason === "insufficient_recent_context" || availability.reason === "missing_recent_context") {
		return {
			heading: "Not enough recent sessions yet",
			body: `Learning needs at least ${availability.minimumRecentContextEntries} checkpointed sessions. This room has ${availability.recentContextEntryCount}. Keep working and checkpointing; this unlocks on its own.`,
			detail: null,
		};
	}
	if (availability.reason === "not_ready") {
		return {
			heading: "Learning cannot start yet",
			body: "This room is not ready for maintenance right now. No memory was changed. Try again in a moment, or check the room on the launcher.",
			detail: availability.message || null,
		};
	}
	return {
		heading: "Learning cannot start yet",
		body: "Learning cannot run for this room right now. No memory was changed. If this persists, check the room's AI profile in AI setup.",
		detail: availability.message || availability.error || null,
	};
}

function structuralReviewUnavailableCopy(availability: StructuralReviewAvailability): { heading: string; body: string; detail: string | null } {
	if (availability.reason === "not_ready") {
		return {
			heading: "Review cannot start yet",
			body: "This room is still being set up. No memory was changed. Try again in a moment.",
			detail: availability.message || null,
		};
	}
	return {
		heading: "Review cannot start yet",
		body: "This room's memory is not in a reviewable state right now. No memory was changed. If this persists, the room may need attention outside Maintain.",
		detail: availability.message || availability.error || null,
	};
}

// Approval failures are shown on the proposal screen, so the instructions must
// point at actions that exist there (Draft again), and unmapped failures need
// the was-my-memory-changed reassurance the raw server text never gives.
function formatMaintenanceApprovalError(message: string): string {
	if (isStaleMaintenanceMessage(message)) return "Memory changed while this proposal was open. No memory was updated. Draft the update again to work from the latest memory state.";
	if (/token growth exceeds|hard limit|> 5%/i.test(message)) return "This candidate grows deep memory beyond the Review Memory safety limit. No memory was updated. Draft the update again.";
	return `The memory update could not be applied. Your memory is unchanged and this proposal is still here. Details: ${message}`;
}

function formatAbsorbApprovalError(message: string): string {
	return formatMaintenanceApprovalError(message);
}

// Draft failures land back on the assessment screen, so the copy reassures
// that the assessment survived and points at the Draft action on that screen.
function formatMaintenanceDraftError(message: string): string {
	if (isStaleMaintenanceMessage(message)) return "Memory changed while this workflow was open. No memory was updated. Restart Maintain to work from the latest memory state.";
	if (/token growth exceeds|hard limit|> 5%/i.test(message)) return "The draft grows deep memory beyond the safety limit. No memory was updated. You can draft again.";
	return `The memory update draft could not be generated. No memory was updated and your assessment is untouched. Details: ${message}`;
}

function formatStructuralReviewWorkflowError(message: string): string {
	if (isStaleMaintenanceMessage(message)) return "Memory changed while this workflow was open. No memory was updated. Please restart Maintain to review the latest memory state.";
	if (/token growth exceeds|hard limit|> 5%/i.test(message)) return "This candidate grows deep memory beyond the Review Memory safety limit. No memory was updated.";
	if (/token budget exceeded|token limit|hard_stop/i.test(message)) return "This discussion reached its token limit. Generate a proposal from the current discussion if possible, or abort and restart Maintain.";
	return message;
}

function CheckpointPreviewShell({ chat, itemCount, rememberText, density, proposal, loading, error, approvalLoading, approvalError, approvalResult, quickRequested, quickBlockedReasons, consultRunning, taskRunning, pendingConsultHandoffCount, pendingTaskHandoffCount, onRememberTextChange, onDensityChange, onGenerate, onApprove, onDiscard, onContinueAfterCheckpoint, onRestAfterCheckpoint, onClose }: { chat: NonNullable<PersistentChatConfig>; itemCount: number; rememberText: string; density: CheckpointDensity; proposal: CheckpointProposalResponse | null; loading: boolean; error: string | null; approvalLoading: boolean; approvalError: string | null; approvalResult: CheckpointApprovalResponse | null; quickRequested: boolean; quickBlockedReasons: string[] | null; consultRunning: boolean; taskRunning: boolean; pendingConsultHandoffCount: number; pendingTaskHandoffCount: number; onRememberTextChange: (text: string) => void; onDensityChange: (density: CheckpointDensity) => void; onGenerate: () => void; onApprove: (approvedRecentContext: string) => void; onDiscard: () => void; onContinueAfterCheckpoint: () => void; onRestAfterCheckpoint: () => void; onClose: () => void }) {
	const [showFullEntry, setShowFullEntry] = useState(false);
	const [editing, setEditing] = useState(false);
	const [approvedFields, setApprovedFields] = useState<CheckpointApprovalEditFields>({ sessionArc: "", body: "", parked: "None" });
	useEscapeKey(() => {
		if (editing) setEditing(false);
		else onClose();
	}, !approvalLoading);
	useEffect(() => {
		setShowFullEntry(false);
		setEditing(false);
		setApprovedFields({
			sessionArc: proposal?.fields.sessionArc ?? "",
			body: proposal?.fields.body ?? "",
			parked: proposal?.fields.parked?.trim() || "None",
		});
	}, [proposal]);
	const approvedDraft = proposal ? buildApprovedRecentContextMarkdown(proposal, approvedFields) : "";
	// Rendered review view: the draft without its RC-DRAFT header line — that
	// line is engine framing; the saved entry (approvedDraft) keeps it.
	const renderedDraft = approvedDraft.split(/\r?\n/).slice(1).join("\n").trim();
	const displayWarnings = proposal ? meaningfulMaintenanceWarnings(proposal.warnings) : [];
	const approvalReady = Boolean(approvedFields.sessionArc.trim() && approvedFields.body.trim() && approvedFields.parked.trim());
	function updateApprovedField(field: keyof CheckpointApprovalEditFields, value: string) {
		setApprovedFields((current) => ({ ...current, [field]: value }));
	}
	function confirmDiscard() {
		const ok = window.confirm("Discard this memory proposal?\n\nIt has not been saved. If you discard it, you return to the active thread and the proposal is lost.");
		if (ok) onDiscard();
	}
	// Consult MR-5 checkpoint-time honesty (§2.3): one-line notices, NOT gates —
	// they never block the checkpoint, they just tell the truth about consults.
	const consultHonestyNotices: string[] = [];
	if (consultRunning) consultHonestyNotices.push("A consult is still running; the checkpoint will discard it.");
	// Task parity (visuals V6): unlike a discarded consult, a task's files persist —
	// the honest copy says what is and is not lost. The consult line below is the
	// §2.3 locked verbatim string; the queue holds both block kinds, so each kind
	// gets its own line.
	if (taskRunning) consultHonestyNotices.push("A specialist task is still running; its result won't be in this checkpoint (artifacts already written stay on disk).");
	if (pendingConsultHandoffCount > 0) consultHonestyNotices.push("A transferred consult hasn't entered memory yet; it will carry into the fresh conversation.");
	if (pendingTaskHandoffCount > 0) consultHonestyNotices.push("A transferred task result hasn't entered memory yet; it will carry into the fresh conversation.");
	const honestyNoticesNode = consultHonestyNotices.length > 0 ? (
		<div className="checkpoint-consult-notices" role="status">
			{consultHonestyNotices.map((notice) => <div key={notice}>{notice}</div>)}
		</div>
	) : null;
	return (
		<div className="checkpoint-preview-backdrop" role="dialog" aria-modal="true" aria-label="Checkpoint proposal">
			<section className="checkpoint-input-card">
				{loading ? (
					<div className="checkpoint-generating-state">
						<span className="spinner" />
						<p className="card-kicker">Checkpoint</p>
						<h2>Drafting memory proposal…</h2>
						<p>This conversation is being compressed into a proposed memory entry. Nothing is saved yet.</p>
					</div>
				) : quickRequested && !quickBlockedReasons?.length && approvalLoading && !approvalResult ? (
					<div className="checkpoint-generating-state">
						<span className="spinner" />
						<p className="card-kicker">Checkpoint</p>
						<h2>Saving memory…</h2>
						<p>The proposal came back clean, so it is being saved to {chat.displayName}’s Recent Context.</p>
					</div>
				) : approvalResult ? (
					<div className="checkpoint-proposal-page checkpoint-saved-page">
						<div className="checkpoint-input-heading">
							<p className="card-kicker">Checkpoint saved</p>
							<h2>Memory updated</h2>
							<p>This conversation is now part of {chat.displayName}’s memory. You can pick up right where you left off.</p>
						</div>
						{approvalResult.warnings.length > 0 && <div className="checkpoint-proposal-warnings">{approvalResult.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
						<div className="checkpoint-preview-actions">
							<button className="landing-action secondary" onClick={onRestAfterCheckpoint}>Return Home</button>
							<button className="landing-action" onClick={onContinueAfterCheckpoint}>Continue working</button>
						</div>
					</div>
				) : proposal ? (
					<div className="checkpoint-proposal-page">
						<div className="checkpoint-input-heading checkpoint-proposal-heading">
							<p className="card-kicker">Memory proposal · not saved</p>
							<h2>Review what {chat.displayName} will remember</h2>
						</div>
						{(quickBlockedReasons?.length ?? 0) > 0 && (
							<div className="absorb-help-note fast-path-blocked-note">
								Not saved automatically. This proposal needs your review because {quickBlockedReasons!.join("; ")}. Review the entry below, then approve or discard it.
							</div>
						)}
						<div className="checkpoint-proposal-result standalone">
							{!editing && (
								<div className="checkpoint-proposal-summary">
									<h3 className="checkpoint-entry-title">{proposal.preview.title}</h3>
									<div className="checkpoint-proposal-arc"><MarkdownRenderer>{proposal.preview.summary}</MarkdownRenderer></div>
									{proposal.preview.keyPoints.length > 0 && (
										<ul>
											{proposal.preview.keyPoints.map((point, index) => <li key={`${index}-${point}`}><MarkdownRenderer>{point}</MarkdownRenderer></li>)}
										</ul>
									)}
								</div>
							)}
							<div className="checkpoint-input-meta subtle">
								{proposal.preview.hasParkedItems && <span>includes parked items</span>}
								<span>~{proposal.estimatedTokens} tokens</span>
							</div>
							{editing ? (
								<div className="checkpoint-edit-field checkpoint-structured-editor">
									<span className="checkpoint-field-label">Edit the entry before saving</span>
									<label>
										<span>Session arc</span>
										<textarea value={approvedFields.sessionArc} onChange={(e) => updateApprovedField("sessionArc", e.target.value)} rows={4} />
									</label>
									<label>
										<span>Body</span>
										<textarea value={approvedFields.body} onChange={(e) => updateApprovedField("body", e.target.value)} rows={14} />
									</label>
									<label>
										<span>Parked / Open items</span>
										<textarea value={approvedFields.parked} onChange={(e) => updateApprovedField("parked", e.target.value)} rows={5} />
									</label>
									<button className="inline-action" onClick={() => setEditing(false)}>Done editing</button>
								</div>
							) : showFullEntry ? (
								<div className="checkpoint-full-review">
									<div className="checkpoint-review-actions">
										<button className="inline-action" onClick={() => setShowFullEntry(false)}>Hide full entry</button>
										<button className="inline-action" onClick={() => setEditing(true)}>Edit</button>
									</div>
									<div className="checkpoint-full-entry checkpoint-full-entry-rendered">
										<MarkdownRenderer>{renderedDraft}</MarkdownRenderer>
									</div>
								</div>
							) : (
								<button className="inline-action checkpoint-full-entry-trigger" onClick={() => setShowFullEntry(true)}>Show full entry</button>
							)}
							{displayWarnings.length > 0 && <div className="checkpoint-proposal-warnings">{displayWarnings.map((warning) => <div key={warning}>{warning}</div>)}</div>}
							{approvalError && <div className="checkpoint-proposal-error">{approvalError}</div>}
						</div>
						{honestyNoticesNode}
						<div className="checkpoint-preview-actions">
							<button className="landing-action secondary" disabled={approvalLoading} onClick={confirmDiscard}>Discard</button>
							<button className="landing-action" disabled={approvalLoading || !approvalReady} onClick={() => onApprove(approvedDraft)}>{approvalLoading ? "Saving…" : "Save to memory"}</button>
						</div>
					</div>
				) : (
					<>
						<div className="checkpoint-input-heading">
							<p className="card-kicker">Checkpoint</p>
							<h2>What should carry forward?</h2>
							<p>Choose how much to keep, and add anything specific you want this room to remember from this thread.</p>
						</div>
						<div className="checkpoint-density-group" aria-label="How much should this room keep?">
							<div className="checkpoint-field-label">How much should this room keep?</div>
							<div className="checkpoint-density-options">
								{CHECKPOINT_DENSITY_OPTIONS.map((option) => (
									<button key={option.id} className={`checkpoint-density-option ${density === option.id ? "selected" : ""}`} onClick={() => onDensityChange(option.id)}>
										<strong>{option.label}</strong>
										<span>{option.budget}</span>
									</button>
								))}
							</div>
						</div>
						<label className="checkpoint-remember-field">
							<div className="checkpoint-field-row">
								<span className="checkpoint-field-label">What do you want to remember?</span>
								<em>{rememberText.length}/{CHECKPOINT_REMEMBER_MAX_CHARS}</em>
							</div>
							<textarea
								value={rememberText}
								maxLength={CHECKPOINT_REMEMBER_MAX_CHARS}
								onChange={(e) => onRememberTextChange(e.target.value.slice(0, CHECKPOINT_REMEMBER_MAX_CHARS))}
								placeholder="Optional. Add the key nuance, decision, or thread that should not be lost."
								rows={4}
							/>
						</label>
						{error && <div className="checkpoint-proposal-error">{error}</div>}
						{honestyNoticesNode}
						<div className="checkpoint-preview-actions">
							<button className="landing-action secondary" onClick={onClose}>Close</button>
							<button className="landing-action" disabled={itemCount === 0} onClick={onGenerate}>Generate memory proposal</button>
						</div>
					</>
				)}
			</section>
		</div>
	);
}


function CheckpointSplitButton({ hasUserInput, inFlight, onQuickCheckpoint, onOpenFullCheckpoint }: { hasUserInput: boolean; inFlight: boolean; onQuickCheckpoint: () => void; onOpenFullCheckpoint: () => void }) {
	const [menuOpen, setMenuOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!menuOpen) return;
		function onPointerDown(event: PointerEvent) {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenuOpen(false);
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") setMenuOpen(false);
		}
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [menuOpen]);
	const checkpointTitle = inFlight ? "Stop or wait for the current response before checkpointing" : hasUserInput ? "Save this conversation to memory. Applies automatically when the proposal is warning-free" : "Send a message before checkpointing";
	return (
		<div className="checkpoint-split" ref={rootRef}>
			<button className="icon-btn checkpoint-split-main" title={checkpointTitle} disabled={!hasUserInput || inFlight} onClick={() => { setMenuOpen(false); onQuickCheckpoint(); }}>Checkpoint</button>
			<button className="icon-btn checkpoint-split-toggle" title="More memory actions" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="More memory actions" disabled={inFlight} onClick={() => setMenuOpen((open) => !open)}>▾</button>
			{menuOpen && (
				<div className="checkpoint-split-menu" role="menu">
					<button role="menuitem" title={hasUserInput ? "Choose summary density and add a steering note, then review before saving" : "Send a message before checkpointing"} disabled={!hasUserInput} onClick={() => { setMenuOpen(false); onOpenFullCheckpoint(); }}>Checkpoint with options…</button>
				</div>
			)}
		</div>
	);
}

export function App() {
	const [view, setView] = useState<MainView>("home");
	const [theme, setTheme] = useState<ThemeMode>(() => {
		try {
			const saved = localStorage.getItem("exxperts.theme");
			return saved === "light" || saved === "dark" ? saved : "dark";
		} catch {
			return "dark";
		}
	});
	const [items, setItems] = useState<ChatItem[]>([]);
	const [composerResetNonce, setComposerResetNonce] = useState(0);
	// V6 iterate affordance: a one-shot composer prefill. Set together with a
	// nonce bump (the composer re-seeds its draft from initialDraftValue on a
	// nonce change); cleared by every OTHER nonce bump site so a stale prefill
	// never resurrects after send/reset.
	const [composerPrefill, setComposerPrefill] = useState("");
	const [connected, setConnected] = useState(false);
	const [busy, setBusy] = useState(false);
	const [turnCancelling, setTurnCancelling] = useState(false);
	const [turnInterruptedNote, setTurnInterruptedNote] = useState<string | null>(null);
	const [sessionVersion, setSessionVersion] = useState(0);
	const [usage, setUsage] = useState<SessionUsage>(ZERO_USAGE);
	const [contextHealth, setContextHealth] = useState<ContextHealthStatus | null>(null);
	const [helpOpen, setHelpOpen] = useState(false);
	// V5: the right pane is a single slot with two possible occupants — the
	// approval preview and the artifact viewer. One state value = last-click-wins
	// by construction; the pane header always names the occupant.
	type RightPaneOccupant =
		| { kind: "preview"; data: ApprovalPreviewData }
		| { kind: "artifactViewer"; taskId: string; templateLabel: string; artifact: { relativePath: string; extension: string }; asset?: AssetRowView }
		// The run view (status grammar, 2026-07-18): the live task's stream in the
		// same pane slot; renders from taskState and swaps to the artifact viewer
		// in place when the run ends.
		| { kind: "taskRun"; taskId: string };
	const [rightPane, setRightPane] = useState<RightPaneOccupant | null>(null);
	// Synchronous mirror for the WS handlers (toast suppression / run-view swap
	// read the pane at event time, not at closure-capture time).
	const rightPaneRef = useRef<RightPaneOccupant | null>(null);
	rightPaneRef.current = rightPane;
	const [artifactMaximized, setArtifactMaximized] = useState(false);
	const [exportNotice, setExportNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
	// The done-moment toast (status grammar, 2026-07-18): fires once when a task
	// ends and nothing else is already showing the result; top-right, ~6 s,
	// click opens the viewer. The rail's green dot is the durable signal.
	const [taskDoneToast, setTaskDoneToast] = useState<{ taskId: string; title: string; kind: "done" | "error"; templateLabel: string; artifact: { relativePath: string; extension: string } | null } | null>(null);
	const [exportCollision, setExportCollision] = useState<ExportCollision | null>(null);
	// Remove-from-list Undo window: one toast, one removable row at a time.
	const [removeNotice, setRemoveNotice] = useState<{ taskId: string } | null>(null);
	// Assets panel (contract §2 rung 3): the thread's ledger rows, refetched on
	// every event that can change them — server truth, no client cache.
	const [assetLedgerRows, setAssetLedgerRows] = useState<AssetLedgerRowInput[]>([]);
	const [assetDeleteConfirm, setAssetDeleteConfirm] = useState<AssetRowView | null>(null);
	// Store-wide GC (contract §4): assessed once per app load; the safety valve
	// stays silent below its threshold.
	const [gcAssessment, setGcAssessment] = useState<TaskStoreGcView | null>(null);
	const [gcReviewOpen, setGcReviewOpen] = useState(false);
	const [gcBusy, setGcBusy] = useState(false);
	useEffect(() => {
		void (async () => {
			try {
				const res = await apiFetch("/api/task-store/gc");
				if (!res.ok) return;
				const data = await res.json().catch(() => null);
				if (data?.proposal) setGcAssessment(data);
			} catch {
				// The valve is best-effort; the next app load re-assesses.
			}
		})();
	}, []);
	// Low-churn shim: the existing preview call sites keep working unchanged.
	const preview = rightPane?.kind === "preview" ? rightPane.data : null;
	const setPreview = (data: ApprovalPreviewData | null) => setRightPane(data ? { kind: "preview", data } : null);

	// Escape closes the artifact/run pane, the keyboard twin of clicking its X
	// or the selected rail row. A maximized pane restores first (one Escape per
	// step), and any open dialog above the pane (delete confirm, export
	// collision) owns Escape until dismissed — one Escape, one layer.
	useEffect(() => {
		const paneOpen = rightPane?.kind === "artifactViewer" || rightPane?.kind === "taskRun";
		if (!paneOpen || assetDeleteConfirm || exportCollision) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			if (artifactMaximized) setArtifactMaximized(false);
			else setRightPane(null);
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [rightPane, artifactMaximized, assetDeleteConfirm, exportCollision]);
	const [conversationId, setConversationId] = useState<string>(() => newConversationId());
	const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
	const [modelStatus, setModelStatus] = useState<WebChatModelStatus | null>(null);
	const [aiProfileStatus, setAiProfileStatus] = useState<PersistentAgentAiProfileSelectionStatus | null>(null);
	const [persistentAgentStatuses, setPersistentAgentStatuses] = useState<PersistentAgentStatus[]>([]);
	const [persistentAgentStatus, setPersistentAgentStatus] = useState<PersistentAgentStatus | null>(null);
	const [persistentThread, setPersistentThread] = useState<PersistentAgentThread | null>(null);
	const [persistentChat, setPersistentChat] = useState<PersistentChatConfig>(null);
	const [persistentResumeError, setPersistentResumeError] = useState<string | null>(null);
	const [currentModelLabel, setCurrentModelLabel] = useState<string>("");
	const [checkpointPreviewOpen, setCheckpointPreviewOpen] = useState(false);
	const [checkpointRememberText, setCheckpointRememberText] = useState("");
	const [checkpointDensity, setCheckpointDensity] = useState<CheckpointDensity>("standard");
	const [checkpointProposal, setCheckpointProposal] = useState<CheckpointProposalResponse | null>(null);
	const [checkpointProposalLoading, setCheckpointProposalLoading] = useState(false);
	const [checkpointProposalError, setCheckpointProposalError] = useState<string | null>(null);
	const [checkpointApprovalLoading, setCheckpointApprovalLoading] = useState(false);
	const [checkpointApprovalError, setCheckpointApprovalError] = useState<string | null>(null);
	const [checkpointApprovalResult, setCheckpointApprovalResult] = useState<CheckpointApprovalResponse | null>(null);
	const [checkpointQuickRequested, setCheckpointQuickRequested] = useState(false);
	const [checkpointQuickBlockedReasons, setCheckpointQuickBlockedReasons] = useState<string[] | null>(null);
	const [maintainChooserOpen, setMaintainChooserOpen] = useState(false);
	const [maintainTarget, setMaintainTarget] = useState<MaintainTarget | null>(null);
	// Where Maintain was launched from; exits return there instead of always
	// dumping the user on the launcher.
	const [maintainOrigin, setMaintainOrigin] = useState<"home" | "memory">("home");
	const maintainReturnLabel = maintainOrigin === "memory" ? "Return to Memory" : "Return to launcher";
	const [maintainConfirm, setMaintainConfirm] = useState<MaintainConfirm | null>(null);
	const [absorbWorkflow, setAbsorbWorkflow] = useState<AbsorbWorkflowState>(CLOSED_ABSORB_WORKFLOW);
	const [structuralReviewWorkflow, setStructuralReviewWorkflow] = useState<StructuralReviewWorkflowState>(CLOSED_STRUCTURAL_REVIEW_WORKFLOW);
	// Cancelling a Maintain workflow must actually stick: every async continuation
	// captures the run counter at request start and drops its state write when a
	// reset bumped it in the meantime (otherwise a slow LLM response reopens the
	// full-screen workspace, and fast-path could even write memory after cancel).
	const maintainRunRef = useRef(0);
	const [absorbLoadingIndex, setAbsorbLoadingIndex] = useState(0);
	const [absorbWaitingIndex, setAbsorbWaitingIndex] = useState(0);
	const [structuralReviewWaitingIndex, setStructuralReviewWaitingIndex] = useState(0);
	const [structuralReviewLoadingIndex, setStructuralReviewLoadingIndex] = useState(0);
	const [rightPaneWidth, setRightPaneWidth] = useState<number>(() => {
		try {
			const raw = localStorage.getItem(KNOWLEDGE_PANE_WIDTH_STORAGE_KEY);
			const parsed = raw ? Number(raw) : NaN;
			if (Number.isFinite(parsed) && parsed > 0) return clampRightPaneWidth(parsed);
		} catch {}
		return getDefaultKnowledgePaneWidth();
	});
	const [resizingRightPane, setResizingRightPane] = useState(false);
	// Only a real divider drag makes the width a preference worth keeping;
	// defaults and window-resize clamps are not the user speaking.
	const rightPaneUserSizedRef = useRef(false);
	// Drag anchor: pointer x and the pane's RENDERED width at mousedown, so the
	// divider tracks the grab point instead of jumping to the pointer, and so a
	// grid-clamped pane (rendered narrower than state) resizes from where it is.
	const rightPaneDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
	const persistTimerRef = useRef<number | null>(null);

	const wsRef = useRef<WebSocket | null>(null);
	const busyRef = useRef(busy);
	const turnCancellingRef = useRef(turnCancelling);
	const turnInterruptedNoteRef = useRef<string | null>(turnInterruptedNote);
	const toolByIdRef = useRef<Map<string, string>>(new Map());
	const hiddenRoutineToolByIdRef = useRef<Map<string, { name: string; args: any }>>(new Map());
	const retrievalActivityIdRef = useRef<string | null>(null);
	const itemsRef = useRef(items);
	// All assistant text flows through one explicit state machine — see
	// assistant-stream.ts. The refs here are only the host glue: the machine
	// state, the scheduled tick handle, and the transient system lines the
	// retry flow swaps in and out.
	const streamStateRef = useRef<AssistantStreamState>(createAssistantStreamState());
	const revealPacingRef = useRef<RevealPacing>(readRevealPacing());
	// The consult (DelegationCard) client state machine — see consult-stream.ts.
	// The ref is the source of truth the WS closures read; the state drives the
	// docked card / folded pill render.
	const [consultState, setConsultState] = useState<ConsultState>(createConsultState);
	const consultStateRef = useRef<ConsultState>(consultState);
	// The specialist-task card state machine (visuals V4) — see task-stream.ts.
	const [taskState, setTaskState] = useState<TaskState>(createTaskState);
	const taskStateRef = useRef<TaskState>(taskState);
	// Iterate chip-chat (§5 amendment): pending = the frame is out and the
	// approval card / launch is in flight; notice = the last ok:false reason.
	// Both reset when the fresh task's task_started supersedes the card.
	const [taskIteratePending, setTaskIteratePending] = useState(false);
	const [taskIterateNotice, setTaskIterateNotice] = useState<string | null>(null);
	// Consult MR-5 pending-transfer queue (§2, §2.3): handoff blocks that ride the
	// user's NEXT prompt (not a memory-write path — the block enters the session
	// JSONL like any user text). The ref is the synchronous source the send path
	// reads; `pendingConsultItemIds` tracks which transferred thread items still
	// show the "included with your next message" hint until a send consumes them.
	const [pendingHandoffs, setPendingHandoffs] = useState<string[]>([]);
	const pendingHandoffsRef = useRef<string[]>(pendingHandoffs);
	const [pendingConsultItemIds, setPendingConsultItemIds] = useState<ReadonlySet<string>>(() => new Set());
	const pendingConsultItemIdsRef = useRef<ReadonlySet<string>>(pendingConsultItemIds);
	function applyPendingHandoffs(blocks: string[], itemIds: ReadonlySet<string>): void {
		pendingHandoffsRef.current = blocks;
		pendingConsultItemIdsRef.current = itemIds;
		setPendingHandoffs(blocks);
		setPendingConsultItemIds(itemIds);
	}
	const streamTickRafRef = useRef<number | null>(null);
	const streamTickTimerRef = useRef<number | null>(null);
	const streamErrorLineIdRef = useRef<string | null>(null);
	const retryNoticeIdRef = useRef<string | null>(null);
	const persistentChatRef = useRef<PersistentChatConfig>(persistentChat);
	// The projected asset rows, mirrored for callbacks created before the memo
	// (openArtifactViewer attaches the row to whatever entry path opened it).
	const assetRowsRef = useRef<AssetRowView[]>([]);
	// Assets panel data: fetch the room-wide REST list (room-scoped history,
	// 2026-07-18 grill: rows survive Memento and checkpoint — both only mint a
	// new conversation). The stale-guard is per-room; a thread switch within the
	// same room keeps the rows it already has.
	const refreshAssetRows = useCallback(async () => {
		const chat = persistentChatRef.current;
		if (!chat) {
			setAssetLedgerRows([]);
			return;
		}
		try {
			const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(chat.agentId)}/tasks`);
			if (!res.ok) return;
			const data = await res.json().catch(() => null);
			const current = persistentChatRef.current;
			if (!current || current.agentId !== chat.agentId) return;
			setAssetLedgerRows(Array.isArray(data?.tasks) ? data.tasks : []);
		} catch {
			// Panel data is best-effort; the next trigger refetches.
		}
	}, []);
	// First-open stamp: the green unread dot decays exactly once. Optimistic —
	// the local row flips immediately; the POST makes it durable. Idempotent on
	// both sides, so every open/act path may call it unconditionally.
	const markAssetRowViewed = useCallback((taskId: string) => {
		const chat = persistentChatRef.current;
		if (!chat || !taskId) return;
		setAssetLedgerRows((rows) => rows.map((row: AssetLedgerRowInput) => (row.taskId === taskId && !row.viewedAt ? { ...row, viewedAt: new Date().toISOString() } : row)));
		void apiFetch(`/api/persistent-agents/${encodeURIComponent(chat.agentId)}/tasks/${encodeURIComponent(taskId)}/viewed`, { method: "POST" }).catch(() => {
			// Best-effort: an unreached stamp just means the dot returns next load.
		});
	}, []);
	// Rows clear only when the ROOM changes — a Memento/checkpoint swaps the
	// conversation but the room history stays put (no blank-and-refill flash).
	const assetsPanelAgentRef = useRef<string | null>(null);
	useEffect(() => {
		if ((persistentChat?.agentId ?? null) !== assetsPanelAgentRef.current) {
			assetsPanelAgentRef.current = persistentChat?.agentId ?? null;
			setAssetLedgerRows([]);
		}
		// This effect is declared before the ref-sync effect below — sync the ref
		// here too (idempotent) so the fetch sees the room we just switched to.
		persistentChatRef.current = persistentChat;
		if (persistentChat) void refreshAssetRows();
	}, [persistentChat, refreshAssetRows]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const workbenchRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		try { localStorage.setItem("exxperts.theme", theme); } catch {}
	}, [theme]);

	useEffect(() => {
		refreshAuthStatus();
		refreshModelStatus();
		refreshAiProfileStatus();
		refreshPersistentAgentStatus();
		// Refresh room statuses (incl. lock state) when returning to the window,
		// so a room locked/freed from the CLI reflects without a manual reload.
		const onFocus = () => { void refreshPersistentAgentStatus(); };
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);

	async function refreshAuthStatus() {
		try {
			const status = await apiFetch("/api/auth/status").then((r) => r.json()) as AuthStatusResponse;
			setAuthStatus(status);
		} catch {}
	}

	async function refreshModelStatus() {
		try {
			const status = await apiFetch("/api/persistent-agent-room/model-status").then((r) => r.json()) as WebChatModelStatus;
			setModelStatus(status);
		} catch {}
	}

	async function refreshAiProfileStatus() {
		try {
			const status = await apiFetch("/api/persistent-agent-ai-profile").then((r) => r.json()) as PersistentAgentAiProfileSelectionStatus;
			setAiProfileStatus(status);
		} catch {}
	}

	async function selectAiProfile(profileId: string) {
		const res = await apiFetch("/api/persistent-agent-ai-profile", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ profileId }),
		});
		if (!res.ok) {
			let message = `Failed to select AI profile (${res.status})`;
			try {
				const body = await res.json();
				if (body?.error) message = String(body.error);
			} catch {}
			throw new Error(message);
		}
		setAiProfileStatus(await res.json() as PersistentAgentAiProfileSelectionStatus);
		await refreshModelStatus();
	}

	async function persistentAgentResponseError(res: Response, fallback: string): Promise<Error> {
		let message = fallback;
		try {
			const body = await res.json();
			if (body?.error) message = String(body.error);
		} catch {}
		return new Error(message);
	}

	async function fetchPersistentAgentThread(agentId: PersistentAgentId, threadId: string): Promise<PersistentAgentThreadRecord> {
		const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`);
		if (!res.ok) throw await persistentAgentResponseError(res, `Failed to load persistent-agent thread (${res.status})`);
		const body = await res.json() as { thread: PersistentAgentThreadRecord };
		return body.thread;
	}

	async function savePersistentAgentThread(thread: PersistentAgentThread | NonNullable<PersistentChatConfig>, state: "active" | "standby", origin: PersistentAgentThreadOrigin, nextItems: ChatItem[] = [], pendingHandoffs?: string[]): Promise<PersistentAgentThreadRecord> {
		// Consult MR-5: `pendingHandoffs` is preserve-if-absent on the server — only
		// the callers that own the current room's queue pass it (send/transfer via
		// the debounced persist, the boundary carries/clears). Reconciliation saves
		// for other threads omit it, so they never clobber a stored queue.
		const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(thread.agentId)}/threads/${encodeURIComponent(thread.conversationId)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ state, origin, model: thread.model, items: nextItems, ...(pendingHandoffs !== undefined ? { pendingHandoffs } : {}) }),
		});
		if (!res.ok) throw await persistentAgentResponseError(res, `Failed to save persistent-agent thread (${res.status})`);
		const body = await res.json() as { thread: PersistentAgentThreadRecord; runtime: PersistentAgentStatus["runtime"] };
		applyPersistentRuntime(thread.agentId, body.runtime);
		return body.thread;
	}

	async function setPersistentRuntimeIdle(agentId: PersistentAgentId): Promise<void> {
		const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/runtime`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ state: "idle" }),
		});
		if (!res.ok) throw new Error(`Failed to update persistent-agent runtime (${res.status})`);
		const body = await res.json() as { runtime: PersistentAgentStatus["runtime"] };
		applyPersistentRuntime(agentId, body.runtime);
	}

	async function discardPersistentAgentThread(agentId: PersistentAgentId, threadId: string): Promise<void> {
		if (persistTimerRef.current) {
			window.clearTimeout(persistTimerRef.current);
			persistTimerRef.current = null;
		}
		const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
		if (!res.ok) throw new Error(`Failed to discard persistent-agent thread (${res.status})`);
		const body = await res.json() as { runtime: PersistentAgentStatus["runtime"] };
		applyPersistentRuntime(agentId, body.runtime);
	}

	async function discardEmptyPreparedBoundaryThread(agentId: PersistentAgentId, threadId: string): Promise<void> {
		if (persistTimerRef.current) {
			window.clearTimeout(persistTimerRef.current);
			persistTimerRef.current = null;
		}
		const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/runtime/discard-empty-prepared-boundary`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ threadId }),
		});
		if (!res.ok) throw await persistentAgentResponseError(res, `Failed to retire empty prepared boundary (${res.status})`);
		const body = await res.json() as { runtime: PersistentAgentStatus["runtime"] };
		applyPersistentRuntime(agentId, body.runtime);
	}

	async function applyPersistentAgentMemento(agentId: PersistentAgentId, conversationId: string): Promise<PersistentAgentMementoBoundaryResponse> {
		if (persistTimerRef.current) {
			window.clearTimeout(persistTimerRef.current);
			persistTimerRef.current = null;
		}
		const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/memento`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ conversationId }),
		});
		if (!res.ok) throw await persistentAgentResponseError(res, `Failed to apply Memento (${res.status})`);
		return await res.json() as PersistentAgentMementoBoundaryResponse;
	}

	// Room exit: leaving the persistent-agent room experience for the launcher.
	async function closePersistentAgentRoom(thread: PersistentAgentThread, origin: PersistentAgentThreadOrigin): Promise<PersistentAgentThread | null> {
		if (hasUserInput(thread.items) || hasUserVisibleTurn(thread.items)) {
			const standbyThread: PersistentAgentThread = { ...thread, state: "standby" };
			setPersistentThread(standbyThread);
			// Carry the pending-transfer queue into standby so a resume re-queues it.
			await savePersistentAgentThread(standbyThread, "standby", origin, standbyThread.items, pendingHandoffsRef.current);
			return standbyThread;
		}
		const statuses = await fetchPersistentAgentStatuses();
		const status = statuses.find((candidate) => candidate.id === thread.agentId) ?? null;
		const activeThreadMatches = status?.runtime.activeThreadId === thread.conversationId;
		const preparedBoundary = activeThreadMatches
			? status.activeThread?.preparedByBoundary ?? (status.activeThread?.preparedByCheckpoint ? "checkpoint" : null)
			: null;
		const hasPreparedBoundaryPrefix = thread.conversationId.startsWith("postcp_") || thread.conversationId.startsWith("postmem_");
		if (activeThreadMatches && (preparedBoundary || hasPreparedBoundaryPrefix)) {
			await discardEmptyPreparedBoundaryThread(thread.agentId, thread.conversationId);
			setPersistentThread(null);
			return null;
		}
		await discardPersistentAgentThread(thread.agentId, thread.conversationId);
		setPersistentThread(null);
		return null;
	}

	async function refreshPersistentAgentStatus() {
		try {
			const statuses = await fetchPersistentAgentStatuses();
			const activeStatuses = Array.isArray(statuses) ? statuses : [];
			setPersistentAgentStatuses(activeStatuses);
			const primaryStatus = activeStatuses[0] ?? null;
			setPersistentAgentStatus(primaryStatus);
			if (persistentChat) return;
			const currentThreadStatus = persistentThread ? activeStatuses.find((candidate) => candidate.id === persistentThread.agentId) ?? null : null;
			const resumableStatus = currentThreadStatus ?? activeStatuses.find((candidate) => (candidate.runtime.state === "standby" || candidate.runtime.state === "active") && !!candidate.runtime.activeThreadId) ?? null;
			if (!resumableStatus) {
				if (persistentThread) setPersistentThread(null);
				return;
			}
			if ((resumableStatus.runtime.state === "standby" || resumableStatus.runtime.state === "active") && resumableStatus.runtime.activeThreadId && (!persistentThread || persistentThread.agentId === resumableStatus.id)) {
				const record = await fetchPersistentAgentThread(resumableStatus.id, resumableStatus.runtime.activeThreadId);
				const localThread = { ...threadRecordToLocalThread(record, resumableStatus.displayName || resumableStatus.id), state: "standby" as const };
				const preparedBoundary = resumableStatus.activeThread?.preparedByBoundary ?? (resumableStatus.activeThread?.preparedByCheckpoint ? "checkpoint" : null);
				if (preparedBoundary) {
					if (resumableStatus.runtime.state === "active") void savePersistentAgentThread(localThread, "standby", preparedBoundary, localThread.items);
					setPersistentThread(null);
				} else {
					setPersistentThread(localThread);
					if (resumableStatus.runtime.state === "active") void savePersistentAgentThread(localThread, "standby", "unknown", localThread.items);
				}
			} else if (resumableStatus.runtime.state === "idle" && persistentThread?.agentId === resumableStatus.id) {
				setPersistentThread(null);
			}
		} catch {}
	}

	async function createPersistentAgentRoom(request: PersistentAgentCreateRequest): Promise<void> {
		await createPersistentAgent(request);
		await refreshPersistentAgentStatus();
	}

	async function archivePersistentAgentRoom(agentId: PersistentAgentId, confirmation: string): Promise<PersistentAgentArchiveResponse> {
		const response = await archivePersistentRoom(agentId, { confirmation });
		setPersistentAgentStatuses((statuses) => statuses.filter((status) => status.id !== agentId));
		setPersistentAgentStatus((status) => status?.id === agentId ? null : status);
		if (persistentChat?.agentId === agentId || persistentThread?.agentId === agentId) {
			if (persistTimerRef.current) {
				window.clearTimeout(persistTimerRef.current);
				persistTimerRef.current = null;
			}
			setPersistentChat(null);
			setPersistentThread(null);
			if (view === "chat") setView("home");
		}
		await refreshPersistentAgentStatus();
		return response;
	}

	function applyPersistentRuntime(agentId: PersistentAgentId, runtime: PersistentAgentStatus["runtime"]): void {
		setPersistentAgentStatuses((statuses) => statuses.map((status) => status.id === agentId ? { ...status, runtime } : status));
		setPersistentAgentStatus((status) => status?.id === agentId ? { ...status, runtime } : status);
	}


	useEffect(() => {
		if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
		persistTimerRef.current = window.setTimeout(() => {
			void persistConversation();
		}, 500);
		return () => {
			if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
		};
	}, [items, conversationId, persistentChat]);

	async function persistConversation() {
		try {
			// The debounced persist owns the current live room — carry its queue so a
			// transfer (enqueue) or a send (clear) reaches the thread record.
			if (persistentChat) await savePersistentAgentThread(persistentChat, "active", "unknown", items, pendingHandoffsRef.current);
		} catch {}
	}

	useEffect(() => { itemsRef.current = items; }, [items]);
	useEffect(() => { persistentChatRef.current = persistentChat; }, [persistentChat]);
	useEffect(() => { busyRef.current = busy; }, [busy]);
	useEffect(() => { turnCancellingRef.current = turnCancelling; }, [turnCancelling]);
	useEffect(() => { turnInterruptedNoteRef.current = turnInterruptedNote; }, [turnInterruptedNote]);

	useEffect(() => {
		if (absorbWorkflow.step !== "proposing") return;
		setAbsorbWaitingIndex(0);
		const id = window.setInterval(() => {
			setAbsorbWaitingIndex((value) => (value + 1) % ABSORB_WAITING_MESSAGES.length);
		}, 5_000);
		return () => window.clearInterval(id);
	}, [absorbWorkflow.step]);

	useEffect(() => {
		if (absorbWorkflow.step !== "checking" && absorbWorkflow.step !== "assessing") return;
		const id = window.setInterval(() => {
			setAbsorbLoadingIndex((value) => (value + 1) % ABSORB_LOADING_MESSAGES.length);
		}, 6_000);
		return () => window.clearInterval(id);
	}, [absorbWorkflow.step]);

	useEffect(() => {
		if (structuralReviewWorkflow.step !== "proposing") return;
		setStructuralReviewWaitingIndex(0);
		const id = window.setInterval(() => {
			setStructuralReviewWaitingIndex((value) => (value + 1) % STRUCTURAL_REVIEW_WAITING_MESSAGES.length);
		}, 5_000);
		return () => window.clearInterval(id);
	}, [structuralReviewWorkflow.step]);

	useEffect(() => {
		if (structuralReviewWorkflow.step !== "checking" && structuralReviewWorkflow.step !== "assessing") return;
		const id = window.setInterval(() => {
			setStructuralReviewLoadingIndex((value) => (value + 1) % STRUCTURAL_REVIEW_LOADING_MESSAGES.length);
		}, 6_000);
		return () => window.clearInterval(id);
	}, [structuralReviewWorkflow.step]);

	useEffect(() => {
		if (!resizingRightPane) return;
		const onMove = (e: MouseEvent) => {
			const drag = rightPaneDragRef.current;
			if (!drag) return;
			const next = clampRightPaneWidth(drag.startWidth + drag.startX - e.clientX, workbenchRef.current?.clientWidth);
			rightPaneUserSizedRef.current = true;
			setRightPaneWidth(next);
		};
		const onUp = () => setResizingRightPane(false);
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
	}, [resizingRightPane]);

	useEffect(() => {
		const onResize = () => setRightPaneWidth((current) => clampRightPaneWidth(current, workbenchRef.current?.clientWidth));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	useEffect(() => {
		if (!rightPaneUserSizedRef.current) return;
		try { localStorage.setItem(KNOWLEDGE_PANE_WIDTH_STORAGE_KEY, String(clampRightPaneWidth(rightPaneWidth))); } catch {}
	}, [rightPaneWidth]);

	// Default open size: split the workbench evenly with the chat. Runs on each
	// open until the user drags the divider (then their width wins, above).
	useEffect(() => {
		if (!rightPane || rightPaneUserSizedRef.current) return;
		let stored: string | null = null;
		try { stored = localStorage.getItem(KNOWLEDGE_PANE_WIDTH_STORAGE_KEY); } catch {}
		if (stored) return;
		setRightPaneWidth(equalSplitPaneWidth(workbenchRef.current?.clientWidth));
	}, [rightPane]);

	// ------------------------------------------------------------------
	// Assistant stream host: dispatches actions into the pure reducer in
	// assistant-stream.ts and applies its effects — exactly one setItems per
	// dispatch, tick scheduling via rAF (or a timer while the tab is hidden,
	// where rAF pauses and nothing is being watched so the reveal just drains).
	// ------------------------------------------------------------------

	function applyStreamUpserts(upserts: Map<string, { text: string; streaming: boolean }>, s: ChatItem[]): ChatItem[] {
		let next = s;
		for (const [id, u] of upserts) {
			if (next.some((it) => it.id === id && it.kind === "assistant")) {
				next = next.map((it) => (it.id === id && it.kind === "assistant" ? { ...it, text: u.text, streaming: u.streaming } : it));
			} else {
				next = [...next, { kind: "assistant", id, text: u.text, streaming: u.streaming }];
			}
		}
		return next;
	}

	function dispatchStream(action: AssistantStreamAction): AssistantStreamEffect[] {
		const { state, effects } = reduceAssistantStream(streamStateRef.current, action, revealPacingRef.current);
		streamStateRef.current = state;
		const upserts = new Map<string, { text: string; streaming: boolean }>();
		for (const effect of effects) {
			if (effect.kind === "upsert") upserts.set(effect.id, { text: effect.text, streaming: effect.streaming });
			else if (effect.kind === "schedule_tick") scheduleStreamTick();
			else if (effect.kind === "warn") console.warn(effect.message, effect.detail ?? "");
		}
		if (upserts.size) setItems((s) => applyStreamUpserts(upserts, s));
		return effects;
	}

	// Drive the consult state machine and apply its WS side effects. The reducer
	// is pure; the host sends the frames it asks for and logs a rejected second
	// consult (no toast, per spec §3).
	function dispatchConsult(action: ConsultAction): ConsultState {
		const { state, effects } = reduceConsult(consultStateRef.current, action);
		consultStateRef.current = state;
		setConsultState(state);
		for (const effect of effects) {
			if (effect.kind === "send_consult") {
				const ws = wsRef.current;
				if (ws && ws.readyState === WebSocket.OPEN) {
					// §8.1: a follow-up carries the prior exchanges (B's own Q/A); a fresh
					// consult omits the field. The server stays stateless and validates it.
					ws.send(JSON.stringify({ type: "consult", consultId: effect.consultId, targetRoomId: effect.targetRoomId, question: effect.question, ...(effect.priorExchanges?.length ? { priorExchanges: effect.priorExchanges } : {}) }));
				}
			} else if (effect.kind === "send_abort") {
				const ws = wsRef.current;
				if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "consult_abort", consultId: effect.consultId }));
			} else if (effect.kind === "rejected") {
				console.info("[consult] request rejected — one consult at a time", { reason: effect.reason });
			}
		}
		return state;
	}

	// The task sibling of dispatchConsult: the only effect is the task_abort
	// frame; `dropped` is host-loggable stale-event tracing.
	function dispatchTask(action: TaskAction): TaskState {
		const { state, effects } = reduceTask(taskStateRef.current, action);
		taskStateRef.current = state;
		setTaskState(state);
		for (const effect of effects) {
			if (effect.kind === "send_abort") {
				const ws = wsRef.current;
				if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "task_abort", taskId: effect.taskId }));
			} else if (effect.kind === "dropped") {
				console.info("[task] event dropped", { reason: effect.reason, taskId: effect.taskId });
			}
		}
		return state;
	}

	// Synchronous flush: everything the machine has received lands in the
	// transcript now (itemsRef too — exit paths persist right after calling
	// this), with no interrupt note. Safe to call when idle.
	function flushAssistantStream() {
		cancelStreamTick();
		const { state, effects } = reduceAssistantStream(streamStateRef.current, { type: "flush", now: performance.now() }, revealPacingRef.current);
		streamStateRef.current = state;
		const upserts = new Map<string, { text: string; streaming: boolean }>();
		for (const effect of effects) {
			if (effect.kind === "upsert") upserts.set(effect.id, { text: effect.text, streaming: effect.streaming });
			else if (effect.kind === "warn") console.warn(effect.message, effect.detail ?? "");
		}
		if (upserts.size) {
			const update = (s: ChatItem[]) => applyStreamUpserts(upserts, s);
			itemsRef.current = update(itemsRef.current);
			setItems(update);
		}
	}

	// The retrying note and the error-line pointer are transient per-connection
	// state: a teardown mid-retry would otherwise leave "retrying…" in the
	// transcript forever.
	function clearTransientStreamNotes() {
		streamErrorLineIdRef.current = null;
		const noteId = retryNoticeIdRef.current;
		retryNoticeIdRef.current = null;
		if (noteId) {
			itemsRef.current = itemsRef.current.filter((it) => it.id !== noteId);
			setItems((s) => s.filter((it) => it.id !== noteId));
		}
	}

	function cancelStreamTick() {
		if (streamTickRafRef.current !== null) {
			window.cancelAnimationFrame(streamTickRafRef.current);
			streamTickRafRef.current = null;
		}
		if (streamTickTimerRef.current !== null) {
			window.clearTimeout(streamTickTimerRef.current);
			streamTickTimerRef.current = null;
		}
	}

	// Browsers pause requestAnimationFrame while the tab is hidden or the
	// window is occluded, so rAF alone would buffer an entire answer and dump
	// it at message_end. When hidden, fall back to a timer that drains the
	// buffer whole (background tabs throttle timers to ~1/s — fine, nothing
	// is being watched).
	function scheduleStreamTick() {
		if (document.visibilityState === "hidden") {
			if (streamTickRafRef.current !== null) {
				window.cancelAnimationFrame(streamTickRafRef.current);
				streamTickRafRef.current = null;
			}
			if (streamTickTimerRef.current === null) {
				streamTickTimerRef.current = window.setTimeout(() => {
					streamTickTimerRef.current = null;
					dispatchStream({ type: "tick", now: performance.now(), mode: "drain" });
				}, 200);
			}
			return;
		}
		if (streamTickTimerRef.current !== null) return;
		if (streamTickRafRef.current === null) {
			streamTickRafRef.current = window.requestAnimationFrame(() => {
				streamTickRafRef.current = null;
				dispatchStream({ type: "tick", now: performance.now(), mode: "paced" });
			});
		}
	}

	useEffect(() => {
		// Tab visibility flips the tick transport (rAF visible / drain timer
		// hidden). Re-arm on every change: a stale hidden-tab drain timer must
		// not dump the buffer after the user returns, and going hidden must not
		// leave a paused rAF stalling the tail.
		const onVisibilityChange = () => {
			if (!isAssistantStreamActive(streamStateRef.current)) return;
			cancelStreamTick();
			scheduleStreamTick();
		};
		// Best effort on app/tab close: land whatever was still revealing and
		// push one keepalive save — the debounced persist timer will never fire
		// after unload, and a paced tail can otherwise be seconds of text that
		// only exists client-side.
		const onPageHide = () => {
			flushAssistantStream();
			const chat = persistentChatRef.current;
			if (!chat) return;
			try {
				void apiFetch(`/api/persistent-agents/${encodeURIComponent(chat.agentId)}/threads/${encodeURIComponent(chat.conversationId)}`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					keepalive: true,
					body: JSON.stringify({ state: "active", origin: "unknown", model: chat.model, items: itemsRef.current, pendingHandoffs: pendingHandoffsRef.current }),
				});
			} catch {}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		window.addEventListener("pagehide", onPageHide);
		return () => {
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("pagehide", onPageHide);
		};
	}, []);

	useEffect(() => {
		try { wsRef.current?.close(); } catch {}

		// In dev (Vite on :5173) connect directly to the web server (:8787)
		// instead of going through the Vite WS proxy — the proxy works but
		// Safari logs a spurious "closed before connection established" error
		// on the initial upgrade. In prod (UI served by the web server itself)
		// `location.host` already points at the right port.
		const wsHost = location.port === "5173" ? "localhost:8787" : location.host;
		const wsParams = new URLSearchParams({ conversationId });
		if (persistentChat) {
			wsParams.set("persistentAgentId", persistentChat.agentId);
			wsParams.set("modelProvider", persistentChat.model.provider);
			wsParams.set("model", persistentChat.model.model);
		}
		const ws = new WebSocket(`ws://${wsHost}/ws?${wsParams.toString()}`);
		wsRef.current = ws;
		ws.onopen = () => setConnected(true);
		ws.onclose = () => setConnected(false);
		ws.onerror = () => setConnected(false);

		ws.onmessage = (raw) => {
			const msg = JSON.parse(raw.data);
			if (msg.type === "ready") {
				if (msg.model?.label) setCurrentModelLabel(canonicalModelDisplayName({ model: msg.model.model, modelLabel: String(msg.model.label), provider: msg.model.provider }));
				setContextHealth(msg.contextHealth ?? null);
				return;
			}
			if (msg.type === "error") {
				// The turn is dead server-side; no message_end will follow. Land
				// whatever streamed and drop the cursor before the error line.
				flushAssistantStream();
				setItems((s) => [...s, { kind: "system", id: nid(), text: msg.message, level: "error" }]);
				setBusy(false);
				busyRef.current = false;
				if (turnCancellingRef.current) {
					markCurrentAssistantInterrupted(turnInterruptedNoteRef.current ?? "Response interrupted.");
					setTurnCancelling(false);
					turnCancellingRef.current = false;
					setTurnInterruptedNote(null);
					turnInterruptedNoteRef.current = null;
				}
				return;
			}
			if (msg.type === "usage_turn") {
				if (msg.modelLabel || msg.model) setCurrentModelLabel(canonicalModelDisplayName({ model: msg.model ? String(msg.model) : undefined, modelLabel: msg.modelLabel ? String(msg.modelLabel) : undefined, provider: msg.modelProvider ? String(msg.modelProvider) : undefined }));
				setUsage((u) => ({
					turns: u.turns + 1,
					input: u.input + (msg.input ?? 0),
					output: u.output + (msg.output ?? 0),
					cacheRead: u.cacheRead + (msg.cacheRead ?? 0),
					cacheWrite: u.cacheWrite + (msg.cacheWrite ?? 0),
					cost: u.cost + (msg.cost ?? 0),
					totalTokens: msg.totalTokens ?? u.totalTokens,
				}));
				if (msg.contextHealth) setContextHealth(msg.contextHealth);
				return;
			}
			if (msg.type === "ui_request") {
				if (msg.kind === "notify") {
					setItems((s) => [
						...s,
						{ kind: "system", id: nid(), text: msg.message ?? "", level: msg.level === "error" ? "error" : "info" },
					]);
					return;
				}
				if (msg.kind === "status") return;
				if (msg.kind === "confirm" || msg.kind === "select" || msg.kind === "input") {
					setItems((s) => [
						...s,
						{
							kind: "approval",
							id: nid(),
							requestId: msg.id,
							uiKind: msg.kind,
							title: msg.title ?? "Confirm",
							message: msg.message,
							detail: msg.detail,
							options: msg.options,
							placeholder: msg.placeholder,
						},
					]);
				}
				return;
			}
			if (msg.type === "consult_started") {
				dispatchConsult({ type: "started", consultId: String(msg.consultId ?? ""), targetRoomId: String(msg.targetRoomId ?? ""), targetDisplayName: String(msg.targetDisplayName ?? msg.targetRoomId ?? ""), model: msg.model });
				return;
			}
			if (msg.type === "consult_delta") {
				dispatchConsult({ type: "delta", consultId: String(msg.consultId ?? ""), delta: String(msg.delta ?? "") });
				return;
			}
			if (msg.type === "consult_end") {
				// Every consult_end carries two standing invariant lines (exact
				// strings from the server's buildConsultAnswer in
				// persistent-agents.ts) — the card's subline already states both,
				// so only room-specific warnings (e.g. the needs_absorb memory-lag
				// warning) surface as a ⚠ notice.
				const consultInvariantWarnings = new Set([
					"no memory has been written",
					"the consulted room was not activated and records no trace of this consult",
				]);
				const consultWarnings = (Array.isArray(msg.warnings) ? msg.warnings.map((w: unknown) => String(w)) : []).filter((w: string) => !consultInvariantWarnings.has(w));
				dispatchConsult({ type: "end", consultId: String(msg.consultId ?? ""), text: String(msg.text ?? ""), l1bFingerprint: msg.l1bFingerprint, generatedAt: String(msg.generatedAt ?? ""), warnings: consultWarnings });
				return;
			}
			if (msg.type === "consult_error") {
				// §8.6: a machine-readable `code` (e.g. "prompt_overflow") lets the card
				// render the "no longer fits" state instead of string-matching the copy.
				dispatchConsult({ type: "error", consultId: String(msg.consultId ?? ""), message: String(msg.message ?? "The consult failed."), ...(msg.code ? { code: String(msg.code) } : {}) });
				return;
			}
			if (msg.type === "task_iterate_result") {
				// ok:true needs no card action — the fresh task's task_started (next
				// frame) supersedes the done card; ok:false surfaces the reason.
				setTaskIteratePending(false);
				if (!msg.ok) {
					const reason = String(msg.reason ?? "The iteration could not start.");
					setTaskIterateNotice(reason);
					// The viewer footer renders the refusal inline; whenever that
					// footer isn't on screen, the toast keeps the failure from
					// being silent.
					const pane = rightPaneRef.current;
					const inlineVisible = pane?.kind === "artifactViewer" && !!pane.asset;
					if (!inlineVisible) setExportNotice({ kind: "error", text: reason });
				}
				return;
			}
			if (msg.type === "task_started") {
				setTaskIteratePending(false);
				setTaskIterateNotice(null);
				dispatchTask({
					type: "started",
					taskId: String(msg.taskId ?? ""),
					template: String(msg.template ?? ""),
					templateVersion: Number.isFinite(Number(msg.templateVersion)) && Number(msg.templateVersion) >= 1 ? Math.floor(Number(msg.templateVersion)) : null,
					templateLabel: String(msg.templateLabel ?? msg.template ?? ""),
					...(msg.title ? { title: String(msg.title) } : {}),
					model: msg.model ?? null,
				});
				return;
			}
			if (msg.type === "task_delta") {
				dispatchTask({ type: "delta", taskId: String(msg.taskId ?? ""), delta: String(msg.delta ?? "") });
				return;
			}
			if (msg.type === "task_end") {
				const endTaskId = String(msg.taskId ?? "");
				const next = dispatchTask({
					type: "end",
					taskId: endTaskId,
					template: String(msg.template ?? ""),
					text: String(msg.text ?? ""),
					artifacts: Array.isArray(msg.artifacts) ? msg.artifacts : [],
					...(Array.isArray(msg.thumbnails) ? { thumbnails: msg.thumbnails } : {}),
					generatedAt: String(msg.generatedAt ?? ""),
					...(msg.usage ? { usage: msg.usage } : {}),
				});
				void refreshAssetRows();
				// Done-moment (status grammar, 2026-07-18): if the user is watching
				// the run view, swap it for the artifact viewer in place — no toast
				// needed. Otherwise the toast fires once; the green dot persists.
				if (next.taskId === endTaskId && next.phase === "done") {
					const first = next.artifacts[0] ?? null;
					const pane = rightPaneRef.current;
					if (pane?.kind === "taskRun" && pane.taskId === endTaskId) {
						if (first) {
							openArtifactViewer(endTaskId, next.templateLabel ?? "visual", { relativePath: first.relativePath, extension: first.extension });
						} else {
							setRightPane(null);
						}
					} else {
						setTaskDoneToast({
							taskId: endTaskId,
							title: assetDisplayTitle(next.title || "Specialist task", next.artifacts),
							kind: "done",
							templateLabel: next.templateLabel ?? "visual",
							artifact: first ? { relativePath: first.relativePath, extension: first.extension } : null,
						});
					}
				}
				return;
			}
			if (msg.type === "task_error") {
				const errorTaskId = String(msg.taskId ?? "");
				const next = dispatchTask({
					type: "error",
					taskId: errorTaskId,
					message: String(msg.message ?? "The task did not finish."),
					...(Array.isArray(msg.artifacts) ? { artifacts: msg.artifacts } : {}),
				});
				void refreshAssetRows();
				// A user-requested stop needs no announcement (they did it); a real
				// failure gets the toast unless the run view is already showing it.
				const pane = rightPaneRef.current;
				const watching = pane?.kind === "taskRun" && pane.taskId === errorTaskId;
				if (next.taskId === errorTaskId && next.phase === "error" && !next.stopRequested && !watching) {
					setTaskDoneToast({
						taskId: errorTaskId,
						title: assetDisplayTitle(next.title || "Specialist task", next.artifacts),
						kind: "error",
						templateLabel: next.templateLabel ?? "visual",
						artifact: next.artifacts[0] ? { relativePath: next.artifacts[0].relativePath, extension: next.artifacts[0].extension } : null,
					});
				}
				return;
			}
			if (msg.type === "task_away_notice") {
				// Rung-2 honesty: tasks that ended with nobody listening. Arrives
				// right after ready, so it lands after resume's setItems.
				const notices: Array<{ title?: string; outcome?: string }> = Array.isArray(msg.notices) ? msg.notices : [];
				const lines = notices.map((notice) => {
					const title = String(notice.title ?? "").trim() || "A specialist task";
					switch (String(notice.outcome ?? "")) {
						case "ok": return `While you were away: “${title}” finished — it's waiting in Artifacts.`;
						case "aborted": return `While you were away: “${title}” was stopped. What it made so far is in Artifacts.`;
						case "orphaned": return `While you were away: “${title}” was interrupted when the app closed. What it made so far is in Artifacts.`;
						default: return `While you were away: “${title}” didn't finish.`;
					}
				});
				const moreCount = Number(msg.moreCount ?? 0);
				if (moreCount > 0) lines.push(`…and ${moreCount} earlier task${moreCount === 1 ? "" : "s"}.`);
				if (lines.length > 0) setItems((s) => [...s, ...lines.map((text) => ({ kind: "system" as const, id: nid(), text }))]);
				void refreshAssetRows();
				return;
			}
			if (msg.type !== "event") return;
			handleEvent(msg.event);
		};

		return () => {
			// Never lose a received tail to a teardown: reveal it, then forget.
			flushAssistantStream();
			clearTransientStreamNotes();
			dispatchStream({ type: "reset" });
			// Socket close kills the consult server-side (no re-attach; a lost
			// answer is re-derivable) — drop the card/pill with the connection.
			dispatchConsult({ type: "reset" });
			// A running task SURVIVES server-side (option 4): reset only forgets
			// this client's view — the reconnect replay rebuilds it from the
			// room's registry (task_started + accumulated tail).
			dispatchTask({ type: "reset" });
			try { ws.close(); } catch {}
		};
	}, [sessionVersion, conversationId, persistentChat]);


	function isRoutineRetrievalTool(name: string): boolean {
		return name.startsWith("kb_") || name.startsWith("memory_");
	}

	function retrievalActivityText(): string {
		const owner = persistentChatRef.current?.displayName?.trim();
		return owner ? `${owner} is checking relevant context…` : "Checking relevant context…";
	}

	function noteRetrievalActivity() {
		if (retrievalActivityIdRef.current) return;
		const id = nid();
		retrievalActivityIdRef.current = id;
		setItems((s) => [...s, { kind: "system", id, text: retrievalActivityText() }]);
	}

	function handleEvent(ev: any) {
		const now = performance.now();

		if (ev.type === "message_start" && ev.message?.role === "assistant") {
			dispatchStream({ type: "message_start", now });
			return;
		}

		if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
			dispatchStream({ type: "delta", text: ev.assistantMessageEvent.delta ?? "", now });
			return;
		}

		if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_end") {
			dispatchStream({ type: "text_end", blockText: extractAssistantTextFromUpdate(ev), now });
			return;
		}

		// Provider auto-retry: the errored attempt's answer will be regenerated
		// as a fresh message that streams into the same bubble (reducer), so the
		// red error line becomes a transient retrying note instead.
		if (ev.type === "auto_retry_start") {
			dispatchStream({ type: "auto_retry_start", now });
			const errorLineId = streamErrorLineIdRef.current;
			streamErrorLineIdRef.current = null;
			const noteId = retryNoticeIdRef.current ?? nid();
			retryNoticeIdRef.current = noteId;
			setItems((s) => {
				const next = errorLineId ? s.filter((it) => it.id !== errorLineId) : s;
				if (next.some((it) => it.id === noteId)) return next;
				return [...next, { kind: "system", id: noteId, text: "Connection hiccup. Retrying…" }];
			});
			return;
		}
		if (ev.type === "auto_retry_end") {
			// Success: the retried answer streamed in normally, drop the note.
			// Failure: the final attempt's message_end already rendered its red
			// error line (kept because no further auto_retry_start removed it).
			const noteId = retryNoticeIdRef.current;
			retryNoticeIdRef.current = null;
			if (noteId) setItems((s) => s.filter((it) => it.id !== noteId));
			return;
		}

		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			// A turn the provider refused (bad key, disabled model, quota) carries
			// stopReason "error" and usually no content — without this line the
			// room would stay silent where the reply should have been.
			if (ev.message.stopReason === "error") {
				const detail = String(ev.message.errorMessage ?? "").trim().slice(0, 300);
				const errorLineId = nid();
				streamErrorLineIdRef.current = errorLineId;
				setItems((s) => [...s, {
					kind: "system",
					id: errorLineId,
					level: "error",
					text: `The model could not respond${detail ? ` · ${detail}` : ""} · check the model and its sign-in in AI setup.`,
				}]);
			}
			dispatchStream({ type: "message_end", finalText: extractAssistantText(ev.message), stopReason: ev.message.stopReason, now });

			const content = ev.message.content as any[] | undefined;
			if (Array.isArray(content)) {
				const toolCalls = content.filter((c) => c?.type === "toolCall");
				if (toolCalls.length) {
					const visibleAdditions: ChatItem[] = [];
					for (const c of toolCalls) {
						const toolId = c.id ?? c.toolCallId;
						const name = String(c.name ?? "");
						const args = c.arguments ?? c.args ?? {};
						if (isRoutineRetrievalTool(name)) {
							hiddenRoutineToolByIdRef.current.set(toolId, { name, args });
							noteRetrievalActivity();
							continue;
						}
						if (name === "delegate_task") {
							// The approval card and the task card ARE this tool's UI; a raw
							// tool chip above them is noise. Errors still surface via the
							// hidden-tool path.
							hiddenRoutineToolByIdRef.current.set(toolId, { name, args });
							continue;
						}
						const itemId = nid();
						toolByIdRef.current.set(toolId, itemId);
						visibleAdditions.push({ kind: "tool", id: itemId, name, args, status: "running" });
					}
					if (visibleAdditions.length) setItems((s) => [...s, ...visibleAdditions]);
				}
			}
			return;
		}

		if (ev.type === "message_end" && ev.message?.role === "toolResult") {
			const msg = ev.message;
			const isError = !!msg.isError;
			const text = extractText(msg);
			const details = msg.details;
			const hidden = hiddenRoutineToolByIdRef.current.get(msg.toolCallId);
			if (hidden) {
				hiddenRoutineToolByIdRef.current.delete(msg.toolCallId);
				if (!isError) return;
				setItems((s) => [...s, { kind: "tool", id: nid(), name: hidden.name, args: hidden.args, status: "error", result: text }]);
				return;
			}
			const itemId = toolByIdRef.current.get(msg.toolCallId);
			if (!itemId) return;
			setItems((s) =>
				s.map((it) =>
					it.id === itemId && it.kind === "tool"
						? { ...it, status: isError ? "error" : "done", result: text, details }
						: it,
				),
			);
			return;
		}

		if (ev.type === "agent_start") {
			setBusy(true);
			busyRef.current = true;
		}
		if (ev.type === "agent_end") {
			setBusy(false);
			busyRef.current = false;
			if (turnCancellingRef.current) {
				markCurrentAssistantInterrupted(turnInterruptedNoteRef.current ?? "Response interrupted.");
				setTurnCancelling(false);
				turnCancellingRef.current = false;
				setTurnInterruptedNote(null);
				turnInterruptedNoteRef.current = null;
			}
			if (persistentChatRef.current) void refreshPersistentAgentStatus();
		}
	}

	function extractAssistantContentText(content: any): string {
		if (typeof content === "string") return content.trim();
		if (!Array.isArray(content)) return "";
		return content
			.filter((c: any) => c?.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join("")
			.trim();
	}

	function extractAssistantText(message: any): string {
		return extractAssistantContentText(message?.content);
	}

	function extractAssistantTextFromUpdate(ev: any): string {
		const event = ev?.assistantMessageEvent;
		const candidates = [
			event?.type === "text_end" ? extractAssistantContentText(event.content) : "",
			extractAssistantText(event?.partial),
			extractAssistantText(ev?.message),
		]
			.map((text) => text.trim())
			.filter(Boolean);
		return candidates.reduce((best, text) => (text.length > best.length ? text : best), "");
	}

	function extractText(result: any): string {
		if (!result) return "";
		if (typeof result === "string") return result;
		const inner = result.content ?? result.value ?? result;
		if (Array.isArray(inner)) {
			return inner.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
		}
		try { return JSON.stringify(result, null, 2); } catch { return String(result); }
	}

	function markCurrentAssistantInterrupted(reason: string) {
		// The interrupt drains and finalizes through the reducer; the note is
		// applied synchronously to itemsRef as well because room-exit paths
		// persist the thread right after calling this.
		cancelStreamTick();
		const { state, effects } = reduceAssistantStream(streamStateRef.current, { type: "interrupt", now: performance.now() }, revealPacingRef.current);
		streamStateRef.current = state;
		const upserts = new Map<string, { text: string; streaming: boolean }>();
		let interruptedId: string | null = null;
		for (const effect of effects) {
			if (effect.kind === "upsert") upserts.set(effect.id, { text: effect.text, streaming: effect.streaming });
			else if (effect.kind === "interrupted") interruptedId = effect.id;
			else if (effect.kind === "warn") console.warn(effect.message, effect.detail ?? "");
		}
		const update = (s: ChatItem[]) => {
			let next = applyStreamUpserts(upserts, s);
			if (interruptedId) {
				next = next.map((it) => {
					if (it.id !== interruptedId || it.kind !== "assistant") return it;
					if (it.text.includes(reason)) return { ...it, streaming: false };
					const text = it.text?.trim() ? `${it.text.trimEnd()}\n\n_${reason}_` : reason;
					return { ...it, text, streaming: false };
				});
			} else if (!next.some((it) => it.kind === "system" && it.text === reason)) {
				next = [...next, { kind: "system" as const, id: nid(), text: reason }];
			}
			return next;
		};
		itemsRef.current = update(itemsRef.current);
		setItems(update);
	}

	function waitForCurrentTurnToSettle(timeoutMs = 2500): Promise<void> {
		const startedAt = Date.now();
		return new Promise((resolve) => {
			const tick = () => {
				if (!busyRef.current || Date.now() - startedAt >= timeoutMs) {
					resolve();
					return;
				}
				window.setTimeout(tick, 50);
			};
			tick();
		});
	}

	async function abortCurrentTurn(options: { leaveAfter?: boolean } = {}): Promise<void> {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		setTurnCancelling(true);
		turnCancellingRef.current = true;
		const note = options.leaveAfter ? "Response interrupted because you left the room." : "Response interrupted by Stop.";
		setTurnInterruptedNote(note);
		turnInterruptedNoteRef.current = note;
		ws.send(JSON.stringify({ type: "abort" }));
		await waitForCurrentTurnToSettle(options.leaveAfter ? 1200 : 2500);
	}

	const send = (text: string): boolean => {
		if (busyRef.current || turnCancellingRef.current) return false;
		const payload = text.trim();
		if (!payload) return false;
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) return false;
		// Consult MR-5 (§2): any queued handoff blocks ride ahead of the user's text
		// on the wire (entering the session JSONL, where a checkpoint can compress
		// them), then the queue clears. The chat bubble shows only the user's text.
		const pending = pendingHandoffsRef.current;
		const wireText = composeOutgoingPromptWithHandoffs(pending, payload);
		if (pending.length) {
			applyPendingHandoffs([], new Set());
			// The block is consumed exactly once: the SERVER clears the persisted
			// queue atomically when it receives this prompt (index.ts prompt handler),
			// so a crash or reordered save can't re-queue it. Cancel any in-flight
			// debounced persist here too, so a stale save can't re-write the old queue
			// before the setItems below reschedules an empty-queue persist.
			if (persistTimerRef.current) { window.clearTimeout(persistTimerRef.current); persistTimerRef.current = null; }
		}
		setItems((s) => [...s, { kind: "user", id: nid(), text: payload }]);
		ws.send(JSON.stringify({ type: "prompt", text: wireText }));
		dispatchStream({ type: "new_turn", now: performance.now() });
		retrievalActivityIdRef.current = null;
		setComposerPrefill("");
		setComposerResetNonce((value) => value + 1);
		setTurnInterruptedNote(null);
		turnInterruptedNoteRef.current = null;
		setTurnCancelling(false);
		turnCancellingRef.current = false;
		setBusy(true);
		busyRef.current = true;
		return true;
	};

	// The composer @-mention popover (Consult MR-3) resolves a leading mention of
	// a known room and hands off here instead of the normal send. MR-4 wires it to
	// the consult WS family + DelegationCard: generate the client-side consultId,
	// capture the consulted room's display name and last memory-write time (for
	// the "as of" recency line), and drive the reducer — which sends the frame and
	// rejects a second consult while one is active.
	// Returns whether the consult was accepted, so the composer keeps the user's
	// typed question when it is rejected (socket down, or one already active).
	function handleConsultRequest(targetRoomId: string, question: string): boolean {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			console.info("[consult] socket not open — consult request dropped", { targetRoomId });
			return false;
		}
		const targetStatus = persistentAgentStatuses.find((status) => status.id === targetRoomId) ?? null;
		const consultId = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
		const next = dispatchConsult({
			type: "request",
			consultId,
			targetRoomId,
			question,
			requestedAt: new Date().toISOString(),
			targetDisplayName: targetStatus?.displayName ?? targetRoomId,
			asOfCheckpointAt: targetStatus?.memoryStatus?.lastCheckpointAt ?? null,
		});
		// Accepted iff the reducer adopted this consult (a rejected second consult
		// leaves the previous consultId in place).
		return next.consultId === consultId;
	}

	// Stacked consult (§8.1/§8.2): a follow-up from the done card asks the SAME
	// room again, building on the stack. Each follow-up is a fresh isolated worker
	// run (the governance invariant is untouched); the reducer accumulates the
	// completed exchange and re-enters streaming, and its send_consult effect
	// carries the prior exchanges. The as-of is re-read from the room's current
	// status (a fresh point-in-time read, §8.5), not pinned to the first ask.
	function handleConsultFollowUp(question: string): boolean {
		// Socket guard (hardening 2026-07-11, fresh-eyes MAJOR): without this, a
		// follow-up during a reconnect blip advanced the reducer to `streaming`
		// with no frame sent — a permanently hung card whose completed (and still
		// transferable) answer became unreachable. Mirror handleConsultRequest:
		// reject before dispatching so the card stays `done` and the draft is kept.
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			console.info("[consult] socket not open — follow-up dropped");
			return false;
		}
		const consult = consultStateRef.current;
		const targetRoomId = consult.targetRoomId;
		if (!targetRoomId) return false;
		const targetStatus = persistentAgentStatuses.find((status) => status.id === targetRoomId) ?? null;
		const consultId = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
		const next = dispatchConsult({
			type: "followUp",
			consultId,
			question,
			requestedAt: new Date().toISOString(),
			asOfCheckpointAt: targetStatus?.memoryStatus?.lastCheckpointAt ?? null,
		});
		// Accepted iff the reducer adopted this follow-up (same discipline as
		// handleConsultRequest — a rejected follow-up keeps the previous state).
		return next.consultId === consultId;
	}

	// Consult MR-5 (§2.1, §2, §3, §4.4): transfer the done consult into the thread.
	// GOVERNANCE — this never writes memory: it appends a display item AND enqueues
	// the canonical handoff block for the user's next prompt. It does NOT touch any
	// memory-write door. Then it dismisses the card (freeing the one-consult gate).
	function transferConsultToThread() {
		const consult = consultStateRef.current;
		// §8.7: transfer moves the WHOLE stack as one item + one block, then frees
		// the gate. `done` transfers everything; a failed/stopped follow-up transfers
		// the preserved completed stack (§8.1). Nothing to transfer → no-op.
		if (!consult.targetRoomId) return;
		const stack = consultStack(consult);
		if (stack.length === 0) return;
		const targetRoomId = consult.targetRoomId;
		const displayName = consult.targetDisplayName ?? targetRoomId;
		const nowIso = new Date().toISOString();
		const fingerprintString = (exchange: ConsultExchange) => {
			const fingerprint = exchange.l1bFingerprint ?? { algorithm: "sha256", value: "" };
			return `${fingerprint.algorithm}:${fingerprint.value}`;
		};
		// The ONE §8.8 block. N=1 delegates to the byte-identical §2.1 grammar.
		const blockExchanges: ConsultHandoffExchange[] = stack.map((exchange) => ({
			question: exchange.question,
			answerMarkdown: exchange.answer,
			fingerprint: exchange.l1bFingerprint ?? { algorithm: "sha256", value: "" },
			// Per-exchange as-of (§8.5) and the request time (header range, §8.8);
			// fall back through generation time to now if somehow unset.
			asOf: exchange.asOfCheckpointAt || exchange.generatedAt || nowIso,
			requestedAt: exchange.requestedAt || exchange.generatedAt || nowIso,
		}));
		const block = buildConsultHandoffBlockFromStack({ slug: targetRoomId, displayName, agentId: targetRoomId, exchanges: blockExchanges });
		const itemId = nid();
		const consultedAtOf = (exchange: ConsultExchange) => {
			const ms = exchange.generatedAt ? Date.parse(exchange.generatedAt) : NaN;
			return Number.isFinite(ms) ? ms : Date.now();
		};
		// §8.4: the item carries the whole stack in `exchanges[]` for N≥2; the flat
		// fields mirror the LATEST exchange so legacy single-exchange renderers still
		// show a sensible provenance. N=1 keeps today's flat-only shape byte-for-byte
		// (no `exchanges` field), so old persisted items and the N=1 path are unchanged.
		const latest = stack[stack.length - 1];
		const item: ChatItem = {
			kind: "consult",
			id: itemId,
			targetRoomId,
			targetDisplayName: displayName,
			question: latest.question,
			answer: latest.answer,
			l1bFingerprint: fingerprintString(latest),
			consultedAt: consultedAtOf(latest),
			transferred: true,
			...(stack.length > 1
				? { exchanges: stack.map((exchange) => ({ question: exchange.question, answer: exchange.answer, l1bFingerprint: fingerprintString(exchange), consultedAt: consultedAtOf(exchange) })) }
				: {}),
		};
		// itemsRef is the synchronous mirror room-exit paths persist from.
		itemsRef.current = [...itemsRef.current, item];
		setItems((s) => [...s, item]);
		const nextIds = new Set(pendingConsultItemIdsRef.current);
		nextIds.add(itemId);
		applyPendingHandoffs([...pendingHandoffsRef.current, block], nextIds);
		dispatchConsult({ type: "dismiss" });
	}

	// Visuals V6's card-transfer path retired with the done-card (status grammar,
	// 2026-07-18): transferAssetRowToThread below is the one transfer door — the
	// same block builder and pending queue, reached through the viewer footer.

	// Assets panel (rung 3): open a ledger row in the right-pane viewer — the
	// reconstituted done-card. The live running row opens the run view instead;
	// other rows without artifacts are not clickable.
	function openAssetRow(row: AssetRowView) {
		// Clicking the already-selected row closes the pane (same as the header
		// X); a running task keeps running server-side either way.
		if (rightPane && (rightPane.kind === "artifactViewer" || rightPane.kind === "taskRun") && rightPane.taskId === row.taskId) {
			setArtifactMaximized(false);
			setRightPane(null);
			return;
		}
		if (row.running) {
			setArtifactMaximized(false);
			setRightPane({ kind: "taskRun", taskId: row.taskId });
			return;
		}
		if (row.artifacts.length === 0) return;
		setArtifactMaximized(false);
		markAssetRowViewed(row.taskId);
		// A refusal notice belongs to the task it answered — never carry it
		// into another row's footer.
		setTaskIterateNotice(null);
		setRightPane({
			kind: "artifactViewer",
			taskId: row.taskId,
			templateLabel: assetTemplateShortName(row.templateId),
			artifact: { relativePath: row.artifacts[0].relativePath, extension: row.artifacts[0].extension },
			asset: row,
		});
	}

	// Add-to-conversation / Re-attach from the panel: the ordinary transfer
	// performed late — same block builder, same pending queue, same gate. The
	// item simply carries no thumbnail (write-time thumbnails die with the
	// card; the ledger stores none by design).
	function transferAssetRowToThread(row: AssetRowView) {
		if (itemsRef.current.some((it) => it.kind === "task" && it.taskId === row.taskId)) return;
		markAssetRowViewed(row.taskId);
		const generatedAt = row.generatedAt || new Date().toISOString();
		const block = buildSpecialistHandoffBlock({
			templateId: row.templateId,
			templateVersion: row.templateVersion,
			taskTitle: row.title,
			ranAtIso: generatedAt,
			artifactPaths: row.artifacts.map((artifact) => artifact.relativePath),
			summary: row.summary,
		});
		const item: ChatItem = {
			kind: "task",
			id: nid(),
			taskId: row.taskId,
			template: row.templateId,
			templateVersion: row.templateVersion,
			templateLabel: assetTemplateShortName(row.templateId),
			title: row.title,
			summary: row.summary,
			artifacts: row.artifacts.map((artifact) => ({ relativePath: artifact.relativePath, bytes: artifact.bytes, extension: artifact.extension })),
			generatedAt,
			transferred: true,
		};
		itemsRef.current = [...itemsRef.current, item];
		setItems((s) => [...s, item]);
		applyPendingHandoffs([...pendingHandoffsRef.current, block], pendingConsultItemIdsRef.current);
	}

	// Per-task delete (contract §4): orphan rows only; the server re-verifies
	// the row is unreferenced and not running before anything is removed.
	async function deleteAssetRow(row: AssetRowView) {
		const chat = persistentChatRef.current;
		if (!chat) return;
		try {
			const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(chat.agentId)}/tasks/${encodeURIComponent(row.taskId)}`, { method: "DELETE" });
			const data = await res.json().catch(() => null);
			if (!res.ok) {
				setExportNotice({ kind: "error", text: data?.error || "That didn't work — the files are unchanged." });
				return;
			}
			setExportNotice({ kind: "success", text: "Deleted." });
			if (rightPane?.kind === "artifactViewer" && rightPane.taskId === row.taskId) {
				setArtifactMaximized(false);
				setRightPane(null);
			}
			void refreshAssetRows();
		} catch {
			setExportNotice({ kind: "error", text: "That didn't work — the files are unchanged." });
		}
	}

	// Remove from list (user control, 2026-07-20): a list operation only — the
	// ledger row gets a removedAt stamp and the panel hides it; files are kept.
	// No dialog: nothing is destroyed, and the toast's Undo clears the stamp.
	async function removeAssetRow(row: AssetRowView) {
		const chat = persistentChatRef.current;
		if (!chat) return;
		try {
			const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(chat.agentId)}/tasks/${encodeURIComponent(row.taskId)}/removed`, { method: "POST" });
			const data = await res.json().catch(() => null);
			if (!res.ok) {
				setExportNotice({ kind: "error", text: data?.error || "That didn't work — the list is unchanged." });
				return;
			}
			setRemoveNotice({ taskId: row.taskId });
			if ((rightPane?.kind === "artifactViewer" || rightPane?.kind === "taskRun") && rightPane.taskId === row.taskId) {
				setArtifactMaximized(false);
				setRightPane(null);
			}
			void refreshAssetRows();
		} catch {
			setExportNotice({ kind: "error", text: "That didn't work — the list is unchanged." });
		}
	}

	async function undoRemoveAssetRow(taskId: string) {
		const chat = persistentChatRef.current;
		setRemoveNotice(null);
		if (!chat) return;
		try {
			await apiFetch(`/api/persistent-agents/${encodeURIComponent(chat.agentId)}/tasks/${encodeURIComponent(taskId)}/removed`, { method: "DELETE" });
		} catch {
			// The refetch below shows the truth either way.
		}
		void refreshAssetRows();
	}

	// GC approval (contract §4): the POST names exactly the proposed ids; the
	// server re-verifies each against a fresh reference scan before deleting.
	async function confirmTaskStoreGc() {
		const proposal = gcAssessment?.proposal;
		if (!proposal || gcBusy) return;
		setGcBusy(true);
		try {
			const res = await apiFetch("/api/task-store/gc", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ taskIds: proposal.candidates.map((candidate) => candidate.taskId) }),
			});
			if (res.ok) {
				let failedCount = 0;
				try { failedCount = Number(((await res.json()) as { failed?: unknown[] }).failed?.length ?? 0) || 0; } catch {}
				setGcAssessment(null);
				setGcReviewOpen(false);
				void refreshAssetRows();
				if (failedCount > 0) {
					setExportNotice({ kind: "error", text: failedCount === 1 ? "Cleanup finished, but one folder couldn't be deleted. It will be proposed again next time." : `Cleanup finished, but ${failedCount} folders couldn't be deleted. They will be proposed again next time.` });
				}
			} else {
				// The server refuses before deleting anything, so this is honest.
				setExportNotice({ kind: "error", text: "The cleanup didn't run — nothing was deleted. Try again in a moment." });
			}
		} catch {
			// Leave the dialog open; the user can retry or cancel.
		} finally {
			setGcBusy(false);
		}
	}

	// Panel iterate: the same user-authored one-click frame as the done card —
	// the server derives template + read scope from its own records (D7; the
	// ledger fallback covers rows older than the reseed window).
	function submitAssetIterate(taskId: string, brief: string): boolean {
		const payload = brief.trim();
		const ws = wsRef.current;
		if (!payload || !ws || ws.readyState !== WebSocket.OPEN) return false;
		setTaskIteratePending(true);
		setTaskIterateNotice(null);
		ws.send(JSON.stringify({ type: "task_iterate", taskId, brief: payload }));
		return true;
	}

	async function requestCheckpointProposal(targetChat: NonNullable<PersistentChatConfig>, density: CheckpointDensity, rememberText: string): Promise<CheckpointProposalResponse> {
		// A paced tail may still be draining after busy cleared — the proposal
		// must see the complete answer.
		flushAssistantStream();
		const transcriptItems = itemsRef.current
			.filter((item) => item.kind === "user" || item.kind === "assistant" || item.kind === "system" || item.kind === "tool")
			.map((item) => {
				if (item.kind === "user" || item.kind === "assistant" || item.kind === "system") return { kind: item.kind, id: item.id, text: item.text };
				return { kind: "tool", id: item.id, name: item.name, status: item.status };
			});
		const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(targetChat.agentId)}/checkpoint/propose`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				conversationId: targetChat.conversationId,
				model: targetChat.model,
				density,
				rememberText,
				items: transcriptItems,
			}),
		});
		if (!res.ok) {
			let message = `Failed to generate proposal (${res.status})`;
			try {
				const body = await res.json();
				if (body?.error) message = String(body.error);
			} catch {}
			throw new Error(message);
		}
		const proposal = await res.json() as CheckpointProposalResponse;
		const currentChat = persistentChatRef.current;
		if (!currentChat || currentChat.agentId !== targetChat.agentId || currentChat.conversationId !== targetChat.conversationId) throw new Error("Checkpoint target changed. Please reopen the checkpoint preview.");
		if (proposal.agentId !== targetChat.agentId) throw new Error("Checkpoint proposal target does not match the current room.");
		if (proposal.conversationId !== targetChat.conversationId || proposal.process?.parentConversationId !== targetChat.conversationId) throw new Error("Checkpoint proposal thread does not match the current conversation.");
		return proposal;
	}

	async function generateCheckpointProposal() {
		const targetChat = persistentChat;
		if (!targetChat || checkpointProposalLoading) return;
		if (busyRef.current || turnCancellingRef.current) {
			setCheckpointProposalError("Stop or wait for the current response before checkpointing.");
			return;
		}
		setCheckpointProposalLoading(true);
		setCheckpointProposalError(null);
		setCheckpointApprovalError(null);
		setCheckpointApprovalResult(null);
		setCheckpointProposal(null);
		try {
			const proposal = await requestCheckpointProposal(targetChat, checkpointDensity, checkpointRememberText);
			setCheckpointProposal(proposal);
		} catch (e) {
			setCheckpointProposalError((e as Error).message);
		} finally {
			setCheckpointProposalLoading(false);
		}
	}

	async function bindToApprovedCheckpointRuntime(approval: CheckpointApprovalResponse, targetChat: NonNullable<PersistentChatConfig>): Promise<void> {
		const freshThreadId = approval.postCheckpoint.activeThreadId || approval.runtimeBoundary.newThreadId;
		const record = await fetchPersistentAgentThread(targetChat.agentId, freshThreadId);
		const thread = threadRecordToLocalThread(record, targetChat.displayName);
		const liveThread = { ...thread, state: "live" as const };
		try { wsRef.current?.close(); } catch {}
		setUsage(ZERO_USAGE);
		setContextHealth(null);
		setPreview(null);
		setBusy(false);
		flushAssistantStream();
		clearTransientStreamNotes();
		dispatchStream({ type: "reset" });
		toolByIdRef.current.clear();
		hiddenRoutineToolByIdRef.current.clear();
		retrievalActivityIdRef.current = null;
		setPersistentThread(null);
		setPersistentChat(null);
		setConversationId(liveThread.conversationId);
		setItems(liveThread.items);
		setPersistentThread(liveThread);
		setPersistentChat({ agentId: liveThread.agentId, displayName: liveThread.displayName, conversationId: liveThread.conversationId, model: liveThread.model });
		// Consult MR-5 checkpoint EXCEPTION (§2.3): the checkpoint closes this thread
		// and prepares a fresh one; an un-transferred-into-memory consult must survive
		// into it. The server-created fresh thread starts empty (the checkpoint write
		// path is off-limits), so carry the queue client-side onto the fresh thread's
		// first save. The fresh transcript has no consult display items, so the hint
		// set is empty even though the blocks still ride the next prompt.
		const carriedQueue = pendingHandoffsRef.current;
		applyPendingHandoffs(carriedQueue, deriveTrailingConsultIds(liveThread.items, carriedQueue.length));
		await savePersistentAgentThread(liveThread, "active", "checkpoint", liveThread.items, carriedQueue);
		setCurrentModelLabel(modelDisplayName(liveThread.model));
		setView("chat");
		setSessionVersion((v) => v + 1);
	}

	async function bindToMementoRuntime(result: PersistentAgentMementoBoundaryResponse, targetChat: NonNullable<PersistentChatConfig>): Promise<void> {
		const freshThreadId = result.postMemento.activeThreadId || result.runtimeBoundary.newThreadId;
		const record = await fetchPersistentAgentThread(targetChat.agentId, freshThreadId);
		const thread = threadRecordToLocalThread(record, targetChat.displayName);
		const liveThread = { ...thread, state: "live" as const };
		try { wsRef.current?.close(); } catch {}
		setUsage(ZERO_USAGE);
		setContextHealth(null);
		setPreview(null);
		setBusy(false);
		flushAssistantStream();
		clearTransientStreamNotes();
		dispatchStream({ type: "reset" });
		toolByIdRef.current.clear();
		hiddenRoutineToolByIdRef.current.clear();
		retrievalActivityIdRef.current = null;
		setPersistentThread(null);
		setPersistentChat(null);
		setConversationId(liveThread.conversationId);
		setItems(liveThread.items);
		setPersistentThread(liveThread);
		setPersistentChat({ agentId: liveThread.agentId, displayName: liveThread.displayName, conversationId: liveThread.conversationId, model: liveThread.model });
		// Consult MR-5 (§2.3): Memento (forget-this-conversation) discards the pending
		// queue — the fresh thread starts with nothing queued.
		applyPendingHandoffs([], new Set());
		try {
			await savePersistentAgentThread(liveThread, "active", "memento", liveThread.items, []);
		} catch (e) {
			// The fresh thread may inherit a model the active AI profile no longer
			// provides (Memento is how a stuck room gets freed), and activating it
			// then trips the model gate; transient failures land here too. The
			// boundary itself was applied — park the room on the launcher and say
			// so, rather than failing silently or erroring inside a dead chat.
			setPersistentChat(null);
			setPersistentThread(null);
			setItems([]);
			setPersistentResumeError(`The conversation was reset, but the room could not be reopened automatically: ${(e as Error).message} Enter it again from its card.`);
			setView("home");
			void refreshPersistentAgentStatus();
			return;
		}
		setCurrentModelLabel(modelDisplayName(liveThread.model));
		setView("chat");
		setSessionVersion((v) => v + 1);
	}

	async function approveCheckpointProposal(approvedRecentContext: string) {
		const targetChat = persistentChat;
		const proposal = checkpointProposal;
		if (!targetChat || !proposal || checkpointApprovalLoading) return;
		if (busyRef.current || turnCancellingRef.current) {
			setCheckpointApprovalError("Stop or wait for the current response before approving a checkpoint.");
			return;
		}
		if (proposal.agentId !== targetChat.agentId) {
			setCheckpointApprovalError("Checkpoint proposal target does not match the current room. Please regenerate the proposal.");
			return;
		}
		if (proposal.conversationId !== targetChat.conversationId || proposal.process?.parentConversationId !== targetChat.conversationId) {
			setCheckpointApprovalError("Checkpoint proposal thread does not match the current conversation. Please regenerate the proposal.");
			return;
		}
		setCheckpointApprovalLoading(true);
		setCheckpointApprovalError(null);
		try {
			const approval = await requestCheckpointApproval(targetChat, proposal, approvedRecentContext);
			await bindToApprovedCheckpointRuntime(approval, targetChat);
			setCheckpointApprovalResult(approval);
			void refreshPersistentAgentStatus();
		} catch (e) {
			setCheckpointApprovalError((e as Error).message);
		} finally {
			setCheckpointApprovalLoading(false);
		}
	}

	async function requestCheckpointApproval(targetChat: NonNullable<PersistentChatConfig>, proposal: CheckpointProposalResponse, approvedRecentContext: string): Promise<CheckpointApprovalResponse> {
		const res = await apiFetch(`/api/persistent-agents/${encodeURIComponent(targetChat.agentId)}/checkpoint/approve`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				conversationId: targetChat.conversationId,
				model: targetChat.model,
				density: proposal.density,
				proposal,
				approvedRecentContext,
			}),
		});
		if (!res.ok) {
			let message = `Failed to approve checkpoint (${res.status})`;
			try {
				const body = await res.json();
				if (body?.error) message = String(body.error);
			} catch {}
			throw new Error(message);
		}
		const approval = await res.json() as CheckpointApprovalResponse;
		const currentChat = persistentChatRef.current;
		if (!currentChat || currentChat.agentId !== targetChat.agentId || currentChat.conversationId !== targetChat.conversationId) throw new Error("Checkpoint target changed after approval. Refresh the room status before continuing.");
		if (approval.agentId !== targetChat.agentId || approval.conversationId !== targetChat.conversationId) throw new Error("Checkpoint approval response does not match the current room.");
		return approval;
	}

	async function runQuickCheckpoint() {
		const targetChat = persistentChat;
		if (!targetChat || checkpointProposalLoading || checkpointApprovalLoading) return;
		if (busyRef.current || turnCancellingRef.current) return;
		setCheckpointQuickRequested(true);
		setCheckpointQuickBlockedReasons(null);
		setCheckpointDensity("standard");
		setCheckpointRememberText("");
		setCheckpointProposal(null);
		setCheckpointProposalError(null);
		setCheckpointApprovalError(null);
		setCheckpointApprovalResult(null);
		setCheckpointPreviewOpen(true);
		setCheckpointProposalLoading(true);
		let proposal: CheckpointProposalResponse;
		try {
			proposal = await requestCheckpointProposal(targetChat, "standard", "");
			setCheckpointProposal(proposal);
		} catch (e) {
			setCheckpointProposalError((e as Error).message);
			setCheckpointProposalLoading(false);
			return;
		}
		setCheckpointProposalLoading(false);
		const blockers = quickCheckpointBlockers(proposal);
		if (blockers.length > 0) {
			setCheckpointQuickBlockedReasons(blockers);
			return;
		}
		if (!(await roomQuickCheckpointAutoApplyEnabled(targetChat.agentId))) {
			setCheckpointQuickBlockedReasons(["Checkpoints now ask for your review first. You can turn automatic apply on in room settings."]);
			return;
		}
		setCheckpointApprovalLoading(true);
		try {
			const approvedRecentContext = buildApprovedRecentContextMarkdown(proposal, {
				sessionArc: proposal.fields.sessionArc,
				body: proposal.fields.body,
				parked: proposal.fields.parked?.trim() || "None",
			});
			const approval = await requestCheckpointApproval(targetChat, proposal, approvedRecentContext);
			await bindToApprovedCheckpointRuntime(approval, targetChat);
			void refreshPersistentAgentStatus();
			resetCheckpointInput();
			// Disclose what the gate no longer blocks on: elision notices from the
			// propose step ride the saved line together with approval warnings.
			const disclosedNotes = [...proposal.warnings.filter(isTranscriptElisionWarning), ...approval.warnings];
			const savedNote = disclosedNotes.length > 0 ? `Checkpoint saved to memory automatically. ${disclosedNotes.join(" ")}` : "Checkpoint saved to memory automatically.";
			setItems((s) => [...s, { kind: "system", id: nid(), text: savedNote }]);
		} catch (e) {
			setCheckpointApprovalError(`The checkpoint could not save automatically. Review and approve it manually. ${(e as Error).message}`);
		} finally {
			setCheckpointApprovalLoading(false);
		}
	}

	function resetCheckpointInput() {
		setCheckpointPreviewOpen(false);
		setCheckpointRememberText("");
		setCheckpointDensity("standard");
		setCheckpointProposal(null);
		setCheckpointProposalError(null);
		setCheckpointProposalLoading(false);
		setCheckpointApprovalError(null);
		setCheckpointApprovalLoading(false);
		setCheckpointApprovalResult(null);
		setCheckpointQuickRequested(false);
		setCheckpointQuickBlockedReasons(null);
	}

	function resetAbsorbWorkflow() {
		maintainRunRef.current += 1;
		setAbsorbWorkflow(CLOSED_ABSORB_WORKFLOW);
	}

	function resetStructuralReviewWorkflow() {
		maintainRunRef.current += 1;
		setStructuralReviewWorkflow(CLOSED_STRUCTURAL_REVIEW_WORKFLOW);
	}

	function resetMaintainWorkflows() {
		setMaintainChooserOpen(false);
		setMaintainTarget(null);
		setMaintainOrigin("home");
		setMaintainConfirm(null);
		resetAbsorbWorkflow();
		resetStructuralReviewWorkflow();
	}

	// Every user-facing exit from Maintain goes through here so the user lands
	// back where they came from (Memory page launches return to the Memory page).
	function exitMaintainWorkflows() {
		const origin = maintainOrigin;
		resetMaintainWorkflows();
		if (origin === "memory") setView("memory");
	}

	function resetLiveUiState() {
		try { wsRef.current?.close(); } catch {}
		setUsage(ZERO_USAGE);
		setContextHealth(null);
		setPreview(null);
		setBusy(false);
		setCurrentModelLabel("");
		setComposerPrefill("");
		setComposerResetNonce((value) => value + 1);
		flushAssistantStream();
		clearTransientStreamNotes();
		dispatchStream({ type: "reset" });
		toolByIdRef.current.clear();
		hiddenRoutineToolByIdRef.current.clear();
		retrievalActivityIdRef.current = null;
		resetCheckpointInput();
		resetMaintainWorkflows();
	}

	// Why this room cannot be maintained right now, in words that name the way
	// out; null when Maintain can start. Mirrors the launcher card's canMaintain.
	function maintainBlockedReason(agentId: PersistentAgentId): string | null {
		if (persistentChat) return "A room session is open. Close it, then start Maintain.";
		const status = persistentAgentStatuses.find((candidate) => candidate.id === agentId) ?? null;
		if (status?.activeLock) {
			return status.activeLock.surface === "scheduler"
				? "This room is working on a scheduled background task. Wait for it to finish, then start Maintain."
				: "This room is active in another place. Close it there, then start Maintain.";
		}
		const hasThread = (persistentThread?.state === "standby" && persistentThread.agentId === agentId)
			|| (!!status && (status.runtime.state === "standby" || status.runtime.state === "active") && !!status.runtime.activeThreadId);
		if (hasThread) return "This room has a session in progress. Resume it and save a checkpoint, then Maintain becomes available.";
		if (status && status.exists && status.status !== "ready" && status.status !== "needs_absorb") return "This room needs attention before it can be maintained.";
		return null;
	}

	function openMaintainChooser(target: MaintainTarget, origin: "home" | "memory" = "home"): boolean {
		if (maintainBlockedReason(target.agentId)) return false;
		setMaintainTarget(target);
		setMaintainOrigin(origin);
		resetAbsorbWorkflow();
		resetStructuralReviewWorkflow();
		setMaintainChooserOpen(true);
		return true;
	}

	function closeMaintainChooser() {
		exitMaintainWorkflows();
	}

	// "Start Maintain again" on error and unavailable screens: reopen the
	// chooser for the same room so a restart (or the other workflow) is one
	// click instead of a trip through the launcher.
	function restartMaintain() {
		const target = absorbWorkflow.target ?? structuralReviewWorkflow.target ?? maintainTarget;
		const origin = maintainOrigin;
		resetMaintainWorkflows();
		if (!target || !openMaintainChooser({ agentId: target.agentId, displayName: target.displayName }, origin)) {
			// The room became blocked while the user sat on the error screen;
			// say why instead of silently dismissing the click.
			if (target) setPersistentResumeError(maintainBlockedReason(target.agentId));
			if (origin === "memory") setView("memory");
		}
	}

	async function startPruneMemoryWorkflow() {
		if (persistentChat || (maintainTarget && persistentThread?.state === "standby" && persistentThread.agentId === maintainTarget.agentId)) return;
		const target = maintainTarget;
		setStructuralReviewLoadingIndex(Math.floor(Math.random() * STRUCTURAL_REVIEW_LOADING_MESSAGES.length));
		setMaintainChooserOpen(false);
		resetAbsorbWorkflow();
		if (!target) {
			setStructuralReviewWorkflow({ step: "error", target: null, availability: null, assessment: null, proposal: null, approvalResult: null, error: "Select a room before starting Review Memory." });
			return;
		}
		const run = maintainRunRef.current;
		setStructuralReviewWorkflow({ step: "checking", target, availability: null, assessment: null, proposal: null, approvalResult: null, error: null });
		try {
			const availability = await fetchStructuralReviewStatus(target.agentId);
			if (run !== maintainRunRef.current) return;
			if (!availability.available) {
				setStructuralReviewWorkflow({ step: "unavailable", target, availability, assessment: null, proposal: null, approvalResult: null, error: null });
				return;
			}
			setStructuralReviewWorkflow({ step: "assessing", target, availability, assessment: null, proposal: null, approvalResult: null, error: null });
			const assessment = await requestStructuralReviewAssessment(target.agentId);
			const fastPathEnabled = await roomFastPathEnabled(target.agentId);
			if (run !== maintainRunRef.current) return;
			setStructuralReviewWorkflow({ step: "assessment", target, availability: assessment.availability, assessment, proposal: null, approvalResult: null, fastPathEnabled, error: null });
		} catch (e) {
			if (run !== maintainRunRef.current) return;
			setStructuralReviewWorkflow({ step: "error", target, availability: null, assessment: null, proposal: null, approvalResult: null, error: formatStructuralReviewWorkflowError((e as Error).message) });
		}
	}

	function abortStructuralReviewWorkflow() {
		const hasDiscussionTranscript = (structuralReviewWorkflow.discussionMessages?.length ?? 0) > 0 && (structuralReviewWorkflow.step === "discussing" || structuralReviewWorkflow.step === "signing_off" || structuralReviewWorkflow.step === "proposing");
		if (hasDiscussionTranscript) {
			setMaintainConfirm({ title: "Abort this memory discussion?", body: "The discussion transcript is temporary and will be discarded. No memory has been changed.", confirmLabel: "Discard discussion", cancelLabel: "Keep discussing", onConfirm: exitMaintainWorkflows });
			return;
		}
		if (structuralReviewWorkflow.step === "proposal") {
			setMaintainConfirm({ title: "Discard this memory update draft?", body: "It has not been saved and will need to be generated again.", confirmLabel: "Discard draft", cancelLabel: "Keep reviewing", onConfirm: exitMaintainWorkflows });
			return;
		}
		exitMaintainWorkflows();
	}

	// Leave the discussion for the assessment it started from; only the
	// temporary transcript is discarded, after the existing confirm.
	function backToStructuralReviewAssessment() {
		if (structuralReviewWorkflow.step !== "discussing" || structuralReviewWorkflow.discussionSending) return;
		const leave = () => setStructuralReviewWorkflow((current) => current.step === "discussing" ? { ...current, step: "assessment", discussionMessages: [], discussionTokenBudget: null, discussionSending: false, discussionWarnings: null, assessmentHandoff: null, error: null } : current);
		if ((structuralReviewWorkflow.discussionMessages?.length ?? 0) > 0) {
			setMaintainConfirm({ title: "Leave this discussion?", body: "The discussion transcript is temporary and will be discarded. Your assessment is kept. No memory has been changed.", confirmLabel: "Back to assessment", cancelLabel: "Keep discussing", onConfirm: leave });
			return;
		}
		leave();
	}

	// Return from the proposal screen to the discussion it came from, keeping
	// the transcript; only the drafted proposal is dropped.
	function backToStructuralReviewDiscussion() {
		if (structuralReviewWorkflow.step !== "proposal" || !(structuralReviewWorkflow.discussionMessages?.length)) return;
		setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "discussing", proposal: null, approvalResult: null, discussionSending: false, fastPathBlockedReasons: undefined, proposalStale: false, error: null });
	}

	function startStructuralReviewDiscussion() {
		const assessment = structuralReviewWorkflow.assessment;
		if (!assessment || structuralReviewWorkflow.step !== "assessment") return;
		setStructuralReviewWorkflow({
			...structuralReviewWorkflow,
			step: "discussing",
			proposal: null,
			approvalResult: null,
			discussionMessages: [],
			discussionTokenBudget: null,
			discussionSending: false,
			assessmentHandoff: null,
			error: null,
		});
	}

	async function sendStructuralReviewDiscussionMessage(message: string) {
		const assessment = structuralReviewWorkflow.assessment;
		const target = structuralReviewWorkflow.target;
		if (!assessment || structuralReviewWorkflow.step !== "discussing" || structuralReviewWorkflow.discussionSending) return;
		if (!target) {
			setStructuralReviewWorkflow({ ...structuralReviewWorkflow, error: "Review Memory target is missing. Return to the launcher and choose a room again." });
			return;
		}
		const userMessage: StructuralReviewDiscussionMessage = { role: "user", content: message.trim() };
		if (!userMessage.content) return;
		const priorMessages = structuralReviewWorkflow.discussionMessages ?? [];
		const optimisticMessages = [...priorMessages, userMessage];
		const run = maintainRunRef.current;
		setStructuralReviewWorkflow({ ...structuralReviewWorkflow, discussionMessages: optimisticMessages, discussionSending: true, error: null });
		try {
			const response = await requestStructuralReviewDiscussionTurn(target.agentId, {
				source: assessment.source,
				assessmentMarkdown: assessment.assessmentMarkdown,
				messages: priorMessages,
				userMessage: userMessage.content,
			});
			if (run !== maintainRunRef.current) return;
			setStructuralReviewWorkflow({
				...structuralReviewWorkflow,
				step: "discussing",
				availability: response.availability,
				discussionMessages: [...optimisticMessages, response.message],
				discussionTokenBudget: response.tokenBudget,
				discussionSending: false,
				discussionWarnings: response.warnings.filter((warning) => !/no memory has been written/i.test(warning)).join("\n") || null,
				error: null,
			});
		} catch (e) {
			if (run !== maintainRunRef.current) return;
			setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "discussing", discussionMessages: optimisticMessages, discussionSending: false, error: formatStructuralReviewWorkflowError((e as Error).message) });
		}
	}

	async function generateStructuralReviewProposalFromDiscussion() {
		const assessment = structuralReviewWorkflow.assessment;
		const target = structuralReviewWorkflow.target;
		const messages = structuralReviewWorkflow.discussionMessages ?? [];
		if (!assessment || structuralReviewWorkflow.step !== "discussing" || messages.length === 0 || structuralReviewWorkflow.discussionSending) return;
		if (!target) {
			setStructuralReviewWorkflow({ ...structuralReviewWorkflow, error: "Review Memory target is missing. Return to the launcher and choose a room again." });
			return;
		}
		const run = maintainRunRef.current;
		setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "signing_off", error: null });
		try {
			const signoff = await requestStructuralReviewDiscussionSignoff(target.agentId, {
				source: assessment.source,
				assessmentMarkdown: assessment.assessmentMarkdown,
				messages,
			});
			if (run !== maintainRunRef.current) return;
			setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "proposing", availability: signoff.availability, assessmentHandoff: signoff.assessmentHandoff, discussionTokenBudget: signoff.tokenBudget, error: null });
			const proposal = await requestStructuralReviewProposal(target.agentId, assessment.assessmentMarkdown, {
				assessmentHandoff: signoff.assessmentHandoff,
				source: assessment.source,
			});
			if (run !== maintainRunRef.current) return;
			const proposalState: StructuralReviewWorkflowState = {
				step: "proposal",
				target,
				availability: proposal.availability,
				assessment,
				proposal,
				approvalResult: null,
				discussionMessages: messages,
				discussionTokenBudget: signoff.tokenBudget,
				assessmentHandoff: signoff.assessmentHandoff,
				fastPathEnabled: structuralReviewWorkflow.fastPathEnabled,
				error: null,
			};
			if (await maybeFastPathStructuralReviewApproval(target, proposal, proposalState, run)) return;
			setStructuralReviewWorkflow(proposalState);
		} catch (e) {
			if (run !== maintainRunRef.current) return;
			setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "discussing", discussionSending: false, error: formatStructuralReviewWorkflowError((e as Error).message) });
		}
	}

	async function generateStructuralReviewProposal() {
		const assessment = structuralReviewWorkflow.assessment;
		const target = structuralReviewWorkflow.target;
		if (!assessment || structuralReviewWorkflow.step === "proposing") return;
		if (!target) {
			setStructuralReviewWorkflow({ ...structuralReviewWorkflow, error: "Review Memory target is missing. Return to the launcher and choose a room again." });
			return;
		}
		const run = maintainRunRef.current;
		const priorProposal = structuralReviewWorkflow.proposal;
		const priorStale = structuralReviewWorkflow.proposalStale;
		setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "proposing", proposal: null, approvalResult: null, proposalStale: false, error: null });
		try {
			// Redrafts keep honoring a discussion the user already had.
			const handoff = structuralReviewWorkflow.assessmentHandoff;
			const proposal = await requestStructuralReviewProposal(target.agentId, assessment.assessmentMarkdown, handoff ? { assessmentHandoff: handoff, source: assessment.source } : undefined);
			if (run !== maintainRunRef.current) return;
			const proposalState: StructuralReviewWorkflowState = { step: "proposal", target, availability: proposal.availability, assessment, proposal, approvalResult: null, discussionMessages: structuralReviewWorkflow.discussionMessages, discussionTokenBudget: structuralReviewWorkflow.discussionTokenBudget, assessmentHandoff: handoff, fastPathEnabled: structuralReviewWorkflow.fastPathEnabled, error: null };
			if (await maybeFastPathStructuralReviewApproval(target, proposal, proposalState, run)) return;
			setStructuralReviewWorkflow(proposalState);
		} catch (e) {
			if (run !== maintainRunRef.current) return;
			// A failed draft never destroys work: a prior proposal (Draft again)
			// is restored, otherwise the assessment survives with an inline error.
			const draftError = formatMaintenanceDraftError((e as Error).message);
			if (priorProposal) setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "proposal", proposal: priorProposal, approvalResult: null, proposalStale: priorStale, error: draftError });
			else setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "assessment", proposal: null, approvalResult: null, error: draftError });
		}
	}

	async function approveStructuralReviewProposal() {
		const proposal = structuralReviewWorkflow.proposal;
		const target = structuralReviewWorkflow.target;
		if (!proposal || !proposal.candidateValidation.valid || structuralReviewWorkflow.step === "approving") return;
		if (!target) {
			setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "proposal", error: "Review Memory target is missing. No memory was updated. Return to the launcher and choose a room again." });
			return;
		}
		if (proposal.agentId !== target.agentId) {
			setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "proposal", error: "This proposal belongs to a different room. No memory was updated. Restart Maintain for this room." });
			return;
		}
		setMaintainConfirm({
			title: `Apply this memory update to ${target.displayName}?`,
			body: "Deep Memory and Active Items are tightened; the timeline and Recent Context stay exactly as they are. The current memory is archived first, so nothing is lost.",
			confirmLabel: "Approve and update",
			cancelLabel: "Keep reviewing",
			onConfirm: () => { void performStructuralReviewApproval(target, proposal); },
		});
	}

	async function performStructuralReviewApproval(target: MaintainTarget, proposal: StructuralReviewProposalResponse) {
		const run = maintainRunRef.current;
		setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "approving", error: null });
		try {
			const approvalResult = await requestStructuralReviewApproval(target.agentId, proposal);
			await refreshPersistentAgentStatus();
			if (run !== maintainRunRef.current) return;
			setStructuralReviewWorkflow({ step: "saved", target, availability: proposal.availability, assessment: structuralReviewWorkflow.assessment, proposal, approvalResult, error: null });
		} catch (e) {
			if (run !== maintainRunRef.current) return;
			const raw = (e as Error).message;
			setStructuralReviewWorkflow({ ...structuralReviewWorkflow, step: "proposal", proposal, approvalResult: null, proposalStale: isUnappliableProposalMessage(raw), error: formatMaintenanceApprovalError(raw) });
		}
	}

	function abortAbsorbWorkflow() {
		const hasDiscussionTranscript = (absorbWorkflow.discussionMessages?.length ?? 0) > 0 && (absorbWorkflow.step === "discussing" || absorbWorkflow.step === "signing_off" || absorbWorkflow.step === "proposing");
		if (hasDiscussionTranscript) {
			setMaintainConfirm({ title: "Abort this memory discussion?", body: "The discussion transcript is temporary and will be discarded. No memory has been changed.", confirmLabel: "Discard discussion", cancelLabel: "Keep discussing", onConfirm: exitMaintainWorkflows });
			return;
		}
		if (absorbWorkflow.step === "proposal") {
			setMaintainConfirm({ title: "Discard this memory update draft?", body: "It has not been saved and will need to be generated again.", confirmLabel: "Discard draft", cancelLabel: "Keep reviewing", onConfirm: exitMaintainWorkflows });
			return;
		}
		exitMaintainWorkflows();
	}

	// Leave the discussion for the assessment it started from; only the
	// temporary transcript is discarded, after the existing confirm.
	function backToAbsorbAssessment() {
		if (absorbWorkflow.step !== "discussing" || absorbWorkflow.discussionSending) return;
		const leave = () => setAbsorbWorkflow((current) => current.step === "discussing" ? { ...current, step: "assessment", discussionMessages: [], discussionTokenBudget: null, discussionSending: false, discussionWarnings: null, assessmentHandoff: null, error: null } : current);
		if ((absorbWorkflow.discussionMessages?.length ?? 0) > 0) {
			setMaintainConfirm({ title: "Leave this discussion?", body: "The discussion transcript is temporary and will be discarded. Your assessment is kept. No memory has been changed.", confirmLabel: "Back to assessment", cancelLabel: "Keep discussing", onConfirm: leave });
			return;
		}
		leave();
	}

	// Return from the proposal screen to the discussion it came from, keeping
	// the transcript; only the drafted proposal is dropped.
	function backToAbsorbDiscussion() {
		if (absorbWorkflow.step !== "proposal" || !(absorbWorkflow.discussionMessages?.length)) return;
		setAbsorbWorkflow({ ...absorbWorkflow, step: "discussing", proposal: null, approvalResult: null, discussionSending: false, fastPathBlockedReasons: undefined, proposalStale: false, error: null });
	}

	function setAbsorbUnavailable(availability: AbsorbAvailability, target: MaintainTarget | null = absorbWorkflow.target) {
		setAbsorbWorkflow({ step: "unavailable", target, availability, assessment: null, proposal: null, approvalResult: null, error: null });
	}

	function setAbsorbError(error: string, availability: AbsorbAvailability | null = null, target: MaintainTarget | null = absorbWorkflow.target) {
		setAbsorbWorkflow({ step: "error", target, availability, assessment: null, proposal: null, approvalResult: null, error });
	}

	async function startAbsorbWorkflow() {
		if (persistentChat || (maintainTarget && persistentThread?.state === "standby" && persistentThread.agentId === maintainTarget.agentId)) return;
		const target = maintainTarget;
		setMaintainChooserOpen(false);
		resetStructuralReviewWorkflow();
		if (!target) {
			setAbsorbError("Select a room before starting Learn.", null, null);
			return;
		}
		setAbsorbLoadingIndex(Math.floor(Math.random() * ABSORB_LOADING_MESSAGES.length));
		const run = maintainRunRef.current;
		setAbsorbWorkflow({ step: "checking", target, availability: null, assessment: null, proposal: null, approvalResult: null, error: null });
		try {
			const availability = await fetchAbsorbStatus(target.agentId);
			if (run !== maintainRunRef.current) return;
			if (!availability.available) {
				setAbsorbUnavailable(availability, target);
				return;
			}
			setAbsorbWorkflow({ step: "assessing", target, availability, assessment: null, proposal: null, approvalResult: null, error: null });
			const assessment = await requestAbsorbAssessment(target.agentId);
			const fastPathEnabled = await roomFastPathEnabled(target.agentId);
			if (run !== maintainRunRef.current) return;
			setAbsorbWorkflow({ step: "assessment", target, availability: assessment.availability, assessment, proposal: null, approvalResult: null, fastPathEnabled, error: null });
		} catch (e) {
			if (run !== maintainRunRef.current) return;
			setAbsorbError(formatAbsorbWorkflowError((e as Error).message), null, target);
		}
	}

	function startAbsorbDiscussion() {
		const assessment = absorbWorkflow.assessment;
		if (!assessment || absorbWorkflow.step !== "assessment") return;
		setAbsorbWorkflow({
			...absorbWorkflow,
			step: "discussing",
			proposal: null,
			approvalResult: null,
			discussionMessages: [],
			discussionTokenBudget: null,
			discussionSending: false,
			assessmentHandoff: null,
			error: null,
		});
	}

	async function sendAbsorbDiscussionMessage(message: string) {
		const assessment = absorbWorkflow.assessment;
		const target = absorbWorkflow.target;
		if (!assessment || absorbWorkflow.step !== "discussing" || absorbWorkflow.discussionSending) return;
		if (!target) {
			setAbsorbWorkflow({ ...absorbWorkflow, error: "The Learn target is missing. Return to the launcher and choose a room again." });
			return;
		}
		const userMessage: AbsorbDiscussionMessage = { role: "user", content: message.trim() };
		if (!userMessage.content) return;
		const priorMessages = absorbWorkflow.discussionMessages ?? [];
		const optimisticMessages = [...priorMessages, userMessage];
		const run = maintainRunRef.current;
		setAbsorbWorkflow({ ...absorbWorkflow, discussionMessages: optimisticMessages, discussionSending: true, error: null });
		try {
			const response = await requestAbsorbDiscussionTurn(target.agentId, {
				source: assessment.source,
				assessmentMarkdown: assessment.assessmentMarkdown,
				messages: priorMessages,
				userMessage: userMessage.content,
			});
			if (run !== maintainRunRef.current) return;
			setAbsorbWorkflow({
				...absorbWorkflow,
				step: "discussing",
				availability: response.availability,
				discussionMessages: [...optimisticMessages, response.message],
				discussionTokenBudget: response.tokenBudget,
				discussionSending: false,
				discussionWarnings: response.warnings.filter((warning) => !/no memory has been written/i.test(warning)).join("\n") || null,
				error: null,
			});
		} catch (e) {
			if (run !== maintainRunRef.current) return;
			setAbsorbWorkflow({ ...absorbWorkflow, step: "discussing", discussionMessages: optimisticMessages, discussionSending: false, error: formatAbsorbWorkflowError((e as Error).message) });
		}
	}

	async function generateAbsorbProposalFromDiscussion() {
		const assessment = absorbWorkflow.assessment;
		const target = absorbWorkflow.target;
		const messages = absorbWorkflow.discussionMessages ?? [];
		if (!assessment || absorbWorkflow.step !== "discussing" || messages.length === 0 || absorbWorkflow.discussionSending) return;
		if (!target) {
			setAbsorbWorkflow({ ...absorbWorkflow, error: "The Learn target is missing. Return to the launcher and choose a room again." });
			return;
		}
		const run = maintainRunRef.current;
		setAbsorbWorkflow({ ...absorbWorkflow, step: "signing_off", error: null });
		try {
			const signoff = await requestAbsorbDiscussionSignoff(target.agentId, {
				source: assessment.source,
				assessmentMarkdown: assessment.assessmentMarkdown,
				messages,
			});
			if (run !== maintainRunRef.current) return;
			setAbsorbWorkflow({ ...absorbWorkflow, step: "proposing", availability: signoff.availability, assessmentHandoff: signoff.assessmentHandoff, discussionTokenBudget: signoff.tokenBudget, error: null });
			const proposal = await requestAbsorbProposal(target.agentId, assessment.assessmentMarkdown, {
				assessmentHandoff: signoff.assessmentHandoff,
				source: assessment.source,
			});
			if (run !== maintainRunRef.current) return;
			const proposalState: AbsorbWorkflowState = {
				step: "proposal",
				target,
				availability: proposal.availability,
				assessment,
				proposal,
				approvalResult: null,
				discussionMessages: messages,
				discussionTokenBudget: signoff.tokenBudget,
				assessmentHandoff: signoff.assessmentHandoff,
				fastPathEnabled: absorbWorkflow.fastPathEnabled,
				error: null,
			};
			if (await maybeFastPathAbsorbApproval(target, proposal, proposalState, run)) return;
			setAbsorbWorkflow(proposalState);
		} catch (e) {
			if (run !== maintainRunRef.current) return;
			setAbsorbWorkflow({ ...absorbWorkflow, step: "discussing", discussionSending: false, error: formatAbsorbWorkflowError((e as Error).message) });
		}
	}

	async function generateAbsorbProposal() {
		const assessment = absorbWorkflow.assessment;
		const target = absorbWorkflow.target;
		if (!assessment || absorbWorkflow.step === "proposing") return;
		if (!target) {
			setAbsorbWorkflow({ ...absorbWorkflow, error: "The Learn target is missing. Return to the launcher and choose a room again." });
			return;
		}
		const run = maintainRunRef.current;
		const priorProposal = absorbWorkflow.proposal;
		const priorStale = absorbWorkflow.proposalStale;
		setAbsorbWorkflow({ ...absorbWorkflow, step: "proposing", proposal: null, approvalResult: null, proposalStale: false, error: null });
		try {
			// Redrafts keep honoring a discussion the user already had.
			const handoff = absorbWorkflow.assessmentHandoff;
			const proposal = await requestAbsorbProposal(target.agentId, assessment.assessmentMarkdown, handoff ? { assessmentHandoff: handoff, source: assessment.source } : undefined);
			if (run !== maintainRunRef.current) return;
			const proposalState: AbsorbWorkflowState = { step: "proposal", target, availability: proposal.availability, assessment, proposal, approvalResult: null, discussionMessages: absorbWorkflow.discussionMessages, discussionTokenBudget: absorbWorkflow.discussionTokenBudget, assessmentHandoff: handoff, fastPathEnabled: absorbWorkflow.fastPathEnabled, error: null };
			if (await maybeFastPathAbsorbApproval(target, proposal, proposalState, run)) return;
			setAbsorbWorkflow(proposalState);
		} catch (e) {
			if (run !== maintainRunRef.current) return;
			// A failed draft never destroys work: a prior proposal (Draft again)
			// is restored, otherwise the assessment survives with an inline error.
			const draftError = formatMaintenanceDraftError((e as Error).message);
			if (priorProposal) setAbsorbWorkflow({ ...absorbWorkflow, step: "proposal", proposal: priorProposal, approvalResult: null, proposalStale: priorStale, error: draftError });
			else setAbsorbWorkflow({ ...absorbWorkflow, step: "assessment", proposal: null, approvalResult: null, error: draftError });
		}
	}


	async function roomFastPathEnabled(agentId: PersistentAgentId): Promise<boolean> {
		try {
			return (await fetchPersistentRoomMaintenanceSettings(agentId)).settings.fastPathSecondApproval === true;
		} catch {
			return false;
		}
	}

	async function roomQuickCheckpointAutoApplyEnabled(agentId: PersistentAgentId): Promise<boolean> {
		try {
			return (await fetchPersistentRoomMaintenanceSettings(agentId)).settings.quickCheckpointAutoApply === true;
		} catch {
			// When the preference cannot be read, fall back to manual review —
			// the safe direction is showing the proposal, not silently applying it.
			return false;
		}
	}

	/**
	 * Fast path: when the room opts in and the proposal is warning-free, apply
	 * it immediately instead of showing the second approval screen. Returns
	 * true when it has taken over the workflow state (applied or failed back
	 * to the manual proposal screen); false means show the proposal as usual.
	 */
	async function maybeFastPathAbsorbApproval(target: MaintainTarget, proposal: AbsorbProposalResponse, proposalState: AbsorbWorkflowState, run: number): Promise<boolean> {
		const fastPathOn = await roomFastPathEnabled(target.agentId);
		// A cancelled run must never reach the automatic write, and must not
		// return false here either: the caller would then restore the cancelled
		// run's proposal state unguarded.
		if (run !== maintainRunRef.current) return true;
		if (!fastPathOn) return false;
		const blockers = maintenanceFastPathBlockers(proposal);
		if (blockers.length > 0) {
			setAbsorbWorkflow({ ...proposalState, fastPathBlockedReasons: blockers });
			return true;
		}
		setAbsorbWorkflow({ ...proposalState, step: "approving", fastPathApplied: true, error: null });
		try {
			const approvalResult = await requestAbsorbApproval(target.agentId, proposal);
			await refreshPersistentAgentStatus();
			if (run !== maintainRunRef.current) return true;
			setAbsorbWorkflow({ ...proposalState, step: "saved", availability: { ...proposal.availability, recentContextEntryCount: approvalResult.recentContextEntryCount }, approvalResult, fastPathApplied: true, error: null });
		} catch (e) {
			if (run !== maintainRunRef.current) return true;
			const raw = (e as Error).message;
			// Stale and safety-limit failures already tell the user what to do;
			// the manual-approval framing would contradict them.
			const blocked = isUnappliableProposalMessage(raw);
			setAbsorbWorkflow({ ...proposalState, step: "proposal", proposalStale: blocked, error: blocked ? formatAbsorbApprovalError(raw) : `Automatic memory maintenance could not apply this proposal. Review and approve it manually. ${raw}` });
		}
		return true;
	}

	async function maybeFastPathStructuralReviewApproval(target: MaintainTarget, proposal: StructuralReviewProposalResponse, proposalState: StructuralReviewWorkflowState, run: number): Promise<boolean> {
		const fastPathOn = await roomFastPathEnabled(target.agentId);
		// A cancelled run must never reach the automatic write, and must not
		// return false here either: the caller would then restore the cancelled
		// run's proposal state unguarded.
		if (run !== maintainRunRef.current) return true;
		if (!fastPathOn) return false;
		const blockers = maintenanceFastPathBlockers(proposal);
		if (blockers.length > 0) {
			setStructuralReviewWorkflow({ ...proposalState, fastPathBlockedReasons: blockers });
			return true;
		}
		setStructuralReviewWorkflow({ ...proposalState, step: "approving", fastPathApplied: true, error: null });
		try {
			const approvalResult = await requestStructuralReviewApproval(target.agentId, proposal);
			await refreshPersistentAgentStatus();
			if (run !== maintainRunRef.current) return true;
			setStructuralReviewWorkflow({ ...proposalState, step: "saved", approvalResult, fastPathApplied: true, error: null });
		} catch (e) {
			if (run !== maintainRunRef.current) return true;
			const raw = (e as Error).message;
			// Stale and safety-limit failures already tell the user what to do;
			// the manual-approval framing would contradict them.
			const blocked = isUnappliableProposalMessage(raw);
			setStructuralReviewWorkflow({ ...proposalState, step: "proposal", proposalStale: blocked, error: blocked ? formatMaintenanceApprovalError(raw) : `Automatic memory maintenance could not apply this proposal. Review and approve it manually. ${raw}` });
		}
		return true;
	}

	async function approveAbsorbProposal() {
		const proposal = absorbWorkflow.proposal;
		const target = absorbWorkflow.target;
		if (!proposal || !proposal.candidateValidation.valid || absorbWorkflow.step === "approving") return;
		if (!target) {
			setAbsorbWorkflow({ ...absorbWorkflow, step: "proposal", error: "The Learn target is missing. No memory was updated. Return to the launcher and choose a room again." });
			return;
		}
		if (proposal.agentId !== target.agentId) {
			setAbsorbWorkflow({ ...absorbWorkflow, step: "proposal", error: "This proposal belongs to a different room. No memory was updated. Restart Maintain for this room." });
			return;
		}
		setMaintainConfirm({
			title: `Apply this memory update to ${target.displayName}?`,
			body: "Recent Sessions are consolidated into deep memory. The current memory is archived first, so nothing is lost.",
			confirmLabel: "Approve and update",
			cancelLabel: "Keep reviewing",
			onConfirm: () => { void performAbsorbApproval(target, proposal); },
		});
	}

	async function performAbsorbApproval(target: MaintainTarget, proposal: AbsorbProposalResponse) {
		const run = maintainRunRef.current;
		setAbsorbWorkflow({ ...absorbWorkflow, step: "approving", error: null });
		try {
			const approvalResult = await requestAbsorbApproval(target.agentId, proposal);
			await refreshPersistentAgentStatus();
			if (run !== maintainRunRef.current) return;
			setAbsorbWorkflow({ step: "saved", target, availability: { ...proposal.availability, recentContextEntryCount: approvalResult.recentContextEntryCount }, assessment: absorbWorkflow.assessment, proposal, approvalResult, error: null });
		} catch (e) {
			if (run !== maintainRunRef.current) return;
			const raw = (e as Error).message;
			setAbsorbWorkflow({ ...absorbWorkflow, step: "proposal", proposal, approvalResult: null, proposalStale: isUnappliableProposalMessage(raw), error: formatAbsorbApprovalError(raw) });
		}
	}

	async function openPersistentAgent(target: PersistentAgentTarget, model: WebChatModelOption) {
		const label = target.displayName?.trim() || "Exxpert";
		// An empty prepared boundary thread (post-checkpoint/Memento) only pins
		// the model while it exists. Entering with a fresh session retires it
		// first so the room starts on the model the user picked.
		const targetStatus = persistentAgentStatuses.find((candidate) => candidate.id === target.id) ?? null;
		const preparedThreadId = targetStatus && (targetStatus.runtime.state === "standby" || targetStatus.runtime.state === "active") ? targetStatus.runtime.activeThreadId : null;
		const targetPreparedBoundary = targetStatus?.activeThread?.preparedByBoundary ?? (targetStatus?.activeThread?.preparedByCheckpoint ? "checkpoint" : null);
		if (preparedThreadId && targetPreparedBoundary && !targetStatus?.activeThread?.hasUserVisibleTurns) {
			try {
				await discardEmptyPreparedBoundaryThread(target.id, preparedThreadId);
			} catch (e) {
				// The snapshot may be stale (another tab already retired the prepared
				// thread). Re-check: only fall through to a fresh entry when the room
				// runtime is idle now; any remaining thread still blocks fresh entry.
				let blocked = true;
				try {
					const statuses = await fetchPersistentAgentStatuses();
					const fresh = statuses.find((candidate) => candidate.id === target.id) ?? null;
					blocked = !fresh || (fresh.runtime.state !== "idle" && !!fresh.runtime.activeThreadId);
				} catch {}
				if (blocked) {
					setPersistentResumeError((e as Error).message);
					await refreshPersistentAgentStatus();
					return;
				}
			}
		}
		const nextConversationId = newConversationId();
		setPersistentResumeError(null);
		resetLiveUiState();
		setPersistentThread(null);
		setPersistentChat(null);
		const nextThread: PersistentAgentThread = { state: "live", agentId: target.id, displayName: label, conversationId: nextConversationId, model, items: [] };
		setConversationId(nextConversationId);
		setItems([]);
		setPersistentThread(nextThread);
		setPersistentChat({ agentId: nextThread.agentId, displayName: nextThread.displayName, conversationId: nextThread.conversationId, model: nextThread.model });
		// A fresh conversation starts with an empty pending-transfer queue.
		applyPendingHandoffs([], new Set());
		try {
			await savePersistentAgentThread(nextThread, "active", "launcher", [], []);
		} catch (e) {
			// The server rejected the new conversation (model gate after a
			// concurrent profile change, or the room's state moved). Entering
			// anyway would drop the user's first message into a thread the server
			// never accepted — surface the rejection on the launcher instead.
			setPersistentChat(null);
			setPersistentThread(null);
			setItems([]);
			setPersistentResumeError((e as Error).message);
			await refreshPersistentAgentStatus();
			return;
		}
		setCurrentModelLabel(modelDisplayName(model));
		setView("chat");
		setSessionVersion((v) => v + 1);
	}

	async function openPersistentAgentResume(status: PersistentAgentStatus) {
		setPersistentResumeError(null);
		const runtimeThreadId = status.runtime.state === "standby" || status.runtime.state === "active" ? status.runtime.activeThreadId : null;
		const localThreadId = persistentThread?.agentId === status.id && (persistentThread.state === "standby" || persistentThread.state === "live") ? persistentThread.conversationId : null;
		const threadId = runtimeThreadId || localThreadId;
		if (!threadId) {
			setPersistentResumeError("No standby thread was found for this room. Refresh Home and try again.");
			await refreshPersistentAgentStatus();
			return;
		}
		try {
			const record = await fetchPersistentAgentThread(status.id, threadId);
			const thread = threadRecordToLocalThread(record, status.displayName || "Exxpert");
			const liveThread = { ...thread, state: "live" as const };
			// Standby → resume re-queues the persisted pending-transfer queue (§2.3)
			// before the first save, so a stale ref from a prior room can't leak in.
			const restoredQueue = readConsultHandoffQueue(record.pendingHandoffs);
			applyPendingHandoffs(restoredQueue, deriveTrailingConsultIds(liveThread.items, restoredQueue.length));
			await savePersistentAgentThread(liveThread, "active", "launcher", liveThread.items, restoredQueue);
			resetLiveUiState();
			setPersistentThread(null);
			setPersistentChat(null);
			setConversationId(liveThread.conversationId);
			setItems(liveThread.items);
			setPersistentThread(liveThread);
			setPersistentChat({ agentId: liveThread.agentId, displayName: liveThread.displayName, conversationId: liveThread.conversationId, model: liveThread.model });
			setCurrentModelLabel(modelDisplayName(liveThread.model));
			setView("chat");
			setSessionVersion((v) => v + 1);
		} catch (e) {
			setPersistentResumeError(formatDirectResumeError(e));
			setView("home");
			await refreshPersistentAgentStatus();
		}
	}

	async function mementoPersistentThread() {
		const targetChat = persistentChat;
		if (!targetChat) return;
		// Memento always works, even mid-stream: the server stops the current
		// response, closes the thread and opens a fresh one.
		const inFlightWarning = persistentRoomInFlight ? "The response currently being written will be stopped.\n\n" : "";
		const ok = window.confirm(`Forget this conversation and start fresh?\n\n${inFlightWarning}This will discard the current room transcript. Nothing will be checkpointed into memory.`);
		if (!ok) return;
		try {
			setBusy(true);
			const result = await applyPersistentAgentMemento(targetChat.agentId, targetChat.conversationId);
			const currentChat = persistentChatRef.current;
			if (!currentChat || currentChat.agentId !== targetChat.agentId) throw new Error("Memento target changed. Please reopen the room and try again.");
			if (result.agentId !== targetChat.agentId) throw new Error("Memento response does not match the current room.");
			await bindToMementoRuntime(result, targetChat);
			void refreshPersistentAgentStatus();
		} catch (e) {
			setBusy(false);
			setItems((s) => [...s, { kind: "system", id: nid(), text: (e as Error).message, level: "error" }]);
		}
	}

	function continueAfterCheckpoint() {
		const approval = checkpointApprovalResult;
		const targetChat = persistentChat;
		if (approval && targetChat && targetChat.conversationId !== approval.postCheckpoint.activeThreadId) {
			void bindToApprovedCheckpointRuntime(approval, targetChat).then(() => resetCheckpointInput()).catch((error) => setCheckpointApprovalError((error as Error).message));
			return;
		}
		resetCheckpointInput();
	}

	async function restAfterCheckpoint() {
		const approval = checkpointApprovalResult;
		const postCheckpointThreadId = approval?.postCheckpoint.activeThreadId;
		if (approval && postCheckpointThreadId) {
			try {
				await discardEmptyPreparedBoundaryThread(approval.agentId, postCheckpointThreadId);
			} catch (e) {
				setCheckpointApprovalError((e as Error).message);
				return;
			}
		} else if (!approval && persistentChat) {
			void setPersistentRuntimeIdle(persistentChat.agentId);
		}
		setPersistentThread(null);
		setPersistentChat(null);
		resetLiveUiState();
		applyPendingHandoffs([], new Set());
		setConversationId(newConversationId());
		setItems([]);
		setView("home");
		void refreshPersistentAgentStatus();
	}

	const resolveApproval = useCallback((requestId: string, value: any, label: string) => {
		// Clear the right pane only when it currently shows the approval preview —
		// leave an artifact viewer (or any other occupant) the user is reading in
		// place. The preview payload carries no per-approval identity, so pane kind
		// is the only available discriminant.
		setRightPane((cur) => (cur?.kind === "preview" ? null : cur));
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "ui_response", id: requestId, value }));
		}
		setItems((s) =>
			s.map((it) =>
				it.kind === "approval" && it.requestId === requestId ? { ...it, done: label } : it,
			),
		);
	}, []);

	const openApprovalPreview = useCallback((next: ApprovalPreviewData) => {
		setPreview(next);
	}, []);

	// V5: open a task artifact beside the chat (the pane's second occupant).
	// Every fresh open starts un-maximized; opening over a preview (or vice
	// versa) swaps the occupant — one slot, last click wins. Whatever the entry
	// path (done card, thread item, Assets row), the viewer gets the SAME
	// reconstituted done-card chrome (Borja, live test 2026-07-18): the asset
	// row rides along when the ledger has it, with a card-state fallback for
	// the beat between task_end and the panel refetch landing.
	const openArtifactViewer = useCallback((taskId: string, templateLabel: string, artifact: { relativePath: string; extension: string }) => {
		setArtifactMaximized(false);
		markAssetRowViewed(taskId);
		let asset = assetRowsRef.current.find((candidate) => candidate.taskId === taskId && candidate.artifacts.length > 0);
		if (!asset) {
			const task = taskStateRef.current;
			if (task.taskId === taskId && task.phase === "done" && task.artifacts.length > 0) {
				asset = {
					taskId,
					title: assetDisplayTitle(task.title || "Specialist task", task.artifacts),
					iconLabel: "",
					running: false,
					unread: false,
					failed: false,
					orphan: false,
					subline: "",
					inConversation: false,
					originLine: "",
					templateId: task.template ?? "",
					templateVersion: task.templateVersion ?? 1,
					summary: task.summary,
					generatedAt: task.generatedAt ?? "",
					artifacts: task.artifacts.map((a) => ({ relativePath: a.relativePath, bytes: a.bytes, extension: a.extension })),
				};
			}
		}
		if (!asset) {
			// Transferred thread items from before the ledger existed still get
			// the same chrome — the item carries everything the viewer needs.
			const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "task" }> => it.kind === "task" && it.taskId === taskId);
			if (item && item.artifacts.length > 0) {
				asset = {
					taskId,
					title: assetDisplayTitle(item.title || "Specialist task", item.artifacts),
					iconLabel: "",
					running: false,
					unread: false,
					failed: false,
					orphan: false,
					subline: "",
					inConversation: true,
					originLine: "",
					templateId: item.template,
					templateVersion: item.templateVersion ?? 1,
					summary: item.summary,
					generatedAt: item.generatedAt,
					artifacts: item.artifacts.map((a) => ({ relativePath: a.relativePath, bytes: a.bytes, extension: a.extension })),
				};
			}
		}
		setTaskIterateNotice(null);
		setRightPane({ kind: "artifactViewer", taskId, templateLabel, artifact, ...(asset ? { asset } : {}) });
	}, []);

	// V5 export (D7): the click IS the approval — no ui_request bridge. Server
	// messages are already user-facing, so failures surface verbatim. A name
	// collision opens the three-button dialog; Replace/Keep both re-enter here
	// with the matching explicit flag (assets contract §5).
	const saveArtifactToWorkspace = useCallback(async (occupant: { taskId: string; artifact: { relativePath: string; extension: string } }, resolution?: "overwrite" | "rename") => {
		const roomId = persistentChat?.agentId;
		if (!roomId) {
			setExportNotice({ kind: "error", text: "Open a room with a workspace to save this artifact." });
			return;
		}
		try {
			const res = await apiFetch(`/api/artifacts/${encodeURIComponent(occupant.taskId)}/export`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				// conversationId → the server resolves the THREAD-effective workspace
				// policy (thread override → room default), not just the room default.
				body: JSON.stringify({
					relativePath: occupant.artifact.relativePath,
					roomId,
					conversationId: persistentChat?.conversationId ?? "",
					...(resolution === "overwrite" ? { overwrite: true } : {}),
					...(resolution === "rename" ? { rename: true } : {}),
				}),
			});
			const data = await res.json().catch(() => null);
			if (!res.ok) {
				if (res.status === 409 && data?.code === "exists") {
					const fileName = occupant.artifact.relativePath.split("/").pop() ?? "this file";
					setExportCollision({
						fileName,
						onReplace: () => void saveArtifactToWorkspace(occupant, "overwrite"),
						onKeepBoth: () => void saveArtifactToWorkspace(occupant, "rename"),
					});
					return;
				}
				setExportNotice({ kind: "error", text: data?.error || "Could not save to the room workspace." });
				return;
			}
			const savedTo = String(data?.savedTo ?? "");
			const exportedName = savedTo ? (savedTo.split(/[\\/]/).pop() ?? "") : "";
			const isHtml = occupant.artifact.extension.toLowerCase() === ".html";
			setExportNotice({
				kind: "success",
				// Filename, not the full path (Borja, live test 2026-07-18) — but the
				// NAME must be the server's savedTo: with Keep both it was suffixed,
				// and that is the one thing the user has to learn from this toast.
				text: (exportedName ? `Saved “${exportedName}” to the room workspace.` : "Saved to the room workspace.") + (isHtml ? " Note: once saved, HTML files open outside the app's protections." : ""),
			});
			// G2-A awareness notice: rides the pending-handoff queue ahead of the
			// next prompt, so the room learns the export happened. Zero new access
			// — the workspace is already room-readable.
			if (savedTo) {
				applyPendingHandoffs([...pendingHandoffsRef.current, `[WORKSPACE EXPORT] Exported ${exportedName || savedTo} to the room workspace: ${savedTo}`], pendingConsultItemIdsRef.current);
			}
			// The row's subline may flip to "in workspace" — refetch the ledger view.
			void refreshAssetRows();
		} catch {
			setExportNotice({ kind: "error", text: "Could not save to the room workspace." });
		}
	}, [persistentChat]);

	useEffect(() => {
		if (!taskDoneToast) return;
		const timer = window.setTimeout(() => setTaskDoneToast(null), 6000);
		return () => window.clearTimeout(timer);
	}, [taskDoneToast]);
	useEffect(() => {
		if (!exportNotice) return;
		const timer = window.setTimeout(() => setExportNotice(null), 6000);
		return () => window.clearTimeout(timer);
	}, [exportNotice]);
	useEffect(() => {
		if (!removeNotice) return;
		const timer = window.setTimeout(() => setRemoveNotice(null), 6000);
		return () => window.clearTimeout(timer);
	}, [removeNotice]);
	// The Undo targets a row of the room it was shown in — a room switch inside
	// the 6s window must drop it rather than aim at the new room.
	useEffect(() => {
		setRemoveNotice(null);
	}, [persistentChat?.agentId]);

	// Assets panel projection: ledger rows + the live task + the thread's
	// transferred ids → the rail's row view-models (pure, smoke-tested).
	const threadTaskIds = useMemo(() => new Set(items.filter((it): it is Extract<ChatItem, { kind: "task" }> => it.kind === "task").map((it) => it.taskId)), [items]);
	const assetRows = useMemo(() => projectAssetRows(assetLedgerRows, {
		liveTask: taskState.phase === "running" && taskState.taskId ? { taskId: taskState.taskId, title: taskState.title ?? "", templateId: taskState.template ?? "" } : null,
		threadTaskIds,
		liveConversationId: persistentChat?.conversationId,
		now: new Date(),
	}), [assetLedgerRows, taskState, threadTaskIds, persistentChat?.conversationId]);
	assetRowsRef.current = assetRows;
	const selectedAssetTaskId = rightPane?.kind === "artifactViewer" || rightPane?.kind === "taskRun" ? rightPane.taskId : null;

	const empty = items.length === 0;
	const currentThreadHasUserInput = hasUserInput(items);
	const currentPersistentStatus = persistentChat
		? persistentAgentStatuses.find((status) => status.id === persistentChat.agentId) ?? (persistentAgentStatus?.id === persistentChat.agentId ? persistentAgentStatus : null)
		: null;
	const currentActiveThreadStatus = persistentChat && currentPersistentStatus?.activeThread?.threadId === persistentChat.conversationId
		? currentPersistentStatus.activeThread
		: null;
	const serverInFlightRelevant = Boolean(persistentChat && currentActiveThreadStatus?.inFlight && (busy || turnCancelling || !connected));
	const persistentRoomRunning = Boolean(persistentChat && (busy || (serverInFlightRelevant && currentActiveThreadStatus?.working)));
	const persistentRoomCancelling = Boolean(persistentChat && (turnCancelling || (serverInFlightRelevant && currentActiveThreadStatus?.cancelling)));
	const persistentRoomInFlight = Boolean(persistentChat && (persistentRoomRunning || persistentRoomCancelling || serverInFlightRelevant));
	async function goHome() {
		// A fully-received answer may still be revealing at reading speed
		// (busy already false) — leaving must not persist a truncated tail.
		flushAssistantStream();
		if (persistentChat && persistentRoomInFlight) {
			const ok = window.confirm("The assistant is still responding. Stop the response and leave?\n\nChoose Cancel to stay in the room.");
			if (!ok) return;
			await abortCurrentTurn({ leaveAfter: true });
			if (turnCancellingRef.current || isAssistantStreamActive(streamStateRef.current)) markCurrentAssistantInterrupted(turnInterruptedNoteRef.current ?? "Response interrupted because you left the room.");
			setTurnCancelling(false);
			turnCancellingRef.current = false;
			setTurnInterruptedNote(null);
			turnInterruptedNoteRef.current = null;
		}
		// Option 4 (2026-07-19): leaving no longer stops a running specialist —
		// the worker survives in the room-scoped registry and the rail's pulsing
		// row greets the user on return. No guard dialog; nothing to warn about.
		await finishLeaveRoom();
	}

	// The tail of goHome, split out so the leave-guard dialog's "Leave anyway"
	// can resume the exact same path.
	async function finishLeaveRoom() {
		// We're releasing our own lock on the room we're leaving; clear its
		// active-lock badge locally so the home card doesn't show a stale
		// "open in app" until the next refresh. (No immediate refetch — that
		// could race ahead of the async server-side release and re-add it.)
		const releasingAgentId = persistentChat?.agentId ?? null;
		if (persistentChat) {
			try { wsRef.current?.close(); } catch {}
			const liveThread: PersistentAgentThread = { ...persistentChat, state: "live", items: itemsRef.current };
			try {
				await closePersistentAgentRoom(liveThread, "home");
			} catch (e) {
				setItems((s) => [...s, { kind: "system", id: nid(), text: (e as Error).message, level: "error" }]);
			}
			setPersistentChat(null);
			setCheckpointPreviewOpen(false);
			resetMaintainWorkflows();
			setBusy(false);
		}
		if (releasingAgentId) {
			setPersistentAgentStatuses((statuses) => statuses.map((s) => (s.id === releasingAgentId ? { ...s, activeLock: null } : s)));
		}
		setView("home");
	}

	const activeDisplay = persistentChat?.displayName ?? "";
	const absorbWorkflowOpen = absorbWorkflow.step !== "closed";
	const structuralReviewWorkflowOpen = structuralReviewWorkflow.step !== "closed";
	const standbyLockedModels = persistentAgentStatuses
		.filter((status) => {
			if (status.runtime.state === "idle" || !status.runtime.activeThreadId || !status.runtime.model) return false;
			// An empty prepared boundary thread (post-checkpoint/Memento) does not
			// pin the room's model: entering can retire it and pick any model, so a
			// profile switch strands nothing. Only real standby conversations count.
			const preparedBoundary = status.activeThread?.preparedByBoundary ?? (status.activeThread?.preparedByCheckpoint ? "checkpoint" : null);
			return !preparedBoundary;
		})
		.map((status) => ({ provider: status.runtime.model!.provider, model: status.runtime.model!.model }));

	// Consult MR-3 candidate rooms for the composer @-mention popover. The list is
	// already archived-free (the server filters archived rooms); the current room
	// is excluded inside the popover logic.
	const mentionCandidates: MentionCandidateRoom[] = persistentAgentStatuses.map((status) => ({
		id: status.id,
		displayName: status.displayName || status.id,
		status: status.status,
		lastCheckpointAt: status.memoryStatus?.lastCheckpointAt ?? null,
	}));

	if (view === "home") {
		if (absorbWorkflowOpen) {
			return (
				<>
					{maintainConfirm && <MaintainConfirmDialog confirm={maintainConfirm} onClose={() => setMaintainConfirm(null)} />}
					<AbsorbWorkflowShell state={absorbWorkflow} loadingMessage={ABSORB_LOADING_MESSAGES[absorbLoadingIndex]} waitingMessage={ABSORB_WAITING_MESSAGES[absorbWaitingIndex]} onAbort={abortAbsorbWorkflow} onDiscuss={startAbsorbDiscussion} onSendDiscussionMessage={sendAbsorbDiscussionMessage} onGenerateFromDiscussion={generateAbsorbProposalFromDiscussion} onGenerate={generateAbsorbProposal} onApprove={approveAbsorbProposal} onBackToDiscussion={backToAbsorbDiscussion} onBackToAssessment={backToAbsorbAssessment} onRestart={restartMaintain} returnLabel={maintainReturnLabel} />
				</>
			);
		}
		if (structuralReviewWorkflowOpen) {
			return (
				<>
					{maintainConfirm && <MaintainConfirmDialog confirm={maintainConfirm} onClose={() => setMaintainConfirm(null)} />}
					<StructuralReviewWorkflowShell state={structuralReviewWorkflow} loadingMessage={STRUCTURAL_REVIEW_LOADING_MESSAGES[structuralReviewLoadingIndex]} waitingMessage={STRUCTURAL_REVIEW_WAITING_MESSAGES[structuralReviewWaitingIndex]} onAbort={abortStructuralReviewWorkflow} onDiscuss={startStructuralReviewDiscussion} onSendDiscussionMessage={sendStructuralReviewDiscussionMessage} onGenerateFromDiscussion={generateStructuralReviewProposalFromDiscussion} onGenerate={generateStructuralReviewProposal} onApprove={approveStructuralReviewProposal} onBackToDiscussion={backToStructuralReviewDiscussion} onBackToAssessment={backToStructuralReviewAssessment} onRestart={restartMaintain} returnLabel={maintainReturnLabel} />
				</>
			);
		}
		if (maintainChooserOpen && maintainTarget) {
			return <MaintainChooserShell target={maintainTarget} memoryStatus={persistentAgentStatuses.find((status) => status.id === maintainTarget.agentId)?.memoryStatus ?? null} onAbsorb={startAbsorbWorkflow} onPrune={startPruneMemoryWorkflow} onReturn={closeMaintainChooser} returnLabel={maintainReturnLabel} />;
		}
		return (
			<>
				{gcAssessment && !gcReviewOpen && <TaskStoreGcBanner assessment={gcAssessment} onReview={() => setGcReviewOpen(true)} onDismiss={() => setGcAssessment(null)} />}
				{gcReviewOpen && gcAssessment && <TaskStoreGcDialog assessment={gcAssessment} busy={gcBusy} onConfirm={() => void confirmTaskStoreGc()} onClose={() => setGcReviewOpen(false)} />}
				<Landing onOpenAiSetup={() => setView("ai-setup")} onOpenDashboard={() => setView("dashboard")} onOpenConnectors={() => setView("connectors")} onOpenMemory={() => setView("memory")} onOpenSkills={() => setView("skills")} onOpenPersistentAgent={openPersistentAgent} onResumePersistentAgent={openPersistentAgentResume} onMaintainPersistentAgent={(target) => { if (!openMaintainChooser(target)) setPersistentResumeError(maintainBlockedReason(target.agentId) ?? "Maintain is not available for this room right now."); }} onCreatePersistentAgent={createPersistentAgentRoom} onArchiveRoom={archivePersistentAgentRoom} modelStatus={modelStatus} persistentAgentStatuses={persistentAgentStatuses} persistentThread={persistentThread} persistentLive={!!persistentChat} persistentResumeError={persistentResumeError} onRefreshPersistentAgent={refreshPersistentAgentStatus} theme={theme} onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} connected={connected} aiProfileStatus={aiProfileStatus} onSelectAiProfile={selectAiProfile} onRefreshAiProfile={refreshAiProfileStatus} standbyLockedModels={standbyLockedModels} />
			</>
		);
	}

	if (view === "ai-setup") {
		return <AiSetupShell onHome={goHome} onDashboard={() => setView("dashboard")} onConnectors={() => setView("connectors")} onMemory={() => setView("memory")} onSkills={() => setView("skills")} onRefreshAuth={refreshAuthStatus} aiProfileStatus={aiProfileStatus} onRefreshAiProfile={refreshAiProfileStatus} onSelectAiProfile={selectAiProfile} connected={connected} theme={theme} onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} standbyLockedModels={standbyLockedModels} />;
	}

	if (view === "connectors") {
		return <ConnectorsShell onHome={goHome} onAiSetup={() => setView("ai-setup")} onDashboard={() => setView("dashboard")} onMemory={() => setView("memory")} onSkills={() => setView("skills")} connected={connected} theme={theme} onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} aiProfileStatus={aiProfileStatus} onSelectAiProfile={selectAiProfile} onRefreshAiProfile={refreshAiProfileStatus} standbyLockedModels={standbyLockedModels} />;
	}

	if (view === "memory") {
		return <MemoryShell onHome={goHome} onAiSetup={() => setView("ai-setup")} onDashboard={() => setView("dashboard")} onConnectors={() => setView("connectors")} onSkills={() => setView("skills")} onMaintain={(target) => { if (openMaintainChooser(target, "memory")) setView("home"); }} maintainBlocked={maintainBlockedReason} connected={connected} theme={theme} onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} aiProfileStatus={aiProfileStatus} onSelectAiProfile={selectAiProfile} onRefreshAiProfile={refreshAiProfileStatus} standbyLockedModels={standbyLockedModels} />;
	}

	if (view === "skills") {
		return <SkillsShell onHome={goHome} onAiSetup={() => setView("ai-setup")} onDashboard={() => setView("dashboard")} onConnectors={() => setView("connectors")} onMemory={() => setView("memory")} connected={connected} theme={theme} onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} aiProfileStatus={aiProfileStatus} onSelectAiProfile={selectAiProfile} onRefreshAiProfile={refreshAiProfileStatus} standbyLockedModels={standbyLockedModels} />;
	}

	if (view === "dashboard") {
		return (
			<div className="landing-shell with-product-sidebar">
				<ProductSidebar
					onHome={goHome}
					onAiSetup={() => setView("ai-setup")}
					onDashboard={() => {}}
					onConnectors={() => setView("connectors")}
					onMemory={() => setView("memory")}
					onSkills={() => setView("skills")}
					connected={connected}
					theme={theme}
					onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
					active="dashboard"
					aiProfileStatus={aiProfileStatus}
					onSelectAiProfile={selectAiProfile}
					onRefreshAiProfile={refreshAiProfileStatus}
					standbyLockedModels={standbyLockedModels}
				/>
				<div className="landing dashboard-page">
					<section className="landing-hero">
						<h1>Wallet.</h1>
						<p>What your exxperts cost, locally measured.</p>
					</section>
					<Dashboard />
				</div>
			</div>
		);
	}

	const rightPaneVisible = Boolean(rightPane);
	const artifactPaneMaximized = artifactMaximized && rightPane?.kind === "artifactViewer";
	// Maximized: no inline style — the .artifact-pane-maximized class drives a
	// single-track grid. The width travels as a custom property (consumed by the
	// .with-right-pane grid rule) rather than an inline grid-template-columns,
	// so the <=900px stacked layout keeps winning while the pane is open.
	const workbenchStyle = rightPaneVisible && !artifactPaneMaximized
		? ({ "--right-pane-width": `${rightPaneWidth}px` } as CSSProperties)
		: undefined;

	const rightPaneSlot = (
		<>
			{rightPaneVisible && !artifactPaneMaximized && (
				<div
					className="pane-resizer"
					role="separator"
					aria-orientation="vertical"
					onMouseDown={(e) => {
						const host = workbenchRef.current;
						if (!host) return;
						// preventDefault: a mousedown default-starts a text selection, which
						// would paint the transcript blue for the whole drag.
						e.preventDefault();
						rightPaneDragRef.current = {
							startX: e.clientX,
							startWidth: host.getBoundingClientRect().right - e.currentTarget.getBoundingClientRect().right,
						};
						setResizingRightPane(true);
					}}
				/>
			)}
			{preview && <Preview content={preview.content} title={preview.title} type={preview.type} onClose={() => setPreview(null)} />}
			{rightPane?.kind === "taskRun" && taskState.phase !== "none" && taskState.taskId === rightPane.taskId && (
				<TaskRunView
					state={taskState}
					onStop={() => dispatchTask({ type: "abort_requested" })}
					onClose={() => { setArtifactMaximized(false); setRightPane(null); }}
					maximized={artifactMaximized}
					onToggleMaximize={() => setArtifactMaximized((m) => !m)}
				/>
			)}
			{rightPane?.kind === "artifactViewer" && (
				<ArtifactViewer
					taskId={rightPane.taskId}
					templateLabel={rightPane.templateLabel}
					artifact={rightPane.artifact}
					maximized={artifactMaximized}
					onToggleMaximize={() => setArtifactMaximized((m) => !m)}
					onClose={() => { setArtifactMaximized(false); setRightPane(null); }}
					onSaveToWorkspace={() => void saveArtifactToWorkspace(rightPane)}
					{...(rightPane.asset ? {
						assetTitle: rightPane.asset.title,
						originLine: rightPane.asset.originLine,
						files: rightPane.asset.artifacts,
						onSelectFile: (file: { relativePath: string; extension: string }) => setRightPane({ ...rightPane, artifact: { relativePath: file.relativePath, extension: file.extension } }),
						footerSlot: (
							<AssetViewerFooter
								taskId={rightPane.taskId}
								artifact={rightPane.artifact}
								inConversation={threadTaskIds.has(rightPane.taskId)}
								orphan={rightPane.asset.orphan}
								canIterate={rightPane.asset.artifacts.length > 0}
								summary={rightPane.asset.summary}
								onAddToConversation={() => rightPane.asset && transferAssetRowToThread(rightPane.asset)}
								onSaveToWorkspace={() => void saveArtifactToWorkspace(rightPane)}
								onIterate={(brief) => submitAssetIterate(rightPane.taskId, brief)}
								iteratePending={taskIteratePending}
								iterateNotice={taskIterateNotice}
								{...(rightPane.asset.orphan ? { onDelete: () => rightPane.asset && setAssetDeleteConfirm(rightPane.asset) } : {})}
							/>
						),
					} : {})}
				/>
			)}
		</>
	);

	return (
		<InRoomChatShellView
			sidebar={
				<Sidebar
					onHome={goHome}
					connected={connected}
					theme={theme}
					onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
					onHelp={() => setHelpOpen(true)}
					assetsSlot={persistentChat ? <AssetsPanel rows={assetRows} selectedTaskId={selectedAssetTaskId} onSelect={openAssetRow} onStopRunning={() => dispatchTask({ type: "abort_requested" })} onRemove={(row) => void removeAssetRow(row)} /> : undefined}
				/>
			}
			withPreview={false}
			workbenchRef={workbenchRef}
			workbenchClassName={`${rightPaneVisible ? (artifactPaneMaximized ? "with-right-pane artifact-pane-maximized" : "with-right-pane") : ""}${resizingRightPane ? " pane-resizing" : ""}`}
			workbenchStyle={workbenchStyle}
			activeDisplay={activeDisplay || ""}
			ownerSecondary=""
			busy={busy}
			usage={usage}
			contextHealth={persistentChat ? contextHealth : null}
			currentModelLabel={currentModelLabel}
			composerRightActions={
				persistentChat ? (
					<>
						<button className="icon-btn" title="Forget this conversation and start fresh. Nothing is checkpointed" onClick={() => void mementoPersistentThread()}>Memento</button>
						<CheckpointSplitButton
							hasUserInput={currentThreadHasUserInput}
							inFlight={persistentRoomInFlight}
							onQuickCheckpoint={() => void runQuickCheckpoint()}
							onOpenFullCheckpoint={() => { setCheckpointQuickRequested(false); setCheckpointQuickBlockedReasons(null); setCheckpointPreviewOpen(true); }}
						/>
					</>
				) : null
			}
			connected={connected}
			items={items}
			pendingConsultIds={pendingConsultItemIds}
			onOpenTaskArtifact={(taskId, relativePath) => {
				const extension = relativePath.includes(".") ? relativePath.slice(relativePath.lastIndexOf(".")).toLowerCase() : "";
				const item = itemsRef.current.find((it): it is Extract<ChatItem, { kind: "task" }> => it.kind === "task" && it.taskId === taskId);
				openArtifactViewer(taskId, item?.templateLabel ?? "visual", { relativePath, extension });
			}}
			empty={empty}
			onSend={send}
			onStop={() => void abortCurrentTurn()}
			stopVisible={persistentRoomInFlight}
			stopDisabled={persistentRoomCancelling || !connected}
			stopLabel="Stop"
			textareaRef={textareaRef}
			composerPlaceholder={persistentRoomCancelling ? "Stopping current response…" : persistentRoomRunning ? "Working… Stop before sending another message" : `Ask ${activeDisplay}…`}
			sendUnavailable={!connected || persistentRoomInFlight}
			initialDraftValue={composerPrefill || undefined}
			draftResetKey={composerResetNonce}
			mention={persistentChat ? {
				candidates: mentionCandidates,
				currentRoomId: persistentChat.agentId,
				busy: persistentRoomInFlight,
				busyTitle: "You can consult another room once this room's current response finishes.",
				onConsultRequest: handleConsultRequest,
				// §8.3: while a consult card is docked, a composer @-mention is rejected
				// visibly (the card is the place to follow up) — name the docked room.
				activeConsultDisplayName: consultState.phase !== "none" ? (consultState.targetDisplayName ?? consultState.targetRoomId) : null,
			} : undefined}
			onResolveApproval={resolveApproval}
			onApprovalPreview={openApprovalPreview}
			aboveComposerSlot={persistentChat ? (
				<>
					<ConsultDock
						state={consultState}
						onMinimize={() => dispatchConsult({ type: "minimize" })}
						onOpen={() => dispatchConsult({ type: "open" })}
						onStop={() => dispatchConsult({ type: "abort_requested" })}
						onDismiss={() => dispatchConsult({ type: "dismiss" })}
						onTransfer={transferConsultToThread}
						onFollowUp={handleConsultFollowUp}
					/>
				</>
			) : undefined}
			previewSlot={rightPaneSlot}
			checkpointPreviewSlot={checkpointPreviewOpen && persistentChat && <CheckpointPreviewShell chat={persistentChat} itemCount={items.length} rememberText={checkpointRememberText} density={checkpointDensity} proposal={checkpointProposal} loading={checkpointProposalLoading} error={checkpointProposalError} approvalLoading={checkpointApprovalLoading} approvalError={checkpointApprovalError} approvalResult={checkpointApprovalResult} quickRequested={checkpointQuickRequested} quickBlockedReasons={checkpointQuickBlockedReasons} consultRunning={consultState.phase === "streaming"} taskRunning={taskState.phase === "running"} pendingConsultHandoffCount={pendingHandoffs.filter((block) => !block.startsWith("[SPECIALIST RESULT") && !block.startsWith("[WORKSPACE EXPORT")).length} pendingTaskHandoffCount={pendingHandoffs.filter((block) => block.startsWith("[SPECIALIST RESULT")).length} onRememberTextChange={(text) => { setCheckpointRememberText(text); setCheckpointProposal(null); setCheckpointProposalError(null); setCheckpointApprovalError(null); setCheckpointApprovalResult(null); }} onDensityChange={(next) => { setCheckpointDensity(next); setCheckpointProposal(null); setCheckpointProposalError(null); setCheckpointApprovalError(null); setCheckpointApprovalResult(null); }} onGenerate={generateCheckpointProposal} onApprove={approveCheckpointProposal} onDiscard={() => { setCheckpointProposal(null); setCheckpointProposalError(null); setCheckpointApprovalError(null); setCheckpointApprovalResult(null); setCheckpointQuickRequested(false); setCheckpointQuickBlockedReasons(null); setCheckpointPreviewOpen(false); }} onContinueAfterCheckpoint={continueAfterCheckpoint} onRestAfterCheckpoint={restAfterCheckpoint} onClose={() => setCheckpointPreviewOpen(false)} />}
			globalOverlaySlot={
				<>
					{helpOpen && <Help onClose={() => setHelpOpen(false)} />}
					{assetDeleteConfirm && <AssetDeleteDialog title={assetDeleteConfirm.title} onDelete={() => { const row = assetDeleteConfirm; setAssetDeleteConfirm(null); if (row) void deleteAssetRow(row); }} onCancel={() => setAssetDeleteConfirm(null)} />}
					{exportCollision && <ExportCollisionDialog collision={exportCollision} onClose={() => setExportCollision(null)} />}
					{exportNotice && (
						<div className={`artifact-export-toast ${exportNotice.kind}`} role="status" aria-live="polite">
							{exportNotice.text}
						</div>
					)}
					{removeNotice && (
						<div className="artifact-export-toast success asset-remove-toast" role="status" aria-live="polite">
							<span className="asset-remove-text">
								<span>Removed from the list.</span>
								<span className="asset-remove-sub">Its files are kept.</span>
							</span>
							<button type="button" className="asset-remove-undo" onClick={() => void undoRemoveAssetRow(removeNotice.taskId)}>Undo</button>
						</div>
					)}
					{taskDoneToast && (
						<button
							type="button"
							className={`task-done-toast ${taskDoneToast.kind}`}
							role="status"
							aria-live="polite"
							onClick={() => {
								const toast = taskDoneToast;
								setTaskDoneToast(null);
								if (toast.artifact) openArtifactViewer(toast.taskId, toast.templateLabel, toast.artifact);
							}}
						>
							{taskDoneToast.kind === "done"
								? <>“{taskDoneToast.title}” is ready — click to open</>
								: <>“{taskDoneToast.title}” didn't finish{taskDoneToast.artifact ? " — click to see what it made" : ""}</>}
						</button>
					)}
				</>
			}
		/>
	);
}
