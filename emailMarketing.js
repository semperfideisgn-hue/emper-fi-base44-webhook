import express from "express";
import nodemailer from "nodemailer";

// Email marketing module for the Semper Fi Command Center.
//
// Base44 entities this module expects (see base44-entities.json):
//   EmailSubscriber, EmailCampaign, EmailSend
//
// Sending goes through plain SMTP (Dreamhost). Env vars:
//   SMTP_HOST   e.g. smtp.dreamhost.com
//   SMTP_PORT   587 (STARTTLS) or 465 (TLS); defaults to 587
//   SMTP_USER   full mailbox address, e.g. hello@semperfidesign.com
//   SMTP_PASS   mailbox password
//   EMAIL_FROM  default from address (falls back to SMTP_USER)
//   PUBLIC_URL  public base URL of this webhook, used for tracking links
//
// Plain SMTP has no provider event webhook, so opens and unsubscribes are
// tracked here: a 1x1 pixel and an unsubscribe link are injected into each
// campaign email.

export default function emailMarketingRouter(base44Request) {
  const router = express.Router();

  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.dreamhost.com",
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  function publicUrl(req) {
    return (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  }

  function injectTracking(html, { baseUrl, campaignId, email }) {
    const qs = `campaign_id=${encodeURIComponent(campaignId)}&email=${encodeURIComponent(email)}`;
    const pixel = `<img src="${baseUrl}/email-marketing/track/open?${qs}" width="1" height="1" alt="" style="display:none">`;
    const unsubscribe = `<p style="font-size:12px;color:#888;text-align:center">` +
      `<a href="${baseUrl}/email-marketing/unsubscribe?${qs}" style="color:#888">Unsubscribe</a></p>`;
    const footer = unsubscribe + pixel;
    return html.includes("</body>") ? html.replace("</body>", `${footer}</body>`) : html + footer;
  }

  async function recordEvent({ campaign_id, subscriber_id, email, status }) {
    await base44Request("/entities/EmailSend", "POST", {
      campaign_id: campaign_id || "",
      subscriber_id: subscriber_id || "",
      email,
      status,
      event_date: new Date().toISOString()
    });
  }

  async function findSubscriberByEmail(email) {
    const existing = await base44Request(
      `/entities/EmailSubscriber?email=${encodeURIComponent(email)}`,
      "GET"
    );
    return Array.isArray(existing) && existing.length > 0 ? existing[0] : null;
  }

  // Add or re-subscribe a subscriber
  router.post("/subscribers", async (req, res) => {
    try {
      const { email, name, tags, client_id } = req.body;
      if (!email) {
        return res.status(400).json({ success: false, error: "email is required" });
      }

      const existing = await findSubscriberByEmail(email);
      let subscriber;
      if (existing) {
        subscriber = await base44Request(`/entities/EmailSubscriber/${existing.id}`, "PUT", {
          status: "subscribed",
          name: name || existing.name,
          tags: tags || existing.tags
        });
      } else {
        subscriber = await base44Request("/entities/EmailSubscriber", "POST", {
          email,
          name: name || "",
          tags: tags || [],
          client_id: client_id || "",
          status: "subscribed"
        });
      }

      res.json({ success: true, subscriber_id: subscriber.id });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Unsubscribe link target (also accepts POST with { email })
  async function handleUnsubscribe(req, res) {
    try {
      const email = req.body?.email || req.query.email;
      const campaignId = req.body?.campaign_id || req.query.campaign_id || "";
      if (!email) {
        return res.status(400).json({ success: false, error: "email is required" });
      }

      const existing = await findSubscriberByEmail(email);
      if (existing) {
        await base44Request(`/entities/EmailSubscriber/${existing.id}`, "PUT", {
          status: "unsubscribed"
        });
        await recordEvent({
          campaign_id: campaignId,
          subscriber_id: existing.id,
          email,
          status: "unsubscribed"
        });
      }

      if (req.method === "GET") {
        res.send("<p>You have been unsubscribed. Sorry to see you go.</p>");
      } else {
        res.json({ success: true });
      }
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
  router.get("/unsubscribe", handleUnsubscribe);
  router.post("/subscribers/unsubscribe", handleUnsubscribe);

  // Open-tracking pixel
  router.get("/track/open", async (req, res) => {
    const { campaign_id, email } = req.query;
    if (email) {
      try {
        const subscriber = await findSubscriberByEmail(email);
        await recordEvent({
          campaign_id,
          subscriber_id: subscriber?.id,
          email,
          status: "opened"
        });
      } catch (error) {
        console.error(error);
      }
    }
    const pixel = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64"
    );
    res.set("Content-Type", "image/gif");
    res.set("Cache-Control", "no-store");
    res.send(pixel);
  });

  // Create a draft campaign
  router.post("/campaigns", async (req, res) => {
    try {
      const { name, subject, from_name, from_email, html_body } = req.body;
      if (!name || !subject || !html_body) {
        return res
          .status(400)
          .json({ success: false, error: "name, subject and html_body are required" });
      }

      const campaign = await base44Request("/entities/EmailCampaign", "POST", {
        name,
        subject,
        from_name: from_name || "Semper Fi Design",
        from_email: from_email || process.env.EMAIL_FROM || process.env.SMTP_USER,
        html_body,
        status: "draft",
        sent_count: 0
      });

      res.json({ success: true, campaign_id: campaign.id });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Send a campaign to all subscribed subscribers (optionally filtered by tag)
  router.post("/campaigns/:id/send", async (req, res) => {
    try {
      const campaign = await base44Request(`/entities/EmailCampaign/${req.params.id}`, "GET");
      if (campaign.status === "sent" || campaign.status === "sending") {
        return res
          .status(409)
          .json({ success: false, error: `campaign is already ${campaign.status}` });
      }

      const subscribers = await base44Request(
        "/entities/EmailSubscriber?status=subscribed",
        "GET"
      );
      const tag = req.body?.tag;
      const recipients = (Array.isArray(subscribers) ? subscribers : []).filter(
        s => !tag || (Array.isArray(s.tags) && s.tags.includes(tag))
      );

      await base44Request(`/entities/EmailCampaign/${campaign.id}`, "PUT", {
        status: "sending"
      });

      const baseUrl = publicUrl(req);
      let sent = 0;
      const failures = [];
      for (const subscriber of recipients) {
        try {
          await transporter.sendMail({
            from: `"${campaign.from_name}" <${campaign.from_email}>`,
            to: subscriber.email,
            subject: campaign.subject,
            html: injectTracking(campaign.html_body, {
              baseUrl,
              campaignId: campaign.id,
              email: subscriber.email
            })
          });
          sent++;
          await recordEvent({
            campaign_id: campaign.id,
            subscriber_id: subscriber.id,
            email: subscriber.email,
            status: "sent"
          });
        } catch (err) {
          failures.push({ email: subscriber.email, error: err.message });
          await recordEvent({
            campaign_id: campaign.id,
            subscriber_id: subscriber.id,
            email: subscriber.email,
            status: "failed"
          });
        }
      }

      await base44Request(`/entities/EmailCampaign/${campaign.id}`, "PUT", {
        status: "sent",
        sent_count: sent,
        sent_date: new Date().toISOString()
      });

      res.json({ success: true, sent, failed: failures.length, failures });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}
