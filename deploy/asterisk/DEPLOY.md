# WhatsApp calling: deploy Phase 2 (Asterisk + backend routing)

Phase 1 (SIP test with Linphone) is already running on the server. Phase 2 connects Asterisk to the
Node backend: every admin/staff user gets their own calling account automatically, the backend decides
who rings (assigned staff 25 s, then everyone 25 s), logs every call, adds call entries to chats, sends
the missed-call message, tracks call permission and stores recordings for 1 year.

Nothing changes for customers yet: the WhatsApp call button stays hidden (DISABLE_ALL). The web panel and
Android app screens come in Phases 3 and 4; until then you test with Linphone (per-user "desk" accounts).

Everything below runs on the server as root. Keep your SSH session open.

---------------------------------------------------------------------------------------------
## 0. Checks (read-only)

    cd /var/www/whats-app-backend
    grep -E '^PORT=' .env                       # backend port, used as BACKEND_URL below (default 3000)
    ps -o user= -p "$(pgrep -f 'whats-app-backend.*server.js|server.js' | head -1)"   # should print root
    getent hosts "$(hostname)" || echo "hostname does not resolve"
    ss -lntp | grep -E ':8088 |:5038 ' || echo "8088/5038 free"
    which ffmpeg

- If the backend does **not** run as root, tell Claude before continuing (staff account file ownership).
- If "hostname does not resolve": `echo "127.0.1.1 $(hostname)" >> /etc/hosts` (Asterisk needs it for WebRTC).

## 1. Pull the code

From your Mac (commit and push first, see the chat), then on the server:

    cd /var/www/whats-app-backend && git pull
    npm ci --omit=dev        # no new packages, but keeps node_modules in sync

## 2. New secrets

    openssl rand -hex 32     # -> CALLING_INTERNAL_SECRET
    openssl rand -hex 32     # -> AMI secret

Add to the **backend** `.env` (`/var/www/whats-app-backend/.env`):

    CALLING_ENABLED=true
    CALLING_PHONE_NUMBER_IDS=1244660898719753
    CALLING_INTERNAL_SECRET=<first value>
    ASTERISK_AMI_SECRET=<second value>
    SIP_DOMAIN=lk.biswakarmagold.com
    SIP_WSS_URL=wss://lk.biswakarmagold.com/ws
    ASTERISK_GENERATED_DIR=/var/lib/bjs-calls/asterisk
    CALL_RECORDINGS_DIR=/var/lib/bjs-calls/recordings

Add to **Asterisk** `deploy/asterisk/.env` (keep the existing lines; you can delete the old
EXT_1001/1002/1003_PASSWORD, EARLY_ANSWER and RING_* lines, they are no longer used):

    BACKEND_URL=http://127.0.0.1:<PORT from step 0>
    CALLING_INTERNAL_SECRET=<first value, same as backend>
    AMI_SECRET=<second value, same as backend ASTERISK_AMI_SECRET>
    DEVICE_WAIT_SECONDS=8

## 3. Folders

    mkdir -p /var/lib/bjs-calls/asterisk /var/lib/bjs-calls/recordings
    chmod 750 /var/lib/bjs-calls/asterisk

## 4. Restart the backend first (it writes the staff accounts)

    pm2 restart whats-backend          # use your pm2 app name (pm2 ls)
    pm2 logs whats-backend --lines 30 --nostream | grep -i calls
    ls -l /var/lib/bjs-calls/asterisk  # pjsip_users.conf and extensions_users.conf, owner 2000, mode 600

A line "accounts written but Asterisk reload failed (will retry)" is expected until step 5.

## 5. Rebuild and restart Asterisk

    cd /var/www/whats-app-backend/deploy/asterisk
    docker compose up -d --build --force-recreate      # rebuild takes about 5-10 minutes
    docker compose logs --tail 40
    docker exec bjs-asterisk asterisk -rx "pjsip show endpoints" | grep -c "Endpoint:  u"   # one per active admin/staff
    docker exec bjs-asterisk asterisk -rx "http show status" | grep Bound                    # 127.0.0.1:8088
    docker exec bjs-asterisk asterisk -rx "manager show users"                               # bjsbackend

Within 2 minutes the backend log shows "calling accounts updated (N users), Asterisk reloaded".

## 6. nginx: websocket for the web panel / Android app (new site file only)

    cp nginx-lk.conf /etc/nginx/sites-available/lk.biswakarmagold.com
    ln -s /etc/nginx/sites-available/lk.biswakarmagold.com /etc/nginx/sites-enabled/
    nginx -t && systemctl reload nginx        # reload ONLY if the test says ok
    curl -s -o /dev/null -w '%{http_code}\n' --http1.1 --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGVzdA==' -H 'Sec-WebSocket-Protocol: sip' \
      https://lk.biswakarmagold.com/ws        # 101 = websocket works

## 7. Meta: switch on SIP call webhooks (informational: Meta's call id, duration, errors)

    cd /var/www/whats-app-backend
    node scripts/calling-sip-setup.js sip-webhooks on --phone 1244660898719753
    # must print "SIP password unchanged: YES"

## 8. Linphone test accounts (per user)

For each user who will test with Linphone (use their login phone number from the panel):

    cd /var/www/whats-app-backend
    node scripts/calling-desk-phone.js on --phone <user login phone>

It prints that user's Linphone username (`u<userId>-desk`) and password on the server terminal only.
Linphone: same settings as Phase 1 (TLS, SIP server `sip:lk.biswakarmagold.com;transport=tls`, ICE off,
SRTP-SDES mandatory). Do not paste passwords into chat. Remove later with `... off --phone ...`.

## 9. Tests (note the time of each)

| # | Test | Expected |
|---|------|----------|
| A | Customer whose chat is **assigned** to a tester calls (send the call button: `node scripts/calling-sip-setup.js send-call-button --phone 1244660898719753 --to 91XXXXXXXXXX`) | only the assigned tester rings for 25 s, then everyone with a registered device |
| B | Answer it | chat shows "📞 Incoming WhatsApp call · m:ss · answered by <name>"; a few seconds after hang-up `GET /api/calls/<callLogId>/recording-url` works |
| C | Call again, nobody answers | after ~50 s: chat shows "📞 Missed WhatsApp call" and the customer receives the missed-call message with the **Call on WhatsApp** button (once per 30 min) |
| D | Linphone of a staff member **not** assigned to the chat dials `chat-<chatId>` | refused (log: WA-OUTBOUND-DENIED ... assigned to you) |
| E | Assigned tester dials `chat-<chatId>` before the customer allowed calls | refused ("not allowed WhatsApp calls") |
| F | Ask permission: `POST /api/calls/<chatId>/request-permission` (or the script `request-permission`), customer taps Allow, then dial `chat-<chatId>` again | customer's WhatsApp rings; chat shows "Customer allowed WhatsApp calls" and later the outgoing call entry |
| G | Deactivate a test user in the panel | within 2 min their account disappears from `pjsip show endpoints` |

Useful logs (no passwords in them):

    pm2 logs whats-backend --lines 200 --nostream | grep '\[calls\]'
    grep -E "WA-|ERROR|WARNING" /var/log/bjs-asterisk/messages.log | tail -50

## Rollback

- Pause calling for customers (no Asterisk change needed):
  `node scripts/calling-sip-setup.js disable --phone 1244660898719753`
- Back to Phase 1 code: `git checkout <phase-1 commit> -- deploy/asterisk && docker compose up -d --build --force-recreate`,
  set `CALLING_ENABLED=false` in the backend .env and `pm2 restart whats-backend`.
- Remove the nginx site: `rm /etc/nginx/sites-enabled/lk.biswakarmagold.com && nginx -t && systemctl reload nginx`.

## What changed in Asterisk (for reference)
- Test extensions 1001-1003 removed; staff accounts come from `/var/lib/bjs-calls/asterisk/pjsip_users.conf`
  (written by the backend, mode 600, uid 2000 = the container's asterisk user).
- New websocket transport (HTTP server on 127.0.0.1:8088, only reachable through nginx `/ws`).
- AMI on 127.0.0.1:5038 (backend only, used to reload accounts).
- Dialplan asks the backend (`/internal/calls/*`, loopback + shared secret) who to ring, reports answer and
  hang-up, and checks every outgoing call. If the backend is down, incoming calls still ring everyone.
- If no device of a stage is online, Asterisk waits up to DEVICE_WAIT_SECONDS (8) for one (e.g. a phone
  woken by push) before moving on.
