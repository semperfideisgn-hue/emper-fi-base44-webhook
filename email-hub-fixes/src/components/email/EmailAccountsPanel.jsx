import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Wifi, WifiOff, Trash2, RefreshCw } from 'lucide-react';

const STATUS_ICON = {
  connected: <Wifi className="w-4 h-4 text-green-400" />,
  error: <WifiOff className="w-4 h-4 text-red-400" />,
  disconnected: <WifiOff className="w-4 h-4 text-muted-foreground" />,
};

export default function EmailAccountsPanel({ user }) {
  const [accounts, setAccounts] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ label: '', email_address: '', provider: 'imap_smtp', imap_host: '', imap_port: 993, smtp_host: '', smtp_port: 587, username: '', password: '' });
  const [testing, setTesting] = useState(null);
  const [saveError, setSaveError] = useState('');
  const isAdmin = user?.role === 'admin';

  const load = async () => {
    const all = await base44.entities.EmailAccount.list();
    setAccounts(isAdmin ? all : all.filter(a => a.owner_user_id === user?.id || a.is_shared));
  };

  useEffect(() => { if (user) load(); }, [user]);

  const handleSave = async () => {
    setSaveError('');
    // Credentials go through the saveEmailAccount backend function, which
    // encrypts the password server-side. The browser never writes
    // password_encrypted directly.
    const { password, ...account } = form;
    try {
      const res = await base44.functions.invoke('saveEmailAccount', { account, password });
      const data = res?.data ?? res;
      if (!data?.success) throw new Error(data?.error || 'Save failed');
      const created = data.account;
      // Auto-test connection
      if (created?.id) {
        try {
          await base44.functions.invoke('emailSyncWorker', { emailAccountId: created.id });
        } catch (err) {
          console.error('Auto-test failed:', err);
        }
      }
      setShowAdd(false);
      setForm({ label: '', email_address: '', provider: 'imap_smtp', imap_host: '', imap_port: 993, smtp_host: '', smtp_port: 587, username: '', password: '' });
      load();
    } catch (err) {
      setSaveError(err?.message || String(err));
    }
  };

  const handleTestConnection = async (accountId) => {
    setTesting(accountId);
    try {
      await base44.functions.invoke('emailSyncWorker', { emailAccountId: accountId });
      load();
    } catch (err) {
      console.error('Test failed:', err);
    }
    setTesting(null);
  };

  const handleDelete = async (id) => {
    await base44.entities.EmailAccount.delete(id);
    load();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Email Accounts</h3>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="w-3 h-3 mr-1" /> Add Account
        </Button>
      </div>

      {accounts.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">No accounts connected. Add one to start syncing emails.</p>
      )}

      <div className="space-y-2">
        {accounts.map(acc => (
          <div key={acc.id} className="flex items-center justify-between bg-secondary/50 rounded-lg px-3 py-2">
            <div className="flex items-center gap-2">
              {STATUS_ICON[acc.status] || STATUS_ICON.disconnected}
              <div>
                <p className="text-sm font-medium">{acc.label || acc.email_address}</p>
                <p className="text-xs text-muted-foreground">{acc.provider} · {acc.email_address}</p>
              </div>
            </div>
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => handleTestConnection(acc.id)}
                disabled={testing === acc.id}
                title="Test connection"
              >
                <RefreshCw className={`w-3 h-3 ${testing === acc.id ? 'animate-spin' : ''}`} />
              </Button>
              {(isAdmin || acc.owner_user_id === user?.id) && (
                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => handleDelete(acc.id)}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect Email Account</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1">
              <Label>Provider</Label>
              <Select value={form.provider} onValueChange={v => setForm(f => ({ ...f, provider: v }))}>
                <SelectTrigger className="bg-secondary border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gmail">Gmail (OAuth)</SelectItem>
                  <SelectItem value="outlook">Outlook (OAuth)</SelectItem>
                  <SelectItem value="imap_smtp">IMAP / SMTP</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {[
              { key: 'label', label: 'Account Label', placeholder: 'e.g. Main Agency Inbox' },
              { key: 'email_address', label: 'Email Address', placeholder: 'you@agency.com' },
              { key: 'username', label: 'Username / Login', placeholder: 'Usually your email' },
              { key: 'password', label: 'Password', placeholder: 'App password or account password', type: 'password' },
            ].map(({ key, label, placeholder, type }) => (
              <div key={key} className="space-y-1">
                <Label>{label}</Label>
                <Input type={type} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder} className="bg-secondary border-border" />
              </div>
            ))}
            {form.provider === 'imap_smtp' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>IMAP Host</Label>
                  <Input value={form.imap_host} onChange={e => setForm(f => ({ ...f, imap_host: e.target.value }))} placeholder="imap.gmail.com" className="bg-secondary border-border" />
                </div>
                <div className="space-y-1">
                  <Label>IMAP Port</Label>
                  <Input type="number" value={form.imap_port} onChange={e => setForm(f => ({ ...f, imap_port: Number(e.target.value) }))} className="bg-secondary border-border" />
                </div>
                <div className="space-y-1">
                  <Label>SMTP Host</Label>
                  <Input value={form.smtp_host} onChange={e => setForm(f => ({ ...f, smtp_host: e.target.value }))} placeholder="smtp.gmail.com" className="bg-secondary border-border" />
                </div>
                <div className="space-y-1">
                  <Label>SMTP Port</Label>
                  <Input type="number" value={form.smtp_port} onChange={e => setForm(f => ({ ...f, smtp_port: Number(e.target.value) }))} className="bg-secondary border-border" />
                </div>
              </div>
            )}
            {saveError && <p className="text-xs text-destructive">{saveError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={!form.email_address || !form.password}>Save Account</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
