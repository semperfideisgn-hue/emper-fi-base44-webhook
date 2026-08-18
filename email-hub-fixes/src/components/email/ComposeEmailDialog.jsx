import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Paperclip, X, Send, Loader2, AlertCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Compose sends through the emailSyncWorker backend function (action:
// 'send_email'), which delivers over the selected EmailAccount's SMTP
// settings. The old version only created an EmailMessage record and showed
// "Sent!" without any email leaving.

export default function ComposeEmailDialog({ open, onOpenChange, defaultTo = '', defaultSubject = '', defaultBody = '', mode = 'compose' }) {
  const [form, setForm] = useState({
    to: defaultTo,
    cc: '',
    subject: defaultSubject,
    body: defaultBody,
  });
  const [attachments, setAttachments] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const modeLabel = { compose: 'New Email', reply: 'Reply', forward: 'Forward' }[mode];

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const all = await base44.entities.EmailAccount.list('-created_date', 50);
        setAccounts(all || []);
        if (!accountId && all?.length) {
          const preferred = all.find(a => a.status === 'connected') || all[0];
          setAccountId(preferred.id);
        }
      } catch {
        setAccounts([]);
      }
    })();
  }, [open]);

  const handleAttach = async (e) => {
    const files = Array.from(e.target.files);
    setSending(true);
    const uploaded = await Promise.all(files.map(async (file) => {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      return { name: file.name, url: file_url };
    }));
    setAttachments(prev => [...prev, ...uploaded]);
    setSending(false);
  };

  const handleSend = async () => {
    setError('');
    if (!accountId) {
      setError('Select a sending account first — add one in Email Accounts if the list is empty.');
      return;
    }
    setSending(true);
    try {
      const res = await base44.functions.invoke('emailSyncWorker', {
        action: 'send_email',
        emailAccountId: accountId,
        message: {
          to: form.to,
          cc: form.cc,
          subject: form.subject,
          body_text: form.body,
          attachments,
        },
      });
      const data = res?.data ?? res;
      if (!data?.success) {
        throw new Error(data?.error || 'Send failed');
      }
      setSent(true);
      setTimeout(() => { setSent(false); onOpenChange(false); }, 1200);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{modeLabel}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          <div className="flex gap-2 items-center">
            <Label className="w-12 text-right shrink-0">From</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="bg-secondary border-border">
                <SelectValue placeholder="Select sending account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map(a => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label ? `${a.label} — ${a.email_address}` : a.email_address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <div className="flex gap-2 items-center">
              <Label className="w-12 text-right shrink-0">To</Label>
              <Input value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))} placeholder="recipient@example.com" className="bg-secondary border-border" />
            </div>
            <div className="flex gap-2 items-center">
              <Label className="w-12 text-right shrink-0">CC</Label>
              <Input value={form.cc} onChange={e => setForm(f => ({ ...f, cc: e.target.value }))} placeholder="cc@example.com" className="bg-secondary border-border" />
            </div>
            <div className="flex gap-2 items-center">
              <Label className="w-12 text-right shrink-0">Subject</Label>
              <Input value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} placeholder="Subject" className="bg-secondary border-border" />
            </div>
          </div>
          <Textarea
            value={form.body}
            onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
            placeholder="Write your message..."
            className="min-h-[180px] bg-secondary border-border"
          />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((a, i) => (
                <div key={i} className="flex items-center gap-1 bg-secondary rounded px-2 py-1 text-xs">
                  <Paperclip className="w-3 h-3" /> {a.name}
                  <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} className="ml-1 text-muted-foreground hover:text-destructive">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}
          <div className="flex justify-between items-center">
            <label className="cursor-pointer flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <Paperclip className="w-4 h-4" /> Attach Files
              <input type="file" multiple className="hidden" onChange={handleAttach} />
            </label>
            <Button onClick={handleSend} disabled={sending || sent || !form.to || !form.subject}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Send className="w-4 h-4 mr-1" />}
              {sent ? 'Sent!' : 'Send'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
