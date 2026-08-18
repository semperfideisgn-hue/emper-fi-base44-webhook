import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * saveEmailAccount — the ONLY path that writes EmailAccount credentials.
 *
 * The browser posts account details plus the raw password over HTTPS; this
 * function encrypts the password (AES-GCM, key from the EMAIL_ENCRYPTION_KEY
 * secret) and stores the ciphertext in password_encrypted. The response never
 * includes the password field. UI code must stop calling
 * base44.entities.EmailAccount.create/update with passwords directly.
 *
 * Request body:
 *   { account: { label, email_address, provider, imap_host, imap_port,
 *                smtp_host, smtp_port, username, is_shared, notes, status },
 *     password?: string,          // required on create; omit on update to keep current
 *     accountId?: string }        // present = update, absent = create
 */

const PREFIX = 'enc:v1:';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function getKey(): Promise<CryptoKey> {
  const secret = Deno.env.get('EMAIL_ENCRYPTION_KEY') || '';
  if (!secret) throw new Error('EMAIL_ENCRYPTION_KEY secret not set — add it under Settings → Secrets.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptPassword(plain: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain))
  );
  return `${PREFIX}${b64(iv)}:${b64(ct)}`;
}

function sanitize(record: any) {
  if (!record) return record;
  const { password_encrypted: _omit, ...rest } = record;
  return rest;
}

const ALLOWED_FIELDS = [
  'label', 'email_address', 'provider', 'imap_host', 'imap_port',
  'smtp_host', 'smtp_port', 'username', 'is_shared', 'notes', 'status',
  'last_synced_at',
];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ success: false, error: 'Unauthorized — sign in required' });
    }

    const { account = {}, password, accountId } = await req.json();
    const svc = base44.asServiceRole.entities;
    const isAdmin = user.role === 'admin' || user?.data?.app_role === 'admin';

    const fields: Record<string, unknown> = {};
    for (const k of ALLOWED_FIELDS) {
      if (account[k] !== undefined) fields[k] = account[k];
    }

    if (accountId) {
      const existing = await svc.EmailAccount.get(accountId);
      if (!existing) {
        return Response.json({ success: false, error: 'Account not found' });
      }
      if (!isAdmin && existing.owner_user_id && existing.owner_user_id !== user.id) {
        return Response.json({ success: false, error: 'Forbidden — you may only edit your own email accounts' });
      }
      if (password) fields.password_encrypted = await encryptPassword(password);
      const updated = await svc.EmailAccount.update(accountId, fields);
      return Response.json({ success: true, account: sanitize(updated) });
    }

    if (!account.email_address) {
      return Response.json({ success: false, error: 'email_address is required' });
    }
    if (!password) {
      return Response.json({ success: false, error: 'password is required when creating an account' });
    }

    const created = await svc.EmailAccount.create({
      ...fields,
      provider: account.provider || 'imap_smtp',
      status: account.status || 'disconnected',
      owner_user_id: user.id,
      password_encrypted: await encryptPassword(password),
    });
    return Response.json({ success: true, account: sanitize(created) });
  } catch (error) {
    return Response.json({ success: false, error: (error as Error).message || String(error) });
  }
});
