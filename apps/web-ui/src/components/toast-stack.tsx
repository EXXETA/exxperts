/**
 * The room's one toast home (taste pass): every transient notice — a task
 * finishing, a delete's Undo window, a save confirmation — appears in a single
 * slot floating just above the composer, stacking upward when several are
 * live. Before this the same four notices used three different corners
 * (bottom-center, bottom-left over the rail, top-right under the top bar), so
 * "where do I look when something happened?" had no answer; a user watching
 * one corner missed the others.
 *
 * The grammar is deliberately one line of shapes: text (with an optional
 * quieter second line for a nuance the first line must not carry) and at most
 * one action. Anything that wants more than that is not a toast.
 *
 * Positioning belongs to the caller's `.composer-toasts` wrapper, which
 * anchors to the composer column rather than the viewport — the viewport
 * centre drifts off the composer the moment the viewer pane opens.
 */

export interface ToastView {
	/** Stable identity for React; also what the stack orders by (oldest first, newest nearest the composer). */
	id: string;
	tone?: "neutral" | "success" | "error";
	/** The fact. One sentence, no trailing context. */
	text: string;
	/** The nuance the fact must not carry ("Its files are kept."). Rendered quieter, below. */
	sub?: string;
	/** At most one action. Undo, Open — a verb the user can act on right now. */
	action?: { label: string; onClick: () => void };
}

interface Props {
	toasts: ToastView[];
}

export function ToastStack({ toasts }: Props) {
	if (toasts.length === 0) return null;
	return (
		<div className="composer-toasts">
			{toasts.map((toast) => (
				<div key={toast.id} className={`room-toast ${toast.tone ?? "neutral"}`} role="status" aria-live="polite">
					<span className="room-toast-text">
						<span>{toast.text}</span>
						{toast.sub && <span className="room-toast-sub">{toast.sub}</span>}
					</span>
					{toast.action && (
						<button type="button" className="room-toast-action" onClick={toast.action.onClick}>
							{toast.action.label}
						</button>
					)}
				</div>
			))}
		</div>
	);
}
