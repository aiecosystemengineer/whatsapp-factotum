# WhatsApp Factotum

An always-on personal assistant that watches **your selected WhatsApp group chats**
and pings your phone the moment something you'd hate to miss appears — free AI
credits, expiring promo codes, hackathon registrations closing tonight, job gigs,
important admin announcements — and warns you about scams.

It is **read-only**: it never posts into groups. Notifications go to your own
WhatsApp self-chat ("Message yourself") and/or a push notification via
[ntfy](https://ntfy.sh).

## Architecture

```
WhatsApp groups ──(Baileys, notify upserts)──▶ per-group batch buffer
      │                                            │ batchWindowSeconds
      │                                            ▼
      │                              classifier (LLM via Vercel AI SDK,
      │                              or built-in keyword heuristic)
      │                                            │ score ≥ minScore
      ▼                                            ▼
  context store (data/)              ntfy push + WhatsApp self-chat
                                     + daily digest
```

Messages are batched per group so a burst of chat is classified once. The last
~10 earlier messages are passed to the LLM as context so "here's the link:"
followed by a bare URL still makes sense. All chat content is wrapped in an
untrusted-data block and secrets are redacted before anything is logged or sent.

## Quick start

```bash
npm i
cp .env.example .env
cp factotum.config.example.json factotum.config.json
npm run link        # scan the QR: WhatsApp › Settings › Linked devices
npm run groups      # lists JID | name | members for all your groups
```

Paste the JIDs you want watched into `factotum.config.json → watchedGroups`,
set your `interests` in plain language, then:

- **Push notifications (recommended):** install the ntfy app on your phone,
  subscribe to a random hard-to-guess topic name, and put it in
  `notify.ntfyTopic`.
- **Self-chat:** `notify.selfChat: true` (default) sends alerts to your own
  "Message yourself" chat.

Add the API key for your chosen `llm.provider` to `.env`, then:

```bash
npm run watch
```

Tune sensitivity with `minScore` (default 60 — notify at/above) and test any
message without sending:

```bash
npm run test -- "Anthropic giving $250 free Claude credits, claim before Friday https://example.com"
npm run test -- "some text" --llm      # use the real LLM path
```

**No API key?** It still works — a built-in keyword heuristic scores messages.
An LLM (a cheap model like `claude-haiku-4-5` or `gpt-4o-mini` is fine)
is recommended for better judgement.

## Running 24/7

With [pm2](https://pm2.keymetrics.io):

```bash
pm2 start npm --name factotum -- run watch
pm2 save
```

Or a systemd user unit (`~/.config/systemd/user/factotum.service`):

```ini
[Unit]
Description=WhatsApp Factotum
After=network-online.target

[Service]
WorkingDirectory=%h/repos/whatsapp-factotum
ExecStart=%h/.nvm/versions/node/v22.0.0/bin/npm run watch
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now factotum` (fix the node path to your install).

## Safety & ToS

- This links your own WhatsApp account as a companion device via the unofficial
  Baileys library — the same mechanism WhatsApp Web uses. Unofficial clients can
  in principle lead to account restrictions; use at your own risk, ideally with
  a secondary number.
- It only reads messages in groups you explicitly list, and only ever *sends*
  to your own self-chat. It cannot post to groups or DM anyone.
- Chat content is treated as untrusted data (prompt-injection filtering,
  untrusted-block wrapping) and API keys are read only from `.env`, never from
  the config file.
- All state lives locally in `./data` and `./auth` — nothing is uploaded
  anywhere except the LLM provider you configure and ntfy notifications you
  enable.

## License

MIT — see [LICENSE](LICENSE).
