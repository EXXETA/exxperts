// Loaded before a kill smoke's server, to make it a shared server with no hook filled.
import { registerServerHooks } from "../src/server-hooks.js";

registerServerHooks({});
