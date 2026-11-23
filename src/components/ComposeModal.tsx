import React, { useState, useEffect } from 'react';
import { MailAccount, MailMessageDetail } from '../types';
import { Send, X, AlertTriangle, Paperclip, Loader2 } from 'lucide-react';

interface ComposeModalProps {
  onClose: () => void;
  activeAccount: MailAccount;
  replyToMessage?: {
    detail: MailMessageDetail;
    type: 'reply' | 'reply-all' | 'forward';
    /** Folder the original lives in, needed to re-read its attachments. */
    folder: string;
  };
  onSendSuccess: () => void;
}

export default function ComposeModal({
  onClose,
  activeAccount,
  replyToMessage,
  onSendSuccess
}: ComposeModalProps) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  interface AttachmentItem {
    name: string;
    size: number;
    type: string;
    content: string;
  }

  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [loadingAttachments, setLoadingAttachments] = useState(false);

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const handleFiles = (fileList: FileList) => {
    Array.from(fileList).forEach(file => {
      if (file.size > 15 * 1024 * 1024) {
        alert(`File ${file.name} is too large. Maximum size is 15MB.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        const base64Data = result.substring(result.indexOf(',') + 1);
        
        setAttachments(prev => {
          if (prev.some(item => item.name === file.name && item.size === file.size)) {
            return prev;
          }
          return [...prev, {
            name: file.name,
            size: file.size,
            type: file.type,
            content: base64Data
          }];
        });
      };
      reader.readAsDataURL(file);
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Prefill fields if replying / forwarding
  useEffect(() => {
    if (replyToMessage) {
      const { detail, type } = replyToMessage;
      
      // Clean up subject prefix
      let cleanSubject = detail.subject;
      const lowerSub = cleanSubject.toLowerCase();
      if (type === 'forward') {
        if (!lowerSub.startsWith('fwd:')) {
          cleanSubject = `Fwd: ${cleanSubject}`;
        }
      } else {
        if (!lowerSub.startsWith('re:')) {
          cleanSubject = `Re: ${cleanSubject}`;
        }
      }
      setSubject(cleanSubject);

      // Handle recipient scoping
      if (type === 'reply') {
        setTo(detail.from.address);
      } else if (type === 'reply-all') {
        // Collect sender + all "to" recipients except myself
        const recipients = [
          detail.from.address,
          ...detail.to.map(t => t.address)
        ].filter(addr => addr.toLowerCase() !== activeAccount.email.toLowerCase());
        
        setTo(recipients.join(', '));
        if (detail.cc && detail.cc.length > 0) {
          const ccList = detail.cc
            .map(t => t.address)
            .filter(addr => addr.toLowerCase() !== activeAccount.email.toLowerCase());
          if (ccList.length > 0) {
            setCc(ccList.join(', '));
            setShowCc(true);
          }
        }
      }

      // Generate visual message history quote block
      const dateStr = new Date(detail.date).toLocaleString();
      const quoteHeader = `\n\n\nOn ${dateStr}, ${detail.from.name || detail.from.address} <${detail.from.address}> wrote:\n`;
      const quotedBody = (detail.text || '')
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      
      setBody(`${quoteHeader}${quotedBody}`);
    }
  }, [replyToMessage, activeAccount]);

  // A forward carries the original files with it, the way every other mail
  // client does. The list view only knows the attachments exist, so the bodies
  // have to be pulled back off the server before this mail can be sent.
  useEffect(() => {
    if (!replyToMessage || replyToMessage.type !== 'forward') return;
    const { detail, folder } = replyToMessage;
    if (!detail.attachments || detail.attachments.length === 0) return;

    let cancelled = false;
    setLoadingAttachments(true);
    setError(null);

    (async () => {
      try {
        const response = await fetch('/api/attachments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: activeAccount, folder, uid: detail.uid })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Could not load the original attachments.');
        }
        if (cancelled) return;
        setAttachments((data.attachments || []).map((att: any) => ({
          name: att.filename,
          size: att.size,
          type: att.contentType,
          content: att.content
        })));
      } catch (err: any) {
        if (!cancelled) {
          setError(`${err.message || 'Could not load the original attachments.'} You can still send this mail, but without them.`);
        }
      } finally {
        if (!cancelled) setLoadingAttachments(false);
      }
    })();

    return () => { cancelled = true; };
  }, [replyToMessage, activeAccount]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!to) {
      setError('Recipient field "To" is required to send.');
      return;
    }
    if (!subject) {
      if (!confirm('Send this email without a subject?')) {
        return;
      }
    }

    setSending(true);
    setError(null);

    try {
      const response = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: activeAccount,
          to: to.split(',').map(s => s.trim()).filter(Boolean),
          cc: cc ? cc.split(',').map(s => s.trim()).filter(Boolean) : undefined,
          bcc: bcc ? bcc.split(',').map(s => s.trim()).filter(Boolean) : undefined,
          subject,
          text: body,
          html: `<div style="font-family: sans-serif; font-size: 14px; line-height: 1.5;">${body.replace(/\n/g, '<br />')}</div>`,
          attachments: attachments.map(att => ({
            filename: att.name,
            content: att.content,
            contentType: att.type
          }))
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to dispatch email via SMTP server');
      }

      onSendSuccess();
    } catch (err: any) {
      setError(err.message || 'Connecting to SMTP host collapsed. Make sure your SMTP server parameters are completely correct.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-white border border-slate-250 text-slate-800 rounded-xl w-full max-w-3xl shadow-2xl flex flex-col h-[85vh] overflow-hidden">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-150 flex justify-between items-center bg-slate-50/50 select-none shrink-0">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-blue-50 text-blue-600">
              <Send className="w-4 h-4 text-blue-600" />
            </span>
            <h2 className="text-xs font-bold tracking-tight text-slate-800">
              {replyToMessage ? `Compose Reply (${replyToMessage.type.replace('-', ' ')})` : 'New Email Message'}
            </h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1.5 rounded hover:bg-slate-100 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body Fields */}
        <form onSubmit={handleSend} className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-150 bg-slate-50/30 text-xs space-y-3 shrink-0">
            
            {error && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-xs flex gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* To Grid */}
            <div className="grid grid-cols-[60px_1fr_auto] items-center gap-1.5">
              <label className="text-slate-400 font-bold uppercase tracking-wider text-[10px]">To:</label>
              <input
                type="text"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="recipient@domain.com, buddy@domain.com"
                className="bg-transparent text-slate-800 focus:outline-none py-1 w-full text-xs placeholder-slate-400"
                required
                autoFocus
              />
              <div className="flex gap-2 shrink-0 text-[10px] text-slate-400 font-bold">
                <button
                  type="button"
                  onClick={() => setShowCc(!showCc)}
                  className={`hover:text-blue-600 px-1 py-0.5 rounded cursor-pointer transition-colors ${showCc ? 'text-blue-600 font-extrabold bg-blue-50' : ''}`}
                >
                  Cc
                </button>
                <button
                  type="button"
                  onClick={() => setShowBcc(!showBcc)}
                  className={`hover:text-blue-600 px-1 py-0.5 rounded cursor-pointer transition-colors ${showBcc ? 'text-blue-600 font-extrabold bg-blue-50' : ''}`}
                >
                  Bcc
                </button>
              </div>
            </div>

            {/* Cc Grid */}
            {showCc && (
              <div className="grid grid-cols-[60px_1fr] items-center gap-1.5 border-t border-slate-150 pt-2.5">
                <label className="text-slate-400 font-bold uppercase tracking-wider text-[10px]">Cc:</label>
                <input
                  type="text"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="carboncopy@domain.com"
                  className="bg-transparent text-slate-800 focus:outline-none py-1 w-full text-xs placeholder-slate-400"
                />
              </div>
            )}

            {/* Bcc Grid */}
            {showBcc && (
              <div className="grid grid-cols-[60px_1fr] items-center gap-1.5 border-t border-slate-150 pt-2.5">
                <label className="text-slate-400 font-bold uppercase tracking-wider text-[10px]">Bcc:</label>
                <input
                  type="text"
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  placeholder="blindcopy@domain.com"
                  className="bg-transparent text-slate-800 focus:outline-none py-1 w-full text-xs placeholder-slate-400"
                />
              </div>
            )}

            {/* Subject Grid */}
            <div className="grid grid-cols-[60px_1fr] items-center gap-1.5 border-t border-slate-150 pt-2.5">
              <label className="text-slate-400 font-bold uppercase tracking-wider text-[10px]">Subject:</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Email Subject Title"
                className="bg-transparent text-slate-800 focus:outline-none py-1 w-full text-xs placeholder-slate-400 font-semibold"
              />
            </div>
          </div>

          {/* Email Body and Attachments Shelf */}
          <div 
            onDragOver={handleDragOver}
            className="flex-1 flex flex-col overflow-y-auto min-h-0 bg-white relative"
          >
            <div className="flex-1 p-4 flex flex-col">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write your email body message here... Or drop files anywhere in this window to attach them!"
                className="w-full flex-1 bg-transparent focus:outline-none resize-none font-sans text-sm text-slate-700 leading-relaxed placeholder-slate-400"
                style={{ minHeight: '120px' }}
              />
            </div>

            {/* Drag & Drop Visual Overlay */}
            {isDragging && (
              <div 
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className="absolute inset-0 bg-blue-50/90 border-2 border-dashed border-blue-400 m-3 rounded-xl flex flex-col items-center justify-center text-blue-700 z-50 transition-all duration-150 animate-pulse"
              >
                <Paperclip className="w-12 h-12 mb-2 animate-bounce text-blue-600" />
                <span className="font-bold text-sm">Drop files here to attach</span>
                <span className="text-[10px] uppercase font-bold text-blue-500 mt-1">Release to upload files</span>
              </div>
            )}

            {/* Attachments Shelf */}
            {(attachments.length > 0 || loadingAttachments) && (
              <div className="px-4 py-2.5 border-t border-slate-150 bg-slate-50/50 flex flex-wrap gap-2 shrink-0 max-h-[140px] overflow-y-auto scrollbar-thin">
                {loadingAttachments && (
                  <div className="flex items-center gap-2 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px] font-semibold text-slate-500 select-none">
                    <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin" />
                    <span>Attaching original files...</span>
                  </div>
                )}
                {attachments.map((file, idx) => (
                  <div 
                    key={idx}
                    className="flex items-center gap-2 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg shadow-2xs group hover:border-slate-300 transition-all select-none"
                  >
                    <Paperclip className="w-3.5 h-3.5 text-slate-400" />
                    <div className="flex flex-col min-w-0 max-w-[150px]">
                      <span className="text-[11px] font-semibold text-slate-700 truncate" title={file.name}>
                        {file.name}
                      </span>
                      <span className="text-[9px] text-slate-400 font-medium">
                        {formatFileSize(file.size)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttachment(idx)}
                      className="p-1 rounded-full text-slate-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer transition-colors"
                      title="Remove attachment"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer Controls */}
          <div className="p-4 border-t border-slate-150 bg-slate-50/50 flex justify-between items-center shrink-0 select-none">
            <div className="flex items-center gap-3">
              <label 
                htmlFor="file-upload" 
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 border border-slate-250 hover:border-slate-350 text-[11px] text-slate-700 font-bold uppercase tracking-wider cursor-pointer transition-all shadow-2xs active:scale-[0.98]"
              >
                <Paperclip className="w-3.5 h-3.5 text-blue-600" />
                <span>Attach Files</span>
              </label>
              <input
                id="file-upload"
                type="file"
                multiple
                onChange={handleFileChange}
                className="hidden"
              />
              <span className="hidden sm:inline text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                SMTP: {activeAccount.smtpHost}:{activeAccount.smtpPort}
              </span>
            </div>
            
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-slate-250 text-slate-600 rounded-lg hover:bg-slate-100 text-xs font-bold cursor-pointer transition-colors"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={sending || loadingAttachments}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/40 disabled:cursor-not-allowed text-white font-bold rounded-lg text-xs flex items-center gap-2 cursor-pointer transition-all shadow-sm hover:shadow-md"
              >
                <span>{sending ? 'Sending...' : loadingAttachments ? 'Attaching...' : 'Send Message'}</span>
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
