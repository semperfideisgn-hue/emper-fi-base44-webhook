# Round 5 — triage fix, full-size email reader, custom domain sending

Three jobs. Apply after rounds 3 and 4.

> **This round changes one decision from round 4.** Round 4 moved the lead
> confirmation email to Base44's `Core.sendEmail`. You've since said you want
> mail sent from your own domain (`semperfidesign.app`), so Patch D below
> replaces that with an SMTP send from your own mailbox. If you have not yet
> applied round 4's Patch 1, skip it and apply Patch D instead. If you already
> applied it, Patch D replaces that block.

---

## Part 1 — Triage: stop scoring phishing as HIGH-priority prospects

There are **two** independent classifiers, and both are wrong about phishing.
Fixing only one leaves the bad badges on screen.

### Why it happens

`classifyEmail()` in `src/pages/EmailSearch.jsx:1621` scores on keyword hits:

```
base 30 + unread 15 + money-term 20 ("payment") + urgent-term 25 ("urgent"/"problem"/"help") = 90 → HIGH
```

Phishing mail is *engineered* to contain exactly those words, so it reliably
scores at the top and gets labelled "External / Prospect". The backend
`emailTriageAgent` has the matching problem: its category list has no phishing
option, so a scam lands in `new_client_inquiry` (priority **urgent**, 2-hour
due date) or `other`, and the agent drafts a polite reply to a criminal.

### Patch A — `src/pages/EmailSearch.jsx`, add a detector above `classifyEmail`

**FIND:**

```jsx
function classifyEmail(email, accounts = []) {
```

**REPLACE WITH:**

```jsx
// Brand-impersonation table: a claimed brand paired with the domains that are
// actually allowed to send as it.
const PHISH_BRANDS = [
  { name: 'american express', domains: ['americanexpress.com', 'aexp.com'] },
  { name: 'amex', domains: ['americanexpress.com', 'aexp.com'] },
  { name: 'paypal', domains: ['paypal.com'] },
  { name: 'apple', domains: ['apple.com', 'icloud.com'] },
  { name: 'microsoft', domains: ['microsoft.com', 'outlook.com'] },
  { name: 'amazon', domains: ['amazon.com'] },
  { name: 'netflix', domains: ['netflix.com'] },
  { name: 'chase', domains: ['chase.com'] },
  { name: 'wells fargo', domains: ['wellsfargo.com'] },
  { name: 'bank of america', domains: ['bankofamerica.com'] },
  { name: 'norton', domains: ['norton.com', 'nortonlifelock.com'] },
  { name: 'mcafee', domains: ['mcafee.com'] },
  { name: 'geek squad', domains: ['bestbuy.com', 'geeksquad.com'] },
];

const PHISH_BAIT = [
  'verify your account', 'validate your account', 'secure your account',
  'account has been compromised', 'temporary hold', 'unusual activity',
  'unusual auto-debit', 'confirm your identity', 'account has been suspended',
  'verify and validate', 'click below and follow the steps',
  'update your payment', 'your account will be closed', 'unauthorized withdrawal',
];

// Phishing is written to trip every urgency and money keyword in the scorer
// below, so without this check scam mail reliably ranks as HIGH "prospect".
function detectPhishing(email) {
  const from = lower(getSenderEmail(email));
  const fromName = lower(email?.from_name);
  const subject = lower(email?.subject);
  const body = lower(getEmailBody(email));
  const domain = getSenderDomain(email);
  const reasons = [];

  const claimed = `${fromName} ${from.split('@')[0]} ${subject}`;
  for (const brand of PHISH_BRANDS) {
    if (claimed.includes(brand.name)) {
      const legit = brand.domains.some((d) => domain === d || domain.endsWith(`.${d}`));
      if (!legit) {
        reasons.push(`Claims to be ${brand.name} but was sent from ${domain || 'an unknown domain'}`);
        break;
      }
    }
  }

  const bait = PHISH_BAIT.filter((p) => body.includes(p) || subject.includes(p));
  if (bait.length) reasons.push(`Credential-harvesting language ("${bait[0]}")`);

  if (/www-[a-z0-9]+\.[a-z0-9.-]*(verify|secure|account|login|update)/i.test(body)) {
    reasons.push('Contains a lookalike verification link');
  }

  const suspicious = reasons.length >= 2 || (reasons.length === 1 && bait.length >= 2);
  return { suspicious, reasons };
}

function classifyEmail(email, accounts = []) {
```

### Patch B — same file, hard-stop suspicious mail before scoring

**FIND:**

```jsx
  const priority = score >= 75 ? 'high' : score >= 50 ? 'medium' : 'normal';
  const label = isClient ? 'Client' : isInternal ? 'Internal' : 'External / Prospect';
```

**REPLACE WITH:**

```jsx
  // Phishing check overrides the keyword score entirely — it cannot be allowed
  // to surface as a high-priority prospect just because it says "urgent".
  const phishing = detectPhishing(email);
  if (phishing.suspicious) {
    return {
      score: 0,
      priority: 'normal',
      label: 'Suspicious / Phishing',
      nextMove: 'Do not click any links. Delete, or report to the spoofed brand.',
      isClient: false,
      isInternal: false,
      isUnread,
      phishing: true,
      phishingReasons: phishing.reasons,
    };
  }

  const priority = score >= 75 ? 'high' : score >= 50 ? 'medium' : 'normal';
  const label = isClient ? 'Client' : isInternal ? 'Internal' : 'External / Prospect';
```

Also update the return at the end of `classifyEmail` so the shape stays
consistent — add `phishing: false, phishingReasons: []` to the returned object.

### Patch C — `base44/functions/emailTriageAgent/entry.ts`

**C1. Add the category.** In the `CATEGORIES` object, insert before `other`:

```ts
  phishing_scam: {
    label: 'Phishing / scam',
    due_hours: null,
    priority: 'low',
    task_prefix: null,
  },
```

`due_hours: null` and `task_prefix: null` mean no Task is created — matching
how `spam_marketing` is already handled.

**C2. Teach the prompt.** In `classifyAndDraft`, add to the CATEGORIES list in
the prompt string, above `- spam_marketing`:

```
- phishing_scam: Impersonates a bank, card issuer, retailer or tech company to harvest credentials or payment details. Signals: sender domain does not match the brand it claims to be; urgent threats about accounts being compromised, held or debited; instructions to "verify", "validate" or "secure" an account; lookalike links.
```

And add to the DRAFT REPLY RULES:

```
- If phishing_scam or spam_marketing: reply_draft MUST be an empty string "" and is_urgent MUST be false. Never draft a reply to a suspected scam.
- Urgency in the message itself is NOT evidence of importance — scams manufacture urgency. Judge is_urgent on whether a real client or real money is genuinely waiting on the owner.
```

**C3. Belt and braces — never trust the model on this one.** Immediately after
the category is resolved in `classifyAndDraft`:

**FIND:**

```ts
    const category = (parsed.category in CATEGORIES ? parsed.category : 'other') as CategoryKey;

    return {
      category,
      summary:     String(parsed.summary     || ''),
      reply_draft: String(parsed.reply_draft || ''),
      is_urgent:   Boolean(parsed.is_urgent),
    };
```

**REPLACE WITH:**

```ts
    const category = (parsed.category in CATEGORIES ? parsed.category : 'other') as CategoryKey;

    // Enforced in code, not left to the model: a scam never produces a reply
    // draft and never counts as urgent, whichever way it was classified.
    const isJunk = category === 'phishing_scam' || category === 'spam_marketing';

    return {
      category,
      summary:     String(parsed.summary     || ''),
      reply_draft: isJunk ? '' : String(parsed.reply_draft || ''),
      is_urgent:   isJunk ? false : Boolean(parsed.is_urgent),
    };
```

---

## Part 2 — Full-size email reader (`EmailReaderDialog.jsx`)

Today the reader is a side panel that renders `body_text` inside a `<pre>` —
narrow, and it never renders HTML. The new component in this folder opens a
large dialog (96vw × 92vh) usable from **every** list: Inbox, Sent, Drafts, the
client-filtered panel, and the lead/prospect views.

What it does beyond being bigger:
- Renders `body_html` sanitized with DOMPurify (already a dependency), with a
  one-click **Formatted / Plain text** toggle.
- **Blocks remote images by default.** Loading them confirms your address to
  the sender and fires their tracking pixels, so it takes a deliberate click.
- Shows the phishing banner and disables links on suspicious mail.
- Lists attachments; keeps Reply / Forward / Create Follow-Up.

Note it only shows formatted bodies for mail synced **after** round 3's MIME
fix — that's what starts populating `body_html`.

### Wiring

1. Save `EmailReaderDialog.jsx` to `src/components/email/EmailReaderDialog.jsx`.
2. In `src/pages/EmailSearch.jsx`, add the import at the top:

```jsx
import EmailReaderDialog from '@/components/email/EmailReaderDialog';
```

3. Next to the existing `const [selectedEmailId, setSelectedEmailId] = useState(null);`
   (~line 3006) add:

```jsx
  const [readerEmail, setReaderEmail] = useState(null);
```

4. Add a single handler near the other handlers — used by every list:

```jsx
  // One entry point so an email opens the same way from every list in the hub.
  const openEmailReader = (emailOrId) => {
    const record = typeof emailOrId === 'string'
      ? emails.find((e) => e.id === emailOrId) || null
      : emailOrId;
    if (!record) return;
    setSelectedEmailId(record.id);
    setReaderEmail(record);
  };
```

5. Point the lists at it. Replace `onSelect={setSelectedEmailId}` (line ~3790)
   and `onSelectEmail={setSelectedEmailId}` (line ~3718) with
   `onSelect={openEmailReader}` / `onSelectEmail={openEmailReader}`
   respectively. Do the same for any other list that selects an email
   (client panel, prospect views) so behaviour is identical everywhere.

6. Render the dialog once, just before the closing tag of the page component
   (alongside the other modals near the end of the file):

```jsx
      <EmailReaderDialog
        email={readerEmail}
        open={Boolean(readerEmail)}
        onOpenChange={(v) => { if (!v) setReaderEmail(null); }}
        onReply={(e) => { setReaderEmail(null); handleReply(e); }}
        onForward={(e) => { setReaderEmail(null); handleForward(e); }}
        onCreateTask={(e) => { setReaderEmail(null); handleCreateTask(e); }}
      />
```

The existing side `EmailReaderPanel` can stay as the quick-preview pane — the
dialog is additive, so nothing that works today breaks.

---

## Part 3 — Send from `semperfidesign.app`

### Patch D — one-time setup (do this first, it's DNS)

1. In the **Dreamhost panel**, add `semperfidesign.app` as a hosted domain (if
   it isn't already) and create a real mailbox on it — e.g.
   `hello@semperfidesign.app`. A real mailbox matters: Dreamhost authenticates
   the SMTP session as that user.
2. Turn on **DKIM** for `semperfidesign.app` in the Dreamhost panel, and
   confirm the **SPF** record exists on that domain. Without both, mail sent as
   `@semperfidesign.app` fails alignment and lands in spam.
3. Add a **DMARC** record if the domain has none — start permissive:
   `v=DMARC1; p=none; rua=mailto:chris@semperfi.design`
4. In the Email Hub, add that mailbox as a second email account
   (`smtp.dreamhost.com`, port 587, username = the full address). Label it
   clearly, e.g. **System Sender**.
5. Copy its record id and save it as a Base44 secret:
   `SYSTEM_EMAIL_ACCOUNT_ID`.

**Why a separate mailbox rather than just changing the From address:** SMTP
authenticates as one mailbox. Sending `From: hello@semperfidesign.app` while
authenticated as `chris@semperfi.design` breaks SPF/DKIM alignment on the
`semperfidesign.app` domain and gets the mail spam-foldered — the exact problem
the original SendGrid comment was written to avoid.

### Patch E — `leadCaptureWebhook` sends over your own domain

File: `base44/functions/leadCaptureWebhook/entry.ts`

Add to the imports at the top:

```ts
import nodemailer from 'npm:nodemailer@6.9.14';
```

Add these helpers above `Deno.serve` (same decrypt contract as
`emailSyncWorker` — passwords are stored `enc:v1:` encrypted):

```ts
const ENC_PREFIX = 'enc:v1:';

async function decryptPassword(stored: string): Promise<string> {
  if (!stored || !stored.startsWith(ENC_PREFIX)) return stored;
  const [ivB64, ctB64] = stored.slice(ENC_PREFIX.length).split(':');
  if (!ivB64 || !ctB64) throw new Error('Stored password is malformed.');
  const secret = Deno.env.get('EMAIL_ENCRYPTION_KEY') || '';
  if (!secret) throw new Error('EMAIL_ENCRYPTION_KEY secret not set.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['decrypt']);
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

// Sends as the designated system mailbox (SYSTEM_EMAIL_ACCOUNT_ID), so lead
// receipts come from our own authenticated domain rather than a third party.
async function sendFromSystemMailbox(sr: any, to: string, subject: string, text: string) {
  const accountId = Deno.env.get('SYSTEM_EMAIL_ACCOUNT_ID') || '';
  const account = accountId
    ? await sr.entities.EmailAccount.get(accountId).catch(() => null)
    : null;
  if (!account?.smtp_host || !account?.password_encrypted) {
    throw new Error('System email account not configured — set SYSTEM_EMAIL_ACCOUNT_ID.');
  }
  const port = Number(account.smtp_port || 587);
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port,
    secure: port === 465,
    auth: {
      user: account.username || account.email_address,
      pass: await decryptPassword(account.password_encrypted),
    },
  });
  await transporter.sendMail({
    from: `"${account.label || 'Semper Fi Design'}" <${account.email_address}>`,
    to,
    subject,
    text,
  });
}
```

Then replace the confirmation-email block (the SendGrid block from round 4's
Patch 1, or the `Core.sendEmail` version if you already applied it) with:

```ts
    // ── Confirmation email to the submitter ───────────────────────────────
    // Sent over our own authenticated domain via the system mailbox.
    // Deliberately NOT Elementor/wp_mail: WordPress mail leaves the web host
    // with no SPF/DKIM alignment. A failure here must never fail the capture —
    // the Lead record is the system of record, this is a courtesy receipt.
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

      await sendFromSystemMailbox(sr, email, 'We got your request — Semper Fi Design', plain)
        .catch((e) => {
          console.error('[leadCaptureWebhook] confirmation email failed:', e.message);
          return null;
        });
    }
```

---

## Verify

1. **Triage** — the two spoofed American Express messages show
   **Suspicious / Phishing**, not HIGH / prospect. Run the triage agent: no
   Task and no reply draft is created for them.
2. **Reader** — click any email in Inbox, Sent, Drafts and the client panel:
   the large reader opens each time. HTML mail renders; images stay blocked
   until you click Load images; phishing shows the red banner with links dead.
3. **Domain** — submit a test lead form. The receipt arrives from
   `@semperfidesign.app`, lands in the inbox rather than spam, and passes
   SPF/DKIM (check "show original" in Gmail).

## Worth flagging

`semperfidesign.app` is a third domain alongside `semperfi.design` (your
mailbox) and `semperfidesign.com`. Sending from one domain while your reply-to
and website live on another confuses recipients and mail filters alike. Once
this works, it's worth consciously picking **one** sending domain and putting
the DKIM/SPF/DMARC effort into that one only.
