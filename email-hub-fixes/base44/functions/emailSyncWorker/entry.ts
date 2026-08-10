import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import nodemailer from 'npm:nodemailer@6.9.14';

// ── SMTP sending ──────────────────────────────────────────────────────────────
// All outbound mail goes through the EmailAccount's own SMTP settings
// (Dreamhost: smtp.dreamhost.com, port 587 or 465). SendGrid has been removed.
// Open tracking: each outbound EmailMessage gets a random tracking_token and a
// pixel pointing at the trackEmailOpen function is injected into the HTML.

const APP_PUBLIC_URL = Deno.env.get('APP_PUBLIC_URL') || 'https://semper-fi-flow.base44.app';

function makeTransport(account: any) {
  const port = Number(account.smtp_port || 587);
  return nodemailer.createTransport({
    host: account.smtp_host || 'smtp.dreamhost.com',
    port,
    secure: port === 465,
    auth: {
      user: account.username || account.email_address,
      pass: account.password_encrypted,
    },
  });
}

function injectPixel(html: string, token: string): string {
  const pixel = `<img src="${APP_PUBLIC_URL}/functions/trackEmailOpen?id=${token}" width="1" height="1" alt="" style="display:none">`;
  return html.includes('</body>') ? html.replace('</body>', `${pixel}</body>`) : html + pixel;
}

// ── send_email: single message from the Compose dialog ────────────────────────

async function handleSendEmail(message: any, fromAccount: any, base44: any): Promise<Response> {
  if (!fromAccount?.smtp_host && !fromAccount?.email_address) {
    return Response.json({ success: false, error: 'Email account has no SMTP configuration.' });
  }
  if (!fromAccount?.password_encrypted) {
    return Response.json({ success: false, error: 'Email account has no password saved — edit the account and re-enter it.' });
  }
  const to = String(message.to || '').trim();
  if (!to) return Response.json({ success: false, error: 'No recipient provided.' });

  const svc = base44.asServiceRole.entities;
  const token = crypto.randomUUID();
  const bodyText = message.body_text || '';
  const bodyHtml = message.body_html || (bodyText ? bodyText.replace(/\n/g, '<br>') : '');
  const fromEmail = fromAccount.email_address;
  const fromName = fromAccount.label || 'Semper Fi Design';

  try {
    const transporter = makeTransport(fromAccount);
    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      cc: message.cc || undefined,
      subject: message.subject || '(no subject)',
      text: bodyText || undefined,
      html: bodyHtml ? injectPixel(bodyHtml, token) : undefined,
      attachments: Array.isArray(message.attachments)
        ? message.attachments.map((a: any) => ({ filename: a.name, path: a.url }))
        : undefined,
    });
  } catch (err) {
    return Response.json({ success: false, error: `SMTP send failed: ${(err as Error).message}` });
  }

  const nowIso = new Date().toISOString();
  try {
    await svc.EmailMessage.create({
      account_id: fromAccount.id,
      from_address: fromEmail,
      from_name: fromName,
      to_addresses: to,
      cc_addresses: message.cc || '',
      subject: message.subject || '(no subject)',
      body_text: bodyText,
      body_html: bodyHtml,
      direction: 'outbound',
      status: 'read',
      delivery_status: 'sent',
      sent_at: nowIso,
      received_at: nowIso,
      tracking_token: token,
      open_count: 0,
      click_count: 0,
      has_attachments: Array.isArray(message.attachments) && message.attachments.length > 0,
      attachment_urls: (message.attachments || []).map((a: any) => a.url).join(','),
      attachment_names: (message.attachments || []).map((a: any) => a.name).join(','),
    });
  } catch { /* record failed — email already sent */ }

  return Response.json({ success: true, message: 'Email sent via SMTP.' });
}

// ── send_campaign: bulk send over SMTP ────────────────────────────────────────

async function handleSendCampaign(campaign: any, fromAccount: any, base44: any): Promise<Response> {
  if (!fromAccount?.password_encrypted) {
    return Response.json({ success: false, error: 'Email account has no password saved — edit the account and re-enter it.' });
  }

  const rawRecipients = Array.isArray(campaign.recipients)
    ? campaign.recipients
    : typeof campaign.recipients === 'string' && campaign.recipients
      ? campaign.recipients.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];
  const recipients: { email: string; name?: string }[] = rawRecipients
    .map((r: any) => (typeof r === 'string' ? { email: r } : r))
    .filter((r: any) => r?.email);

  if (!recipients.length) {
    return Response.json({ success: false, error: 'No recipients provided. Add at least one recipient email address before sending.' });
  }

  const fromEmail = campaign.from_email || campaign.from_address || fromAccount.email_address;
  const fromName = campaign.from_name || fromAccount.label || 'Semper Fi Design';
  const subject = campaign.subject || '(no subject)';
  const bodyHtml = campaign.body_html || '';
  const bodyText = campaign.body_text || bodyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  const svc = base44.asServiceRole.entities;
  const nowIso = new Date().toISOString();
  const transporter = makeTransport(fromAccount);

  let sent = 0;
  let untracked = 0;
  const failures: { email: string; error: string }[] = [];

  for (const r of recipients) {
    const token = crypto.randomUUID();
    let messageId: string | null = null;
    try {
      const created = await svc.EmailMessage.create({
        account_id: fromAccount.id,
        from_address: fromEmail,
        from_name: fromName,
        to_addresses: r.email,
        subject,
        body_text: bodyText,
        body_html: bodyHtml,
        direction: 'outbound',
        status: 'sent',
        delivery_status: 'queued',
        sent_at: nowIso,
        received_at: nowIso,
        campaign_id: campaign.campaign_id || '',
        tracking_token: token,
        open_count: 0,
        click_count: 0,
        ...(campaign.client_id ? { client_id: campaign.client_id } : {}),
        ...(campaign.client_name ? { client_name: campaign.client_name } : {}),
      });
      messageId = created?.id || null;
    } catch { untracked += 1; }

    try {
      await transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to: r.email,
        subject,
        text: bodyText || ' ',
        html: bodyHtml ? injectPixel(bodyHtml, token) : undefined,
      });
      sent += 1;
      if (messageId) await svc.EmailMessage.update(messageId, { delivery_status: 'sent' }).catch(() => {});
    } catch (err) {
      failures.push({ email: r.email, error: (err as Error).message });
      if (messageId) await svc.EmailMessage.update(messageId, { delivery_status: 'failed' }).catch(() => {});
    }
  }

  return Response.json({
    success: failures.length < recipients.length,
    sentCount: sent,
    failedCount: failures.length,
    failures,
    untracked,
    provider: 'smtp',
    tracking: 'self_hosted_pixel',
    message: `${sent} of ${recipients.length} email(s) sent via SMTP (${fromAccount.smtp_host || 'smtp.dreamhost.com'}).`,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ success: false, error: 'Unauthorized — sign in required' });
    }

    const body = await req.json();
    const { action, emailAccountId, campaign, message } = body as {
      action?: string;
      emailAccountId?: string;
      campaign?: any;
      message?: any;
    };

    if (!emailAccountId) {
      return Response.json({ success: false, error: 'emailAccountId required' });
    }

    console.log(`[emailSync] Loading account: ${emailAccountId}`);
    let acc;
    try {
      // .get() — .filter({ id }) does not match on the primary key and made
      // every sync return "Account not found"
      acc = await base44.entities.EmailAccount.get(emailAccountId);
    } catch (err) {
      console.error(`[emailSync] Failed to fetch account: ${err.message}`);
      return Response.json({ success: false, error: `Failed to fetch account: ${err.message}` });
    }
    if (!acc) {
      return Response.json({ success: false, error: 'Account not found', accountId: emailAccountId });
    }

    // Ownership check — non-admins may only use their own email accounts
    // (unless the account is marked shared). The schema field is
    // owner_user_id; the old check read acc.user_id, which does not exist,
    // so it never blocked anyone.
    const isAdmin = user.role === 'admin' || user?.data?.app_role === 'admin';
    if (!isAdmin && !acc.is_shared && acc.owner_user_id && acc.owner_user_id !== user.id) {
      return Response.json({ success: false, error: 'Forbidden — you may only use your own email accounts' });
    }

    // ── Outbound actions: SMTP, skip IMAP entirely ───────────────────────────
    if (action === 'send_campaign') {
      return handleSendCampaign(campaign || {}, acc, base44);
    }
    if (action === 'send_email') {
      return handleSendEmail(message || {}, acc, base44);
    }

    console.log(`[emailSync] Account found: ${acc.email_address}`);
    console.log(`[emailSync] Provider: ${acc.provider}`);
    console.log(`[emailSync] IMAP Host: ${acc.imap_host}:${acc.imap_port || 993}`);

    // ── SECURITY: use password_encrypted field, never log the value ──────────
    if (!acc.imap_host || !acc.username || !acc.password_encrypted) {
      return Response.json({
        success: false,
        error: 'Missing IMAP configuration',
        missing: {
          imap_host: !acc.imap_host,
          username: !acc.username,
          password_encrypted: !acc.password_encrypted,
        }
      });
    }

    return await syncEmailsWithFullParse(acc, base44);
  } catch (error) {
    console.error(`[emailSync] Handler error: ${error.message}`);
    return Response.json({ success: false, error: error.message });
  }
});

function parseHeaders(headerBlock) {
  const headers = {};
  const lines = headerBlock.split('\r\n');
  let currentKey = '';

  for (const line of lines) {
    if (!line) break;
    if (line[0] === ' ' || line[0] === '\t') {
      if (currentKey) headers[currentKey] += ' ' + line.trim();
    } else {
      const [key, ...valueParts] = line.split(':');
      if (key) {
        currentKey = key.toLowerCase().trim();
        headers[currentKey] = valueParts.join(':').trim();
      }
    }
  }
  return headers;
}

function extractEmailAddress(addressStr) {
  if (!addressStr) return '';
  const match = addressStr.match(/<([^>]+)>/);
  return match ? match[1] : addressStr.split('@')[0] ? addressStr : '';
}

function extractEmailName(addressStr) {
  if (!addressStr) return '';
  const match = addressStr.match(/^([^<]+)</);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
}

async function syncEmailsWithFullParse(account, base44) {
  const result = {
    accountId: account.id,
    email: account.email_address,
    library: 'native-tls-imap-full-parse',
    connectionSuccess: false,
    authSuccess: false,
    inboxOpenSuccess: false,
    unseenCount: 0,
    emailsCreated: 0,
    duplicatesSkipped: 0,
    errorCount: 0,
    firstSubjects: [],
    errors: [],
    logs: []
  };

  let conn;
  try {
    result.logs.push(`Starting sync for ${account.email_address}`);
    result.logs.push(`Connecting to ${account.imap_host}:${account.imap_port || 993}`);

    const hostname = account.imap_host;
    const port = account.imap_port || 993;
    const username = account.username || account.email_address;

    // ── SECURITY: read from password_encrypted — never log this value ────────
    const password = account.password_encrypted;

    conn = await Deno.connectTls({ hostname, port, alpnProtocols: [] });
    result.connectionSuccess = true;
    result.logs.push(`TLS connection established`);

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffer = '';
    let tagCounter = 1;

    const write = async (cmd) => {
      const encoded = encoder.encode(cmd + '\r\n');
      const writer = conn.writable.getWriter();
      try {
        await writer.write(encoded);
      } finally {
        writer.releaseLock();
      }
    };

    // reader.read() takes no AbortSignal, so the previous AbortController never
    // cancelled anything — a silent server hung the function until the platform
    // killed it. Promise.race gives a timeout that actually fires.
    const read = async (timeout = 5000) => {
      const reader = conn.readable.getReader();
      let timeoutId;
      try {
        const timed = new Promise((_, rej) => {
          timeoutId = setTimeout(() => rej(new Error('Read timeout')), timeout);
        });
        const { value } = await Promise.race([reader.read(), timed]);
        if (value) {
          buffer += decoder.decode(value);
          const lines = buffer.split('\r\n');
          buffer = lines.pop() || '';
          return lines;
        }
        return [];
      } finally {
        clearTimeout(timeoutId);
        reader.releaseLock();
      }
    };

    // Read until the tagged completion line for `tag` appears, or we run out of
    // patience. IMAP replies arrive across arbitrary packet boundaries; a single
    // read() can return a partial response. SEARCH and FETCH already looped like
    // this — LOGIN did not, which is why a good password could look like a
    // failure.
    const readUntilTag = async (tag, timeout = 8000, maxRounds = 40) => {
      const collected = [];
      const deadline = Date.now() + timeout;
      for (let i = 0; i < maxRounds && Date.now() < deadline; i++) {
        let lines;
        try {
          lines = await read(Math.max(500, deadline - Date.now()));
        } catch (e) {
          if (collected.length) break;   // partial reply is better than nothing
          throw e;
        }
        for (const line of lines) {
          collected.push(line);
          if (line.startsWith(tag + ' ')) return collected;   // tagged OK/NO/BAD
        }
      }
      return collected;
    };

    // IMAP quoted-strings must escape backslash and double-quote. An unescaped
    // password containing either produced a malformed LOGIN and a mystery
    // auth failure.
    const imapQuote = (v) => '"' + String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

    const greeting = await read(3000);
    result.logs.push(`Server greeting: ${greeting[0]?.substring(0, 60) || 'N/A'}`);

    // ── AUTH: password used here but never logged ─────────────────────────────
    result.logs.push(`Authenticating as ${username}`);
    const loginTag = `A${tagCounter++}`;
    await write(`${loginTag} LOGIN ${imapQuote(username)} ${imapQuote(password)}`);

    // Previously: a read timeout set authSuccess = true, so a WRONG PASSWORD
    // reported a successful sync that imported nothing. Never infer auth.
    let loginLines = [];
    try {
      loginLines = await readUntilTag(loginTag, 8000);
    } catch (e) {
      throw new Error(`No response to LOGIN (${e.message}). Check imap_host/port and that the account allows IMAP.`);
    }

    const tagged = loginLines.find(l => l.startsWith(loginTag + ' '));
    if (!tagged) {
      throw new Error('IMAP server never completed the LOGIN command (no tagged response).');
    }
    result.authSuccess = /^\S+\s+OK\b/i.test(tagged);
    if (!result.authSuccess) {
      // Surface the server's own words — e.g. "NO [AUTHENTICATIONFAILED]".
      throw new Error(`Authentication failed: ${tagged.slice(0, 160)}`);
    }
    result.logs.push(`Authentication successful`);

    result.logs.push(`Opening INBOX`);
    const selectTag = `A${tagCounter++}`;
    try {
      await write(`${selectTag} SELECT INBOX`);
      const selectLines = await read(5000);
      for (const line of selectLines) {
        if (line.includes('EXISTS')) {
          const match = line.match(/(\d+) EXISTS/);
          if (match) result.logs.push(`INBOX has ${match[1]} messages`);
        }
      }
      result.inboxOpenSuccess = true;
    } catch (e) {
      throw new Error(`SELECT INBOX failed: ${e.message}`);
    }

    result.logs.push(`Searching for recent emails (UNSEEN or last 10)`);
    const searchTag = `A${tagCounter++}`;
    await write(`${searchTag} SEARCH UNSEEN`);

    let uids = [];
    let searchComplete = false;
    let searchAttempts = 0;
    while (!searchComplete && searchAttempts < 10) {
      try {
        const searchLines = await read(3000);
        for (const line of searchLines) {
          const match = line.match(/^\*\s+SEARCH\s+(.*?)$/);
          if (match && match[1]) {
            uids = match[1].trim().split(/\s+/).filter(u => /^\d+$/.test(u));
          }
          if (line.startsWith(searchTag + ' OK')) { searchComplete = true; break; }
        }
      } catch (e) {
        if (searchAttempts > 2) searchComplete = true;
      }
      searchAttempts++;
    }

    result.unseenCount = uids.length;
    result.logs.push(`Found ${uids.length} unseen emails`);

    if (uids.length === 0) {
      result.logs.push(`No unseen; falling back to UID RANGE for testing`);
      const rangeTag = `A${tagCounter++}`;
      await write(`${rangeTag} SEARCH UID 1:*`);
      let rangeComplete = false;
      let rangeAttempts = 0;
      while (!rangeComplete && rangeAttempts < 10) {
        try {
          const rangeLines = await read(2000);
          for (const line of rangeLines) {
            const match = line.match(/^\*\s+SEARCH\s+(.*?)$/);
            if (match && match[1]) {
              uids = match[1].trim().split(/\s+/).filter(u => /^\d+$/.test(u)).slice(-5);
            }
            if (line.startsWith(rangeTag + ' OK')) { rangeComplete = true; break; }
          }
        } catch (e) {
          if (rangeAttempts > 2) rangeComplete = true;
        }
        rangeAttempts++;
      }
      result.logs.push(`Fallback found ${uids.length} recent emails`);
    }

    const toFetch = uids.slice(0, 20);
    result.logs.push(`Processing ${toFetch.length} emails`);

    for (const uid of toFetch) {
      try {
        const fetchTag = `A${tagCounter++}`;
        await write(`${fetchTag} FETCH ${uid} (RFC822)`);

        let fetchData = '';
        let fetchComplete = false;
        const maxAttempts = 100;
        let attempts = 0;

        while (!fetchComplete && attempts < maxAttempts) {
          try {
            const lines = await read(2000);
            for (const line of lines) {
              fetchData += line + '\r\n';
              if (line.startsWith(fetchTag + ' OK')) { fetchComplete = true; break; }
            }
          } catch (e) {
            if (e.message.includes('timeout') && attempts > 5) fetchComplete = true;
            else throw e;
          }
          attempts++;
        }

        const rfc822Match = fetchData.match(/RFC822\s+\{(\d+)\}[\r\n]+([\s\S]*?)(?=\r\nA\d|$)/);
        if (!rfc822Match || !rfc822Match[2]) {
          result.logs.push(`No RFC822 data for UID ${uid}`);
          continue;
        }

        const fullMessage = rfc822Match[2];
        const [headerPart, ...bodyParts] = fullMessage.split('\r\n\r\n');
        const headers = parseHeaders(headerPart);
        const bodyRaw = bodyParts.join('\r\n\r\n');

        const messageId = headers['message-id'] || `${account.id}_${uid}`;

        let existing = [];
        try {
          existing = await base44.asServiceRole.entities.EmailMessage.filter({
            account_id: account.id,
            message_uid: messageId,
          });
        } catch (e) {
          result.logs.push(`Dedup check error: ${e.message}`);
        }

        if (existing.length > 0) { result.duplicatesSkipped++; continue; }

        const subject = headers['subject'] || '(no subject)';
        const fromRaw = headers['from'] || '';
        const toRaw = headers['to'] || '';
        const ccRaw = headers['cc'] || '';
        const dateStr = headers['date'] || new Date().toISOString();
        const fromAddr = extractEmailAddress(fromRaw);
        const fromName = extractEmailName(fromRaw);
        const bodyText = bodyRaw.replace(/<[^>]*>/g, '').substring(0, 5000);

        await base44.asServiceRole.entities.EmailMessage.create({
          account_id: account.id,
          message_uid: messageId,
          from_address: fromAddr,
          from_name: fromName,
          to_addresses: toRaw,
          cc_addresses: ccRaw,
          subject,
          body_text: bodyText,
          body_html: '',
          received_at: dateStr,
          direction: 'inbound',
          status: 'unread',
          synced_by_user_id: '',
        });

        result.emailsCreated++;
        if (result.firstSubjects.length < 3) result.firstSubjects.push(subject);
        result.logs.push(`Saved: ${subject.substring(0, 50)}`);

      } catch (e) {
        result.errorCount++;
        result.errors.push({ uid, error: e.message });
        result.logs.push(`Error processing UID ${uid}: ${e.message}`);
      }
    }

    try {
      const logoutTag = `A${tagCounter++}`;
      await write(`${logoutTag} LOGOUT`);
      result.logs.push(`Logout sent`);
    } catch {}

    result.logs.push(`Sync completed: ${result.emailsCreated} created, ${result.duplicatesSkipped} skipped, ${result.errorCount} errors`);
    return Response.json({ success: true, ...result });

  } catch (error) {
    result.error = error.message;
    result.errorStack = error.stack;
    result.logs.push(`FAILED: ${error.message}`);
    return Response.json({ success: false, ...result });
  } finally {
    if (conn) { try { conn.close(); } catch {} }
  }
}
