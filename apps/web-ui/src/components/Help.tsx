interface Props {
	onClose: () => void;
}

export function Help({ onClose }: Props) {
	return (
		<div className="help-overlay" onClick={onClose}>
			<div className="help-modal" onClick={(e) => e.stopPropagation()}>
				<div className="help-head">
					<h2>How exxperts works</h2>
					<button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
				</div>
				<div className="help-body">
					<section className="help-hero">
						<p className="help-lede">
							exxperts runs on your machine: persistent AI rooms with durable memory that
							you govern. No memory changes without your approval.
						</p>
					</section>

					<section>
						<h3>Rooms</h3>
						<p>
							Each room is a persistent workspace with its own exxpert, memory, threads, and
							workspace files. Use Remember to save what matters from a conversation into
							the room's memory. Beside it in the composer, the effort pill sets how hard the
							room thinks: open it and slide between Faster and Smarter. The choice sticks
							for the room and takes effect from your next message, and the pill only appears
							when the room's model can actually reason. Forget, the bin icon at the top of
							the room, closes the current conversation without remembering it and is also
							available in Room Settings. Maintain, on the room card, opens Memorize and
							Review, which turn remembered sessions into lasting memory and tidy it; you sign
							off every rewrite. Room Settings holds the rest: workspace access, memory budget,
							schedules, and delete.
						</p>
					</section>

					<section>
						<h3>Your AI</h3>
						<p>
							Connect the AI you already have in AI setup: sign in with a subscription, paste
							an API key, or point at a company gateway. You approve which models rooms may
							use, and you switch between AI profiles right here in the settings menu.
						</p>
					</section>

					<section>
						<h3>Memory and Wallet</h3>
						<p>
							The Memory page shows what your rooms know, and HiveMind answers questions
							across all of it. The Wallet tracks spend, including background work like
							memory upkeep and scheduled runs, split into billed API spend and
							plan-covered usage, with a CSV export.
						</p>
					</section>

					<section>
						<h3>Commands</h3>
						<pre className="help-code">
{`exxperts web  # this app, in the browser
exxperts cli  # coding agent in the terminal, from any repo`}
						</pre>
					</section>
				</div>
			</div>
		</div>
	);
}
