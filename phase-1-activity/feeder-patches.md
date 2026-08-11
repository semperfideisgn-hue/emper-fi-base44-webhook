# Phase 1 feeder patches — exact block swaps

Two automatic feeders prove the aggregation pattern: outbound email → Activity
row, website inquiry → Activity row. Both are additions inside existing
backend functions; both are wrapped so a failure can never break the send or
the webhook.

## Feeder 1 — emailSyncWorker: outbound email → Activity

File: `base44/functions/emailSyncWorker/entry.ts`, inside `handleSendEmail`.

**FIND** (end of the EmailMessage record block in handleSendEmail):

```ts
  } catch { /* record failed — email already sent */ }

  return Response.json({ success: true, message: 'Email sent via SMTP.' });
```

**REPLACE WITH:**

```ts
  } catch { /* record failed — email already sent */ }

  // Feed the client timeline when this send is tied to a client.
  if (message.client_id) {
    try {
      await svc.Activity.create({
        client_id: message.client_id,
        activity_type: 'email',
        title: `Email sent: ${message.subject || '(no subject)'}`,
        summary: `To ${to}`,
        detail: bodyText.slice(0, 2000),
        activity_date: nowIso,
        created_by_name: fromName,
        direction: 'outbound',
        source: 'email_hub',
        visibility: 'internal_only',
      });
    } catch { /* timeline write is best-effort */ }
  }

  return Response.json({ success: true, message: 'Email sent via SMTP.' });
```

Note: `handleSendEmail`'s `message` payload gains an optional `client_id` —
the Compose dialog can pass it when opened from a client context (optional
follow-up; without it, plain composes simply don't create timeline rows).

## Feeder 2 — websiteLeadWebhook: inquiry → Activity

File: `base44/functions/websiteLeadWebhook/entry.ts`, immediately after the
`WebsiteInquiry` record is created (search for `WebsiteInquiry.create`; add
right after the created record is obtained — variable name in file is the
created inquiry):

```ts
    // Phase 1: feed the client timeline. Best-effort — never fail the webhook.
    try {
      await sr.entities.Activity.create({
        client_id: resolvedClientId,           // use the function's resolved client id variable
        activity_type: 'client_request',
        title: `Website inquiry${nameValue ? ` from ${nameValue}` : ''}`,
        summary: (messageValue || '').slice(0, 140),
        detail: messageValue || '',
        activity_date: new Date().toISOString(),
        direction: 'inbound',
        source: 'webhook',
        visibility: 'internal_only',
      });
    } catch (e) {
      console.error('Activity feed write failed:', (e as Error).message);
    }
```

Adjust the three local variable names (`resolvedClientId`, `nameValue`,
`messageValue`) to the actual identifiers used at that point in the function —
they are the client id the webhook resolved and the name/message fields it
extracted via `pick()`.

## Order of application

1. Create the `Activity` entity first (`Activity.entity.json`) — the UI starts
   working the moment it exists (timeline tab + Add Note are already wired).
2. Apply Feeder 1, then Feeder 2.

## Verification

1. Open any client as admin → Timeline tab → Add Note → note appears.
2. Submit a test form on a connected client site → `client_request` row appears
   on that client's timeline.
3. Confirm a non-admin staff login can see the timeline (RLS check), and that a
   client portal login can NOT (Phase 1 is internal-only).
