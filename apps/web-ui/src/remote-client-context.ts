import { useEffect, useState } from "react";

// Is this page being viewed from a remote device (over the tunnel), and with
// what capability? Used only to HIDE affordances that cannot work remotely
// (native folder picker, save-to-disk): the server refuses them regardless
// of what the client renders, so failing open to "local" here is safe and
// keeps the loopback experience byte-identical when the probe cannot run.
export interface RemoteClientContext {
	remote: boolean;
	capability: "full" | "read-only";
}

const LOCAL_CONTEXT: RemoteClientContext = { remote: false, capability: "full" };

let cached: Promise<RemoteClientContext> | null = null;

export function fetchRemoteClientContext(): Promise<RemoteClientContext> {
	if (!cached) {
		cached = fetch("/api/remote/client-context")
			.then((res) => (res.ok ? (res.json() as Promise<RemoteClientContext>) : LOCAL_CONTEXT))
			.catch(() => LOCAL_CONTEXT);
	}
	return cached;
}

export function useRemoteClientContext(): RemoteClientContext {
	const [context, setContext] = useState<RemoteClientContext>(LOCAL_CONTEXT);
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
