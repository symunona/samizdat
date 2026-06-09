---
created: 2026-06-09
topic: Newsletter email ingest (kill-the-newsletter style)
excerpt: Server generates unique email addresses; relay forwards incoming emails as HTTP webhook; server creates Documents directly. No OAuth, no Google Console.
status: iced — do RSS first; revisit when a newsletter has no RSS feed
---

# Newsletter Ingest — kill-the-newsletter style

## Goal

User subscribes to a newsletter using a server-generated email address like
`xk9m2p@mail.yourdomain.com`. When the newsletter sends an email, a relay
(forwardemail.net) POSTs it to the server. Server creates a `Document` and
queues the pipeline. Zero OAuth, zero Google Console.

---

## Data Flow

```mermaid
sequenceDiagram
    participant U as User (App)
    participant S as Server (Go)
    participant DB as SQLite
    participant R as Relay (forwardemail.net)
    participant NL as Newsletter sender

    U->>S: POST /api/v1/feeds {kind:"newsletter", title:"Axios AM"}
    S->>DB: INSERT feed (kind=newsletter, token=xk9m2p, url=email-newsletter:xk9m2p)
    S-->>U: {email: "xk9m2p@mail.yourdomain.com"}

    U->>NL: Subscribe with xk9m2p@mail.yourdomain.com

    NL->>R: SMTP email → xk9m2p@mail.yourdomain.com
    R->>S: POST /api/v1/inbound/email/xk9m2p\n  (raw MIME body, X-Webhook-Secret header)
    S->>S: verify secret
    S->>DB: SELECT feed WHERE token=xk9m2p
    S->>S: parse MIME (net/mail + mime/multipart)\n  HTML → Markdown (existing html.go)
    S->>DB: INSERT document\n  canonical_url = email:<message-id>\n  title = subject\n  author = from\n  source_feed_id = feed.id
    S->>DB: INSERT job {kind:run_pipeline, document_id:...}
    S-->>R: 200 OK

    DB->>S: worker claims job
    S->>S: Pipeline → Highlights + Tags
    S->>U: sync pull returns new Document + Highlights
```

---

## Architecture

```mermaid
graph TD
    subgraph App
        UI[Add Newsletter screen]
    end

    subgraph Server["server (Go, 1 binary)"]
        API_CREATE["POST /api/v1/feeds\nkind=newsletter"]
        API_INBOUND["POST /api/v1/inbound/email/:token\n(public, secret-authed)"]
        PARSER[email parser\nnet/mail + mime/multipart\nHTML→Markdown]
        DOC_STORE[Document store]
        JOB_Q[Job queue]
        WORKER[Worker]
    end

    subgraph Storage
        DB[(SQLite)]
        VAULT[vault/\nmarkdown files]
    end

    subgraph External
        RELAY["forwardemail.net\n(free, open source)\nMX → webhook"]
        NL[Newsletter sender\nSubstack / Mailchimp / etc]
    end

    UI -->|1. create feed| API_CREATE
    API_CREATE -->|2. INSERT feed + token| DB
    API_CREATE -->|3. return email addr| UI

    NL -->|SMTP| RELAY
    RELAY -->|4. POST raw email| API_INBOUND
    API_INBOUND --> PARSER
    PARSER -->|5. INSERT document| DOC_STORE
    DOC_STORE --> DB
    DOC_STORE --> VAULT
    DOC_STORE -->|6. enqueue| JOB_Q
    JOB_Q --> DB
    WORKER -->|7. run pipeline| JOB_Q
```

---

## Schema changes

### `feeds` table — no new columns needed

Store token in existing `config` JSON field:
```json
{
  "token": "xk9m2p",
  "email": "xk9m2p@mail.yourdomain.com"
}
```

`url` field = `"email-newsletter:xk9m2p"` (synthetic, satisfies UNIQUE constraint).
`kind` = `"newsletter"` (new enum value, existing column).

### `server_settings` — one new key

`"newsletter_webhook_secret"` — shared secret validated on inbound webhook.
`"newsletter_email_domain"` — e.g. `mail.yourdomain.com`

---

## New server code

| File | What |
|------|------|
| `internal/api/newsletter.go` | `POST /api/v1/feeds` handler extension + `POST /api/v1/inbound/email/:token` |
| `internal/extractor/email.go` | MIME parser → `ParsedEmail{Subject, From, MessageID, TextHTML, TextPlain}` |
| `internal/store/queries.sql` | `GetFeedByToken`, `GetFeedsByKind` |

No new dependencies — `net/mail` and `mime/multipart` are stdlib.
Existing `internal/api/html.go` (HTML→Markdown) is reused for email body.

---

## Relay setup (Cloudflare Email Routing + Worker)

Domain: `newsletter.tmpx.space`

### DNS / Email Routing
1. Cloudflare dashboard → `tmpx.space` → Email Routing → enable
2. Add catch-all rule: `*@newsletter.tmpx.space` → **Email Worker**

### Worker (`email-to-sam`)
```javascript
export default {
  async email(message, env, ctx) {
    const token = message.to.split('@')[0]; // "xk9m2p" from "xk9m2p@newsletter.tmpx.space"
    const buf = await new Response(message.raw).arrayBuffer();
    const resp = await fetch(`${env.SAM_SERVER}/api/v1/inbound/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'X-Recipient-Token': token,
        'X-Webhook-Secret': env.WEBHOOK_SECRET,
      },
      body: buf,
    });
    if (!resp.ok) throw new Error(`sam returned ${resp.status}`);
  }
};
```

Worker env vars (Cloudflare secrets):
- `SAM_SERVER` = `https://sam.tmpx.space` (or Tailscale URL)
- `WEBHOOK_SECRET` = random 32-char hex, also stored in `server_settings`

---

## Token generation

```go
func generateEmailToken() string {
    b := make([]byte, 4)
    rand.Read(b)
    return hex.EncodeToString(b) // 8 hex chars, e.g. "a3f92c1d"
}
```

Collision probability negligible for single-user scale.

---

## Document canonical_url

```
email:<message-id-header-value>
```

Example: `email:<01933a2b.xk9m2p@substack.com>`

Deduplication: if same newsletter sends duplicate, Message-ID is stable → INSERT OR IGNORE.

---

## User flow (app)

1. Tap FAB → "Add Newsletter"
2. Enter newsletter name (optional) → tap "Get Email Address"
3. App shows: `Copy xk9m2p@mail.yourdomain.com`
4. User pastes into newsletter subscription form
5. First email arrives → Document appears in feed

---

## What's NOT in scope (yet)

- Unsubscribe flow (delete feed → token stops matching → 404 on webhook)
- Attachment handling (skip for now, text/HTML body only)
- Multiple email domains
- Newsletter auto-detection (detect if a URL is Substack → offer email OR RSS)

---

## Open questions before implementing

1. Do you have a domain to use for `mail.yourdomain.com`?
2. forwardemail.net or Cloudflare Email Routing as relay? (forwardemail = simpler webhook, CF = free but needs Worker code)
3. Token in `config` JSON vs new `email_token` column on `feeds`? (JSON = no migration, column = indexable)
