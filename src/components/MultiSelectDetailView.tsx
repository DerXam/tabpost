import React, { useState } from 'react';
import { MailMessage, FolderNode } from '../types';
import { CheckSquare, Eye, EyeOff, Trash2, X, Mail, Calendar, User, ShieldAlert, FolderInput } from 'lucide-react';
import MoveToFolderModal from './MoveToFolderModal';

interface MultiSelectDetailViewProps {
  selectedIds: string[];
  messages: MailMessage[];
  onBulkMark: (targets: { uid: number; accountEmail?: string }[], seen: boolean) => void;
  onBulkDelete: (targets: { uid: number; accountEmail?: string }[]) => void;
  onBulkSpam?: (targets: { uid: number; accountEmail?: string }[]) => void;
  onBulkMove?: (targets: { uid: number; accountEmail?: string }[], targetFolder: string) => void;
  folders?: FolderNode[];
  loadingFolders?: boolean;
  selectedFolder?: string;
  onClearSelection: () => void;
}

export default function MultiSelectDetailView({
  selectedIds,
  messages,
  onBulkMark,
  onBulkDelete,
  onBulkSpam,
  onBulkMove,
  folders = [],
  loadingFolders = false,
  selectedFolder = 'INBOX',
  onClearSelection
}: MultiSelectDetailViewProps) {
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
  // Extract target objects from selectedIds
  const selectedTargets = selectedIds.map(id => {
    const parts = id.split('_');
    const accountEmail = parts[0] === 'default' ? undefined : parts[0];
    const uid = Number(parts[1]);
    return { uid, accountEmail };
  });

  // Find matching message objects for preview
  const selectedMessages = messages.filter(m => {
    const msgId = `${m.accountEmail || 'default'}_${m.uid}`;
    return selectedIds.includes(msgId);
  });

  const count = selectedIds.length;

  const handleMarkRead = () => {
    onBulkMark(selectedTargets, true);
    onClearSelection();
  };

  const handleMarkUnread = () => {
    onBulkMark(selectedTargets, false);
    onClearSelection();
  };

  const handleSpam = () => {
    if (onBulkSpam) {
      if (confirm(`Are you sure you want to mark ${count} selected messages as spam?`)) {
        onBulkSpam(selectedTargets);
        onClearSelection();
      }
    }
  };

  const handleDelete = () => {
    if (confirm(`Are you sure you want to delete ${count} selected messages?`)) {
      onBulkDelete(selectedTargets);
      onClearSelection();
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return dateStr;
    }
  };

  return (
    <div className="w-full h-full bg-slate-50 flex flex-col items-center justify-between p-6 overflow-y-auto select-none">
      <div className="max-w-xl w-full my-auto space-y-6">
        
        {/* Main Card Header */}
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm text-center space-y-4">
          <div className="w-14 h-14 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center mx-auto text-blue-600 shadow-3xs">
            <CheckSquare className="w-7 h-7" />
          </div>

          <div>
            <h2 className="text-xl font-bold text-slate-900">
              {count} {count === 1 ? 'Message' : 'Messages'} Selected
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Message content is hidden while multiple items are selected.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2">
            <button
              type="button"
              onClick={handleMarkRead}
              className="flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs rounded-xl shadow-xs transition-all hover:shadow cursor-pointer active:scale-98"
            >
              <Eye className="w-4 h-4" />
              <span>Mark all as Read</span>
            </button>

            <button
              type="button"
              onClick={handleMarkUnread}
              className="flex items-center justify-center gap-2 py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs rounded-xl transition-all cursor-pointer active:scale-98"
            >
              <EyeOff className="w-4 h-4 text-slate-500" />
              <span>Mark all as Unread</span>
            </button>

            {onBulkSpam && (
              <button
                type="button"
                onClick={handleSpam}
                className="flex items-center justify-center gap-2 py-2.5 px-4 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-semibold text-xs rounded-xl transition-all cursor-pointer active:scale-98"
              >
                <ShieldAlert className="w-4 h-4 text-amber-600" />
                <span>Mark as spam</span>
              </button>
            )}

            {onBulkMove && (
              <button
                type="button"
                onClick={() => setIsMoveModalOpen(true)}
                className="flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-50 hover:bg-blue-100 text-blue-800 border border-blue-200 font-semibold text-xs rounded-xl transition-all cursor-pointer active:scale-98"
              >
                <FolderInput className="w-4 h-4 text-blue-600" />
                <span>Move to folder</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleDelete}
              className="flex items-center justify-center gap-2 py-2.5 px-4 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-semibold text-xs rounded-xl transition-all cursor-pointer active:scale-98 sm:col-span-2"
            >
              <Trash2 className="w-4 h-4 text-rose-600" />
              <span>Delete all selected messages</span>
            </button>
          </div>

          <div className="pt-2 border-t border-slate-100 flex items-center justify-center">
            <button
              type="button"
              onClick={onClearSelection}
              className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-700 font-medium transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              <span>Deselect all messages</span>
            </button>
          </div>
        </div>

        {/* Selected Items List Preview */}
        {selectedMessages.length > 0 && (
          <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-2xs space-y-3">
            <div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider px-1">
              <span>Selected items preview ({selectedMessages.length})</span>
            </div>

            <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 rounded-xl border border-slate-150">
              {selectedMessages.map(msg => (
                <div key={`${msg.accountEmail || 'default'}_${msg.uid}`} className="p-3 text-xs space-y-1 bg-white hover:bg-slate-50/50">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800 truncate">
                      {msg.from.name || msg.from.address}
                    </span>
                    <span className="text-[10px] text-slate-400 shrink-0 font-mono">
                      {formatDate(msg.date)}
                    </span>
                  </div>
                  <div className="text-slate-600 truncate font-medium">
                    {msg.subject || '(No Subject)'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>

      {onBulkMove && (
        <MoveToFolderModal
          isOpen={isMoveModalOpen}
          onClose={() => setIsMoveModalOpen(false)}
          folders={folders}
          currentFolder={selectedFolder}
          loadingFolders={loadingFolders}
          onSelectFolder={(targetFolder) => {
            onBulkMove(selectedTargets, targetFolder);
            setIsMoveModalOpen(false);
            onClearSelection();
          }}
          itemCount={count}
        />
      )}
    </div>
  );
}
