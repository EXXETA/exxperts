import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import type { PersistentAgentMementoBoundaryResponse, PersistentAgentStatus } from "../types";
import { modelDisplayName } from "../model-names";
import { RsInfo } from "./rs-info";

async function applyMemento(agentId: string, conversationId: string): Promise<PersistentAgentMementoBoundaryResponse> {
	const response = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/memento`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ conversationId }),
	});
	const text = await response.text();
	let payload: unknown = null;
	try { payload = text.trim() ? JSON.parse(text) : null; } catch { payload = text; }
	if (!response.ok) {
		const error = payload && typeof payload === "object" ? (payload as { error?: unknown }).error : null;
		throw new Error(typeof error === "string" && error.trim() ? error.trim() : `Failed to apply Memento (${response.status}).`);
	}
	return payload as PersistentAgentMementoBoundaryResponse;
}

function sessionModelLabel(status: PersistentAgentStatus): string | null {
	const model = status.runtime.model;
	if (!model) return null;
	return modelDisplayName({ model: model.model, modelLabel: model.label, provider: model.provider }) || model.model;
}

export function RoomSessionSection({ status, onRefresh }: { status: PersistentAgentStatus; onRefresh: () => void }) {
	const [confirming, setConfirming] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const activeThread = status.activeThread;
	const modelLabel = sessionModelLabel(status);
	const busy = Boolean(activeThread?.inFlight || activeThread?.working || status.activeLock);
	const confirmRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (confirming) confirmRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, [confirming]);

	async function submitMemento(): Promise<void> {
		if (!activeThread) return;
		setSubmitting(true);
		setError(null);
		setMessage(null);
		try {
			await applyMemento(status.id, activeThread.threadId);
			setConfirming(false);
			setMessage("Memento applied. The room starts a fresh conversation on next open.");
			onRefresh();
		} catch (e) {
			setError((e as Error).message || "Failed to apply Memento.");
		} finally {
			setSubmitting(false);
		}
	}

	const head = (
		<>
			<header className="rs-pane-head">
				<h3>Session</h3>
			</header>
			<p className="rs-pane-sub">The conversation this room currently has open.</p>
		</>
	);

	if (!activeThread) {
		return (
			<div className="room-session-section">
				{head}
				<p className="workspaces-empty-state">No open conversation yet. Memento becomes available once the room has one.</p>
				{message && <div className="workspaces-success">{message}</div>}
			</div>
		);
	}

	return (
		<div className="room-session-section">
			{head}
			{!confirming && (
				<div className="rs-row">
					<div className="rs-row-main">
						<span className="rs-row-label">
							Open conversation{modelLabel ? <> on <strong>{modelLabel}</strong></> : null}{busy ? " (in use)" : ""}
						</span>
						<span className="rs-row-hint">
							Memento closes it and the room starts fresh. Memory stays, nothing is checkpointed.
							<RsInfo text="Useful when the conversation is stuck on a model or provider you no longer have access to." />
						</span>
					</div>
					<button className="rs-btn" disabled={submitting} onClick={() => { setConfirming(true); setError(null); setMessage(null); }}>Memento…</button>
				</div>
			)}
			{confirming && (
				<div className="room-session-confirm" ref={confirmRef}>
					<p className="room-danger-note"><strong>Apply Memento?</strong> The current conversation is forgotten and the room starts fresh. Memory stays and nothing is checkpointed.{busy ? " The room is in use right now: any response being written will be stopped and a live session will be closed." : ""}</p>
					<div className="room-danger-confirm-actions">
						<button className="rs-btn" disabled={submitting} onClick={() => void submitMemento()}>{submitting ? "Applying…" : "Apply Memento"}</button>
						<button className="rs-quiet" type="button" disabled={submitting} onClick={() => { setConfirming(false); setError(null); }}>Cancel</button>
					</div>
				</div>
			)}
			{message && <div className="workspaces-success">{message}</div>}
			{error && <div className="workspaces-error">{error}</div>}
		</div>
	);
}
