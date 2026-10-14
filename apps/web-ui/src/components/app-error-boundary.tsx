import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The app's one safety net: a render error anywhere below shows one plain
 * sentence and a way back, instead of a blank page. What went wrong goes to
 * the console, never onto the screen.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("The page stopped drawing:", error, info.componentStack);
	}

	render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		return (
			<div className="app-error-boundary" role="alert" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, minHeight: "100vh", padding: 24, textAlign: "center" }}>
				<p style={{ margin: 0 }}>Something went wrong on this page. Reloading usually fixes it.</p>
				<button type="button" className="rs-btn" onClick={() => location.reload()}>Reload</button>
			</div>
		);
	}
}
