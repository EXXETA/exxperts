import { useState } from "react";
import type { BashRuleRow, PermissionAction } from "../bash-rules";
import { CollapseIcon, ExpandIcon } from "./icons";

const ACTIONS: { value: PermissionAction; label: string }[] = [
	{ value: "deny", label: "Deny" },
	{ value: "ask", label: "Ask" },
	{ value: "allow", label: "Allow" },
];

export function BashRulesEditor({ rows, onChange, disabled, idPrefix }: { rows: BashRuleRow[]; onChange: (rows: BashRuleRow[]) => void; disabled: boolean; idPrefix: string }) {
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
	const update = (index: number, patch: Partial<BashRuleRow>) => onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
	const move = (index: number, delta: -1 | 1) => {
		const next = [...rows];
		const [row] = next.splice(index, 1);
		next.splice(index + delta, 0, row);
		onChange(next);
	};
	return (
		<div className="bash-rules">
			<p className="settings-group-kicker">Bash rules · last matching rule wins</p>
			{rows.map((row, index) => (
				<div className="bash-rule-row" key={index}>
					<div className="bash-rule-pattern-control">
						<input className="launcher-path-input bash-rule-pattern" type="text" value={row.pattern} disabled={disabled} aria-label={`Rule ${index + 1} pattern`} onChange={(event) => update(index, { pattern: event.target.value })} />
						<button className="bash-rule-expand" type="button" disabled={disabled} aria-label={`Expand rule ${index + 1} pattern`} aria-expanded={expandedIndex === index} title="Expand pattern" onClick={() => setExpandedIndex(index)}><ExpandIcon /></button>
					</div>
					<div className="permission-toggle" role="radiogroup" aria-label={`Rule ${index + 1} action`}>
						{ACTIONS.map(({ value, label }) => {
							const id = `${idPrefix}-${index}-${value}`;
							return <span key={value}><input type="radio" id={id} name={`${idPrefix}-${index}`} value={value} checked={row.action === value} disabled={disabled} onChange={() => update(index, { action: value })} /><label htmlFor={id}>{label}</label></span>;
						})}
					</div>
					<button className="rs-btn" type="button" disabled={disabled || index === 0} aria-label={`Move rule ${index + 1} up`} onClick={() => move(index, -1)}>↑</button>
					<button className="rs-btn" type="button" disabled={disabled || index === rows.length - 1} aria-label={`Move rule ${index + 1} down`} onClick={() => move(index, 1)}>↓</button>
					<button className="rs-btn" type="button" disabled={disabled} aria-label={`Delete rule ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>✕</button>
				</div>
			))}
			{expandedIndex !== null && rows[expandedIndex] && (
				<div className="bash-rule-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpandedIndex(null); }}>
					<section className="bash-rule-modal" role="dialog" aria-modal="true" aria-labelledby={`${idPrefix}-expanded-title`}>
						<div className="bash-rule-modal-header">
							<p className="settings-group-kicker" id={`${idPrefix}-expanded-title`}>Bash rule {expandedIndex + 1} pattern</p>
							<button className="bash-rule-expand bash-rule-collapse" type="button" aria-label="Collapse pattern editor" title="Collapse pattern editor" onClick={() => setExpandedIndex(null)}><CollapseIcon /></button>
						</div>
						<textarea autoFocus className="launcher-path-input bash-rule-modal-input" value={rows[expandedIndex].pattern} disabled={disabled} aria-label={`Rule ${expandedIndex + 1} pattern editor`} onChange={(event) => update(expandedIndex, { pattern: event.target.value })} />
					</section>
				</div>
			)}
			<button className="rs-btn" type="button" disabled={disabled} onClick={() => onChange([...rows, { pattern: "*", action: "ask" }])}>+ Add rule</button>
			<p className="settings-help">Patterns match the command text: * = any, ? = one character. Not a sandbox.</p>
		</div>
	);
}
