import { useEscapeKey } from "./use-escape-key";

interface Props {
	onClose: () => void;
}

/** The first steps, in the order a new user takes them: a bold lead and a few sentences each. */
const STEPS: { lead: string; body: string }[] = [
	{ lead: "Connect your AI.", body: "Open the gear, then Settings, AI setup. Sign in with a subscription, add an API key, or connect your company gateway. Set the default models for your rooms there." },
	{ lead: "Create a room.", body: "One room per project or topic. Press New room on Home, give it a name and start talking: ask questions, share files, work things through." },
	{ lead: "Remember what matters.", body: "When a conversation is worth keeping, press Remember. You see what your exxpert will keep before anything is saved. Forget closes a conversation without keeping it." },
	{ lead: "Keep the memory tidy.", body: "When conversations pile up, press Maintain on the room's card. Memorize turns them into notes, and Review tidies the notes. Nothing changes without your approval." },
	{ lead: "Come back any time.", body: "A room rests fully saved. Press Resume to continue where you left off." },
];

const GOOD_TO_KNOW = [
	"Each room can have its own model: Room settings, Model.",
	"Sort your rooms on Home by last used, by name, or drag them into your own order.",
	"A room is open in one place at a time. If it's open in another window, close it there first.",
	"The Memory page shows what your rooms remember. The Wallet shows what you spend.",
];

/** The one user guide, behind Help in the gear menu (on a phone too): guidance for a new user, not a manual. */
export function Help({ onClose }: Props) {
	useEscapeKey(onClose);
	return (
		<div className="help-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="How exxperts works">
			<div className="help-modal" onClick={(e) => e.stopPropagation()}>
				<div className="help-head">
					<h2>How exxperts works</h2>
					<button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
				</div>
				<div className="help-body">
					<p className="help-lede">Most AI forgets the moment you close it. Your rooms don't.</p>
					<ol className="help-steps">
						{STEPS.map((step) => (
							<li key={step.lead}><strong>{step.lead}</strong> {step.body}</li>
						))}
					</ol>
					<h3>Good to know</h3>
					<ul className="help-notes">
						{GOOD_TO_KNOW.map((note) => <li key={note}>{note}</li>)}
					</ul>
				</div>
			</div>
		</div>
	);
}
