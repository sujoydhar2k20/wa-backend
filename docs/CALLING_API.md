# WhatsApp calling: client integration (web panel, Android app)

Backend Phase 2. Audio goes over SIP/WebRTC to Asterisk; the backend decides who rings and records everything.

## 1. Softphone login
`GET /api/calls/me/sip` (JWT) →
```json
{ "enabled": true, "wssUrl": "wss://lk.biswakarmagold.com/ws", "domain": "lk.biswakarmagold.com",
  "uri": "sip:u<userId>@lk.biswakarmagold.com", "username": "u<userId>", "password": "...",
  "displayName": "Rina", "iceServers": [] }
```
Register with JsSIP (web) / sip_ua (Flutter) using these values. Keep the password in memory only
(`Cache-Control: no-store`). Web and Android may be registered at the same time: both ring.

**Answering in the browser (tested):** answer the incoming session as soon as the first local ICE candidate
exists, do not wait for gathering to finish:
```js
session.on('icecandidate', (e) => { if (!readyTimer) readyTimer = setTimeout(() => e.ready(), 300); });
session.answer({ mediaConstraints: { audio: true, video: false } });
```

Every open tab / device registers separately (up to 10 per user) and every one of them rings.
Incoming INVITEs to staff carry the header `X-BJS-CallLog: <callLogId>` to match them with socket events.

**Decline:** `POST /api/calls/:callLogId/decline` stops ringing on all of the user's tabs/devices. If the user
is the assigned staff member (first 25 s), everyone else is rung at once; a user who declined is not rung
again for that call. Emits `call:dismissed` to the user's other tabs.

## 2. Calling a customer
1. `GET /api/calls/:chatId/status` → `{ canCall, reason, dialTarget, permission: {status: granted|expired|declined|none, expiresAt}, permissionRequest: {ok|allowed, reason} }`
   - green button: `canCall === true`
   - red button: show `reason`; offer phone dialler or "Ask for WhatsApp call permission"
2. `POST /api/calls/:chatId/request-permission` (optional body `{ "text": "..." }`) → 409 already allowed, 429 Meta limit (1/day, 2/week)

**Send a "Call on WhatsApp" button** (free interactive message, any staff device):
- `GET /api/calls/:chatId/status` → `callButton: { ok, reason?, windowEndsAt?, defaultText }`
- `POST /api/calls/:chatId/send-call-button` body `{ "text": "optional, max 1024 chars" }` → `{ message }`;
  409 when the customer hasn't messaged/called in 24 h (WhatsApp then only allows a template) or one was sent < 2 min ago.
  Same access rule as calling: staff only in chats assigned to them, admins anywhere. The chat gets `message:new`
  with `metadata.kind = 'call_button'`.

3. Place the call: `ua.call('sip:' + dialTarget + '@' + domain, ...)` where `dialTarget = chat-<chatId>`.
   The backend re-checks everything; a refused call is hung up and `call:blocked` is emitted.
   (`POST /api/calls/:chatId/initiate` does the same check and returns `dialTarget`.)

Rules: staff only chats assigned to them; admins/superadmins any chat; customer must have allowed calls.

## 3. Socket.io events (sent only to the users concerned, room `user:<id>`)
| event | when | payload |
|---|---|---|
| `call:incoming` | a customer is calling; stage `assigned` (assigned staff, 25 s) or `all` | `callLogId, chatId, waId, contactName, wabaName, stage, ringSeconds` |
| `call:answered` | someone answered (others stop ringing UI) | `callLogId, answeredBy {id,name}` |
| `call:dismissed` | you declined in another tab | `callLogId, reason` |
| `call:ended` | call finished (answered, missed, failed) | `callLogId, status, duration, endReason` |
| `call:outgoing` | your outgoing call was authorised | `callLogId, chatId` |
| `call:blocked` | your outgoing call was refused | `chatId, reason` |
| `call:recording` | recording converted and ready | `callLogId` |
| `message:new` | chat entry "📞 Missed/Incoming/Outgoing WhatsApp call …" (type `system`, `metadata.kind = 'call'`) | as other messages |

The SIP INVITE is what actually rings the device; the socket events are for UI (names, chat links, dismissal).

## 4. FCM data messages (Android wake-up)
- `type: incoming_call` + the `call:incoming` payload (high priority) → show full-screen ringing, register SIP
  (Asterisk waits up to 8 s for a device to come online before each ring stage).
- `type: call_answered_elsewhere` / `type: call_ended` with `callLogId` → stop ringing.

## 5. History and recordings
- `GET /api/calls/logs?page&limit&status&direction&from&to` (admins: all; staff: their chats / their calls)
- `GET /api/calls/:chatId/logs`
- `GET /api/calls/:callLogId/recording-url` → `{ url, expiresIn }`; use `url` directly in `<audio src>` (signed, 1 h, supports seeking).
- CallLog fields: `direction, status (ringing|accepted|terminated|missed|rejected|failed), stage, answeredBy, answeredDevice (app|desk), initiatedBy, duration, startedAt, answeredAt, endedAt, endReason, recording {status, durationSec}, meta {status, duration}`.
