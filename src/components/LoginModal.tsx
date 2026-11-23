import React, { useState, useEffect } from 'react';
import { MailAccount } from '../types';
import { Mail, Shield, Server, ArrowRight, X, Info } from 'lucide-react';

interface LoginModalProps {
  onAddAccount: (account: MailAccount) => void;
  onClose: () => void;
  isFirstAccount: boolean;
}

export default function LoginModal({ onAddAccount, onClose, isFirstAccount }: LoginModalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountName, setAccountName] = useState('');
  
  // IMAP settings
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState(993);
  const [imapSecure, setImapSecure] = useState(true);

  // SMTP settings
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(465);
  const [smtpSecure, setSmtpSecure] = useState(true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [providerNote, setProviderNote] = useState<string | null>(null);

  // Auto-fill configuration based on email input domains
  useEffect(() => {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return;

    if (domain === 'gmail.com') {
      setImapHost('imap.gmail.com');
      setImapPort(993);
      setImapSecure(true);
      setSmtpHost('smtp.gmail.com');
      setSmtpPort(465);
      setSmtpSecure(true);
      setProviderNote('Gmail requires an "App Password" to connect through IMAP. Please generate one in your Google account security page.');
    } else if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain === 'msn.com') {
      setImapHost('outlook.office365.com');
      setImapPort(993);
      setImapSecure(true);
      setSmtpHost('smtp.office365.com');
      setSmtpPort(587);
      setSmtpSecure(false);
      setProviderNote('Outlook may require an "App Password" if 2-Factor Authentication is enabled on your Microsoft account.');
    } else if (domain === 'yahoo.com') {
      setImapHost('imap.mail.yahoo.com');
      setImapPort(993);
      setImapSecure(true);
      setSmtpHost('smtp.mail.yahoo.com');
      setSmtpPort(465);
      setSmtpSecure(true);
      setProviderNote('Yahoo Mail requires an "App Password" generated in your Account Info -> Account Security page.');
    } else if (domain === 'aol.com') {
      setImapHost('imap.aol.com');
      setImapPort(993);
      setImapSecure(true);
      setSmtpHost('smtp.aol.com');
      setSmtpPort(465);
      setSmtpSecure(true);
      setProviderNote('AOL Mail requires an "App Password" generated in your AOL Account Security tab.');
    } else {
      // General guess
      setImapHost(`imap.${domain}`);
      setImapPort(993);
      setImapSecure(true);
      setSmtpHost(`smtp.${domain}`);
      setSmtpPort(465);
      setSmtpSecure(true);
      setProviderNote(null);
    }
  }, [email]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !imapHost || !smtpHost) {
      setError('Please fill in all standard configuration fields');
      return;
    }

    setLoading(true);
    setError(null);

    const checkAccount: MailAccount = {
      id: `${email}_${Date.now()}`,
      email,
      accountName: accountName.trim() || undefined,
      password,
      imapHost,
      imapPort,
      imapSecure,
      smtpHost,
      smtpPort,
      smtpSecure
    };

    try {
      // Send a request to verification endpoint on the backend
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: checkAccount })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Check server connection parameters and credentials');
      }

      // Add to parents state
      onAddAccount(checkAccount);
    } catch (err: any) {
      setError(err.message || 'Connecting to mail server failed. Double check your host, port, and security credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-white border border-slate-200 text-slate-800 rounded-xl w-full max-w-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-150 flex justify-between items-center bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
              <Mail className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold tracking-tight text-slate-800">Add Email Account</h2>
              <p className="text-[11px] text-slate-400 font-medium">Connect a mailbox concurrent session via IMAP & SMTP</p>
            </div>
          </div>
          {!isFirstAccount && (
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1.5 rounded-md hover:bg-slate-100 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-xs leading-relaxed flex gap-2">
              <Shield className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-500" />
              <span>{error}</span>
            </div>
          )}

          {providerNote && (
            <div className="p-3 bg-amber-50 border border-amber-200 text-amber-700 rounded text-xs leading-relaxed flex gap-2">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
              <span>{providerNote}</span>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Account Display Name (Optional)</label>
              <input
                type="text"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                placeholder="e.g. Work Email, Personal, Support"
                className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600/30 transition-all placeholder-slate-400"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Email Address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600/30 transition-all placeholder-slate-400"
                required
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Password / App Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••••••"
                className="w-full bg-white border border-slate-200 rounded px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600/30 transition-all placeholder-slate-400"
                required
              />
            </div>
          </div>

          {/* Toggle Advanced */}
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-[11px] font-semibold text-slate-500 hover:text-blue-600 flex items-center gap-1.5 focus:outline-none cursor-pointer transition-colors"
            >
              <Server className="w-3.5 h-3.5" />
              <span>{showAdvanced ? 'Hide advanced host configurations' : 'Configure custom host parameters (IMAP/SMTP)'}</span>
            </button>
          </div>

          {showAdvanced && (
            <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-4 animate-slide-down">
              <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Protocol Host Settings</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">IMAP Incoming Server</label>
                  <input
                    type="text"
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                    placeholder="imap.example.com"
                    className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">IMAP Port</label>
                  <input
                    type="number"
                    value={imapPort}
                    onChange={(e) => setImapPort(Number(e.target.value))}
                    className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 select-none">
                <input
                  type="checkbox"
                  id="imapSecure"
                  checked={imapSecure}
                  onChange={(e) => setImapSecure(e.target.checked)}
                  className="rounded bg-white border-slate-300 text-blue-600 focus:ring-blue-600/40 focus:ring-1"
                />
                <label htmlFor="imapSecure" className="text-xs text-slate-600 font-medium cursor-pointer">
                  Require SSL/TLS secure channel
                </label>
              </div>

              <hr className="border-slate-200" />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">SMTP Outgoing Server</label>
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.example.com"
                    className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">SMTP Port</label>
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(Number(e.target.value))}
                    className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 select-none">
                <input
                  type="checkbox"
                  id="smtpSecure"
                  checked={smtpSecure}
                  onChange={(e) => setSmtpSecure(e.target.checked)}
                  className="rounded bg-white border-slate-300 text-blue-600 focus:ring-blue-600/40 focus:ring-1"
                />
                <label htmlFor="smtpSecure" className="text-xs text-slate-600 font-medium cursor-pointer">
                  Require SSL/TLS secure channel
                </label>
              </div>
            </div>
          )}

          {/* Action Footer */}
          <div className="pt-4 flex gap-3 select-none">
            {!isFirstAccount && (
              <button
                type="button"
                onClick={onClose}
                className="flex-1 border border-slate-250 hover:bg-slate-100 text-slate-600 font-bold py-2 px-4 rounded text-xs transition-colors cursor-pointer"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/40 disabled:cursor-not-allowed text-white font-bold py-2.5 px-4 rounded text-xs transition-all flex items-center justify-center gap-2 cursor-pointer shadow-sm hover:shadow-md"
            >
              <span>{loading ? 'Testing Session parameters...' : 'Connect Mailbox'}</span>
              {!loading && <ArrowRight className="w-4 h-4 font-bold" />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
