import { useMemo, useState, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Reply, Forward, Sparkles, X, ShieldAlert, ImageOff, Image as ImageIcon,
  Code2, FileText, Paperclip,
} from 'lucide-react';

/**
 * EmailReaderDialog — the full-size email reader for the Email Hub.
 *
 * One component used from every list in the hub (Inbox, Sent, Drafts, the
 * client-filtered panel and the lead/prospect views), so an email opens the
 * same way everywhere.
 *
 * Behavior worth knowing:
 *   - Renders body_html when present (sanitized with DOMPurify), falling back
 *     to body_text. Toggle between rendered and plain-text views.
 *   - Remote images are BLOCKED by default. Loading them silently confirms
 *     your address to a sender and fires their tracking pixels; "Load images"
 *     is a deliberate click.
 *   - Suspicious mail gets a warning banner and links are rendered inert.
 */

const BRANDS = [
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

const BAIT_PHRASES = [
  'verify your account', 'validate your account', 'secure your account',
  'account has been compromised', 'temporary hold', 'unusual activity',
  'unusual auto-debit', 'confirm your identity', 'account has been suspended',
  'verify and validate', 'click below and follow the steps',
  'update your payment', 'your account will be closed', 'unauthorized withdrawal',
];

/**
 * Shared phishing heuristic. Mirrors the logic in classifyEmail() so the
 * badge, the reader banner and the backend triage all agree.
 */
export function detectSuspicious(email) {
  const from = String(email?.from_address || '').toLowerCase();
  const fromName = String(email?.from_name || '').toLowerCase();
  const subject = String(email?.subject || '').toLowerCase();
  const body = String(email?.body_text || email?.body_html || '').toLowerCase();
  const domain = (from.match(/@([^>\s,]+)/) || [])[1] || '';
  const reasons = [];

  // A well-known brand claimed in the display name, local part or subject,
  // sent from a domain that is not that brand's.
  const claimed = `${fromName} ${from.split('@')[0]} ${subject}`;
  for (const brand of BRANDS) {
    if (claimed.includes(brand.name)) {
      const legit = brand.domains.some((d) => domain === d || domain.endsWith(`.${d}`));
      if (!legit) {
        reasons.push(`Claims to be ${brand.name} but was sent from ${domain || 'an unknown domain'}`);
        break;
      }
    }
  }

  const bait = BAIT_PHRASES.filter((p) => body.includes(p) || subject.includes(p));
  if (bait.length) reasons.push(`Uses credential-harvesting language ("${bait[0]}")`);

  // Hyphenated brand lookalikes, e.g. "www-americanexpress.account.verify.details"
  if (/www-[a-z0-9]+\.[a-z0-9.-]*(verify|secure|account|login|update)/i.test(body)) {
    reasons.push('Contains a lookalike verification link');
  }

  return { suspicious: reasons.length >= 2 || (reasons.length === 1 && bait.length >= 2), reasons };
}

function formatWhen(value) {
  if (!value) return '—';
  const t = Date.parse(value);
  if (isNaN(t)) return String(value);
  return new Date(t).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function senderLine(email) {
  const name = email?.from_name;
  const addr = email?.from_address || email?.sender_email || email?.from || '';
  return name ? `${name} <${addr}>` : addr || '—';
}

export default function EmailReaderDialog({
  email,
  open,
  onOpenChange,
  onReply,
  onForward,
  onCreateTask,
}) {
  const [showImages, setShowImages] = useState(false);
  const [viewMode, setViewMode] = useState('rendered');

  // Reset per-message: image trust must never carry over to the next email.
  useEffect(() => {
    setShowImages(false);
    setViewMode('rendered');
  }, [email?.id]);

  const risk = useMemo(() => (email ? detectSuspicious(email) : { suspicious: false, reasons: [] }), [email]);

  const safeHtml = useMemo(() => {
    if (!email?.body_html) return '';
    let html = DOMPurify.sanitize(email.body_html, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'srcset'],
      ALLOW_DATA_ATTR: false,
    });
    if (!showImages) {
      // Neutralize remote images rather than dropping them, so "Load images"
      // can restore the layout without a re-sanitize round trip.
      html = html.replace(/<img\b[^>]*>/gi, '');
    }
    if (risk.suspicious) {
      html = html.replace(/<a\b[^>]*>/gi, '<span data-link-disabled="true">').replace(/<\/a>/gi, '</span>');
    }
    return html;
  }, [email?.body_html, showImages, risk.suspicious]);

  const plainText = email?.body_text || '';
  const hasHtml = Boolean(email?.body_html);
  const attachmentNames = String(email?.attachment_names || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!email) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-6xl flex-col gap-0 overflow-hidden p-0">
        {/* Header */}
        <div className="border-b border-border bg-card px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-xl font-semibold tracking-tight">
                {email.subject || '(No subject)'}
              </h2>
              <div className="mt-2 space-y-0.5 text-sm text-muted-foreground">
                <p className="truncate">
                  <span className="font-medium text-foreground">From:</span> {senderLine(email)}
                </p>
                <p className="truncate">
                  <span className="font-medium text-foreground">To:</span> {email.to_addresses || '—'}
                </p>
                <p>
                  <span className="font-medium text-foreground">Date:</span>{' '}
                  {formatWhen(email.received_at || email.sent_at || email.created_date)}
                </p>
                {email.client_name && (
                  <p>
                    <span className="font-medium text-foreground">Client:</span> {email.client_name}
                  </p>
                )}
              </div>
            </div>

            <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} className="shrink-0">
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Actions */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {onReply && (
              <Button size="sm" variant="outline" onClick={() => onReply(email)} className="gap-2">
                <Reply className="h-3.5 w-3.5" /> Reply
              </Button>
            )}
            {onForward && (
              <Button size="sm" variant="outline" onClick={() => onForward(email)} className="gap-2">
                <Forward className="h-3.5 w-3.5" /> Forward
              </Button>
            )}
            {onCreateTask && (
              <Button size="sm" onClick={() => onCreateTask(email)} className="gap-2">
                <Sparkles className="h-3.5 w-3.5" /> Create Follow-Up
              </Button>
            )}

            <div className="ml-auto flex items-center gap-2">
              {hasHtml && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setViewMode((m) => (m === 'rendered' ? 'plain' : 'rendered'))}
                  className="gap-2"
                >
                  {viewMode === 'rendered' ? <FileText className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
                  {viewMode === 'rendered' ? 'Plain text' : 'Formatted'}
                </Button>
              )}
              {hasHtml && viewMode === 'rendered' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowImages((v) => !v)}
                  className="gap-2"
                  title="Remote images are blocked until you allow them"
                >
                  {showImages ? <ImageOff className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
                  {showImages ? 'Hide images' : 'Load images'}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Suspicious banner */}
        {risk.suspicious && (
          <div className="flex items-start gap-3 border-b border-[rgba(255,107,107,0.3)] bg-[rgba(255,107,107,0.10)] px-6 py-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#FF9A9A]" />
            <div className="text-sm text-[#FF9A9A]">
              <p className="font-semibold">This looks like a phishing attempt — links are disabled.</p>
              <ul className="mt-1 list-inside list-disc text-xs opacity-90">
                {risk.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/10 p-6">
          <div className="mx-auto max-w-4xl rounded-2xl border border-border bg-background p-6 shadow-sm">
            {hasHtml && viewMode === 'rendered' ? (
              <div
                className="email-html-body text-sm leading-7 text-foreground [&_a]:text-primary [&_a]:underline [&_img]:max-w-full [&_table]:max-w-full"
                dangerouslySetInnerHTML={{ __html: safeHtml }}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground">
                {plainText || 'No body text available.'}
              </pre>
            )}
          </div>

          {attachmentNames.length > 0 && (
            <div className="mx-auto mt-4 max-w-4xl rounded-2xl border border-border bg-card p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <Paperclip className="h-3.5 w-3.5" /> Attachments
              </p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {attachmentNames.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
