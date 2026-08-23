import { useEffect, useState } from "react";
import { apiFetch, fetchJson } from "../api";

/**
 * Data profiles: which ~/.exxperts state tree this computer runs — rooms,
 * agents, history, wallet, memory, all of it. One person's private setup and
 * a curated demo can live side by side and never touch each other.
 *
 * Switching is deliberately heavy: the server exits and the launcher (or the
 * desktop shell) swaps the directories while nothing has them open, then
 * starts the server again on the other tree. So the switch button asks twice,
 * and once the POST is away this pane goes terminal — the tab it lives in is
 * about to lose its session, because the sign-in token belongs to the profile.
 *
 * A failed network reply on that one POST is not an error: the server may be
 * gone before the answer flushes, and gone is exactly what was asked for.
 * Only a refusal the server itself sent (a 409 with its reason) renders as one.
 *
 * Deleting asks twice like the rooms' danger zone does. The standard profile
 * IS ~/.exxperts — it has no name, never moves, and can never be deleted:
 * it is not addressable by the delete route at all.
 */

/** active null = the standard ~/.exxperts profile; profiles excludes it. */
type StateProfilePayload = { active: string | null; profiles: Array<{ name: string }> };

/** One armed action at a time; name null addresses the standard profile. */
type Armed = { kind: "switch" | "delete"; name: string | null } | null;

export function StateProfileSection() {
	const [payload, setPayload] = useState<StateProfilePayload | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [armed, setArmed] = useState<Armed>(null);
	/** Terminal: the switch is running; this page follows it into the new profile. */
	const [restarting, setRestarting] = useState<{ name: string | null; signInPath: string | null } | null>(null);
	const [busy, setBusy] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [creating, setCreating] = useState(false);

	async function load() {
		setLoading(true);
		setLoadError(null);
		try {
			// Status-checked by hand: an older server 404s here with a body
			// whose error text ("Not Found") says nothing useful.
			const res = await apiFetch("/api/settings/state-profile");
			if (res.status === 404) {
				setLoadError("This server does not offer profiles yet. Update it to switch profiles from here.");
				return;
			}
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setLoadError(body?.error ?? `Request failed (${res.status})`);
				return;
			}
			setPayload(await res.json() as StateProfilePayload);
		} catch (e) {
			setLoadError((e as Error).message);
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => { void load(); }, []);

	// Follow the restart: wait for the server to go down, then come back, then
	// walk this page into the new profile's session. The sign-in link came
	// with the switch reply (the new token was minted before the restart).
	useEffect(() => {
		if (!restarting) return;
		// The app's own background calls hit the new server with the stale
		// cookie, 401, and would race redirectToSignInOn401's assign("/") past
		// this page's own navigation. Holding its throttle guard (api.ts) for
		// the whole wait keeps this effect the only navigator.
		const holdRedirectGuard = () => {
			try {
				sessionStorage.setItem("exxperts-auth-redirect", String(Date.now()));
			} catch {
				// Without sessionStorage the guard cannot be held; the sign-in
				// still succeeds when this page's navigation wins the race.
			}
		};
		holdRedirectGuard();
		// Two independent "the new server is up" signals: an observed
		// down-then-up transition, or this page's cookie suddenly answering
		// 401 (the token rotated with the profile) — the second catches a
		// restart so fast the 1s poll never saw the gap.
		let wentDown = false;
		const timer = window.setInterval(() => {
			holdRedirectGuard();
			void (async () => {
				try {
					const res = await fetch("/api/settings/state-profile", { signal: AbortSignal.timeout(1500) });
					if (res.status === 401 || (wentDown && res.ok)) {
						window.clearInterval(timer);
						location.assign(restarting.signInPath ?? "/");
					} else if (!res.ok) {
						// A dev proxy (Vite) answers 5xx for a dead backend
						// instead of failing the fetch.
						wentDown = true;
					}
				} catch {
					wentDown = true;
				}
			})();
		}, 500);
		return () => window.clearInterval(timer);
	}, [restarting]);

	async function create() {
		setCreating(true);
		setCreateError(null);
		try {
			setPayload(await fetchJson<StateProfilePayload>("/api/settings/state-profile/create", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: draft.trim() }),
			}));
			setDraft("");
		} catch (e) {
			setCreateError((e as Error).message);
		} finally {
			setCreating(false);
		}
	}

	function arm(kind: "switch" | "delete", name: string | null): boolean {
		if (armed?.kind === kind && armed.name === name) return true;
		setArmed({ kind, name });
		setListError(null);
		return false;
	}

	async function switchTo(name: string | null) {
		if (!arm("switch", name)) return;
		setBusy(true);
		setListError(null);
		try {
			const reply = await fetchJson<{ signInPath?: string }>("/api/settings/state-profile/switch", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name }),
			});
			setRestarting({ name, signInPath: reply.signInPath ?? null });
		} catch (e) {
			// fetch itself failing means the server dropped the connection while
			// going down — the restart is happening. Anything else is the server
			// refusing, with its reason in the message.
			if (e instanceof TypeError) setRestarting({ name, signInPath: null });
			else {
				setListError((e as Error).message);
				setArmed(null);
			}
		} finally {
			setBusy(false);
		}
	}

	async function deleteProfile(name: string) {
		if (!arm("delete", name)) return;
		setBusy(true);
		setListError(null);
		try {
			setPayload(await fetchJson<StateProfilePayload>("/api/settings/state-profile/delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name }),
			}));
		} catch (e) {
			setListError((e as Error).message);
		} finally {
			setArmed(null);
			setBusy(false);
		}
	}

	if (restarting) {
		return (
			<section className="ai-setup-section state-profiles" aria-label="Profiles">
				<p className="ai-setup-copy" role="status">
					Restarting with profile “{restarting.name ?? ".exxperts"}”… This page reconnects and signs in by itself when the app is back.
				</p>
				{restarting.signInPath && (
					<p className="ai-setup-copy">
						If nothing happens within a minute, <a href={restarting.signInPath}>open the new session manually</a>.
					</p>
				)}
			</section>
		);
	}

	if (loading) {
		return (
			<section className="ai-setup-section state-profiles" aria-label="Profiles">
				<p className="ai-setup-copy" role="status">Reading the loaded profile…</p>
			</section>
		);
	}

	if (loadError || !payload) {
		return (
			<section className="ai-setup-section state-profiles" aria-label="Profiles">
				<div className="workspaces-error archived-rooms-note" role="alert">{loadError ?? "Could not read the profiles."}</div>
				<p><button className="inline-action" type="button" onClick={() => void load()}>Try again</button></p>
			</section>
		);
	}

	return (
		<>
			<section className="ai-setup-section state-profiles" aria-label="Loaded profile">
				<p className="ai-setup-copy">
					A profile is everything this computer's exxperts holds: rooms, agents, history, wallet, memory. Only one is
					loaded at a time; the others wait untouched in your home folder as “.exxperts-name”.
				</p>
				<div className="rs-row">
					<div className="rs-row-main">
						<span className="rs-row-label">{payload.active ?? ".exxperts"}</span>
						<span className="rs-row-hint">The loaded profile — everything you see in the app right now lives here.</span>
					</div>
					<span className="rs-row-hint">Current</span>
				</div>
			</section>
			<section className="ai-setup-section state-profiles" aria-label="Create a new profile">
				<h3 className="web-search-fallback-heading">Create a new profile</h3>
				<div className="rs-row">
					<div className="rs-row-main">
						<span className="rs-row-hint">Starts empty, like a fresh install. Nothing is copied from the loaded profile.</span>
					</div>
					<div className="rs-pane-actions">
						<input
							className="launcher-path-input"
							type="text"
							value={draft}
							placeholder="demo"
							disabled={creating}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) void create(); }}
							aria-label="New profile name"
						/>
						<button className="rs-btn" type="button" disabled={creating || !draft.trim()} onClick={() => void create()}>
							{creating ? "Creating…" : "Create"}
						</button>
					</div>
				</div>
				{createError && <div className="workspaces-error archived-rooms-note" role="alert">{createError}</div>}
			</section>
			{(payload.profiles.length > 0 || payload.active !== null) && (
				<section className="ai-setup-section state-profiles" aria-label="Other profiles on this computer">
					<h3 className="web-search-fallback-heading">Other profiles on this computer</h3>
					<p className="ai-setup-copy">
						Switching restarts exxperts and opens a newly signed-in tab — running work stops, nothing is lost. Deleting
						removes a profile and everything in it from this machine.
					</p>
					{payload.active !== null && (
						<div className="rs-row">
							<div className="rs-row-main">
								<span className="rs-row-label">.exxperts</span>
								<span className="rs-row-hint">Your standard profile. It never moves and cannot be deleted.</span>
								{armed?.kind === "switch" && armed.name === null && (
									<span className="rs-row-hint room-danger-armed" role="alert">Switch back to “.exxperts” and restart now?</span>
								)}
							</div>
							<div className="rs-pane-actions">
								{armed?.kind === "switch" && armed.name === null && (
									<button className="rs-quiet" type="button" disabled={busy} onClick={() => setArmed(null)}>Keep it</button>
								)}
								<button className="rs-btn" type="button" disabled={busy} onClick={() => void switchTo(null)}>
									{busy && armed?.kind === "switch" && armed.name === null ? "Switching…" : armed?.kind === "switch" && armed.name === null ? "Switch and restart" : "Switch"}
								</button>
							</div>
						</div>
					)}
					{payload.profiles.map((profile) => {
						const switchArmed = armed?.kind === "switch" && armed.name === profile.name;
						const deleteArmed = armed?.kind === "delete" && armed.name === profile.name;
						return (
							<div className="rs-row" key={profile.name}>
								<div className="rs-row-main">
									<span className="rs-row-label">{profile.name}</span>
									{switchArmed && (
										<span className="rs-row-hint room-danger-armed" role="alert">Switch to “{profile.name}” and restart now?</span>
									)}
									{deleteArmed && (
										<span className="rs-row-hint room-danger-armed" role="alert">
											Delete “{profile.name}” forever? Everything in it is removed from this machine.
										</span>
									)}
								</div>
								<div className="rs-pane-actions">
									{(switchArmed || deleteArmed) && (
										<button className="rs-quiet" type="button" disabled={busy} onClick={() => setArmed(null)}>Keep it</button>
									)}
									{!deleteArmed && (
										<button className="rs-btn" type="button" disabled={busy} onClick={() => void switchTo(profile.name)}>
											{busy && switchArmed ? "Switching…" : switchArmed ? "Switch and restart" : "Switch"}
										</button>
									)}
									{!switchArmed && (
										<button className="rs-btn rs-btn-danger" type="button" disabled={busy} onClick={() => void deleteProfile(profile.name)}>
											{busy && deleteArmed ? "Deleting…" : deleteArmed ? "Delete forever" : "Delete"}
										</button>
									)}
								</div>
							</div>
						);
					})}
					{listError && <div className="workspaces-error archived-rooms-note" role="alert">{listError}</div>}
				</section>
			)}
		</>
	);
}
