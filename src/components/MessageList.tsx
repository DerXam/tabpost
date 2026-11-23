import React, { useState, useEffect } from 'react';
import { MailMessage, FolderNode } from '../types';
import { Search, RefreshCw, ChevronLeft, ChevronRight, Paperclip, Mail, Eye, EyeOff, Trash2, CheckSquare, Square, Menu, Pencil, X, ShieldAlert, FolderInput } from 'lucide-react';
import MoveToFolderModal from './MoveToFolderModal';

interface MessageListProps {
  messages: MailMessage[];
  selectedFolder: string;
  selectedUid: number | null;
  selectedAccountEmail: string | null;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  onSelectMessage: (uid: number, accountEmail?: string) => void;
  onRefreshMessages: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  totalMessages: number;
  onLoadMore: () => void;
  loading: boolean;
  onBulkMark: (targets: { uid: number; accountEmail?: string }[], seen: boolean) => void;
  onBulkDelete: (targets: { uid: number; accountEmail?: string }[]) => void;
  onBulkSpam?: (targets: { uid: number; accountEmail?: string }[]) => void;
  onBulkMove?: (targets: { uid: number; accountEmail?: string }[], targetFolder: string) => void;
  folders?: FolderNode[];
  loadingFolders?: boolean;
  isGlobalMode?: boolean;
  onToggleNavigation?: () => void;
  onStartCompose?: () => void;
  currentAccountEmail?: string | null;
  getAccountDisplayName?: (email?: string) => string;
}

export default function MessageList({
  messages,
  selectedFolder,
  selectedUid,
  selectedAccountEmail,
  selectedIds,
  onSelectedIdsChange,
  onSelectMessage,
  onRefreshMessages,
  searchQuery,
  onSearchChange,
  totalMessages,
  onLoadMore,
  loading,
  onBulkMark,
  onBulkDelete,
  onBulkSpam,
  onBulkMove,
  folders = [],
  loadingFolders = false,
  isGlobalMode,
  onToggleNavigation,
  onStartCompose,
  currentAccountEmail,
  getAccountDisplayName
}: MessageListProps) {
  const [searchInput, setSearchInput] = useState(searchQuery);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);

  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  const filteredMessages = showUnreadOnly
    ? messages.filter(msg => !msg.flags.some(f => f.toLowerCase() === '\\seen'))
    : messages;

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearchChange(searchInput);
  };

  const getMsgId = (msg: MailMessage) => `${msg.accountEmail || 'default'}_${msg.uid}`;

  // Smart multi-select handler supporting Ctrl/Cmd-click, Shift-click, and regular click
  const handleItemClick = (msg: MailMessage, index: number, e: React.MouseEvent) => {
    const msgId = getMsgId(msg);

    // Get current effective selection IDs (including single selectedUid if selectedIds was empty)
    let currentBaseIds = [...selectedIds];
    if (currentBaseIds.length === 0 && selectedUid !== null) {
      const activeSingle = messages.find(m => m.uid === selectedUid && (!selectedAccountEmail || m.accountEmail === selectedAccountEmail));
      if (activeSingle) {
        currentBaseIds = [getMsgId(activeSingle)];
      }
    }

    if (e.ctrlKey || e.metaKey) {
      // 1. Control / Cmd Click -> Toggle selection of clicked item
      e.preventDefault();
      let nextSelectedIds: string[];
      if (currentBaseIds.includes(msgId)) {
        nextSelectedIds = currentBaseIds.filter(id => id !== msgId);
      } else {
        nextSelectedIds = [...currentBaseIds, msgId];
      }

      onSelectedIdsChange(nextSelectedIds);
      setLastSelectedIndex(index);

      if (nextSelectedIds.length === 1) {
        const singleId = nextSelectedIds[0];
        const found = filteredMessages.find(m => getMsgId(m) === singleId);
        if (found) {
          onSelectMessage(found.uid, found.accountEmail);
        }
      } else {
        onSelectMessage(-1, undefined);
      }
    } else if (e.shiftKey) {
      // 2. Shift Click -> Range select between lastSelectedIndex and current index
      e.preventDefault();
      let startIdx = lastSelectedIndex !== null ? lastSelectedIndex : index;
      let endIdx = index;
      if (startIdx > endIdx) {
        [startIdx, endIdx] = [endIdx, startIdx];
      }

      const rangeMsgs = filteredMessages.slice(startIdx, endIdx + 1);
      const rangeIds = rangeMsgs.map(getMsgId);
      const combinedSet = new Set([...currentBaseIds, ...rangeIds]);
      const nextSelectedIds = Array.from(combinedSet);

      onSelectedIdsChange(nextSelectedIds);
      setLastSelectedIndex(index);

      if (nextSelectedIds.length === 1) {
        const found = filteredMessages.find(m => getMsgId(m) === nextSelectedIds[0]);
        if (found) {
          onSelectMessage(found.uid, found.accountEmail);
        }
      } else {
        onSelectMessage(-1, undefined);
      }
    } else {
      // 3. Normal Click -> Clear multi-selection & select single message
      onSelectedIdsChange([]);
      setLastSelectedIndex(index);
      onSelectMessage(msg.uid, msg.accountEmail);
    }
  };

  const toggleSelectMessage = (msg: MailMessage, index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const msgId = getMsgId(msg);
    let currentBaseIds = [...selectedIds];
    if (currentBaseIds.length === 0 && selectedUid !== null) {
      const activeSingle = messages.find(m => m.uid === selectedUid && (!selectedAccountEmail || m.accountEmail === selectedAccountEmail));
      if (activeSingle) {
        currentBaseIds = [getMsgId(activeSingle)];
      }
    }

    let nextSelectedIds: string[];
    if (currentBaseIds.includes(msgId)) {
      nextSelectedIds = currentBaseIds.filter(x => x !== msgId);
    } else {
      nextSelectedIds = [...currentBaseIds, msgId];
    }

    onSelectedIdsChange(nextSelectedIds);
    setLastSelectedIndex(index);

    if (nextSelectedIds.length === 1) {
      const singleId = nextSelectedIds[0];
      const found = filteredMessages.find(m => getMsgId(m) === singleId);
      if (found) {
        onSelectMessage(found.uid, found.accountEmail);
      }
    } else {
      onSelectMessage(-1, undefined);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === filteredMessages.length) {
      onSelectedIdsChange([]);
    } else {
      onSelectedIdsChange(filteredMessages.map(getMsgId));
      onSelectMessage(-1, undefined);
    }
  };

  const handleBulkAction = async (action: 'read' | 'unread' | 'delete' | 'spam') => {
    if (selectedIds.length === 0) return;

    const targets = selectedIds.map(id => {
      const parts = id.split('_');
      const accountEmail = parts[0] === 'default' ? undefined : parts[0];
      const uid = Number(parts[1]);
      return { uid, accountEmail };
    });

    if (action === 'read') {
      await onBulkMark(targets, true);
    } else if (action === 'unread') {
      await onBulkMark(targets, false);
    } else if (action === 'spam') {
      if (onBulkSpam && confirm(`Are you sure you want to mark ${selectedIds.length} selected messages as spam?`)) {
        await onBulkSpam(targets);
      }
    } else if (action === 'delete') {
      if (confirm(`Are you sure you want to delete ${selectedIds.length} selected messages?`)) {
        await onBulkDelete(targets);
      }
    }
    onSelectedIdsChange([]);
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      const now = new Date();
      if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      if (d.getFullYear() !== now.getFullYear()) {
        return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
      }
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch (_) {
      return dateStr;
    }
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  return (
    <div className="w-full flex flex-col h-full bg-white select-none text-slate-800">
      
      {/* Dynamic Top Bar for Sidebar Mode */}
      <div className="p-3 bg-slate-900 text-white flex items-center justify-between shrink-0 shadow-sm">
        <div className="flex items-center gap-2 min-w-0">
          {onToggleNavigation && (
            <button
              type="button"
              onClick={onToggleNavigation}
              className="p-1.5 rounded hover:bg-slate-800 transition-colors cursor-pointer text-slate-300 hover:text-white"
              title="Accounts & Folders"
            >
              <Menu className="w-4 h-4" />
            </button>
          )}
          <div className="flex flex-col min-w-0">
            {searchQuery.trim() !== '' ? (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-bold text-xs truncate text-amber-300">
                  Search results
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('');
                    onSearchChange('');
                  }}
                  className="p-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-rose-450 transition-colors cursor-pointer"
                  title="Clear search and back to inbox"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <span className="font-bold text-xs truncate">
                {isGlobalMode ? 'Global Unified Inbox' : (selectedFolder === 'INBOX' ? 'Inbox' : selectedFolder)}
              </span>
            )}
            {!isGlobalMode && currentAccountEmail && (
              <span className="text-[9px] text-slate-400 font-mono truncate max-w-[150px]">
                {currentAccountEmail}
              </span>
            )}
          </div>
        </div>
        
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onRefreshMessages}
            disabled={loading}
            className="p-1.5 rounded hover:bg-slate-800 text-slate-300 hover:text-white transition-colors cursor-pointer disabled:opacity-40"
            title="Refresh Inbox"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-blue-400' : ''}`} />
          </button>

          {onStartCompose && (
            <button
              type="button"
              onClick={onStartCompose}
              className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-[10px] font-bold shadow-xs hover:shadow active:scale-95 transition-all cursor-pointer"
              title="Compose New Mail"
            >
              <Pencil className="w-3 h-3" />
              <span>Compose</span>
            </button>
          )}
        </div>
      </div>

      {/* Search Header */}
      <form onSubmit={handleSearchSubmit} className="p-3 border-b border-slate-150 flex items-center gap-2 bg-slate-50/50">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={isGlobalMode ? "Search global inbox..." : `Search ${selectedFolder.split('/').pop()}...`}
            className="w-full bg-slate-100 border border-slate-250/60 rounded px-2.5 py-1.5 pl-8 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-600 focus:bg-white transition-all"
          />
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
        </div>
        <button
          type="button"
          onClick={onRefreshMessages}
          disabled={loading}
          className="p-1.5 rounded border border-slate-200 hover:bg-slate-200/50 text-slate-500 hover:text-slate-800 disabled:opacity-45 shrink-0 cursor-pointer transition-colors"
          title="Refresh List"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-blue-600' : ''}`} />
        </button>
      </form>

      {/* Filter Tabs / Quick-Filters OR Back to inbox when searching */}
      {searchQuery.trim() !== '' ? (
        <div className="px-3 py-1.5 border-b border-slate-150 bg-slate-50/25 flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setSearchInput('');
              onSearchChange('');
            }}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-semibold bg-blue-50 hover:bg-blue-100 text-blue-700 hover:text-blue-900 transition-all border border-blue-200 shadow-3xs cursor-pointer"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Back to inbox</span>
          </button>
        </div>
      ) : (
        <div className="px-3 py-2 border-b border-slate-150 bg-slate-50/20 flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setShowUnreadOnly(false);
              onSelectedIdsChange([]);
            }}
            className={`flex-1 text-center py-1 rounded text-[11px] font-semibold transition-all border ${
              !showUnreadOnly
                ? 'bg-blue-600 border-blue-500 text-white font-bold shadow-sm'
                : 'bg-white border-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-50/50'
            }`}
          >
            All Mails
          </button>
          <button
            type="button"
            onClick={() => {
              setShowUnreadOnly(true);
              onSelectedIdsChange([]);
            }}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded text-[11px] font-semibold transition-all border ${
              showUnreadOnly
                ? 'bg-blue-600 border-blue-500 text-white font-bold shadow-sm'
                : 'bg-white border-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-50/50'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${showUnreadOnly ? 'bg-white animate-pulse' : 'bg-slate-400'}`} />
            Unread Only
          </button>
        </div>
      )}

      {/* Bulk Actions Bar */}
      {filteredMessages.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-150 bg-slate-50/70 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <button
              onClick={toggleSelectAll}
              className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-200/50 focus:outline-none transition-colors"
              title="Select all"
            >
              {selectedIds.length === filteredMessages.length ? (
                <CheckSquare className="w-4 h-4 text-blue-600" />
              ) : (
                <Square className="w-4 h-4" />
              )}
            </button>
            
            {selectedIds.length > 0 && (
               <span className="font-semibold text-blue-700 text-[11px] animate-fade-in bg-blue-50 px-1.5 py-0.5 rounded">
                 {selectedIds.length} selected
               </span>
            )}
          </div>

          {selectedIds.length > 0 ? (
            <div className="flex items-center gap-1.5 animate-fade-in">
              <button
                onClick={() => handleBulkAction('read')}
                className="p-1 hover:bg-slate-200 rounded hover:text-blue-600 text-slate-500 transition-colors cursor-pointer"
                title="Mark Read"
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleBulkAction('unread')}
                className="p-1 hover:bg-slate-200 rounded hover:text-blue-600 text-slate-500 transition-colors cursor-pointer"
                title="Mark Unread"
              >
                <EyeOff className="w-3.5 h-3.5" />
              </button>
              {onBulkSpam && (
                <button
                  onClick={() => handleBulkAction('spam')}
                  className="p-1 hover:bg-amber-100 rounded hover:text-amber-700 text-slate-500 transition-colors cursor-pointer"
                  title="Mark Spam"
                >
                  <ShieldAlert className="w-3.5 h-3.5" />
                </button>
              )}
              {onBulkMove && (
                <button
                  onClick={() => setIsMoveModalOpen(true)}
                  className="p-1 hover:bg-blue-100 rounded hover:text-blue-700 text-slate-500 transition-colors cursor-pointer"
                  title="Move to folder"
                >
                  <FolderInput className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => handleBulkAction('delete')}
                className="p-1 hover:bg-rose-100 rounded hover:text-rose-600 text-slate-500 transition-colors cursor-pointer"
                title="Delete/Trash"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
              Filter: {isGlobalMode ? 'Global Inbox' : selectedFolder.split('/').pop()}
            </span>
          )}
        </div>
      )}

      {/* Messages List */}
      <div 
        onScroll={(e) => {
          const target = e.currentTarget;
          const threshold = 120; // px margin from bottom
          const isAtBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + threshold;
          if (isAtBottom && !loading && messages.length < totalMessages) {
            onLoadMore();
          }
        }}
        className="flex-1 overflow-y-auto divide-y divide-slate-100 scrollbar-thin scrollbar-thumb-slate-200"
      >
        {loading && messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-slate-400 gap-2">
            <RefreshCw className="w-6 h-6 animate-spin text-blue-600/50" />
            <span className="text-xs">Loading inbox...</span>
          </div>
        ) : filteredMessages.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-xs italic">
            {showUnreadOnly ? 'No unread messages.' : 'No messages found in this folder.'}
          </div>
        ) : (
          <>
            {filteredMessages.map((msg, index) => {
              const isSelected = selectedUid === msg.uid && (!selectedAccountEmail || selectedAccountEmail === msg.accountEmail);
              const isUnread = !msg.flags.some(f => f.toLowerCase() === '\\seen');
              const isDraft = msg.flags.some(f => f.toLowerCase() === '\\draft');
              const isChecked = selectedIds.includes(getMsgId(msg));
              const attachmentCount = msg.attachmentCount ?? 0;

              return (
                <div
                  key={getMsgId(msg)}
                  onClick={(e) => handleItemClick(msg, index, e)}
                  className={`p-3 text-xs border-r-4 cursor-pointer relative group transition-all flex ${
                    isChecked
                      ? 'bg-blue-100/70 border-r-blue-600 font-medium'
                      : isSelected
                      ? 'bg-blue-50/70 border-r-blue-600'
                      : isUnread
                      ? 'bg-slate-50/40 border-r-transparent hover:bg-slate-50'
                      : 'bg-transparent border-r-transparent hover:bg-slate-50'
                  }`}
                >
                  {/* Checkbox hover region */}
                  <div 
                    onClick={(e) => toggleSelectMessage(msg, index, e)}
                    className="w-5 pr-1 flex items-start pt-0.5 shrink-0"
                  >
                    <button className={`p-0.5 rounded text-slate-400 hover:text-slate-600 ${
                      isChecked ? 'text-blue-600' : 'opacity-0 group-hover:opacity-100 transition-opacity'
                    }`}>
                      {isChecked ? <CheckSquare className="w-3.5 h-3.5 text-blue-600" /> : <Square className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className={`truncate leading-tight pr-1 ${
                        isUnread ? 'text-slate-900 font-bold' : isSelected ? 'text-blue-950 font-medium' : 'text-slate-600 font-medium'
                      }`}>
                        {msg.from.name || msg.from.address}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0 select-none">
                        {(msg.accountEmail || currentAccountEmail) && (
                          <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-150 font-extrabold text-[9px] leading-none shrink-0" title={msg.accountEmail || currentAccountEmail || ''}>
                            {getAccountDisplayName ? getAccountDisplayName(msg.accountEmail || currentAccountEmail) : (msg.accountEmail || currentAccountEmail || '').split('@')[0]}
                          </span>
                        )}
                        <span className={`text-[10px] shrink-0 select-none ${
                          isSelected ? 'text-blue-600' : 'text-slate-400'
                        }`}>
                          {formatDate(msg.date)}
                        </span>
                      </div>
                    </div>

                    <h4 className={`truncate text-[12px] leading-snug ${
                      isUnread ? 'text-slate-900 font-bold' : isSelected ? 'text-slate-800 font-normal' : 'text-slate-500 font-normal'
                    }`}>
                      {isDraft && <span className="text-amber-500 font-bold mr-1">[Draft]</span>}
                      {msg.subject}
                    </h4>

                    <div className="flex items-center justify-between text-[11px] text-slate-400 pt-0.5 font-normal font-sans">
                      <span className="truncate min-w-0 flex-1 pr-2 group-hover:text-slate-600 transition-colors">
                        {msg.snippet || '(Empty content...)'}
                      </span>
                      {/* Attachments, or nothing at all. The size on its own says
                          nothing useful, so it only rides along as the weight of
                          the attachments the paperclip is announcing. */}
                      {attachmentCount > 0 && (
                        <div
                          className="flex items-center gap-1 shrink-0 text-slate-500"
                          title={`${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'} · ${formatSize(msg.size)}`}
                        >
                          <Paperclip className="w-3 h-3" />
                          {attachmentCount > 1 && (
                            <span className="text-[9px] font-bold leading-none">{attachmentCount}</span>
                          )}
                          <span className="text-[9px] font-mono opacity-80">{formatSize(msg.size)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {isUnread && (
                    <div className="absolute right-1 top-3.5 w-1.5 h-1.5 rounded-full bg-blue-600" />
                  )}
                </div>
              );
            })}

            {/* Loading More Spinner at the bottom of the scroll list */}
            {loading && messages.length > 0 && (
              <div className="p-4 flex items-center justify-center gap-2 text-xs text-slate-500 bg-slate-50/25 border-t border-slate-100 animate-fade-in">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-600" />
                <span>Loading older messages...</span>
              </div>
            )}

            {/* End of list text indicator */}
            {!loading && messages.length > 0 && messages.length >= totalMessages && (
              <div className="p-4 text-center text-[10px] text-slate-400 font-mono tracking-wider uppercase select-none border-t border-slate-150 bg-slate-50/10">
                All messages loaded
              </div>
            )}
          </>
        )}
      </div>

      {/* Messages Counter / Pull-down Footer */}
      <div className="p-3 border-t border-slate-200 bg-slate-50/30 flex items-center justify-between text-xs text-slate-500 select-none">
        <span className="text-[10px] font-mono">
          Showing {messages.length} of {totalMessages} messages
        </span>

        {messages.length < totalMessages && (
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="text-[10px] font-bold text-blue-600 hover:text-blue-700 disabled:opacity-50 select-none transition-all hover:underline cursor-pointer"
          >
            {loading ? 'Loading...' : 'Load older messages'}
          </button>
        )}
      </div>

      {onBulkMove && (
        <MoveToFolderModal
          isOpen={isMoveModalOpen}
          onClose={() => setIsMoveModalOpen(false)}
          folders={folders}
          currentFolder={selectedFolder}
          loadingFolders={loadingFolders}
          onSelectFolder={async (targetFolder) => {
            const targets = selectedIds.map(id => {
              const parts = id.split('_');
              const accountEmail = parts[0] === 'default' ? undefined : parts[0];
              const uid = Number(parts[1]);
              return { uid, accountEmail };
            });
            await onBulkMove(targets, targetFolder);
            onSelectedIdsChange([]);
            setIsMoveModalOpen(false);
          }}
          itemCount={selectedIds.length}
        />
      )}
    </div>
  );
}
