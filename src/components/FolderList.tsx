import React from 'react';
import { FolderNode, MailAccount } from '../types';
import { Inbox, Send, FileText, Trash2, ShieldAlert, Archive, Folder, Pencil, RefreshCw, LogOut } from 'lucide-react';

interface FolderListProps {
  folders: FolderNode[];
  selectedFolder: string;
  onSelectFolder: (path: string) => void;
  onStartCompose: () => void;
  onRefreshFolders: () => void;
  onLogoutAccount: () => void;
  loading: boolean;
  activeAccount: MailAccount;
  isGlobalMode?: boolean;
}

export default function FolderList({
  folders,
  selectedFolder,
  onSelectFolder,
  onStartCompose,
  onRefreshFolders,
  onLogoutAccount,
  loading,
  activeAccount,
  isGlobalMode
}: FolderListProps) {
  
  const getFolderIcon = (specialUse?: string, name?: string, isSelected?: boolean) => {
    const lowerName = (name || '').toLowerCase();
    const style = `w-4 h-4 shrink-0 transition-colors ${isSelected ? 'text-blue-600' : 'text-slate-500'}`;
    
    if (specialUse === 'inbox' || lowerName === 'inbox') return <Inbox className={style} />;
    if (specialUse === 'sent' || lowerName.includes('sent')) return <Send className={style} />;
    if (specialUse === 'drafts' || lowerName.includes('draft')) return <FileText className={style} />;
    if (specialUse === 'trash' || lowerName.includes('trash') || lowerName.includes('bin')) return <Trash2 className={style} />;
    if (specialUse === 'junk' || lowerName.includes('junk') || lowerName.includes('spam')) return <ShieldAlert className={style} />;
    if (specialUse === 'archive' || lowerName.includes('archive')) return <Archive className={style} />;
    return <Folder className={style} />;
  };

  return (
    <div className="w-64 bg-slate-50 border-r border-slate-200 flex flex-col h-full select-none flex-shrink-0 text-slate-800">
      
      {/* Compose Trigger */}
      <div className="p-4 border-b border-slate-200 bg-slate-50">
        <button
          onClick={onStartCompose}
          className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold py-2.5 px-4 rounded-md flex items-center justify-center gap-2 shadow-sm hover:shadow-md cursor-pointer transition-all text-sm"
        >
          <Pencil className="w-4 h-4" />
          <span>Compose</span>
        </button>
      </div>

      {/* Folders Scrollable List */}
      <div className="flex-1 overflow-y-auto py-3 space-y-1 px-2 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent">
        <div className="flex justify-between items-center px-3 mb-2">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-semibold">Folders</span>
          <button
            onClick={onRefreshFolders}
            disabled={loading}
            className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-200/50 focus:outline-none disabled:opacity-50 transition-colors"
            title="Refresh list"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-blue-600' : ''}`} />
          </button>
        </div>

        {folders.length === 0 ? (
          <div className="text-center py-8 text-xs text-slate-400 italic">
            {loading ? 'Fetching folders...' : 'No folders found'}
          </div>
        ) : (
          folders.map((folder) => {
            const isSelected = selectedFolder === folder.path;
            return (
              <button
                key={folder.path}
                onClick={() => onSelectFolder(folder.path)}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-md transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-blue-50 border-l-4 border-blue-600 text-blue-700 font-semibold'
                    : 'text-slate-600 hover:bg-slate-200/50 hover:text-slate-900'
                }`}
              >
                <div className="flex items-center gap-2.5 truncate">
                  {getFolderIcon(folder.specialUse, folder.name, isSelected)}
                  <span className="truncate" title={folder.name}>
                    {folder.name === 'INBOX' ? 'Inbox' : folder.name}
                  </span>
                </div>
                {folder.unreadCount > 0 && (
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    isSelected ? 'bg-blue-100 text-blue-700' : 'bg-slate-200 text-slate-600'
                  }`}>
                    {folder.unreadCount}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {/* Footer Profile Control */}
      <div className="p-4 border-t border-slate-200 bg-slate-100/50 flex items-center justify-between text-xs">
        <div className="truncate flex flex-col gap-0.5 min-w-0">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Active Credentials</span>
          <span className="text-slate-700 font-semibold truncate flex items-center gap-1.5" title={isGlobalMode ? 'All Connected Inboxes Merged' : activeAccount?.email}>
            {isGlobalMode ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse shrink-0" />
                <span className="text-blue-700 font-extrabold uppercase text-[10px] tracking-wider">Global Unified Session</span>
              </>
            ) : (
              activeAccount?.email
            )}
          </span>
        </div>
        {!isGlobalMode && (
          <button
            onClick={onLogoutAccount}
            className="text-slate-400 hover:text-rose-600 p-1.5 rounded hover:bg-slate-200/60 focus:outline-none transition-colors border border-transparent hover:border-slate-200 focus:ring-1 focus:ring-rose-500"
            title="Sign out account"
          >
            <LogOut className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
