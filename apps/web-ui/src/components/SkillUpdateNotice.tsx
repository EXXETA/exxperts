import { roomSkillUpdateLabel, useSkillUpdateNotices } from "../skill-update-notices";

export function RoomSkillUpdateButton({ roomId, onClick, disabled = false }: { roomId: string; onClick: () => void; disabled?: boolean }) {
	const label = roomSkillUpdateLabel(useSkillUpdateNotices(), roomId);
	return label ? <button className="rs-text-btn skill-update-notice" disabled={disabled} onClick={onClick} title="Open Skills in this room's settings"><span className="skill-update-dot" aria-hidden="true" />{label}</button> : null;
}
