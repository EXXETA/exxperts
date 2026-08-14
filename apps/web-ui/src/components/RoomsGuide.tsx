import { useEscapeKey } from "./use-escape-key";

interface Props {
	onClose: () => void;
}

const POINTS: { term: string; body: string }[] = [
	{
		term: "Bring your own AI",
		body: "exxperts runs with the AI you already have. Connect a subscription or an API key once, in AI setup behind the gear at the bottom of the sidebar.",
	},
	{
		term: "Create and chat",
		body: "Make a room, name your exxpert, and talk to it like a colleague: ask questions, share files, work things through.",
	},
	{
		term: "An exxpert for each topic",
		body: "Give each project, topic, or area its own room, so its exxpert builds real depth there while everything else stays out of the way.",
	},
	{
		term: "It remembers",
		body: "Your work is saved as you go. Each time you Remember you choose what your exxpert keeps from the session, so nothing important is lost.",
	},
	{
		term: "Come back any time",
		body: "Leave a room and it rests, fully saved. Press Resume to continue right where you left off.",
	},
];

export function RoomsGuide({ onClose }: Props) {
	useEscapeKey(onClose);
	return (
		<div className="rooms-guide-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="How rooms work">
			<div className="rooms-guide-modal" onClick={(e) => e.stopPropagation()}>
				<div className="rooms-guide-topbar">
					<button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
				</div>

				<h2 className="rooms-guide-hook">
					Most AI forgets the moment you close it. Your exxpert doesn't.
				</h2>
				<p className="rooms-guide-lede">
					A room is your own workspace, with its own exxpert.
				</p>

				<div className="rooms-guide-basics">
					{POINTS.map((point) => (
						<div className="rooms-guide-basic" key={point.term}>
							<span className="rooms-guide-term">{point.term}</span>
							<span className="rooms-guide-body">{point.body}</span>
						</div>
					))}
				</div>

				<p className="rooms-guide-foot">
					Good to know: a room can be open in just one place at a time. If it is open in another
					window or the command line, close it there first.
				</p>
			</div>
		</div>
	);
}
