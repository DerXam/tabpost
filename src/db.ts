import { MailMessage } from './types';

export interface CachedMailMessage extends MailMessage {
  accountEmail: string; // db storage explicitly enforces account Email
  folder?: string;
  id?: string; // composite key: `${accountEmail}:${folder}:${uid}`
}

export function openMailDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const request = indexedDB.open('MailCacheDB', 1);

    request.onerror = (event) => {
      console.error('[DATABASE] IndexedDB open error:', event);
      reject(new Error('Failed to open database'));
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('accountEmail', 'accountEmail', { unique: false });
        store.createIndex('folder', 'folder', { unique: false });
        store.createIndex('uid', 'uid', { unique: false });
        store.createIndex('date', 'date', { unique: false });
      }
    };
  });
}

export async function saveLocalMessages(
  messages: MailMessage[], 
  defaultFolder: string,
  options?: { forceOverwriteFlags?: boolean }
): Promise<void> {
  try {
    const db = await openMailDB();
    const transaction = db.transaction('messages', 'readwrite');
    const store = transaction.objectStore('messages');

    // Load existing items to protect against stale background sync flag overrides
    const existingMap = new Map<string, MailMessage>();
    if (!options?.forceOverwriteFlags) {
      await new Promise<void>((res) => {
        const req = store.getAll();
        req.onsuccess = () => {
          for (const item of (req.result || [])) {
            if (item && item.id) {
              existingMap.set(item.id, item);
            }
          }
          res();
        };
        req.onerror = () => res();
      });
    }

    for (const msg of messages) {
      const accountEmailLower = (msg.accountEmail || '').toLowerCase();
      if (!accountEmailLower) continue;

      const folderName = (msg.folder || defaultFolder || 'INBOX').toUpperCase();
      const id = `${accountEmailLower}:${folderName}:${msg.uid}`;

      let finalFlags = Array.isArray(msg.flags) ? [...msg.flags] : [];

      if (!options?.forceOverwriteFlags) {
        const existing = existingMap.get(id);
        if (existing && Array.isArray(existing.flags)) {
          const existingHasSeen = existing.flags.some((f: string) => f.toLowerCase() === '\\seen');
          const incomingHasSeen = finalFlags.some((f: string) => f.toLowerCase() === '\\seen');
          if (existingHasSeen && !incomingHasSeen) {
            finalFlags.push('\\Seen');
          }
        }
      }

      const toPut = {
        ...msg,
        flags: finalFlags,
        accountEmail: accountEmailLower,
        folder: folderName,
        id: id
      };
      store.put(toPut);
    }

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = (e) => {
        console.error('[DATABASE] save transaction error:', e);
        reject((e.target as IDBTransaction).error);
      };
    });
  } catch (err) {
    console.error('[DATABASE] saveLocalMessages failing:', err);
  }
}

export async function getLocalMessages(
  accountEmail: string | null, // null for global mode across all accounts
  folder: string,
  searchQuery?: string
): Promise<MailMessage[]> {
  try {
    const db = await openMailDB();
    const transaction = db.transaction('messages', 'readonly');
    const store = transaction.objectStore('messages');

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        let results = request.result as MailMessage[];

        // 1. Filter by Account Email if in specific account mode
        if (accountEmail) {
          const lowerEmail = accountEmail.toLowerCase();
          results = results.filter(m => (m.accountEmail || '').toLowerCase() === lowerEmail);
        }

        // 2. Filter by Folder if in specific account mode
        const targetFolder = (folder || 'INBOX').toUpperCase();
        results = results.filter(m => (m.folder || 'INBOX').toUpperCase() === targetFolder);

        // 3. Filter by search query if set
        if (searchQuery) {
          const s = searchQuery.toLowerCase();
          results = results.filter(m => {
            const subjectMatch = m.subject && m.subject.toLowerCase().includes(s);
            const fromNameMatch = m.from && m.from.name && m.from.name.toLowerCase().includes(s);
            const fromAddressMatch = m.from && m.from.address && m.from.address.toLowerCase().includes(s);
            const toMatch = m.to && m.to.some(t => 
              (t.name && t.name.toLowerCase().includes(s)) ||
              (t.address && t.address.toLowerCase().includes(s))
            );
            return subjectMatch || fromNameMatch || fromAddressMatch || toMatch;
          });
        }

        // 4. Sort descending by date
        results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        resolve(results);
      };

      request.onerror = (e) => {
        console.error('[DATABASE] getLocalMessages read error:', e);
        reject((e.target as IDBRequest).error);
      };
    });
  } catch (err) {
    console.error('[DATABASE] getLocalMessages failed:', err);
    return [];
  }
}

export async function getMaxLocalUid(accountEmail: string, folder: string): Promise<number> {
  try {
    const db = await openMailDB();
    const transaction = db.transaction('messages', 'readonly');
    const store = transaction.objectStore('messages');

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const results = request.result as MailMessage[];
        const folderUpper = (folder || 'INBOX').toUpperCase();
        const accountLower = accountEmail.toLowerCase();
        
        const matched = results.filter(m => 
          (m.accountEmail || '').toLowerCase() === accountLower && 
          (m.folder || 'INBOX').toUpperCase() === folderUpper
        );
        
        if (matched.length === 0) {
          resolve(0);
        } else {
          const max = Math.max(...matched.map(m => m.uid));
          resolve(max);
        }
      };
      request.onerror = (e) => reject((e.target as IDBRequest).error);
    });
  } catch (err) {
    console.error('[DATABASE] getMaxLocalUid failed:', err);
    return 0;
  }
}

/**
 * Drop cached rows for a folder that the server no longer reports.
 *
 * The cache is otherwise append-only: the list is rendered from IndexedDB and a
 * sync only ever `put`s rows into it. So a message that disappears server-side
 * — deleted from another client, or written back by a refresh that raced a
 * local delete — sits in the list forever, because nothing ever takes it out.
 *
 * `serverUids` has to be the newest contiguous slice of the folder. Only rows
 * at or above its lowest uid are candidates; anything older simply was not part
 * of this answer and is left alone. Returns the number of rows removed.
 */
export async function pruneLocalMessages(
  accountEmail: string,
  folder: string,
  serverUids: number[]
): Promise<number> {
  if (!accountEmail || !serverUids || serverUids.length === 0) return 0;
  try {
    const keep = new Set(serverUids);
    const lowestKnownUid = Math.min(...serverUids);
    const emailLower = accountEmail.toLowerCase();
    const folderName = (folder || 'INBOX').toUpperCase();

    const db = await openMailDB();
    const transaction = db.transaction('messages', 'readwrite');
    const store = transaction.objectStore('messages');

    let removed = 0;
    await new Promise<void>((res) => {
      const req = store.getAll();
      req.onsuccess = () => {
        for (const row of (req.result || [])) {
          if (!row || !row.id) continue;
          if ((row.accountEmail || '').toLowerCase() !== emailLower) continue;
          if ((row.folder || 'INBOX').toUpperCase() !== folderName) continue;
          if (row.uid < lowestKnownUid) continue;
          if (keep.has(row.uid)) continue;
          store.delete(row.id);
          removed++;
        }
        res();
      };
      req.onerror = () => res();
    });

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = (e) => reject((e.target as IDBTransaction).error);
    });
    return removed;
  } catch (err) {
    console.error('[DATABASE] pruneLocalMessages failed:', err);
    return 0;
  }
}

export async function deleteLocalMessages(targets: { uid: number; accountEmail: string }[], folder: string): Promise<void> {
  try {
    const db = await openMailDB();
    const transaction = db.transaction('messages', 'readwrite');
    const store = transaction.objectStore('messages');
    
    // 1. Delete standard key format
    for (const t of targets) {
      const folderName = (folder || 'INBOX').toUpperCase();
      const id = `${t.accountEmail.toLowerCase()}:${folderName}:${t.uid}`;
      store.delete(id);
    }

    // 2. Scan-and-delete fallback to guarantee clean deletion across ALL folders
    // (This handles cases where folder names might be stored differently, e.g. nested or TRASH folder casing)
    const allRequest = store.getAll();
    allRequest.onsuccess = () => {
      const allMsgs = allRequest.result;
      for (const t of targets) {
        const targetEmailLower = t.accountEmail.toLowerCase();
        const matches = allMsgs.filter(m => 
          m.uid === t.uid && 
          (m.accountEmail || '').toLowerCase() === targetEmailLower
        );
        for (const m of matches) {
          if (m.id) {
            store.delete(m.id);
          }
        }
      }
    };
    
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = (e) => reject((e.target as IDBTransaction).error);
    });
  } catch (err) {
    console.error('[DATABASE] deleteLocalMessages failed:', err);
  }
}
