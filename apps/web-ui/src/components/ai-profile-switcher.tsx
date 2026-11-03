import { type ReactNode, useRef, useState, useLayoutEffect, useEffect } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "./use-escape-key";
import { PaneHeader, GroupHeader } from "./pane-header";
import { useRemoteClientContext, aiSetupLocked, SHARED_SERVER_ADMIN_LINE, NEW_ADMIN_HINT } from "../remote-client-context";
import { useProviderLogin, ApiKeyForm, AddProviderPanel, ConfigureProfileModal, GatewayConfigModal, GatewayApproveModelsModal } from "./add-provider-panel";
import { AiDefaultsGroup } from "./ai-defaults-group";
import { fetchJson, withoutServiceLine } from "../api";
import { modelTooltipName, distinctModelNames } from "../model-names";
import type { AuthStatusResponse, WebChatModelStatus, PersistentAgentAiProfileSelectionStatus, PersistentAgentAiProfileStatus, LoginProviderCatalogEntry } from "../types";

function authSourceLabel(source?: AuthStatusResponse["providers"][number]["source"], label?: string): string {
	if (source === "stored") return "stored locally";
	if (source === "environment") return `environment variable${label ? `: ${label}` : ""}`;
	if (source === "runtime") return label || "runtime override";
	if (source === "fallback") return label || "custom provider config";
	if (source === "models_json_key" || source === "models_json_command") return label || "models.json";
	return "not connected";
}

// What Home can say about AI setup: no provider connected at all, one
// connected while the default for new rooms cannot run, or a new room could
// talk at once. The model status's providers decide when they are known. Before
// that (or when its read failed) the profiles can tell only that nothing is
// connected: a ready profile says nothing about whether the default can run,
// so "ready" waits for the model status. Null while unknown.
export type HomeAiReadiness = "no-model" | "default-unavailable" | "ready";
function homeAiProfileStatus(modelStatus: WebChatModelStatus | null, aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null): HomeAiReadiness | null {
	if (modelStatus?.providers) return !modelStatus.providers.some((provider) => provider.ready) ? "no-model" : modelStatus.ready ? "ready" : "default-unavailable";
	if (!aiProfileStatus) return null;
	if (aiProfileStatus.state.source === "default") return "no-model";
	return aiProfileStatus.profiles.some((profile) => profile.ready) ? null : "no-model";
}

// Registry rows spell a model as { provider, model, label }; the shared naming
// module takes { provider, model, modelLabel }. One adapter, so every surface
// here goes through the same canonical implementation instead of its own.
type RegistryModel = { label?: string; model: string; provider?: string };
function nameInput(model: RegistryModel) {
	return { model: model.model, modelLabel: model.label, provider: model.provider };
}
function registryModelTooltip(model: RegistryModel): string {
	return modelTooltipName(nameInput(model)) || model.model;
}

// A comma-separated model list where each name carries its provider on hover.
type CurrentModel = { name: string; provider: string | null };
const NO_CURRENT_MODEL: CurrentModel = { name: "", provider: null };

function ModelNameList({ models }: { models: RegistryModel[] }) {
	const names = distinctModelNames(models.map(nameInput));
	return (
		<>
			{models.map((model, index) => (
				<span key={`${model.provider ?? ""}/${model.model}/${index}`}>
					{index > 0 ? ", " : ""}
					<span title={registryModelTooltip(model)}>{names[index] || model.model}</span>
				</span>
			))}
		</>
	);
}

// A provider's models in product vocabulary: the ones its rooms may pick, and
// the connection. Which model runs memory work is the rooms' choice (the
// defaults above, or Room settings, Model), not the provider's.
// keySaved: the stored credential is a key, so it reads "key saved", as the row's subline does.
function AiProfileModelsDetail({ profile, keySaved }: { profile: PersistentAgentAiProfileStatus; keySaved: boolean }) {
	const roomModels = profile.processes?.persistentRoom.models ?? [];
	return (
		<div className="ai-profile-models" role="presentation">
			<div className="ai-profile-models-row"><span>Rooms</span><span>{roomModels.length > 0 ? <ModelNameList models={roomModels} /> : "no room models listed"}</span></div>
			<div className="ai-profile-models-row"><span>Connection</span><span>{profile.provider.configured ? `${keySaved ? "key saved" : "signed in"} · ${authSourceLabel(profile.provider.source, profile.provider.label)}` : "not signed in"}</span></div>
		</div>
	);
}

/** The profile row's management popover, rendered through a portal to <body>.
 *  The rows live inside scroll containers (the settings modal's content pane,
 *  the onboarding page) that clip an in-place absolute menu at the fold; the
 *  portal escapes every ancestor clip and containing-block trap (the modal
 *  backdrop's backdrop-filter would otherwise capture position:fixed). The
 *  menu hangs right-aligned under its anchor and flips above it when the
 *  viewport bottom would cut it; a ResizeObserver re-measures when the
 *  contents swap (the remove-confirm is taller than the item list). */
function AiProfileRowMenu({ anchorRef, onDismiss, children }: { anchorRef: React.RefObject<HTMLElement | null>; onDismiss: () => void; children: ReactNode }) {
	const menuRef = useRef<HTMLSpanElement>(null);
	const [pos, setPos] = useState<{ top: number | undefined; bottom: number | undefined; left: number } | null>(null);
	useLayoutEffect(() => {
		function measure() {
			const menu = menuRef.current;
			const anchor = anchorRef.current;
			if (!menu || !anchor) return;
			const rect = anchor.getBoundingClientRect();
			const height = menu.offsetHeight;
			const spaceBelow = window.innerHeight - rect.bottom - 12;
			const spaceAbove = rect.top - 12;
			const up = height > spaceBelow && spaceAbove > spaceBelow;
			const left = Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8));
			const next = up
				? { top: undefined, bottom: window.innerHeight - rect.top + 6, left }
				: { top: rect.bottom + 6, bottom: undefined, left };
			setPos((prev) => (prev && prev.top === next.top && prev.bottom === next.bottom && prev.left === next.left ? prev : next));
		}
		measure();
		// Content swaps (confirm state) change the height; window scrolls and
		// resizes move the anchor. The capture-phase scroll listener sees the
		// modal pane's scrolls too.
		const observer = new ResizeObserver(measure);
		if (menuRef.current) observer.observe(menuRef.current);
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
	}, [anchorRef]);
	return createPortal(
		<>
			<span className="ai-profile-menu-backdrop" onClick={onDismiss} />
			<span
				className="ai-profile-menu"
				role="menu"
				ref={menuRef}
				style={pos ? { top: pos.top, bottom: pos.bottom, left: pos.left } : { visibility: "hidden" }}
			>
				{children}
			</span>
		</>,
		document.body,
	);
}

function AiProfileSwitcherSection({ status, authStatus, onRefresh, onRefreshAuth, onSignedIn, focus, serviceBack }: { status: PersistentAgentAiProfileSelectionStatus | null; authStatus: AuthStatusResponse | null; onRefresh: () => void; onRefreshAuth: () => void; /** A sign-in or a key was just saved here. */ onSignedIn?: () => void; focus?: { providerId: string } | null; /** Counts the page's reconnects after an outage. */ serviceBack: number }) {
	// On a remote device the provider/gateway setup routes are local-only
	// (remote-route-policy is the truth), so those controls render as facts
	// with one honest line instead of failing per tap. On a shared server only
	// its admin may change them, so they read the same way for everyone else.
	// Provider sign-in and sign-out stay off there for the admin too: it holds
	// keys and gateways, never a person's own subscription.
	const remoteClient = useRemoteClientContext();
	const remoteSetupLocked = aiSetupLocked(remoteClient);
	const subscriptionsHidden = remoteClient.sharedServer;
	const [addProviderOpen, setAddProviderOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// A key saved without its service's check (it could not be reached): one plain line.
	const [keyNotice, setKeyNotice] = useState<string | null>(null);
	const [modelsOpenId, setModelsOpenId] = useState<string | null>(null);
	const [editProfile, setEditProfile] = useState<PersistentAgentAiProfileStatus | null>(null);
	// Opened to sign a provider in again (a room stopped on it): its row is
	// brought into view once the rows are there, once per request.
	const focusedRef = useRef<typeof focus>(null);
	useEffect(() => {
		if (!focus || focusedRef.current === focus || !status) return;
		const row = document.querySelector(`[data-provider-id="${CSS.escape(focus.providerId)}"]`);
		if (!row) return;
		focusedRef.current = focus;
		row.scrollIntoView({ block: "center" });
	}, [focus, status]);
	// Which gateway the modal is for: gateways are plural now, so "open" is not
	// enough to know whose base URL or model set is being edited.
	const [gatewayEdit, setGatewayEdit] = useState<{ id: string; label: string } | null>(null);
	const [gatewayApproveId, setGatewayApproveId] = useState<string | null>(null);
	const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
	// The trigger of the open menu, captured at click time: the portaled
	// popover positions itself off this element's live rect.
	const menuAnchorRef = useRef<HTMLElement | null>(null);
	const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
	const [removing, setRemoving] = useState(false);
	const [keyProfileId, setKeyProfileId] = useState<string | null>(null);
	// A re-read can take the admin's role away while a form is open: nothing stays open to be typed into.
	useEffect(() => {
		if (!remoteSetupLocked) return;
		setKeyProfileId(null);
		setAddProviderOpen(false);
		setGatewayEdit(null);
		setGatewayApproveId(null);
		setEditProfile(null);
		setMenuOpenId(null);
		setConfirmRemoveId(null);
	}, [remoteSetupLocked]);
	const [loginCatalog, setLoginCatalog] = useState<LoginProviderCatalogEntry[] | null>(null);

	// Refetched when the profile SET changes (not on every status refresh):
	// setting up a gateway or custom provider adds catalog entries the
	// auth-type lookup must know about. And when the service answers again
	// after an outage: a read that got no answer is asked again.
	const profileSetKey = status?.profiles.map((profile) => profile.id).join(",") ?? "";
	useEffect(() => {
		fetchJson<{ providers: LoginProviderCatalogEntry[] }>("/api/auth/providers")
			.then((result) => setLoginCatalog(result.providers))
			.catch(() => {});
	}, [profileSetKey, serviceBack]);

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
		onSignedIn?.();
	});
	// The service answers again after an outage: a line saying it could not be reached is no longer true.
	useEffect(() => {
		setError(withoutServiceLine);
		login.setError(withoutServiceLine);
	}, [serviceBack]);

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
		// On a shared server a provider that offers both is added with its key.
		if (entry && (!entry.authTypes.includes("oauth") || (subscriptionsHidden && entry.authTypes.includes("api_key")))) {
			setKeyProfileId(keyProfileId === profile.id ? null : profile.id);
			return;
		}
		await login.signIn(profile.provider.id);
	}

	async function saveApiKey(profile: PersistentAgentAiProfileStatus, key: string) {
		setError(null);
		setKeyNotice(null);
		const saved = await fetchJson<{ notice?: string }>("/api/auth/api-key", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: profile.provider.id, key }),
		});
		setKeyNotice(saved.notice ?? null);
		setKeyProfileId(null);
		onRefresh();
		onRefreshAuth();
		onSignedIn?.();
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

	function closeMenu() {
		setMenuOpenId(null);
		setConfirmRemoveId(null);
	}
	useEscapeKey(closeMenu, menuOpenId !== null);
	// A key row is a transient surface like the menu above it, and closes the
	// same way. Without this it could only be escaped by reloading the page.
	useEscapeKey(() => setKeyProfileId(null), keyProfileId !== null);
	// Removing a provider disconnects it: profile, approved models, and the
	// stored credential all go. Built-ins cannot be removed, only signed out.
	async function removeProfile(profile: PersistentAgentAiProfileStatus) {
		setRemoving(true);
		setError(null);
		try {
			// Removing one gateway leaves every other gateway's models and key alone.
			const url = profile.kind === "gateway"
				? `/api/persistent-agent-ai-profiles/gateways/${encodeURIComponent(profile.id)}`
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
	const emptyCard = (
		<div className="ai-profile-card">
			<p className="cli-note ai-profile-card-empty">Profile status is still loading.</p>
		</div>
	);
	return (
		<section className="ai-setup-section ai-profile-switcher-section" aria-label="AI setup">
			<PaneHeader
				title="AI setup"
				line="Your providers, and the models rooms use until they set their own."
				actions={!remoteSetupLocked && (
					<button className="rs-btn add-provider-toggle" type="button" aria-expanded={addProviderOpen} onClick={() => setAddProviderOpen((value) => !value)}>Add provider</button>
				)}
			/>
			<AiDefaultsGroup serviceBack={serviceBack} onSaved={onRefreshAuth} refreshKey={(status?.profiles ?? []).map((profile) => `${profile.id}:${profile.ready ? 1 : 0}:${[...profile.requiredModels, ...(profile.processes?.persistentRoom.models ?? [])].map((model) => `${model.provider}/${model.model}`).join("+")}`).join(",")} />
			<div className="settings-group">
			<GroupHeader kicker="Providers" />
			{status ? (
				status.profiles.length > 0 ? (
					<div className="ai-profile-card">
						<div className="ai-profile-rows">
							{status.profiles.map((profile) => {
								const roomModelCount = profile.processes?.persistentRoom.models.length ?? 0;
								const roomModelsLabel = `${roomModelCount} room model${roomModelCount === 1 ? "" : "s"}`;
								const signingIn = login.signingInProvider === profile.provider.id;
								// One quiet subline per row, describing the row's own state.
								// "Setup needed" is reserved for signed-in-but-still-broken.
								const signedInWithOAuth = authStatus?.providers.find((provider) => provider.id === profile.provider.id)?.signedInWithOAuth;
								const keyRefused = profile.provider.keyRefused !== undefined;
								// A sign-in the last call found gone reads as signed out, and its way on is Sign in, not Replace key.
								const signInGone = profile.provider.keyRefused === "signed-out";
								const subline = signingIn
									? "finish signing in in your browser…"
									: keyRefused
										? signInGone ? "signed out" : profile.provider.keyRefused === "no-workspace" ? "not accepted at the last try: key isn't tied to a workspace" : "not accepted at the last try"
										: profile.ready
										? signedInWithOAuth === false ? "key saved" : "signed in"
										: profile.provider.configured
											? "setup needed"
											// The models toggle beside the row already carries the count;
											// repeating it here read as a glitch, loudest on phones where
											// the toggle wraps directly under this line.
											: "signed out";
								const sublineWarn = !signingIn && profile.provider.configured && (!profile.ready || keyRefused);
								const modelsOpen = modelsOpenId === profile.id;
								return (
									<div key={profile.id} data-provider-id={profile.provider.id} className={`ai-profile-row-group${modelsOpen ? " open" : ""}${keyProfileId === profile.id ? " key-open" : ""}`}>
										<div className={`ai-profile-row${profile.ready && !keyRefused ? "" : " notready"}`}>
											<span className="ai-profile-main">
												<span className="ai-profile-text">
													<span className="ai-profile-name">{profile.label}</span>
													<span className={`ai-profile-sub sub-default${sublineWarn ? " warn" : ""}`}>{subline}</span>
												</span>
											</span>
											<span className="ai-profile-side">
												{roomModelCount > 0 && (
													<button
														className="ai-profile-models-toggle"
														aria-expanded={modelsOpen}
														title="Show or hide this profile's models"
														onClick={() => setModelsOpenId(modelsOpen ? null : profile.id)}
													>
														{roomModelsLabel} <span className="disclosure-chevron" aria-hidden="true" />
													</button>
												)}
												{signingIn ? (
													<button className="ai-profile-foot-link" onClick={() => void login.cancel()} title="Stop this sign-in attempt">Cancel</button>
												) : (
													<>
														{/* The key row carries its own Cancel now, for every row rather
														    than only the not-ready ones, so this offers the way IN and the
														    form offers the way out. */}
														{keyRefused && !signInGone && keyProfileId !== profile.id && !remoteSetupLocked && (
															<button className="rs-btn ai-profile-signin" onClick={() => profile.kind === "gateway" ? setGatewayEdit({ id: profile.id, label: profile.label }) : setKeyProfileId(profile.id)}>Replace key</button>
														)}
														{((!profile.ready && !keyRefused) || signInGone) && keyProfileId !== profile.id && !remoteSetupLocked && !(subscriptionsHidden && !providerAcceptsApiKey(profile.provider.id)) && (
															<button className="rs-btn ai-profile-signin" disabled={login.signingInProvider !== null} onClick={() => void signIn(profile)}>
																{providerUsesOAuth(profile.provider.id) && !subscriptionsHidden ? "Sign in" : "Add API key"}
															</button>
														)}
														{/* Management stays reachable in every state — broken (expired
														    token, missing model) AND fully signed out. A signed-out custom
														    profile must still offer Remove, or the row becomes a dead end;
														    items that need a credential gate themselves below. */}
													{!remoteSetupLocked && <span className="ai-profile-menu-anchor">
														<button
															className="ai-profile-menu-btn"
															aria-haspopup="menu"
															aria-expanded={menuOpenId === profile.id}
															aria-label={`Manage ${profile.label}`}
															title={`Manage ${profile.label}: models, keys, sign-out`}
															onClick={(e) => { if (menuOpenId === profile.id) { closeMenu(); } else { menuAnchorRef.current = e.currentTarget; setMenuOpenId(profile.id); setConfirmRemoveId(null); setKeyProfileId(null); } }}
														>···</button>
														{menuOpenId === profile.id && (
															<AiProfileRowMenu anchorRef={menuAnchorRef} onDismiss={closeMenu}>
																{confirmRemoveId === profile.id ? (
																	<>
																		<span className="ai-profile-menu-confirm">Remove {profile.label}? This {profile.provider.configured ? "signs out and deletes" : "deletes"} its models.</span>
																		<button className="ai-profile-menu-item danger" role="menuitem" disabled={removing} onClick={() => void removeProfile(profile)}>{removing ? "Removing…" : "Remove"}</button>
																		<button className="ai-profile-menu-item" role="menuitem" disabled={removing} onClick={() => setConfirmRemoveId(null)} title="Cancel — keep this profile">Keep it</button>
																	</>
																) : (
																	<>
																		{/* A toggle, not an opener: a 0-room-model profile renders no
																		    "N room models" collapse control, so without the Hide branch
																		    the opened panel would be uncloseable. */}
																		<button className="ai-profile-menu-item" role="menuitem" onClick={() => { setModelsOpenId(modelsOpen ? null : profile.id); closeMenu(); }}>{modelsOpen ? "Hide models" : "View models"}</button>
																		{profile.kind === "custom" && (
																			<button className="ai-profile-menu-item" role="menuitem" onClick={() => { setEditProfile(profile); closeMenu(); }} title="Choose which models rooms may use">Approve models</button>
																		)}
																		{profile.kind === "gateway" && (
																			<>
																				{/* Approve models edits the model set only; Edit gateway
																				    owns the base URL and API key. */}
																				<button className="ai-profile-menu-item" role="menuitem" onClick={() => { setGatewayApproveId(profile.id); closeMenu(); }} title="Choose which models rooms may use">Approve models</button>
																				<button className="ai-profile-menu-item" role="menuitem" onClick={() => { setGatewayEdit({ id: profile.id, label: profile.label }); closeMenu(); }} title="Change the gateway URL or API key">Edit gateway</button>
																			</>
																		)}
																		{/* A subscription sign-in is renewed by signing in again; only a
																		    key is replaced. Switching a subscription row to a key is Sign
																		    out, then Add key. */}
																		{profile.provider.configured && authStatus?.providers.find((provider) => provider.id === profile.provider.id)?.signedInWithOAuth ? (
																			!subscriptionsHidden && <button className="ai-profile-menu-item" role="menuitem" onClick={() => { closeMenu(); void signIn(profile); }}>Sign in again</button>
																		) : providerAcceptsApiKey(profile.provider.id) && profile.provider.configured && (
																			<button className="ai-profile-menu-item" role="menuitem" onClick={() => { setKeyProfileId(profile.id); closeMenu(); }}>Replace API key</button>
																		)}
																		{/* No credential stored → nothing to sign out of. */}
																		{profile.provider.configured && !subscriptionsHidden && (
																			<button className="ai-profile-menu-item" role="menuitem" onClick={() => { closeMenu(); void signOut(profile); }}>Sign out</button>
																		)}
																		{profile.kind !== "builtin" && (
																			<button className="ai-profile-menu-item danger" role="menuitem" onClick={() => setConfirmRemoveId(profile.id)}>
																				{profile.kind === "gateway" ? "Remove gateway…" : "Remove provider…"}
																			</button>
																		)}
																	</>
																)}
															</AiProfileRowMenu>
														)}
													</span>}
													</>
												)}
											</span>
										</div>
										{signingIn && login.instructions && (
											<div className="add-provider-instructions ai-profile-signin-instructions">{login.instructions}</div>
										)}
										{keyProfileId === profile.id && (
											<ApiKeyForm className="ai-profile-key-form" providerName={profile.label} onSave={(key) => saveApiKey(profile, key)} onCancel={() => setKeyProfileId(null)} />
										)}
										{modelsOpen && <AiProfileModelsDetail profile={profile} keySaved={signedInWithOAuth === false} />}
									</div>
								);
							})}
						</div>
					</div>
				) : (
					emptyCard
				)
			) : (
				emptyCard
			)}
			</div>
			{/* The providers to add open under the list (the header's Add
			    provider button). One key form at a time across the whole page:
			    the panel closes the row form when it opens its own, and closes
			    its own when a row opens one. The signature is how the panel
			    learns this list moved: removing a gateway profile here deletes
			    the gateway the panel lists below, and a renamed one would keep
			    its old name there. A string rather than the status object, so a
			    refetch that changed nothing costs no fetch. */}
			{remoteSetupLocked ? (
				<>
					<p className="cli-note">{remoteClient.sharedServer ? SHARED_SERVER_ADMIN_LINE : "Providers and gateways are set up on the computer itself."}</p>
					{remoteClient.sharedServer && <p className="cli-note">{NEW_ADMIN_HINT}</p>}
				</>
			) : (
				<AddProviderPanel
					open={addProviderOpen}
					onOpenChange={setAddProviderOpen}
					onProfilesChanged={() => { onRefresh(); onRefreshAuth(); }}
					onKeyFormOpen={() => setKeyProfileId(null)}
					keyFormBlocked={keyProfileId !== null}
					profilesSignature={(status?.profiles ?? []).map((profile) => `${profile.id}:${profile.label}`).join("|")}
					serviceBack={serviceBack}
				/>
			)}
			{status?.state.message && <p className="cli-note">{status.state.message}</p>}
			{status?.customProfiles?.errors?.map((message) => <p key={message} className="cli-note">{message}</p>)}
			{(error ?? login.error) && <div className="checkpoint-proposal-error" role="alert">{error ?? login.error}</div>}
			{keyNotice && !(error ?? login.error) && <p className="settings-help" role="status">{keyNotice}</p>}
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
			{gatewayEdit && (
				<GatewayConfigModal
					gatewayId={gatewayEdit.id}
					knownLabel={gatewayEdit.label}
					onClose={() => setGatewayEdit(null)}
					onSaved={() => { onRefresh(); onRefreshAuth(); }}
				/>
			)}
			{gatewayApproveId && (
				<GatewayApproveModelsModal
					gatewayId={gatewayApproveId}
					onClose={() => setGatewayApproveId(null)}
					onSaved={() => { onRefresh(); onRefreshAuth(); }}
				/>
			)}
		</section>
	);
}

export { AiProfileSwitcherSection, NO_CURRENT_MODEL, homeAiProfileStatus, nameInput };
export type { CurrentModel, RegistryModel };
