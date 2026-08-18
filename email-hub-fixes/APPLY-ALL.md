# Email Hub — complete apply guide

Everything outstanding, in order. Repo:
`semperfideisgn-hue/emper-fi-base44-webhook`, branch
`claude/email-marketing-command-center-n1q0oo`.

**Deliberately split into four editor prompts rather than one.** A single
mega-prompt across ~15 edits in 5 files is how the builder AI ends up
half-applying things and inventing the rest. Run them in order and check
between.

## Already done — do not redo

- SMTP send (Dreamhost), password encryption + migration, `saveEmailAccount`,
  fixed ownership check, `trackEmailOpen` on `tracking_token`
- The `Activity` entity exists; the Client Timeline works

## Files to ignore

- `round2-sync-refresh.md` — superseded by round 3
- `round4-retire-sendgrid.md` **Patch 1** — superseded by round 5 Patch E
  (everything else in round 4 still applies)
- `phase-1-activity/Activity.entity.json` — superseded by the live schema

---

## Step 1 — DNS and mailbox (you, before any code)

In the Dreamhost panel:

1. Add `semperfidesign.app` as a hosted domain if it isn't already.
2. Create a real mailbox on it, e.g. `hello@semperfidesign.app`.
3. Enable **DKIM** for that domain; confirm an **SPF** record exists.
4. Add **DMARC** if missing: `v=DMARC1; p=none; rua=mailto:chris@semperfi.design`

Then in the Command Center:

5. Email Hub → add that mailbox as an account (`smtp.dreamhost.com`, port 587,
   username = full address). Label it **System Sender**.
6. Copy its record id → Base44 → Settings → Secrets →
   `SYSTEM_EMAIL_ACCOUNT_ID`.

DNS can take up to an hour to propagate. Steps 2 and 3 don't depend on it.

---

## Step 2 — Editor prompt A: sync worker (round 3)

> Apply the five patches in `email-hub-fixes/round3-complete.md` from the
> GitHub repo semperfideisgn-hue/emper-fi-base44-webhook, branch
> `claude/email-marketing-command-center-n1q0oo`, to
> `base44/functions/emailSyncWorker/entry.ts`. They are exact FIND/REPLACE
> blocks: (1a) add the MIME decoding helpers after `extractEmailName`,
> (1b) normalize the Date header to ISO and decode the body via
> `parseMimeBody`, (1c) store `body_html` instead of an empty string,
> (1d) change `.slice(-5)` to `.slice(-20)`, (1e) write
> `status: 'connected'` + `last_synced_at` to the EmailAccount via service
> role after a successful sync and `status: 'error'` on failure, both in
> try/catch. Apply exactly as written. Do not restructure the function, do not
> touch the IMAP logic, do not change anything else.

**Check before moving on:** Email Hub → Sync. The badge should flip to
**connected**, newest mail should be at the top, and opening a message should
show readable text instead of `=\r\n` and `&nbsp;`.

---

## Step 3 — Editor prompt B: hub page fixes (rounds 3 + 4)

> In `src/pages/EmailSearch.jsx`, apply Patch 2 (2a, 2b, 2c) from
> `email-hub-fixes/round3-complete.md` in the GitHub repo
> semperfideisgn-hue/emper-fi-base44-webhook, branch
> `claude/email-marketing-command-center-n1q0oo`: hold the signed-in user in a
> local `currentUser` variable, re-read EmailAccount after syncing, sort
> messages in JS by parsed `received_at` with a `created_date` fallback, and
> use `currentUser` for the `isAdminUser` check.
>
> Then apply Patch 3 from `email-hub-fixes/round4-retire-sendgrid.md` — the
> seven stale SendGrid strings in the same file (lines ~1099, 1114, 1195,
> 1307-1308, 1406, 1593, 4199). Those are copy-only changes: sending goes
> through Dreamhost SMTP now, there is no SendGrid key and no sandbox mode.
> Do not change any logic in Patch 3.

---

## Step 4 — Editor prompt C: triage + reader (round 5, parts 1 and 2)

> Apply Part 1 and Part 2 of `email-hub-fixes/round5/README.md` from the GitHub
> repo semperfideisgn-hue/emper-fi-base44-webhook, branch
> `claude/email-marketing-command-center-n1q0oo`.
>
> Part 1 — phishing triage. In `src/pages/EmailSearch.jsx` add the
> `PHISH_BRANDS`, `PHISH_BAIT` and `detectPhishing` definitions immediately
> above `classifyEmail`, and make `classifyEmail` return the
> "Suspicious / Phishing" result before it computes the keyword priority (add
> `phishing: false, phishingReasons: []` to the normal return too). In
> `base44/functions/emailTriageAgent/entry.ts` add the `phishing_scam` category
> to CATEGORIES with `due_hours: null` and `task_prefix: null`, add the
> phishing category description and the two extra draft rules to the prompt,
> and enforce in code that `phishing_scam` and `spam_marketing` always produce
> an empty `reply_draft` and `is_urgent: false`.
>
> Part 2 — email reader. Create
> `src/components/email/EmailReaderDialog.jsx` with the exact contents of
> `email-hub-fixes/round5/EmailReaderDialog.jsx` from that repo. Then wire it
> into `src/pages/EmailSearch.jsx` per the six wiring steps: import it, add a
> `readerEmail` state, add the `openEmailReader` handler, point
> `onSelect`/`onSelectEmail` at it in every email list (inbox list, the
> `onSelectEmail` at ~line 3718, and the client/prospect panels), and render
> `<EmailReaderDialog>` once near the other modals at the end of the component.
> Keep the existing `EmailReaderPanel` side pane as-is.

**Check:** click an email anywhere → the big reader opens. The two spoofed
American Express messages read **Suspicious / Phishing**, not HIGH.

---

## Step 5 — Editor prompt D: custom domain + SendGrid removal (rounds 4 + 5)

Only after Step 1's DNS has propagated and `SYSTEM_EMAIL_ACCOUNT_ID` is saved.

> Apply Part 3 (Patch E) of `email-hub-fixes/round5/README.md` from the GitHub
> repo semperfideisgn-hue/emper-fi-base44-webhook, branch
> `claude/email-marketing-command-center-n1q0oo`, to
> `base44/functions/leadCaptureWebhook/entry.ts`: add the nodemailer import,
> add the `decryptPassword` and `sendFromSystemMailbox` helpers above
> `Deno.serve`, and replace the existing SendGrid confirmation-email block with
> the `sendFromSystemMailbox` version. Do NOT apply Patch 1 of round4 — this
> replaces it.
>
> Then delete the `base44/functions/sendgridEventWebhook/` function entirely
> (round 4 Patch 2). It is dead code: nothing sends through SendGrid after this
> change, and it only ever reacted to SendGrid delivery events.

---

## Step 6 — Cleanup (you)

Once Step 5 verifies:

- Base44 → Settings → Secrets → delete `SENDGRID_API_KEY`,
  `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `SENDGRID_REPLY_TO`,
  `SENDGRID_SANDBOX_MODE`, `SENDGRID_WEBHOOK_TOKEN`.
- SendGrid dashboard → remove the Event Webhook pointing at the deleted
  function, then cancel the account if nothing else uses it.

---

## Final verification checklist

| # | Test | Expected |
|---|---|---|
| 1 | Email Hub → Sync | Badge flips to **connected**, fresh timestamp, no page reload |
| 2 | Inbox order | Newest mail at the top |
| 3 | Open a message synced after the fix | Readable text; **Formatted** view renders HTML |
| 4 | Click an email in Inbox / Sent / Drafts / client panel | Large reader opens every time |
| 5 | Open a spoofed Amex message | Red phishing banner, links dead, images blocked |
| 6 | Inbox badges | Those messages show **Suspicious / Phishing**, not HIGH |
| 7 | Run `emailTriageAgent` | No Task and no reply draft for the phishing messages |
| 8 | Compose → send yourself mail | Arrives; appears at top of Sent |
| 9 | Submit a test lead form | Lead created **and** receipt arrives from `@semperfidesign.app` |
| 10 | Gmail → "Show original" on that receipt | SPF **pass**, DKIM **pass** |
| 11 | Search the hub UI for "SendGrid" | No matches |

If any step fails, report the exact error rather than letting the builder AI
improvise a fix — several of these patches depend on each other.

## Still open after this

- Phase 1 timeline feeders (`phase-1-activity/feeder-patches.md`) — the
  Activity entity and UI already work; these just auto-file sent mail and
  website inquiries onto the client timeline.
- Merge PR #1 (the standalone email marketing module in the webhook repo).
- Pick one sending domain long-term: `semperfi.design`,
  `semperfidesign.com`, and now `semperfidesign.app` are three identities to
  authenticate and explain.
