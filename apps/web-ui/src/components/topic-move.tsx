// Move: the one control that puts a note under another topic, the same in Room
// settings' Memory and on the Memorize card. It lists the topics there are, so
// a typo never makes a topic by accident; "new topic…" shows a field for the
// name, and the server says why a name cannot be used.

import { useId, useState } from "react";
import { memoryTopicName } from "../memory-surface-copy";

const NEW_TOPIC = "__new-topic__";

export function TopicMove({ topics, current, busy, onMove, onCancel }: { topics: string[]; current: string; busy: boolean; onMove: (topic: string, newTopic: boolean) => void; onCancel: () => void }) {
	const [choice, setChoice] = useState(current);
	const [name, setName] = useState("");
	const id = useId();
	const typed = choice === NEW_TOPIC;
	// Move waits for somewhere else to go: another topic, or a new one with its name.
	const ready = typed ? name.trim().length > 0 : choice !== current;
	const options = topics.includes(current) ? topics : [current, ...topics];
	return (
		<div className="memory-entry-move">
			<label className="memory-entry-move-label" htmlFor={id}>Move to</label>
			<select id={id} value={choice} onChange={(event) => setChoice(event.target.value)}>
				{options.map((topic) => <option key={topic} value={topic}>{memoryTopicName(topic)}</option>)}
				<option value={NEW_TOPIC}>new topic…</option>
			</select>
			{typed && <input type="text" value={name} placeholder="Topic name" aria-label="New topic name" autoFocus onChange={(event) => setName(event.target.value)} />}
			<span className="settings-form-foot">
				<button className="rs-btn" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
				<button className="rs-btn rs-btn-primary" type="button" disabled={busy || !ready} onClick={() => onMove((typed ? name : choice).trim(), typed)}>{busy ? "Moving…" : "Move"}</button>
			</span>
		</div>
	);
}
