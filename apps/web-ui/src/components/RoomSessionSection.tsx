import { useState } from "react";
import { apiFetch } from "../api";
import type { PersistentAgentMementoBoundaryResponse, PersistentAgentStatus } from "../types";
import { modelDisplayName, modelTooltipName } from "../model-names";
import { confirmDialog } from "./confirm-dialog";
import { RsInfo } from "./rs-info";
import { PaneHeader } from "./pane-header";

/** The one question before a conversation is forgotten, from the room's bin or from this pane. */
export function confirmForgetConversation(answerRunning: boolean): Promise<boolean> {
	const stopped = answerRunning ? "The response currently being written will be stopped. " : "";
	return confirmDialog({
		title: "Forget this conversation and start fresh?",
		body: `${stopped}This deletes this conversation for good. Nothing from it is saved to memory.`,
		confirmLabel: "Forget",
		danger: true,
	});
}

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
		throw new Error(typeof error === "string" && error.trim() ? error.trim() : `Failed to forget this conversation (${response.status}).`);
	}
	return payload as PersistentAgentMementoBoundaryResponse;
}

function sessionModelLabel(status: PersistentAgentStatus): { name: string; title: string } | null {
	const model = status.runtime.model;
	if (!model) return null;
	const input = { model: model.model, modelLabel: model.label, provider: model.provider };
	return { name: modelDisplayName(input) || model.model, title: modelTooltipName(input) || model.model };
}

export function RoomSessionSection({ status, answering, onRefresh, onMementoApplied, onMementoForget, onBeforeMemento }: { status: PersistentAgentStatus; answering: boolean; onRefresh: () => void; onMementoApplied?: () => void; onMementoForget?: () => void; onBeforeMemento?: (continueAction: () => void) => boolean }) {
	const [submitting, setSubmitting] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const activeThread = status.activeThread;
	const modelLabel = sessionModelLabel(status);
	const busy = Boolean(activeThread?.inFlight || activeThread?.working || status.activeLock);

	async function forgetConversation(): Promise<void> {
		if (!activeThread) return;
		if (onBeforeMemento && !onBeforeMemento(() => { void forgetConversation(); })) return;
		setError(null);
		setMessage(null);
		if (!(await confirmForgetConversation(answering))) return;
		setSubmitting(true);
		try {
			await applyMemento(status.id, activeThread.threadId);
			// A memento is a forget flow wherever it is applied from: any parked
			// draft for this room dies with the conversation.
			onMementoForget?.();
			// From inside the open room the caller leaves the room instead: the
			// conversation this view is bound to no longer exists server-side, so
			// there is nothing here to keep showing a success note over.
			if (onMementoApplied) {
				onMementoApplied();
				return;
			}
			setMessage("This conversation is forgotten. The room starts a fresh one on next open.");
			onRefresh();
		} catch (e) {
			setError((e as Error).message || "Failed to forget this conversation.");
		} finally {
			setSubmitting(false);
		}
	}

	const head = <PaneHeader title="Conversation" line="The conversation this room has open right now." />;

	if (!activeThread) {
		return (
			<div className="room-session-section">
				{head}
				<p className="settings-empty">No open conversation yet. Forget becomes available once the room has one.</p>
				{message && <div className="workspaces-success">{message}</div>}
			</div>
		);
	}

	return (
		<div className="room-session-section">
			{head}
			<div className="settings-rows">
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">
							Open conversation{modelLabel ? <> on <strong title={modelLabel.title}>{modelLabel.name}</strong></> : null}{busy ? " (in use)" : ""}
						</span>
						<span className="settings-row-sub">
							Forget ends this conversation and starts a fresh one. The room keeps everything already in its memory, and nothing new is saved from this conversation.
							<RsInfo text="Useful when the conversation is stuck on a model or provider you no longer have access to." />
						</span>
					</div>
					<button className="rs-btn" disabled={submitting} onClick={() => void forgetConversation()}>{submitting ? "Forgetting…" : "Forget…"}</button>
				</div>
			</div>
			{message && <div className="workspaces-success">{message}</div>}
			{error && <div className="workspaces-error">{error}</div>}
		</div>
	);
}
