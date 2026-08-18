# Email Hub fixes — complete replacement files

Fixes from the Email Hub audit. Each file below **fully replaces** the file at
the same path inside the Base44 app (Semper Fi Design Command Center). Paste
whole files — these are not diffs.

| File in this folder | Replaces (in Base44 app) | What changed |
|---|---|---|
| `base44/functions/emailSyncWorker/entry.ts` | `base44/functions/emailSyncWorker/entry.ts` | Outbound mail now goes over **SMTP (Dreamhost)** using each EmailAccount's own `smtp_host`/`smtp_port`/`username`/`password_encrypted` — SendGrid removed. New `send_email` action powers the Compose dialog. Ownership check fixed (`owner_user_id`, was the nonexistent `user_id`; `is_shared` now honored). Self-hosted open-tracking pixel injected into every outbound HTML email. IMAP receive path unchanged. |
| `base44/functions/trackEmailOpen/entry.ts` | `base44/functions/trackEmailOpen/entry.ts` | Now matches on `tracking_token` (the field the sender writes). Previously filtered on `tracking_id`, which nothing set — no open was ever recorded. |
| `src/components/email/ComposeEmailDialog.jsx` | `src/components/email/ComposeEmailDialog.jsx` | **Send actually sends.** Invokes `emailSyncWorker` with `action: 'send_email'` over the selected account's SMTP. Adds a From-account selector and surfaces send errors instead of always showing "Sent!". Previously it only created an EmailMessage record — no email left. |
| `base44/functions/saveEmailAccount/entry.ts` | *(new function)* | The only path that writes email-account credentials. Encrypts the password server-side (AES-GCM with the `EMAIL_ENCRYPTION_KEY` secret, `enc:v1:` prefix) and never returns the password field to the browser. |
| `base44/functions/migrateEmailPasswords/entry.ts` | *(new function, one-shot)* | Admin-only migration: encrypts every plaintext password already sitting in `EmailAccount.password_encrypted`. Safe to re-run — already-encrypted values are skipped. |
| `src/components/email/EmailAccountsPanel.jsx` | `src/components/email/EmailAccountsPanel.jsx` | Account save goes through `saveEmailAccount` instead of writing `password_encrypted` from the browser. Shows save errors. |
| `src/pages/EmailSearch.wizard-patch.md` | *(patch instructions)* | Two exact block swaps inside `EmailConnectionWizardDialog` in `EmailSearch.jsx` (~line 2580) — the file is too large for a whole-file paste. |

## Password security rollout (order matters)

1. Add the `EMAIL_ENCRYPTION_KEY` secret in Base44 (Settings → Secrets): a long
   random value, e.g. from `openssl rand -base64 32`. Do this FIRST — the new
   code refuses to save or migrate without it.
2. Paste the updated `emailSyncWorker`, then the new `saveEmailAccount` and
   `migrateEmailPasswords` functions, then the two UI changes. Sync and send
   keep working throughout: un-migrated plaintext passwords are used as-is
   until step 3 converts them.
3. Run the migration once while logged in as admin (browser console):
   `await base44.functions.invoke('migrateEmailPasswords', {})` — the response
   reports migrated/skipped counts. Re-running is harmless.
4. In the Base44 builder, if the entity editor offers a per-field visibility /
   RLS option on `EmailAccount.password_encrypted`, hide it from client reads —
   after these changes no UI needs the field. (Even without it, clients only
   ever see ciphertext now.)
5. Heads-up: passwords are no longer viewable anywhere after this. Forgotten
   password = re-enter it from the provider (e.g. Dreamhost panel).

## Setup notes

- Each `EmailAccount` used for sending needs `smtp_host` (`smtp.dreamhost.com`),
  `smtp_port` (587 or 465), `username`, and `password_encrypted` filled in.
  For Dreamhost, username is the full mailbox address.
- Optional Base44 secret `APP_PUBLIC_URL` overrides the tracking-pixel base URL
  (defaults to `https://semper-fi-flow.base44.app`).
- `SENDGRID_API_KEY` / `SENDGRID_*` secrets and the `sendgridEventWebhook`
  function are no longer used by these paths; the webhook function can be
  retired once nothing else references it.

## Still open from the audit (not in this batch)

- IMAP sync has no MIME decoding (base64/quoted-printable bodies store as
  garbage), caps at 20 messages, and leaves `body_html` empty.
- `EmailSearch.jsx` (~3,000 lines) duplicates account management that also
  lives in `EmailAccountsPanel` and still references the SendGrid send path
  in its campaign builder UI copy.
