import { useEffect, useMemo, useRef, useState } from "react";
import type { LoginProviderCatalogEntry, PersistentAgentAiProfileStatus, ProviderModelCatalog } from "../types";
import { useEscapeKey } from "./use-escape-key";
import { apiFetch, fetchJson } from "../api";
import { modelDisplayName } from "../model-names";

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
export function ApiKeyForm({ placeholder, onSave, className }: {
	placeholder: string;
	onSave: (key: string) => Promise<void>;
	className?: string;
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
				}}
			/>
			<button className="landing-action" disabled={!key.trim() || saving} onClick={() => void save()}>
				{saving ? "Saving…" : "Save key"}
			</button>
		</div>
	);
}

// Browser sign-in for a raw provider id: the server starts the same OAuth flow
// the CLI /login runs, we open the URL in a new tab and poll until it settles.
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
// rooms may use, and which model runs Learn and Review Memory. Saving creates
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
						Choose the models your rooms may run on, and which model handles Learn and Review Memory. You can change this later.
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
								<h3>Learn</h3>
								<select className="configure-profile-select" value={learnModel} onChange={(e) => setLearnModel(e.target.value)} aria-label="Learn model">
									{catalog.models.map((model) => (
										<option key={model.id} value={model.id}>{catalogModelName(model)}{model.suggestedDefault ? " (suggested)" : ""}</option>
									))}
								</select>
							</div>
							<div className="configure-profile-field">
								<h3>Review Memory</h3>
								<select className="configure-profile-select" value={reviewMemoryModel} onChange={(e) => setReviewMemoryModel(e.target.value)} aria-label="Review Memory model">
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
	vision: boolean;
	/** Null when nobody chose one, which means the default window applies. */
	contextWindow: number | null;
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
type GatewayDetection = { id: string; vision: boolean | null; contextWindow: number | null };
type GatewayDiscoverResponse = { models: string[]; detected?: GatewayDetection[] };
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

/** The first complaint any approved model's window has, or null when they are all fine. */
function approvedContextWindowError(drafts: ModelDraft[]): string | null {
	for (const draft of drafts) {
		if (!draft.approved) continue;
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
 * One row of the approve step: whether the model is approved, whether it can
 * look at images, and how much context it really has. Detection fills these in
 * where a gateway publishes them; the person editing them has the last word,
 * which is why every field stays enabled either way.
 */
type ModelDraft = {
	id: string;
	approved: boolean;
	vision: boolean;
	contextWindow: string;
	/**
	 * The display name a gateway's model was saved under. Carried through the
	 * form untouched: it is nobody's job here to edit it, but dropping it would
	 * quietly collapse a migrated gateway's model names to raw ids, and there is
	 * no getting them back.
	 */
	label?: string;
};

function draftFromParts(id: string, approved: boolean, saved: GatewayModelConfig | undefined, detected: GatewayDetection | undefined): ModelDraft {
	return {
		id,
		approved,
		vision: saved?.vision ?? detected?.vision ?? false,
		contextWindow: String(saved?.contextWindow ?? detected?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
		...(saved?.label && saved.label !== id ? { label: saved.label } : {}),
	};
}

function draftsToPayload(drafts: ModelDraft[]): Array<{ modelId: string; vision: boolean; contextWindow: number; label?: string }> {
	return drafts
		.filter((draft) => draft.approved)
		.map((draft) => ({
			modelId: draft.id,
			vision: draft.vision,
			// Validated before we get here, so the fallback is only ever reached
			// by a caller that skipped the check.
			contextWindow: contextWindowError(draft.contextWindow) ? DEFAULT_CONTEXT_WINDOW : Number(draft.contextWindow.trim()),
			...(draft.label ? { label: draft.label } : {}),
		}));
}

/**
 * Merge what the gateway just said with what is already on screen. Anything the
 * person touched survives a reload; a model the gateway stopped listing stays
 * visible so saving never drops it behind their back.
 */
function mergeDrafts(current: ModelDraft[], discovered: string[], detections: GatewayDetection[], saved: GatewayModelConfig[]): ModelDraft[] {
	const byId = new Map(current.map((draft) => [draft.id, draft]));
	const detectedById = new Map(detections.map((detection) => [detection.id, detection]));
	const savedById = new Map(saved.map((model) => [model.modelId, model]));
	const ids = [...new Set([...discovered, ...saved.map((model) => model.modelId), ...current.map((draft) => draft.id)])].sort();
	return ids.map((id) => byId.get(id) ?? draftFromParts(id, savedById.has(id), savedById.get(id), detectedById.get(id)));
}

export function GatewayModelApprovalList({ drafts, onChange, ariaLabel }: {
	drafts: ModelDraft[];
	onChange: (next: ModelDraft[]) => void;
	ariaLabel: string;
}) {
	function update(id: string, patch: Partial<ModelDraft>) {
		onChange(drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
	}
	return (
		<div className="configure-profile-model-list gateway-model-list" role="group" aria-label={ariaLabel}>
			{drafts.map((draft) => {
				// An unapproved model's window is not going anywhere, so it is not
				// worth complaining about; the row people are actually saving is.
				const windowError = draft.approved ? contextWindowError(draft.contextWindow) : null;
				return (
					<div key={draft.id} className="configure-profile-model-option gateway-model-row">
						<label className="gateway-model-approve" title={draft.id}>
							<input type="checkbox" checked={draft.approved} onChange={() => update(draft.id, { approved: !draft.approved })} />
							<span className="configure-profile-model-name">{draft.id}</span>
						</label>
						<label className="gateway-model-vision" title="Send attached images to this model instead of a placeholder">
							<input type="checkbox" checked={draft.vision} onChange={() => update(draft.id, { vision: !draft.vision })} />
							<span>supports images</span>
						</label>
						<label className="gateway-model-window">
							<span className="gateway-model-window-label">context</span>
							<input
								className={`launcher-path-input gateway-model-window-input${windowError ? " invalid" : ""}`}
								type="text"
								inputMode="numeric"
								value={draft.contextWindow}
								aria-label={`Context window for ${draft.id}`}
								aria-invalid={windowError ? true : undefined}
								onChange={(e) => update(draft.id, { contextWindow: e.target.value })}
							/>
						</label>
						{windowError && <span className="gateway-model-window-error">{windowError}</span>}
					</div>
				);
			})}
		</div>
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
			setDrafts((current) => mergeDrafts(current, result.models, result.detected ?? [], saved?.roomModels ?? []));
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
	const effectiveMaintenanceModel = maintenanceModel && approvedIds.includes(maintenanceModel) ? maintenanceModel : approvedIds[0] ?? "";

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
			<div className="room-settings-modal configure-profile-modal" onClick={(e) => e.stopPropagation()}>
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
								<GatewayModelApprovalList drafts={drafts} onChange={setDrafts} ariaLabel="Room models" />
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
									<GatewayModelApprovalList
										drafts={effectiveDrafts}
										onChange={(next) => setDrafts((current) => [...current.filter((draft) => !next.some((entry) => entry.id === draft.id)), ...next])}
										ariaLabel="Room models"
									/>
								)}
								<div className="gateway-discover-row">
									<button className="ai-profile-foot-link" disabled={!canDiscover} onClick={() => { setManualMode(false); void discover(); }}>load from gateway instead</button>
								</div>
							</>
						)}
					</div>
					<div className="configure-profile-field">
						<h3>Learn &amp; Review Memory</h3>
						<select className="configure-profile-select" value={effectiveMaintenanceModel} onChange={(e) => setMaintenanceModel(e.target.value)} aria-label="Maintenance model" disabled={approvedIds.length === 0}>
							{approvedIds.map((id) => (
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
 * gateway policy has one maintenance model that runs both Learn and Review
 * Memory, so the modal shows a single picker instead of pretending there are two.
 */
export function GatewayApproveModelsModal({ gatewayId, onClose, onSaved }: { gatewayId: string; onClose: () => void; onSaved: () => void }) {
	const [config, setConfig] = useState<GatewayConfig | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<ModelDraft[]>([]);
	const [discovering, setDiscovering] = useState(false);
	const [discoverError, setDiscoverError] = useState<string | null>(null);
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
			setDrafts(mergeDrafts(keepDrafts, result.models, result.detected ?? [], gateway.roomModels));
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
	const effectiveMaintenanceModel = maintenanceModel && approvedIds.includes(maintenanceModel) ? maintenanceModel : approvedIds[0] ?? "";

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
			<div className="room-settings-modal configure-profile-modal" onClick={(e) => e.stopPropagation()}>
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
										<GatewayModelApprovalList drafts={drafts} onChange={setDrafts} ariaLabel="Room models" />
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
											<GatewayModelApprovalList
												drafts={effectiveDrafts}
												onChange={(next) => setDrafts((current) => [...current.filter((draft) => !next.some((entry) => entry.id === draft.id)), ...next])}
												ariaLabel="Room models"
											/>
										)}
										<div className="gateway-discover-row">
											<button className="ai-profile-foot-link" disabled={saving} onClick={() => setManualMode(false)}>back to the model list</button>
										</div>
									</>
								)}
							</div>
							<div className="configure-profile-field">
								<h3>Learn and Review Memory</h3>
								<select className="configure-profile-select" value={effectiveMaintenanceModel} onChange={(e) => setMaintenanceModel(e.target.value)} aria-label="Maintenance model" disabled={approvedIds.length === 0}>
									{approvedIds.map((id) => (
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
export function AddProviderPanel({ onProfilesChanged }: { onProfilesChanged: () => void }) {
	const [open, setOpen] = useState(false);
	const [providers, setProviders] = useState<LoginProviderCatalogEntry[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [apiKeyProvider, setApiKeyProvider] = useState<LoginProviderCatalogEntry | null>(null);
	const [configureProvider, setConfigureProvider] = useState<{ id: string; name: string } | null>(null);
	// null id means "adding a new one"; the modal is closed when the whole slot is null.
	const [gatewayEdit, setGatewayEdit] = useState<{ id: string | null; label?: string } | null>(null);
	const [gateways, setGateways] = useState<GatewayConfig[]>([]);
	// A gateways file that cannot be read is not an empty one, and the panel must
	// not quietly offer to add a first gateway on top of a list it cannot see.
	const [gatewayNotice, setGatewayNotice] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [addedNote, setAddedNote] = useState<string | null>(null);

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
			setGateways(result.gateways);
			setGatewayNotice(result.unreadable ? result.errors[0] ?? "Saved gateways could not be read." : null);
		} catch {
			// Leave whatever the panel is already showing rather than replacing it
			// with a claim that there are no gateways.
		}
	}

	useEffect(() => {
		if (!open) return;
		void refreshProviders();
		void refreshGateways();
	}, [open]);

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
				<button className="ai-profile-foot-link add-provider-toggle" aria-expanded={open} onClick={() => { setAddedNote(null); setOpen((value) => !value); }}>
					{open ? "Add another provider ▴" : "Add another provider ▾"}
				</button>
				{addedNote && !open && <span className="add-provider-added-note">{addedNote}</span>}
			</span>
			{open && (
				<div className="ai-setup-block add-provider-block">
					<p className="cli-note">
						Sign in with any provider the runtime supports · the same options as the CLI /login. After signing in you approve which models it may use.
					</p>
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
						<h3>Custom gateways</h3>
						{gatewayNotice && <div className="checkpoint-proposal-error">{gatewayNotice}</div>}
						<div className="add-provider-rows">
							{gateways.map((gateway) => (
								<div key={gateway.id} className="add-provider-row">
									<span className="add-provider-name">{gateway.label}</span>
									<span className="add-provider-side">
										<span className="add-provider-configured">configured</span>
										<button className="ai-profile-foot-link" onClick={() => setGatewayEdit({ id: gateway.id, label: gateway.label })}>Edit gateway</button>
									</span>
								</div>
							))}
							<div className="add-provider-row">
								<span className="add-provider-name">OpenAI-compatible endpoint · LiteLLM, vLLM, OpenRouter, company proxies</span>
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
									<div key={provider.id} className="add-provider-row-group">
										<div className="add-provider-row">
											<span className="add-provider-name">{provider.name}</span>
											<span className="add-provider-side">
												{provider.configured && <span className="add-provider-configured">key saved</span>}
												{provider.configured ? (
													<>
														<button className="ai-profile-foot-link" onClick={() => setConfigureProvider({ id: provider.id, name: provider.name })}>Approve models</button>
														<button className="ai-profile-foot-link" onClick={() => setApiKeyProvider(apiKeyProvider?.id === provider.id ? null : provider)}>
															{apiKeyProvider?.id === provider.id ? "Cancel" : "Replace key"}
														</button>
														<button className="ai-profile-foot-link" onClick={() => void removeKey(provider)}>Remove key</button>
													</>
												) : (
													<button
														className="ai-profile-foot-link"
														onClick={() => setApiKeyProvider(apiKeyProvider?.id === provider.id ? null : provider)}
													>
														{apiKeyProvider?.id === provider.id ? "Cancel" : "Add API key"}
													</button>
												)}
											</span>
										</div>
										{apiKeyProvider?.id === provider.id && (
											<ApiKeyForm placeholder={`${provider.name} API key`} onSave={saveApiKey} />
										)}
									</div>
								))}
							</div>
							<p className="cli-note">Keys stay on this device in the local auth store, shared with the exxperts CLI.</p>
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
