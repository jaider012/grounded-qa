import { createAuth } from './auth.js';
import type { Auth } from './auth.js';
import { createLimits } from './limits.js';
import type { Limits } from './limits.js';
import { loadAuthSettings, loadLimitsSettings, loadTrustProxyHops } from './config.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface RuntimeDeps {
  auth: Auth;
  limits: Limits;
  /** Number of reverse-proxy hops to trust, forwarded to `createApp`. */
  trustProxyHops: number;
}

export interface LoadRuntimeDepsOptions {
  log?: (message: string, error?: unknown) => void;
  /** Clock seam forwarded to the daily ask cap, for tests. */
  now?: () => Date;
}

/**
 * Reads `AUTH_MODE`/`COGNITO_*`, the abuse-limit variables, and
 * `TRUST_PROXY_HOPS` from `env` and builds the `auth`, `limits`, and
 * `trustProxyHops` dependencies `createApp` needs to run with real
 * protection in production. Any configuration problem surfaces as a
 * `ConfigError` (see `src/config.ts`), exactly like `loadConfig`, so
 * `server.ts` can print the message and exit instead of booting the app
 * unprotected.
 */
export function loadRuntimeDeps(env: Env, options: LoadRuntimeDepsOptions = {}): RuntimeDeps {
  const authSettings = loadAuthSettings(env);
  const limitsSettings = loadLimitsSettings(env);
  const trustProxyHops = loadTrustProxyHops(env);
  const isProduction = (env['NODE_ENV'] ?? '').trim() === 'production';

  const auth = createAuth({
    mode: authSettings.mode,
    cognito: authSettings.mode === 'cognito' ? authSettings.cognito : undefined,
    isProduction,
    log: options.log,
  });

  const limits = createLimits(limitsSettings, { now: options.now });

  return { auth, limits, trustProxyHops };
}
