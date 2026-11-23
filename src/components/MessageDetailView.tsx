import React, { useState, useEffect, useRef } from 'react';
import { MailMessageDetail, MailAccount, FolderNode } from '../types';
import { Reply, ReplyAll, Forward, Trash2, MailOpen, Paperclip, Download, ExternalLink, RefreshCw, ZoomIn, Eye, EyeOff, ChevronLeft, ShieldAlert, FolderInput } from 'lucide-react';
import MoveToFolderModal from './MoveToFolderModal';

interface MessageDetailViewProps {
  detail: MailMessageDetail | null;
  loading: boolean;
  onComposeReply: (type: 'reply' | 'reply-all' | 'forward') => void;
  onMarkUnread: () => void;
  onDeleteMessage: () => void;
  onMarkSpam?: () => void;
  onMoveMessage?: (targetFolder: string) => void;
  folders?: FolderNode[];
  loadingFolders?: boolean;
  activeAccount: MailAccount;
  selectedFolder: string;
  onBackToList?: () => void;
}

export default function MessageDetailView({
  detail,
  loading,
  onComposeReply,
  onMarkUnread,
  onDeleteMessage,
  onMarkSpam,
  onMoveMessage,
  folders = [],
  loadingFolders = false,
  activeAccount,
  selectedFolder,
  onBackToList
}: MessageDetailViewProps) {
  const [viewMode, setViewMode] = useState<'html' | 'text' | 'source'>('html');
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [isMoveModalOpen, setIsMoveModalOpen] = useState<boolean>(false);
  const [source, setSource] = useState<string | null>(null);
  const [sourceState, setSourceState] = useState<'idle' | 'loading' | 'error'>('idle');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Set default view mode based on what's available
  useEffect(() => {
    setSource(null);
    setSourceState('idle');
    if (detail) {
      if (detail.html) setViewMode('html');
      else setViewMode('text');
    }
  }, [detail]);

  // Raw message source, fetched only when the Source view is opened.
  useEffect(() => {
    if (viewMode !== 'source' || !detail || source !== null) return;
    let cancelled = false;
    setSourceState('loading');
    fetch('/api/message-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: activeAccount, folder: selectedFolder, uid: detail.uid })
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Failed (${r.status})`);
        if (!cancelled) { setSource(data.source ?? ''); setSourceState('idle'); }
      })
      .catch((err) => {
        if (!cancelled) { setSource(err?.message || 'Failed to load source'); setSourceState('error'); }
      });
    return () => { cancelled = true; };
  }, [viewMode, detail, source, activeAccount, selectedFolder]);

  // Handle attachment downloads.
  // Credentials go in the POST body, never the URL: query strings end up in
  // server access logs, browser history and any proxy along the way.
  const handleDownloadAttachment = async (filename: string, index: number) => {
    if (!detail) return;
    let objectUrl: string | null = null;
    try {
      const response = await fetch('/api/attachment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: activeAccount,
          folder: selectedFolder,
          uid: detail.uid,
          index
        })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Download failed (${response.status})`);
      }

      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = objectUrl;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      console.error('Failed to download attachment', err);
      alert(err?.message || 'Attachment download failed. Please try again.');
    } finally {
      if (objectUrl) {
        // Give the browser a moment to start the download before revoking.
        setTimeout(() => URL.revokeObjectURL(objectUrl!), 60000);
      }
    }
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  // Plain-text mail goes into the HTML document below, so it must not be
  // parsed as markup: "<b>" in a text mail is text, not bold.
  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  // Dynamic sandbox source mapping
  const srcDoc = detail
    ? viewMode === 'html' && detail.html
      ? `
        <!DOCTYPE html>
        <html>
          <head>
            <base target="_blank">
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                line-height: 1.6;
                color: #2D3748;
                margin: 20px;
                background-color: #FFFFFF;
                word-wrap: break-word;
                overflow-x: auto;
              }
              a { color: #10B981; text-decoration: underline; }
              img { max-width: 100% !important; height: auto !important; }
              blockquote {
                border-left: 2px solid #E2E8F0;
                padding-left: 12px;
                color: #718096;
                margin-left: 0;
              }
            </style>
          </head>
          <body>
            ${detail.html}
          </body>
        </html>
      `
      : `
        <!DOCTYPE html>
        <html>
          <head>
            <base target="_blank">
            <style>
              body {
                font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
                font-size: 13px;
                line-height: 1.5;
                color: #2D3748;
                margin: 20px;
                white-space: pre-wrap;
                word-wrap: break-word;
                background-color: #FFFFFF;
              }
            </style>
          </head>
          <body>${escapeHtml(detail.text || '(Empty Body)')}</body>
        </html>
      `
    : '';

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-50/40 min-w-0 select-none">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600 mb-2" />
        <span className="text-slate-550 text-sm">Opening mail connection & loading message stream...</span>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-50/50 min-w-0 select-none text-center">
        <div className="max-w-sm p-6 rounded-lg bg-white border border-slate-200 shadow-sm">
          <MailOpen className="w-12 h-12 text-slate-400 mx-auto mb-3" />
          <h3 className="text-slate-700 font-semibold mb-1 text-sm">No Message Selected</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Select an email from the message list to view its contents, attachments, and headers.
          </p>
        </div>
      </div>
    );
  }

  // Comma joined list of recipients
  const showToField = detail.to.map(t => t.name || t.address).join(', ');
  const showCcField = detail.cc && detail.cc.length > 0 ? detail.cc.map(t => t.name || t.address).join(', ') : '';

  return (
    <div className="flex-1 flex flex-col h-full bg-white min-w-0 overflow-hidden text-slate-800">
      
      {/* Top action toolbar */}
      <div className="p-3 border-b border-slate-200 bg-slate-50/50 flex items-center justify-between shrink-0 select-none">
        
        {/* Reply switches */}
        <div className="flex items-center gap-1.5">
          {onBackToList && (
            <button
              onClick={onBackToList}
              className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer border border-slate-250/60 shadow-2xs mr-1.5"
              title="Back to inbox"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>
          )}
          <button
            onClick={() => onComposeReply('reply')}
            className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer border border-slate-200 shadow-xs"
            title="Reply"
          >
            <Reply className="w-3.5 h-3.5 text-blue-650" />
            <span className="hidden sm:inline">Reply</span>
          </button>
          <button
            onClick={() => onComposeReply('reply-all')}
            className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer border border-slate-200 shadow-xs"
            title="Reply All"
          >
            <ReplyAll className="w-3.5 h-3.5 text-blue-655" />
            <span className="hidden sm:inline">Reply All</span>
          </button>
          <button
            onClick={() => onComposeReply('forward')}
            className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer border border-slate-200 shadow-xs"
            title="Forward"
          >
            <Forward className="w-3.5 h-3.5 text-blue-650" />
            <span className="hidden sm:inline">Forward</span>
          </button>
        </div>

        {/* Action modifiers */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onMarkUnread}
            className="p-1.5 hover:bg-slate-150 text-slate-500 hover:text-blue-600 rounded transition-colors cursor-pointer border border-transparent hover:border-slate-200"
            title="Mark as Unread"
          >
            <MailOpen className="w-4 h-4" />
          </button>
          
          {onMarkSpam && (
            <button
              onClick={onMarkSpam}
              className="p-1.5 hover:bg-amber-50 text-slate-500 hover:text-amber-600 rounded transition-colors cursor-pointer border border-transparent hover:border-amber-200"
              title="Mark as spam"
            >
              <ShieldAlert className="w-4 h-4" />
            </button>
          )}

          {onMoveMessage && (
            <button
              onClick={() => setIsMoveModalOpen(true)}
              className="p-1.5 hover:bg-blue-50 text-slate-500 hover:text-blue-600 rounded transition-colors cursor-pointer border border-transparent hover:border-blue-200"
              title="Move to folder"
            >
              <FolderInput className="w-4 h-4" />
            </button>
          )}

          <button
            onClick={onDeleteMessage}
            className="p-1.5 hover:bg-slate-150 text-slate-500 hover:text-rose-600 rounded transition-colors cursor-pointer border border-transparent hover:border-slate-200"
            title="Delete permanently / Move to Trash"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Message Scroller Body */}
      <div className="flex-1 flex flex-col overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-slate-200">
        
        {/* Core Headers Pane */}
        <div className="space-y-4">
          <h1 className="text-xl font-bold text-slate-900 tracking-tight leading-snug">
            {detail.subject}
          </h1>

          <div className="bg-slate-50 border border-slate-200/80 rounded-lg p-4 space-y-2.5 text-xs select-text text-slate-600">
            <div className="grid grid-cols-[60px_1fr] items-baseline">
              <span className="text-slate-400 font-bold uppercase tracking-wider text-[10px]">From:</span>
              <span>
                <span className="font-bold text-blue-800">{detail.from.name || ''}</span>{' '}
                <span className="text-slate-400 font-mono text-[11px]">&lt;{detail.from.address}&gt;</span>
              </span>
            </div>

            <div className="grid grid-cols-[60px_1fr] items-baseline">
              <span className="text-slate-400 font-bold uppercase tracking-wider text-[10px]">To:</span>
              <span className="text-slate-600 truncate" title={showToField}>{showToField}</span>
            </div>

            {showCcField && (
              <div className="grid grid-cols-[60px_1fr] items-baseline">
                <span className="text-slate-400 font-bold uppercase tracking-wider text-[10px]">Cc:</span>
                <span className="text-slate-600 truncate" title={showCcField}>{showCcField}</span>
              </div>
            )}

            <div className="grid grid-cols-[60px_1fr] items-baseline">
              <span className="text-slate-400 font-bold uppercase tracking-wider text-[10px]">Date:</span>
              <span className="text-slate-500 font-mono text-[11px]">
                {new Date(detail.date).toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' })}
              </span>
            </div>
          </div>
        </div>

        {/* Attachments Section */}
        {detail.attachments && detail.attachments.length > 0 && (
          <div className="space-y-2.5 select-none">
            <div className="flex items-center gap-1.5 text-xs text-slate-400 font-bold uppercase tracking-wider">
              <Paperclip className="w-3.5 h-3.5 text-blue-600" />
              <span>Attachments ({detail.attachments.length})</span>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {detail.attachments.map((att) => (
                <div
                  key={att.index}
                  onClick={() => handleDownloadAttachment(att.filename, att.index)}
                  className="bg-slate-50 border border-slate-200 hover:border-slate-300 p-2.5 rounded-md flex items-center justify-between gap-3 text-xs cursor-pointer group transition-all"
                >
                  <div className="truncate flex flex-col min-w-0 gap-0.5">
                    <span className="text-slate-700 font-medium truncate group-hover:text-blue-600 transition-colors" title={att.filename}>
                      {att.filename}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">
                      {att.contentType.split('/').pop()?.toUpperCase()} • {formatSize(att.size)}
                    </span>
                  </div>
                  <button className="p-1.5 rounded-full bg-white text-slate-400 group-hover:text-blue-650 shrink-0 border border-slate-205 shadow-2xs">
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Message body frame container */}
        <div className="flex-1 border border-slate-200 bg-white rounded-lg flex flex-col min-h-[450px] shadow-xs overflow-hidden relative">
          
          {/* Document Format Bar */}
          <div className="px-4 py-2 border-b border-slate-200 bg-slate-50/85 flex items-center justify-between shrink-0 select-none text-xs text-slate-600">
            <div className="flex items-center gap-3">
              <span className="text-slate-400 font-bold uppercase text-[10px] tracking-wider">Message View:</span>
              <div className="flex items-center border border-slate-300 rounded bg-white p-0.5">
                <button
                  onClick={() => setViewMode('html')}
                  disabled={!detail.html}
                  className={`px-3 py-0.5 rounded text-[10px] uppercase font-bold transition-all ${
                    viewMode === 'html'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-600 hover:bg-slate-100 disabled:opacity-30'
                  }`}
                >
                  HTML
                </button>
                <button
                  onClick={() => setViewMode('text')}
                  disabled={!detail.text}
                  className={`px-3 py-0.5 rounded text-[10px] uppercase font-bold transition-all ${
                    viewMode === 'text'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-600 hover:bg-slate-100 disabled:opacity-30'
                  }`}
                >
                  Text
                </button>
                <button
                  onClick={() => setViewMode('source')}
                  className={`px-3 py-0.5 rounded text-[10px] uppercase font-bold transition-all ${
                    viewMode === 'source'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                  title="Show raw message source"
                >
                  Source
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <ZoomIn className="w-3.5 h-3.5 text-slate-400" />
                <select
                  value={zoomLevel}
                  onChange={(e) => setZoomLevel(Number(e.target.value))}
                  className="bg-white border border-slate-300 rounded py-0.5 px-1.5 text-[11px] font-mono text-slate-600 focus:outline-none"
                >
                  <option value="80">80%</option>
                  <option value="90">90%</option>
                  <option value="100">100%</option>
                  <option value="110">110%</option>
                  <option value="120">120%</option>
                  <option value="130">130%</option>
                </select>
              </div>
            </div>
          </div>

          {/* Sandboxed iframe */}
          {viewMode === 'source' ? (
            <div className="flex-1 w-full bg-white relative overflow-auto">
              {sourceState === 'loading' ? (
                <div className="p-4 text-xs text-slate-500 flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading source…
                </div>
              ) : (
                <pre
                  className={`p-4 font-mono whitespace-pre-wrap break-all ${sourceState === 'error' ? 'text-red-600' : 'text-slate-700'}`}
                  style={{ fontSize: `${(12 * zoomLevel) / 100}px` }}
                >
                  {source}
                </pre>
              )}
            </div>
          ) : (
          <div className="flex-1 w-full bg-white relative p-1">
            <iframe
              ref={iframeRef}
              title="Mail Body Content"
              srcDoc={srcDoc}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              className="w-full h-full border-0 focus:outline-none"
              style={{
                transform: `scale(${zoomLevel / 100})`,
                transformOrigin: 'top left',
                width: `${100 / (zoomLevel / 100)}%`,
                height: `${100 / (zoomLevel / 100)}%`,
              }}
            />
          </div>
          )}
        </div>
      </div>

      {onMoveMessage && (
        <MoveToFolderModal
          isOpen={isMoveModalOpen}
          onClose={() => setIsMoveModalOpen(false)}
          folders={folders}
          currentFolder={selectedFolder}
          loadingFolders={loadingFolders}
          onSelectFolder={(targetFolder) => {
            onMoveMessage(targetFolder);
            setIsMoveModalOpen(false);
          }}
          itemCount={1}
        />
      )}
    </div>
  );
}
