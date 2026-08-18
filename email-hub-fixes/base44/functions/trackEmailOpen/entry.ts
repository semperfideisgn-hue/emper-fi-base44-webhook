import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * trackEmailOpen — read-receipt tracking pixel.
 *
 * PUBLIC / NO AUTH — this is loaded directly by the recipient's email client
 * as an <img> tag, so it cannot require a login. It always returns a 1x1
 * transparent GIF regardless of outcome (never error visibly to the client).
 *
 * Query: ?id=<tracking_token>
 * The SMTP send path (emailSyncWorker) injects the pixel into every outbound
 * HTML email. Matches on EmailMessage.tracking_token — the field the sender
 * actually writes. (The old version filtered on tracking_id, which nothing
 * ever set, so no open was ever recorded.)
 */

const PIXEL_GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7'), c => c.charCodeAt(0));

function pixelResponse() {
  return new Response(PIXEL_GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    },
  });
}

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const trackingToken = url.searchParams.get('id');
    if (!trackingToken) return pixelResponse();

    const base44 = createClientFromRequest(req);
    const matches = await base44.asServiceRole.entities.EmailMessage.filter({ tracking_token: trackingToken }, '-created_date', 1);
    const msg = matches?.[0];
    if (msg) {
      const now = new Date().toISOString();
      await base44.asServiceRole.entities.EmailMessage.update(msg.id, {
        opened_at: msg.opened_at || now,
        last_opened_at: now,
        open_count: (msg.open_count || 0) + 1,
        ...(msg.delivery_status !== 'bounced' ? { delivery_status: 'delivered' } : {}),
      });
    }
  } catch (e) {
    // Swallow all errors — a broken tracker must never break email rendering.
    console.error('trackEmailOpen error:', (e as Error).message);
  }
  return pixelResponse();
});
