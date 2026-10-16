import { RsInfo } from "./rs-info";

export interface SkillPathItem { label: string; onClick?: () => void }

export function SkillLibraryPath({ items, shared = false, disabled = false }: { items: SkillPathItem[]; shared?: boolean; disabled?: boolean }) {
	return <header className="skill-library-path">
		<nav aria-label="Skills navigation"><ol>{items.map((item, index) => <li key={index}>
			{index > 0 && <span className="skill-path-separator" aria-hidden="true">/</span>}
			{item.onClick ? <button type="button" disabled={disabled} onClick={() => item.onClick?.()}>{item.label}</button> : <span aria-current={index === items.length - 1 ? "page" : undefined}>{item.label}</span>}
		</li>)}</ol></nav>
		{shared && <span className="skill-library-scope">Shared library <RsInfo text="This library is shared by all rooms. Importing changes updates the local library; each room keeps its approved version until you confirm its changes." /></span>}
	</header>;
}
