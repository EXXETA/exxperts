// Loaded with --import into a server a smoke starts (smoke-marked-connector.ts,
// proxyEnv): its fetches follow HTTP_PROXY and NO_PROXY on every Node the repo
// supports, as Node's own NODE_USE_ENV_PROXY does only on newer ones.
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

if (process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent());
