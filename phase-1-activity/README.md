# Phase 1 — Client Activity Timeline (apply package)

Phase 0 found that the Client Detail Timeline UI is **fully built and already
deployed** — `ActivityTimelinePanel`, `ActivityRow`, `AddNoteModal`, and a
22-type activity vocabulary (`src/lib/activityTypes.js`) all exist and are
wired into `ClientDetail.jsx`. They query an entity named `Activity` that was
**never created**, so the tab silently renders empty (`safeFilter` swallows
the error).

Phase 1 is therefore smaller and safer than planned: create the missing
entity to the UI's exact contract, and add two automatic feeders.

| File | What it is |
|---|---|
| `Activity.entity.json` | The `Activity` entity schema, field-for-field matched to what `AddNoteModal` writes and `ActivityRow`/`ActivityTimelinePanel` render. Staff-only RLS modeled on Task's. Create via Base44 builder or `create_entity_schema`. |
| `feeder-patches.md` | Two exact block swaps: outbound email (emailSyncWorker) and website inquiry (websiteLeadWebhook) each write an Activity row, best-effort. |

No existing entity, RLS rule, page, or portal surface is modified. The only
UI change ever needed is optional (Compose dialog passing `client_id`).

Also verified during Phase 1 prep:
- `CRMNote` and `ClientCommunication` contain **0 records** — safe to treat as
  retired; nothing to migrate. (Not deleted — per working agreements, entity
  deletion needs explicit owner approval; they can simply be ignored.)
- `Activity` contains 0 records (entity resolves but is schema-less/ghost).
