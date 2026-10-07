// Connector auth (#53). claude.ai offers three ways in for a custom connector (claude.com
// docs, "Authentication for connectors"): no auth, a fixed request header (beta, only for
// some organizations), and OAuth 2.0 with a per-user sign-in. This file has one of each:
//
// - none:   anyone with the URL. Proves transport only.
// - bearer: `Authorization: Bearer <token>` from a 0600 file, for the request-header beta
//           and for Claude Code's `--header`.
// - oauth:  a single-owner authorization server on the same origin. Claude registers itself
//           (Dynamic Client Registration) or uses a pre-registered client id; the consent
//           page asks for the owner passphrase; tokens need PKCE S256 and refresh rotates.
//
// Tokens and codes are stored only as SHA-256 digests and found by digest; the passphrase
// and PKCE verifiers are compared with timingSafeEqual. The one exception: the newest
// rotation's token pair is held for a minute, so a refresh that is retried or sent twice
// at once gets the same answer. State is in memory: a restart signs everyone out.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { systemClock, type Clock } from "../types.ts";
import type { HttpReply } from "./http.ts";
import type { Principal } from "./mcp.ts";

export const MCP_RESOURCE_PATH = "/mcp";

export type AuthCheck =
  | { ok: true; principal: Principal }
  | { ok: false; challenge: string; reason: string };

export interface Authenticator {
  readonly mode: "none" | "bearer" | "oauth";
  /** Set in OAuth mode: the routes beside /mcp. */
  readonly oauth?: OAuthAuthority;
  check(header: string | undefined): AuthCheck;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function digestHex(value: string): string {
  return digest(value).toString("hex");
}

function sameSecret(given: string, expected: Buffer): boolean {
  return timingSafeEqual(digest(given), expected);
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function bearerFrom(header: string | undefined): string | undefined {
  const match = /^Bearer[ \t]+([A-Za-z0-9\-._~+/]+=*)[ \t]*$/iu.exec(
    header ?? "",
  );
  return match?.[1];
}

export class NoAuth implements Authenticator {
  public readonly mode = "none" as const;

  public check(): AuthCheck {
    return { ok: true, principal: { mode: "none" } };
  }
}

export class BearerAuth implements Authenticator {
  public readonly mode = "bearer" as const;
  private readonly expected: Buffer;

  public constructor(token: string) {
    if (token.length < 32) {
      throw new Error("the bearer token must be at least 32 characters");
    }
    this.expected = digest(token);
  }

  public check(header: string | undefined): AuthCheck {
    const given = bearerFrom(header);
    if (given === undefined) {
      return {
        ok: false,
        challenge: 'Bearer realm="frond-ear-connector"',
        reason: "missing bearer token",
      };
    }
    if (!sameSecret(given, this.expected)) {
      return {
        ok: false,
        challenge: 'Bearer realm="frond-ear-connector", error="invalid_token"',
        reason: "invalid bearer token",
      };
    }
    return { ok: true, principal: { mode: "bearer" } };
  }
}

// ---- OAuth ---------------------------------------------------------------------------------

/** Where claude.ai, Desktop, mobile and Cowork send the browser back (claude.com docs). */
export const CLAUDE_CALLBACKS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

const CODE_TTL_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** How long the same refresh token gets the same answer again (a retry after a timeout). */
const REFRESH_REPEAT_MS = 60_000;
const MAX_CLIENTS = 100;
const MAX_PENDING = 100;
/** Wrong passphrases allowed per window before consent locks for the rest of it. */
const CONSENT_FAILURES = 5;
const CONSENT_WINDOW_MS = 15 * 60_000;

interface Client {
  clientId: string;
  name: string | undefined;
  redirectUris: string[];
  registered: "dynamic" | "configured";
  createdAt: number;
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scope: string | undefined;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string | undefined;
  expiresAt: number;
}

/** An access token's grant. */
interface Grant {
  clientId: string;
  scope: string | undefined;
  family: string;
  expiresAt: number;
}

/**
 * One sign-in: the chain of refresh tokens that rotation makes. Each refresh token starts
 * with its family id, and only the newest is live. An older one coming back means a copy
 * exists somewhere, so the whole sign-in ends (OAuth 2.1 4.3.1, refresh token rotation).
 */
interface Family {
  clientId: string;
  scope: string | undefined;
  /** Digest of the one live refresh token. */
  current: string;
  expiresAt: number;
  /** The newest rotation, held for REFRESH_REPEAT_MS. */
  last:
    | {
        from: string;
        at: number;
        access: string;
        refresh: string;
        accessExpiresAt: number;
      }
    | undefined;
}

/** Log facts for one OAuth step (see HttpReply.note). Keys avoid the logger's redaction list. */
type Note = Record<string, unknown>;

/** A client-supplied value, cut down for a log line. */
function clip(value: unknown, length = 200): string | undefined {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, length)
    : undefined;
}

function clipList(value: unknown, length = 200): string[] | undefined {
  return Array.isArray(value)
    ? value.slice(0, 5).map((item) => clip(String(item), length) ?? "")
    : undefined;
}

function withNote(reply: HttpReply, note: Note): HttpReply {
  return { ...reply, note: { ...note, ...reply.note } };
}

export interface OAuthOptions {
  /** The public origin, e.g. https://silas.example.ts.net. It is also the issuer. */
  publicUrl: string;
  /** The owner passphrase the consent page asks for. */
  ownerSecret: string;
  /** Allow Dynamic Client Registration (RFC 7591). Default true. */
  dynamicRegistration?: boolean;
  /** Pre-registered public client ids ("Use your own OAuth client" in claude.ai). */
  clientIds?: readonly string[];
  /** Also accept http://localhost, 127.0.0.1 and [::1] redirects on any port (Claude Code). */
  loopbackRedirects?: boolean;
  clock?: Clock;
}

function htmlEscape(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

/**
 * Claude sends `resource` in canonical form: lowercase scheme and host, no default port, no
 * trailing slash, no fragment (claude.com docs, "Audience mismatch"). Compare in that form
 * rather than byte for byte.
 */
function sameResource(given: string, expected: string): boolean {
  try {
    const url = new URL(given);
    return (
      `${url.origin}${url.pathname.replace(/\/+$/u, "")}${url.search}` ===
      expected
    );
  } catch {
    return false;
  }
}

function isLoopbackRedirect(uri: URL): boolean {
  return (
    uri.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname)
  );
}

/** RFC 7636 code_verifier: 43-128 characters of [A-Z a-z 0-9 - . _ ~]. */
function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/u.test(verifier)) {
    return false;
  }
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return (
    computed.length === challenge.length &&
    timingSafeEqual(Buffer.from(computed), Buffer.from(challenge))
  );
}

function oauthError(
  status: number,
  error: string,
  description: string,
): HttpReply {
  return {
    status,
    headers: { "content-type": "application/json", pragma: "no-cache" },
    body: JSON.stringify({ error, error_description: description }),
    note: { outcome: error, reason: description },
  };
}

function tokenReply(
  access: string,
  refresh: string,
  expiresInMs: number,
  scope: string | undefined,
  outcome: string,
): HttpReply {
  return {
    status: 200,
    headers: { "content-type": "application/json", pragma: "no-cache" },
    body: JSON.stringify({
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.round(expiresInMs / 1_000)),
      refresh_token: refresh,
      ...(scope === undefined ? {} : { scope }),
    }),
    note: { outcome },
  };
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  // No scripts, no framing (clickjacking), no external loads. form-action stays open: a
  // CSP form-action also restricts the redirect that follows the POST.
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function page(
  status: number,
  title: string,
  inner: string,
  outcome: string,
): HttpReply {
  return {
    status,
    headers: PAGE_HEADERS,
    note: { outcome },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem}code{word-break:break-all}input[type=password]{width:100%;font-size:1rem;padding:.4rem}button{font-size:1rem;padding:.4rem 1rem;margin:.6rem .4rem 0 0}.warn{color:#a00}</style></head><body><h1>${htmlEscape(title)}</h1>${inner}</body></html>`,
  };
}

export class OAuthAuthority implements Authenticator {
  public readonly mode = "oauth" as const;
  public readonly issuer: string;
  /** The MCP endpoint URL: the `resource` in the metadata and in token requests. */
  public readonly resource: string;
  public readonly resourceMetadataUrl: string;
  private readonly ownerSecret: Buffer;
  private readonly dynamicRegistration: boolean;
  private readonly loopbackRedirects: boolean;
  private readonly clock: Clock;
  private readonly clients = new Map<string, Client>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, Grant>();
  private readonly families = new Map<string, Family>();
  private consentFailures: number[] = [];

  public constructor(options: OAuthOptions) {
    const url = new URL(options.publicUrl);
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new Error("the public URL must be an origin, with no path");
    }
    if (url.protocol !== "https:" && !isLoopbackRedirect(url)) {
      throw new Error(
        "the public URL must be https (or loopback http for tests)",
      );
    }
    if (options.ownerSecret.length < 20) {
      throw new Error("the owner passphrase must be at least 20 characters");
    }
    this.issuer = url.origin;
    this.resource = `${url.origin}${MCP_RESOURCE_PATH}`;
    this.resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
    this.ownerSecret = digest(options.ownerSecret);
    this.dynamicRegistration = options.dynamicRegistration ?? true;
    this.loopbackRedirects = options.loopbackRedirects ?? false;
    this.clock = options.clock ?? systemClock;
    for (const clientId of options.clientIds ?? []) {
      this.clients.set(clientId, {
        clientId,
        name: undefined,
        redirectUris: [...CLAUDE_CALLBACKS],
        registered: "configured",
        createdAt: this.clock.now(),
      });
    }
  }

  public get oauth(): OAuthAuthority {
    return this;
  }

  // ---- the resource server side --------------------------------------------------------

  public check(header: string | undefined): AuthCheck {
    const challenge = `Bearer resource_metadata="${this.resourceMetadataUrl}"`;
    const token = bearerFrom(header);
    if (token === undefined) {
      // A 401 with resource_metadata is what starts Claude's sign-in (RFC 9728).
      return { ok: false, challenge, reason: "sign-in required" };
    }
    const grant = this.accessTokens.get(digestHex(token));
    if (!grant || grant.expiresAt <= this.clock.now()) {
      if (grant) {
        this.accessTokens.delete(digestHex(token));
      }
      return {
        ok: false,
        challenge: `Bearer error="invalid_token", error_description="expired or unknown token", resource_metadata="${this.resourceMetadataUrl}"`,
        reason: "expired or unknown token",
      };
    }
    return {
      ok: true,
      principal: {
        mode: "oauth",
        clientId: grant.clientId,
        clientName: this.clients.get(grant.clientId)?.name,
        scope: grant.scope,
        expiresAt: grant.expiresAt,
      },
    };
  }

  // ---- discovery -----------------------------------------------------------------------

  public isMetadataPath(path: string): boolean {
    return (
      path === "/.well-known/oauth-protected-resource" ||
      path === `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}` ||
      path === "/.well-known/oauth-authorization-server"
    );
  }

  public metadata(path: string): Record<string, unknown> {
    if (path === "/.well-known/oauth-authorization-server") {
      return {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        ...(this.dynamicRegistration
          ? { registration_endpoint: `${this.issuer}/register` }
          : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      };
    }
    // RFC 9728 protected resource metadata. `resource` must equal the URL entered in Claude.
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
      resource_name: "frond-ear connector",
    };
  }

  // ---- Dynamic Client Registration (RFC 7591) ------------------------------------------

  public register(raw: string, contentType: string): HttpReply {
    const note: Note = { step: "register" };
    return withNote(this.registerClient(raw, contentType, note), note);
  }

  /** Fills `note` with what the client asked for as it reads the request. */
  private registerClient(
    raw: string,
    contentType: string,
    note: Note,
  ): HttpReply {
    if (!this.dynamicRegistration) {
      return {
        status: 404,
        headers: {},
        body: undefined,
        note: { outcome: "registration off" },
      };
    }
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return oauthError(
        400,
        "invalid_client_metadata",
        "send application/json",
      );
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(raw);
    } catch {
      return oauthError(400, "invalid_client_metadata", "body is not JSON");
    }
    if (typeof metadata !== "object" || metadata === null) {
      return oauthError(
        400,
        "invalid_client_metadata",
        "body is not an object",
      );
    }
    const fields = metadata as Record<string, unknown>;
    // What the client asked for, as the proof on #53 wants to see it.
    note.clientName = clip(fields.client_name, 100);
    note.redirects = clipList(fields.redirect_uris);
    note.authMethod = clip(fields.token_endpoint_auth_method, 40);
    note.grants = clipList(fields.grant_types, 40);
    note.scope = clip(fields.scope);
    const redirects = fields.redirect_uris;
    if (
      !Array.isArray(redirects) ||
      redirects.length === 0 ||
      redirects.length > 5 ||
      !redirects.every(
        (uri) => typeof uri === "string" && this.redirectAllowed(uri),
      )
    ) {
      return oauthError(
        400,
        "invalid_redirect_uri",
        `redirect_uris must be 1-5 of: ${CLAUDE_CALLBACKS.join(", ")}${this.loopbackRedirects ? ", or a loopback http URI" : ""}`,
      );
    }
    const grantTypes = fields.grant_types;
    if (
      grantTypes !== undefined &&
      (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code"))
    ) {
      return oauthError(
        400,
        "invalid_client_metadata",
        "grant_types must include authorization_code",
      );
    }
    const responseTypes = fields.response_types;
    if (
      responseTypes !== undefined &&
      (!Array.isArray(responseTypes) ||
        responseTypes.some((type) => type !== "code"))
    ) {
      return oauthError(
        400,
        "invalid_client_metadata",
        'response_types must be ["code"]',
      );
    }
    if (!this.makeRoomForClient()) {
      return oauthError(
        503,
        "temporarily_unavailable",
        "too many registered clients with live sign-ins",
      );
    }
    const name = clip(fields.client_name, 100);
    const client: Client = {
      clientId: `dcr-${randomBytes(12).toString("base64url")}`,
      name,
      redirectUris: redirects as string[],
      registered: "dynamic",
      createdAt: this.clock.now(),
    };
    this.clients.set(client.clientId, client);
    // Every client is public: whatever auth method was asked for, the answer is "none".
    return {
      status: 201,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt / 1_000),
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(name === undefined ? {} : { client_name: name }),
      }),
      note: { client: client.clientId, outcome: "registered" },
    };
  }

  /** Evicts the oldest dynamic client with no live sign-in, if the table is full. */
  private makeRoomForClient(): boolean {
    if (this.clients.size < MAX_CLIENTS) {
      return true;
    }
    const now = this.clock.now();
    const live = new Set(
      [...this.families.values()]
        .filter((family) => family.expiresAt > now)
        .map((family) => family.clientId),
    );
    for (const client of this.clients.values()) {
      if (client.registered === "dynamic" && !live.has(client.clientId)) {
        this.clients.delete(client.clientId);
        return true;
      }
    }
    return false;
  }

  private redirectAllowed(uri: string): boolean {
    if (CLAUDE_CALLBACKS.includes(uri)) {
      return true;
    }
    if (!this.loopbackRedirects) {
      return false;
    }
    try {
      return isLoopbackRedirect(new URL(uri));
    } catch {
      return false;
    }
  }

  /** Exact match, except that a loopback redirect matches whatever its port (RFC 8252 7.3). */
  private redirectMatches(client: Client, uri: string): boolean {
    if (client.redirectUris.includes(uri)) {
      return true;
    }
    if (!this.loopbackRedirects) {
      return false;
    }
    let requested: URL;
    try {
      requested = new URL(uri);
    } catch {
      return false;
    }
    if (!isLoopbackRedirect(requested)) {
      return false;
    }
    return client.redirectUris.some((registered) => {
      try {
        const candidate = new URL(registered);
        return (
          isLoopbackRedirect(candidate) &&
          candidate.hostname === requested.hostname &&
          candidate.pathname === requested.pathname &&
          candidate.search === requested.search
        );
      } catch {
        return false;
      }
    });
  }

  // ---- authorization endpoint ----------------------------------------------------------

  public authorizeGet(query: URLSearchParams): HttpReply {
    this.prune();
    return withNote(this.authorizeRequest(query), {
      step: "authorize",
      client: clip(query.get("client_id"), 80),
      redirect: clip(query.get("redirect_uri")),
      resource: clip(query.get("resource")) ?? "(none)",
      scope: clip(query.get("scope")),
      challengeMethod: clip(query.get("code_challenge_method"), 20),
    });
  }

  private authorizeRequest(query: URLSearchParams): HttpReply {
    const clientId = query.get("client_id") ?? "";
    const redirectUri = query.get("redirect_uri") ?? "";
    const client = this.clients.get(clientId);
    if (!client) {
      return page(
        400,
        "Sign-in refused",
        "<p>Unknown client. Remove the connector in Claude and add it again.</p>",
        "unknown client",
      );
    }
    if (!this.redirectMatches(client, redirectUri)) {
      // Never redirect to a URI that is not registered (RFC 6749 4.1.2.1).
      return page(
        400,
        "Sign-in refused",
        "<p>The redirect URI is not registered for this client.</p>",
        "redirect not registered",
      );
    }
    const state = query.get("state") ?? undefined;
    const fail = (error: string, description: string): HttpReply =>
      this.redirect(redirectUri, {
        error,
        error_description: description,
        state,
      });
    if (query.get("response_type") !== "code") {
      return fail("unsupported_response_type", "only response_type=code");
    }
    const challenge = query.get("code_challenge") ?? "";
    if (
      query.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9\-_]{43}$/u.test(challenge)
    ) {
      return fail(
        "invalid_request",
        "PKCE with code_challenge_method=S256 is required",
      );
    }
    const resource = query.get("resource");
    if (resource !== null && !sameResource(resource, this.resource)) {
      return fail("invalid_target", `resource must be ${this.resource}`);
    }
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) {
        this.pending.delete(oldest);
      }
    }
    const requestId = newToken();
    this.pending.set(requestId, {
      clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      scope: query.get("scope") ?? undefined,
      expiresAt: this.clock.now() + PENDING_TTL_MS,
    });
    return this.consentPage(requestId, client, redirectUri, undefined);
  }

  private consentPage(
    requestId: string,
    client: Client,
    redirectUri: string,
    warning: string | undefined,
  ): HttpReply {
    const target = new URL(redirectUri);
    const who =
      client.registered === "configured"
        ? `the pre-registered client <code>${htmlEscape(client.clientId)}</code>`
        : `a client that registered itself as <code>${htmlEscape(client.name ?? "(no name)")}</code> (self-reported)`;
    return page(
      warning ? 401 : 200,
      "Allow access to the frond-ear connector?",
      `${warning ? `<p class="warn">${htmlEscape(warning)}</p>` : ""}<p>${who} asks to use <code>${htmlEscape(this.resource)}</code>.</p><p>Approving sends your browser back to <strong>${htmlEscape(target.host)}</strong> (<code>${htmlEscape(redirectUri)}</code>). Approve only if you just pressed Connect there.</p>${isLoopbackRedirect(target) ? `<p class="warn">This address is on the computer that signs in, and any program there can listen on it. Approve only if you just started this sign-in from Claude Code.</p>` : ""}<form method="post" action="/authorize"><input type="hidden" name="request" value="${requestId}"><label>Owner passphrase<br><input type="password" name="passphrase" autocomplete="current-password" autofocus></label><br><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form>`,
      warning ? "wrong passphrase" : "consent page",
    );
  }

  public authorizePost(form: URLSearchParams): HttpReply {
    this.prune();
    // Read before deciding: a decision removes the pending request.
    const client = this.pending.get(form.get("request") ?? "")?.clientId;
    return withNote(this.decideConsent(form), { step: "consent", client });
  }

  private decideConsent(form: URLSearchParams): HttpReply {
    const requestId = form.get("request") ?? "";
    const pending = this.pending.get(requestId);
    const client = pending ? this.clients.get(pending.clientId) : undefined;
    if (!pending || !client) {
      return page(
        400,
        "Sign-in expired",
        "<p>This sign-in request has expired. Press Connect in Claude again.</p>",
        "expired",
      );
    }
    if (form.get("decision") !== "approve") {
      this.pending.delete(requestId);
      return this.redirect(pending.redirectUri, {
        error: "access_denied",
        error_description: "the owner denied the request",
        state: pending.state,
      });
    }
    const now = this.clock.now();
    this.consentFailures = this.consentFailures.filter(
      (at) => now - at < CONSENT_WINDOW_MS,
    );
    if (this.consentFailures.length >= CONSENT_FAILURES) {
      return page(
        429,
        "Too many attempts",
        "<p>Too many wrong passphrases. Wait 15 minutes and press Connect again.</p>",
        "locked",
      );
    }
    if (!sameSecret(form.get("passphrase") ?? "", this.ownerSecret)) {
      this.consentFailures.push(now);
      return this.consentPage(
        requestId,
        client,
        pending.redirectUri,
        "Wrong passphrase.",
      );
    }
    this.pending.delete(requestId);
    const code = newToken();
    this.codes.set(digestHex(code), {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scope: pending.scope,
      expiresAt: now + CODE_TTL_MS,
    });
    return this.redirect(pending.redirectUri, { code, state: pending.state });
  }

  private redirect(
    redirectUri: string,
    params: Record<string, string | undefined>,
  ): HttpReply {
    const location = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        location.searchParams.set(key, value);
      }
    }
    // RFC 9207: name the issuer, so a client talking to several servers can't be mixed up.
    location.searchParams.set("iss", this.issuer);
    return {
      status: 302,
      headers: { location: location.href },
      body: undefined,
      note: { outcome: params.error ?? "code issued" },
    };
  }

  // ---- token endpoint ------------------------------------------------------------------

  public token(
    form: URLSearchParams,
    basicHeader: string | undefined,
  ): HttpReply {
    this.prune();
    const fromForm = form.get("client_id");
    const clientId = fromForm ?? this.basicClientId(basicHeader);
    return withNote(this.tokenRequest(form, clientId), {
      step: "token",
      grant: clip(form.get("grant_type"), 40),
      client: clip(clientId, 80),
      clientVia:
        fromForm !== null ? "form" : clientId !== undefined ? "basic" : "none",
      resource: clip(form.get("resource")) ?? "(none)",
    });
  }

  private tokenRequest(
    form: URLSearchParams,
    clientId: string | undefined,
  ): HttpReply {
    if (!clientId || !this.clients.has(clientId)) {
      return oauthError(401, "invalid_client", "unknown client_id");
    }
    const resource = form.get("resource");
    if (resource !== null && !sameResource(resource, this.resource)) {
      return oauthError(
        400,
        "invalid_target",
        `resource must be ${this.resource}`,
      );
    }
    switch (form.get("grant_type")) {
      case "authorization_code":
        return this.exchangeCode(form, clientId);
      case "refresh_token":
        return this.refresh(form, clientId);
      default:
        return oauthError(
          400,
          "unsupported_grant_type",
          "authorization_code or refresh_token",
        );
    }
  }

  private basicClientId(header: string | undefined): string | undefined {
    const match = /^Basic[ \t]+([A-Za-z0-9+/]+=*)$/iu.exec(header ?? "");
    if (!match) {
      return undefined;
    }
    const id = Buffer.from(match[1]!, "base64").toString("utf8").split(":")[0];
    try {
      return id ? decodeURIComponent(id) : undefined;
    } catch {
      return undefined;
    }
  }

  private exchangeCode(form: URLSearchParams, clientId: string): HttpReply {
    const key = digestHex(form.get("code") ?? "");
    const code = this.codes.get(key);
    // Single use: gone whether or not the rest checks out.
    this.codes.delete(key);
    if (!code || code.expiresAt <= this.clock.now()) {
      return oauthError(400, "invalid_grant", "unknown, used or expired code");
    }
    if (
      code.clientId !== clientId ||
      code.redirectUri !== form.get("redirect_uri")
    ) {
      return oauthError(
        400,
        "invalid_grant",
        "code was issued to another client or redirect_uri",
      );
    }
    if (!pkceMatches(form.get("code_verifier") ?? "", code.codeChallenge)) {
      return oauthError(
        400,
        "invalid_grant",
        "code_verifier does not match code_challenge",
      );
    }
    const familyId = randomBytes(16).toString("base64url");
    const family: Family = {
      clientId,
      scope: code.scope,
      current: "",
      expiresAt: 0,
      last: undefined,
    };
    this.families.set(familyId, family);
    return this.rotate(familyId, family, undefined);
  }

  private refresh(form: URLSearchParams, clientId: string): HttpReply {
    const presented = form.get("refresh_token") ?? "";
    const familyId = presented.slice(0, Math.max(0, presented.indexOf(".")));
    const family = this.families.get(familyId);
    const now = this.clock.now();
    if (!family || family.expiresAt <= now) {
      return oauthError(
        400,
        "invalid_grant",
        "unknown or expired refresh token",
      );
    }
    if (family.clientId !== clientId) {
      return oauthError(
        400,
        "invalid_grant",
        "refresh token was issued to another client",
      );
    }
    const presentedDigest = digestHex(presented);
    if (presentedDigest === family.current) {
      return this.rotate(familyId, family, presentedDigest);
    }
    const last = family.last;
    if (
      last &&
      last.from === presentedDigest &&
      now - last.at < REFRESH_REPEAT_MS
    ) {
      // The same refresh again, retried or sent twice at once: the same answer.
      return tokenReply(
        last.access,
        last.refresh,
        last.accessExpiresAt - now,
        family.scope,
        "repeated",
      );
    }
    // An older refresh token came back: someone holds a copy. End the whole sign-in.
    this.revokeFamily(familyId);
    return oauthError(
      400,
      "invalid_grant",
      "refresh token reused; sign in again",
    );
  }

  /** Issues the family's next token pair; the refresh token it came from stops being live. */
  private rotate(
    familyId: string,
    family: Family,
    from: string | undefined,
  ): HttpReply {
    const now = this.clock.now();
    const access = newToken();
    const refresh = `${familyId}.${newToken()}`;
    this.accessTokens.set(digestHex(access), {
      clientId: family.clientId,
      scope: family.scope,
      family: familyId,
      expiresAt: now + ACCESS_TTL_MS,
    });
    family.current = digestHex(refresh);
    family.expiresAt = now + REFRESH_TTL_MS;
    family.last =
      from === undefined
        ? undefined
        : {
            from,
            at: now,
            access,
            refresh,
            accessExpiresAt: now + ACCESS_TTL_MS,
          };
    return tokenReply(
      access,
      refresh,
      ACCESS_TTL_MS,
      family.scope,
      from === undefined ? "issued" : "rotated",
    );
  }

  private revokeFamily(familyId: string): void {
    this.families.delete(familyId);
    for (const [key, grant] of this.accessTokens) {
      if (grant.family === familyId) {
        this.accessTokens.delete(key);
      }
    }
  }

  private prune(): void {
    const now = this.clock.now();
    for (const store of [
      this.pending,
      this.codes,
      this.accessTokens,
      this.families,
    ]) {
      for (const [key, entry] of store) {
        if (entry.expiresAt <= now) {
          store.delete(key);
        }
      }
    }
    for (const family of this.families.values()) {
      if (family.last && now - family.last.at >= REFRESH_REPEAT_MS) {
        family.last = undefined;
      }
    }
  }
}
