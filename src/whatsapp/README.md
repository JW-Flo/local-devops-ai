# WhatsApp Adapter

Express Router for WhatsApp integration via Baileys library. Provides message handling, auto-responses via Bedrock, and connection management.

## Integration Steps

### 1. Add to `src/index.ts`

Find the section where other routers are mounted (around line 550). Add these two lines:

```typescript
import { createWhatsAppRouter } from './whatsapp/index.js';
app.use('/whatsapp', createWhatsAppRouter());
```

Suggested location: after the market agent router and before the self-healer endpoints.

### 2. Update `.env`

Add these environment variables:

```
WHATSAPP_ENABLED=1
WHATSAPP_CREDS_PATH=D:/openclaw/credentials/whatsapp/default
WHATSAPP_ALLOWLIST=+17064612998
```

- `WHATSAPP_ENABLED`: Set to `1` to enable the adapter
- `WHATSAPP_CREDS_PATH`: Path where Baileys stores auth state (QR code + credentials)
- `WHATSAPP_ALLOWLIST`: Comma-separated phone numbers allowed to message the bot (format: `+1XXXXXXXXXX`)

### 3. Build & Restart

```bash
npm run build
npm start
```

On first run, the router will log a QR code to console. Scan it with WhatsApp to authenticate.

## API Endpoints

### `GET /whatsapp/status`

Returns connection status and metrics:
```json
{
  "connected": true,
  "phoneNumber": "1234567890@s.whatsapp.net",
  "uptime": 3600,
  "messagesReceived": 5,
  "messagesSent": 5
}
```

### `POST /whatsapp/start`

Initialize Baileys connection (auto-starts on first message if not already connected):
```json
{
  "status": "success",
  "message": "WhatsApp connection initializing",
  "connected": false,
  "phoneNumber": null
}
```

### `POST /whatsapp/stop`

Gracefully disconnect:
```json
{
  "status": "success",
  "message": "WhatsApp disconnected"
}
```

### `POST /whatsapp/send`

Send a test message to a phone number (for testing):
```json
{
  "to": "+17064612998",
  "text": "Hello, this is a test"
}
```

Response:
```json
{
  "status": "success",
  "message": "Message sent",
  "to": "+17064612998",
  "text": "Hello, this is a test"
}
```

## How It Works

1. **Authentication**: First time requires QR code scan. Credentials stored in `WHATSAPP_CREDS_PATH`
2. **Message Reception**: Listens on `messages.upsert` event
3. **Filtering**:
   - Ignores group messages (unless explicitly enabled)
   - Ignores own messages
   - Only processes messages from allowlisted numbers
4. **AI Response**: Routes text through `callBedrock()` with WhatsApp-specific system prompt
5. **Error Handling**: Sends error message back to user if LLM fails
6. **Auto-reconnect**: Automatically reconnects on disconnection (except logged-out state)

## Monitoring

- Check logs with `[whatsapp]` prefix
- Monitor `/whatsapp/status` endpoint for uptime and message counts
- QR codes and connection events logged to console

## Troubleshooting

**Not receiving messages?**
- Verify phone number is in `WHATSAPP_ALLOWLIST` (correct format: `+1XXXXXXXXXX`)
- Check console logs for QR code scan status
- Ensure `WHATSAPP_ENABLED=1`

**Connection drops?**
- Auto-reconnect kicks in after 3 seconds
- Check console for `[whatsapp] Disconnected` logs
- If stuck at `loggedOut`, delete auth state and rescan QR

**Bedrock errors?**
- Verify AWS credentials and `AWS_REGION`, `BEDROCK_MODEL` are set
- Check Bedrock rate limits in `/llm/usage`
