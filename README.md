# Tabpost

A self-hosted, multi-account IMAP/SMTP webmail client that lives in a browser
tab. React + Vite on the front, an Express IMAP proxy on the back. The server
keeps no credentials and no mail.

## Security model

The service is deliberately open — anyone may use it with their own mail
account. There is no application login, which means **the mail credentials are
the only authentication**. Two consequences drive the design:

1. Every request must prove its credentials. Cached IMAP connections are keyed
   by a hash over the full credential set (including the password), so a request
   with the wrong password can never be served from someone else's open session.
2. Nothing about a mailbox is exposed on the strength of an address alone.
   Real-time event streams require a short-lived token issued only after the
   credentials check out.

Credentials are never stored server-side. They live in the browser's
localStorage and are sent with each request.

### Known residual risks

- **Passwords sit in localStorage in plaintext.** Any XSS in this app hands over
  every configured account. Mail HTML is rendered in a scripts-disabled iframe
  and attachments are always served as `application/octet-stream`, which are the
  two paths that would otherwise lead there.
- **Remote images in mail are loaded**, so senders can see when a message was
  opened.

## Running locally

```bash
npm install
npm run dev
```

## Deploying

```bash
docker compose up -d --build
```

The container builds the client and runs the compiled server. Never run
`npm run dev` in production — the Vite dev server exposes source and a
file-serving surface.

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `NODE_ENV` | — | Must be `production` to serve the built bundle. |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the app. Set correctly, or rate limiting buckets every visitor under the proxy's IP. |
| `MAX_CACHED_CONNECTIONS` | `200` | Upper bound on simultaneously cached IMAP connections. |
| `DEBUG_LOG` | off | Writes redacted log lines to `./search_debug.log`. |
| `ALLOW_PRIVATE_MAIL_HOSTS` | off | ⚠️ Permits mail servers on private/loopback networks. Re-opens SSRF against your own LAN. |
| `ALLOW_SELF_SIGNED_TLS` | off | ⚠️ Accepts invalid mail server certificates. Lets an active network attacker capture users' passwords. |

Both ⚠️ switches exist only for a trusted, non-public deployment.

### Limits enforced

- Mail servers must resolve to public addresses, on standard mail ports only
  (IMAP 143/993, SMTP 25/465/587/2525).
- `/api/verify`: 20 requests per IP per 15 minutes.
- `/api/send`: 100 per IP per hour.
- All `/api` routes: 300 per IP per minute.
- Repeated auth failures against a single address lock that address for 15
  minutes, independent of source IP.

## License

MIT, see [LICENSE](LICENSE).
