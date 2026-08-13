# Email Hub round 2 — "synced and connected, but nothing refreshed"

Diagnosed against live data on 2026-08-13. The sync **worked** (4 inbound
messages created 15:39:06, outbound test sends at 15:42/15:43), and the
password is now encrypted (`enc:v1:` confirmed). Two separate defects made a
successful sync look like a failed one.

## Defect 1 — new mail sorts into the middle of the list

`syncEmailsWithFullParse` stores the raw `Date:` header verbatim:

```
inbound  received_at = "07 Jul 2026 08:54:55 +0800"   ← raw RFC 2822
inbound  received_at = "Mon, 5 Jan 2026 20:08:26 +0000"
outbound received_at = "2026-08-13T15:43:14.004Z"     ← ISO
```

The hub loads with `EmailMessage.list('-received_at', 100)`, a **string** sort.
Rows starting with a weekday name (`"Mon, …"`) sort above every ISO timestamp,
and rows starting with a day digit (`"07 Jul…"`) sort below them. Freshly
synced mail therefore lands scattered through the list instead of at the top —
which reads exactly like "it didn't refresh."

## Defect 2 — the status badge never says "connected"

`status: 'connected'` is written in exactly one place in the whole app:
`EmailSearch.jsx:2662`, inside the connection wizard's Test Connection handler.
Syncing from the hub (`loadEmails({ sync: true })`) invokes the worker but
never touches the account record, and never re-reads it afterwards. The live
account shows `last_synced_at: 2026-08-13T15:39:07Z` with
`status: "disconnected"` — proof the sync ran and the badge simply never
caught up.

---

## Patch 1 — `base44/functions/emailSyncWorker/entry.ts`

### 1a. Normalize the header date

**FIND:**

```ts
        const dateStr = headers['date'] || new Date().toISOString();
```

**REPLACE WITH:**

```ts
        // Normalize the RFC 2822 header date to ISO. Storing the raw header
        // string mixed ISO and "Mon, 5 Jan 2026 20:08:26 +0000" formats in the
        // same field, so the hub's '-received_at' sort compared them as plain
        // strings and newly synced mail landed in the middle of the list.
        const rawDateStr = headers['date'] || '';
        const parsedDate = rawDateStr ? new Date(rawDateStr) : null;
        const dateStr = parsedDate && !isNaN(parsedDate.getTime())
          ? parsedDate.toISOString()
          : new Date().toISOString();
```

### 1b. Record the sync outcome on the account (server-side truth)

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

## Patch 2 — `src/pages/EmailSearch.jsx` (inside `loadEmails`, ~line 3089)

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

      // Sort in JS. received_at is ISO for outbound mail but a raw RFC 2822
      // header string on older inbound rows, so the server-side
      // '-received_at' sort compared them as plain strings and buried freshly
      // synced mail mid-list. Date.parse handles both formats.
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

No migration is needed for the 4 existing inbound rows — the JS sort parses
their raw header dates correctly, and new rows are stored as ISO from now on.

## Verify after applying

1. Email Hub → Sync. The account badge should flip to **connected** and show a
   fresh "last synced" time without a page reload.
2. Newest mail sits at the **top** of the list.
3. Send yourself an email from Compose → it appears at the top too.

## Noted, not fixed (out of scope for this patch)

`loadEmails` calls `isAdminUser(user)` using the `user` state captured before
`setUser(currentUser)` takes effect, so on first page load the client list can
come back empty and only populate on a later refresh. Separate one-line fix
(use the local `currentUser` variable); flagging rather than bundling it.
