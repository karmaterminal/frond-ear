// The connector's single-owner OAuth mode (#53), over a real loopback socket. The official MCP
// SDK's OAuth client stands in for Claude's: discovery, Dynamic Client Registration, PKCE and
// the token exchange are all its code, not ours; the test plays the owner at the consent page.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { CLAUDE_CALLBACKS, OAuthAuthority } from "../src/connector/auth.ts";
import { echoTools } from "../src/connector/echo.ts";
import { createConnectorServer } from "../src/connector/http.ts";
import { StructuredLogger } from "../src/logger.ts";
import { FakeClock } from "./helpers.ts";

const OWNER = "correct horse battery staple 2026";
const CALLBACK = CLAUDE_CALLBACKS[0]!;
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
}

function send(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    // A fresh connection each time: a pooled one can outlive a server the test restarts.
    const req = httpRequest(
      url,
      {
        method: options.method ?? "POST",
        headers: options.headers ?? {},
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Started {
  base: string;
  url: string;
  port: number;
  oauth: OAuthAuthority;
  lines: string[];
  close(): Promise<void>;
}

async function start(
  t: TestContext,
  options: {
    clock?: FakeClock;
    dynamicRegistration?: boolean;
    clientIds?: string[];
    loopbackRedirects?: boolean;
    /** A port to come back on, as after a restart. */
    port?: number;
  } = {},
): Promise<Started> {
  // The issuer needs the port before the server listens, so probe for a free one, and try
  // again if something takes it in between.
  for (let attempt = 1; ; attempt += 1) {
    const port = options.port ?? (await freePort());
    const base = `http://127.0.0.1:${port}`;
    const oauth = new OAuthAuthority({
      publicUrl: base,
      ownerSecret: OWNER,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.dynamicRegistration === undefined
        ? {}
        : { dynamicRegistration: options.dynamicRegistration }),
      ...(options.clientIds ? { clientIds: options.clientIds } : {}),
      ...(options.loopbackRedirects ? { loopbackRedirects: true } : {}),
    });
    const lines: string[] = [];
    const connector = createConnectorServer({
      tools: echoTools(),
      auth: oauth,
      publicUrl: base,
      logger: new StructuredLogger((line) => lines.push(line), [OWNER]),
    });
    try {
      await connector.listen("127.0.0.1", port);
    } catch (error) {
      if (
        options.port === undefined &&
        attempt < 5 &&
        (error as { code?: string }).code === "EADDRINUSE"
      ) {
        continue;
      }
      throw error;
    }
    t.after(() => connector.close());
    return {
      base,
      url: `${base}/mcp`,
      port,
      oauth,
      lines,
      close: () => connector.close(),
    };
  }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function register(
  base: string,
  metadata: Record<string, unknown> = {},
): Promise<Answer> {
  return send(`${base}/register`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...metadata,
    }),
  });
}

function authorizeUrl(
  base: string,
  clientId: string,
  challenge: string,
  overrides: Record<string, string | null> = {},
): string {
  const url = new URL(`${base}/authorize`);
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource: `${base}/mcp`,
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) {
      url.searchParams.set(key, value);
    }
  }
  return url.href;
}

function requestIdFrom(page: string): string {
  const found = /name="request" value="([^"]+)"/u.exec(page);
  assert.ok(found, "the consent page carries a request id");
  return found[1]!;
}

function decide(
  base: string,
  requestId: string,
  passphrase: string,
  decision = "approve",
  from = "198.51.100.4",
): Promise<Answer> {
  // A browser sends the page's own origin with the form (see the consent page's
  // Referrer-Policy).
  return send(`${base}/authorize`, {
    headers: { ...FORM, origin: new URL(base).origin, "x-forwarded-for": from },
    body: new URLSearchParams({
      request: requestId,
      passphrase,
      decision,
    }).toString(),
  });
}

function token(base: string, params: Record<string, string>): Promise<Answer> {
  return send(`${base}/token`, {
    headers: FORM,
    body: new URLSearchParams(params).toString(),
  });
}

/**
 * Registers, consents and exchanges the code: what Claude and the owner do together. Given
 * a client id, it signs in again with that one, as Claude does with its registration.
 */
async function signIn(
  base: string,
  existingClientId?: string,
): Promise<{ clientId: string; access: string; refresh: string }> {
  const clientId =
    existingClientId ?? ((await register(base)).json.client_id as string);
  const { verifier, challenge } = pkce();
  const consent = await send(authorizeUrl(base, clientId, challenge), {
    method: "GET",
  });
  const approved = await decide(base, requestIdFrom(consent.text), OWNER);
  assert.equal(approved.status, 302, approved.text);
  const code = new URL(String(approved.headers.location)).searchParams.get(
    "code",
  )!;
  const exchanged = await token(base, {
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    client_id: clientId,
    code_verifier: verifier,
    resource: `${base}/mcp`,
  });
  assert.equal(exchanged.status, 200, exchanged.text);
  return {
    clientId,
    access: exchanged.json.access_token,
    refresh: exchanged.json.refresh_token,
  };
}

function mcpWith(url: string, accessToken: string): Promise<Answer> {
  return send(url, {
    headers: { ...JSON_HEADERS, authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    }),
  });
}

/** The SDK's OAuthClientProvider, in memory: what Claude keeps per connection. */
class MemoryProvider {
  public authorizationUrl: URL | undefined;
  private information: unknown;
  private saved: { access_token: string } | undefined;
  private verifier = "";

  public get redirectUrl(): string {
    return CALLBACK;
  }

  public get clientMetadata(): Record<string, unknown> {
    return {
      client_name: "Claude",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  public clientInformation(): unknown {
    return this.information;
  }

  public saveClientInformation(information: unknown): void {
    this.information = information;
  }

  public tokens(): { access_token: string } | undefined {
    return this.saved;
  }

  public saveTokens(tokens: { access_token: string }): void {
    this.saved = tokens;
  }

  public redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  public saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  public codeVerifier(): string {
    return this.verifier;
  }
}

type AuthProvider = NonNullable<
  NonNullable<
    ConstructorParameters<typeof StreamableHTTPClientTransport>[1]
  >["authProvider"]
>;

function transportFor(
  url: string,
  provider: MemoryProvider,
): StreamableHTTPClientTransport {
  // MemoryProvider implements the parts of OAuthClientProvider the SDK calls here.
  return new StreamableHTTPClientTransport(new URL(url), {
    authProvider: provider as unknown as AuthProvider,
  });
}

function connect(
  client: Client,
  transport: StreamableHTTPClientTransport,
): Promise<void> {
  return client.connect(transport as Parameters<Client["connect"]>[0]);
}

test("discovery: the metadata says what Claude's client checks before it signs in", async (t) => {
  const server = await start(t);
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    const resource = await send(`${server.base}${path}`, { method: "GET" });
    assert.equal(resource.status, 200);
    assert.equal(
      resource.json.resource,
      server.url,
      "resource is exactly the MCP URL",
    );
    assert.deepEqual(resource.json.authorization_servers, [server.base]);
  }
  const issuer = await send(
    `${server.base}/.well-known/oauth-authorization-server`,
    { method: "GET" },
  );
  assert.equal(issuer.status, 200);
  assert.equal(issuer.json.issuer, server.base);
  assert.equal(issuer.json.registration_endpoint, `${server.base}/register`);
  assert.deepEqual(issuer.json.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(issuer.json.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(issuer.json.grant_types_supported, [
    "authorization_code",
    "refresh_token",
  ]);
  assert.equal(
    issuer.json.authorization_response_iss_parameter_supported,
    true,
  );
});

test("an MCP request without a token is a 401 that points at the resource metadata", async (t) => {
  const server = await start(t);
  const answer = await send(server.url, {
    headers: JSON_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  });
  assert.equal(answer.status, 401);
  assert.equal(
    answer.headers["www-authenticate"],
    `Bearer resource_metadata="${server.base}/.well-known/oauth-protected-resource/mcp"`,
  );
  const garbage = await mcpWith(server.url, "not-a-token");
  assert.equal(garbage.status, 401);
  assert.match(
    String(garbage.headers["www-authenticate"]),
    /error="invalid_token"/u,
  );
});

test("the MCP SDK's OAuth client registers, gets consent, exchanges with PKCE and calls echo", async (t) => {
  const server = await start(t);
  const provider = new MemoryProvider();

  const first = new Client({ name: "sdk-oauth", version: "1.0.0" });
  t.after(() => first.close());
  const firstTransport = transportFor(server.url, provider);
  await assert.rejects(connect(first, firstTransport), /Unauthorized/u);
  const authorize = provider.authorizationUrl;
  assert.ok(authorize, "the SDK sent the browser to /authorize");
  assert.equal(
    authorize.origin + authorize.pathname,
    `${server.base}/authorize`,
  );
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("resource"), server.url);
  assert.match(
    authorize.searchParams.get("client_id") ?? "",
    /^dcr-/u,
    "registered dynamically",
  );

  const consent = await send(authorize.href, { method: "GET" });
  assert.equal(consent.status, 200);
  assert.match(
    consent.headers["content-security-policy"] as string,
    /frame-ancestors 'none'/u,
  );
  assert.match(
    consent.text,
    /claude\.ai/u,
    "the page names where the browser goes next",
  );
  assert.doesNotMatch(consent.text, /any program there can listen on it/u);
  assert.equal(
    consent.headers["referrer-policy"],
    "same-origin",
    "under no-referrer a browser would send Origin: null with the form",
  );
  const nullOrigin = await send(`${server.base}/authorize`, {
    headers: { ...FORM, origin: "null" },
    body: new URLSearchParams({
      request: requestIdFrom(consent.text),
      passphrase: OWNER,
      decision: "approve",
    }).toString(),
  });
  assert.equal(nullOrigin.status, 403, "which the Origin check refuses");
  const approved = await decide(
    server.base,
    requestIdFrom(consent.text),
    OWNER,
  );
  assert.equal(approved.status, 302);
  const back = new URL(String(approved.headers.location));
  assert.equal(back.origin + back.pathname, CALLBACK);
  assert.equal(
    back.searchParams.get("iss"),
    server.base,
    "RFC 9207 issuer on the redirect",
  );

  await firstTransport.finishAuth(back.searchParams.get("code")!);
  assert.ok(provider.tokens()?.access_token);

  const second = new Client({ name: "sdk-oauth", version: "1.0.0" });
  t.after(() => second.close());
  await connect(second, transportFor(server.url, provider));
  const echoed = await second.callTool({
    name: "echo",
    arguments: { text: "signed in" },
  });
  assert.equal((echoed as any).content[0].text, "signed in");
  const info = JSON.parse(
    ((await second.callTool({ name: "connection_info", arguments: {} })) as any)
      .content[0].text,
  );
  assert.equal(info.auth.mode, "oauth");
  assert.equal(info.auth.clientName, "Claude");
  assert.ok(info.auth.expiresInSeconds > 3_500);
  const log = server.lines.join("\n");
  assert.ok(
    !log.includes(provider.tokens()!.access_token),
    "no access token in the log",
  );
  assert.ok(!log.includes(OWNER), "no passphrase in the log");
  assert.ok(
    !log.includes(back.searchParams.get("code")!),
    "no code in the log",
  );

  // Each OAuth step leaves what the client asked for in its request's log line.
  const steps = server.lines
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.oauth)
    .map((entry) => entry.oauth);
  assert.deepEqual(
    steps.map((step) => `${step.step}:${step.outcome}`),
    [
      "register:registered",
      "authorize:consent page",
      "consent:code issued",
      "token:issued",
    ],
  );
  const [registered, authorized, consented, exchanged] = steps;
  assert.equal(registered.clientName, "Claude");
  assert.deepEqual(registered.redirects, [CALLBACK]);
  assert.equal(registered.authMethod, "none");
  assert.match(registered.client, /^dcr-/u);
  assert.equal(authorized.resource, server.url);
  assert.equal(authorized.challengeMethod, "S256");
  assert.equal(exchanged.grant, "authorization_code");
  assert.equal(exchanged.clientVia, "form");
  assert.equal(consented.client, registered.client);
  assert.equal(exchanged.client, registered.client);
});

test("the stateless MCP era works with an OAuth token, and connection_info names the client", async (t) => {
  const server = await start(t);
  const { clientId, access } = await signIn(server.base);
  const version = "2026-07-28";
  const call = (headers: Record<string, string>): Promise<Answer> =>
    send(server.url, {
      headers: {
        ...JSON_HEADERS,
        "mcp-protocol-version": version,
        "mcp-method": "tools/call",
        "mcp-name": "connection_info",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "connection_info",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  const anonymous = await call({});
  assert.equal(anonymous.status, 401);
  assert.match(
    String(anonymous.headers["www-authenticate"]),
    /resource_metadata=/u,
  );
  const answer = await call({ authorization: `Bearer ${access}` });
  assert.equal(answer.status, 200, answer.text);
  const info = JSON.parse(answer.json.result.content[0].text);
  assert.equal(info.era, "modern");
  assert.equal(info.session, null);
  assert.equal(info.auth.mode, "oauth");
  assert.equal(info.auth.clientId, clientId);
  assert.ok(!answer.text.includes(access), "the token is never echoed");
});

test("consent: a wrong passphrase is refused, five lock it for the window, and deny says so", async (t) => {
  const server = await start(t);
  const clientId = (await register(server.base)).json.client_id as string;
  const { challenge } = pkce();
  const consent = await send(authorizeUrl(server.base, clientId, challenge), {
    method: "GET",
  });
  const requestId = requestIdFrom(consent.text);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await decide(
      server.base,
      requestId,
      `not the passphrase ${attempt}`,
    );
    assert.equal(wrong.status, 401);
    assert.match(wrong.text, /Wrong passphrase/u);
    assert.equal(wrong.headers.location, undefined);
  }
  const locked = await decide(server.base, requestId, OWNER);
  assert.equal(
    locked.status,
    429,
    "even the right passphrase waits out the lock",
  );

  const denied = await decide(server.base, requestId, "", "deny");
  assert.equal(denied.status, 302);
  const back = new URL(String(denied.headers.location));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), "state-123");
  const replay = await decide(server.base, requestId, OWNER);
  assert.equal(replay.status, 400, "a decided request can't be decided again");
});

test("consent: an approved request can't be approved again", async (t) => {
  const server = await start(t);
  const clientId = (await register(server.base)).json.client_id as string;
  const consent = await send(
    authorizeUrl(server.base, clientId, pkce().challenge),
    { method: "GET" },
  );
  const requestId = requestIdFrom(consent.text);
  assert.equal((await decide(server.base, requestId, OWNER)).status, 302);
  const twice = await decide(server.base, requestId, OWNER);
  assert.equal(twice.status, 400);
  assert.equal(twice.headers.location, undefined, "no second code");
});

test("consent: wrong passphrases lock out only the address they came from, counting the last 15 minutes", async (t) => {
  const clock = new FakeClock(1_000_000);
  const server = await start(t, { clock });
  const clientId = (await register(server.base)).json.client_id as string;
  const openConsent = async (): Promise<string> =>
    requestIdFrom(
      (
        await send(authorizeUrl(server.base, clientId, pkce().challenge), {
          method: "GET",
        })
      ).text,
    );
  const guess = async (
    requestId: string,
    passphrase: string,
  ): Promise<number> =>
    (await decide(server.base, requestId, passphrase, "approve", "203.0.113.7"))
      .status;

  const guessed = await openConsent();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(await guess(guessed, `a guess ${attempt}`), 401);
  }
  clock.advance(9 * 60_000);
  assert.equal(await guess(guessed, "a fifth guess"), 401);
  assert.equal(
    await guess(guessed, OWNER),
    429,
    "five wrong within 15 minutes lock the address, even for the right passphrase",
  );
  const owners = await openConsent();
  assert.equal(
    (await decide(server.base, owners, OWNER)).status,
    302,
    "the owner, at another address, still signs in",
  );

  clock.advance(7 * 60_000);
  assert.equal(
    await guess(await openConsent(), "one more guess"),
    401,
    "the first four are now older than 15 minutes, so the lock is over",
  );
});

test("authorize: unregistered redirects never redirect; an unknown client gets consent only while registration is open; bad requests redirect with an error", async (t) => {
  const server = await start(t);
  const clientId = (await register(server.base)).json.client_id as string;
  const { challenge } = pkce();

  const unknown = await send(
    authorizeUrl(server.base, "dcr-registered-before-a-restart", challenge),
    { method: "GET" },
  );
  assert.equal(
    unknown.status,
    200,
    "registration is open, so an id with no record may do what a fresh one could",
  );
  assert.match(unknown.text, /no record of/u);
  const unknownElsewhere = await send(
    authorizeUrl(server.base, "dcr-registered-before-a-restart", challenge, {
      redirect_uri: "https://evil.example/cb",
    }),
    { method: "GET" },
  );
  assert.equal(unknownElsewhere.status, 400);
  assert.equal(unknownElsewhere.headers.location, undefined);
  const garbled = await send(
    authorizeUrl(server.base, "<script>", challenge, { client_id: "a b" }),
    { method: "GET" },
  );
  assert.equal(garbled.status, 400, "an implausible client id is refused");
  const elsewhere = await send(
    authorizeUrl(server.base, clientId, challenge, {
      redirect_uri: "https://evil.example/cb",
    }),
    { method: "GET" },
  );
  assert.equal(elsewhere.status, 400);
  assert.equal(elsewhere.headers.location, undefined);

  const canonical = await send(
    authorizeUrl(server.base, clientId, challenge, {
      resource: `${server.base.toUpperCase()}/mcp/`,
    }),
    { method: "GET" },
  );
  assert.equal(
    canonical.status,
    200,
    "resource compares in canonical form (case of scheme and host, trailing slash)",
  );
  for (const [overrides, error] of [
    [{ code_challenge: null }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ resource: "https://other.example/mcp" }, "invalid_target"],
    [{ resource: `${server.base}/other` }, "invalid_target"],
  ] as const) {
    const answer = await send(
      authorizeUrl(server.base, clientId, challenge, overrides),
      { method: "GET" },
    );
    assert.equal(answer.status, 302, JSON.stringify(overrides));
    const back = new URL(String(answer.headers.location));
    assert.equal(back.origin + back.pathname, CALLBACK);
    assert.equal(back.searchParams.get("error"), error);
  }
});

test("authorize: a stranger opening many sign-ins can't push out the owner's", async (t) => {
  const server = await start(t);
  const clientId = (await register(server.base)).json.client_id as string;
  const openFrom = async (from: string): Promise<string> =>
    requestIdFrom(
      (
        await send(authorizeUrl(server.base, clientId, pkce().challenge), {
          method: "GET",
          headers: { "x-forwarded-for": from },
        })
      ).text,
    );
  const owners = await openFrom("198.51.100.4");
  const strangers: string[] = [];
  for (let opened = 0; opened < 100; opened += 1) {
    strangers.push(await openFrom("203.0.113.7"));
  }
  assert.equal(
    (await decide(server.base, owners, OWNER)).status,
    302,
    "the owner's request is still open",
  );
  assert.equal(
    (await decide(server.base, strangers[0]!, OWNER)).status,
    400,
    "the stranger's own oldest requests made room",
  );
  assert.equal(
    (await decide(server.base, strangers.at(-1)!, OWNER)).status,
    302,
  );
});

test("token: PKCE, single-use codes, redirect_uri, client and resource are all checked", async (t) => {
  const server = await start(t);
  const clientId = (await register(server.base)).json.client_id as string;
  const { verifier, challenge } = pkce();
  async function freshCode(): Promise<string> {
    const consent = await send(authorizeUrl(server.base, clientId, challenge), {
      method: "GET",
    });
    const approved = await decide(
      server.base,
      requestIdFrom(consent.text),
      OWNER,
    );
    return new URL(String(approved.headers.location)).searchParams.get("code")!;
  }
  const exchange = (
    code: string,
    overrides: Record<string, string> = {},
  ): Promise<Answer> =>
    token(server.base, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      ...overrides,
    });

  const wrongVerifier = await exchange(await freshCode(), {
    code_verifier: pkce().verifier,
  });
  assert.equal(wrongVerifier.status, 400);
  assert.equal(wrongVerifier.json.error, "invalid_grant");
  const failed = JSON.parse(server.lines.at(-1)!).oauth;
  assert.equal(failed.outcome, "invalid_grant");
  assert.match(failed.reason, /code_verifier/u);

  const wrongRedirect = await exchange(await freshCode(), {
    redirect_uri: "https://claude.ai/api/mcp/other_callback",
  });
  assert.equal(wrongRedirect.json.error, "invalid_grant");

  const withoutRedirect = await token(server.base, {
    grant_type: "authorization_code",
    code: await freshCode(),
    client_id: clientId,
    code_verifier: verifier,
  });
  assert.equal(
    withoutRedirect.status,
    200,
    "OAuth 2.1 leaves redirect_uri out of the token request",
  );

  const wrongResource = await exchange(await freshCode(), {
    resource: "https://other.example/mcp",
  });
  assert.equal(wrongResource.json.error, "invalid_target");

  const otherClient = await exchange(await freshCode(), {
    client_id: "dcr-someone-else",
  });
  assert.equal(otherClient.status, 400);
  assert.equal(otherClient.json.error, "invalid_grant");
  const noClient = await token(server.base, {
    grant_type: "authorization_code",
    code: await freshCode(),
    code_verifier: verifier,
  });
  assert.equal(noClient.status, 401);
  assert.equal(noClient.json.error, "invalid_client");

  const basic = await send(`${server.base}/token`, {
    headers: {
      ...FORM,
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: await freshCode(),
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(
    basic.status,
    200,
    "the client may name itself in a Basic header",
  );
  assert.equal(JSON.parse(server.lines.at(-1)!).oauth.clientVia, "basic");

  const code = await freshCode();
  const good = await exchange(code);
  assert.equal(good.status, 200);
  assert.equal(good.json.token_type, "Bearer");
  assert.equal(good.json.expires_in, 3600);
  assert.equal(good.headers["cache-control"], "no-store");
  const again = await exchange(code);
  assert.equal(again.json.error, "invalid_grant", "a code works once");

  const asJson = await send(`${server.base}/token`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: await freshCode(),
    }),
  });
  assert.equal(asJson.status, 400);
  const unsupported = await token(server.base, {
    grant_type: "client_credentials",
    client_id: clientId,
  });
  assert.equal(unsupported.json.error, "unsupported_grant_type");
});

test("refresh rotates; the same refresh within a minute gets the same answer; an older one ends the sign-in", async (t) => {
  const clock = new FakeClock(1_000_000);
  const server = await start(t, { clock });
  const refresh = (refreshToken: string, clientId: string): Promise<Answer> =>
    token(server.base, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
  const first = await signIn(server.base);
  assert.equal((await mcpWith(server.url, first.access)).status, 200);

  const rotated = await refresh(first.refresh, first.clientId);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.json.refresh_token, first.refresh);
  assert.notEqual(rotated.json.access_token, first.access);
  assert.equal(
    (await mcpWith(server.url, rotated.json.access_token)).status,
    200,
  );

  clock.advance(59_000);
  const repeated = await refresh(first.refresh, first.clientId);
  assert.equal(repeated.status, 200, "a retry within the minute");
  assert.equal(repeated.json.refresh_token, rotated.json.refresh_token);
  assert.equal(repeated.json.access_token, rotated.json.access_token);
  assert.equal(repeated.json.expires_in, 3_600 - 59);

  clock.advance(1_000);
  const replay = await refresh(first.refresh, first.clientId);
  assert.equal(replay.json.error, "invalid_grant");
  assert.match(replay.json.error_description, /reused/u);
  assert.equal(
    (await mcpWith(server.url, rotated.json.access_token)).status,
    401,
    "the family is revoked",
  );
  assert.equal(
    (await refresh(rotated.json.refresh_token, first.clientId)).json.error,
    "invalid_grant",
  );

  const second = await signIn(server.base);
  const two = await refresh(second.refresh, second.clientId);
  const three = await refresh(two.json.refresh_token, second.clientId);
  assert.equal(three.status, 200);
  const older = await refresh(second.refresh, second.clientId);
  assert.equal(
    older.json.error,
    "invalid_grant",
    "two rotations back is a replay even within the minute",
  );
  assert.equal(
    (await mcpWith(server.url, three.json.access_token)).status,
    401,
  );

  const other = await signIn(server.base);
  const elsewhere = await token(server.base, {
    grant_type: "refresh_token",
    refresh_token: other.refresh,
    client_id: other.clientId,
    resource: "https://other.example/mcp",
  });
  assert.equal(elsewhere.json.error, "invalid_target");
  const crossClient = await refresh(other.refresh, first.clientId);
  assert.equal(
    crossClient.json.error,
    "invalid_grant",
    "a refresh token stays with its client",
  );
  const forged = await refresh(`${other.refresh}x`, other.clientId);
  assert.equal(forged.json.error, "invalid_grant");
  assert.equal(
    (await mcpWith(server.url, other.access)).status,
    401,
    "a token that is not the live one, with a live family id, ends the sign-in",
  );
});

test("after a restart the old refresh token is invalid_grant, and Claude signs in again with its old client id", async (t) => {
  const before = await start(t);
  const old = await signIn(before.base);
  await before.close();
  const after = await start(t, { port: before.port });

  const refreshed = await token(after.base, {
    grant_type: "refresh_token",
    refresh_token: old.refresh,
    client_id: old.clientId,
    resource: after.url,
  });
  assert.equal(refreshed.status, 400);
  assert.equal(
    refreshed.json.error,
    "invalid_grant",
    "a dead grant, not a dead client, so Claude starts a new sign-in",
  );
  assert.equal((await mcpWith(after.url, old.access)).status, 401);

  const again = await signIn(after.base, old.clientId);
  assert.equal(again.clientId, old.clientId);
  assert.equal((await mcpWith(after.url, again.access)).status, 200);
  const rotated = await token(after.base, {
    grant_type: "refresh_token",
    refresh_token: again.refresh,
    client_id: old.clientId,
  });
  assert.equal(rotated.status, 200, rotated.text);
});

test("access tokens expire after an hour and codes after a minute", async (t) => {
  const clock = new FakeClock(1_000_000);
  const server = await start(t, { clock });
  const session = await signIn(server.base);
  clock.advance(60 * 60_000 - 1);
  assert.equal((await mcpWith(server.url, session.access)).status, 200);
  clock.advance(1);
  const expired = await mcpWith(server.url, session.access);
  assert.equal(expired.status, 401);
  assert.match(
    String(expired.headers["www-authenticate"]),
    /error="invalid_token"/u,
  );

  const clientId = (await register(server.base)).json.client_id as string;
  const { verifier, challenge } = pkce();
  const consent = await send(authorizeUrl(server.base, clientId, challenge), {
    method: "GET",
  });
  const approved = await decide(
    server.base,
    requestIdFrom(consent.text),
    OWNER,
  );
  const code = new URL(String(approved.headers.location)).searchParams.get(
    "code",
  )!;
  clock.advance(60_001);
  const late = await token(server.base, {
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    client_id: clientId,
    code_verifier: verifier,
  });
  assert.equal(late.json.error, "invalid_grant");
});

test("registration: only Claude's callbacks unless loopback is allowed, which matches any port", async (t) => {
  const server = await start(t);
  const foreign = await register(server.base, {
    redirect_uris: ["https://evil.example/cb"],
  });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.json.error, "invalid_redirect_uri");
  const mixed = await register(server.base, {
    redirect_uris: ["https://evil.example/cb", CALLBACK],
  });
  assert.equal(mixed.status, 201, "RFC 7591 3.2.1: register less than asked");
  assert.deepEqual(mixed.json.redirect_uris, [CALLBACK]);
  const dropped = await send(
    authorizeUrl(server.base, mixed.json.client_id, pkce().challenge, {
      redirect_uri: "https://evil.example/cb",
    }),
    { method: "GET" },
  );
  assert.equal(dropped.status, 400);
  assert.equal(dropped.headers.location, undefined);
  const loopbackRefused = await register(server.base, {
    redirect_uris: ["http://localhost:4567/callback"],
  });
  assert.equal(loopbackRefused.status, 400);
  const secretClient = await register(server.base, {
    token_endpoint_auth_method: "client_secret_post",
  });
  assert.equal(secretClient.status, 201);
  assert.equal(
    secretClient.json.token_endpoint_auth_method,
    "none",
    "every client is public",
  );
  assert.equal(secretClient.json.client_secret, undefined);
  const notJson = await send(`${server.base}/register`, {
    headers: FORM,
    body: "client_name=x",
  });
  assert.equal(notJson.status, 400);

  const loopback = await start(t, { loopbackRedirects: true });
  const registered = await register(loopback.base, {
    redirect_uris: ["http://localhost:4567/callback"],
  });
  assert.equal(registered.status, 201);
  const { challenge } = pkce();
  const otherPort = await send(
    authorizeUrl(loopback.base, registered.json.client_id, challenge, {
      redirect_uri: "http://localhost:9999/callback",
    }),
    { method: "GET" },
  );
  assert.equal(
    otherPort.status,
    200,
    "RFC 8252: a loopback redirect matches on any port",
  );
  assert.match(
    otherPort.text,
    /any program there can listen on it/u,
    "the consent page warns about a loopback redirect",
  );
  const otherPath = await send(
    authorizeUrl(loopback.base, registered.json.client_id, challenge, {
      redirect_uri: "http://localhost:9999/elsewhere",
    }),
    { method: "GET" },
  );
  assert.equal(otherPath.status, 400, "but not on another path");
});

test("registration: a flood of registrations can't break a sign-in under way or one that is done", async (t) => {
  const server = await start(t);
  const done = await signIn(server.base);
  const clientId = (await register(server.base)).json.client_id as string;
  const { verifier, challenge } = pkce();
  const consent = await send(authorizeUrl(server.base, clientId, challenge), {
    method: "GET",
  });
  for (let registered = 0; registered < 100; registered += 1) {
    const flood = await send(`${server.base}/register`, {
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.7",
      },
      body: JSON.stringify({ redirect_uris: [CALLBACK] }),
    });
    assert.equal(flood.status, 201);
  }
  const forgotten = await send(
    authorizeUrl(server.base, clientId, pkce().challenge),
    { method: "GET" },
  );
  assert.match(forgotten.text, /no record of/u, "the new client was evicted");
  const kept = await send(
    authorizeUrl(server.base, done.clientId, pkce().challenge),
    { method: "GET" },
  );
  assert.match(
    kept.text,
    /registered itself as/u,
    "a client with a live sign-in is never evicted",
  );

  const approved = await decide(
    server.base,
    requestIdFrom(consent.text),
    OWNER,
  );
  assert.equal(approved.status, 302, "the request carries its client id");
  const exchanged = await token(server.base, {
    grant_type: "authorization_code",
    code: new URL(String(approved.headers.location)).searchParams.get("code")!,
    client_id: clientId,
    code_verifier: verifier,
  });
  assert.equal(exchanged.status, 200, exchanged.text);
  const refreshed = await token(server.base, {
    grant_type: "refresh_token",
    refresh_token: done.refresh,
    client_id: done.clientId,
  });
  assert.equal(refreshed.status, 200, refreshed.text);
});

test("a pre-registered client id works with registration turned off", async (t) => {
  const server = await start(t, {
    dynamicRegistration: false,
    clientIds: ["frond-ear-claude"],
  });
  const issuer = await send(
    `${server.base}/.well-known/oauth-authorization-server`,
    { method: "GET" },
  );
  assert.equal(issuer.json.registration_endpoint, undefined);
  assert.equal((await register(server.base)).status, 404);
  const stranger = await send(
    authorizeUrl(server.base, "dcr-made-up", pkce().challenge),
    { method: "GET" },
  );
  assert.equal(stranger.status, 400, "with registration off, no unknown ids");
  assert.equal(stranger.headers.location, undefined);
  const strangerToken = await token(server.base, {
    grant_type: "refresh_token",
    refresh_token: "x.y",
    client_id: "dcr-made-up",
  });
  assert.equal(strangerToken.status, 401);
  assert.equal(strangerToken.json.error, "invalid_client");

  const { verifier, challenge } = pkce();
  const consent = await send(
    authorizeUrl(server.base, "frond-ear-claude", challenge),
    { method: "GET" },
  );
  assert.equal(consent.status, 200);
  assert.match(consent.text, /pre-registered client/u);
  const approved = await decide(
    server.base,
    requestIdFrom(consent.text),
    OWNER,
  );
  const code = new URL(String(approved.headers.location)).searchParams.get(
    "code",
  )!;
  const exchanged = await token(server.base, {
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    client_id: "frond-ear-claude",
    code_verifier: verifier,
  });
  assert.equal(exchanged.status, 200);
});

test("a pre-registered client gets Claude Code's loopback callbacks, on any port, only when loopback is allowed", async (t) => {
  const options = { dynamicRegistration: false, clientIds: ["claude-code"] };
  const { challenge } = pkce();
  const ask = (base: string, redirect: string): Promise<Answer> =>
    send(
      authorizeUrl(base, "claude-code", challenge, { redirect_uri: redirect }),
      { method: "GET" },
    );
  const loopback = await start(t, { ...options, loopbackRedirects: true });
  for (const redirect of [
    "http://localhost:53682/callback",
    "http://127.0.0.1:41000/callback",
    CALLBACK,
  ]) {
    assert.equal((await ask(loopback.base, redirect)).status, 200, redirect);
  }
  for (const redirect of [
    "http://localhost:53682/elsewhere",
    "http://127.0.0.1:41000/callback?x=1",
    "http://[::1]:41000/callback",
    "https://localhost:53682/callback",
  ]) {
    const refused = await ask(loopback.base, redirect);
    assert.equal(refused.status, 400, redirect);
    assert.equal(refused.headers.location, undefined);
  }
  const plain = await start(t, options);
  assert.equal(
    (await ask(plain.base, "http://localhost:53682/callback")).status,
    400,
  );
  assert.equal((await ask(plain.base, CALLBACK)).status, 200);
});

test("the consent page escapes what a client says about itself", async (t) => {
  const server = await start(t);
  const clientId = (
    await register(server.base, {
      client_name: `<script>alert("x")</script><img src=x>`,
    })
  ).json.client_id as string;
  const consent = await send(
    authorizeUrl(server.base, clientId, pkce().challenge),
    { method: "GET" },
  );
  assert.equal(consent.status, 200);
  assert.ok(!consent.text.includes("<script>"));
  assert.ok(!consent.text.includes("<img"));
  assert.match(
    consent.text,
    /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/u,
  );
  assert.match(consent.text, /self-reported/u);
});

test("OAuthAuthority refuses a public URL with a path, plain http off loopback, or a short passphrase", () => {
  assert.throws(
    () =>
      new OAuthAuthority({
        publicUrl: "https://a.example/mcp",
        ownerSecret: OWNER,
      }),
    /origin/u,
  );
  assert.throws(
    () =>
      new OAuthAuthority({ publicUrl: "http://a.example", ownerSecret: OWNER }),
    /https/u,
  );
  assert.throws(
    () =>
      new OAuthAuthority({
        publicUrl: "https://a.example",
        ownerSecret: "short",
      }),
    /20 characters/u,
  );
});
