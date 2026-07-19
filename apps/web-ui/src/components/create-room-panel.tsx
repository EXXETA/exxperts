import { type FormEvent, useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { PersistentAgentCreateRequest, PersistentAgentModeOption } from "../types";

export interface CreateRoomFormValues {
	personalAgentName: string;
	confirmPersonalAgentName: string;
	userName: string;
	preferredAddress: string;
	mode?: string;
}

export interface CreateRoomPanelViewProps {
	variant?: "card" | "section";
	open: boolean;
	values: CreateRoomFormValues;
	modes?: PersistentAgentModeOption[];
	submitting?: boolean;
	error?: string | null;
	successName?: string | null;
	onOpen: () => void;
	onClose: () => void;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
	onChange: (field: keyof CreateRoomFormValues, value: string) => void;
}

export function CreateRoomPanelView({ variant = "card", open, values, modes = [], submitting = false, error = null, successName = null, onOpen, onClose, onSubmit, onChange }: CreateRoomPanelViewProps) {
	const form = (
		<form className="create-room-form" onSubmit={onSubmit}>
			<div className="create-room-fields">
				<label className="create-room-field">
					<strong>Exxpert name</strong>
					<input className="launcher-path-input create-room-input" type="text" value={values.personalAgentName} onChange={(e) => onChange("personalAgentName", e.target.value)} />
				</label>
				<label className="create-room-field">
					<strong>Confirm exxpert name</strong>
					<input className="launcher-path-input create-room-input" type="text" value={values.confirmPersonalAgentName} onChange={(e) => onChange("confirmPersonalAgentName", e.target.value)} />
				</label>
				<label className="create-room-field">
					<strong>Your name</strong>
					<input className="launcher-path-input create-room-input" type="text" value={values.userName} onChange={(e) => onChange("userName", e.target.value)} />
				</label>
				<label className="create-room-field">
					<strong>Preferred address</strong>
					<input className="launcher-path-input create-room-input" type="text" placeholder="Optional" value={values.preferredAddress} onChange={(e) => onChange("preferredAddress", e.target.value)} />
				</label>
				{modes.length > 1 && (
					<div className="create-room-field create-room-mode-field" role="radiogroup" aria-label="Working style">
						<strong>Working style</strong>
						<div className="create-room-mode-options">
							{modes.map((mode) => (
								<label key={mode.id} className="create-room-mode-option">
									<input type="radio" name="create-room-mode" value={mode.id} checked={(values.mode ?? modes[0]?.id) === mode.id} disabled={submitting} onChange={() => onChange("mode", mode.id)} />
									<span className="create-room-mode-copy"><strong>{mode.label}</strong> · {mode.description}</span>
								</label>
							))}
						</div>
						<p className="create-room-mode-note">Fixed for this room after creation.</p>
					</div>
				)}
			</div>
			{error && <div className="create-room-message error">{error}</div>}
			<div className="create-room-actions">
				<button className="landing-action" type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create room"}</button>
				<button className="inline-action" type="button" disabled={submitting} onClick={onClose}>Cancel</button>
			</div>
		</form>
	);
	const body = !open ? (
		<button className="landing-action create-room-open-action" onClick={onOpen}>{successName ? "Create another room" : "Create room"}</button>
	) : form;
	const successMessage = successName ? <div className="create-room-message success">Created {successName}. The room card is now available.</div> : null;

	if (variant === "section") {
		return (
			<div className="create-room-section create-room-body">
				<p className="create-room-copy">Name the exxpert for this room and tell it how to address you. Confirm the name to avoid a typo.</p>
				{successMessage}
				{body}
			</div>
		);
	}

	return (
		<article className="landing-card persistent-agent-card create-room-card create-room-panel">
			<div className="persistent-agent-header create-room-section-heading">
				<span className="status-dot ready" />
				<h2>Create room</h2>
			</div>
			<p className="cli-note create-room-copy">Create a new room with its own exxpert and local memory.</p>
			<p className="cli-note create-room-hint">The exxpert keeps this room's memory and context between sessions, so you can re-enter and continue later.</p>
			{successMessage}
			{body}
		</article>
	);
}

export function CreateRoomPanel({ onCreate, initialOpen = false, variant = "card", onCreated, onCancel }: { onCreate: (request: PersistentAgentCreateRequest) => Promise<void>; initialOpen?: boolean; variant?: "card" | "section"; onCreated?: () => void; onCancel?: () => void }) {
	const [open, setOpen] = useState(initialOpen);
	const [modes, setModes] = useState<PersistentAgentModeOption[]>([]);
	const [values, setValues] = useState<CreateRoomFormValues>({
		personalAgentName: "",
		confirmPersonalAgentName: "",
		userName: "",
		preferredAddress: "",
	});
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [successName, setSuccessName] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		apiFetch("/api/persistent-agent-modes")
			.then(async (res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (cancelled || !data || !Array.isArray(data.modes)) return;
				setModes(data.modes);
				const defaultModeId = typeof data.defaultModeId === "string" ? data.defaultModeId : data.modes[0]?.id;
				if (defaultModeId) setValues((current) => (current.mode ? current : { ...current, mode: defaultModeId }));
			})
			.catch(() => {
				// Without the mode list the picker stays hidden and the server default applies.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const displayName = values.personalAgentName.trim();
		const confirmation = values.confirmPersonalAgentName.trim();
		const trimmedUserName = values.userName.trim();
		const trimmedPreferredAddress = values.preferredAddress.trim();
		if (!displayName) {
			setError("Exxpert name is required.");
			return;
		}
		if (displayName !== confirmation) {
			setError("Exxpert name confirmation must match.");
			return;
		}
		if (!trimmedUserName) {
			setError("Your name is required.");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await onCreate({
				displayName,
				userName: trimmedUserName,
				...(trimmedPreferredAddress ? { preferredUserAddress: trimmedPreferredAddress } : {}),
				...(values.mode ? { mode: values.mode } : {}),
			});
			setSuccessName(displayName);
			setValues((current) => ({
				personalAgentName: "",
				confirmPersonalAgentName: "",
				userName: "",
				preferredAddress: "",
				...(current.mode ? { mode: modes[0]?.id ?? current.mode } : {}),
			}));
			setOpen(false);
			onCreated?.();
		} catch (err) {
			setError((err as Error).message || "Failed to create room.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<CreateRoomPanelView
			variant={variant}
			open={open}
			values={values}
			modes={modes}
			submitting={submitting}
			error={error}
			successName={successName}
			onOpen={() => { setOpen(true); setError(null); setSuccessName(null); }}
			onClose={onCancel ? () => { setError(null); onCancel(); } : () => { setOpen(false); setError(null); }}
			onSubmit={submit}
			onChange={(field, value) => {
				setValues((current) => ({ ...current, [field]: value }));
				setError(null);
			}}
		/>
	);
}
