import { useEffect, useRef, useState } from "react";
import { fetchPersistentRoomBashSettings, updatePersistentRoomBashSettings } from "../persistent-room-management-api";
import { useRemoteClientContext } from "../remote-client-context";
import type { PersistentAgentId } from "../types";

/**
 * The chat header's bash-mode chip: visible only in rooms whose workspace
 * policy has Bash enabled, it names the one fact worth glancing at up here —
 * whether commands run only after an approval card ("Bash: asks") or without
 * asking ("Bash: auto"). Clicking it opens a two-option menu that applies the
 * choice immediately (product decision: no confirmation step in either
 * direction), through the same endpoint the Room Settings toggle uses.
 *
 * Staleness: the chip refetches on agentId change and whenever the settings
 * modal closes (the `settingsOpen` prop is the cheap hook App already holds —
 * the Room Settings workspace section can flip the same stored value). It
 * also refetches on menu OPEN, because that is the moment a stale answer
 * would misdirect a click.
 *
 * A failed load quietly shows "asks" — the fail-closed truth, matching the
 * approval guard's own default when nothing is stored.
 *
 * On a remote client the chip still tells the truth, but the options are
 * disabled: the PUT is loopback-only on the server, so offering the switch
 * would only manufacture an error.
 */
export function BashModeChip({ agentId, bashEnabled, settingsOpen = false }: {
	agentId: PersistentAgentId;
	bashEnabled: boolean;
	settingsOpen?: boolean;
}) {
	const [autoApprove, setAutoApprove] = useState(false);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [refetchTick, setRefetchTick] = useState(0);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const remoteClient = useRemoteClientContext();

	// Load the stored mode. Reruns when the room changes, when a refetch is
	// requested (menu open, settings-modal close), and only while the chip is
	// actually shown — a bounded room never fetches.
	useEffect(() => {
		if (!bashEnabled) return;
		let cancelled = false;
		void fetchPersistentRoomBashSettings(agentId)
			.then((response) => {
				if (!cancelled) setAutoApprove(response.settings.autoApprove === true);
			})
			// Quiet failure = "asks": the guard's own fail-closed default.
			.catch(() => {
				if (!cancelled) setAutoApprove(false);
			});
		return () => { cancelled = true; };
	}, [agentId, bashEnabled, refetchTick]);

	// Room switch: drop any open menu and fall back to "asks" until the new
	// room's answer lands, so the previous room's mode never shows on it.
	useEffect(() => {
		setOpen(false);
		setAutoApprove(false);
		setSaveError(null);
	}, [agentId]);

	// Settings-modal close is a moment the stored value may have changed.
	const prevSettingsOpenRef = useRef(settingsOpen);
	useEffect(() => {
		const wasOpen = prevSettingsOpenRef.current;
		prevSettingsOpenRef.current = settingsOpen;
		if (wasOpen && !settingsOpen) setRefetchTick((tick) => tick + 1);
	}, [settingsOpen]);

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") setOpen(false);
		}
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	if (!bashEnabled) return null;

	function toggleMenu(): void {
		setOpen((value) => {
			const next = !value;
			if (next) {
				// Opening is when staleness matters: another device or the
				// settings modal may have flipped the value since we loaded it.
				setSaveError(null);
				setRefetchTick((tick) => tick + 1);
			}
			return next;
		});
	}

	async function select(nextAutoApprove: boolean): Promise<void> {
		// `saving` also guards the rapid-double-click race: the second click
		// returns before a second PUT can leave.
		if (saving || remoteClient.remote) return;
		if (nextAutoApprove === autoApprove) {
			setOpen(false);
			return;
		}
		setSaving(true);
		setSaveError(null);
		try {
			const response = await updatePersistentRoomBashSettings(agentId, { autoApprove: nextAutoApprove });
			setAutoApprove(response.settings.autoApprove === true);
			setOpen(false);
		} catch (e) {
			// The stored truth did not change, so neither does the chip; the
			// menu stays open with the failure named so a retry is one click.
			setSaveError((e as Error).message || "Failed to save bash approval setting.");
		} finally {
			setSaving(false);
		}
	}

	const optionsDisabled = saving || remoteClient.remote;

	return (
		<div className="bash-mode-chip-anchor" ref={rootRef}>
			<button
				type="button"
				className={`bash-mode-chip${autoApprove ? " auto" : ""}`}
				title={autoApprove ? "This room runs commands without asking. Click to change" : "This room asks before each command. Click to change"}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={toggleMenu}
			>
				{autoApprove ? "Bash: auto" : "Bash: asks"}
			</button>
			{open && (
				<div className="bash-mode-menu" role="menu" aria-label="Bash approval mode">
					<button
						type="button"
						role="menuitemradio"
						className={`bash-mode-option${!autoApprove ? " is-current" : ""}`}
						aria-checked={!autoApprove}
						disabled={optionsDisabled}
						onClick={() => void select(false)}
					>Ask before each command</button>
					<button
						type="button"
						role="menuitemradio"
						className={`bash-mode-option${autoApprove ? " is-current" : ""}`}
						aria-checked={autoApprove}
						disabled={optionsDisabled}
						onClick={() => void select(true)}
					>Run without asking</button>
					{remoteClient.remote && <p className="bash-mode-menu-note">Changeable at the computer only.</p>}
					{saveError && <p className="bash-mode-menu-error">{saveError}</p>}
				</div>
			)}
		</div>
	);
}
