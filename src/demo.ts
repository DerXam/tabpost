// Demo mode for screenshots: open the dev server with ?demo.
// Replaces the API with made-up accounts and mail, so no real mailbox is
// needed and nothing private ends up in a picture. Dev builds only: main.tsx
// imports this behind import.meta.env.DEV, so production never contains it.

type DemoMail = {
  uid: number;
  account: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  snippet: string;
  minutesAgo: number;
  unread?: boolean;
  html?: string;
  attachments?: { filename: string; contentType: string; size: number }[];
};

const ACCOUNTS = [
  { email: 'alex@example.com', accountName: 'Personal' },
  { email: 'alex.morgan@work.example', accountName: 'Work' },
  { email: 'hello@sidequest.example', accountName: 'Side project' },
];

const MAILS: DemoMail[] = [
  {
    uid: 412, account: 'alex.morgan@work.example', fromName: 'Priya Nair', fromAddress: 'priya@work.example',
    subject: 'Release notes for Thursday', minutesAgo: 6, unread: true,
    snippet: 'Hi Alex, I drafted the release notes for Thursday. Could you look over the migration section before I send it out?',
    attachments: [{ filename: 'release-notes-draft.pdf', contentType: 'application/pdf', size: 184320 }],
    html: `<p>Hi Alex,</p>
<p>I drafted the release notes for Thursday. Could you look over the <b>migration section</b> before I send it out? The rest is mostly the changelog.</p>
<ul><li>New export dialog</li><li>Faster search on large folders</li><li>Migration: config key <code>sync.interval</code> was renamed</li></ul>
<p>The draft is attached. If it looks fine I'll post it to the team channel tomorrow morning.</p>
<p>Thanks!<br>Priya</p>`,
  },
  {
    uid: 88, account: 'alex@example.com', fromName: 'Sam Okafor', fromAddress: 'sam.okafor@example.net',
    subject: 'Board game night on Saturday?', minutesAgo: 34, unread: true,
    snippet: 'We are trying a new co-op game this week. Bring snacks if you can, I will handle drinks.',
  },
  {
    uid: 57, account: 'hello@sidequest.example', fromName: 'Lena Fischer', fromAddress: 'lena@example.org',
    subject: 'Feedback on the beta', minutesAgo: 95, unread: true,
    snippet: 'Played through the first three levels with my kids. The jump in level two is a bit too hard for them.',
  },
  {
    uid: 411, account: 'alex.morgan@work.example', fromName: 'Build Server', fromAddress: 'ci@work.example',
    subject: 'Nightly build #1482 passed', minutesAgo: 180,
    snippet: 'All 312 tests passed in 4m 12s. Artifacts are available for 7 days.',
  },
  {
    uid: 87, account: 'alex@example.com', fromName: 'Mia Hoffmann', fromAddress: 'mia.h@example.net',
    subject: 'Photos from the hike', minutesAgo: 320,
    snippet: 'Finally sorted them! The one from the summit turned out great, you have to see it.',
    attachments: [{ filename: 'summit.jpg', contentType: 'image/jpeg', size: 2411724 }],
  },
  {
    uid: 410, account: 'alex.morgan@work.example', fromName: 'Jonas Weber', fromAddress: 'jonas@work.example',
    subject: 'Re: Office move next month', minutesAgo: 600,
    snippet: 'Good point about the meeting rooms. I added it to the list for Friday.',
  },
  {
    uid: 56, account: 'hello@sidequest.example', fromName: 'Hosting Status', fromAddress: 'status@hosting.example',
    subject: 'Scheduled maintenance completed', minutesAgo: 1500,
    snippet: 'The maintenance window on your server has ended. No action is needed on your side.',
  },
  {
    uid: 86, account: 'alex@example.com', fromName: 'Library Downtown', fromAddress: 'noreply@library.example',
    subject: 'Your reservation is ready for pickup', minutesAgo: 2900,
    snippet: 'The book you reserved is waiting for you at the front desk until next Friday.',
  },
  {
    uid: 409, account: 'alex.morgan@work.example', fromName: 'Priya Nair', fromAddress: 'priya@work.example',
    subject: 'Sprint planning notes', minutesAgo: 4300,
    snippet: 'Here are the notes from today. We agreed to move the settings rework to the next sprint.',
  },
  {
    uid: 55, account: 'hello@sidequest.example', fromName: 'Tom Becker', fromAddress: 'tom.becker@example.com',
    subject: 'Collaboration idea', minutesAgo: 5800,
    snippet: 'I make chiptune music and would love to do a soundtrack for your next game. Interested?',
  },
  {
    uid: 85, account: 'alex@example.com', fromName: 'Sam Okafor', fromAddress: 'sam.okafor@example.net',
    subject: 'Re: Bike repair', minutesAgo: 8700,
    snippet: 'The shop on the corner fixed mine in a day. Not cheap, but they know what they are doing.',
  },
  {
    uid: 408, account: 'alex.morgan@work.example', fromName: 'HR Team', fromAddress: 'hr@work.example',
    subject: 'Holiday calendar for next year', minutesAgo: 11500,
    snippet: 'Please enter your planned days off by the end of the month so we can plan coverage.',
  },
];

const FOLDERS = [
  { path: 'INBOX', name: 'Inbox', specialUse: 'inbox', totalCount: 248 },
  { path: 'Sent', name: 'Sent', specialUse: 'sent', totalCount: 96, unreadCount: 0 },
  { path: 'Drafts', name: 'Drafts', specialUse: 'drafts', totalCount: 3, unreadCount: 0 },
  { path: 'Archive', name: 'Archive', specialUse: 'archive', totalCount: 1204, unreadCount: 0 },
  { path: 'Junk', name: 'Junk', specialUse: 'junk', totalCount: 12, unreadCount: 2 },
  { path: 'Trash', name: 'Trash', specialUse: 'trash', totalCount: 31, unreadCount: 0 },
];

const now = Date.now();
const seen = new Set<string>();
const key = (account: string, uid: number) => `${account}:${uid}`;

function toListItem(mail: DemoMail) {
  return {
    uid: mail.uid,
    seq: mail.uid,
    subject: mail.subject,
    from: { name: mail.fromName, address: mail.fromAddress },
    to: [{ address: mail.account }],
    date: new Date(now - mail.minutesAgo * 60000).toISOString(),
    flags: mail.unread && !seen.has(key(mail.account, mail.uid)) ? [] : ['\\Seen'],
    size: 4096,
    attachmentCount: mail.attachments?.length ?? 0,
    snippet: mail.snippet,
    accountEmail: mail.account,
    folder: 'INBOX',
  };
}

function unreadCount(account: string) {
  return MAILS.filter((m) => m.account === account && m.unread && !seen.has(key(m.account, m.uid))).length;
}

function respond(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
}

function handle(path: string, body: any): Promise<Response> {
  const email: string | undefined = body?.account?.email;
  switch (path) {
    case '/api/verify':
      return respond({ status: 'ok', email });
    case '/api/folders':
      return respond({
        folders: FOLDERS.map((f) => ({
          ...f,
          unreadCount: f.path === 'INBOX' ? unreadCount(email || '') : f.unreadCount,
        })),
      });
    case '/api/global-messages': {
      const messages = MAILS.map(toListItem);
      const unreads: Record<string, number> = {};
      const sliceUids: Record<string, number[]> = {};
      for (const a of ACCOUNTS) {
        unreads[a.email] = unreadCount(a.email);
        sliceUids[a.email] = MAILS.filter((m) => m.account === a.email).map((m) => m.uid);
      }
      return respond({ messages, total: messages.length, unreads, errors: [], sliceUids });
    }
    case '/api/messages': {
      const messages = body.folder === 'INBOX' ? MAILS.filter((m) => m.account === email).map(toListItem) : [];
      return respond({ messages, total: messages.length });
    }
    case '/api/message-detail': {
      const mail = MAILS.find((m) => m.account === email && m.uid === Number(body.uid)) ?? MAILS[0];
      seen.add(key(mail.account, mail.uid));
      return respond({
        detail: {
          uid: mail.uid,
          subject: mail.subject,
          from: { name: mail.fromName, address: mail.fromAddress },
          to: [{ name: 'Alex Morgan', address: mail.account }],
          date: new Date(now - mail.minutesAgo * 60000).toISOString(),
          flags: ['\\Seen'],
          html: mail.html,
          text: mail.html ? undefined : `${mail.snippet}\n\nCheers,\n${mail.fromName.split(' ')[0]}`,
          attachments: (mail.attachments ?? []).map((a, index) => ({ ...a, index })),
        },
      });
    }
    case '/api/subscribe':
      return respond({ token: 'demo', emails: ACCOUNTS.map((a) => a.email) });
    default:
      return respond({ status: 'ok' });
  }
}

// Seed the made-up accounts and start from an empty mail cache.
localStorage.setItem(
  'tabpost_accounts_v1',
  JSON.stringify(
    ACCOUNTS.map((a, i) => ({
      id: `demo-${i}`,
      email: a.email,
      accountName: a.accountName,
      password: 'demo',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpSecure: true,
    }))
  )
);
indexedDB.deleteDatabase('MailCacheDB');

const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, location.origin).pathname;
  if (!path.startsWith('/api/')) return realFetch(input, init);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  return handle(path, body);
};

// ?demo=open also opens the newest mail, for screenshots taken without clicks.
if (new URLSearchParams(location.search).get('demo') === 'open') {
  const openFirst = () => {
    const subject = [...document.querySelectorAll('h3, h4, span, div')].find(
      (el) => el.childElementCount === 0 && el.textContent === MAILS[0].subject
    ) as HTMLElement | undefined;
    if (subject) subject.click();
    else setTimeout(openFirst, 200);
  };
  setTimeout(openFirst, 500);
}

// Live updates: a stream that stays open and never sends anything.
class SilentEventSource extends EventTarget {
  readyState = 1;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  close() { this.readyState = 2; }
}
(window as any).EventSource = SilentEventSource;
