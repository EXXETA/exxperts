import { useState, type DragEvent } from "react";
import { useHoverTooltip } from "./workspace-hover-tooltip";

// Its own type, so a tab dropped on the composer or the file tree is ignored there.
const TAB_DRAG_TYPE = "application/x-exxperts-workspace-tab";

type DropTarget = { path: string; side: "before" | "after" };

export function WorkspaceFileTabs({ tabs, active, onSelect, onClose, onReorder }: { tabs: string[]; active: string | null; onSelect: (path: string) => void; onClose: (path: string) => void; onReorder: (paths: string[]) => void }) {
	const [dragged, setDragged] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
	const { show: showTooltip, hide: hideTooltip, tooltip } = useHoverTooltip();
	const endDrag = () => { setDragged(null); setDropTarget(null); };
	const overTab = (event: DragEvent<HTMLElement>, path: string) => {
		if (!dragged) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "move";
		const box = event.currentTarget.getBoundingClientRect();
		setDropTarget(path === dragged ? null : { path, side: event.clientX < box.left + box.width / 2 ? "before" : "after" });
	};
	// Past the last tab, the tab goes to the end.
	const overBar = (event: DragEvent<HTMLElement>) => {
		if (!dragged) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const last = tabs[tabs.length - 1];
		setDropTarget(last === dragged ? null : { path: last, side: "after" });
	};
	const drop = (event: DragEvent<HTMLElement>) => {
		if (!dragged) return;
		event.preventDefault();
		if (dropTarget) {
			const rest = tabs.filter((path) => path !== dragged);
			const at = rest.indexOf(dropTarget.path) + (dropTarget.side === "after" ? 1 : 0);
			onReorder([...rest.slice(0, at), dragged, ...rest.slice(at)]);
		}
		endDrag();
	};
	return <div className="workspace-tabs" role="tablist" aria-label="Open files" onDragOver={overBar} onDrop={drop}>
		{tabs.map((path) => {
			const name = path.split("/").pop() || path;
			return <div
				className="workspace-tab"
				key={path}
				data-active={path === active}
				data-dragging={path === dragged || undefined}
				data-drop={dropTarget?.path === path ? dropTarget.side : undefined}
				draggable
				onMouseEnter={(event) => showTooltip(event, path)}
				onMouseLeave={hideTooltip}
				onDragStart={(event) => { hideTooltip(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(TAB_DRAG_TYPE, path); setDragged(path); }}
				onDragEnd={endDrag}
				onDragOver={(event) => overTab(event, path)}
			>
				<button type="button" className="workspace-tab-select" role="tab" aria-selected={path === active} aria-description={path} onClick={() => onSelect(path)}>{name}</button>
				<button type="button" className="workspace-tab-close" aria-label={`Close ${name}`} onClick={() => onClose(path)}>×</button>
			</div>;
		})}
		{tooltip}
	</div>;
}
