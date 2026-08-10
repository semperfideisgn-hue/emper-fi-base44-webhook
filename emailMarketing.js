import express from "express";

// Email marketing module for the Semper Fi Command Center.
//
// Base44 entities this module expects (create them in the Base44 builder):
//   EmailSubscriber: email, name, status (subscribed|unsubscribed), tags, client_id
//   EmailCampaign:   name, subject, from_name, from_email, html_body, status
//                    (draft|sending|sent), sent_count, sent_date
//   EmailSend:       campaign_id, subscriber_id, email, status
//                    (sent|failed|opened|clicked|unsubscribed), event_date
//
// Provider credentials stay server-side (SENDGRID_API_KEY) — never in the
// Base44 client bundle.

export default function emailMarketingRouter(base44Request) {
  const router = express.Router();

  const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

  async function sendEmail({ to, from_email, from_name, subject, html }) {
    const response = await fetch(SENDGRID_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from_email, name: from_name },
        subject,
        content: [{ type: "text/html", value: html }]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`SendGrid ${response.status}: ${text}`);
    }
  }

  // Add or re-subscribe a subscriber
  router.post("/subscribers", async (req, res) => {
    try {
      const { email, name, tags, client_id } = req.body;
      if (!email) {
        return res.status(400).json({ success: false, error: "email is required" });
      }

      const existing = await base44Request(
        `/entities/EmailSubscriber?email=${encodeURIComponent(email)}`,
        "GET"
      );

      let subscriber;
      if (Array.isArray(existing) && existing.length > 0) {
        subscriber = await base44Request(
          `/entities/EmailSubscriber/${existing[0].id}`,
          "PUT",
          { status: "subscribed", name: name || existing[0].name, tags: tags || existing[0].tags }
        );
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

  // Unsubscribe (also the target of unsubscribe links)
  router.post("/subscribers/unsubscribe", async (req, res) => {
    try {
      const email = req.body.email || req.query.email;
      if (!email) {
        return res.status(400).json({ success: false, error: "email is required" });
      }

      const existing = await base44Request(
        `/entities/EmailSubscriber?email=${encodeURIComponent(email)}`,
        "GET"
      );
      if (!Array.isArray(existing) || existing.length === 0) {
        return res.status(404).json({ success: false, error: "subscriber not found" });
      }

      await base44Request(`/entities/EmailSubscriber/${existing[0].id}`, "PUT", {
        status: "unsubscribed"
      });

      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, error: error.message });
    }
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
        from_email: from_email || process.env.EMAIL_FROM || "hello@semperfidesign.com",
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

      let sent = 0;
      const failures = [];
      for (const subscriber of recipients) {
        try {
          await sendEmail({
            to: subscriber.email,
            from_email: campaign.from_email,
            from_name: campaign.from_name,
            subject: campaign.subject,
            html: campaign.html_body
          });
          sent++;
          await base44Request("/entities/EmailSend", "POST", {
            campaign_id: campaign.id,
            subscriber_id: subscriber.id,
            email: subscriber.email,
            status: "sent",
            event_date: new Date().toISOString()
          });
        } catch (err) {
          failures.push({ email: subscriber.email, error: err.message });
          await base44Request("/entities/EmailSend", "POST", {
            campaign_id: campaign.id,
            subscriber_id: subscriber.id,
            email: subscriber.email,
            status: "failed",
            event_date: new Date().toISOString()
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

  // SendGrid event webhook — records opens/clicks/unsubscribes back into Base44
  router.post("/events", async (req, res) => {
    try {
      const events = Array.isArray(req.body) ? req.body : [req.body];
      for (const event of events) {
        const status = { open: "opened", click: "clicked", unsubscribe: "unsubscribed" }[
          event.event
        ];
        if (!status || !event.email) continue;

        await base44Request("/entities/EmailSend", "POST", {
          campaign_id: event.campaign_id || "",
          subscriber_id: "",
          email: event.email,
          status,
          event_date: new Date().toISOString()
        });

        if (status === "unsubscribed") {
          const existing = await base44Request(
            `/entities/EmailSubscriber?email=${encodeURIComponent(event.email)}`,
            "GET"
          );
          if (Array.isArray(existing) && existing.length > 0) {
            await base44Request(`/entities/EmailSubscriber/${existing[0].id}`, "PUT", {
              status: "unsubscribed"
            });
          }
        }
      }
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}
