import React, { useState, useEffect } from 'react';
import { MailAccount, FolderNode, MailMessage, MailMessageDetail } from './types';
import { getLocalMessages, saveLocalMessages, getMaxLocalUid, deleteLocalMessages, pruneLocalMessages } from './db';
import LoginModal from './components/LoginModal';
import FolderList from './components/FolderList';
import MessageList from './components/MessageList';
import MessageDetailView from './components/MessageDetailView';
import MultiSelectDetailView from './components/MultiSelectDetailView';
import ComposeModal from './components/ComposeModal';
import { Mail, Plus, X, Shield, RefreshCw, ChevronLeft, Inbox, Folder, Bell, BellOff, Pencil } from 'lucide-react';

const STORAGE_KEY = 'tabpost_accounts_v1';
// Accounts saved before the rename to Tabpost; read once and moved to STORAGE_KEY.
const LEGACY_STORAGE_KEY = 'snappyclient_accounts_v1';

function updateFavicon(count: number) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  
  // Find all existing rel=icon icons and remove them to force hard browser repaint
  const existingLinks = document.querySelectorAll("link[rel~='icon']");
  existingLinks.forEach(el => el.parentNode?.removeChild(el));

  const link = document.createElement('link');
  link.type = 'image/png';
  link.rel = 'icon';

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 32, 32);

    if (count <= 0) {
      // Draw elegant default black envelope on transparent background
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      const ex = 4, ey = 7, ew = 24, eh = 17;
      ctx.beginPath();
      ctx.rect(ex, ey, ew, eh);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + ew / 2, ey + eh / 2);
      ctx.lineTo(ex + ew, ey);
      ctx.stroke();
    } else {
      // Draw solid alert background circle in Red-500
      ctx.fillStyle = '#ef4444'; 
      ctx.beginPath();
      ctx.arc(16, 16, 14, 0, 2 * Math.PI);
      ctx.fill();

      // White outline border
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Center bold white text
      ctx.fillStyle = '#ffffff';
      const textVal = count.toString();
      if (textVal.length === 1) {
        ctx.font = 'bold 18px system-ui, -apple-system, sans-serif';
      } else if (textVal.length === 2) {
        ctx.font = 'bold 14px system-ui, -apple-system, sans-serif';
      } else {
        ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(textVal, 16, 16);
    }

    link.href = canvas.toDataURL('image/png');
    document.getElementsByTagName('head')[0].appendChild(link);
  } catch (err) {
    console.error('Error updating favicon:', err);
  }
}

export default function App() {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [activeAccountIndex, setActiveAccountIndex] = useState<number>(0);
  const [isGlobalMode, setIsGlobalMode] = useState<boolean>(true);
  const [selectedAccountEmail, setSelectedAccountEmail] = useState<string | null>(null);
  const [globalUnreads, setGlobalUnreads] = useState<Record<string, number>>({});
  
  // Track last viewed folders per-account and folder-list drop-down visibility
  const [accountLastFolder, setAccountLastFolder] = useState<Record<string, string>>({});
  const [showFolderSelectionIdx, setShowFolderSelectionIdx] = useState<number | null>(null);

  // Editable account names
  const [editingAccountIdx, setEditingAccountIdx] = useState<number | null>(null);
  const [editingNameInput, setEditingNameInput] = useState<string>('');

  const getAccountDisplayName = (email?: string): string => {
    if (!email) return 'Unified Mail';
    const acc = accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
    if (acc && acc.accountName && acc.accountName.trim() !== '') {
      return acc.accountName.trim();
    }
    return email;
  };

  const handleSaveAccountName = (index: number) => {
    const updated = accounts.map((a, i) => i === index ? { ...a, accountName: editingNameInput.trim() || undefined } : a);
    setAccounts(updated);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (_) {}
    setEditingAccountIdx(null);
  };

  // 2. Fetch Active Account details on Index switch
  const activeAccount = accounts[activeAccountIndex];

  const getAccountForEmail = (email?: string) => {
    if (!email) return accounts[activeAccountIndex] || accounts[0];
    return accounts.find(a => a.email.toLowerCase() === email.toLowerCase()) || accounts[activeAccountIndex] || accounts[0];
  };
  
  // Session-arrived notification tracking
  const [sessionArrivedUnreads, setSessionArrivedUnreads] = useState<string[]>([]);
  const sessionKnownMessageIdsRef = React.useRef<Set<string>>(new Set());
  const loadedDirectoriesRef = React.useRef<Set<string>>(new Set());
  const [notificationPermission, setNotificationPermission] = useState<string>(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'default'
  );
  
  // View mode navigation router
  const [viewMode, setViewMode] = useState<'list' | 'detail' | 'navigation'>('list');

  // SSE Reconnection trigger state for robust client watchdog resets
  const [sseReconnectTrigger, setSseReconnectTrigger] = useState<number>(0);
  
  // UI states
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>('INBOX');
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [messageDetail, setMessageDetail] = useState<MailMessageDetail | null>(null);

  // Clear multi-select when switching folders or mode
  useEffect(() => {
    setSelectedIds([]);
  }, [selectedFolder, isGlobalMode, activeAccountIndex]);

  // Safety tracking refs to guarantee stale async request results are discarded
  const selectedUidRef = React.useRef<number | null>(null);
  const selectedAccountEmailRef = React.useRef<string | null>(null);
  const messagesRef = React.useRef<MailMessage[]>([]);

  useEffect(() => {
    selectedUidRef.current = selectedUid;
  }, [selectedUid]);

  useEffect(() => {
    selectedAccountEmailRef.current = selectedAccountEmail;
  }, [selectedAccountEmail]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Synchronize last viewed folders automatically
  useEffect(() => {
    if (!isGlobalMode && activeAccount) {
      setAccountLastFolder(prev => {
        if (prev[activeAccount.email] !== selectedFolder) {
          return {
            ...prev,
            [activeAccount.email]: selectedFolder
          };
        }
        return prev;
      });
    }
  }, [selectedFolder, activeAccount, isGlobalMode]);

  // Pagination & Search
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(30);
  const [totalMessages, setTotalMessages] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Loading indicator states
  const [loadingFolders, setLoadingFolders] = useState<boolean>(false);
  const [loadingMessages, setLoadingMessages] = useState<boolean>(false);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);

  // Modals / Overlays
  const [showAddAccount, setShowAddAccount] = useState<boolean>(false);
  const [showCompose, setShowCompose] = useState<boolean>(false);
  const [replyTarget, setReplyTarget] = useState<{ detail: MailMessageDetail; type: 'reply' | 'reply-all' | 'forward'; folder: string } | undefined>(undefined);

  const [globalError, setGlobalError] = useState<string | null>(null);

  // Messages the user just deleted, spammed or moved away from here.
  //
  // The IMAP move triggers an `expunge` push that comes straight back to us and
  // kicks off a silent refresh. That refresh races the local removal: its cache
  // read can still see the message (it flickers back in), and its server answer
  // can still contain it (it gets written into IndexedDB again and, since the
  // cache is what the list renders, stays there). Holding the keys down until
  // both sides have caught up is what keeps the list steady.
  const removedKeysRef = React.useRef<Map<string, number>>(new Map());
  const REMOVED_KEY_TTL_MS = 60000;

  const removedKey = (accountEmail: string | undefined, folder: string, uid: number) =>
    `${(accountEmail || '').toLowerCase()}:${(folder || 'INBOX').toUpperCase()}:${uid}`;

  const rememberRemoved = (targets: { uid: number; accountEmail?: string }[], folder: string) => {
    const now = Date.now();
    for (const [key, at] of removedKeysRef.current) {
      if (now - at > REMOVED_KEY_TTL_MS) removedKeysRef.current.delete(key);
    }
    for (const t of targets) {
      removedKeysRef.current.set(removedKey(t.accountEmail || activeAccount?.email, folder, t.uid), now);
    }
  };

  // Undone when the server refuses the removal, so a message that is still
  // sitting in the mailbox is not hidden from the list.
  const forgetRemoved = (target: { uid: number; accountEmail?: string }, folder: string) => {
    removedKeysRef.current.delete(removedKey(target.accountEmail || activeAccount?.email, folder, target.uid));
  };

  // Applied to both what a sync displays and what it writes to the cache, so a
  // removed message can neither reappear in the list nor crawl back into
  // IndexedDB behind it.
  const withoutRemoved = <T extends { uid: number; accountEmail?: string; folder?: string }>(
    list: T[],
    fallbackFolder: string
  ): T[] => {
    if (removedKeysRef.current.size === 0) return list;
    const now = Date.now();
    return list.filter(m => {
      const at = removedKeysRef.current.get(removedKey(m.accountEmail, m.folder || fallbackFolder, m.uid));
      if (at === undefined) return true;
      if (now - at > REMOVED_KEY_TTL_MS) {
        removedKeysRef.current.delete(removedKey(m.accountEmail, m.folder || fallbackFolder, m.uid));
        return true;
      }
      return false;
    });
  };

  // 1. Initial State Load from LocalStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
      if (stored && localStorage.getItem(STORAGE_KEY) === null) {
        localStorage.setItem(STORAGE_KEY, stored);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
      if (stored) {
        const parsed = JSON.parse(stored) as MailAccount[];
        if (parsed && parsed.length > 0) {
          setAccounts(parsed);
          setActiveAccountIndex(0);
        }
      }
    } catch (_) {
      console.error('LocalStorage failed to load accounts.');
    }
  }, []);

  // 1a. Request Desktop Notification permission on app launch
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      console.log('[NOTIFICATION DEBUG] Page loaded. Notification API exists. Current permission state:', Notification.permission);
      if (Notification.permission === 'default') {
        console.log('[NOTIFICATION DEBUG] Requesting notification permission on load...');
        Notification.requestPermission().then(permission => {
          console.log('[NOTIFICATION DEBUG] Loaded permission request completed. Result:', permission);
          setNotificationPermission(permission);
        }).catch(err => {
          console.error('[NOTIFICATION DEBUG] Load permission request failed/rejected:', err);
        });
      }
    } else {
      console.warn('[NOTIFICATION DEBUG] Notification API is not available on this browser/platform');
    }
  }, []);

  // 1b. Update Favicon dynamically whenever the session's arrived unread count changes
  useEffect(() => {
    updateFavicon(sessionArrivedUnreads.length);
  }, [sessionArrivedUnreads.length]);

  // 1c. Spot newly-arrived unreads in a freshly fetched list. Deliberately not
  // tied to the rendered list: while a search is active that list holds only
  // hits, so handleRefreshAll feeds this an unfiltered slice instead.
  const detectArrivals = (list: MailMessage[], directoryId: string) => {
    if (list.length === 0) return;

    if (!loadedDirectoriesRef.current.has(directoryId)) {
      // First time this mailbox/directory combination is populated in this session.
      // Mark all currently visible messages as "pre-existing" / known, so they do not trigger alarms.
      list.forEach(m => {
        sessionKnownMessageIdsRef.current.add(`${m.accountEmail || ''}:${m.uid}`);
      });
      loadedDirectoriesRef.current.add(directoryId);
      return;
    }

    // Directory has been viewed before - so any brand-new messages found in the list are real new arrivals!
    const newlyArrived: MailMessage[] = [];
    list.forEach(m => {
      const compositeId = `${m.accountEmail || ''}:${m.uid}`;
      if (!sessionKnownMessageIdsRef.current.has(compositeId)) {
        sessionKnownMessageIdsRef.current.add(compositeId);
        const isUnread = !m.flags.some(f => f.toLowerCase() === '\\seen');
        if (isUnread) {
          newlyArrived.push(m);
        }
      }
    });

    if (newlyArrived.length === 0) return;

    const arrivedIds = newlyArrived.map(m => `${m.accountEmail || ''}:${m.uid}`);
    setSessionArrivedUnreads(prev => {
      const merged = new Set([...prev, ...arrivedIds]);
      return Array.from(merged);
    });

    // Push real OS system alerts
    newlyArrived.forEach(msg => {
      const sender = msg.from.name || msg.from.address;
      const hasNotificationApi = typeof window !== 'undefined' && 'Notification' in window;
      const currentPermission = hasNotificationApi ? Notification.permission : 'not-supported';

      console.log('[NOTIFICATION DEBUG] New email arrived, attempting alert:', {
        uid: msg.uid,
        from: sender,
        subject: msg.subject,
        hasNotificationApi,
        permission: currentPermission
      });

      if (hasNotificationApi && currentPermission === 'granted') {
        try {
          console.log('[NOTIFICATION DEBUG] Spawning Notification instance...');
          const notification = new Notification(`New Mail from ${sender}`, {
            body: msg.subject || '(No Subject)',
            icon: '/favicon.ico',
            tag: `${msg.accountEmail || ''}:${msg.uid}`
          });

          console.log('[NOTIFICATION DEBUG] Notification spawned successfully:', notification);

          notification.onshow = () => {
            console.log('[NOTIFICATION DEBUG] Notification is now active/visible in OS UI');
          };

          notification.onerror = (evt) => {
            console.error('[NOTIFICATION DEBUG] Notification instance reported error event:', evt);
          };

          notification.onclick = () => {
            console.log('[NOTIFICATION DEBUG] User clicked notification! Opening message detail.');
            window.focus();
            setSearchQuery('');
            setSelectedUid(msg.uid);
            setSelectedAccountEmail(msg.accountEmail || null);
            setViewMode('detail');
          };
        } catch (e) {
          console.error('[NOTIFICATION DEBUG] Exception thrown during new Notification instantiation:', e);
        }
      } else {
        console.warn('[NOTIFICATION DEBUG] Notification not shown because conditions are not met:', {
          apiAvailable: hasNotificationApi,
          permissionStatus: currentPermission,
          grantedRequired: 'Notification.permission must be "granted" (Firefox may suppress/require user click trigger)'
        });
      }
    });
  };

  const activeDirectoryId = isGlobalMode ? 'global:INBOX' : `${activeAccount?.email || ''}:${selectedFolder}`;

  // Scan the rendered list. Suppressed while a search is active: its hits are no
  // slice of the mailbox, so old unread matches would be taken for new arrivals.
  useEffect(() => {
    if (searchQuery) return;
    detectArrivals(messages, activeDirectoryId);
  }, [messages, isGlobalMode, activeAccount?.email, selectedFolder, searchQuery]);

  // 1d. Keep session count in perfect sync with seen flag mutations (e.g. read / clicked mails)
  useEffect(() => {
    if (sessionArrivedUnreads.length === 0) return;

    let updated = false;
    const nextArrived = sessionArrivedUnreads.filter(id => {
      const msg = messages.find(m => `${m.accountEmail || ''}:${m.uid}` === id);
      if (msg) {
        const isSeen = msg.flags.some(f => f.toLowerCase() === '\\seen');
        if (isSeen) {
          updated = true;
          return false; // has been read, clear from tracker
        }
      }
      return true;
    });

    if (updated) {
      setSessionArrivedUnreads(nextArrived);
    }
  }, [messages, sessionArrivedUnreads]);

  useEffect(() => {
    if (!isGlobalMode && activeAccount) {
      fetchFolders(activeAccount);
    } else if (!isGlobalMode && !activeAccount) {
      setFolders([]);
      setMessages([]);
    }
  }, [activeAccount?.email, isGlobalMode]);

  // 3. Retrieve Messages upon changing selected Folder, page, query, account, or global mode
  useEffect(() => {
    if (isGlobalMode) {
      fetchGlobalMessages(false, false);
    } else if (activeAccount && selectedFolder) {
      fetchMessages(activeAccount, selectedFolder, page, searchQuery, false, false);
    } else {
      setMessages([]);
    }
  }, [selectedFolder, searchQuery, page, activeAccount?.email, isGlobalMode]);

  // Lazy loading incremental paging fetch
  const handleLoadMore = async () => {
    if (loadingMessages) return;
    if (isGlobalMode) {
      await fetchGlobalMessages(false, true);
    } else if (activeAccount && selectedFolder) {
      await fetchMessages(activeAccount, selectedFolder, page, searchQuery, false, true);
    }
  };

  // (Relocated below to prevent ReferenceError due to non-hoisted functions)

  // Network Fetch Action: Folders list (supports silent background sync)
  const fetchFolders = async (account: MailAccount, silent = false) => {
    if (!silent) {
      setLoadingFolders(true);
      setGlobalError(null);
    }
    try {
      const response = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Connection to mail folders failed');
      }
      setFolders(data.folders || []);
      
      // Keep existing selected folder if still valid, else inbox
      const foundInList = data.folders?.some((f: any) => f.path === selectedFolder);
      if (!foundInList) {
        setSelectedFolder('INBOX');
      }
    } catch (err: any) {
      if (!silent) {
        setGlobalError(`Folders sync error: ${err.message || 'Check connection'}`);
      }
    } finally {
      if (!silent) {
        setLoadingFolders(false);
      }
    }
  };

  // Set Global mode folders
  useEffect(() => {
    if (isGlobalMode) {
      const counts = Object.values(globalUnreads) as number[];
      const sumunseen = counts.reduce((a, b) => a + b, 0);
      setFolders([
        {
          path: 'INBOX',
          name: 'Global Inbox',
          unreadCount: sumunseen,
          totalCount: totalMessages,
          specialUse: 'inbox',
        }
      ]);
    }
  }, [isGlobalMode, globalUnreads, totalMessages]);

  // `background` runs the sync for its side effects only: it ignores the active
  // search, writes the result to the cache and returns it, but never touches the
  // rendered list. handleRefreshAll uses it to see mail a search filters away.
  const fetchGlobalMessages = async (silent = false, isLoadMore = false, background = false): Promise<MailMessage[] | null> => {
    if (accounts.length === 0) return null;
    if (loadingMessages && !silent) return null;
    const query = background ? '' : searchQuery;
    if (!silent) {
      setLoadingMessages(true);
      setGlobalError(null);
    }
    try {
      // 1. INSTANT LOCAL CACHE LOAD
      if (!isLoadMore && !background) {
        const localMails = withoutRemoved(await getLocalMessages(null, 'INBOX', searchQuery), 'INBOX');
        if (localMails.length > 0) {
          setMessages(localMails);
          setTotalMessages(localMails.length);
        }
      }

      // 2. RETRIEVE MAX UIDS ACROSS ACCOUNTS
      // Bypassed if loading more so that standard paginated fetch takes priority
      const localUids: Record<string, number> = {};
      const localStats: Record<string, { total: number; unread: number; maxUid: number }> = {};
      if (!isLoadMore) {
        for (const acc of accounts) {
          const maxUid = await getMaxLocalUid(acc.email, 'INBOX');
          localUids[acc.email] = maxUid;

          // Compute local total and local unread for INBOX of each account
          const accMails = await getLocalMessages(acc.email, 'INBOX', '');
          const accUnread = accMails.filter(m => !m.flags.some(f => f.toLowerCase() === '\\seen')).length;
          localStats[acc.email.toLowerCase()] = {
            total: accMails.length,
            unread: accUnread,
            maxUid
          };
        }
      }

      const nextPage = isLoadMore ? page + 1 : 1;

      // 3. API FETCH
      const response = await fetch('/api/global-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accounts,
          page: nextPage,
          pageSize,
          search: query,
          localUids: isLoadMore ? {} : localUids,
          localStats: isLoadMore ? {} : localStats
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Connection to global mailbox failed');
      }

      // 4. SAVE NEWLY FETCHED RANGE & FLAGS TO CACHE
      if (data.messages && data.messages.length > 0) {
        await saveLocalMessages(withoutRemoved(data.messages, 'INBOX'), 'INBOX');
      }

      // 4b. RECONCILE DELETIONS
      // The merged page is date-sorted and sliced across accounts, so it is no
      // slice of any single mailbox. The server reports each account's own
      // newest range separately for exactly this purpose.
      if (!isLoadMore && !query && data.sliceUids) {
        for (const [email, uids] of Object.entries(data.sliceUids as Record<string, number[]>)) {
          await pruneLocalMessages(email, 'INBOX', uids)
            .catch(e => console.error('Failed to prune vanished messages from IndexedDB:', e));
        }
      }

      // 5. QUERY LATEST MERGED AND DEDUPLICATE SET FROM LOCAL CACHE
      const mergedLocalMails = withoutRemoved(await getLocalMessages(null, 'INBOX', query), 'INBOX');
      if (!background) {
        setMessages(mergedLocalMails);
        setPage(isLoadMore ? nextPage : 1);
        setTotalMessages(data.total !== undefined ? data.total : mergedLocalMails.length);
      }

      if (data.unreads) {
        setGlobalUnreads(data.unreads);
      }
      if (data.errors && data.errors.length > 0 && !silent) {
        setGlobalError(`Sync warning: some mailboxes could not connect:\n${data.errors.join('\n')}`);
      }

      return mergedLocalMails;
    } catch (err: any) {
      if (!silent) {
        setGlobalError(`Global mailbox sync error: ${err.message || 'Check connection'}`);
      }
      return null;
    } finally {
      if (!silent) {
        setLoadingMessages(false);
      }
    }
  };

  // Network Fetch Action: Messages list (supports silent background sync)
  const fetchMessages = async (account: MailAccount, folder: string, currentPage: number, query: string, silent = false, isLoadMore = false, background = false): Promise<MailMessage[] | null> => {
    if (isGlobalMode) {
      return await fetchGlobalMessages(silent, isLoadMore, background);
    }
    if (loadingMessages && !silent) return null;
    if (!silent) {
      setLoadingMessages(true);
      setGlobalError(null);
    }
    try {
      // 1. INSTANT LOCAL CACHE LOAD
      if (!isLoadMore && !background) {
        const localMails = withoutRemoved(await getLocalMessages(account.email, folder, query), folder);
        if (localMails.length > 0) {
          setMessages(localMails);
          setTotalMessages(localMails.length);
        }
      }

      // 2. RETRIEVE MAX UID
      // Bypassed if loading more so that standard older paginated fetch takes priority
      const maxLocalUid = isLoadMore ? 0 : await getMaxLocalUid(account.email, folder);

      let localTotal = 0;
      let localUnread = 0;
      if (!isLoadMore) {
        const localMails = await getLocalMessages(account.email, folder, '');
        localTotal = localMails.length;
        localUnread = localMails.filter(m => !m.flags.some(f => f.toLowerCase() === '\\seen')).length;
      }

      const nextPage = isLoadMore ? page + 1 : 1;

      // 3. API FETCH
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account,
          folder,
          page: nextPage,
          pageSize,
          search: query,
          maxLocalUid,
          localTotal,
          localUnread
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Filing messages list failed');
      }

      // 4. SAVE TO CACHE
      const serverMessages: any[] = data.messages || [];
      if (serverMessages.length > 0) {
        const tagged = serverMessages.map((m: any) => ({
          ...m,
          accountEmail: account.email,
          folder: folder
        }));
        await saveLocalMessages(withoutRemoved(tagged, folder), folder);

        // 4b. RECONCILE DELETIONS
        // A plain page-1 answer is the newest contiguous slice of the folder,
        // so anything cached inside that range and missing from it is gone
        // server-side. Search hits and older pages are not a slice, so they
        // must not be used to prune.
        if (!isLoadMore && !query && !data.noChanges) {
          await pruneLocalMessages(account.email, folder, serverMessages.map((m: any) => m.uid))
            .catch(e => console.error('Failed to prune vanished messages from IndexedDB:', e));
        }
      }

      // 5. QUERY LATEST MERGED SET FROM CACHE
      const mergedLocalMails = withoutRemoved(await getLocalMessages(account.email, folder, query), folder);
      if (!background) {
        setMessages(mergedLocalMails);
        setPage(isLoadMore ? nextPage : 1);
        setTotalMessages(data.total !== undefined ? data.total : mergedLocalMails.length);
      }

      return mergedLocalMails;
    } catch (err: any) {
      if (!silent) {
        setGlobalError(`Messages sync error: ${err.message || 'Check connection'}`);
      }
      return null;
    } finally {
      if (!silent) {
        setLoadingMessages(false);
      }
    }
  };

  // Central refresh mechanism for both folder badges & mail lists
  const handleRefreshAll = async (silent = false) => {
    if (isGlobalMode) {
      await fetchGlobalMessages(silent);
    } else {
      if (!activeAccount) return;
      await Promise.all([
        fetchFolders(activeAccount, silent),
        fetchMessages(activeAccount, selectedFolder, page, searchQuery, silent)
      ]);
    }

    // A search shows only its hits, so new mail that does not match is invisible
    // and never reaches the cache. Pull the unfiltered newest slice as well and
    // run arrival detection on it, so notifications and the favicon badge keep
    // working while a search is open. Costs one extra round trip per refresh,
    // and only for as long as the search box holds something.
    if (searchQuery) {
      const list = isGlobalMode
        ? await fetchGlobalMessages(true, false, true)
        : await fetchMessages(activeAccount!, selectedFolder, 1, '', true, false, true);
      if (list) detectArrivals(list, activeDirectoryId);
    }
  };

  const handleRefreshAllRef = React.useRef(handleRefreshAll);
  useEffect(() => {
    handleRefreshAllRef.current = handleRefreshAll;
  });

  // 5. Periodic background auto-refresh fallback
  useEffect(() => {
    const handleSync = () => {
      handleRefreshAll(true);
    };

    const interval = setInterval(handleSync, 300000); // fallback sync every 5 minutes

    return () => clearInterval(interval);
  }, [activeAccount, selectedFolder, page, searchQuery, isGlobalMode, accounts.length]);

  // 6. Real-time subscription via Server-Sent Events (SSE / IMAP IDLE proxy) with Heartbeat Watchdog
  useEffect(() => {
    if (accounts.length === 0) return;

    console.log('[SSE] Connecting to real-time event updates for:', accounts.map(a => a.email), `(Trigger: ${sseReconnectTrigger})`);

    let cancelled = false;
    let eventSource: EventSource | null = null;
    let lastMessageTime = Date.now();
    let watchdogInterval: NodeJS.Timeout | null = null;

    const getStateString = (state: number) => {
      switch (state) {
        case 0: return 'CONNECTING (0)';
        case 1: return 'OPEN (1)';
        case 2: return 'CLOSED (2)';
        default: return `UNKNOWN (${state})`;
      }
    };

    const triggerReconnect = () => {
      const currentState = eventSource ? getStateString(eventSource.readyState) : 'NOT CONNECTED';
      console.log(`[SSE] Forcing connection reset (Current state: ${currentState})...`);
      try {
        eventSource?.close();
      } catch (_) {}
      setSseReconnectTrigger(prev => prev + 1);
      // Also silently pull latest mails immediately to guarantee sync upon reconnect
      handleRefreshAllRef.current(true);
    };

    // A heartbeat watchdog to detect silent connection drops (e.g. after PC hibernation/sleep or network change)
    // Since the server sends a keepalive ping every 25 seconds, we should receive *some* message within 45 seconds.
    watchdogInterval = setInterval(() => {
      // The token exchange is still in flight, or it failed. Give it the same
      // grace period as a silent connection, then retry the whole handshake.
      if (!eventSource) {
        if (Date.now() - lastMessageTime > 45000) {
          console.warn('[SSE Watchdog] No active subscription established. Retrying handshake...');
          triggerReconnect();
        }
        return;
      }

      const timeSinceLastMessage = Date.now() - lastMessageTime;
      const stateStr = getStateString(eventSource.readyState);
      console.log(`[SSE Watchdog] Checking connection... ${Math.round(timeSinceLastMessage / 1000)}s since last activity. Connection State: ${stateStr}`);

      if (timeSinceLastMessage > 45000) {
        console.warn(`[SSE Watchdog] Timeout: No messages for ${Math.round(timeSinceLastMessage / 1000)}s. Reconnecting...`);
        triggerReconnect();
      } else if (eventSource.readyState === 2) {
        console.warn(`[SSE Watchdog] Connection is CLOSED. Triggering immediate reconnect...`);
        triggerReconnect();
      }
    }, 10000);

    const onMessage = (event: MessageEvent) => {
      // Update the heartbeat timestamp for any incoming message (ping, connected, real updates)
      lastMessageTime = Date.now();

      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') {
          console.log('[SSE] SSE channel connected successfully. Listening for real-time mailbox push notifications.');
        } else if (data.type === 'ping') {
          console.log('[SSE] Heartbeat ping received from server. Connection is verified healthy.');
        } else if (data.type === 'exists' || data.type === 'flags' || data.type === 'expunge') {
          console.log('[SSE] Real-time mailbox event received:', data);
          // Trigger a silent background refresh using the latest ref function to avoid stale query closures!
          handleRefreshAllRef.current(true);
        }
      } catch (err) {
        // Ignored parsing error
      }
    };

    const onError = (e: Event) => {
      console.warn('[SSE] Connection error/loss detected by EventSource. State:', eventSource?.readyState, e);
      // Sometimes EventSource auto-reconnection fails or gets stuck in a loop after wakeup.
      // We let the browser try, but our 45s heartbeat watchdog is the ultimate safety net.
    };

    // Reconnect proactively if the browser fires the 'online' event (network interface came back up after sleep)
    const handleOnline = () => {
      console.log('[SSE] Browser came online. Forcing SSE reconnect to guarantee sync...');
      triggerReconnect();
    };

    // Reconnect proactively when the page visibility changes (user returned to tab, or computer woke up)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('[SSE] Tab became visible. Verifying connection or forcing reconnect...');
        // If we were sleeping, lastMessageTime will be far in the past.
        const timeSinceLastMessage = Date.now() - lastMessageTime;
        if (timeSinceLastMessage > 45000) {
          console.log(`[SSE] Tab visible after sleep/hibernation (${Math.round(timeSinceLastMessage / 1000)}s since last update). Reconnecting...`);
          triggerReconnect();
        } else {
          // Even if not timed out yet, do a silent refresh to make sure we didn't miss anything during hidden state
          handleRefreshAllRef.current(true);
        }
      }
    };

    // An EventSource cannot carry a request body, so we first exchange the
    // account credentials for a short-lived, single-use subscription token.
    // The server no longer hands out event streams for a plain address list —
    // that let anyone watch when mail arrived for an address they guessed.
    const connect = async () => {
      try {
        const response = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accounts })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Real-time subscription was refused');
        }
        if (cancelled) return;

        eventSource = new EventSource(`/api/events?token=${encodeURIComponent(data.token)}`);
        eventSource.onmessage = onMessage;
        eventSource.onerror = onError;
        lastMessageTime = Date.now();
      } catch (err) {
        // Leave eventSource null; the watchdog retries on the next tick.
        console.warn('[SSE] Could not establish real-time subscription:', err);
      }
    };

    connect();

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      console.log('[SSE] Closing real-time event source and cleaning timers');
      cancelled = true;
      if (watchdogInterval) clearInterval(watchdogInterval);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      eventSource?.close();
    };
  }, [accounts, isGlobalMode, activeAccount, selectedFolder, sseReconnectTrigger]);

  // Network Fetch Action: Message Detail viewer
  const fetchMessageDetail = async (account: MailAccount, folder: string, uid: number, email?: string) => {
    setLoadingDetail(true);
    setGlobalError(null);
    try {
      const response = await fetch('/api/message-detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, folder, uid })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Loading message body failed');
      }

      // Safeguard: Check if this response is still for the currently selected message to avoid race conditions
      if (selectedUidRef.current !== uid || (email && selectedAccountEmailRef.current !== email)) {
        console.log('[Detail] Stale detail request ignored for UID:', uid);
        return;
      }

      setMessageDetail(data.detail);
    } catch (err: any) {
      if (selectedUidRef.current === uid && (!email || selectedAccountEmailRef.current === email)) {
        setGlobalError(`Detail load error: ${err.message || 'Could not fetch message contents'}`);
      }
    } finally {
      if (selectedUidRef.current === uid && (!email || selectedAccountEmailRef.current === email)) {
        setLoadingDetail(false);
      }
    }
  };

  // Handler: Add Account
  const handleAddAccount = (newAccount: MailAccount) => {
    const updated = [...accounts, newAccount];
    setAccounts(updated);
    saveAccounts(updated);
    setActiveAccountIndex(updated.length - 1);
    setShowAddAccount(false);
  };

  // Handler: Save persistent accounts
  const saveAccounts = (items: MailAccount[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  };

  // Handler: Logout active configuration
  const handleLogoutAccount = (indexToLogout?: number) => {
    const targetIdx = indexToLogout !== undefined ? indexToLogout : activeAccountIndex;
    const filtered = accounts.filter((_, i) => i !== targetIdx);

    setAccounts(filtered);
    saveAccounts(filtered);
    
    // Safety check constraints
    if (filtered.length > 0) {
      const nextIndex = Math.max(0, targetIdx - 1);
      setActiveAccountIndex(nextIndex);
    } else {
      setActiveAccountIndex(0);
      setSelectedFolder('INBOX');
      setFolders([]);
      setMessages([]);
      setSelectedUid(null);
      setMessageDetail(null);
    }
  };

  // Single seen togglers
  const handleMarkSeenSingle = async (uid: number, nextSeen: boolean, accountEmail?: string) => {
    const email = accountEmail || activeAccount?.email;
    const targetAccount = getAccountForEmail(email);
    const folder = isGlobalMode ? 'INBOX' : selectedFolder;

    let stateChanged = false;

    // Synchronous optimistic update to React state and IndexedDB local cache
    setMessages(prev => {
      const targetMsg = prev.find(m => m.uid === uid && (!isGlobalMode || m.accountEmail === email));
      if (targetMsg) {
        const currentlySeen = targetMsg.flags.some(f => f.toLowerCase() === '\\seen');
        if (currentlySeen === nextSeen) {
          // Message already matches requested state!
          return prev;
        }
      }

      stateChanged = true;
      return prev.map(m => {
        if (m.uid === uid && (!isGlobalMode || m.accountEmail === email)) {
          const flags = [...m.flags];
          const hasSeen = flags.some(f => f.toLowerCase() === '\\seen');
          let nextFlags = [...flags];
          if (nextSeen) {
            if (!hasSeen) nextFlags.push('\\Seen');
          } else {
            nextFlags = flags.filter(f => f.toLowerCase() !== '\\seen');
          }
          const updatedM = { ...m, flags: nextFlags };
          if (email) {
            saveLocalMessages([updatedM], folder, { forceOverwriteFlags: true }).catch(e => {
              console.error('Failed to sync individual seen state inside handleMarkSeenSingle:', e);
            });
          }
          return updatedM;
        }
        return m;
      });
    });

    if (!stateChanged) {
      // If state didn't change (already seen/unread), still guarantee server is notified if needed
      try {
        await fetch('/api/mark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: targetAccount, folder, uid, markSeen: nextSeen })
        });
      } catch (_) {}
      return;
    }

    // Sync folder unread counters synchronously
    if (isGlobalMode) {
      if (email) {
        setGlobalUnreads(prev => ({
          ...prev,
          [email]: Math.max(0, (prev[email] || 0) + (nextSeen ? -1 : 1))
        }));
      }
    } else {
      setFolders(prev => prev.map(f => {
        if (f.path === folder) {
          const change = nextSeen ? -1 : 1;
          const current = f.unreadCount;
          return { ...f, unreadCount: Math.max(0, current + change) };
        }
        return f;
      }));
    }

    if (nextSeen) {
      const searchEmail = email || '';
      const matchId1 = `${searchEmail}:${uid}`.toLowerCase();
      const matchId2 = `:${uid}`;
      setSessionArrivedUnreads(prev => prev.filter(id => {
        const lowerId = id.toLowerCase();
        return lowerId !== matchId1 && lowerId !== matchId2;
      }));
    }

    // Notify IMAP server in background
    try {
      await fetch('/api/mark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: targetAccount,
          folder,
          uid,
          markSeen: nextSeen
        })
      });
    } catch (_) {}
  };

  // 4. Retrieve Detail once message selection is clicked (and instantly mark unreads as read)
  useEffect(() => {
    if (selectedUid !== null) {
      const email = selectedAccountEmail || activeAccount?.email;
      const targetAccount = getAccountForEmail(email);
      const folder = isGlobalMode ? 'INBOX' : selectedFolder;

      // Find the message in our safety reference to instantly mark it as read locally & on server
      const msg = messagesRef.current.find(m => m.uid === selectedUid && (!isGlobalMode || m.accountEmail === email));
      if (msg) {
        const isUnread = !msg.flags.some(f => f.toLowerCase() === '\\seen');
        if (isUnread) {
          console.log('[Selection] Snappily marking selected unread message as read locally & on IMAP server:', selectedUid);
          handleMarkSeenSingle(selectedUid, true, email || undefined);
        }
      }

      fetchMessageDetail(targetAccount, folder, selectedUid, email);
    } else {
      setMessageDetail(null);
    }
  }, [selectedUid, selectedAccountEmail, isGlobalMode, activeAccountIndex, selectedFolder]);

  // Bulk set flags
  const handleBulkMark = async (targets: { uid: number; accountEmail?: string }[], makeSeen: boolean) => {
    // Run in parallel
    await Promise.all(targets.map(async (target) => {
      const email = target.accountEmail || activeAccount?.email;
      const targetAccount = getAccountForEmail(email);
      const folder = isGlobalMode ? 'INBOX' : selectedFolder;
      try {
        await fetch('/api/mark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: targetAccount,
            folder,
            uid: target.uid,
            markSeen: makeSeen
          })
        });
      } catch (_) {}
    }));

    // Local changes sync & database persistent writeback
    const updatedMessagesToSave: MailMessage[] = [];
    setMessages(prev => prev.map(m => {
      const match = targets.find(t => t.uid === m.uid && (!isGlobalMode || t.accountEmail === m.accountEmail));
      if (match) {
        const flags = [...m.flags];
        let nextM: MailMessage;
        if (makeSeen) {
          if (!flags.some(f => f.toLowerCase() === '\\seen')) flags.push('\\Seen');
          nextM = { ...m, flags };
        } else {
          nextM = { ...m, flags: flags.filter(f => f.toLowerCase() !== '\\seen') };
        }
        updatedMessagesToSave.push(nextM);
        return nextM;
      }
      return m;
    }));

    if (updatedMessagesToSave.length > 0) {
      const folder = isGlobalMode ? 'INBOX' : selectedFolder;
      saveLocalMessages(updatedMessagesToSave, folder).catch(e => {
        console.error('Failed to save bulk mark flags in IndexedDB:', e);
      });
    }

    if (makeSeen) {
      const matchCompIds = new Set(
        targets.map(t => `${t.accountEmail || ''}:${t.uid}`.toLowerCase())
      );
      setSessionArrivedUnreads(prev => prev.filter(id => {
        const lowerId = id.toLowerCase();
        const parts = lowerId.split(':');
        const uidPart = parts[parts.length - 1];
        return !matchCompIds.has(lowerId) && !matchCompIds.has(`:${uidPart}`);
      }));
    }

    if (isGlobalMode) {
      fetchGlobalMessages(true);
    } else if (activeAccount) {
      fetchFolders(activeAccount);
    }
  };

  // Bulk / Single Mark as Spam
  const handleMarkSpamMessages = async (targetsToSpam: { uid: number; accountEmail?: string }[]) => {
    // Marked before the network call: the expunge push can arrive while these
    // requests are still in flight.
    rememberRemoved(targetsToSpam, isGlobalMode ? 'INBOX' : selectedFolder);
    await Promise.all(targetsToSpam.map(async (target) => {
      const email = target.accountEmail || activeAccount?.email;
      const targetAccount = getAccountForEmail(email);
      const folder = isGlobalMode ? 'INBOX' : selectedFolder;

      let junkFolder = '';
      if (!isGlobalMode) {
        const junkFolderNode = folders.find(f => f.specialUse === 'junk' || f.path.toLowerCase().includes('spam') || f.path.toLowerCase().includes('junk'));
        junkFolder = junkFolderNode ? junkFolderNode.path : 'Junk';
      }

      try {
        const response = await fetch('/api/spam', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: targetAccount,
            folder,
            uid: target.uid,
            junkFolder
          })
        });
        if (!response.ok) throw new Error(`Server refused the request (${response.status})`);
      } catch (err) {
        console.error('Mark spam step failed for target:', target, err);
        forgetRemoved(target, folder);
      }
    }));

    // Remove from loaded list
    setMessages(prev => prev.filter(m => {
      const isTarget = targetsToSpam.some(t => t.uid === m.uid && (!isGlobalMode || (t.accountEmail || '').toLowerCase() === (m.accountEmail || '').toLowerCase()));
      return !isTarget;
    }));

    // Local IndexedDB cache purge
    const folder = isGlobalMode ? 'INBOX' : selectedFolder;
    const itemsToPurge = targetsToSpam.map(t => ({
      uid: t.uid,
      accountEmail: t.accountEmail || activeAccount?.email || ''
    })).filter(x => !!x.accountEmail);

    await deleteLocalMessages(itemsToPurge, folder).catch(e => {
      console.error('Failed to purge spam emails from IndexedDB:', e);
    });

    const spammedCompositeIds = new Set(targetsToSpam.map(t => `${t.accountEmail || ''}:${t.uid}`));
    setSessionArrivedUnreads(prev => prev.filter(id => !spammedCompositeIds.has(id)));

    // Clear selection Detail if spammed active viewport
    if (selectedUid) {
      const matchesActive = targetsToSpam.some(t => t.uid === selectedUid && (!isGlobalMode || t.accountEmail === selectedAccountEmail));
      if (matchesActive) {
        setSelectedUid(null);
        setSelectedAccountEmail(null);
        setMessageDetail(null);
      }
    }

    if (isGlobalMode) {
      fetchGlobalMessages(true);
    } else if (activeAccount) {
      fetchFolders(activeAccount);
    }
  };

  // Bulk / Single Move Messages to Target Folder
  const handleMoveMessages = async (targetsToMove: { uid: number; accountEmail?: string }[], targetFolder: string) => {
    rememberRemoved(targetsToMove, isGlobalMode ? 'INBOX' : selectedFolder);
    await Promise.all(targetsToMove.map(async (target) => {
      const email = target.accountEmail || activeAccount?.email;
      const targetAccount = getAccountForEmail(email);
      const folder = isGlobalMode ? 'INBOX' : selectedFolder;

      try {
        const response = await fetch('/api/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: targetAccount,
            folder,
            uid: target.uid,
            targetFolder
          })
        });
        if (!response.ok) throw new Error(`Server refused the request (${response.status})`);
      } catch (err) {
        console.error('Move message step failed for target:', target, err);
        forgetRemoved(target, folder);
      }
    }));

    // Remove moved items from loaded list
    setMessages(prev => prev.filter(m => {
      const isTarget = targetsToMove.some(t => t.uid === m.uid && (!isGlobalMode || (t.accountEmail || '').toLowerCase() === (m.accountEmail || '').toLowerCase()));
      return !isTarget;
    }));

    // Local IndexedDB cache purge
    const folder = isGlobalMode ? 'INBOX' : selectedFolder;
    const itemsToPurge = targetsToMove.map(t => ({
      uid: t.uid,
      accountEmail: t.accountEmail || activeAccount?.email || ''
    })).filter(x => !!x.accountEmail);

    await deleteLocalMessages(itemsToPurge, folder).catch(e => {
      console.error('Failed to purge moved emails from IndexedDB:', e);
    });

    const movedCompositeIds = new Set(targetsToMove.map(t => `${t.accountEmail || ''}:${t.uid}`));
    setSessionArrivedUnreads(prev => prev.filter(id => !movedCompositeIds.has(id)));

    // Clear selection Detail if moved active viewport message
    if (selectedUid) {
      const matchesActive = targetsToMove.some(t => t.uid === selectedUid && (!isGlobalMode || t.accountEmail === selectedAccountEmail));
      if (matchesActive) {
        setSelectedUid(null);
        setSelectedAccountEmail(null);
        setMessageDetail(null);
      }
    }

    if (isGlobalMode) {
      fetchGlobalMessages(true);
    } else if (activeAccount) {
      fetchFolders(activeAccount);
    }
  };

  // Bulk Delete Messages / Single Delete Message
  const handleDeleteMessages = async (targetsToDelete: { uid: number; accountEmail?: string }[]) => {
    rememberRemoved(targetsToDelete, isGlobalMode ? 'INBOX' : selectedFolder);
    await Promise.all(targetsToDelete.map(async (target) => {
      const email = target.accountEmail || activeAccount?.email;
      const targetAccount = getAccountForEmail(email);
      const folder = isGlobalMode ? 'INBOX' : selectedFolder;
      // In global view, expunge immediately
      let trashFolder = '';
      if (!isGlobalMode) {
        const trashFolderNode = folders.find(f => f.specialUse === 'trash');
        trashFolder = trashFolderNode ? trashFolderNode.path : '';
      }

      try {
        const response = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: targetAccount,
            folder,
            uid: target.uid,
            trashFolder
          })
        });
        if (!response.ok) throw new Error(`Server refused the request (${response.status})`);
      } catch (err) {
        console.error('Delete step failed for target:', target, err);
        forgetRemoved(target, folder);
      }
    }));

    // Remove from loaded list
    setMessages(prev => prev.filter(m => {
      const isTarget = targetsToDelete.some(t => t.uid === m.uid && (!isGlobalMode || (t.accountEmail || '').toLowerCase() === (m.accountEmail || '').toLowerCase()));
      return !isTarget;
    }));

    // Local IndexedDB cache purge
    const folder = isGlobalMode ? 'INBOX' : selectedFolder;
    const itemsToDelete = targetsToDelete.map(t => ({
      uid: t.uid,
      accountEmail: t.accountEmail || activeAccount?.email || ''
    })).filter(x => !!x.accountEmail);

    await deleteLocalMessages(itemsToDelete, folder).catch(e => {
      console.error('Failed to purge deleted emails from IndexedDB:', e);
    });

    // Filter out deleted messages from sessionArrivedUnreads too
    const deletedCompositeIds = new Set(targetsToDelete.map(t => `${t.accountEmail || ''}:${t.uid}`));
    setSessionArrivedUnreads(prev => prev.filter(id => !deletedCompositeIds.has(id)));
    
    // Clear selection Detail if deleted active viewport
    if (selectedUid) {
      const matchesActive = targetsToDelete.some(t => t.uid === selectedUid && (!isGlobalMode || t.accountEmail === selectedAccountEmail));
      if (matchesActive) {
        setSelectedUid(null);
        setSelectedAccountEmail(null);
        setMessageDetail(null);
      }
    }

    if (isGlobalMode) {
      fetchGlobalMessages(true);
    } else if (activeAccount) {
      fetchFolders(activeAccount);
    }
  };

  // 7. Keyboard Shortcuts (ArrowUp / ArrowDown / Delete / Backspace)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore shortcut if user is typing in input or editable field
      const activeEl = document.activeElement;
      if (activeEl) {
        const tagName = activeEl.tagName.toUpperCase();
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || activeEl.hasAttribute('contenteditable')) {
          return;
        }
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (messages.length === 0) return;
        e.preventDefault(); // Stop window from scrolling

        let nextIndex = 0;
        if (selectedUid !== null) {
          const currentIndex = messages.findIndex(m => 
            m.uid === selectedUid && 
            (isGlobalMode ? (m.accountEmail || '').toLowerCase() === (selectedAccountEmail || '').toLowerCase() : true)
          );
          if (e.key === 'ArrowDown') {
            nextIndex = currentIndex + 1;
            if (nextIndex >= messages.length) return; // already at end
          } else {
            nextIndex = currentIndex - 1;
            if (nextIndex < 0) return; // already at start
          }
        } else {
          // If nothing is selected and arrow down/up is pressed, select first item
          nextIndex = 0;
        }

        const nextMsg = messages[nextIndex];
        if (nextMsg) {
          setSelectedUid(nextMsg.uid);
          setSelectedAccountEmail(nextMsg.accountEmail || null);
        }
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedUid !== null) {
          e.preventDefault();
          // Find next message to select after deleting current one
          const currentIndex = messages.findIndex(m => 
            m.uid === selectedUid && 
            (isGlobalMode ? (m.accountEmail || '').toLowerCase() === (selectedAccountEmail || '').toLowerCase() : true)
          );
          let targetNextMsg: MailMessage | null = null;
          if (currentIndex !== -1 && messages.length > 1) {
            if (currentIndex < messages.length - 1) {
              targetNextMsg = messages[currentIndex + 1];
            } else {
              targetNextMsg = messages[currentIndex - 1];
            }
          }

          // Perform deletion
          handleDeleteMessages([{ uid: selectedUid, accountEmail: selectedAccountEmail || undefined }]);

          // Auto-select the next/previous message for smooth keyboard-only reading experience
          if (targetNextMsg) {
            setSelectedUid(targetNextMsg.uid);
            setSelectedAccountEmail(targetNextMsg.accountEmail || null);
          } else {
            setSelectedUid(null);
            setMessageDetail(null);
            if (viewMode === 'detail') {
              setViewMode('list');
            }
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [messages, selectedUid, selectedAccountEmail, isGlobalMode, handleDeleteMessages, viewMode]);

  // Action: Launch compose modal with details
  const handleComposeReply = (type: 'reply' | 'reply-all' | 'forward') => {
    if (!messageDetail) return;
    // The folder rides along so a forward can pull the original attachments back
    // off the server.
    setReplyTarget({ detail: messageDetail, type, folder: selectedFolder });
    setShowCompose(true);
  };

  return (
    <div className="h-screen w-full flex flex-col bg-slate-100 text-slate-800 overflow-hidden font-sans relative">
      
      {/* Global Error Banner */}
      {globalError && (
        <div className="bg-rose-50 border-b border-rose-200 px-3 py-2 text-rose-700 text-xs flex justify-between items-center select-none shrink-0 animate-fade-in font-semibold z-30">
          <div className="flex items-center gap-2 font-sans min-w-0">
            <Shield className="w-3.5 h-3.5 text-rose-500 shrink-0" />
            <span className="whitespace-pre-line truncate">{globalError}</span>
          </div>
          <button onClick={() => setGlobalError(null)} className="text-slate-400 hover:text-slate-700 p-1 rounded hover:bg-rose-100 shrink-0">
            <X className="w-3" />
          </button>
        </div>
      )}

      {/* Routed Main Area */}
      <div className="flex-1 flex flex-col overflow-hidden bg-white">
        {accounts.length === 0 ? (
          // Greeting Splash screen
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-slate-50 select-none">
            <div className="p-6 rounded-xl bg-white border border-slate-200 shadow-md flex flex-col items-center max-w-sm">
              <span className="p-3 bg-blue-50 text-blue-600 rounded-2xl mb-4 border border-blue-100 shadow-xs animate-pulse">
                <Mail className="w-8 h-8" />
              </span>
              <h2 className="text-base font-extrabold tracking-tight text-slate-800 mb-1">Welcome to Tabpost</h2>
              <p className="text-xs text-slate-500 leading-relaxed mb-6">
                Connected accounts operate concurrently. The interface is optimized to fit perfectly into a browser's narrow sidebar tool stack.
              </p>
              <button
                onClick={() => setShowAddAccount(true)}
                className="w-full bg-blue-600 hover:bg-blue-750 active:bg-blue-800 text-white font-bold py-2.5 px-6 rounded-lg shadow-xs hover:shadow cursor-pointer transition-all flex items-center justify-center gap-1.5 text-xs uppercase tracking-wider"
              >
                <span>Connect your First Mailbox</span>
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <>
            {viewMode === 'navigation' && (
              <div className="flex-1 flex flex-col h-full bg-slate-50 overflow-hidden">
                {/* Navigation Header */}
                <div className="p-3 bg-slate-900 text-white flex items-center justify-between shrink-0 select-none shadow-sm">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setViewMode('list')}
                      className="p-1.5 rounded hover:bg-slate-800 text-slate-300 hover:text-white transition-colors cursor-pointer"
                      title="Back to inbox list"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="font-bold text-xs tracking-wider uppercase">Menu & Accounts</span>
                  </div>
                  <span className="text-[10px] bg-slate-800 text-slate-400 font-bold px-2 py-0.5 rounded leading-none uppercase tracking-widest border border-slate-700">active</span>
                </div>

                {/* Navigation list */}
                <div className="flex-1 overflow-y-auto space-y-4 p-4">
                  
                  {/* Unified Feeds group */}
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5 px-1">Unified Feeds</span>
                    <button
                      onClick={() => {
                        setIsGlobalMode(true);
                        setSelectedFolder('INBOX');
                        setSearchQuery('');
                        setPage(1);
                        setSelectedUid(null);
                        setMessageDetail(null);
                        setViewMode('list');
                      }}
                      className={`w-full flex items-center justify-between p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                        isGlobalMode
                          ? 'bg-blue-50 border-blue-300 ring-1 ring-blue-600/20'
                          : 'bg-white hover:bg-slate-100 border-slate-200 shadow-2xs'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-2 bg-blue-600 text-white rounded shadow-2xs shrink-0">
                          <Inbox className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-800 uppercase tracking-tight">Global Unified Inbox</div>
                          <div className="text-[10px] text-slate-400 leading-none mt-0.5">Aggregated concurrent accounts feed</div>
                        </div>
                      </div>
                      {isGlobalMode && (
                        <span className="w-2.5 h-2.5 rounded-full bg-blue-600 animate-pulse shrink-0" />
                      )}
                    </button>
                  </div>

                  {/* Connected Accounts & specific folder selectors */}
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5 px-1">Accounts & Folders</span>
                    <div className="space-y-3">
                      {accounts.map((acc, index) => {
                        const isAccActive = !isGlobalMode && activeAccountIndex === index;
                        const lastFolder = accountLastFolder[acc.email] || 'INBOX';
                        const isFolderListOpen = showFolderSelectionIdx === index;
                        const displayName = acc.accountName && acc.accountName.trim() !== '' ? acc.accountName : acc.email;
                        const isEditingName = editingAccountIdx === index;
                        
                        return (
                          <div key={acc.id} className="bg-white border border-slate-200 rounded-xl p-3 shadow-2xs space-y-2">
                            {/* Main Account Card Top */}
                            <div 
                              onClick={() => {
                                if (isEditingName) return;
                                setIsGlobalMode(false);
                                setActiveAccountIndex(index);
                                const targetFold = accountLastFolder[acc.email] || 'INBOX';
                                setSelectedFolder(targetFold);
                                setSearchQuery('');
                                setPage(1);
                                setSelectedUid(null);
                                setMessageDetail(null);
                                setViewMode('list');
                              }}
                              className={`w-full flex items-center justify-between p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                                isAccActive
                                  ? 'bg-emerald-50/70 border-emerald-300 ring-1 ring-emerald-600/15'
                                  : 'bg-white hover:bg-slate-100 border-slate-200 shadow-2xs'
                              }`}
                            >
                              <div className="flex items-center gap-3 min-w-0 flex-1">
                                <div className={`p-2 rounded shadow-2xs shrink-0 ${
                                  isAccActive ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'
                                }`}>
                                  <Mail className="w-4 h-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  {isEditingName ? (
                                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                                      <input
                                        type="text"
                                        value={editingNameInput}
                                        onChange={(e) => setEditingNameInput(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') handleSaveAccountName(index);
                                          if (e.key === 'Escape') setEditingAccountIdx(null);
                                        }}
                                        placeholder="Account Name..."
                                        className="w-full bg-white border border-blue-400 rounded px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500 font-medium"
                                        autoFocus
                                      />
                                      <button
                                        type="button"
                                        onClick={() => handleSaveAccountName(index)}
                                        className="p-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs cursor-pointer font-bold shrink-0"
                                        title="Save name"
                                      >
                                        ✓
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingAccountIdx(null)}
                                        className="p-1 bg-slate-200 hover:bg-slate-300 text-slate-600 rounded text-xs cursor-pointer shrink-0"
                                        title="Cancel"
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="text-xs font-extrabold text-slate-800 tracking-tight truncate flex items-center gap-1.5" title={displayName}>
                                        <span>{displayName}</span>
                                      </div>
                                      {acc.accountName && (
                                        <div className="text-[10px] text-slate-400 font-mono truncate" title={acc.email}>
                                          {acc.email}
                                        </div>
                                      )}
                                      {isAccActive && (
                                        <div className="text-[9px] text-emerald-600 leading-none mt-0.5 truncate uppercase tracking-wider font-bold">
                                          {lastFolder === 'INBOX' ? 'Inbox' : lastFolder.split('/').pop()}
                                        </div>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                              
                              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                                {!isEditingName && (
                                  <button
                                    onClick={() => {
                                      setEditingAccountIdx(index);
                                      setEditingNameInput(acc.accountName || '');
                                    }}
                                    className="text-slate-400 hover:text-blue-600 p-1.5 rounded hover:bg-blue-50 transition-colors cursor-pointer"
                                    title="Edit account label/name"
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                <button
                                  onClick={() => handleLogoutAccount(index)}
                                  className="text-slate-400 hover:text-rose-600 p-1.5 rounded hover:bg-rose-50 transition-colors cursor-pointer"
                                  title="Disconnect active credentials"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            {/* Dropdown Folder Trigger Button */}
                            <div className="pt-0.5">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!isAccActive) {
                                    setIsGlobalMode(false);
                                    setActiveAccountIndex(index);
                                    setSelectedFolder(accountLastFolder[acc.email] || 'INBOX');
                                    setSearchQuery('');
                                    setPage(1);
                                    setSelectedUid(null);
                                    setMessageDetail(null);
                                  }
                                  setShowFolderSelectionIdx(isFolderListOpen ? null : index);
                                }}
                                className={`w-full text-center py-1 bg-slate-50 hover:bg-slate-100 border border-slate-200/80 rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                                  isFolderListOpen && isAccActive ? 'text-blue-600 border-blue-200 bg-blue-50/50' : 'text-slate-500 hover:text-slate-800'
                                }`}
                              >
                                <Folder className="w-3 h-3" />
                                <span>Select Account Folder</span>
                              </button>
                            </div>

                            {/* Folder list when open and account is active */}
                            {isFolderListOpen && isAccActive && (
                              <div className="pl-3.5 border-l-2 border-slate-200/80 space-y-1 pt-1.5">
                                {loadingFolders ? (
                                  <div className="py-2 text-[10px] text-slate-400 italic flex items-center gap-1.5 text-xs">
                                    <RefreshCw className="w-3 h-3 animate-spin text-blue-500" />
                                    <span>Syncing directories...</span>
                                  </div>
                                ) : folders.length === 0 ? (
                                  <div className="py-2 text-[10px] text-slate-400 italic">No directories found</div>
                                ) : (
                                  folders.map((folder) => {
                                    const isFoldActive = selectedFolder === folder.path;
                                    return (
                                      <button
                                        key={folder.path}
                                        onClick={() => {
                                          setSelectedFolder(folder.path);
                                          setPage(1);
                                          setSelectedUid(null);
                                          setMessageDetail(null);
                                          setViewMode('list');
                                          // Retain last viewed folder for this account
                                          setAccountLastFolder(prev => ({
                                            ...prev,
                                            [acc.email]: folder.path
                                          }));
                                        }}
                                        className={`w-full flex items-center justify-between py-1.5 px-2 text-[11px] rounded transition-all text-left cursor-pointer ${
                                          isFoldActive
                                            ? 'bg-blue-50 text-blue-700 font-extrabold shadow-3xs'
                                            : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                                        }`}
                                      >
                                        <span className="truncate">{folder.name === 'INBOX' ? 'Inbox' : folder.name}</span>
                                        {folder.unreadCount > 0 && (
                                          <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold shrink-0 ${isFoldActive ? 'bg-blue-100 text-blue-700' : 'bg-slate-105 text-slate-500'}`}>
                                            {folder.unreadCount}
                                          </span>
                                        )}
                                      </button>
                                    );
                                  })
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* System & OS Notifications controller */}
                  <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-2xs space-y-3">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Live Notifications</span>
                    
                    {/* OS Notifications setting status row */}
                    <div className="flex items-center justify-between gap-1.5 py-1">
                      <div className="flex items-center gap-2">
                        {notificationPermission === 'granted' ? (
                          <div className="p-1.5 bg-emerald-55 text-emerald-600 rounded">
                            <Bell className="w-3.5 h-3.5" />
                          </div>
                        ) : (
                          <div className="p-1.5 bg-slate-50 text-slate-400 rounded">
                            <BellOff className="w-3.5 h-3.5 animate-pulse" />
                          </div>
                        )}
                        <div className="text-left">
                          <span className="text-xs font-bold text-slate-800 block">Desktop Alerts</span>
                          <span className="text-[9px] text-slate-400 leading-none">
                            {notificationPermission === 'granted' ? 'Enabled (system auth)' : 'Notifications default/blocked'}
                          </span>
                        </div>
                      </div>

                      {notificationPermission !== 'granted' && (
                        <button
                          type="button"
                          onClick={() => {
                            console.log('[NOTIFICATION DEBUG] User clicked "Request OS Permission" button');
                            if (typeof window !== 'undefined' && 'Notification' in window) {
                              console.log('[NOTIFICATION DEBUG] Requesting notification permission via interaction flow...');
                              Notification.requestPermission().then(permission => {
                                console.log('[NOTIFICATION DEBUG] Interaction permission status returned:', permission);
                                setNotificationPermission(permission);
                                if (permission === 'granted') {
                                  console.log('[NOTIFICATION DEBUG] Permission granted, attempting to spawn test notification...');
                                  try {
                                    new Notification('Tabpost alerts active!');
                                    console.log('[NOTIFICATION DEBUG] Test notification spawned successfully!');
                                  } catch (err) {
                                    console.error('[NOTIFICATION DEBUG] Test notification call failed:', err);
                                  }
                                } else {
                                  console.warn('[NOTIFICATION DEBUG] Permission request resolved to:', permission);
                                }
                              }).catch(err => {
                                console.error('[NOTIFICATION DEBUG] Permission request rejected with error:', err);
                              });
                            } else {
                              console.error('[NOTIFICATION DEBUG] Notification API is not available on this browser.');
                            }
                          }}
                          className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[9px] uppercase tracking-wider rounded transition-all cursor-pointer"
                        >
                          Request OS Permission
                        </button>
                      )}
                    </div>

                    {/* Session arrived counter tracker stats with manual reset button if desired */}
                    <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                      <div className="text-left">
                        <span className="text-xs font-bold text-slate-800 block">Session Arrivals Tracker</span>
                        <span className="text-[9px] text-slate-400 leading-none">Mails received during active tab load</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="px-2.5 py-1 bg-red-100 text-red-700 font-extrabold text-[11px] rounded-full min-w-[20px] text-center">
                          {sessionArrivedUnreads.length}
                        </span>
                        {sessionArrivedUnreads.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setSessionArrivedUnreads([]);
                            }}
                            className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-700 cursor-pointer transition-colors"
                            title="Reset notification session counter to 0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Add Concurrent mailbox button */}
                  <div className="pt-2 select-none">
                    <button
                      onClick={() => setShowAddAccount(true)}
                      className="w-full py-2.5 px-3 border-2 border-dashed border-slate-300 hover:border-blue-500 text-slate-500 hover:text-blue-600 transition-all font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 cursor-pointer bg-white"
                      title="Add concurrent IMAP mailbox"
                    >
                      <Plus className="w-4 h-4 text-emerald-550 shrink-0" />
                      <span>Add Account connection</span>
                    </button>
                  </div>

                  <div className="text-center text-[10px] text-slate-400 select-none pt-4 font-mono">
                    Tabpost
                  </div>
                </div>
              </div>
            )}

            {(viewMode === 'list' || viewMode === 'detail') && (
              <div className="flex-1 flex overflow-hidden bg-white h-full w-full">
                {/* Left Pane: Message List - Full width on mobile when viewMode === 'list', visible beside detail on desktop */}
                <div className={`flex-col h-full shrink-0 border-r border-slate-200 overflow-hidden md:w-80 lg:w-[400px] xl:w-[460px] ${
                  viewMode === 'list' ? 'flex w-full animate-fade-in' : 'hidden md:flex'
                }`}>
                  <MessageList
                    messages={messages}
                    selectedFolder={selectedFolder}
                    selectedUid={selectedUid}
                    selectedAccountEmail={selectedAccountEmail}
                    selectedIds={selectedIds}
                    onSelectedIdsChange={setSelectedIds}
                    onSelectMessage={(uid, email) => {
                      if (uid === -1) {
                        setSelectedUid(null);
                        setMessageDetail(null);
                      } else {
                        setSelectedUid(uid);
                        setSelectedAccountEmail(email || null);
                      }
                      setViewMode('detail');
                    }}
                    onRefreshMessages={() => handleRefreshAll(false)}
                    searchQuery={searchQuery}
                    onSearchChange={(q) => {
                      setSearchQuery(q);
                      setPage(1);
                      setSelectedUid(null);
                      setSelectedIds([]);
                      setMessageDetail(null);
                    }}
                    totalMessages={totalMessages}
                    onLoadMore={handleLoadMore}
                    loading={loadingMessages}
                    onBulkMark={handleBulkMark}
                    onBulkDelete={handleDeleteMessages}
                    onBulkSpam={handleMarkSpamMessages}
                    onBulkMove={handleMoveMessages}
                    folders={folders}
                    loadingFolders={loadingFolders}
                    isGlobalMode={isGlobalMode}
                    onToggleNavigation={() => setViewMode('navigation')}
                    onStartCompose={() => {
                      setReplyTarget(undefined);
                      setShowCompose(true);
                    }}
                    currentAccountEmail={activeAccount?.email}
                    getAccountDisplayName={getAccountDisplayName}
                  />
                </div>

                {/* Right Pane: Message Detail - Full width on mobile when viewMode === 'detail', visible beside list on desktop */}
                <div className={`flex-col h-full flex-1 overflow-hidden ${
                  viewMode === 'detail' ? 'flex w-full animate-fade-in' : 'hidden md:flex'
                }`}>
                  {selectedIds.length > 1 ? (
                    <MultiSelectDetailView
                      selectedIds={selectedIds}
                      messages={messages}
                      onBulkMark={handleBulkMark}
                      onBulkDelete={handleDeleteMessages}
                      onBulkSpam={handleMarkSpamMessages}
                      onBulkMove={handleMoveMessages}
                      folders={folders}
                      loadingFolders={loadingFolders}
                      selectedFolder={selectedFolder}
                      onClearSelection={() => setSelectedIds([])}
                    />
                  ) : (
                    <MessageDetailView
                      detail={messageDetail}
                      loading={loadingDetail}
                      onComposeReply={handleComposeReply}
                      onMarkUnread={() => {
                        if (selectedUid !== null) {
                          handleMarkSeenSingle(selectedUid, false, selectedAccountEmail || undefined);
                          // On mobile, return back to list on marking unread
                          setViewMode('list');
                        }
                      }}
                      onDeleteMessage={() => {
                        if (selectedUid !== null) {
                          handleDeleteMessages([{ uid: selectedUid, accountEmail: selectedAccountEmail || undefined }]);
                          // On mobile, return back to list on delete
                          setViewMode('list');
                        }
                      }}
                      onMarkSpam={() => {
                        if (selectedUid !== null) {
                          handleMarkSpamMessages([{ uid: selectedUid, accountEmail: selectedAccountEmail || undefined }]);
                          setViewMode('list');
                        }
                      }}
                      onMoveMessage={(targetFolder) => {
                        if (selectedUid !== null) {
                          handleMoveMessages([{ uid: selectedUid, accountEmail: selectedAccountEmail || undefined }], targetFolder);
                          setViewMode('list');
                        }
                      }}
                      folders={folders}
                      loadingFolders={loadingFolders}
                      activeAccount={isGlobalMode ? getAccountForEmail(selectedAccountEmail || undefined) : activeAccount}
                      selectedFolder={selectedFolder}
                      onBackToList={() => {
                        setViewMode('list');
                        setSelectedUid(null);
                        setSelectedIds([]);
                        setMessageDetail(null);
                      }}
                    />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Add Account Modal overlay */}
      {(showAddAccount || accounts.length === 0) && (
        <LoginModal
          onAddAccount={handleAddAccount}
          onClose={() => setShowAddAccount(false)}
          isFirstAccount={accounts.length === 0}
        />
      )}

      {/* Compose Email Modal overlay */}
      {showCompose && (isGlobalMode ? accounts.length > 0 : !!activeAccount) && (
        <ComposeModal
          onClose={() => {
            setShowCompose(false);
            setReplyTarget(undefined);
          }}
          activeAccount={isGlobalMode ? getAccountForEmail(selectedAccountEmail || undefined) : activeAccount}
          replyToMessage={replyTarget}
          onSendSuccess={() => {
            setShowCompose(false);
            setReplyTarget(undefined);
            setGlobalError(null);
            alert('Email sent successfully!');
            // If we are currently viewing the Drafts folder or Sent, sync messages
            if (isGlobalMode) {
              fetchGlobalMessages(true);
            } else if (selectedFolder.toLowerCase().includes('sent')) {
              fetchMessages(activeAccount, selectedFolder, page, searchQuery);
            }
          }}
        />
      )}
    </div>
  );
}
