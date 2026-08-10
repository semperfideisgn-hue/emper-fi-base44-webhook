# EmailSearch.jsx — connection wizard patch (password security)

`EmailSearch.jsx` is ~4,200 lines, so unlike the other files this is not a
whole-file replacement. It is exactly **two block swaps** inside
`EmailConnectionWizardDialog` (around line 2580). Find each OLD block and
replace it with the NEW block, verbatim.

## Swap 1 — `buildPayload`: stop putting the password in the entity payload

**OLD:**

```jsx
  const buildPayload = (status) => ({
    label: form.label || `${preset.title} Inbox`,
    email_address: form.email_address.trim(),
    provider: form.provider,
    imap_host: form.imap_host.trim(),
    imap_port: Number(form.imap_port || 993),
    smtp_host: form.smtp_host.trim(),
    smtp_port: Number(form.smtp_port || 587),
    username: form.username.trim() || form.email_address.trim(),
    // The EmailAccount schema field is `password_encrypted`. Writing `password`
    // is off-schema, so Base44 silently DROPPED it: the account saved fine and
    // emailSyncWorker then failed with "Missing IMAP configuration" because the
    // one field it needs was never persisted.
    password_encrypted: form.password,
    status: status || 'disconnected',
    owner_user_id: user?.id || '',
    is_shared: Boolean(form.is_shared),
    notes: form.notes || '',
  });
```

**NEW:**

```jsx
  // Password is NOT part of this payload — it goes to the saveEmailAccount
  // backend function separately, which encrypts it server-side. The browser
  // never writes password_encrypted directly.
  const buildPayload = (status) => ({
    label: form.label || `${preset.title} Inbox`,
    email_address: form.email_address.trim(),
    provider: form.provider,
    imap_host: form.imap_host.trim(),
    imap_port: Number(form.imap_port || 993),
    smtp_host: form.smtp_host.trim(),
    smtp_port: Number(form.smtp_port || 587),
    username: form.username.trim() || form.email_address.trim(),
    status: status || 'disconnected',
    is_shared: Boolean(form.is_shared),
    notes: form.notes || '',
  });
```

## Swap 2 — `saveAccount`: save through the backend function

**OLD:**

```jsx
      const payload = buildPayload(status || 'disconnected');
      let account;

      if (savedAccountId) {
        account = await base44.entities.EmailAccount.update(savedAccountId, payload);
      } else {
        account = await base44.entities.EmailAccount.create(payload);
        setSavedAccountId(account.id);
      }
```

**NEW:**

```jsx
      const payload = buildPayload(status || 'disconnected');
      const res = await base44.functions.invoke('saveEmailAccount', {
        account: payload,
        // On update an empty password means "keep the current one".
        password: form.password || undefined,
        accountId: savedAccountId || undefined,
      });
      const data = res?.data ?? res;
      if (!data?.success) {
        throw new Error(data?.error || 'Could not save the email account.');
      }
      const account = data.account;
      if (!savedAccountId) setSavedAccountId(account.id);
```

That's the whole patch. The wizard's validation still requires a password on
first save, and `handleTestConnection`'s later `EmailAccount.update` calls only
touch `status`/`notes`/`last_synced_at`, so they are fine as-is.
