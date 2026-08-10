import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * migrateEmailPasswords — one-shot migration: encrypt every plaintext
 * password sitting in EmailAccount.password_encrypted.
 *
 * Admin-only. Safe to re-run: already-encrypted values (enc:v1: prefix) are
 * skipped, so a partial run just picks up where it left off.
 *
 * Run once from the browser console while logged in as admin:
 *   await base44.functions.invoke('migrateEmailPasswords', {})
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    const isAdmin = user && (user.role === 'admin' || user?.data?.app_role === 'admin');
    if (!isAdmin) {
      return Response.json({ success: false, error: 'Forbidden — admin only' });
    }

    const svc = base44.asServiceRole.entities;
    const accounts = await svc.EmailAccount.list('-created_date', 500);

    let migrated = 0;
    let skipped = 0;
    let empty = 0;
    const errors: { id: string; error: string }[] = [];

    for (const acc of accounts || []) {
      const current = acc.password_encrypted;
      if (!current) { empty += 1; continue; }
      if (String(current).startsWith(PREFIX)) { skipped += 1; continue; }
      try {
        await svc.EmailAccount.update(acc.id, {
          password_encrypted: await encryptPassword(String(current)),
        });
        migrated += 1;
      } catch (err) {
        errors.push({ id: acc.id, error: (err as Error).message });
      }
    }

    return Response.json({
      success: errors.length === 0,
      migrated,
      already_encrypted: skipped,
      no_password: empty,
      errors,
    });
  } catch (error) {
    return Response.json({ success: false, error: (error as Error).message || String(error) });
  }
});
