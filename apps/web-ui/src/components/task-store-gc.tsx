import { useEscapeKey } from "./use-escape-key";

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
			<button className="rs-btn" onClick={onReview} title="See which old task folders would be deleted">Review</button>
			<button className="icon-btn" aria-label="Dismiss" title="Dismiss — nothing is deleted" onClick={onDismiss}>✕</button>
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
				<p>These {proposal.candidates.length} are from old work no conversation refers to anymore. Deleting them frees {fmtMb(proposal.reclaimBytes)}; your Attachments and saved snapshots stay.</p>
				<div className="task-store-gc-list">
					{proposal.candidates.map((candidate) => (
						<div key={candidate.taskId} className="task-store-gc-row">
							<span className="task-store-gc-title">{candidate.title || candidate.taskId}</span>
							<span className="task-store-gc-meta">{candidate.startedAt ? new Date(candidate.startedAt).toLocaleDateString() : "—"} · {fmtMb(candidate.bytes)}</span>
						</div>
					))}
				</div>
				<div className="checkpoint-preview-actions">
					<button className="rs-btn" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
					<button className="rs-btn rs-btn-danger" disabled={busy} onClick={onConfirm}>{busy ? "Deleting…" : `Delete ${proposal.candidates.length} task folders`}</button>
				</div>
			</section>
		</div>
	);
}

export { TaskStoreGcBanner, TaskStoreGcDialog };
export type { TaskStoreGcView };
