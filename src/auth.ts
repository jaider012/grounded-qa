import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { AuthMode, CognitoSettings } from './config.js';

export interface AuthUser {
  sub: string;
  email?: string;
  isAdmin: boolean;
}

// Extends Express's Request type project-wide with the user attached by the
// auth middleware below (undefined until that middleware has run).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthUser;
    }
  }
}

export interface CognitoVerifierResult {
  sub: string;
  email?: string;
  groups: string[];
}

/** Injectable seam: verifies a Cognito ID token and returns its relevant claims. */
export interface CognitoVerifier {
  verify(idToken: string): Promise<CognitoVerifierResult>;
}

export interface CreateAuthOptions {
  mode: AuthMode;
  /** Required when `mode` is `'cognito'`. */
  cognito?: CognitoSettings;
  /** True when the app should treat cookies as https-only even without a TLS socket (e.g. NODE_ENV=production). */
  isProduction?: boolean;
  /** Defaults to a real `CognitoJwtVerifier` built from `cognito`. */
  verifier?: CognitoVerifier;
  /** Defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Clock seam, accepted for consistency with the rest of the app's injected fakes. */
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

export interface Auth {
  mode: AuthMode;
  /** Mounted at the app root: attaches `req.auth`, enforces protection/CSRF, and serves /auth/* and /api/me. */
  router: Router;
}

const SESSION_COOKIE = 'gqa_session';
const OAUTH_COOKIE = 'gqa_oauth';
const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600;

const EXEMPT_PATHS = new Set(['/healthz', '/auth/login', '/auth/callback', '/auth/logout', '/favicon.svg']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// --- Cookies -----------------------------------------------------------------

interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  /** Seconds. */
  maxAge?: number;
}

/** Parses a `Cookie` request header into a name -> value map. No external cookie library is used. */
function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }

  return cookies;
}

function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAge !== undefined) segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.sameSite) segments.push(`SameSite=${options.sameSite}`);
  if (options.httpOnly) segments.push('HttpOnly');
  if (options.secure) segments.push('Secure');
  return segments.join('; ');
}

function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'Lax', secure });
}

// --- Small helpers -------------------------------------------------------------

/**
 * The externally visible `scheme://host[:port]` for this request. `req.get('host')`
 * always reads the raw `Host` header, ignoring `X-Forwarded-Host`, so behind a
 * trusted reverse proxy (TRUST_PROXY_HOPS > 0, e.g. App Runner) the forwarded
 * host is used instead, matching how `req.protocol` already honors
 * `X-Forwarded-Proto` once proxy hops are trusted.
 */
function originOf(req: Request): string {
  const forwardedHost = req.headers['x-forwarded-host'];
  const trustsProxy = Boolean(req.app.get('trust proxy'));
  const host =
    trustsProxy && typeof forwardedHost === 'string' ? (forwardedHost.split(',')[0] ?? '').trim() : req.get('host');
  return `${req.protocol}://${host}`;
}

function isHttps(req: Request, isProduction: boolean): boolean {
  return req.secure || isProduction;
}

/** Equal-length, constant-time string comparison; unequal lengths are reported unequal without throwing. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function htmlPage(message: string, linkHref: string, linkText: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in</title></head>' +
    `<body><p>${message}</p><p><a href="${linkHref}">${linkText}</a></p></body></html>`
  );
}

// --- Default (real) Cognito verifier --------------------------------------------

function buildDefaultVerifier(cognito: CognitoSettings): CognitoVerifier {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: cognito.userPoolId,
    tokenUse: 'id',
    clientId: cognito.clientId,
  });

  return {
    async verify(idToken: string): Promise<CognitoVerifierResult> {
      const payload = await verifier.verify(idToken);
      const email = typeof payload['email'] === 'string' ? payload['email'] : undefined;
      return { sub: payload.sub, email, groups: payload['cognito:groups'] ?? [] };
    },
  };
}

// --- Cognito mode ----------------------------------------------------------------

interface RuntimeSettings {
  clientId: string;
  clientSecret: string;
  domain: string;
  verifier: CognitoVerifier;
  fetchFn: typeof fetch;
  log: (message: string, error?: unknown) => void;
  isProduction: boolean;
}

function buildCognitoRouter(settings: RuntimeSettings): Router {
  const router = express.Router();

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE];
    let user: AuthUser | undefined;

    if (sessionToken) {
      try {
        const claims = await settings.verifier.verify(sessionToken);
        user = { sub: claims.sub, email: claims.email, isAdmin: claims.groups.includes('admins') };
      } catch {
        // Expired or otherwise invalid: treat as unauthenticated and drop the stale cookie.
        res.append('Set-Cookie', clearCookie(SESSION_COOKIE, isHttps(req, settings.isProduction)));
      }
    }

    req.auth = user;

    if (EXEMPT_PATHS.has(req.path)) {
      next();
      return;
    }

    if (!user) {
      if (req.path.startsWith('/api')) {
        res.status(401).json({ error: 'Sign in to continue.' });
      } else {
        res.redirect(302, '/auth/login');
      }
      return;
    }

    if (req.path.startsWith('/api') && MUTATING_METHODS.has(req.method)) {
      // Fails closed: a browser always sends Origin on a cross-site or
      // same-site fetch/XHR/form POST, so a missing Origin here is not a
      // normal browser request and must be blocked exactly like a wrong
      // one, not silently allowed through.
      const origin = req.headers.origin;
      if (typeof origin !== 'string' || origin !== originOf(req)) {
        res.status(403).json({ error: 'Cross-site request blocked.' });
        return;
      }
    }

    next();
  });

  router.get('/auth/login', (req: Request, res: Response) => {
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    res.append(
      'Set-Cookie',
      serializeCookie(OAUTH_COOKIE, `${state}.${codeVerifier}`, {
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS,
        secure: isHttps(req, settings.isProduction),
      }),
    );

    const authorizeUrl = new URL('/oauth2/authorize', settings.domain);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', settings.clientId);
    authorizeUrl.searchParams.set('redirect_uri', `${originOf(req)}/auth/callback`);
    authorizeUrl.searchParams.set('scope', 'openid email');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    res.redirect(302, authorizeUrl.toString());
  });

  router.get('/auth/callback', async (req: Request, res: Response) => {
    const secure = isHttps(req, settings.isProduction);
    const cookies = parseCookies(req.headers.cookie);
    const oauthCookie = cookies[OAUTH_COOKIE];
    res.append('Set-Cookie', clearCookie(OAUTH_COOKIE, secure));

    const code = typeof req.query['code'] === 'string' ? req.query['code'] : undefined;
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : undefined;

    const invalidRequest = (): void => {
      res
        .status(400)
        .type('html')
        .send(htmlPage('This sign-in link has expired or is invalid.', '/auth/login', 'Try signing in again'));
    };

    if (!oauthCookie || !code || !state) {
      invalidRequest();
      return;
    }

    const separator = oauthCookie.indexOf('.');
    const savedState = separator === -1 ? '' : oauthCookie.slice(0, separator);
    const codeVerifier = separator === -1 ? '' : oauthCookie.slice(separator + 1);

    if (!savedState || !codeVerifier || !timingSafeEqualStrings(savedState, state)) {
      invalidRequest();
      return;
    }

    try {
      const redirectUri = `${originOf(req)}/auth/callback`;
      const basicAuth = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64');

      const tokenResponse = await settings.fetchFn(new URL('/oauth2/token', settings.domain), {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: settings.clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }).toString(),
      });

      if (!tokenResponse.ok) {
        throw new Error(`Token endpoint responded with status ${tokenResponse.status}.`);
      }

      const tokenBody = (await tokenResponse.json()) as { id_token?: unknown; expires_in?: unknown };
      if (typeof tokenBody.id_token !== 'string') {
        throw new Error('Token endpoint response did not include an id_token.');
      }

      // Verifying here (rather than trusting the token endpoint blindly)
      // confirms the issuer, audience, and signature before it ever becomes
      // this browser's session.
      await settings.verifier.verify(tokenBody.id_token);

      const expiresIn = typeof tokenBody.expires_in === 'number' ? tokenBody.expires_in : DEFAULT_TOKEN_EXPIRY_SECONDS;

      res.append(
        'Set-Cookie',
        serializeCookie(SESSION_COOKIE, tokenBody.id_token, {
          httpOnly: true,
          sameSite: 'Lax',
          maxAge: expiresIn,
          secure,
        }),
      );
      res.redirect(302, '/');
    } catch (error) {
      settings.log('Sign-in failed during /auth/callback', error instanceof Error ? error.message : undefined);
      res.status(401).type('html').send(htmlPage('Sign-in failed. Try again.', '/auth/login', 'Try again'));
    }
  });

  router.get('/auth/logout', (req: Request, res: Response) => {
    res.append('Set-Cookie', clearCookie(SESSION_COOKIE, isHttps(req, settings.isProduction)));

    const logoutUrl = new URL('/logout', settings.domain);
    logoutUrl.searchParams.set('client_id', settings.clientId);
    logoutUrl.searchParams.set('logout_uri', `${originOf(req)}/`);

    res.redirect(302, logoutUrl.toString());
  });

  router.get('/api/me', (req: Request, res: Response) => {
    const user = req.auth;
    res.status(200).json({ email: user?.email ?? null, isAdmin: user?.isAdmin ?? false, authMode: 'cognito' });
  });

  return router;
}

// --- None mode ---------------------------------------------------------------

function buildNoneRouter(): Router {
  const router = express.Router();
  const localUser: AuthUser = { sub: 'local', email: 'local', isAdmin: true };

  router.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = localUser;
    next();
  });

  router.get('/api/me', (_req: Request, res: Response) => {
    res.status(200).json({ email: localUser.email, isAdmin: localUser.isAdmin, authMode: 'none' });
  });

  return router;
}

// --- Factory ---------------------------------------------------------------------

/**
 * Builds the auth integration described by `options`. In `cognito` mode this
 * verifies sessions, protects every route except the exempt list, enforces
 * admin/CSRF checks, and serves the OAuth + /api/me routes. In `none` mode it
 * attaches a synthetic local admin and protects nothing (local development
 * and the existing test suite).
 */
export function createAuth(options: CreateAuthOptions): Auth {
  const log = options.log ?? ((message: string, error?: unknown): void => console.error(message, error));

  if (options.mode === 'none') {
    log('Authentication disabled (AUTH_MODE=none)');
    return { mode: 'none', router: buildNoneRouter() };
  }

  const cognito = options.cognito;
  if (!cognito) {
    throw new Error('createAuth: "cognito" settings are required when mode is "cognito".');
  }

  const settings: RuntimeSettings = {
    clientId: cognito.clientId,
    clientSecret: cognito.clientSecret,
    domain: cognito.domain,
    verifier: options.verifier ?? buildDefaultVerifier(cognito),
    fetchFn: options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    log,
    isProduction: options.isProduction ?? false,
  };

  return { mode: 'cognito', router: buildCognitoRouter(settings) };
}
