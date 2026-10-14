import { useEffect, useState } from "react";

// Is this page being viewed from a remote device (over the tunnel), and with
// what capability? Used only to HIDE affordances that cannot work remotely
// (native folder picker, save-to-disk): the server refuses them regardless
// of what the client renders, so failing open to "local" here is safe and
// keeps the loopback experience byte-identical when the probe cannot run.
//
// sharedServer: the server is shared by many people, so it is no one's own
// computer. The same controls are hidden as on a phone, and settings only an
// admin may change are read-only. False when the field is missing or the
// probe fails, like the rest of the local default.
export interface RemoteClientContext {
	remote: boolean;
	capability: "full" | "read-only";
	sharedServer: boolean;
}

const LOCAL_CONTEXT: RemoteClientContext = { remote: false, capability: "full", sharedServer: false };

let cached: Promise<RemoteClientContext> | null = null;
// The probe's answer once it has come, so a component mounted later starts
// from it instead of from the local default.
let known: RemoteClientContext | null = null;

function readContext(body: unknown): RemoteClientContext {
	const value = (body ?? {}) as Partial<Record<keyof RemoteClientContext, unknown>>;
	return {
		remote: value.remote === true,
		capability: value.capability === "read-only" ? "read-only" : "full",
		sharedServer: value.sharedServer === true,
	};
}

export function fetchRemoteClientContext(): Promise<RemoteClientContext> {
	if (!cached) {
		cached = fetch("/api/remote/client-context")
			.then((res) => (res.ok ? res.json().then(readContext) : LOCAL_CONTEXT))
			.catch(() => LOCAL_CONTEXT)
			.then((context) => (known = context));
	}
	return cached;
}

/**
 * Whether a control that only works on this computer is shown: not on a
 * remote device, and not on a shared server. Every such control asks here,
 * so the two cases always read the same way.
 */
export function showsComputerOnlyControls(context: RemoteClientContext): boolean {
	return !context.remote && !context.sharedServer;
}

/** The one line a read-only setting shows on a shared server. */
export const SHARED_SERVER_ADMIN_LINE = "On a shared server, your admin sets this up.";

export function useRemoteClientContext(): RemoteClientContext {
	const [context, setContext] = useState<RemoteClientContext>(() => known ?? LOCAL_CONTEXT);
	useEffect(() => {
		let alive = true;
		void fetchRemoteClientContext().then((resolved) => {
			if (alive) setContext(resolved);
		});
		return () => {
			alive = false;
		};
	}, []);
	return context;
}
