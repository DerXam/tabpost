import React from 'react';
import { FolderNode } from '../types';
import { Folder, Inbox, Send, FileText, Trash2, ShieldAlert, Archive, X, FolderInput, RefreshCw } from 'lucide-react';

interface MoveToFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  folders: FolderNode[];
  currentFolder?: string;
  loadingFolders?: boolean;
  onSelectFolder: (targetFolderPath: string) => void;
  itemCount?: number;
}

export default function MoveToFolderModal({
  isOpen,
  onClose,
  folders,
  currentFolder,
  loadingFolders,
  onSelectFolder,
  itemCount = 1
}: MoveToFolderModalProps) {
  if (!isOpen) return null;

  const getFolderIcon = (specialUse?: string, name?: string) => {
    const lowerName = (name || '').toLowerCase();
    const style = 'w-4 h-4 shrink-0 text-slate-500';

    if (specialUse === 'inbox' || lowerName === 'inbox') return <Inbox className={style} />;
    if (specialUse === 'sent' || lowerName.includes('sent')) return <Send className={style} />;
    if (specialUse === 'drafts' || lowerName.includes('draft')) return <FileText className={style} />;
    if (specialUse === 'trash' || lowerName.includes('trash') || lowerName.includes('bin')) return <Trash2 className={style} />;
    if (specialUse === 'junk' || lowerName.includes('junk') || lowerName.includes('spam')) return <ShieldAlert className={style} />;
    if (specialUse === 'archive' || lowerName.includes('archive')) return <Archive className={style} />;
    return <Folder className={style} />;
  };

  const filteredFolders = folders.filter(f => f.path !== currentFolder);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-fade-in">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-xl border border-blue-100">
              <FolderInput className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-800">
                Move {itemCount === 1 ? 'Message' : `${itemCount} Messages`}
              </h3>
              <p className="text-[11px] text-slate-400">Select destination folder</p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Folder List Body */}
        <div className="p-3 overflow-y-auto flex-1 space-y-1 divide-y divide-slate-50">
          {loadingFolders ? (
            <div className="py-8 text-center text-xs text-slate-400 flex flex-col items-center gap-2">
              <RefreshCw className="w-5 h-5 animate-spin text-blue-500" />
              <span>Loading folders...</span>
            </div>
          ) : filteredFolders.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400 italic">
              No other destination folders available.
            </div>
          ) : (
            filteredFolders.map((folder) => {
              const displayName = folder.name === 'INBOX' ? 'Inbox' : folder.name;
              return (
                <button
                  type="button"
                  key={folder.path}
                  onClick={() => {
                    onSelectFolder(folder.path);
                    onClose();
                  }}
                  className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-blue-50/60 hover:text-blue-700 text-slate-700 transition-all text-xs text-left cursor-pointer group border border-transparent hover:border-blue-100"
                >
                  <div className="flex items-center gap-3 truncate">
                    {getFolderIcon(folder.specialUse, folder.name)}
                    <span className="font-semibold truncate">{displayName}</span>
                  </div>
                  <span className="text-[10px] text-slate-400 group-hover:text-blue-600 font-medium">
                    Move here &rarr;
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-100 bg-slate-50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
