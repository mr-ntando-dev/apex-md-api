# ⚡ APEX-MD API — 2026 Supreme Edition

**Stateless REST API** · Render-deployed · Pairs with [apex-md-bot](https://github.com/mr-ntando-dev/apex-md-bot) via MongoDB job queue

> **This repo is the API only.** No Baileys, no QR code, no WhatsApp session.
> The bot lives in [apex-md-bot](https://github.com/mr-ntando-dev/apex-md-bot) and runs on your panel/VPS.
> They communicate through a shared **MongoDB job queue** — no direct socket exposure needed.

---

## 🏗️ Architecture

```
┌─────────────────────┐    MongoDB (shared)    ┌──────────────────────┐
│   apex-md-bot        │ ←── reads  jobs ──────  │   apex-md-api        │
│   Panel / VPS        │ ──── writes results ──→  │   Render (free tier) │
│                      │                          │                      │
│   Baileys socket     │                          │   30 REST endpoints  │
│   200+ commands      │                          │   No Baileys needed  │
│   Guardian AI        │                          │   Stateless          │
│   Job worker         │                          │                      │
└─────────────────────┘                          └──────────────────────┘
```

- **Bot** stays alive on your panel/VPS — holds the WhatsApp session
- **API** on Render wakes up on HTTP request, writes a job to MongoDB, waits for result
- **Bot worker** picks up jobs every 1s, executes with live socket, writes result back
- **Keep-alive** pinger *in the bot* pings `/ping` on this API every 14 min so Render free tier never sleeps

---

## 🚀 Quick Start

### 1. Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com)

1. Fork this repo
2. Create a new **Web Service** on Render, connect your fork
3. Set environment variables (see below)
4. Deploy

### 2. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | ✅ | Same MongoDB URI as your bot. This is the only link between API and bot. |
| `API_SECRET` | ✅ | Strong random string. All `/api/*` requests require `X-API-Key: <API_SECRET>`. |
| `JOB_TIMEOUT_MS` | ❌ | How long API waits for bot to execute a job. Default: `10000` (10s). |
| `LOG_LEVEL` | ❌ | `info` (default) or `debug` |

> **PORT** is set automatically by Render — do not override it.

### 3. Configure the bot

In your **apex-md-bot** `.env`, set:
```env
MONGODB_URI=mongodb+srv://...   # same URI as here
API_URL=https://your-apex-api.onrender.com
```

That's it. Both repos sharing the same `MONGODB_URI` is the only wiring needed.

---

## 📡 REST API Reference

All endpoints require the header: `X-API-Key: <API_SECRET>`

Base URL: `https://your-apex-api.onrender.com`

### Health (no auth)

| Method | Path | Description |
|---|---|---|
| `GET` | `/ping` | Health check — used by bot keep-alive pinger |

### Messaging

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/send` | Send text / image / video / audio / sticker / document |
| `POST` | `/api/broadcast` | Broadcast message to all chats |

### Presence

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auto-typing` | Show typing indicator |
| `POST` | `/api/auto-recording` | Show voice recording indicator |
| `POST` | `/api/auto-read` | Mark messages as read |
| `POST` | `/api/auto-presence` | Set online/offline status |

### Group Management

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/group/create` | Create a new group |
| `POST` | `/api/group/add` | Add members |
| `POST` | `/api/group/remove` | Remove members |
| `POST` | `/api/group/promote` | Promote to admin |
| `POST` | `/api/group/demote` | Demote from admin |
| `GET` | `/api/group/settings/:groupJid` | Get group settings (DB, no bot needed) |
| `POST` | `/api/group/settings` | Update group settings (DB, no bot needed) |
| `POST` | `/api/group/link` | Get invite link |
| `POST` | `/api/group/revoke-link` | Revoke invite link |
| `POST` | `/api/group/name` | Change group name |
| `POST` | `/api/group/description` | Change group description |
| `POST` | `/api/group/mute` | Mute/unmute group |

### Contacts & Profile

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/users/:number` | Get user stats (DB, no bot needed) |
| `PATCH` | `/api/users/:number` | Update user data (DB, no bot needed) |
| `POST` | `/api/update-profile` | Update bot's WhatsApp profile |
| `POST` | `/api/block-unblock` | Block or unblock a contact |

### Auto-Reply (DB — no bot needed)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auto-reply` | List all auto-reply rules |
| `POST` | `/api/auto-reply` | Create / update a rule |
| `DELETE` | `/api/auto-reply/:keyword` | Delete a rule |

### Scheduled Messages (DB — no bot needed)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/schedule` | List active schedules |
| `POST` | `/api/schedule` | Create a scheduled message |
| `DELETE` | `/api/schedule/:id` | Delete a schedule |

### AI

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/ai` | Chat with AI (proxied through bot job queue) |

### Plugins

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/plugins` | List installed plugins (proxied through bot) |
| `DELETE` | `/api/plugins/:name` | Unload a plugin (proxied through bot) |

### Bot Status & Config

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/status` | API health + uptime |
| `GET` | `/api/bot/ping` | Check if bot is alive (dispatches a ping job) |
| `GET` | `/api/bot/config` | View API config |
| `PATCH` | `/api/bot/config` | Override API config at runtime |
| `POST` | `/api/bot/theme` | Switch bot personality theme |
| `GET` | `/api/chats` | List known groups from DB |

---

## 📦 Dependencies

This API is intentionally lean — **no Baileys, no FFmpeg, no media processing**:

```json
{
  "express":    "HTTP server",
  "mongoose":   "MongoDB (job queue + settings)",
  "node-cache": "In-memory fallback",
  "pino":       "Structured logging",
  "dotenv":     "Environment variables",
  "axios":      "HTTP client (for outbound requests)"
}
```

---

## ⚠️ Legal

The WhatsApp socket and Baileys integration live in the bot repo only. This API never connects to WhatsApp directly.

---

## 📄 License

MIT
