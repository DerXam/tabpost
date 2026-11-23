import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import fs from 'fs';

const app = express();
const PORT = 3000;

// ---------------------------------------------------------------------------
// Configuration
//
// This service is intentionally open: anyone may use it with their own mail
// credentials. That makes the *credentials themselves* the only authentication,
// so every request must be able to prove them. The settings below keep an open
// deployment from being abused as an SSRF pivot, a port scanner, or a relay for
// credential-stuffing attacks against third-party mail providers.
// ---------------------------------------------------------------------------

// Allow connecting to mail servers on private/loopback networks. Only enable
// this for a trusted, non-public deployment — it re-opens SSRF against your LAN.
const ALLOW_PRIVATE_MAIL_HOSTS = process.env.ALLOW_PRIVATE_MAIL_HOSTS === 'true';

// Accept mail servers presenting invalid/self-signed TLS certificates. Enabling
// this allows an active network attacker to capture users' mail passwords.
const ALLOW_SELF_SIGNED_TLS = process.env.ALLOW_SELF_SIGNED_TLS === 'true';

// Verbose file logging. Off by default: log lines describe other people's
// mailboxes, so they are redacted and not persisted unless explicitly requested.
const DEBUG_LOG = process.env.DEBUG_LOG === 'true';

// Upper bound on simultaneously cached IMAP connections across all users.
const MAX_CACHED_CONNECTIONS = Number(process.env.MAX_CACHED_CONNECTIONS || 200);

// Number of reverse proxies in front of this app, so req.ip is the real client.
const TRUST_PROXY = Number(process.env.TRUST_PROXY || 0);
if (TRUST_PROXY > 0) {
  app.set('trust proxy', TRUST_PROXY);
}

// Ports a mail server is allowed to live on. Without this the account payload
// turns the server into an arbitrary TCP port scanner.
const IMAP_PORTS = new Set([143, 993]);
const SMTP_PORTS = new Set([25, 465, 587, 2525]);

app.disable('x-powered-by');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Mail passwords sit in localStorage, so an XSS bug would hand over every
// account. This policy is the second line of defence: only our own bundled
// scripts may run, and scripts may only talk to this server, so injected code
// can neither start nor send anything out.
//
// The mail view is a srcdoc iframe, which inherits this policy. That is why
// images and fonts may come from anywhere (remote images in mail) and inline
// styles are allowed (mail HTML is full of them). Neither can run code.
//
// Production only: the Vite dev server needs inline scripts and a websocket.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Credentials used to travel in query strings; make sure no URL ever leaks
  // to a third party via the Referer header.
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (IS_PRODUCTION) res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  next();
});

// Composing a mail with attachments needs a large body; nothing else does.
// A 25mb limit on every unauthenticated endpoint is a cheap memory DoS.
app.use('/api/send', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '1mb' }));

// Forwarding re-uploads the attachments through /api/send, so the set we hand
// to the compose form has to fit back inside that body limit once base64'd.
const MAX_FORWARD_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Active IMAP connection cache to "hold connection open at same time".
// Keyed by a hash over the *full* credentials, so a cached connection can never
// be handed to a request that did not present the correct password.
const connectionCache = new Map<string, { client: ImapFlow; activeTime: number; email: string }>();

// Active SSE Clients for real-time notifications
const sseClients = new Map<string, express.Response[]>();

// Redact an address for logging: other people's mail is not ours to record.
function maskEmail(email?: string): string {
  const raw = String(email || '').trim();
  const at = raw.lastIndexOf('@');
  if (at <= 0) return 'unknown';
  const user = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const head = user.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, user.length - head.length))}@${domain}`;
}

// Global logger. Never pass subjects, search terms, recipients or raw addresses
// in here — use maskEmail() and counts instead.
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (DEBUG_LOG) {
    fs.appendFile('./search_debug.log', line + '\n', () => {});
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
//
// Every endpoint accepts arbitrary credentials for arbitrary mail servers, so
// without limits this host is a convenient laundering proxy for credential
// stuffing — and the resulting provider blocks land on *our* IP.
// ---------------------------------------------------------------------------

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function consumeRateBudget(key: string, windowMs: number, max: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count++;
  return bucket.count <= max;
}

function rateLimit(name: string, windowMs: number, max: number): express.RequestHandler {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    if (!consumeRateBudget(key, windowMs, max)) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000).toString());
      return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
    }
    next();
  };
}

// Independent of the per-IP limit: slow down repeated failures against a single
// address, so a distributed attacker cannot brute-force one mailbox.
function noteAuthFailure(email: string) {
  consumeRateBudget(`authfail:${String(email).toLowerCase()}`, 15 * 60 * 1000, 10);
}

function isAuthLockedOut(email: string): boolean {
  const bucket = rateBuckets.get(`authfail:${String(email).toLowerCase()}`);
  return !!bucket && Date.now() < bucket.resetAt && bucket.count > 10;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now >= bucket.resetAt) rateBuckets.delete(key);
  }
}, 60 * 1000).unref?.();

// ---------------------------------------------------------------------------
// Mail server target validation (SSRF protection)
// ---------------------------------------------------------------------------

function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd]/.test(lower)) return true; // unique local
    if (lower.startsWith('fe80')) return true; // link-local
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // unparseable → refuse
}

// A syntactically ordinary DNS name: dot-separated labels, and a final label
// containing at least one letter. This rejects the legacy numeric IP encodings
// (0177.0.0.1, 2130706433, 0x7f.0.0.1, 127.1) outright. Those are the classic
// SSRF bypass, because different resolvers decode them differently — glibc
// reads 0177 as decimal 177, other stacks read it as octal 127.
const HOSTNAME_PATTERN = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/;

function isPlausibleHostname(hostname: string): boolean {
  if (!HOSTNAME_PATTERN.test(hostname)) return false;
  const labels = hostname.split('.');
  return /[a-zA-Z]/.test(labels[labels.length - 1]);
}

// Resolves the mail server and returns the address to actually connect to.
//
// Returning a concrete IP matters: if we validated the hostname and then handed
// the *name* to ImapFlow, the library would resolve it a second time, and the
// two answers need not agree — that is the DNS-rebinding window. Connecting to
// the address we vetted closes it. TLS still verifies against the hostname via
// the returned servername.
async function resolveSafeMailTarget(
  host: any,
  port: any,
  kind: 'imap' | 'smtp'
): Promise<{ address: string; servername: string }> {
  const allowedPorts = kind === 'imap' ? IMAP_PORTS : SMTP_PORTS;
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || !allowedPorts.has(numericPort)) {
    throw new Error(`Port ${port} is not a permitted ${kind.toUpperCase()} port`);
  }

  const hostname = String(host || '').trim();
  if (!hostname || hostname.length > 253) {
    throw new Error('Invalid mail server hostname');
  }

  const literalFamily = net.isIP(hostname);
  if (!literalFamily && !isPlausibleHostname(hostname)) {
    throw new Error('Invalid mail server hostname');
  }

  if (ALLOW_PRIVATE_MAIL_HOSTS) {
    return { address: hostname, servername: hostname };
  }

  let addresses: string[];
  if (literalFamily) {
    addresses = [hostname];
  } else {
    try {
      addresses = (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);
    } catch (_) {
      throw new Error(`Could not resolve mail server '${hostname}'`);
    }
  }

  if (addresses.length === 0) {
    throw new Error(`Could not resolve mail server '${hostname}'`);
  }
  // Every answer must be public: one private record is enough to reject, so a
  // hostile DNS record cannot smuggle an internal address in behind a good one.
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error('This mail server resolves to a non-public address and cannot be used');
    }
  }

  return { address: addresses[0], servername: hostname };
}

function notifyClients(email: string, payload: any) {
  const clients = sseClients.get(email.toLowerCase());
  if (clients && clients.length > 0) {
    const data = JSON.stringify(payload);
    for (const res of clients) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch (e) {
        // Ignored
      }
    }
  }
}

// Count the real attachments of a message from its IMAP BODYSTRUCTURE.
// Cheap and authoritative: no need to download the body, and unlike a size
// heuristic it never claims an attachment a big HTML newsletter does not have.
// Parts referenced from the body (inline images with a Content-ID) are skipped
// so the paperclip only shows up for files the user can actually save.
function countAttachments(node: any): number {
  if (!node) return 0;
  const type = (node.type || '').toLowerCase();
  const disposition = (node.disposition || '').toLowerCase();
  const filename = node.dispositionParameters?.filename || node.parameters?.name;

  // An embedded mail counts as one attachment, not as its own inner parts.
  if (type === 'message/rfc822') return 1;

  if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
    return node.childNodes.reduce((sum: number, child: any) => sum + countAttachments(child), 0);
  }

  if (disposition === 'attachment') return 1;
  // Some senders omit the disposition and only name the file.
  if (filename && disposition !== 'inline') return 1;
  // Inline without a Content-ID is nothing the body can reference, so it
  // reaches the user as a file like any other attachment.
  if (disposition === 'inline' && filename && !node.id) return 1;
  return 0;
}

async function extractSnippet(sourceBuffer: any): Promise<string> {
  if (!sourceBuffer) return '';
  try {
    const parsed = await simpleParser(sourceBuffer);
    let text = parsed.text || '';
    if (!text && parsed.html) {
      text = parsed.html.replace(/<[^>]*>/g, ' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 150) {
      return text.substring(0, 150) + '...';
    }
    return text;
  } catch (err) {
    return '';
  }
}

// Cache key over the complete credential set. The password is part of the hash,
// so a request that presents the wrong password can never be served from an
// existing authenticated connection — it is forced through a real IMAP login.
function credentialKey(account: any): string {
  const material = JSON.stringify([account.email, account.imapHost, account.imapPort, account.password]);
  return crypto.createHash('sha256').update(material).digest('hex');
}

// Drop the least recently used connections once the cache exceeds its bound.
function enforceCacheBound() {
  if (connectionCache.size <= MAX_CACHED_CONNECTIONS) return;
  const byAge = [...connectionCache.entries()].sort((a, b) => a[1].activeTime - b[1].activeTime);
  for (const [key, entry] of byAge.slice(0, connectionCache.size - MAX_CACHED_CONNECTIONS)) {
    log(`[CONNECTION-GC] Evicting connection for ${maskEmail(entry.email)} (cache bound reached)`);
    entry.client.logout().catch(() => {});
    connectionCache.delete(key);
  }
}

// Helper to get connected client (cached or fresh)
async function getConnectedClient(account: any): Promise<ImapFlow> {
  if (!account || !account.email || !account.imapHost || !account.imapPort) {
    throw new Error('Invalid account configuration elements');
  }
  if (!account.password) {
    throw new Error('A password is required');
  }
  if (isAuthLockedOut(account.email)) {
    throw new Error('Too many failed sign-in attempts for this address. Please try again later.');
  }

  const key = credentialKey(account);
  const cached = connectionCache.get(key);

  if (cached && cached.client.usable) {
    cached.activeTime = Date.now();
    return cached.client;
  }

  if (cached) {
    try {
      await cached.client.logout();
    } catch (_) {}
    connectionCache.delete(key);
  }

  const target = await resolveSafeMailTarget(account.imapHost, account.imapPort, 'imap');

  const client = new ImapFlow({
    host: target.address,
    port: Number(account.imapPort),
    secure: !!account.imapSecure,
    auth: {
      user: account.email,
      pass: account.password
    },
    logger: false,
    tls: {
      // Certificate is validated against the name the user typed, not the IP
      // we connected to.
      servername: target.servername,
      // Disabling this lets an active network attacker read the user's password.
      rejectUnauthorized: !ALLOW_SELF_SIGNED_TLS
    }
  });

  try {
    await client.connect();
  } catch (err) {
    noteAuthFailure(account.email);
    throw err;
  }

  const lowerEmail = account.email.toLowerCase();

  // Subscriptions for real-time event notifications via IMAP IDLE
  client.on('exists', (data) => {
    notifyClients(lowerEmail, { type: 'exists', accountEmail: lowerEmail, folder: data.path, count: data.count });
  });

  client.on('flags', (data) => {
    notifyClients(lowerEmail, { type: 'flags', accountEmail: lowerEmail, folder: data.path, seq: data.seq });
  });

  client.on('expunge', (data) => {
    notifyClients(lowerEmail, { type: 'expunge', accountEmail: lowerEmail, folder: data.path, seq: data.seq });
  });

  // Keep mailbox 'INBOX' open to start listening for changes (enables IDLE immediately)
  try {
    await client.mailboxOpen('INBOX');
  } catch (err: any) {
    log(`[IMAP EVENT SIGNUP] Failed to open INBOX initially for ${maskEmail(lowerEmail)}: ${err.message}`);
  }

  connectionCache.set(key, { client, activeTime: Date.now(), email: lowerEmail });
  enforceCacheBound();
  return client;
}

// Inactive connections manager (running every 1 minute, purging >15 minutes idle)
// If there is an active SSE subscriber listening for this account's events, we automatically
// refresh its activeTime so it is kept alive in IDLE steady state.
setInterval(() => {
  const now = Date.now();
  for (const [key, cached] of connectionCache.entries()) {
    const hasActiveSSE = (sseClients.get(cached.email)?.length || 0) > 0;

    if (hasActiveSSE) {
      // Refresh activeTime to preserve the IMAP IDLE connection for active users
      cached.activeTime = now;
    } else if (now - cached.activeTime > 15 * 60 * 1000) {
      log(`[CONNECTION-GC] Purging idle IMAP connection for ${maskEmail(cached.email)} (no active SSE client)`);
      cached.client.logout().catch(() => {});
      connectionCache.delete(key);
    }
  }
}, 60 * 1000);

// Every endpoint below accepts arbitrary credentials for arbitrary mail servers,
// so all of them are budgeted per client IP.
app.use('/api', rateLimit('api', 60 * 1000, 300));

// API: Verify account credentials
// Deliberately stricter: this is the endpoint an attacker would drive to test
// stolen credential lists against third-party providers.
app.post('/api/verify', rateLimit('verify', 15 * 60 * 1000, 20), async (req, res) => {
  try {
    const { account } = req.body;
    await getConnectedClient(account);
    res.json({ status: 'ok', email: account.email });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Verification failed. Please check credentials' });
  }
});

// API: Fetch folders list with unread sizes
app.post('/api/folders', async (req, res) => {
  try {
    const { account } = req.body;
    const client = await getConnectedClient(account);
    const folderList = await client.list();

    const result = [];
    for (const f of folderList) {
      let unreadCount = 0;
      let totalCount = 0;
      try {
        const status = await client.status(f.path, { unseen: true, messages: true });
        unreadCount = status.unseen || 0;
        totalCount = status.messages || 0;
      } catch (_) {}

      let specialUse: string | undefined = undefined;
      const lowerPath = f.path.toLowerCase();
      // Detect special uses by flags or names
      if (f.flags.has('\\Inbox') || lowerPath === 'inbox') {
        specialUse = 'inbox';
      } else if (f.flags.has('\\Sent') || lowerPath.includes('sent')) {
        specialUse = 'sent';
      } else if (f.flags.has('\\Drafts') || lowerPath.includes('draft')) {
        specialUse = 'drafts';
      } else if (f.flags.has('\\Trash') || lowerPath.includes('trash') || lowerPath.includes('bin')) {
        specialUse = 'trash';
      } else if (f.flags.has('\\Junk') || lowerPath.includes('junk') || lowerPath.includes('spam')) {
        specialUse = 'junk';
      } else if (f.flags.has('\\Archive') || lowerPath.includes('archive')) {
        specialUse = 'archive';
      }

      result.push({
        path: f.path,
        name: f.name,
        unreadCount,
        totalCount,
        specialUse
      });
    }

    res.json({ folders: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list folders' });
  }
});

// API: Fetch merged global inbox messages
app.post('/api/global-messages', async (req, res) => {
  try {
    const { accounts, page = 1, pageSize = 30, search = '', localUids, localStats } = req.body;
    if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
      return res.json({ messages: [], total: 0, unreads: {}, errors: [] });
    }


    const fetchTasks = accounts.map(async (account) => {
      try {
        const client = await getConnectedClient(account);
        const accountEmailLower = account.email.toLowerCase();

        // Status check for unread count in inbox
        let unreadCount = 0;
        try {
          const status = await client.status('INBOX', { unseen: true });
          unreadCount = status.unseen || 0;
        } catch (_) {
          // Unread count is best-effort; a failure here must not abort the sync.
        }

        const lock = await client.getMailboxLock('INBOX');
        try {
          const mailboxObj = await client.mailboxOpen('INBOX');
          const total = mailboxObj.exists;

          // CHEAP SYNC SHORT-CIRCUIT: Check if stats match local stats perfectly
          const stats = localStats && localStats[accountEmailLower];
          if (stats && !search && (page === 1 || page === undefined)) {
            const parsedMaxLocalUid = Number(stats.maxUid || 0);
            const parsedLocalTotal = Number(stats.total || -1);
            const parsedLocalUnread = Number(stats.unread || -1);

            if (parsedMaxLocalUid > 0 && parsedLocalTotal === total && parsedLocalUnread === unreadCount) {
              // Rapidly check if any newer UIDs exist on server
              const serverNewerUids = await client.search({ uid: `${parsedMaxLocalUid + 1}:*` }, { uid: true }).catch(() => []);
              const newUidsFiltered = (Array.isArray(serverNewerUids) ? serverNewerUids : []).filter(u => u > parsedMaxLocalUid);

              if (newUidsFiltered.length === 0) {
                return { messages: [], unread: unreadCount, total, accountEmail: account.email, noChanges: true };
              }
            }
          }

          if (total === 0) {
            return { messages: [], unread: unreadCount, total: 0, accountEmail: account.email };
          }

          const messages: any[] = [];
          if (search) {
            
            const subjRes = await client.search({ subject: search }, { uid: true }).catch(() => []);

            const fromRes = await client.search({ from: search }, { uid: true }).catch(() => []);

            const toRes = await client.search({ to: search }, { uid: true }).catch(() => []);

            const searchResults = [subjRes, fromRes, toRes];
            const uidsSet = new Set<number>();
            for (const list of searchResults) {
              if (Array.isArray(list)) {
                for (const uid of list) {
                  uidsSet.add(uid);
                }
              }
            }
            const uids = Array.from(uidsSet);
            
            uids.sort((a, b) => b - a);
            const pageUids = uids.slice(0, 100); // Fetch a slightly larger pool to ensure we have enough matches after filtering
            if (pageUids.length > 0) {
              for await (const msg of client.fetch(pageUids.join(','), { envelope: true, flags: true, size: true, bodyStructure: true, source: { start: 0, maxLength: 16384 } }, { uid: true })) {
                messages.push({
                  uid: msg.uid,
                  seq: msg.seq,
                  subject: msg.envelope.subject || '(No Subject)',
                  from: msg.envelope.from && msg.envelope.from[0] ? { name: msg.envelope.from[0].name, address: msg.envelope.from[0].address } : { address: 'unknown' },
                  to: (msg.envelope.to || []).map((t: any) => ({ name: t.name, address: t.address })),
                  date: msg.envelope.date ? msg.envelope.date.toISOString() : new Date().toISOString(),
                  flags: Array.from(msg.flags || []),
                  size: msg.size,
                  attachmentCount: countAttachments(msg.bodyStructure),
                  snippet: await extractSnippet(msg.source),
                  accountEmail: account.email
                });
              }
            }
            
            // Filter out messages marked as \Deleted
            const nonDeleted = messages.filter(msg => !msg.flags.some((f: string) => f.toLowerCase() === '\\deleted'));

            return { messages: nonDeleted, unread: unreadCount, total: nonDeleted.length, accountEmail: account.email };
          } else {
            const maxLocalUid = (localUids && typeof localUids === 'object') ? Number(localUids[account.email] || 0) : 0;
            if (maxLocalUid > 0) {
              const serverNewerUids = await client.search({ uid: `${maxLocalUid + 1}:*` }, { uid: true }).catch(() => []);
              const newUidsFiltered = (Array.isArray(serverNewerUids) ? serverNewerUids : []).filter(u => u > maxLocalUid);

              
              const uidsToFetch = [...newUidsFiltered];
              
              const end = total;
              const start = Math.max(1, end - 19);
              const recentRange = `${start}:${end}`;
              
              const setOfUidsToFetch = new Set<string>();
              uidsToFetch.forEach(u => setOfUidsToFetch.add(u.toString()));
              
              if (end >= 1) {
                for await (const msg of client.fetch(recentRange, { envelope: true, flags: true, size: true, bodyStructure: true, source: { start: 0, maxLength: 16384 } })) {
                  messages.push({
                    uid: msg.uid,
                    seq: msg.seq,
                    subject: msg.envelope.subject || '(No Subject)',
                    from: msg.envelope.from && msg.envelope.from[0] ? { name: msg.envelope.from[0].name, address: msg.envelope.from[0].address } : { address: 'unknown' },
                    to: (msg.envelope.to || []).map((t: any) => ({ name: t.name, address: t.address })),
                    date: msg.envelope.date ? msg.envelope.date.toISOString() : new Date().toISOString(),
                    flags: Array.from(msg.flags || []),
                    size: msg.size,
                    attachmentCount: countAttachments(msg.bodyStructure),
                    snippet: await extractSnippet(msg.source),
                    accountEmail: account.email
                  });
                  setOfUidsToFetch.delete(msg.uid.toString());
                }
              }
              
              if (setOfUidsToFetch.size > 0) {
                const remainingUids = Array.from(setOfUidsToFetch);
                for await (const msg of client.fetch(remainingUids.join(','), { envelope: true, flags: true, size: true, bodyStructure: true, source: { start: 0, maxLength: 16384 } }, { uid: true })) {
                  messages.push({
                    uid: msg.uid,
                    seq: msg.seq,
                    subject: msg.envelope.subject || '(No Subject)',
                    from: msg.envelope.from && msg.envelope.from[0] ? { name: msg.envelope.from[0].name, address: msg.envelope.from[0].address } : { address: 'unknown' },
                    to: (msg.envelope.to || []).map((t: any) => ({ name: t.name, address: t.address })),
                    date: msg.envelope.date ? msg.envelope.date.toISOString() : new Date().toISOString(),
                    flags: Array.from(msg.flags || []),
                    size: msg.size,
                    attachmentCount: countAttachments(msg.bodyStructure),
                    snippet: await extractSnippet(msg.source),
                    accountEmail: account.email
                  });
                }
              }
              
              return { messages, unread: unreadCount, total, accountEmail: account.email };
            } else {
              const end = total;
              // Fetch page * pageSize messages to allow client-side merging and slicing
              const start = Math.max(1, total - (Number(page || 1) * Number(pageSize || 30)) + 1);
              const range = `${start}:${end}`;
              for await (const msg of client.fetch(range, { envelope: true, flags: true, size: true, bodyStructure: true, source: { start: 0, maxLength: 16384 } })) {
                messages.push({
                  uid: msg.uid,
                  seq: msg.seq,
                  subject: msg.envelope.subject || '(No Subject)',
                  from: msg.envelope.from && msg.envelope.from[0] ? { name: msg.envelope.from[0].name, address: msg.envelope.from[0].address } : { address: 'unknown' },
                  to: (msg.envelope.to || []).map((t: any) => ({ name: t.name, address: t.address })),
                  date: msg.envelope.date ? msg.envelope.date.toISOString() : new Date().toISOString(),
                  flags: Array.from(msg.flags || []),
                  size: msg.size,
                  attachmentCount: countAttachments(msg.bodyStructure),
                  snippet: await extractSnippet(msg.source),
                  accountEmail: account.email
                });
              }
              return { messages, unread: unreadCount, total, accountEmail: account.email };
            }
          }
          return { messages: [], unread: unreadCount, total: 0, accountEmail: account.email };
        } finally {
          lock.release();
        }
      } catch (err: any) {
        log(`[GLOBAL-SYNC] Sync failed for ${maskEmail(account?.email)}: ${err.message}`);
        return { messages: [], unread: 0, total: 0, accountEmail: account.email, error: err.message };
      }
    });

    const results = await Promise.all(fetchTasks);

    // Merge messages from all accounts
    let mergedMessages: any[] = [];
    const unreads: Record<string, number> = {};
    const errors: string[] = [];
    let totalMessagesCombined = 0;

    // Each account's own newest range, before the cross-account merge below
    // reorders and slices it. The client needs this to tell which of its cached
    // messages have vanished server-side: the merged page is date-sorted across
    // mailboxes and so is not a slice of any single one.
    const sliceUids: Record<string, number[]> = {};

    for (const res of results) {
      if (res.error) {
        errors.push(`${res.accountEmail}: ${res.error}`);
      } else {
        unreads[res.accountEmail] = res.unread;
        totalMessagesCombined += res.total;
        const accountMessages = res.messages || [];
        mergedMessages = mergedMessages.concat(accountMessages);
        // Search hits are not a slice of the mailbox, and a short-circuited
        // account did not report one at all: neither may be pruned against.
        if (!search && !(res as any).noChanges && accountMessages.length > 0) {
          sliceUids[res.accountEmail] = accountMessages
            .filter((m: any) => !m.flags.some((f: string) => f.toLowerCase() === '\\deleted'))
            .map((m: any) => m.uid);
        }
      }
    }

    // Filter out messages marked as \Deleted
    mergedMessages = mergedMessages.filter(msg => !msg.flags.some((f: string) => f.toLowerCase() === '\\deleted'));

    // Sort by date DESC
    mergedMessages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Slice for current page
    const startIdx = (page - 1) * pageSize;
    const pageMessages = mergedMessages.slice(startIdx, startIdx + pageSize);

    res.json({
      messages: pageMessages,
      total: totalMessagesCombined,
      unreads,
      errors,
      sliceUids
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to merge global inbox messages' });
  }
});

// API: Fetch messages list
app.post('/api/messages', async (req, res) => {
  try {
    const { account, folder = 'INBOX', page = 1, pageSize = 30, search = '', maxLocalUid = 0, localTotal = -1, localUnread = -1 } = req.body;
    const client = await getConnectedClient(account);

    const lock = await client.getMailboxLock(folder);
    try {
      const mailboxObj = await client.mailboxOpen(folder);
      const total = mailboxObj.exists;
      if (total === 0) {
        return res.json({ messages: [], total: 0 });
      }

      // CHEAP SYNC SHORT-CIRCUIT: Check if stats match local stats perfectly
      const parsedMaxLocalUid = Number(maxLocalUid || 0);
      const parsedLocalTotal = Number(localTotal || -1);
      const parsedLocalUnread = Number(localUnread || -1);

      if (parsedMaxLocalUid > 0 && !search && (page === 1 || page === undefined)) {
        let serverUnseen = -1;
        try {
          const status = await client.status(folder, { unseen: true });
          serverUnseen = status.unseen || 0;
        } catch (_) {}

        if (parsedLocalTotal === total && parsedLocalUnread === serverUnseen) {
          // Rapidly check if any newer UIDs exist on server
          const serverNewerUids = await client.search({ uid: `${parsedMaxLocalUid + 1}:*` }, { uid: true }).catch(() => []);
          const newUidsFiltered = (Array.isArray(serverNewerUids) ? serverNewerUids : []).filter(u => u > parsedMaxLocalUid);

          if (newUidsFiltered.length === 0) {
            return res.json({ messages: [], total, noChanges: true });
          }
        }
      }

      const messages: any[] = [];

      if (search) {
        
        const subjRes = await client.search({ subject: search }, { uid: true }).catch(() => []);

        const fromRes = await client.search({ from: search }, { uid: true }).catch(() => []);

        const toRes = await client.search({ to: search }, { uid: true }).catch(() => []);

        const searchResults = [subjRes, fromRes, toRes];
        const uidsSet = new Set<number>();
        for (const list of searchResults) {
          if (Array.isArray(list)) {
            for (const uid of list) {
              uidsSet.add(uid);
            }
          }
        }
        const uids = Array.from(uidsSet);
        uids.sort((a, b) => b - a);

        const startIdx = (page - 1) * pageSize;
        const pageUids = uids.slice(startIdx, startIdx + pageSize);

        if (pageUids.length > 0) {
          try {
            const fetchResult = client.fetch(pageUids.join(','), { envelope: true, flags: true, size: true, bodyStructure: true, source: { start: 0, maxLength: 16384 } }, { uid: true });
            let count = 0;
            for await (const msg of fetchResult) {
              count++;
              try {
                const snippetText = msg.source ? await extractSnippet(msg.source) : '';
                messages.push({
                  uid: msg.uid,
                  seq: msg.seq,
                  subject: msg.envelope?.subject || '(No Subject)',
                  from: msg.envelope?.from && msg.envelope.from[0] ? { name: msg.envelope.from[0].name, address: msg.envelope.from[0].address } : { address: 'unknown' },
                  to: (msg.envelope?.to || []).map((t: any) => ({ name: t.name, address: t.address })),
                  date: msg.envelope?.date ? msg.envelope.date.toISOString() : new Date().toISOString(),
                  flags: Array.from(msg.flags || []),
                  size: msg.size,
                  attachmentCount: countAttachments(msg.bodyStructure),
                  snippet: snippetText,
                });
              } catch (msgErr: any) {
              }
            }
          } catch (fetchErr: any) {
          }
        }

        // Filter out messages marked as \Deleted
        const nonDeleted = messages.filter(msg => !msg.flags.some((f: string) => f.toLowerCase() === '\\deleted'));

        nonDeleted.sort((a, b) => b.uid - a.uid);
        return res.json({ messages: nonDeleted, total: uids.length });
      } else {
        const parsedMaxLocalUid = Number(maxLocalUid || 0);
        if (parsedMaxLocalUid > 0) {
          // Sync Gaps: Fetch whatever has arrived since maxLocalUid
          const serverNewerUids = await client.search({ uid: `${parsedMaxLocalUid + 1}:*` }, { uid: true }).catch(() => []);
          const newUidsFiltered = (Array.isArray(serverNewerUids) ? serverNewerUids : []).filter(u => u > parsedMaxLocalUid);

          const uidsToFetch = [...newUidsFiltered];

          // Also pull top chunk of this folder to keep flags (read/unread) in sync
          const end = total;
          const start = Math.max(1, end - pageSize + 1);

          if (end >= 1) {
            const range = `${start}:${end}`;
            const setOfUidsToFetch = new Set<string>();
            uidsToFetch.forEach(u => setOfUidsToFetch.add(u.toString()));

            for await (const msg of client.fetch(range, { envelope: true, flags: true, size: true, bodyStructure: true, source: { start: 0, maxLength: 16384 } })) {
              messages.push({
                uid: msg.uid,
                seq: msg.seq,
                subject: msg.envelope.subject || '(No Subject)',
                from: msg.envelope.from && msg.envelope.from[0] ? { name: msg.envelope.from[0].name, address: msg.envelope.from[0].address } : { address: 'unknown' },
                to: (msg.envelope.to || []).map((t: any) => ({ name: t.name, address: t.address })),
                date: msg.envelope.date ? msg.envelope.date.toISOString() : new Date().toISOString(),
                flags: Array.from(msg.flags || []),
                size: msg.size,
                attachmentCount: countAttachments(msg.bodyStructure),
                snippet: await extractSnippet(msg.source),
              });
              setOfUidsToFetch.delete(msg.uid.toString());
            }

            if (setOfUidsToFetch.size > 0) {
              const remaining = Array.from(setOfUidsToFetch);
              for await (const msg of client.fetch(remaining.join(','), { envelope: true, flags: true, size: true, bodyStructure: true, source: { start: 0, maxLength: 16384 } }, { uid: true })) {
                messages.push({
                  uid: msg.uid,
                  seq: msg.seq,
                  subject: msg.envelope.subject || '(No Subject)',
                  from: msg.envelope.from && msg.envelope.from[0] ? { name: msg.envelope.from[0].name, address: msg.envelope.from[0].address } : { address: 'unknown' },
                  to: (msg.envelope.to || []).map((t: any) => ({ name: t.name, address: t.address })),
                  date: msg.envelope.date ? msg.envelope.date.toISOString() : new Date().toISOString(),
                  flags: Array.from(msg.flags || []),
                  size: msg.size,
                  attachmentCount: countAttachments(msg.bodyStructure),
                  snippet: await extractSnippet(msg.source),
                });
              }
            }
          }
          const nonDeleted = messages.filter(msg => !msg.flags.some((f: string) => f.toLowerCase() === '\\deleted'));
          nonDeleted.sort((a, b) => b.uid - a.uid);
          return res.json({ messages: nonDeleted, total });
        } else {
          // Paginated retrieval of messages (newest first)
          const end = total - (page - 1) * pageSize;
          const start = Math.max(1, end - pageSize + 1);

          if (end < 1) {
            return res.json({ messages: [], total });
          }

          const range = `${start}:${end}`;
          for await (const msg of client.fetch(range, { envelope: true, flags: true, size: true, bodyStructure: true, source: { start: 0, maxLength: 16384 } })) {
            messages.push({
              uid: msg.uid,
              seq: msg.seq,
              subject: msg.envelope.subject || '(No Subject)',
              from: msg.envelope.from && msg.envelope.from[0] ? { name: msg.envelope.from[0].name, address: msg.envelope.from[0].address } : { address: 'unknown' },
              to: (msg.envelope.to || []).map((t: any) => ({ name: t.name, address: t.address })),
              date: msg.envelope.date ? msg.envelope.date.toISOString() : new Date().toISOString(),
              flags: Array.from(msg.flags || []),
              size: msg.size,
              attachmentCount: countAttachments(msg.bodyStructure),
              snippet: await extractSnippet(msg.source),
            });
          }

          const nonDeleted = messages.filter(msg => !msg.flags.some((f: string) => f.toLowerCase() === '\\deleted'));
          nonDeleted.sort((a, b) => b.seq - a.seq);
          return res.json({ messages: nonDeleted, total });
        }
      }
    } finally {
      lock.release();
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch messages' });
  }
});

// API: Fetch message details & bodies
app.post('/api/message-detail', async (req, res) => {
  try {
    const { account, folder, uid } = req.body;
    const client = await getConnectedClient(account);

    const lock = await client.getMailboxLock(folder);
    try {
      const downloadResult = await client.download(uid.toString(), undefined, { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of downloadResult.content) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBuffer = Buffer.concat(chunks);
      const parsed = await simpleParser(rawBuffer);

      const attachments = (parsed.attachments || []).map((att: any, index: number) => ({
        filename: att.filename || `attachment-${index}`,
        contentType: att.contentType || 'application/octet-stream',
        size: att.size || (att.content ? att.content.length : 0),
        index,
        contentId: att.contentId
      }));

      const parseAddress = (addrObj: any) => {
        if (!addrObj) return [];
        const entries = Array.isArray(addrObj) ? addrObj : (addrObj.value || [addrObj]);
        return entries.flatMap((item: any) => {
          if (!item) return [];
          if (item.value) return item.value.map((v: any) => ({ name: v.name, address: v.address }));
          return [{ name: item.name, address: item.address }];
        }).filter((x: any) => x && x.address);
      };

      res.json({
        detail: {
          uid: Number(uid),
          subject: parsed.subject || '(No Subject)',
          from: parsed.from && parsed.from.value && parsed.from.value[0] ? { name: parsed.from.value[0].name, address: parsed.from.value[0].address } : { address: 'unknown' },
          to: parseAddress(parsed.to),
          cc: parseAddress(parsed.cc),
          bcc: parseAddress(parsed.bcc),
          date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
          flags: [],
          html: parsed.html || undefined,
          text: parsed.text || undefined,
          attachments
        }
      });

      // Automatically flag as read \Seen
      try {
        await client.messageFlagsAdd(uid.toString(), ['\\Seen'], { uid: true });
      } catch (_) {}
    } finally {
      lock.release();
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch email details' });
  }
});

// API: Raw RFC 822 source of a message, for the "Source" view.
// Returned as JSON text, never as a served document, so nothing in it can run
// on this origin. Does not touch the \Seen flag.
app.post('/api/message-source', async (req, res) => {
  try {
    const { account, folder, uid } = req.body;
    if (!account || !folder || uid === undefined) {
      return res.status(400).json({ error: 'Missing parameter details' });
    }
    const client = await getConnectedClient(account);
    const lock = await client.getMailboxLock(folder);
    try {
      const downloadResult = await client.download(String(uid), undefined, { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of downloadResult.content) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      res.json({ source: Buffer.concat(chunks).toString('utf8') });
    } finally {
      lock.release();
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch message source' });
  }
});

// API: Set flags (seen/unseen)
app.post('/api/mark', async (req, res) => {
  try {
    const { account, folder, uid, markSeen } = req.body;
    const client = await getConnectedClient(account);
    const lock = await client.getMailboxLock(folder);
    try {
      if (markSeen) {
        await client.messageFlagsAdd(uid.toString(), ['\\Seen'], { uid: true });
      } else {
        await client.messageFlagsRemove(uid.toString(), ['\\Seen'], { uid: true });
      }
      res.json({ status: 'ok' });
    } finally {
      lock.release();
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to modify flags' });
  }
});

// API: Delete message / move to Trash
app.post('/api/delete', async (req, res) => {
  try {
    const { account, folder, uid, trashFolder } = req.body;
    const client = await getConnectedClient(account);
    const lock = await client.getMailboxLock(folder);
    try {
      let dest = trashFolder;
      if (!dest) {
        try {
          const list = await client.list();
          for (const f of list) {
            const lp = f.path.toLowerCase();
            if (f.flags.has('\\Trash') || lp.includes('trash') || lp.includes('bin')) {
              dest = f.path;
              break;
            }
          }
        } catch (_) {}
      }

      if (dest && folder !== dest) {
        try {
          await client.messageMove(uid.toString(), dest, { uid: true });
        } catch (_) {
          try {
            await client.messageCopy(uid.toString(), dest, { uid: true });
            await client.messageFlagsAdd(uid.toString(), ['\\Deleted'], { uid: true });
            await (client as any).mailboxExpunge();
          } catch (_) {
            await client.messageFlagsAdd(uid.toString(), ['\\Deleted'], { uid: true });
            await (client as any).mailboxExpunge();
          }
        }
      } else {
        await client.messageFlagsAdd(uid.toString(), ['\\Deleted'], { uid: true });
        await (client as any).mailboxExpunge();
      }
      res.json({ status: 'ok' });
    } finally {
      lock.release();
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete message' });
  }
});

// API: Mark message as spam / move to Junk folder
app.post('/api/spam', async (req, res) => {
  try {
    const { account, folder, uid, junkFolder } = req.body;
    const client = await getConnectedClient(account);
    const lock = await client.getMailboxLock(folder);
    try {
      try {
        await client.messageFlagsAdd(uid.toString(), ['$Junk', '\\Junk'], { uid: true });
      } catch (_) {}

      let dest = junkFolder;
      if (!dest) {
        try {
          const list = await client.list();
          for (const f of list) {
            const lp = f.path.toLowerCase();
            if (f.flags.has('\\Junk') || lp.includes('junk') || lp.includes('spam')) {
              dest = f.path;
              break;
            }
          }
        } catch (_) {}
      }

      const candidates = dest ? [dest, 'Junk', 'Spam', '[Gmail]/Spam', 'Junk E-mail', 'INBOX.Junk', 'INBOX.Spam', 'Bulk'] : ['Junk', 'Spam', '[Gmail]/Spam', 'Junk E-mail', 'INBOX.Junk', 'INBOX.Spam', 'Bulk'];
      let moved = false;

      for (const target of candidates) {
        if (folder === target) continue;
        try {
          await client.messageMove(uid.toString(), target, { uid: true });
          moved = true;
          break;
        } catch (_) {
          try {
            await client.messageCopy(uid.toString(), target, { uid: true });
            await client.messageFlagsAdd(uid.toString(), ['\\Deleted'], { uid: true });
            await (client as any).mailboxExpunge();
            moved = true;
            break;
          } catch (_) {}
        }
      }

      if (!moved) {
        await client.messageFlagsAdd(uid.toString(), ['\\Deleted'], { uid: true });
        await (client as any).mailboxExpunge();
      }

      res.json({ status: 'ok' });
    } finally {
      lock.release();
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to mark message as spam' });
  }
});

// API: Move message to target folder
app.post('/api/move', async (req, res) => {
  try {
    const { account, folder, uid, targetFolder } = req.body;
    const client = await getConnectedClient(account);
    const lock = await client.getMailboxLock(folder);
    try {
      if (targetFolder && folder !== targetFolder) {
        try {
          await client.messageMove(uid.toString(), targetFolder, { uid: true });
        } catch (_) {
          await client.messageCopy(uid.toString(), targetFolder, { uid: true });
          await client.messageFlagsAdd(uid.toString(), ['\\Deleted'], { uid: true });
          await (client as any).mailboxExpunge();
        }
      }
      res.json({ status: 'ok' });
    } finally {
      lock.release();
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to move message' });
  }
});

// API: Send email using SMTP
app.post('/api/send', rateLimit('send', 60 * 60 * 1000, 100), async (req, res) => {
  try {
    const { account, to, cc, bcc, subject, text, html, attachments } = req.body;

    if (!account || !account.email || !account.password) {
      return res.status(400).json({ error: 'Invalid account configuration elements' });
    }
    if (isAuthLockedOut(account.email)) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts for this address. Please try again later.' });
    }

    // Prove the caller owns this mailbox before relaying anything through it.
    // SMTP would authenticate too, but checking IMAP first keeps an open relay
    // from being probed purely through the send path.
    await getConnectedClient(account);
    const target = await resolveSafeMailTarget(account.smtpHost, account.smtpPort, 'smtp');

    const transporter = nodemailer.createTransport({
      host: target.address,
      port: Number(account.smtpPort),
      secure: !!account.smtpSecure,
      auth: {
        user: account.email,
        pass: account.password
      },
      // Keep message options from reaching the filesystem or arbitrary URLs;
      // attachments are only ever accepted as inline base64 below.
      disableFileAccess: true,
      disableUrlAccess: true,
      tls: {
        servername: target.servername,
        rejectUnauthorized: !ALLOW_SELF_SIGNED_TLS
      }
    });

    const mailOptions: any = {
      from: `"${account.email.split('@')[0]}" <${account.email}>`,
      to,
      cc,
      bcc,
      subject,
      text,
      html
    };

    if (attachments && Array.isArray(attachments)) {
      mailOptions.attachments = attachments.map((att: any) => ({
        filename: att.filename,
        content: Buffer.from(att.content, 'base64'),
        contentType: att.contentType
      }));
    }

    await transporter.sendMail(mailOptions);
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to send email' });
  }
});

// API: Get attachment download binary stream
// POST rather than GET: credentials used to be base64'd into the query string,
// which put mail passwords into access logs, browser history and proxy logs.
app.post('/api/attachment', async (req, res) => {
  try {
    const { account, folder, uid, index } = req.body;
    if (!account || !folder || uid === undefined || index === undefined) {
      return res.status(400).json({ error: 'Missing parameter details' });
    }

    const client = await getConnectedClient(account);
    const lock = await client.getMailboxLock(folder as string);
    try {
      const downloadResult = await client.download(String(uid), undefined, { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of downloadResult.content) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBuffer = Buffer.concat(chunks);
      const parsed = await simpleParser(rawBuffer);

      const idx = parseInt(String(index), 10);
      const att = parsed.attachments && parsed.attachments[idx];
      if (!att) {
        return res.status(404).json({ error: 'Attachment not found' });
      }

      // Always hand attachments back as an opaque download. Serving the sender's
      // declared Content-Type from our own origin would let an HTML attachment
      // execute script on this domain and read every stored account.
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename || 'attachment')}"`);
      res.send(att.content);
    } finally {
      lock.release();
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'File download failed' });
  }
});

// API: Fetch every attachment of a message as base64, for forwarding.
// One download and one parse for the whole set, rather than the N round trips
// a per-attachment loop over /api/attachment would cost.
app.post('/api/attachments', async (req, res) => {
  try {
    const { account, folder, uid } = req.body;
    if (!account || !folder || uid === undefined) {
      return res.status(400).json({ error: 'Missing parameter details' });
    }

    const client = await getConnectedClient(account);
    const lock = await client.getMailboxLock(folder as string);
    try {
      const downloadResult = await client.download(String(uid), undefined, { uid: true });
      const chunks: Buffer[] = [];
      for await (const chunk of downloadResult.content) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const parsed = await simpleParser(Buffer.concat(chunks));

      let total = 0;
      const attachments = (parsed.attachments || []).map((att: any, index: number) => {
        const content: Buffer = att.content || Buffer.alloc(0);
        total += content.length;
        return {
          filename: att.filename || `attachment-${index}`,
          contentType: att.contentType || 'application/octet-stream',
          size: content.length,
          contentId: att.contentId,
          content: content.toString('base64')
        };
      });

      // Keep the reply within what the compose form will accept back on send.
      if (total > MAX_FORWARD_ATTACHMENT_BYTES) {
        return res.status(413).json({ error: 'Attachments are too large to forward automatically.' });
      }

      res.json({ attachments });
    } finally {
      lock.release();
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to read attachments' });
  }
});

// ---------------------------------------------------------------------------
// Real-time event subscriptions
//
// EventSource cannot send a request body or custom headers, so the browser
// exchanges its credentials for a short-lived, single-use token first.
// Subscribing by plain address (the previous ?emails=... form) let anybody
// watch when mail arrived for any address they cared to name.
// ---------------------------------------------------------------------------

const subscriptionTokens = new Map<string, { emails: string[]; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of subscriptionTokens.entries()) {
    if (now >= entry.expiresAt) subscriptionTokens.delete(token);
  }
}, 30 * 1000).unref?.();

// API: Exchange verified credentials for a short-lived SSE subscription token
app.post('/api/subscribe', async (req, res) => {
  try {
    const { accounts } = req.body;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({ error: 'No accounts provided' });
    }

    // Only subscribe to mailboxes whose credentials actually check out.
    const verified: string[] = [];
    for (const account of accounts) {
      try {
        await getConnectedClient(account);
        verified.push(String(account.email).toLowerCase());
      } catch (err: any) {
        log(`[SSE] Rejected subscription for ${maskEmail(account?.email)}: ${err.message}`);
      }
    }

    if (verified.length === 0) {
      return res.status(401).json({ error: 'None of the supplied accounts could be authenticated' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    subscriptionTokens.set(token, { emails: verified, expiresAt: Date.now() + 60 * 1000 });
    res.json({ token, emails: verified });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create subscription' });
  }
});

// API: SSE event subscription for real-time IMAP IDLE pushes
app.get('/api/events', (req, res) => {
  const token = String(req.query.token || '');
  const subscription = subscriptionTokens.get(token);
  subscriptionTokens.delete(token); // single use

  if (!subscription || Date.now() >= subscription.expiresAt) {
    res.status(401).send('Invalid or expired subscription token');
    return;
  }

  const emails = subscription.emails;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send an initial connected ping
  res.write('data: {"type":"connected"}\n\n');

  // Register this response for all specified emails
  for (const email of emails) {
    if (!sseClients.has(email)) {
      sseClients.set(email, []);
    }
    sseClients.get(email)!.push(res);
  }

  // Periodic ping to keep connection alive and prevent reverse-proxy timeouts
  const pingInterval = setInterval(() => {
    try {
      res.write('data: {"type":"ping"}\n\n');
    } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(pingInterval);
    for (const email of emails) {
      const list = sseClients.get(email) || [];
      const index = list.indexOf(res);
      if (index !== -1) {
        list.splice(index, 1);
      }
      if (list.length === 0) {
        sseClients.delete(email);
      }
    }
  });
});

// Setup Vite Dev server or production paths
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Tabpost server running on http://localhost:${PORT}`);
  });
}

startServer();
