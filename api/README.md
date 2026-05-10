# APEX-MD REST API

> Expose all bot auto-features over HTTP so dashboards, automation flows (n8n, Make), web panels, or scripts can drive the bot without WhatsApp commands.

---

## Setup

### 1 — Add to `.env`

```env
API_SECRET=your_super_secret_key_here   # required — all requests need this
API_PORT=3000                            # optional, default 3000
```

### 2 — Wire into `index.js`

Add these lines to your `index.js` (right after `const config = require('./config')`):

```js
const { startApiServer } = require('./api/server');
const { mountApi }       = require('./api');
```

Inside `startBot()`, before `makeWASocket(...)`:

```js
const { app } = await startApiServer();
```

Then, inside the `connection === 'open'` handler:

```js
mountApi(app, sock);   // pass the live socket to the API layer
```

### 3 — Auth

Every request must include the header:

```
X-API-Key: your_super_secret_key_here
```

Or as a query param: `?apiKey=your_super_secret_key_here`

---

## All Endpoints

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | GET | `/api/status` | Bot health, uptime, memory |
| 2 | POST | `/api/send` | Send text / image / video / audio / sticker / document |
| 3 | POST | `/api/auto-typing` | Simulate typing indicator in a chat |
| 4 | POST | `/api/auto-recording` | Simulate voice-note recording indicator |
| 5 | POST | `/api/auto-read` | Mark messages as read |
| 6 | POST | `/api/auto-seen-status` | View all pending WhatsApp statuses |
| 7 | GET | `/api/menu` | Full command menu as structured JSON |
| 8 | POST | `/api/broadcast` | Send message to multiple chats with delay |
| 9 | GET/POST/DELETE | `/api/auto-reply` | Manage keyword → auto-reply rules |
| 10 | GET/POST | `/api/group/settings` | Read / update group feature flags |
| 11 | POST | `/api/group/action` | Kick / promote / demote member |
| 12 | GET/PATCH | `/api/users/:number` | Read / update user profile |
| 13 | GET/POST/DELETE | `/api/schedule` | Manage cron-scheduled messages |
| 14 | GET/PATCH | `/api/bot/config` | Live config update (no restart) |
| 15 | POST | `/api/bot/theme` | Switch bot personality theme |
| 16 | POST | `/api/auto-status-view` | Enable auto-status viewing |
| 17 | POST | `/api/auto-presence` | Set bot's own presence state |
| 18 | GET | `/api/chats` | List all groups the bot is in |
| 19 | POST | `/api/react` | React to a message with an emoji |
| 20 | POST | `/api/delete-message` | Delete a sent message |
| 21 | POST | `/api/pin-message` | Pin / unpin a message |
| 22 | POST | `/api/group/create` | Create a new WhatsApp group |
| 23 | POST | `/api/group/invite-link` | Get group invite link |
| 24 | POST | `/api/forward` | Forward a message to another chat |
| 25 | POST | `/api/update-profile` | Update bot name / status / avatar |
| 26 | POST | `/api/block-unblock` | Block or unblock a contact |
| 27 | GET/DELETE | `/api/plugins` | List / remove live plugins |
| 28 | POST | `/api/ai` | Query the triple AI engine directly |
| 29 | POST | `/api/auto-welcome` | Toggle welcome message for a group |
| 30 | POST | `/api/mute-group` | Mute / unmute a group via API |

---

## Example Requests

### Send a text message
```bash
curl -X POST http://localhost:3000/api/send \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{ "number": "2348012345678", "text": "Hello from the API! 👋" }'
```

### Simulate typing for 5 seconds
```bash
curl -X POST http://localhost:3000/api/auto-typing \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{ "number": "2348012345678", "duration": 5000 }'
```

### Auto-read messages
```bash
curl -X POST http://localhost:3000/api/auto-read \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{ "number": "2348012345678" }'
```

### Get full command menu
```bash
curl http://localhost:3000/api/menu \
  -H "X-API-Key: your_key"
```

### Broadcast to multiple numbers
```bash
curl -X POST http://localhost:3000/api/broadcast \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "targets": ["2348012345678", "2347099887766"],
    "text": "📢 Important update from APEX-MD!",
    "delay": 2000
  }'
```

### Add an auto-reply rule
```bash
curl -X POST http://localhost:3000/api/auto-reply \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{ "keyword": "hi", "reply": "Hello! How can I help? 🤖", "exact": false }'
```

### Schedule a daily message
```bash
curl -X POST http://localhost:3000/api/schedule \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "2348012345678@s.whatsapp.net",
    "message": "Good morning! ☀️ Daily reminder from APEX-MD.",
    "cronExpr": "0 9 * * *"
  }'
```

### Live-patch config (no restart)
```bash
curl -X PATCH http://localhost:3000/api/bot/config \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{ "AUTO_TYPING": true, "PUBLIC_MODE": false }'
```

### Mute a group
```bash
curl -X POST http://localhost:3000/api/mute-group \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{ "groupJid": "120363012345678901@g.us", "mute": true }'
```

### React to a message
```bash
curl -X POST http://localhost:3000/api/react \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "2348012345678",
    "messageId": "3EB0XXXXXXXXXXXXXXXX",
    "emoji": "❤️"
  }'
```

### Query AI directly
```bash
curl -X POST http://localhost:3000/api/ai \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{ "prompt": "What are the top 5 WhatsApp bot features?", "engine": "auto" }'
```

---

## Response format

Every endpoint returns the same envelope:

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": "human-readable message" }
```

HTTP status codes: `200` success · `400` bad input · `401` auth fail · `503` bot not ready · `500` internal error

---

## Notes

- All `number` fields accept international format without `+` — e.g. `2348012345678`
- `image`, `video`, `audio`, `sticker`, `document` fields accept **base64-encoded** file contents
- The API layer shares the same Baileys socket as the bot — no separate connection
- Config changes via `/api/bot/config` survive until the next restart (no `.env` write)
- To persist config permanently, update your `.env` file manually
