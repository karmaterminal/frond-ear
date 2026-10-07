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
    const req = httpRequest(
      url,
      { method: options.method ?? "POST", headers: options.headers ?? {} },
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
  oauth: OAuthAuthority;
  lines: string[];
}

async function start(
  t: TestContext,
  options: {
    clock?: FakeClock;
    dynamicRegistration?: boolean;
    clientIds?: string[];
    loopbackRedirects?: boolean;
  } = {},
): Promise<Started> {
  const port = await freePort();
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
  await connector.listen("127.0.0.1", port);
  t.after(() => connector.close());
  return { base, url: `${base}/mcp`, oauth, lines };
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
): Promise<Answer> {
  return send(`${base}/authorize`, {
    headers: FORM,
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

/** Registers, consents and exchanges the code: what Claude and the owner do together. */
async function signIn(
  base: string,
): Promise<{ clientId: string; access: string; refresh: string }> {
  const clientId = (await register(base)).json.client_id as string;
  const { verifier, challenge } = pkce();
  const consent = await send(authorizeUrl(base, clientId, challenge), {
    method: "GET",
  });
  const approved = await decide(base, requestIdFrom(consent.text), OWNER);
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

test("authorize: unknown clients and unregistered redirects never redirect; bad requests do, with an error", async (t) => {
  const server = await start(t);
  const clientId = (await register(server.base)).json.client_id as string;
  const { challenge } = pkce();

  const unknown = await send(authorizeUrl(server.base, "dcr-nope", challenge), {
    method: "GET",
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.location, undefined);
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
    redirect_uri: CLAUDE_CALLBACKS[1]!,
  });
  assert.equal(wrongRedirect.json.error, "invalid_grant");

  const wrongResource = await exchange(await freshCode(), {
    resource: "https://other.example/mcp",
  });
  assert.equal(wrongResource.json.error, "invalid_target");

  const unknownClient = await exchange(await freshCode(), {
    client_id: "dcr-nope",
  });
  assert.equal(unknownClient.status, 401);
  assert.equal(unknownClient.json.error, "invalid_client");

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
