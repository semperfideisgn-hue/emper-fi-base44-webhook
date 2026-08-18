# Round 4 — retire SendGrid completely

## What SendGrid is actually still doing (verified 2026-08-13)

Exactly **one** live thing: `leadCaptureWebhook` sends a courtesy confirmation
email ("We got your request — Semper Fi Design") to someone who submits a lead
form. It fires only when both `SENDGRID_API_KEY` and `SENDGRID_FROM_EMAIL`
secrets are set, and it is wrapped in `.catch()` so a failure is silent.

Everything else that mentions SendGrid is dead or stale:

| Place | State |
|---|---|
| `emailSyncWorker` | **Migrated to Dreamhost SMTP.** No SendGrid left. |
| `sendgridEventWebhook` | **Dead.** Matches events by `tracking_token`; nothing sends with that custom_arg any more. |
| `EmailSearch.jsx` (6 spots) | **Stale UI copy** — still tells you sends go through SendGrid and to add `SENDGRID_API_KEY`. Both untrue since the SMTP migration. |
| `EmailMessage.jsonc` field descriptions | Stale wording only, harmless. |
| `docs/internal/*` | Stale status notes ("SENDGRID_SANDBOX_MODE must be false"). |

Note the app has a **third** email path already: Base44's built-in
`integrations.Core.sendEmail`, used by `billingDunningSweep`,
`sendApprovedEmail`, `notifyDeliverableShared`, `bannerRequestAction`,
`dropboxSyncClientFiles` and others. That is the app's de facto transactional
sender, and it needs no credentials.

So today there are three senders. After this round there are two: **Dreamhost
SMTP** for anything you compose or campaign, **Core.sendEmail** for automated
system notices.

---

## Patch 1 — `leadCaptureWebhook`: move the confirmation off SendGrid

File: `base44/functions/leadCaptureWebhook/entry.ts`

**FIND** (the whole SendGrid block, ~line 405–447):

```ts
    // ── Confirmation email to the submitter, via SendGrid ─────────────────
```
…through the closing…
```ts
      }).catch((e) => { console.error('[leadCaptureWebhook] confirmation email failed:', e.message); return null; });
    }
```

**REPLACE WITH:**

```ts
    // ── Confirmation email to the submitter ───────────────────────────────
    // Deliberately NOT Elementor/wp_mail: WordPress mail leaves the web host
    // with no SPF/DKIM alignment, so it lands in spam or is dropped with no
    // log. Uses the platform's transactional sender — the same path
    // billingDunningSweep, sendApprovedEmail and notifyDeliverableShared
    // already use — so no third-party key is required. A failure here must
    // never fail the capture: the Lead record is the system of record, this
    // is a courtesy receipt.
    if (email && !existingLead) {
      const firstName = first_name && first_name !== 'Unknown' ? first_name : 'there';
      const plain = [
        `Hi ${firstName},`,
        '',
        'Thanks for reaching out to Semper Fi Design — we have your request and a real person will get back to you within one business day.',
        '',
        service_raw ? `You asked about: ${service_raw}` : '',
        message ? `What you told us: ${message}` : '',
        '',
        'If anything else comes to mind, just reply to this email — it reaches us directly.',
        '',
        'Semper Fi,',
        'Chris Nobles',
        'Semper Fi Design',
      ].filter(Boolean).join('\n');

      await sr.integrations.Core.sendEmail({
        to: email,
        subject: 'We got your request — Semper Fi Design',
        body: plain,
      }).catch((e) => {
        console.error('[leadCaptureWebhook] confirmation email failed:', e.message);
        return null;
      });
    }
```

(`sr` is the service-role client already in scope in this function.)

## Patch 2 — delete the dead webhook

Delete the function `sendgridEventWebhook` (the whole
`base44/functions/sendgridEventWebhook/` directory).

Safe because: it only reacts to SendGrid delivery events, and after Patch 1
nothing in the app calls SendGrid at all. Even today it is inert — the one
remaining SendGrid send never passed a `tracking_token` custom_arg, so every
event it received was skipped.

If a SendGrid Event Webhook is still registered in the SendGrid dashboard
pointing at this URL, remove it there too so SendGrid stops retrying a 404.

## Patch 3 — fix the lying UI copy in `src/pages/EmailSearch.jsx`

Six strings still tell you sends go through SendGrid. Update the wording only —
no logic changes:

| Line | Change |
|---|---|
| 1099 | comment: "Real campaign metrics from SendGrid tracking" → "from open-tracking pixel hits recorded by trackEmailOpen" |
| 1114 | log text: "Metrics refreshed from SendGrid tracking" → "Metrics refreshed from open tracking" |
| 1195 | note: drop the "requires a future SMTP/send backend function … send through SendGrid" sentence — sending works now, over Dreamhost SMTP |
| 1307–1308 | remove the SANDBOX MODE branch; success text → `Sent via SMTP. Delivered: ${sentCount}. Failed: ${failedCount}.` |
| 1406 | "Opens & clicks come from SendGrid tracking" → "Opens come from the tracking pixel and arrive over time" |
| 1593 | replace the whole "Live send: not active … add SENDGRID_API_KEY" callout — live send is active over Dreamhost SMTP; no key needed |
| 4199 | "Send Now uses emailSyncWorker → SendGrid" → "Send Now uses emailSyncWorker → Dreamhost SMTP" |

## Patch 4 — remove the now-unused secrets

After Patches 1–3, delete these from Base44 → Settings → Secrets:
`SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`,
`SENDGRID_REPLY_TO`, `SENDGRID_SANDBOX_MODE`, `SENDGRID_WEBHOOK_TOKEN`.

Then cancel the SendGrid account itself if nothing else uses it.

## Verify

1. Submit a test lead form → Lead record created **and** the confirmation email
   arrives (check spam on the first one).
2. Email Hub → Send Now on a campaign → still delivers; the result banner says
   SMTP, not SendGrid.
3. Nowhere in the hub UI mentions SendGrid or asks for an API key.

## One judgement call to make

`Core.sendEmail` sends from Base44's own infrastructure, so the confirmation
may not come from `chris@semperfi.design`. If you want lead receipts to come
from your own domain, the alternative is to send it over Dreamhost SMTP
instead — that needs a shared SMTP helper, since `emailSyncWorker` requires a
signed-in user and this webhook is public. Worth doing only if the from-address
matters to you; say so and it's a small follow-up.
