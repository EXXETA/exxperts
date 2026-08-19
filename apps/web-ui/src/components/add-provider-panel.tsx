import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LoginProviderCatalogEntry, PersistentAgentAiProfileStatus, ProviderModelCatalog } from "../types";
import { useEscapeKey } from "./use-escape-key";
import { apiFetch, fetchJson } from "../api";
import { modelDisplayName } from "../model-names";
import { applyToApproved, approvedCount, detectionAnswers, draftEffective, isNonChatMode, setAllApproved, trustDetected, type BulkDetection } from "../gateway-model-bulk";

// Catalog entries carry a bare name ("Opus 4.8") or none; canonicalise so the
// approval lists read the same as chips and Wallet ("Claude Opus 4.8").
function catalogModelName(model: { id: string; name?: string }): string {
	return modelDisplayName({ model: model.id, modelLabel: model.name }) || model.id;
}

// The model-approval checkbox list, shared by the provider and gateway modals.
export function ModelCheckboxList({ options, selected, onToggle, ariaLabel }: {
	options: Array<{ id: string; name?: string; suggested?: boolean }>;
	selected: Set<string>;
	onToggle: (modelId: string) => void;
	ariaLabel: string;
}) {
	return (
		<div className="configure-profile-model-list" role="group" aria-label={ariaLabel}>
			{options.map((option) => (
				<label key={option.id} className="configure-profile-model-option" title={option.id}>
					<input type="checkbox" checked={selected.has(option.id)} onChange={() => onToggle(option.id)} />
					<span className="configure-profile-model-name">{catalogModelName(option)}</span>
					{option.suggested && <span className="configure-profile-suggested">suggested</span>}
				</label>
			))}
		</div>
	);
}

// Masked credential entry, shared by the add-panel rows and the profile rows.
/**
 * A key entry row. When the caller can close it, it says so: a form that opens
 * on a menu click and offers no way back leaves reloading the page as the only
 * exit, which is not an exit.
 */
export function ApiKeyForm({ placeholder, onSave, className, onCancel }: {
	placeholder: string;
	onSave: (key: string) => Promise<void>;
	className?: string;
	onCancel?: () => void;
}) {
	const [key, setKey] = useState("");
	const [saving, setSaving] = useState(false);
	async function save() {
		setSaving(true);
		try {
			await onSave(key);
			setKey("");
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className={`add-provider-key-form${className ? ` ${className}` : ""}`}>
			<input
				className="launcher-path-input create-room-input"
				type="password"
				placeholder={placeholder}
				value={key}
				autoFocus
				onChange={(e) => setKey(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && key.trim() && !saving) void save();
					// Escape backs out of a field somebody opened by mistake, the way
					// it closes every other transient surface in the app. Stopped from
					// propagating so it does not also close whatever contains this.
					if (e.key === "Escape" && onCancel && !saving) {
						e.preventDefault();
						e.stopPropagation();
						onCancel();
					}
				}}
			/>
			<button className="landing-action" disabled={!key.trim() || saving} onClick={() => void save()}>
				{saving ? "Saving…" : "Save key"}
			</button>
			{onCancel && (
				<button className="ai-profile-foot-link" type="button" disabled={saving} onClick={onCancel}>Cancel</button>
			)}
		</div>
	);
}

// Browser sign-in for a raw provider id: the server starts the runtime's OAuth
// flow, we open the URL in a new tab and poll until it settles.
export function useProviderLogin(onDone: (providerId: string, ok: boolean) => void) {
	const [signingInProvider, setSigningInProvider] = useState<string | null>(null);
	// Device-code flows (GitHub Copilot) hand back a code the person must type
	// on the provider's page; callback-server flows have no instructions.
	const [instructions, setInstructions] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function signIn(providerId: string) {
		setError(null);
		setInstructions(null);
		try {
			const { url, instructions: startInstructions } = await fetchJson<{ url: string; instructions?: string | null }>("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: providerId }),
			});
			window.open(url, "_blank", "noopener");
			setInstructions(startInstructions ?? null);
			setSigningInProvider(providerId);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function cancel() {
		try {
			await fetchJson("/api/auth/login/cancel", { method: "POST" });
		} catch {}
		setSigningInProvider(null);
		setInstructions(null);
	}

	useEffect(() => {
		if (!signingInProvider) return;
		let stopped = false;
		const timer = window.setInterval(async () => {
			try {
				const state = await fetchJson<{ pending: boolean; instructions?: string | null; error?: string | null }>("/api/auth/login/status");
				if (stopped) return;
				if (state.pending) {
					if (state.instructions) setInstructions(state.instructions);
					return;
				}
				window.clearInterval(timer);
				if (state.error) setError(state.error);
				setSigningInProvider(null);
				setInstructions(null);
				onDone(signingInProvider, !state.error);
			} catch {}
		}, 2000);
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [signingInProvider]);

	return { signingInProvider, instructions, error, setError, signIn, cancel };
}

// Suggest-then-approve model configuration for one provider: which models its
// rooms may use, and which model runs Memorize and Review. Saving creates
// or updates the provider's custom AI profile.
export function ConfigureProfileModal({ providerId, providerName, existingProfile, allowRemove = true, onClose, onSaved }: {
	providerId: string;
	providerName: string;
	existingProfile?: PersistentAgentAiProfileStatus;
	// Built-in profiles are edited through the same modal but cannot be removed,
	// only reset from the row menu.
	allowRemove?: boolean;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [catalog, setCatalog] = useState<ProviderModelCatalog | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [roomModels, setRoomModels] = useState<Set<string>>(new Set());
	const [learnModel, setLearnModel] = useState("");
	const [reviewMemoryModel, setReviewMemoryModel] = useState("");
	const [saving, setSaving] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	useEscapeKey(onClose, true);

	const existingRoomModels = useMemo(
		() => (existingProfile?.processes?.persistentRoom.models ?? []).map((model) => model.model),
		[existingProfile],
	);
	const existingForPurpose = (token: string) =>
		existingProfile?.requiredModels.find((model) => (model.purpose ?? "").split("/").includes(token))?.model ?? "";

	useEffect(() => {
		let stopped = false;
		fetchJson<ProviderModelCatalog>(`/api/persistent-agent-ai-profiles/model-catalog?provider=${encodeURIComponent(providerId)}`)
			.then((result) => {
				if (stopped) return;
				setCatalog(result);
				const initialRooms = existingRoomModels.length > 0 ? existingRoomModels : [result.suggested];
				setRoomModels(new Set(initialRooms.filter((id) => result.models.some((model) => model.id === id))));
				setLearnModel(existingForPurpose("absorb") || result.suggested);
				setReviewMemoryModel(existingForPurpose("structural-review") || result.suggested);
			})
			.catch((e) => {
				if (!stopped) setLoadError((e as Error).message);
			});
		return () => {
			stopped = true;
		};
	}, [providerId]);

	function toggleRoomModel(modelId: string) {
		setRoomModels((current) => {
			const next = new Set(current);
			if (next.has(modelId)) next.delete(modelId);
			else next.add(modelId);
			return next;
		});
	}

	async function save() {
		setSaving(true);
		setSaveError(null);
		try {
			await fetchJson("/api/persistent-agent-ai-profiles/custom", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					providerId,
					label: providerName,
					roomModels: [...roomModels],
					learnModel,
					reviewMemoryModel,
				}),
			});
			onSaved();
			onClose();
		} catch (e) {
			setSaveError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	async function removeProfile() {
		if (!existingProfile) return;
		setRemoving(true);
		setSaveError(null);
		try {
			await fetchJson(`/api/persistent-agent-ai-profiles/custom/${encodeURIComponent(existingProfile.id)}`, { method: "DELETE" });
			onSaved();
			onClose();
		} catch (e) {
			setSaveError((e as Error).message);
		} finally {
			setRemoving(false);
		}
	}

	const canSave = roomModels.size > 0 && Boolean(learnModel) && Boolean(reviewMemoryModel) && !saving && !removing;

	return (
		<div className="room-settings-overlay configure-profile-overlay" role="dialog" aria-modal="true" aria-label={`Configure ${providerName} models`} onClick={onClose}>
			<div className="room-settings-modal configure-profile-modal" onClick={(e) => e.stopPropagation()}>
				<div className="room-settings-head">
					<div className="room-settings-title-block">
						<div className="room-settings-title-row">
							<h2>{`Approve ${providerName} models`}</h2>
						</div>
					</div>
					<button className="icon-btn" onClick={onClose} aria-label="Close">Close</button>
				</div>
				<div className="room-settings-body configure-profile-body">
					<p className="ai-setup-copy">
						Choose the models your rooms may run on, and which model handles Memorize and Review. You can change this later.
					</p>
					{loadError && <div className="checkpoint-proposal-error">{loadError}</div>}
					{!catalog && !loadError && <p className="cli-note">Loading models…</p>}
					{catalog && (
						<>
							{catalog.note && <p className="cli-note">{catalog.note}</p>}
							<div className="configure-profile-field">
								<h3>Rooms</h3>
								<ModelCheckboxList
									options={catalog.models.map((model) => ({ id: model.id, name: model.name, suggested: model.suggestedDefault }))}
									selected={roomModels}
									onToggle={toggleRoomModel}
									ariaLabel="Room models"
								/>
							</div>
							<div className="configure-profile-field">
								<h3>Memorize</h3>
								<select className="configure-profile-select" value={learnModel} onChange={(e) => setLearnModel(e.target.value)} aria-label="Memorize model">
									{catalog.models.map((model) => (
										<option key={model.id} value={model.id}>{catalogModelName(model)}{model.suggestedDefault ? " (suggested)" : ""}</option>
									))}
								</select>
							</div>
							<div className="configure-profile-field">
								<h3>Review</h3>
								<select className="configure-profile-select" value={reviewMemoryModel} onChange={(e) => setReviewMemoryModel(e.target.value)} aria-label="Review model">
									{catalog.models.map((model) => (
										<option key={model.id} value={model.id}>{catalogModelName(model)}{model.suggestedDefault ? " (suggested)" : ""}</option>
									))}
								</select>
							</div>
							{saveError && <div className="checkpoint-proposal-error">{saveError}</div>}
							<div className="create-room-actions">
								<button className="landing-action" disabled={!canSave} onClick={() => void save()}>{saving ? "Saving…" : "Save profile"}</button>
								<button className="inline-action" disabled={saving || removing} onClick={onClose}>Cancel</button>
								{existingProfile && allowRemove && (
									<button className="ai-profile-foot-link configure-profile-remove" disabled={saving || removing} onClick={() => void removeProfile()}>
										{removing ? "Removing…" : "Remove profile"}
									</button>
								)}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

/** One saved gateway's approved model, as the server describes it. */
export type GatewayModelConfig = {
	modelId: string;
	label?: string;
	/** Effective values: override over detection over default, resolved server-side. */
	vision: boolean;
	webSearch: boolean;
	reasoning: boolean;
	contextWindow: number;
	/** The fields the person pinned. Sparse: present means chosen, an explicit false included. */
	overrides?: { vision?: boolean; reasoning?: boolean; contextWindow?: number };
	/** What the gateway last declared, null per field where it did not answer. */
	detected?: BulkDetection;
};

export type GatewayConfig = {
	id: string;
	providerId: string;
	label: string;
	baseUrl: string;
	roomModels: GatewayModelConfig[];
	maintenanceModel: string;
	/** The gateway that existed before the app could hold several. Its ids are frozen. */
	isDefault: boolean;
};

type GatewayListResponse = { gateways: GatewayConfig[]; errors: string[]; unreadable?: boolean; defaultContextWindow: number };
type GatewayDetection = BulkDetection & { id: string };
type GatewayDiscoverResponse = { models: string[]; detected?: GatewayDetection[]; excludedNonChat?: Array<{ id: string; mode: string }> };
type GatewaySaveResponse = { gateway?: GatewayConfig | null; error?: string };

// What the runtime falls back to when a gateway model declares no window. Shown
// in the field rather than left blank, so the number driving the context chip
// and auto-compaction is never a secret.
const DEFAULT_CONTEXT_WINDOW = 128000;
// The same bounds the server enforces, so a slip is caught under the field that
// caused it instead of coming back as a refused save.
const MIN_CONTEXT_WINDOW = 4096;
const MAX_CONTEXT_WINDOW = 20000000;

/**
 * A typed context window, read strictly. parseInt would take "1e9" as 1 and
 * "128000abc" as 128000, and either would quietly become the number the room's
 * context chip reads and auto-compaction fires on.
 */
function contextWindowError(value: string): string | null {
	const text = value.trim();
	if (!text) return "Enter a context window in tokens.";
	if (!/^\d+$/.test(text)) return "Context window must be a whole number of tokens, digits only.";
	const parsed = Number(text);
	if (!Number.isSafeInteger(parsed) || parsed < MIN_CONTEXT_WINDOW || parsed > MAX_CONTEXT_WINDOW) {
		return `Context window must be between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW} tokens.`;
	}
	return null;
}

/** The first complaint any approved model's window override has, or null when they are all fine. */
function approvedContextWindowError(drafts: ModelDraft[]): string | null {
	for (const draft of drafts) {
		// Only an override can be mistyped; a field following detection or the
		// default always holds a number the server produced.
		if (!draft.approved || draft.contextWindow === undefined) continue;
		const error = contextWindowError(draft.contextWindow);
		if (error) return `${draft.id}: ${error}`;
	}
	return null;
}

export function gatewaysUrl(gatewayId: string | null, suffix = ""): string {
	return gatewayId
		? `/api/persistent-agent-ai-profiles/gateways/${encodeURIComponent(gatewayId)}${suffix}`
		: `/api/persistent-agent-ai-profiles/gateways${suffix}`;
}

/**
 * One row of the approve step. Approval and the web search tick are plain
 * values; images, reasoning and the context window live in two halves, the
 * person's sparse overrides here and the gateway's detection snapshot beside
 * them, resolved for display by draftEffective exactly as the server resolves
 * them for the runtime. Web search is the exception because those searches can
 * bill per use: detection never sets the tick, only the person does.
 */
type ModelDraft = {
	id: string;
	approved: boolean;
	/** The web search tick, effective as it stands. */
	webSearch: boolean;
	/** Override: present only when the person set it. */
	vision?: boolean;
	/** Override: present only when the person set it. */
	reasoning?: boolean;
	/** Override: the window as typed. Present only when the person set it. */
	contextWindow?: string;
	/** What the gateway last declared about this model, from the saved snapshot or the last reload. */
	detected: BulkDetection | null;
	/**
	 * The display name a gateway's model was saved under. Carried through the
	 * form untouched: it is nobody's job here to edit it, but dropping it would
	 * quietly collapse a migrated gateway's model names to raw ids, and there is
	 * no getting them back.
	 */
	label?: string;
};

function draftFromParts(id: string, approved: boolean, saved: GatewayModelConfig | undefined, detected: BulkDetection | undefined): ModelDraft {
	return {
		id,
		approved,
		// Web search is the one capability that can bill the user per use, so a
		// gateway's declaration never pre-ticks it: "can search" is the gateway's
		// statement, "search on my account" stays the user's. The declaration is
		// still one explicit click away through "use detected".
		webSearch: saved?.webSearch ?? false,
		...(saved?.overrides?.vision !== undefined ? { vision: saved.overrides.vision } : {}),
		...(saved?.overrides?.reasoning !== undefined ? { reasoning: saved.overrides.reasoning } : {}),
		...(saved?.overrides?.contextWindow !== undefined ? { contextWindow: String(saved.overrides.contextWindow) } : {}),
		detected: detected ?? saved?.detected ?? null,
		...(saved?.label && saved.label !== id ? { label: saved.label } : {}),
	};
}

/** Whether any row carries a hand-set field, the thing a reload deliberately keeps. */
function anyAdjustments(drafts: ModelDraft[]): boolean {
	return drafts.some((draft) => draft.vision !== undefined || draft.reasoning !== undefined || draft.contextWindow !== undefined);
}

function draftsToPayload(drafts: ModelDraft[]): Array<{ modelId: string; webSearch: boolean; overrides: { vision?: boolean; reasoning?: boolean; contextWindow?: number }; detected: BulkDetection | Record<string, never>; label?: string }> {
	return drafts
		.filter((draft) => draft.approved)
		.map((draft) => ({
			modelId: draft.id,
			webSearch: draft.webSearch,
			// Only what the person actually chose travels as an override; the
			// detection snapshot rides along so the store remembers what the
			// gateway said between reloads.
			overrides: {
				...(draft.vision !== undefined ? { vision: draft.vision } : {}),
				...(draft.reasoning !== undefined ? { reasoning: draft.reasoning } : {}),
				// Validated before we get here, so the drop is only ever reached
				// by a caller that skipped the check.
				...(draft.contextWindow !== undefined && !contextWindowError(draft.contextWindow) ? { contextWindow: Number(draft.contextWindow.trim()) } : {}),
			},
			detected: draft.detected ?? {},
			...(draft.label ? { label: draft.label } : {}),
		}));
}

/**
 * Merge what the gateway just said with what is already on screen. The
 * detection snapshot refreshes on every row the reload answered for; the
 * person's overrides survive untouched, which is the whole contract. A model
 * the gateway stopped listing stays visible so saving never drops it behind
 * their back.
 */
function mergeDrafts(current: ModelDraft[], discovered: string[], detections: GatewayDetection[], saved: GatewayModelConfig[]): ModelDraft[] {
	const byId = new Map(current.map((draft) => [draft.id, draft]));
	const detectedById = new Map(detections.map((detection) => [detection.id, detection]));
	const savedById = new Map(saved.map((model) => [model.modelId, model]));
	const ids = [...new Set([...discovered, ...saved.map((model) => model.modelId), ...current.map((draft) => draft.id)])].sort();
	return ids.map((id) => {
		const existing = byId.get(id);
		const detection = detectedById.get(id);
		if (existing) return detection ? { ...existing, detected: detection } : existing;
		return draftFromParts(id, savedById.has(id), savedById.get(id), detection);
	});
}

/**
 * Typing ids is the one path that can save a dozen models nobody looked at, so
 * it says out loud what those models are being saved as.
 */
const MANUAL_IDS_DEFAULTS_NOTE = "Models added by id start with images, web search and reasoning off, and the default context window. Set them per model below or with the controls at the top of the list.";

/** The context figure as a badge: compact where round, exact where not. */
function formatContextFigure(tokens: number): string {
	if (tokens >= 1000000 && tokens % 100000 === 0) return `${tokens / 1000000}M context`;
	if (tokens % 1000 === 0) return `${tokens / 1000}k context`;
	return `${tokens} context`;
}

/** One honest sentence for the adjust fold: what the gateway declared, field by field. */
function detectedNote(detection: BulkDetection | null): string {
	if (!detectionAnswers(detection)) return "This gateway did not say what this model can do.";
	const parts: string[] = [];
	if (detection!.vision != null) parts.push(`images ${detection!.vision ? "on" : "off"}`);
	if (detection!.webSearch != null) parts.push(`web search ${detection!.webSearch ? "yes" : "no"}`);
	if (detection!.reasoning != null) {
		// The one ladder fact worth a word here: a top tier above the generic
		// dial, capped by the deployment's own ceiling where it names one. The
		// full rung list belongs to the room's effort dial, not to this sentence.
		const ceiling = detection!.effortCeiling ?? null;
		const declaredTop = detection!.thinkingLevels?.max === true ? "max" : detection!.thinkingLevels?.xhigh === true ? "xhigh" : null;
		const top = declaredTop === "max" && (ceiling === "xhigh") ? "xhigh"
			: declaredTop != null && ceiling != null && ceiling !== "xhigh" && ceiling !== "max" ? null
			: declaredTop;
		parts.push(`thinking ${detection!.reasoning ? (top ? `on, up to ${top}` : "on") : "off"}`);
	}
	if (detection!.contextWindow != null) parts.push(`context ${detection!.contextWindow}`);
	if (detection!.maxTokens != null) parts.push(`max output ${detection!.maxTokens}`);
	return `Gateway detected: ${parts.join(", ")}.`;
}

/**
 * One honest line about models the discover step kept out of the list, or null
 * when it kept nothing out.
 */
function nonChatExcludedNote(excluded: Array<{ id: string; mode: string }> | undefined): string | null {
	const count = excluded?.length ?? 0;
	if (count === 0) return null;
	return count === 1
		? "1 model the gateway lists is not a chat model and is not shown."
		: `${count} models the gateway lists are not chat models and are not shown.`;
}

/**
 * Whether "use detected" would change this row: an override sits on a field
 * the gateway answered, or the tick differs from its declaration.
 */
function rowCanTrustDetection(draft: ModelDraft): boolean {
	const detection = draft.detected;
	if (!detectionAnswers(detection)) return false;
	if (detection!.vision != null && draft.vision !== undefined) return true;
	if (detection!.reasoning != null && draft.reasoning !== undefined) return true;
	if (detection!.contextWindow != null && draft.contextWindow !== undefined) return true;
	if (detection!.webSearch != null && draft.webSearch !== detection!.webSearch) return true;
	return false;
}

export function GatewayModelApprovalList({ drafts, onChange, ariaLabel, askedGateway = false }: {
	drafts: ModelDraft[];
	onChange: (next: ModelDraft[]) => void;
	ariaLabel: string;
	/** True once this panel actually asked the gateway (a load or reload ran). A migrated config's empty snapshot says nothing about the gateway itself, so the undeclared line waits for a real answer. */
	askedGateway?: boolean;
}) {
	// Starts empty on purpose. Seeded with the default it read as a value the
	// list already held, when it is only a tool waiting to be pointed at one.
	const [bulkWindow, setBulkWindow] = useState("");
	// Which rows have their adjust fold open. Plain view state: nothing in it
	// survives a save or belongs in the drafts.
	const [openAdjust, setOpenAdjust] = useState<ReadonlySet<string>>(new Set());
	function update(id: string, patch: Partial<ModelDraft>) {
		onChange(drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
	}
	function toggleAdjust(id: string) {
		setOpenAdjust((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}
	const approved = approvedCount(drafts);
	const allApproved = drafts.length > 0 && approved === drafts.length;
	// An empty field is not a mistake here, it is the resting state, so it stays
	// quiet and only disables apply. Anything typed is held to the same bounds.
	const bulkWindowTouched = bulkWindow.trim().length > 0;
	const bulkWindowError = bulkWindowTouched ? contextWindowError(bulkWindow) : null;
	// Ticking web search for a model the gateway does not run it on fails in one
	// of two ways, and only one of them is loud: some gateways reject the
	// request outright, and others accept the field, ignore it, and answer
	// without searching. The quiet one is the reason this cannot live in a hover
	// tooltip, and the reason the hint ends by asking somebody to check.
	const anyWebSearch = drafts.some((draft) => draft.approved && draft.webSearch);
	const hasDetections = drafts.some((draft) => detectionAnswers(draft.detected));
	const webSearchCount = drafts.filter((draft) => draft.approved && draft.webSearch).length;
	return (
		<>
			{askedGateway && drafts.length > 0 && !hasDetections && (
				<p className="gateway-model-list-hint">This gateway does not say what its models can do. Set capabilities through adjust.</p>
			)}
			{anyWebSearch && (
				<p className="gateway-model-list-hint">
					Web search is on for {webSearchCount === 1 ? "1 model" : `${webSearchCount} models`}. The gateway may bill those searches; untick any model you would rather not pay for.
				</p>
			)}
		<div className="configure-profile-model-list gateway-model-list" role="group" aria-label={ariaLabel}>
			{drafts.length > 1 && (
				<div className="configure-profile-model-option gateway-model-row gateway-model-bulk-row">
					<label className="gateway-model-approve" title={allApproved ? "Unapprove every model in this list" : "Approve every model in this list"}>
						<input
							type="checkbox"
							checked={allApproved}
							ref={(node) => {
								// Half a list is neither ticked nor unticked, and the box
								// should say so rather than pick a side.
								if (node) node.indeterminate = approved > 0 && !allApproved;
							}}
							aria-label="Approve all models"
							onChange={() => onChange(setAllApproved(drafts, !allApproved))}
						/>
						<span className="configure-profile-model-name">{`${approved} of ${drafts.length} approved`}</span>
					</label>
					{/* The bulk pairs write the person's choice onto every approved
					    row at once, which makes each of them an override: they exist
					    for the gateway that declares nothing, and for overruling one
					    that declares wrongly. */}
					<div className="gateway-model-vision gateway-model-bulk-cell">
						<span className="gateway-model-bulk-label">images</span>
						<span className="gateway-model-bulk-seg">
							<button type="button" title="Set images on for every approved model the gateway does not rule out" onClick={() => onChange(applyToApproved(drafts, { vision: true }))}>on</button>
							<button type="button" title="Set images off for every approved model, as your choice over detection" onClick={() => onChange(applyToApproved(drafts, { vision: false }))}>off</button>
						</span>
					</div>
					<div className="gateway-model-websearch gateway-model-bulk-cell">
						<span className="gateway-model-bulk-label">web search</span>
						<span className="gateway-model-bulk-seg">
							<button type="button" title="Turn web search on for every approved model" onClick={() => onChange(applyToApproved(drafts, { webSearch: true }))}>on</button>
							<button type="button" title="Turn web search off for every approved model" onClick={() => onChange(applyToApproved(drafts, { webSearch: false }))}>off</button>
						</span>
					</div>
					<div className="gateway-model-reasoning gateway-model-bulk-cell">
						<span className="gateway-model-bulk-label">thinking</span>
						<span className="gateway-model-bulk-seg">
							<button type="button" title="Set thinking on for every approved model the gateway does not rule out" onClick={() => onChange(applyToApproved(drafts, { reasoning: true }))}>on</button>
							<button type="button" title="Set thinking off for every approved model, as your choice over detection" onClick={() => onChange(applyToApproved(drafts, { reasoning: false }))}>off</button>
						</span>
					</div>
					<div className="gateway-model-window gateway-model-bulk-cell">
						<span className="gateway-model-window-label">context</span>
						<input
							className={`launcher-path-input gateway-model-window-input${bulkWindowError ? " invalid" : ""}`}
							type="text"
							inputMode="numeric"
							placeholder="set all to…"
							value={bulkWindow}
							aria-label="Context window to apply to all approved models"
							aria-invalid={bulkWindowError ? true : undefined}
							onChange={(e) => setBulkWindow(e.target.value)}
						/>
						<button
							type="button"
							className="gateway-model-bulk-button"
							disabled={!bulkWindowTouched || Boolean(bulkWindowError)}
							title={bulkWindowError ?? (bulkWindowTouched ? "Give every approved model this context window, as your choice over detection" : "Type a context window first")}
							onClick={() => onChange(applyToApproved(drafts, { contextWindow: bulkWindow.trim() }))}
						>
							apply
						</button>
					</div>
					{/* Use detected belongs to the whole list rather than to a
					    column, and sits at the far end saying so. */}
					{hasDetections && (
						<button
							type="button"
							className="gateway-model-bulk-button gateway-model-bulk-detected"
							title="Follow the gateway's detection: clears your per-model choices for the fields it answers, and sets the web search tick to what it declares"
							onClick={() => onChange(trustDetected(drafts))}
						>
							use detected
						</button>
					)}
				</div>
			)}
			{drafts.map((draft) => {
				const effective = draftEffective(draft, DEFAULT_CONTEXT_WINDOW);
				// Only an override can be mistyped, and only an approved row is
				// being saved; everything else keeps quiet.
				const windowError = draft.approved && draft.contextWindow !== undefined ? contextWindowError(draft.contextWindow) : null;
				const effectiveWindow = contextWindowError(effective.contextWindow) ? null : Number(effective.contextWindow.trim());
				const adjustOpen = openAdjust.has(draft.id);
				return (
					<div key={draft.id} className="configure-profile-model-option gateway-model-row">
						<label className="gateway-model-approve" title={draft.id}>
							<input type="checkbox" checked={draft.approved} onChange={() => update(draft.id, { approved: !draft.approved })} />
							<span className="configure-profile-model-name">{draft.id}</span>
						</label>
						{/* Facts, not controls: what the model effectively is, from the
						    person's choice where there is one and the gateway's word
						    where there is not. Changing them lives behind adjust. */}
						<span className="gateway-model-facts">
							{effective.vision && <span className="gateway-model-fact" title={draft.vision !== undefined ? "Images on, set by you" : "Images on, declared by the gateway"}>images</span>}
							{effective.reasoning && <span className="gateway-model-fact" title={draft.reasoning !== undefined ? "Thinking on, set by you" : "Thinking on, declared by the gateway"}>thinking</span>}
							<span className="gateway-model-fact" title={effectiveWindow == null ? "The context window needs fixing under adjust" : `${effectiveWindow} tokens${draft.contextWindow !== undefined ? ", set by you" : draft.detected?.contextWindow != null ? ", declared by the gateway" : ", the default"}`}>
								{effectiveWindow == null ? "context not set" : formatContextFigure(effectiveWindow)}
							</span>
						</span>
						<label className="gateway-model-websearch" title="Let this model search the web through the gateway's own search, on top of the room's web search tool. The gateway may bill these searches.">
							<input type="checkbox" checked={draft.webSearch} onChange={() => update(draft.id, { webSearch: !draft.webSearch })} />
							<span>web search</span>
						</label>
						<button type="button" className="gateway-model-adjust" aria-expanded={adjustOpen} onClick={() => toggleAdjust(draft.id)}>adjust</button>
						{adjustOpen && (
							<div className="gateway-model-adjust-fold">
								<div className="gateway-adjust-field">
									<span className="gateway-model-bulk-label">images</span>
									<span className="gateway-model-bulk-seg">
										<button type="button" className={effective.vision ? "seg-active" : ""} title="Send attached images to this model, as your choice" onClick={() => update(draft.id, { vision: true })}>on</button>
										<button type="button" className={effective.vision ? "" : "seg-active"} title="Keep images away from this model, as your choice" onClick={() => update(draft.id, { vision: false })}>off</button>
									</span>
								</div>
								<div className="gateway-adjust-field">
									<span className="gateway-model-bulk-label">thinking</span>
									<span className="gateway-model-bulk-seg">
										<button type="button" className={effective.reasoning ? "seg-active" : ""} title="Forward the room's thinking effort, the Faster to Smarter dial, to this model, as your choice" onClick={() => update(draft.id, { reasoning: true })}>on</button>
										<button type="button" className={effective.reasoning ? "" : "seg-active"} title="Never ask this model for extra thinking, as your choice" onClick={() => update(draft.id, { reasoning: false })}>off</button>
									</span>
								</div>
								<label className="gateway-adjust-field gateway-model-window">
									<span className="gateway-model-window-label">context</span>
									<input
										className={`launcher-path-input gateway-model-window-input${windowError ? " invalid" : ""}`}
										type="text"
										inputMode="numeric"
										value={effective.contextWindow}
										aria-label={`Context window for ${draft.id}`}
										aria-invalid={windowError ? true : undefined}
										onChange={(e) => update(draft.id, { contextWindow: e.target.value })}
									/>
								</label>
								<div className="gateway-model-detected-row">
									<span className="gateway-model-detected-note">{detectedNote(draft.detected)}</span>
									{rowCanTrustDetection(draft) && (
										<button
											type="button"
											className="gateway-model-bulk-button"
											title="Clear your choices for the fields the gateway answered, so this model follows detection again"
											onClick={() => onChange(drafts.map((row) => (row.id === draft.id ? trustDetected([row])[0] : row)))}
										>
											use detected
										</button>
									)}
								</div>
							</div>
						)}
						{isNonChatMode(draft.detected?.mode) && (
							<span className="gateway-model-window-error">{`The gateway says this model's mode is "${draft.detected?.mode}", not chat. A room locked to it cannot answer.`}</span>
						)}
						{windowError && <span className="gateway-model-window-error">{windowError}</span>}
					</div>
				);
			})}
		</div>
		</>
	);
}

/**
 * Add or edit one gateway: name, address, key, then the models it may run with
 * their image support and context size. `gatewayId` is null when a new gateway
 * is being added; an existing gateway keeps its ids untouched, because every
 * room already locked to it stores them.
 */
export function GatewayConfigModal({ gatewayId, knownLabel, onClose, onSaved }: { gatewayId: string | null; knownLabel?: string; onClose: () => void; onSaved: (gatewayLabel: string) => void }) {
	const [loaded, setLoaded] = useState(gatewayId === null);
	const [saved, setSaved] = useState<GatewayConfig | null>(null);
	// Seeded from the name the row already showed, never from a guess. Seeding
	// "OpenAI-compatible gateway" here used to flash the wrong name at anyone
	// editing a gateway called something else.
	const [label, setLabel] = useState(gatewayId === null ? "" : knownLabel ?? "");
	const [baseUrl, setBaseUrl] = useState("");
	const [token, setToken] = useState("");
	const [drafts, setDrafts] = useState<ModelDraft[]>([]);
	const [discoveredOnce, setDiscoveredOnce] = useState(false);
	// One quiet reassurance after a reload: hand-set fields survived it.
	const [reloadKeptNote, setReloadKeptNote] = useState(false);
	// One honest line about models the discover step kept out of the list.
	const [excludedNote, setExcludedNote] = useState<string | null>(null);
	const [manualMode, setManualMode] = useState(false);
	const [modelsText, setModelsText] = useState("");
	const [maintenanceModel, setMaintenanceModel] = useState("");
	const [discovering, setDiscovering] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// A create that succeeded (or failed after the gateway was already written)
	// hands back its id. Keeping it means a second attempt edits that gateway
	// instead of adding a twin beside it with the same name and address.
	const [createdId, setCreatedId] = useState<string | null>(null);
	// Fields the person has touched are never overwritten by the load that was
	// already in flight when they started typing.
	const dirtyRef = useRef<{ label: boolean; baseUrl: boolean }>({ label: false, baseUrl: false });
	useEscapeKey(onClose, true);

	const targetGatewayId = gatewayId ?? createdId;
	const configured = saved !== null;

	useEffect(() => {
		if (gatewayId === null) return;
		let stopped = false;
		fetchJson<GatewayConfig>(gatewaysUrl(gatewayId))
			.then((config) => {
				if (stopped) return;
				setSaved(config);
				if (!dirtyRef.current.label) setLabel(config.label);
				if (!dirtyRef.current.baseUrl) setBaseUrl(config.baseUrl ?? "");
				setMaintenanceModel(config.maintenanceModel ?? "");
				setDrafts(config.roomModels.map((model) => draftFromParts(model.modelId, true, model, undefined)));
				setModelsText(config.roomModels.map((model) => model.modelId).join("\n"));
			})
			.catch((e) => {
				if (!stopped) setError((e as Error).message);
			})
			.finally(() => {
				if (!stopped) setLoaded(true);
			});
		return () => {
			stopped = true;
		};
	}, [gatewayId]);

	const manualIds = useMemo(() => {
		const seen = new Set<string>();
		return modelsText
			.split(/[\n,]/)
			.map((value) => value.trim())
			.filter((value) => {
				if (!value || seen.has(value)) return false;
				seen.add(value);
				return true;
			});
	}, [modelsText]);

	async function discover() {
		setDiscovering(true);
		setError(null);
		try {
			const result = await fetchJson<GatewayDiscoverResponse>(gatewaysUrl(targetGatewayId, "/discover"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ baseUrl, key: token }),
			});
			const merged = mergeDrafts(drafts, result.models, result.detected ?? [], saved?.roomModels ?? []);
			setDrafts(merged);
			setReloadKeptNote(anyAdjustments(merged));
			setExcludedNote(nonChatExcludedNote(result.excludedNonChat));
			setDiscoveredOnce(true);
			setManualMode(false);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setDiscovering(false);
		}
	}

	// Manual entry is the fallback for a gateway with no model list of its own;
	// the ids typed here get the same two capability fields as discovered ones.
	const effectiveDrafts = manualMode
		? manualIds.map((id) => drafts.find((draft) => draft.id === id) ?? draftFromParts(id, true, undefined, undefined))
		: drafts;
	const approvedIds = effectiveDrafts.filter((draft) => draft.approved).map((draft) => draft.id);
	// The maintenance dropdown never offers a model the gateway declares
	// non-chat: Memorize and Review are chat turns and would never work on one.
	const maintenanceEligibleIds = effectiveDrafts.filter((draft) => draft.approved && !isNonChatMode(draft.detected?.mode)).map((draft) => draft.id);
	const effectiveMaintenanceModel = maintenanceModel && maintenanceEligibleIds.includes(maintenanceModel) ? maintenanceModel : maintenanceEligibleIds[0] ?? approvedIds[0] ?? "";

	async function save() {
		const windowError = approvedContextWindowError(effectiveDrafts);
		if (windowError) {
			setError(windowError);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const payload = {
				label,
				baseUrl,
				roomModels: draftsToPayload(effectiveDrafts),
				maintenanceModel: effectiveMaintenanceModel,
				// Sent with the gateway so the key is filed the moment its provider
				// exists; a blank key on an edit leaves the stored one alone.
				...(token.trim() ? { key: token.trim() } : {}),
			};
			// apiFetch rather than fetchJson: the id the server returns matters
			// even on a failure, because it is what turns a retry into an edit of
			// the gateway just created instead of a second one beside it.
			const response = await apiFetch(gatewaysUrl(targetGatewayId), {
				method: targetGatewayId === null ? "POST" : "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			let body: GatewaySaveResponse = {};
			try {
				body = (await response.json()) as GatewaySaveResponse;
			} catch {
				// A body we cannot read changes nothing about the status below.
			}
			if (body.gateway?.id) setCreatedId(body.gateway.id);
			if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
			onSaved(label.trim() || "Your gateway");
			onClose();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const canDiscover = Boolean(baseUrl.trim()) && (Boolean(token.trim()) || configured) && !discovering && !saving;
	const canSave = loaded && Boolean(label.trim()) && Boolean(baseUrl.trim()) && approvedIds.length > 0 && (Boolean(token.trim()) || configured) && !saving && !approvedContextWindowError(effectiveDrafts);
	const title = gatewayId === null ? "Add a gateway" : `Edit ${saved?.label ?? knownLabel ?? "gateway"}`;

	return (
		<div className="room-settings-overlay configure-profile-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
			<div className="room-settings-modal configure-profile-modal gateway-config-modal" onClick={(e) => e.stopPropagation()}>
				<div className="room-settings-head">
					<div className="room-settings-title-block">
						<div className="room-settings-title-row">
							<h2>{title}</h2>
						</div>
					</div>
					<button className="icon-btn" onClick={onClose} aria-label="Close">Close</button>
				</div>
				<div className="room-settings-body configure-profile-body">
					<p className="ai-setup-copy">
						Connect an OpenAI-compatible endpoint such as a company LiteLLM or vLLM gateway. Give it a name, enter the address and your API key, load the models it routes, and approve the ones your rooms may use. You can save as many gateways as you like and switch between them in the profile list.
					</p>
					<div className="configure-profile-field">
						<h3>Name</h3>
						<input className="launcher-path-input create-room-input" type="text" placeholder="Company gateway" value={label} onChange={(e) => { dirtyRef.current.label = true; setLabel(e.target.value); }} />
					</div>
					<div className="configure-profile-field">
						<h3>Base URL</h3>
						<input className="launcher-path-input create-room-input" type="text" placeholder="https://litellm.example.com/v1" value={baseUrl} onChange={(e) => { dirtyRef.current.baseUrl = true; setBaseUrl(e.target.value); }} />
					</div>
					<div className="configure-profile-field">
						<h3>API key</h3>
						<input
							className="launcher-path-input create-room-input"
							type="password"
							placeholder={configured ? "leave blank to keep the saved key" : "sk-…"}
							value={token}
							onChange={(e) => setToken(e.target.value)}
						/>
					</div>
					<div className="configure-profile-field">
						<h3>Room models</h3>
						{!manualMode && !discoveredOnce && drafts.length === 0 && (
							<div className="gateway-discover-row">
								<button className="landing-action" disabled={!canDiscover} onClick={() => void discover()}>{discovering ? "Loading…" : "Load models from gateway"}</button>
								<button className="ai-profile-foot-link" disabled={saving} onClick={() => setManualMode(true)}>enter ids manually</button>
							</div>
						)}
						{!manualMode && (discoveredOnce || drafts.length > 0) && (
							<>
								<GatewayModelApprovalList drafts={drafts} onChange={setDrafts} ariaLabel="Room models" askedGateway={discoveredOnce} />
								{excludedNote && <p className="cli-note">{excludedNote}</p>}
								{reloadKeptNote && <p className="cli-note">Your adjustments are kept. Use detected returns to the gateway's answers.</p>}
								<div className="gateway-discover-row">
									<button className="ai-profile-foot-link" disabled={!canDiscover} onClick={() => void discover()}>{discovering ? "reloading…" : "reload from gateway"}</button>
									<button className="ai-profile-foot-link" disabled={saving} onClick={() => setManualMode(true)}>enter ids manually</button>
								</div>
							</>
						)}
						{manualMode && (
							<>
								<textarea
									className="launcher-path-input create-room-input gateway-models-input"
									placeholder={"one model id per line, e.g.\ngpt-4o\nclaude-sonnet"}
									value={modelsText}
									onChange={(e) => setModelsText(e.target.value)}
									rows={4}
								/>
								{effectiveDrafts.length > 0 && (
									<>
										<p className="cli-note">{MANUAL_IDS_DEFAULTS_NOTE}</p>
										<GatewayModelApprovalList
											drafts={effectiveDrafts}
											onChange={(next) => setDrafts((current) => [...current.filter((draft) => !next.some((entry) => entry.id === draft.id)), ...next])}
											ariaLabel="Room models"
										/>
									</>
								)}
								<div className="gateway-discover-row">
									<button className="ai-profile-foot-link" disabled={!canDiscover} onClick={() => { setManualMode(false); void discover(); }}>load from gateway instead</button>
								</div>
							</>
						)}
					</div>
					<div className="configure-profile-field">
						<h3>Memorize &amp; Review</h3>
						<select className="configure-profile-select" value={effectiveMaintenanceModel} onChange={(e) => setMaintenanceModel(e.target.value)} aria-label="Maintenance model" disabled={approvedIds.length === 0}>
							{maintenanceEligibleIds.map((id) => (
								<option key={id} value={id}>{catalogModelName({ id })}</option>
							))}
						</select>
					</div>
					{error && <div className="checkpoint-proposal-error">{error}</div>}
					<div className="create-room-actions">
						<button className="landing-action" disabled={!canSave} onClick={() => void save()}>{saving ? "Saving…" : "Save gateway"}</button>
						<button className="inline-action" disabled={saving} onClick={onClose}>Cancel</button>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * Approve-models for one saved gateway: the same suggest-then-approve step
 * custom providers get, scoped to the model set and its two capability fields.
 * Name, base URL and API key are untouched here; Edit gateway owns those. A
 * gateway policy has one maintenance model that runs both Memorize and
 * Review, so the modal shows a single picker instead of pretending there are two.
 */
export function GatewayApproveModelsModal({ gatewayId, onClose, onSaved }: { gatewayId: string; onClose: () => void; onSaved: () => void }) {
	const [config, setConfig] = useState<GatewayConfig | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<ModelDraft[]>([]);
	const [discovering, setDiscovering] = useState(false);
	const [discoverError, setDiscoverError] = useState<string | null>(null);
	const [reloadKeptNote, setReloadKeptNote] = useState(false);
	// One honest line about models the discover step kept out of the list.
	const [excludedNote, setExcludedNote] = useState<string | null>(null);
	// Only a real answer from the gateway justifies claiming it says nothing.
	const [askedGateway, setAskedGateway] = useState(false);
	const [manualMode, setManualMode] = useState(false);
	const [modelsText, setModelsText] = useState("");
	const [maintenanceModel, setMaintenanceModel] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	useEscapeKey(onClose, true);

	async function discover(gateway: GatewayConfig, keepDrafts: ModelDraft[]) {
		setDiscovering(true);
		setDiscoverError(null);
		try {
			// No key in the body: the server uses the gateway's stored key.
			const result = await fetchJson<GatewayDiscoverResponse>(gatewaysUrl(gateway.id, "/discover"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ baseUrl: gateway.baseUrl }),
			});
			const merged = mergeDrafts(keepDrafts, result.models, result.detected ?? [], gateway.roomModels);
			setDrafts(merged);
			setReloadKeptNote(anyAdjustments(merged));
			setExcludedNote(nonChatExcludedNote(result.excludedNonChat));
			setAskedGateway(true);
			setManualMode(false);
		} catch (e) {
			setDiscoverError((e as Error).message);
			// Graceful fallback: the currently approved set is the list.
			setDrafts(keepDrafts);
		} finally {
			setDiscovering(false);
		}
	}

	useEffect(() => {
		let stopped = false;
		fetchJson<GatewayConfig>(gatewaysUrl(gatewayId))
			.then((result) => {
				if (stopped) return;
				setConfig(result);
				const initial = result.roomModels.map((model) => draftFromParts(model.modelId, true, model, undefined));
				setDrafts(initial);
				setModelsText(result.roomModels.map((model) => model.modelId).join("\n"));
				setMaintenanceModel(result.maintenanceModel ?? "");
				void discover(result, initial);
			})
			.catch((e) => {
				if (!stopped) setLoadError((e as Error).message);
			});
		return () => {
			stopped = true;
		};
	}, [gatewayId]);

	const manualIds = useMemo(() => {
		const seen = new Set<string>();
		return modelsText
			.split(/[\n,]/)
			.map((value) => value.trim())
			.filter((value) => {
				if (!value || seen.has(value)) return false;
				seen.add(value);
				return true;
			});
	}, [modelsText]);

	const effectiveDrafts = manualMode
		? manualIds.map((id) => drafts.find((draft) => draft.id === id) ?? draftFromParts(id, true, undefined, undefined))
		: drafts;
	const approvedIds = effectiveDrafts.filter((draft) => draft.approved).map((draft) => draft.id);
	// The maintenance dropdown never offers a model the gateway declares
	// non-chat: Memorize and Review are chat turns and would never work on one.
	const maintenanceEligibleIds = effectiveDrafts.filter((draft) => draft.approved && !isNonChatMode(draft.detected?.mode)).map((draft) => draft.id);
	const effectiveMaintenanceModel = maintenanceModel && maintenanceEligibleIds.includes(maintenanceModel) ? maintenanceModel : maintenanceEligibleIds[0] ?? approvedIds[0] ?? "";

	async function save() {
		if (!config) return;
		const windowError = approvedContextWindowError(effectiveDrafts);
		if (windowError) {
			setSaveError(windowError);
			return;
		}
		setSaving(true);
		setSaveError(null);
		try {
			await fetchJson(gatewaysUrl(config.id), {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					label: config.label,
					// Only sent when the gateway actually has one. A gateway carried
					// over from the legacy file may have no address recorded
					// anywhere, and this screen is not the one that asks for it.
					...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
					roomModels: draftsToPayload(effectiveDrafts),
					maintenanceModel: effectiveMaintenanceModel,
				}),
			});
			onSaved();
			onClose();
		} catch (e) {
			setSaveError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const loading = !config && !loadError;
	const canSave = Boolean(config) && approvedIds.length > 0 && !saving && !discovering && !approvedContextWindowError(effectiveDrafts);
	const gatewayName = config?.label || "gateway";

	return (
		<div className="room-settings-overlay configure-profile-overlay" role="dialog" aria-modal="true" aria-label="Approve gateway models" onClick={onClose}>
			<div className="room-settings-modal configure-profile-modal gateway-config-modal" onClick={(e) => e.stopPropagation()}>
				<div className="room-settings-head">
					<div className="room-settings-title-block">
						<div className="room-settings-title-row">
							<h2>{`Approve ${gatewayName} models`}</h2>
						</div>
					</div>
					<button className="icon-btn" onClick={onClose} aria-label="Close">Close</button>
				</div>
				<div className="room-settings-body configure-profile-body">
					<p className="ai-setup-copy">
						Choose the models your rooms may run on, whether each one can look at images, and how much context it has. The gateway address and API key stay as they are; use Edit gateway to change those.
					</p>
					{loadError && <div className="checkpoint-proposal-error">{loadError}</div>}
					{loading && <p className="cli-note">Loading gateway configuration…</p>}
					{config && (
						<>
							<div className="configure-profile-field">
								<h3>Rooms</h3>
								{discovering && <p className="cli-note">Loading models from the gateway…</p>}
								{!discovering && discoverError && (
									<>
										<div className="checkpoint-proposal-error">{discoverError}</div>
										<p className="cli-note">Showing the currently approved models instead. You can reload from the gateway or enter ids manually.</p>
									</>
								)}
								{!discovering && !manualMode && (
									<>
										<GatewayModelApprovalList drafts={drafts} onChange={setDrafts} ariaLabel="Room models" askedGateway={askedGateway} />
										{excludedNote && <p className="cli-note">{excludedNote}</p>}
										{reloadKeptNote && <p className="cli-note">Your adjustments are kept. Use detected returns to the gateway's answers.</p>}
										<div className="gateway-discover-row">
											<button className="ai-profile-foot-link" disabled={saving} onClick={() => void discover(config, drafts)}>reload from gateway</button>
											<button className="ai-profile-foot-link" disabled={saving} onClick={() => setManualMode(true)}>enter ids manually</button>
										</div>
									</>
								)}
								{!discovering && manualMode && (
									<>
										<textarea
											className="launcher-path-input create-room-input gateway-models-input"
											placeholder={"one model id per line, e.g.\ngpt-4o\nclaude-sonnet"}
											value={modelsText}
											onChange={(e) => setModelsText(e.target.value)}
											rows={4}
										/>
										{effectiveDrafts.length > 0 && (
											<>
												<p className="cli-note">{MANUAL_IDS_DEFAULTS_NOTE}</p>
												<GatewayModelApprovalList
													drafts={effectiveDrafts}
													onChange={(next) => setDrafts((current) => [...current.filter((draft) => !next.some((entry) => entry.id === draft.id)), ...next])}
													ariaLabel="Room models"
												/>
											</>
										)}
										<div className="gateway-discover-row">
											<button className="ai-profile-foot-link" disabled={saving} onClick={() => setManualMode(false)}>back to the model list</button>
										</div>
									</>
								)}
							</div>
							<div className="configure-profile-field">
								<h3>Memorize and Review</h3>
								<select className="configure-profile-select" value={effectiveMaintenanceModel} onChange={(e) => setMaintenanceModel(e.target.value)} aria-label="Maintenance model" disabled={approvedIds.length === 0}>
									{maintenanceEligibleIds.map((id) => (
										<option key={id} value={id}>{catalogModelName({ id })}</option>
									))}
								</select>
							</div>
							{saveError && <div className="checkpoint-proposal-error">{saveError}</div>}
							<div className="create-room-actions">
								<button className="landing-action" disabled={!canSave} onClick={() => void save()}>{saving ? "Saving…" : "Save models"}</button>
								<button className="inline-action" disabled={saving} onClick={onClose}>Cancel</button>
							</div>
						</>
					)}
					{loadError && (
						<div className="create-room-actions">
							<button className="inline-action" onClick={onClose}>Close</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

// Providers most people reach for first; the rest follow alphabetically.
const POPULAR_PROVIDER_ORDER = ["google", "mistral", "openrouter", "deepseek", "xai", "groq", "together", "fireworks"];

// "Add provider" flow on the AI setup page: the full raw-Pi sign-in surface —
// subscription (OAuth) providers plus API-key providers — followed by the
// approve-models step that creates the provider's profile.
export function AddProviderPanel({ onProfilesChanged, onKeyFormOpen, keyFormBlocked, profilesSignature, trailing }: {
	onProfilesChanged: () => void;
	/** Told when this panel opens a key form, so the page can close any other one. */
	onKeyFormOpen?: () => void;
	/** True while a key form outside this panel is open; this panel closes its own. */
	keyFormBlocked?: boolean;
	/** A string that changes whenever the profile list above changes. Removing a
	 *  gateway-backed profile up there deletes the gateway down here, and a signed-out
	 *  provider becomes addable again, so both of this panel's lists are re-read when
	 *  it moves. Passing nothing simply keeps the open-time refresh. */
	profilesSignature?: string;
	/** Rendered at the right end of the toggle row (the page's Refresh link),
	 *  so the two controls share one line under the profile list. */
	trailing?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [providers, setProviders] = useState<LoginProviderCatalogEntry[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [apiKeyProvider, setApiKeyProvider] = useState<LoginProviderCatalogEntry | null>(null);
	const [configureProvider, setConfigureProvider] = useState<{ id: string; name: string } | null>(null);
	// null id means "adding a new one"; the modal is closed when the whole slot is null.
	const [gatewayEdit, setGatewayEdit] = useState<{ id: string | null; label?: string } | null>(null);
	// A gateways file that cannot be read is not an empty one, and the panel must
	// not quietly offer to add a gateway on top of a list it cannot see. The list
	// itself is not kept: nothing down here renders it any more.
	const [gatewayNotice, setGatewayNotice] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [addedNote, setAddedNote] = useState<string | null>(null);

	/** The provider whose key form is open, if any. */
	const keyFormOpen = apiKeyProvider?.id ?? null;
	// Two open key forms at once is two invitations to type a secret with no way
	// of telling which row either belongs to. Only one stays open, page-wide.
	function openApiKeyProvider(provider: LoginProviderCatalogEntry | null) {
		// Refusing outright rather than trusting the caller to also hand us a way of
		// closing the other form: the invariant holds on its own either way.
		if (provider && keyFormBlocked) return;
		setApiKeyProvider(provider);
		if (provider) onKeyFormOpen?.();
	}
	useEffect(() => {
		if (keyFormBlocked) setApiKeyProvider(null);
	}, [keyFormBlocked]);

	// Called when a provider gains its profile: collapse the panel and narrate
	// the hand-off so the row appearing above does not read as a disappearance.
	function announceAdded(name: string) {
		setAddedNote(`${name} added · it now appears above as a profile.`);
		setOpen(false);
		setFilter("");
	}

	const login = useProviderLogin((providerId, ok) => {
		if (!ok) return;
		const entry = providers?.find((provider) => provider.id === providerId);
		if (!entry?.profileId) setConfigureProvider({ id: providerId, name: entry?.name ?? providerId });
		onProfilesChanged();
	});

	async function refreshProviders() {
		try {
			const result = await fetchJson<{ providers: LoginProviderCatalogEntry[] }>("/api/auth/providers");
			setProviders(result.providers);
			setLoadError(null);
		} catch (e) {
			setLoadError((e as Error).message);
		}
	}

	async function refreshGateways() {
		try {
			const result = await fetchJson<GatewayListResponse>(gatewaysUrl(null));
			setGatewayNotice(result.unreadable ? result.errors[0] ?? "Saved gateways could not be read." : null);
		} catch {
			// Leave whatever the panel is already showing rather than replacing it
			// with a claim that there are no gateways.
		}
	}

	// Both lists are read on open, and read again whenever the profile list above
	// moves. That list is where a gateway-backed profile gets removed, and the
	// server deletes the gateway with it; without this the row below stayed on
	// screen offering to edit something that no longer exists.
	useEffect(() => {
		if (!open) return;
		void refreshProviders();
		void refreshGateways();
	}, [open, profilesSignature]);

	async function removeKey(provider: LoginProviderCatalogEntry) {
		login.setError(null);
		try {
			await fetchJson("/api/auth/logout", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: provider.id }),
			});
			onProfilesChanged();
			void refreshProviders();
		} catch (e) {
			login.setError((e as Error).message);
		}
	}

	async function saveApiKey(key: string) {
		if (!apiKeyProvider) return;
		login.setError(null);
		try {
			await fetchJson("/api/auth/api-key", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: apiKeyProvider.id, key }),
			});
			const needsProfile = !apiKeyProvider.profileId;
			const picked = apiKeyProvider;
			setApiKeyProvider(null);
			if (needsProfile) setConfigureProvider({ id: picked.id, name: picked.name });
			onProfilesChanged();
			void refreshProviders();
		} catch (e) {
			login.setError((e as Error).message);
		}
	}

	// Providers that already carry a profile have their own row above.
	const addable = (providers ?? []).filter((provider) => !provider.profileId);
	const filterText = filter.trim().toLowerCase();
	const matchesFilter = (provider: LoginProviderCatalogEntry) =>
		!filterText || provider.name.toLowerCase().includes(filterText) || provider.id.toLowerCase().includes(filterText);
	const oauthProviders = addable.filter((provider) => provider.authTypes.includes("oauth")).filter(matchesFilter);
	const apiKeyProviders = addable
		.filter((provider) => !provider.authTypes.includes("oauth"))
		.filter(matchesFilter)
		.sort((a, b) => {
			const aRank = POPULAR_PROVIDER_ORDER.indexOf(a.id);
			const bRank = POPULAR_PROVIDER_ORDER.indexOf(b.id);
			if (aRank !== -1 || bRank !== -1) return (aRank === -1 ? POPULAR_PROVIDER_ORDER.length : aRank) - (bRank === -1 ? POPULAR_PROVIDER_ORDER.length : bRank);
			return a.name.localeCompare(b.name);
		});

	return (
		<div className="add-provider-panel">
			<span className="add-provider-toggle-row">
				{/* Collapsing takes the key form with it. Leaving it open would bring an
				    autofocused secret field back on the next open, one nothing outside
				    this panel knows about. */}
				<button className="ai-profile-foot-link add-provider-toggle" aria-expanded={open} onClick={() => { setAddedNote(null); setApiKeyProvider(null); setOpen((value) => !value); }}>
					{open ? "Add another provider ▴" : "Add another provider ▾"}
				</button>
				{addedNote && !open && <span className="add-provider-added-note">{addedNote}</span>}
				{trailing && <span className="add-provider-toggle-trailing">{trailing}</span>}
			</span>
			{open && (
				<div className="ai-setup-block add-provider-block">
					<p className="cli-note">Sign in, then approve the models it may use.</p>
					{loadError && <div className="checkpoint-proposal-error">{loadError}</div>}
					{!providers && !loadError && <p className="cli-note">Loading providers…</p>}
					{login.error && <div className="checkpoint-proposal-error">{login.error}</div>}
					{providers && addable.length > 6 && (
						<input
							className="launcher-path-input create-room-input add-provider-filter"
							type="text"
							placeholder="Filter providers…"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
						/>
					)}
					{providers && filterText && oauthProviders.length === 0 && apiKeyProviders.length === 0 && (
						<p className="cli-note">No provider matches "{filter.trim()}".</p>
					)}
					{oauthProviders.length > 0 && (
						<div className="add-provider-group">
							<h3>Subscription</h3>
							<div className="add-provider-rows">
								{oauthProviders.map((provider) => (
									<div key={provider.id} className="add-provider-row-group">
										<div className="add-provider-row">
											<span className="add-provider-name">{provider.name}</span>
											<span className="add-provider-side">
												{provider.configured && <span className="add-provider-configured">signed in</span>}
												{login.signingInProvider === provider.id ? (
													<>
														<span className="add-provider-configured">finish signing in in your browser…</span>
														<button className="ai-profile-foot-link" onClick={() => void login.cancel()}>Cancel</button>
													</>
												) : provider.configured ? (
													<button className="ai-profile-foot-link" onClick={() => setConfigureProvider({ id: provider.id, name: provider.name })}>Approve models</button>
												) : (
													<button className="ai-profile-signin" disabled={login.signingInProvider !== null} onClick={() => void login.signIn(provider.id)}>Sign in →</button>
												)}
											</span>
										</div>
										{login.signingInProvider === provider.id && login.instructions && (
											<div className="add-provider-instructions">{login.instructions}</div>
										)}
									</div>
								))}
							</div>
						</div>
					)}
					<div className="add-provider-group">
						<h3>Gateways</h3>
						{gatewayNotice && <div className="checkpoint-proposal-error">{gatewayNotice}</div>}
						{/* This group only adds. A gateway that exists is a profile in the
						    list above, and that row's menu already carries every way of
						    changing or ending it; a second copy of those actions down here
						    was a second place to look and a second place to be wrong. */}
						<div className="add-provider-rows">
							<div className="add-provider-row">
								<span className="add-provider-name">OpenAI-compatible gateway · LiteLLM, vLLM, company proxies</span>
								<span className="add-provider-side">
									<button className="ai-profile-foot-link" onClick={() => setGatewayEdit({ id: null })}>Add gateway</button>
								</span>
							</div>
						</div>
					</div>
					{apiKeyProviders.length > 0 && (
						<div className="add-provider-group">
							<h3>API key</h3>
							<div className="add-provider-rows">
								{apiKeyProviders.map((provider) => (
									<div key={provider.id} className={`add-provider-row-group${keyFormOpen === provider.id ? " key-open" : ""}`}>
										<div className="add-provider-row">
											<span className="add-provider-name">{provider.name}</span>
											<span className="add-provider-side">
												{provider.configured && <span className="add-provider-configured">key saved</span>}
												{/* The open form owns the way out. A row that also kept its own
												    Cancel put two of them on screen at once, one under the other,
												    both closing the same thing. */}
												{provider.configured ? (
													<>
														<button className="ai-profile-foot-link" onClick={() => setConfigureProvider({ id: provider.id, name: provider.name })}>Approve models</button>
														{keyFormOpen !== provider.id && (
															<button className="ai-profile-foot-link" onClick={() => openApiKeyProvider(provider)}>Replace key</button>
														)}
														<button className="ai-profile-foot-link" onClick={() => void removeKey(provider)}>Remove key</button>
													</>
												) : (
													keyFormOpen !== provider.id && (
														<button className="ai-profile-foot-link" onClick={() => openApiKeyProvider(provider)}>Add API key</button>
													)
												)}
											</span>
										</div>
										{keyFormOpen === provider.id && (
											<ApiKeyForm className="add-provider-row-key-form" placeholder={`${provider.name} API key`} onSave={saveApiKey} onCancel={() => setApiKeyProvider(null)} />
										)}
									</div>
								))}
							</div>
							<p className="cli-note">Keys stay on this device.</p>
						</div>
					)}
				</div>
			)}
			{gatewayEdit && (
				<GatewayConfigModal
					gatewayId={gatewayEdit.id}
					knownLabel={gatewayEdit.label}
					onClose={() => setGatewayEdit(null)}
					onSaved={(gatewayLabel) => {
						const wasNew = gatewayEdit.id === null;
						if (wasNew) announceAdded(gatewayLabel);
						onProfilesChanged();
						void refreshProviders();
						void refreshGateways();
					}}
				/>
			)}
			{configureProvider && (
				<ConfigureProfileModal
					providerId={configureProvider.id}
					providerName={configureProvider.name}
					onClose={() => setConfigureProvider(null)}
					onSaved={() => {
						announceAdded(configureProvider.name);
						onProfilesChanged();
						void refreshProviders();
					}}
				/>
			)}
		</div>
	);
}
