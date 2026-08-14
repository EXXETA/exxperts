import { useEffect, useRef, useState } from "react";
import { fetchJson } from "../api";

/**
 * Web search, made visible: both kinds of it.
 *
 * The app's own search has always been configurable and never been findable, a
 * JSON file in the user data dir written by a terminal command with nothing
 * anywhere admitting the choice existed. And provider search, where the model
 * looks things up on its own side while it answers, needs a way to be turned
 * off for the deployments that require every search to happen on their own
 * infrastructure.
 *
 * So the section reads top to bottom in the order the decisions actually
 * matter: first whether the two subscription profiles search for themselves,
 * then what everything else falls back to.
 *
 * Nothing here moves until the server says it moved. A control that jumps on
 * click and quietly stays jumped when the save fails is a control that lies
 * about the state of the machine, and this pane exists precisely because
 * settings that lie about the machine are the thing being fixed. So every
 * control shows a pending state while its save is in flight and takes its
 * value from the server's answer.
 */

type WebSearchProvider = "duckduckgo" | "searxng" | "disabled";

type WebSearchSettingsPayload = {
	provider: WebSearchProvider;
	baseUrl: string;
	source: "environment" | "settings" | "default";
	providerSearch: boolean;
	saved: { provider: WebSearchProvider | null; baseUrl: string };
	envProvider: string | null;
	unreadable: string | null;
};

const OPTIONS: Array<{ id: WebSearchProvider; label: string; blurb: (providerSearchOn: boolean) => string }> = [
	{
		id: "duckduckgo",
		label: "DuckDuckGo",
		blurb: () => "Works straight away, nothing to install. On some networks DuckDuckGo refuses automated searches; when that happens the room says so instead of guessing.",
	},
	{
		id: "searxng",
		label: "Your own SearXNG",
		blurb: () => "A search instance you run yourself. Steadier under heavy use and nothing leaves for a search engine under your name.",
	},
	{
		id: "disabled",
		label: "Off",
		// "No web search at all" would be false in both branches, and this is the
		// one option somebody picks for a reason they care about. The switch above
		// keeps the two subscriptions searching, and a gateway model ticked for web
		// search carries that on the model itself, past anything chosen here.
		blurb: (providerSearchOn) =>
			providerSearchOn
				? "No search through the app's own machinery. Claude and ChatGPT rooms still search through the provider while the switch above is on, and gateway models still search where you ticked it. Rooms can still open a page you give them a link to."
				: "No search through the app's own machinery. Gateway models still search where you ticked web search for them. Rooms can still open a page you give them a link to.",
	},
];

type SearxngSetupPhase =
	| "idle"
	| "checking-docker"
	| "docker-missing"
	| "docker-stopped"
	| "pulling-image"
	| "starting"
	| "ready"
	| "error";

type SearxngSetupStatus = {
	phase: SearxngSetupPhase;
	baseUrl: string | null;
	message: string | null;
	running: boolean;
};

/**
 * What the screen says while the engine is being started. The wait is long
 * enough that silence reads as a hang, so every phase says something, and none
 * of it asks anybody to open a terminal.
 */
function setupLine(status: SearxngSetupStatus): string | null {
	switch (status.phase) {
		case "checking-docker":
		case "starting":
		case "pulling-image":
			return "Getting the search engine ready. The first time can take a few minutes.";
		case "docker-missing":
			return "This needs Docker Desktop or OrbStack installed first.";
		case "docker-stopped":
			return "Docker is installed but not running. Start it, then try again.";
		case "ready":
			return "Running.";
		case "error":
			return status.message ?? "The search engine could not be started.";
		default:
			return null;
	}
}

/** Which control is mid-save, so only that one shows as busy. */
type Pending = null | { kind: "providerSearch"; value: boolean } | { kind: "provider"; value: WebSearchProvider } | { kind: "baseUrl" };

export function WebSearchSettingsSection() {
	const [settings, setSettings] = useState<WebSearchSettingsPayload | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState<Pending>(null);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	/** The address as typed. Only meaningful once somebody has touched it. */
	const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);
	/** A radio choice made but not yet saved, which only SearXNG can be in. */
	const [pendingChoice, setPendingChoice] = useState<WebSearchProvider | null>(null);
	// A save landing while somebody is mid-edit must not reach in and retype
	// their field for them. The draft survives every answer except its own.
	const baseUrlDirty = useRef(false);
	/** The local-engine run, when there is or was one. */
	const [setup, setSetup] = useState<SearxngSetupStatus | null>(null);
	const [setupStarting, setSetupStarting] = useState(false);
	// A finished run must fill the address in once, not on every poll that still
	// reports the same success.
	const adoptedBaseUrl = useRef<string | null>(null);

	function adopt(payload: WebSearchSettingsPayload, clearDraft: boolean) {
		setSettings(payload);
		if (clearDraft || !baseUrlDirty.current) {
			setBaseUrlDraft(null);
			baseUrlDirty.current = false;
		}
	}

	async function load() {
		setLoading(true);
		setLoadError(null);
		try {
			adopt(await fetchJson<WebSearchSettingsPayload>("/api/settings/web-search"), true);
			setPendingChoice(null);
		} catch (e) {
			const message = (e as Error).message;
			// An older server has no such endpoint. Saying so beats a bare 404,
			// which reads as a broken app rather than an app that predates this.
			setLoadError(/\(404\)/.test(message) ? "This server does not offer web search settings yet. Update it to change these from here." : message);
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => { void load(); }, []);

	// The form always edits the SAVED settings, never the resolved ones. An
	// environment variable can decide what actually runs, but writing its value
	// back into the file would persist a choice nobody made, and would erase the
	// setting waiting underneath for the day the variable goes away.
	const savedProvider = settings?.saved.provider ?? "duckduckgo";
	const savedBaseUrl = settings?.saved.baseUrl ?? "";
	const shownChoice = pendingChoice ?? savedProvider;
	const shownBaseUrl = baseUrlDraft ?? savedBaseUrl;
	const envHeld = settings?.source === "environment";

	async function put(body: Record<string, unknown>, kind: Pending, savedNote: string) {
		setPending(kind);
		setError(null);
		setNote(null);
		try {
			const payload = await fetchJson<WebSearchSettingsPayload>("/api/settings/web-search", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			adopt(payload, kind?.kind === "baseUrl" || kind?.kind === "provider");
			setPendingChoice(null);
			setNote(savedNote);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setPending(null);
		}
	}

	function saveProvider(next: WebSearchProvider) {
		return put(
			// The address rides along only when it is the thing being chosen.
			next === "searxng" ? { provider: next, baseUrl: shownBaseUrl } : { provider: next },
			{ kind: "provider", value: next },
			envHeld
				? "Saved. The forced setting on this computer still decides what runs until it is removed."
				: "Saved. The next search uses it.",
		);
	}

	// Polled only while something is actually happening. A run started before
	// this screen was opened is picked up the same way, so reloading mid-pull
	// does not lose sight of it.
	const setupRunning = setup?.running ?? false;
	useEffect(() => {
		if (shownChoice !== "searxng") return;
		let stopped = false;
		async function read() {
			try {
				const next = await fetchJson<SearxngSetupStatus>("/api/web-search/searxng/setup");
				if (!stopped) setSetup(next);
			} catch {
				// An older server has no such endpoint. The button says so when it
				// is pressed; there is nothing to report from a poll.
			}
		}
		void read();
		if (!setupRunning) return;
		const timer = window.setInterval(() => void read(), 2000);
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [shownChoice, setupRunning]);

	// A ready engine is only useful once the address is saved, so the flow
	// finishes itself through the same save path the field uses.
	useEffect(() => {
		const url = setup?.phase === "ready" ? setup.baseUrl : null;
		if (!url || adoptedBaseUrl.current === url) return;
		adoptedBaseUrl.current = url;
		if (savedProvider === "searxng" && savedBaseUrl === url) return;
		baseUrlDirty.current = false;
		setBaseUrlDraft(url);
		void put(
			{ provider: "searxng", baseUrl: url },
			{ kind: "provider", value: "searxng" },
			"Saved. The next search uses it.",
		);
	}, [setup?.phase, setup?.baseUrl]);

	async function startSetup() {
		setSetupStarting(true);
		setError(null);
		setNote(null);
		try {
			adoptedBaseUrl.current = null;
			setSetup(await fetchJson<SearxngSetupStatus>("/api/web-search/searxng/setup", { method: "POST" }));
		} catch (e) {
			const message = (e as Error).message;
			setSetup({
				phase: "error",
				baseUrl: null,
				message: /\(404\)/.test(message) ? "This server cannot start a search engine for you yet. Update it, or enter the address of one you already run." : message,
				running: false,
			});
		} finally {
			setSetupStarting(false);
		}
	}

	function saveProviderSearch(next: boolean) {
		return put(
			{ providerSearch: next },
			{ kind: "providerSearch", value: next },
			next
				? "Saved. Claude and ChatGPT rooms search on their own side from the next message."
				: "Saved. Claude and ChatGPT rooms use the search below from the next message.",
		);
	}

	if (loading) {
		return (
			<section className="ai-setup-section" aria-label="Web search">
				<div className="ai-setup-section-heading"><h2>Web search</h2></div>
				<p className="ai-setup-copy" role="status">Reading the current setting…</p>
			</section>
		);
	}

	// Never draw invented defaults. An unreachable server is not a machine that
	// searches with DuckDuckGo and provider search on; it is a machine we know
	// nothing about, and saying so is the only honest thing on offer.
	if (loadError || !settings) {
		return (
			<section className="ai-setup-section" aria-label="Web search">
				<div className="ai-setup-section-heading"><h2>Web search</h2></div>
				<div className="workspaces-error archived-rooms-note" role="alert">{loadError ?? "Could not read the web search settings."}</div>
				<p><button className="inline-action" type="button" onClick={() => void load()}>Try again</button></p>
			</section>
		);
	}

	const providerSearchOn = settings.providerSearch;
	const setupMessage = setup ? setupLine(setup) : null;
	const setupFailed = setup ? setup.phase === "error" || setup.phase === "docker-missing" || setup.phase === "docker-stopped" : false;
	const togglePending = pending?.kind === "providerSearch";
	const baseUrlPending = pending?.kind === "baseUrl" || (pending?.kind === "provider" && pending.value === "searxng");

	return (
		<section className="ai-setup-section" aria-label="Web search">
			<div className="ai-setup-section-heading">
				<h2>Web search</h2>
			</div>
			<p className="ai-setup-copy">
				How your exxperts search the web when they need something current. Changes apply from the next message, no restart.
			</p>

			{settings.unreadable && (
				<div className="workspaces-error archived-rooms-note" role="alert">
					The saved settings file {settings.unreadable}, so none of it is in force: provider search is off and the app is
					falling back to DuckDuckGo. Repair or delete it to change anything here.
				</div>
			)}

			<div className="web-search-native">
				<label className={`web-search-native-toggle${togglePending ? " pending" : ""}`}>
					<input
						type="checkbox"
						checked={providerSearchOn}
						disabled={pending !== null || !!settings.unreadable}
						onChange={(e) => void saveProviderSearch(e.target.checked)}
					/>
					<span className="web-search-option-body">
						<span className="web-search-option-label">
							Use provider search where available{togglePending ? " (saving…)" : ""}
						</span>
						<span className="web-search-option-blurb">
							Rooms on the Claude and ChatGPT subscriptions search through the provider itself, so nothing runs on your
							machine. Gateway models search on their own only where you ticked web search for them, which this switch
							does not change.
						</span>
					</span>
				</label>
			</div>

			<div className="web-search-fallback">
				<h3 className="web-search-fallback-heading">Everything else</h3>
				<p className="ai-setup-copy web-search-fallback-copy">
					{providerSearchOn
						? "The search every room uses except Claude and ChatGPT. Gateway models use it alongside their own."
						: "The search every room uses, including Claude and ChatGPT while the switch above is off."}
				</p>
				{envHeld && (
					<p className="ai-setup-copy web-search-env-note" role="status">
						This computer is set up to force {settings.provider === "disabled" ? "no search backend at all" : settings.provider},
						and that setting wins over this screen. The choice below is saved and takes over the moment the forced one is
						removed. It does not affect provider search above.
					</p>
				)}
			</div>
			<div className="web-search-options" role="radiogroup" aria-label="Web search provider">
				{OPTIONS.map((option) => {
					const optionPending = pending?.kind === "provider" && pending.value === option.id;
					const unsaved = pendingChoice === option.id && savedProvider !== option.id;
					return (
						<label key={option.id} className={`web-search-option${shownChoice === option.id ? " selected" : ""}${optionPending ? " pending" : ""}`}>
							<input
								type="radio"
								name="web-search-provider"
								checked={shownChoice === option.id}
								disabled={pending !== null || !!settings.unreadable}
								onChange={() => {
									setNote(null);
									setError(null);
									// SearXNG needs an address before it means anything, so it
									// waits for Save and says so; the other two are the whole
									// decision, and the radio only moves when the server agrees.
									if (option.id === "searxng") setPendingChoice("searxng");
									else void saveProvider(option.id);
								}}
							/>
							<span className="web-search-option-body">
								<span className="web-search-option-label">
									{option.label}
									{optionPending && <span className="web-search-pending-note"> saving…</span>}
									{unsaved && !optionPending && <span className="web-search-pending-note"> not saved yet</span>}
								</span>
								<span className="web-search-option-blurb">{option.blurb(providerSearchOn)}</span>
							</span>
						</label>
					);
				})}
			</div>
			{shownChoice === "searxng" && (
				<div className="web-search-searxng">
					<label className="web-search-searxng-label" htmlFor="web-search-base-url">Address</label>
					<input
						id="web-search-base-url"
						className="launcher-path-input"
						type="text"
						value={shownBaseUrl}
						placeholder="http://localhost:8080"
						disabled={baseUrlPending}
						onChange={(e) => { baseUrlDirty.current = true; setBaseUrlDraft(e.target.value); setNote(null); }}
					/>
					<button className="inline-action" type="button" disabled={pending !== null} onClick={() => void saveProvider("searxng")}>
						{baseUrlPending ? "Saving…" : "Save"}
					</button>
					{/* The other half of the choice: an address somebody already has, or
					    one this app makes for them. Nothing here asks for a terminal. */}
					<div className="web-search-searxng-setup">
						<button
							className="inline-action"
							type="button"
							disabled={setupStarting || setupRunning || !!settings.unreadable}
							onClick={() => void startSetup()}
						>
							{setupRunning || setupStarting ? "Starting…" : "Start one on this computer"}
						</button>
						{setupMessage && (
							<span className={`web-search-searxng-status${setupFailed ? " failed" : ""}`} role="status">{setupMessage}</span>
						)}
					</div>
				</div>
			)}
			{note && <p className="archived-rooms-note" role="status">{note}</p>}
			{error && <div className="workspaces-error archived-rooms-note" role="alert">{error}</div>}
		</section>
	);
}
