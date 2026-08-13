# Email Hub round 3 — complete fix set

**This document supersedes `round2-sync-refresh.md`** — it includes those two
fixes plus the remaining defects, consolidated so the patches don't collide on
the same code blocks. Apply this file only.

Verified against live app data on 2026-08-13.

## What's already working (verified, no action needed)

- Password encryption — the account's `password_encrypted` carries the
  `enc:v1:` prefix.
- Inbound IMAP sync — 4 messages pulled from Dreamhost at 15:39.
- Outbound SMTP send — test emails sent 15:42 and 15:43.

## Defects fixed here

| # | Defect | Symptom |
|---|---|---|
| 1 | `received_at` stores the raw RFC 2822 header; the hub sorts it as a string | New mail scatters mid-list — looks like "it didn't refresh" |
| 2 | Only the connection wizard ever writes `status: 'connected'` | Badge stays "disconnected" after a successful hub sync |
| 3 | Hub never re-reads accounts after syncing | Badge/timestamp stale until a full page reload |
| 4 | No MIME decoding — bodies stored raw, `body_html` always empty | Messages read as `=\r\n` / `&nbsp;` / `=A9` garbage |
| 5 | `isAdminUser(user)` reads state set moments earlier in the same call | Client list empty on first page load |
| 6 | No-unseen fallback fetches only the last 5 messages | Sparse hub on a caught-up inbox |

---

## Patch 1 — `base44/functions/emailSyncWorker/entry.ts`

### 1a. Add MIME decoding helpers

**FIND** (the existing helper, near the bottom of the module):

```ts
function extractEmailName(addressStr) {
  if (!addressStr) return '';
  const match = addressStr.match(/^([^<]+)</);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
}
```

**REPLACE WITH:**

```ts
function extractEmailName(addressStr) {
  if (!addressStr) return '';
  const match = addressStr.match(/^([^<]+)</);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
}

// ── MIME decoding ─────────────────────────────────────────────────────────────
// Mail bodies arrive quoted-printable or base64 encoded, usually inside a
// multipart container. The previous code stored the raw body and stripped tags
// with a regex, which left "=\r\n" soft breaks, "=A9" escapes and &nbsp;
// entities throughout the hub, and never populated body_html at all.

function decodeQuotedPrintable(input) {
  const joined = String(input).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.substr(i + 1, 2))) {
      bytes.push(parseInt(joined.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return joined;
  }
}

function decodeBase64Body(input) {
  try {
    const clean = String(input).replace(/[^A-Za-z0-9+/=]/g, '');
    if (!clean) return '';
    const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return String(input);
  }
}

function decodeTransferEncoding(raw, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc.includes('quoted-printable')) return decodeQuotedPrintable(raw);
  if (enc.includes('base64')) return decodeBase64Body(raw);
  return String(raw);
}

function htmlToPlainText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Returns { text, html } for a message or message part. Recurses through
// nested multiparts (multipart/mixed wrapping multipart/alternative is common).
function parseMimeBody(msgHeaders, bodyRaw, depth = 0) {
  const contentType = msgHeaders['content-type'] || '';
  const encoding = msgHeaders['content-transfer-encoding'] || '';
  const boundaryMatch = contentType.match(/boundary="?([^";\r\n]+)"?/i);

  if (!boundaryMatch || depth > 4) {
    const decoded = decodeTransferEncoding(bodyRaw, encoding);
    if (/text\/html/i.test(contentType)) {
      return { text: htmlToPlainText(decoded), html: decoded };
    }
    return { text: decoded, html: '' };
  }

  const boundary = boundaryMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = String(bodyRaw).split(new RegExp(`--${boundary}(?:--)?\r?\n`));

  let text = '';
  let html = '';

  for (const part of parts) {
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const partHeaders = parseHeaders(part.slice(0, sep));
    const partBody = part.slice(sep + 4);
    const partType = partHeaders['content-type'] || '';

    if (/multipart\//i.test(partType)) {
      const nested = parseMimeBody(partHeaders, partBody, depth + 1);
      if (!text && nested.text) text = nested.text;
      if (!html && nested.html) html = nested.html;
      continue;
    }
    if (/text\/plain/i.test(partType) && !text) {
      text = decodeTransferEncoding(partBody, partHeaders['content-transfer-encoding']);
    } else if (/text\/html/i.test(partType) && !html) {
      html = decodeTransferEncoding(partBody, partHeaders['content-transfer-encoding']);
    }
  }

  if (!text && html) text = htmlToPlainText(html);
  return { text: (text || '').trim(), html: (html || '').trim() };
}
```

### 1b. Normalize the date and decode the body

**FIND:**

```ts
        const dateStr = headers['date'] || new Date().toISOString();
        const fromAddr = extractEmailAddress(fromRaw);
        const fromName = extractEmailName(fromRaw);
        const bodyText = bodyRaw.replace(/<[^>]*>/g, '').substring(0, 5000);
```

**REPLACE WITH:**

```ts
        // Normalize the RFC 2822 header date to ISO. Storing the raw header
        // mixed ISO and "Mon, 5 Jan 2026 20:08:26 +0000" in one field, so the
        // hub's '-received_at' sort compared them as plain strings and buried
        // freshly synced mail mid-list.
        const rawDateStr = headers['date'] || '';
        const parsedDate = rawDateStr ? new Date(rawDateStr) : null;
        const dateStr = parsedDate && !isNaN(parsedDate.getTime())
          ? parsedDate.toISOString()
          : new Date().toISOString();
        const fromAddr = extractEmailAddress(fromRaw);
        const fromName = extractEmailName(fromRaw);
        const parsedBody = parseMimeBody(headers, bodyRaw);
        const bodyText = (parsedBody.text || '').substring(0, 5000);
        const bodyHtml = (parsedBody.html || '').substring(0, 100000);
```

### 1c. Store the decoded HTML

**FIND:**

```ts
          body_text: bodyText,
          body_html: '',
          received_at: dateStr,
          direction: 'inbound',
```

**REPLACE WITH:**

```ts
          body_text: bodyText,
          body_html: bodyHtml,
          received_at: dateStr,
          direction: 'inbound',
```

### 1d. Fetch more than 5 messages when nothing is unread

**FIND:**

```ts
              uids = match[1].trim().split(/\s+/).filter(u => /^\d+$/.test(u)).slice(-5);
```

**REPLACE WITH:**

```ts
              uids = match[1].trim().split(/\s+/).filter(u => /^\d+$/.test(u)).slice(-20);
```

### 1e. Record the sync outcome on the account (server-side truth)

**FIND:**

```ts
    result.logs.push(`Sync completed: ${result.emailsCreated} created, ${result.duplicatesSkipped} skipped, ${result.errorCount} errors`);
    return Response.json({ success: true, ...result });

  } catch (error) {
    result.error = error.message;
    result.errorStack = error.stack;
    result.logs.push(`FAILED: ${error.message}`);
    return Response.json({ success: false, ...result });
```

**REPLACE WITH:**

```ts
    result.logs.push(`Sync completed: ${result.emailsCreated} created, ${result.duplicatesSkipped} skipped, ${result.errorCount} errors`);

    // Record the outcome on the account itself, so the hub's status badge
    // reflects reality no matter which UI path triggered the sync. Previously
    // only the connection wizard wrote 'connected', so syncing from the hub
    // left a working account showing 'disconnected' forever.
    try {
      await base44.asServiceRole.entities.EmailAccount.update(account.id, {
        status: 'connected',
        last_synced_at: new Date().toISOString(),
      });
    } catch { /* status write is best-effort — never fail a good sync */ }

    return Response.json({ success: true, ...result });

  } catch (error) {
    result.error = error.message;
    result.errorStack = error.stack;
    result.logs.push(`FAILED: ${error.message}`);
    try {
      await base44.asServiceRole.entities.EmailAccount.update(account.id, { status: 'error' });
    } catch { /* best-effort */ }
    return Response.json({ success: false, ...result });
```

---

## Patch 2 — `src/pages/EmailSearch.jsx`, inside `loadEmails`

### 2a. Keep the signed-in user in a local variable

**FIND:**

```jsx
      try {
        const currentUser = await base44.auth.me();
        setUser(currentUser);
      } catch {
        setUser(null);
      }
```

**REPLACE WITH:**

```jsx
      // Held locally as well as in state: the admin check further down runs in
      // this same call, before React has applied setUser, so reading the state
      // variable there returned the *previous* user and skipped the client load.
      let currentUser = null;
      try {
        currentUser = await base44.auth.me();
        setUser(currentUser);
      } catch {
        setUser(null);
      }
```

### 2b. Refresh accounts after sync, and sort messages by real time

**FIND:**

```jsx
      let allEmails = [];

      try {
        allEmails = await base44.entities.EmailMessage.list('-received_at', 100);
      } catch {
        try {
          allEmails = await base44.entities.EmailMessage.list('-created_date', 100);
        } catch {
          try {
            allEmails = await base44.entities.EmailMessage.list();
          } catch {
            allEmails = [];
          }
        }
      }

      setEmails(allEmails || []);
      setSelectedEmailId(null);
```

**REPLACE WITH:**

```jsx
      // Re-read the accounts after syncing so the status badge and
      // "last synced" reflect what the worker just wrote.
      if (sync) {
        try {
          const refreshedAccounts = await base44.entities.EmailAccount.list('-created_date', 50);
          setAccounts(refreshedAccounts || []);
        } catch { /* keep the pre-sync list */ }
      }

      let allEmails = [];

      try {
        allEmails = await base44.entities.EmailMessage.list('-created_date', 200);
      } catch {
        try {
          allEmails = await base44.entities.EmailMessage.list();
        } catch {
          allEmails = [];
        }
      }

      // Sort in JS. received_at is ISO for outbound mail and for anything
      // synced after this fix, but older inbound rows hold a raw RFC 2822
      // header string, so a server-side '-received_at' sort compares the two
      // formats as plain text. Date.parse handles both.
      const receivedAtMs = (m) => {
        const t = Date.parse(m?.received_at || '');
        if (!isNaN(t)) return t;
        const c = Date.parse(m?.created_date || '');
        return isNaN(c) ? 0 : c;
      };
      const sortedEmails = [...(allEmails || [])].sort((a, b) => receivedAtMs(b) - receivedAtMs(a));

      setEmails(sortedEmails);
      setSelectedEmailId(null);
```

### 2c. Use the local user for the admin check

**FIND:**

```jsx
      if (isAdminUser(user)) {
```

**REPLACE WITH:**

```jsx
      if (isAdminUser(currentUser)) {
```

---

## Verify after applying

1. Email Hub → Sync → badge flips to **connected** with a fresh timestamp, no
   page reload needed.
2. Newest mail is at the **top**.
3. Open a synced message — the body reads as normal text, not `=\r\n` and
   `&nbsp;` (existing 4 messages stay garbled; re-sync after the fix, or just
   let them age out).
4. Client list populates on first load, not only after a refresh.

## Deliberately NOT done

- **`sendgridEventWebhook` is now dead code** (SendGrid was removed from the
  send path). It is harmless — it only looks up tracking tokens — but it should
  be retired. Per the repo's working agreements, deleting a backend function
  needs explicit owner approval, so it is left in place and flagged here.
- **Triage quality:** the hub is scoring obvious phishing (spoofed "American
  Express" mail from `worrrkssss@servers.net`, `AmExpp_chris@server.net`) as
  HIGH priority / "Prospect". That is an `emailTriageAgent` prompt issue, not a
  hub bug — worth a separate pass, and worth knowing those two messages in your
  inbox are phishing.
