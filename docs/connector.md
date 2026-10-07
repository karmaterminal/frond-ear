# claude.ai custom connector: the echo step (#53)

`frond-ear connector-echo` is the first, disposable step of #53: a **read-only** MCP server that a
claude.ai custom connector can call, run on a seat behind Tailscale Funnel. It proves what the
connector's transport and auth actually need before the Discord facade is built.

- **It has no Discord access.** No bot token, no daemon socket, no ledger. Its two tools are
  `echo` (returns its text) and `connection_info` (reports what the server saw on that call).
- **It listens on loopback only.** Funnel is the only way in from outside.
- **Every request leaves one `connector.request` JSON line on stderr.** These lines are the proof.
- **State is in memory.** A restart ends every session and sign-in. Claude's next refresh gets
  `invalid_grant`, and the owner approves a new sign-in.

The facade (allowlisted reads, a reply to one configured channel, a send audit log, its own bot
token) is a follow-up PR, shaped by what this proof finds.

## Contents

- [What it speaks](#what-it-speaks)
- [Run it](#run-it)
- [Auth modes and the claude.ai dialog](#auth-modes-and-the-claudeai-dialog)
- [The proof, step by step](#the-proof-step-by-step)
- [What to record on #53](#what-to-record-on-53)
- [Reading the log](#reading-the-log)
- [Security notes](#security-notes)

## What it speaks

One endpoint, `POST /mcp`, answers both eras of MCP's Streamable HTTP transport, so the proof
shows which one Claude uses.

| Era    | Versions                                       | How a request is recognised                                                | Sessions                                                                           |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| legacy | 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 | starts with `initialize`                                                   | `Mcp-Session-Id` from `initialize`, unless `--no-sessions`; `DELETE /mcp` ends one |
| modern | 2026-07-28                                     | `_meta` carries `io.modelcontextprotocol/protocolVersion` on every request | none; `server/discover` instead of `initialize`                                    |

- Results are plain JSON, never an SSE stream. `GET /mcp` is `405`, which both eras allow.
- A modern request must mirror its version, method and tool name into the `MCP-Protocol-Version`,
  `Mcp-Method` and `Mcp-Name` headers. A mismatch is `400` with code `-32020`, and an unknown
  version is `400` with `-32022` and the supported list, as the 2026-07-28 spec asks.
- Other routes: `GET /healthz` (`ok`), and in OAuth mode the authorization server routes listed
  under [oauth](#oauth).

## Run it

```sh
node src/cli.ts connector-echo --public-url https://<host>.<tailnet>.ts.net [auth flags]
```

| Flag                         | Default          | Meaning                                                                                                                                                      |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--listen <host:port>`       | `127.0.0.1:8787` | Loopback only: `127.0.0.1`, `localhost` or `[::1]`. Anything wider is refused. Behind Funnel, use `127.0.0.1`.                                               |
| `--public-url <origin>`      | none             | The https origin Funnel serves, no path. Without it, a request through the tunnel gets `403 Host not allowed`.                                               |
| `--auth none\|bearer\|oauth` | `none`           | See the next section.                                                                                                                                        |
| `--token-file <path>`        |                  | `bearer`: the token, in a 0600 file. At least 32 characters of `A-Z a-z 0-9 - . _ ~ + /`, and `=` only as padding at the end.                                |
| `--owner-secret-file <path>` |                  | `oauth`: the owner passphrase for the consent page, at least 20 characters, in a 0600 file.                                                                  |
| `--client-id <id>`           |                  | `oauth`: a pre-registered client id for the dialog's "Use your own OAuth client". Repeatable.                                                                |
| `--no-dcr`                   |                  | `oauth`: turn off Dynamic Client Registration, to prove the own-client path alone.                                                                           |
| `--allow-loopback-redirect`  |                  | `oauth`: also accept `http://localhost` and `127.0.0.1` redirects on any port, for Claude Code. `--client-id` clients then accept its `/callback` on either. |
| `--allow-origin <origin>`    |                  | Accept one more `Origin` value. Repeatable.                                                                                                                  |
| `--no-sessions`              |                  | Legacy era without sessions.                                                                                                                                 |

Secrets come only from files that only their owner can read. The server refuses a file with any
group or other permission bits, and never takes a secret from argv or the environment. Make one
like this and give its path to the flag:

```sh
umask 077 && openssl rand -base64 33 | tr -d '\n' > ~/.config/frond-ear/connector-token
```

The owner passphrase is what figs pastes on the consent page, so keep it as a POCKET key and say
which one; never put it in a channel or an issue.

Funnel forwards a bare port to `127.0.0.1` only, so a server listening on `[::1]`, or on a
`localhost` that resolves to it, can't be reached through it.

At start it prints the local URL and, with `--public-url`, the URL to give claude.ai:
`claude.ai connector URL: https://<host>/mcp`. Enter that exact string; the OAuth metadata's
`resource` must equal it.

## Auth modes and the claude.ai dialog

The **Add custom connector** dialog ([claude.com docs](https://claude.com/docs/connectors/custom/add-unlisted))
has three settings that matter here: **Authentication**, **OAuth client**, and **Request headers**.
Authentication settings can't be changed later; to switch modes, remove the connector and add it
again.

| `--auth` | Dialog settings                                                                                                                        | Proves                                                                                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`   | Authentication: **No sign-in**                                                                                                         | Transport only. Anyone with the URL can call `echo`, so keep Funnel up only while testing.                                                                                                                                                                                 |
| `bearer` | **No sign-in**, plus **Request headers**: `authorization` with the value `Bearer <token>`, scheme included                             | The request-header option. It is in beta for a limited set of organizations; if the dialog has no Request headers section, use `oauth`. Claude Code can send the same header with `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <token>"`. |
| `oauth`  | **Sign in now**; OAuth client **Register automatically**, or **Use your own OAuth client** with an id from `--client-id` and no secret | Claude's sign-in, which the facade will need: discovery, registration, consent, PKCE, refresh.                                                                                                                                                                             |

### oauth

A single-owner authorization server on the same origin, which Claude discovers from a `401`:

| Route                                                            | What it is                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/.well-known/oauth-protected-resource/mcp` (and without `/mcp`) | RFC 9728 metadata: `resource` is `<public-url>/mcp`, `authorization_servers` is `[<public-url>]`                                                                                                                                                                                                |
| `/.well-known/oauth-authorization-server`                        | RFC 8414 metadata: S256 PKCE, public clients (`none`), `iss` on redirects (RFC 9207)                                                                                                                                                                                                            |
| `POST /register`                                                 | Dynamic Client Registration (RFC 7591). Redirects must be Claude's callback (`https://claude.ai/api/mcp/auth_callback`), or loopback with `--allow-loopback-redirect`. A list with others in it registers only the allowed ones (RFC 7591 3.2.1). Every client is public, whatever it asks for. |
| `GET /authorize`                                                 | The consent page. It names the client (marked self-reported for a registered one) and the host the browser goes back to, and asks for the owner passphrase. While registration is on, a client id with no record here gets the page too, for the redirects a new registration could use.        |
| `POST /token`                                                    | Code exchange (PKCE S256; the client must match, and `redirect_uri` too when sent, since OAuth 2.1 drops it) and refresh.                                                                                                                                                                       |

- Codes are single-use and last 60 s. Access tokens last 1 hour and refresh tokens 30 days.
- Each refresh rotates the refresh token. The same refresh again within 60 s gets the same answer
  (a retry, or two at once). An older refresh token after that ends the whole sign-in.
- Five wrong passphrases from one address lock that address out of the consent page for 15
  minutes. The owner, at another address, can still sign in.
- One address can hold 10 open sign-in requests, and everyone together 100. Past that, the
  oldest gives way, that address's own first.
- The server keeps up to 100 registered clients. A new registration pushes out the oldest one
  with no live sign-in, and a sign-in under way still finishes.
- After a restart, Claude's refresh token gets `invalid_grant`, not `invalid_client`, so Claude
  starts a new sign-in. While registration is on, its old client id gets the consent page again.
- `resource`, when sent, must name this server's `/mcp` URL. It is compared in canonical form,
  because Claude sends it that way (lowercase scheme and host, no default port or trailing slash).
- Claude's recommended dialog option, "Use Claude's published identity" (CIMD), needs metadata
  this server doesn't advertise. Claude's docs say it then falls back to registration, which
  the proof can confirm.

## The proof, step by step

The seat and the princes do steps 1 to 4, 9 and 10; figs does 5 to 8 in claude.ai. Nothing here
is automated.

1. **Choose the host.** Which seat runs it, as which user, and whether it gets its own unit. Funnel
   needs Tailscale 1.38.3 or later, MagicDNS, HTTPS certificates, and the `funnel` node attribute
   in the tailnet policy file ([Tailscale Funnel](https://tailscale.com/kb/1223/funnel)).
2. **Start the server** in tmux or a user unit, with the auth mode under test, for example:

   ```sh
   node src/cli.ts connector-echo --public-url https://<host>.<tailnet>.ts.net \
     --auth oauth --owner-secret-file ~/.config/frond-ear/connector-owner 2>>~/connector-echo.jsonl
   ```

3. **Expose it**: `tailscale funnel --bg 8787`, which forwards to `127.0.0.1:8787`, the default
   `--listen`. Funnel allows only ports 443, 8443 and 10000; on 8443 or 10000, put the port in
   `--public-url`. Public DNS can take up to 10 minutes.
4. **Check it from outside the tailnet**, for example from a phone off Wi-Fi or a cloud shell:
   - `dig +short <host>.<tailnet>.ts.net` returns only public IPv4 addresses. claude.ai refuses
     a name that resolves to any private or 100.64.0.0/10 address, and connectors are IPv4-only.
   - `curl -i https://<host>/healthz` is `200 ok`, and `curl -i https://<host>/mcp` is `405`.
   - In oauth mode, `curl -i -X POST https://<host>/mcp` is `401` with
     `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"`,
     and that URL returns the JSON metadata.
5. **Add the connector** (figs): [Customize > Connectors](https://claude.ai/customize/connectors) >
   **Add custom connector**, URL `https://<host>/mcp`, settings from the table above. For Project 95
   threads, also turn it on under the project's settings, Connectors. Connectors load when a session
   starts, so the test needs a new thread.
6. **Sign in** (oauth): the consent page should say the browser goes back to `claude.ai`. Approve
   with the owner passphrase.
7. **Call both tools** in a new thread: ask Claude to call `echo` with a short text, then
   `connection_info`. Paste the `connection_info` result into #53.
8. **Wait out an access token** (oauth): call a tool again more than an hour after sign-in. Claude
   refreshes up to five minutes before expiry, or on a `401`.
9. **Restart the server** and call a tool once more, to see what Claude does when its session or
   token is gone. In oauth mode, expect a refresh that gets `invalid_grant`, then a new sign-in
   for figs to approve: note whether Claude registers again or reuses its client id.
10. **Take it down**: repeat the Funnel command with `off` at the end (`tailscale funnel --bg 8787 off`),
    stop the server, and remove the connector unless the facade follows soon. Avoid
    `tailscale funnel reset` on a shared host: it clears the node's other Serve and Funnel config too.

## What to record on #53

| Question                                                              | Where it shows                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Which era and version Claude speaks                                   | `era`, `version` and `rpc` in the log; `connection_info`                                 |
| Whether it keeps a session, and whether it sends `DELETE`             | `session` in the log; `connection_info.session`                                          |
| What Claude calls itself, and its capabilities                        | `client` in the log; `connection_info.client` and `clientCapabilities`                   |
| Which headers arrive: `User-Agent`, `Origin`, `X-Forwarded-For`       | `ua`, `origin`, `forwardedFor` and `headers` in the log                                  |
| Whether requests come through Funnel, from Claude's published range   | `tailscale-funnel-request: ?1` in `headers`; `forwardedFor` within 160.79.104.0/21       |
| Whether Claude registers or uses the configured client, and with what | `oauth` lines with `step: "register"`: `clientName`, `redirects`, `authMethod`, `grants` |
| Whether `resource` and `scope` arrive at `/authorize` and `/token`    | `oauth.resource`, `oauth.scope`                                                          |
| When and how it refreshes, and whether refreshes come in pairs        | `oauth` lines with `grant: "refresh_token"` and `outcome` `rotated` or `repeated`        |
| What Claude does after a restart                                      | the `oauth` lines after it: `invalid_grant`, then `register` or the old `client`         |
| Anything refused that shouldn't be                                    | any `403` (Host or Origin) or unexpected `401`/`400`, with its `reason`                  |
| How long tool calls take on this side                                 | `ms`                                                                                     |

If Connect fails with a `403` and the log names an `origin`, restart with `--allow-origin` for that
value. Claude's docs warn that strict Origin checks can reject its requests; record the value on
#53 either way.

## Reading the log

One JSON line per request, after the logger's redaction:

```json
{
  "time": "2026-10-07T12:00:00.000Z",
  "level": "info",
  "event": "connector.request",
  "method": "POST",
  "path": "/mcp",
  "remote": "127.0.0.1",
  "forwardedFor": "<caller address>",
  "ua": "<client user agent>",
  "mcpProtocolVersion": "2025-06-18",
  "headers": [
    "accept: application/json, text/event-stream",
    "authorization: [redacted, 50 chars]",
    "mcp-session-id: [redacted, 32 chars]",
    "..."
  ],
  "auth": "oauth",
  "era": "legacy",
  "rpc": "tools/call",
  "tool": "echo",
  "version": "2025-06-18",
  "session": "1a2b3c4d",
  "client": "<clientInfo name>",
  "status": 200,
  "ms": 2
}
```

- Tool arguments and results are never logged. Neither are tokens, codes or the passphrase:
  header values whose names look like credentials are replaced by their length, and the
  configured secrets are scrubbed from every line.
- `session` is the first 8 hex characters of the session id.
- OAuth routes add an `oauth` object: `step` (`register`, `authorize`, `consent` or `token`),
  `outcome`, a `reason` on failures, and what the client sent.

```sh
jq -c 'select(.event == "connector.request")
  | {time, method, path, status, era, version, rpc, tool, client, auth, origin, forwardedFor, oauth}' \
  ~/connector-echo.jsonl
```

## Security notes

- **Exposure.** The server binds loopback; Funnel publishes it. In `none` mode anyone who finds
  the URL can call `echo`, which only returns its input. The ts.net name is public once HTTPS
  certificates are on (certificate transparency), so keep Funnel up only for the test.
- **DNS rebinding.** `Host` must be the public host (with or without `:443`) or loopback with the
  bound port. A present `Origin` must be the public origin, `https://claude.ai`, `https://claude.com`,
  the server's own loopback origin, or an `--allow-origin` value. Both are checked on every route.
- **Callers.** A caller is the last `X-Forwarded-For` address, the one Funnel set, or else the
  socket's. A process on the host itself can claim any address; one through Funnel can't.
- **Limits.** 120 requests a minute per caller and 600 across all callers (`429` with
  `Retry-After`), 256 KiB MCP bodies, 16 KiB OAuth forms, and short socket timeouts.
- **OAuth.** One owner. Registered clients are public, so the passphrase on the consent page is
  the gate, and the page names the host the browser goes back to. Tokens and codes are stored
  only as SHA-256 digests, except the newest rotation's pair, held for 60 s.
- **Not covered.** CIMD, token persistence across restarts, and per-user identity. A single
  owner is all the facade needs; the proof decides whether CIMD is worth adding.
