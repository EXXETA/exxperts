// Minimal local declaration for the transitive "ws" client used by
// consult-streaming-smoke; @types/ws is deliberately not a dependency.
declare module "ws" {
	const WebSocket: any;
	export default WebSocket;
}
