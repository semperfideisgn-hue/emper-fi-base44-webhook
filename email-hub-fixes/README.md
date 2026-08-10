# Email Hub fixes — complete replacement files

Fixes from the Email Hub audit. Each file below **fully replaces** the file at
the same path inside the Base44 app (Semper Fi Design Command Center). Paste
whole files — these are not diffs.

| File in this folder | Replaces (in Base44 app) | What changed |
|---|---|---|
| `base44/functions/emailSyncWorker/entry.ts` | `base44/functions/emailSyncWorker/entry.ts` | Outbound mail now goes over **SMTP (Dreamhost)** using each EmailAccount's own `smtp_host`/`smtp_port`/`username`/`password_encrypted` — SendGrid removed. New `send_email` action powers the Compose dialog. Ownership check fixed (`owner_user_id`, was the nonexistent `user_id`; `is_shared` now honored). Self-hosted open-tracking pixel injected into every outbound HTML email. IMAP receive path unchanged. |
| `base44/functions/trackEmailOpen/entry.ts` | `base44/functions/trackEmailOpen/entry.ts` | Now matches on `tracking_token` (the field the sender writes). Previously filtered on `tracking_id`, which nothing set — no open was ever recorded. |
| `src/components/email/ComposeEmailDialog.jsx` | `src/components/email/ComposeEmailDialog.jsx` | **Send actually sends.** Invokes `emailSyncWorker` with `action: 'send_email'` over the selected account's SMTP. Adds a From-account selector and surfaces send errors instead of always showing "Sent!". Previously it only created an EmailMessage record — no email left. |

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

- Passwords are stored in plaintext in `EmailAccount.password_encrypted` and
  written from the browser. Next step: write/verify passwords only via a
  backend function and stop returning the field to the client.
- IMAP sync has no MIME decoding (base64/quoted-printable bodies store as
  garbage), caps at 20 messages, and leaves `body_html` empty.
- `EmailSearch.jsx` (~3,000 lines) duplicates account management that also
  lives in `EmailAccountsPanel` and still references the SendGrid send path
  in its campaign builder UI copy.
