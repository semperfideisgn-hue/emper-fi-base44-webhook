# Phase 1 — Client Activity Timeline (apply package)

> **STATUS (verified live 2026-08-11): the `Activity` entity now EXISTS in the
> app** — created after this package was first written, with a richer schema
> than the one proposed here. `Activity.entity.json` in this folder is kept
> for reference only and **must NOT be applied** — it would downgrade the live
> schema. The only remaining Phase 1 work is the two feeders in
> `feeder-patches.md`, which have been updated to match the LIVE schema.

Phase 0 found that the Client Detail Timeline UI is fully built and deployed —
`ActivityTimelinePanel`, `ActivityRow`, `AddNoteModal`, and the 22-type
activity vocabulary (`src/lib/activityTypes.js`) are wired into
`ClientDetail.jsx`, querying the `Activity` entity.

Live-schema notes that differ from the original proposal (verified from the
deployed entity):

- `required`: `client_id`, `activity_type`, `title`, `activity_date`
- `source` enum: `manual, email, ai, automation, project, billing, system`
  (NOT `email_hub` / `webhook` / `agent`)
- `direction` enum includes `system`
- extra fields: `contact_id`, `opportunity_id` (reserved), `follow_up_owner_user_id`,
  `follow_up_owner_name`
- read RLS includes `client_visible` + `client_ids` for portal users

| File | Status |
|---|---|
| `Activity.entity.json` | **SUPERSEDED — do not apply.** Live schema is richer. |
| `feeder-patches.md` | **Current.** Two block swaps matched to the live schema. |

Also verified live:
- Email Hub fixes fully applied: SMTP worker with `decryptPassword`, fixed
  ownership check, `trackEmailOpen` on `tracking_token`, Compose using
  `send_email`, both account-save paths using `saveEmailAccount`.
- **Password migration has NOT been run**: 1 EmailAccount
  (chris@semperfi.design, Dreamhost 587) has a stored password with no
  `enc:v1:` prefix. Run as admin in the browser console:
  `await base44.functions.invoke('migrateEmailPasswords', {})`
- `CRMNote` / `ClientCommunication`: 0 records, dormant, ignore.
