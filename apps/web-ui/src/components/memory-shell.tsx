import { Memory } from "./Memory";
import { type ThemeMode, type AppearancePreference, ProductSidebar } from "./product-shell";
import type { SettingsSection } from "./settings-overlay";
import type { PersistentAgentId } from "../types";
import type { MaintainTarget } from "../room-thread-items";

function MemoryShell({ onHome, onSettings, onDashboard, onMaintain, maintainBlocked, onOpenMemorySettings, theme, appearance, onSetAppearance }: { onHome: () => void; onSettings: (section?: SettingsSection) => void; onDashboard: () => void; onMaintain: (target: MaintainTarget) => void; maintainBlocked?: (agentId: PersistentAgentId) => string | null; onOpenMemorySettings: (target: { agentId: string; displayName: string }) => void; theme: ThemeMode; appearance: AppearancePreference; onSetAppearance: (pref: AppearancePreference) => void }) {
	return (
		<div className="landing-shell with-product-sidebar">
			<ProductSidebar onHome={onHome} onSettings={onSettings} onDashboard={onDashboard} onMemory={() => {}} theme={theme} appearance={appearance} onSetAppearance={onSetAppearance} active="memory" />
			<div className="landing dashboard-page">
				<section className="landing-hero">
					<h1>Memory.</h1>
					<p>What your rooms remember, and how full their memory is.</p>
				</section>
				<Memory onMaintain={onMaintain} maintainBlocked={maintainBlocked} onOpenMemorySettings={onOpenMemorySettings} />
			</div>
		</div>
	);
}

export { MemoryShell };
