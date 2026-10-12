# WhatsApp calling: deploy Phase 3 (calling in the web panel)

Staff answer and make WhatsApp calls inside the web panel. Every open tab rings with the company ringtone;
the assigned staff member rings first for 25 s, then everyone. Declining (assigned staff) rings everyone at once.
Linphone is no longer needed for staff (keep the test desk accounts until Phase 5 if you like).

## 1. Backend (server)

    cd /var/www/whats-app-backend && git pull
    pm2 restart whats-backend
    pm2 logs whats-backend --lines 30 --nostream | grep -i calls     # "calling accounts updated ... Asterisk reloaded"

## 2. Asterisk: new dialplan (no rebuild needed)

The compose file now loads the config templates from this folder, so a restart is enough:

    cd /var/www/whats-app-backend/deploy/asterisk
    docker compose up -d --force-recreate
    docker exec bjs-asterisk asterisk -rx "dialplan show add-callhdr"      # context exists
    docker exec bjs-asterisk asterisk -rx "pjsip show endpoints" | grep -c "Endpoint:  u"

## 3. Web panel (server folder of whats-app-frontend)

    cd <web panel folder> && git pull
    npm ci
    npm run build
    pm2 restart <web panel pm2 name>            # pm2 ls shows it (next start -p 3004)

The panel must be opened over https (it already is): browsers allow the microphone only on secure pages.

## 4. First use (each staff member, once)
- Open the panel: the browser asks for **notifications** (allow, for background-tab call alerts).
- On the first call the browser asks for the **microphone**: allow.
- If the ringtone does not play the first time, click "Click to turn on the ringtone" (browser autoplay rule).

## 5. Live tests

| # | Test | Expected |
|---|------|----------|
| 1 | Customer calls (chat assigned to staff A); A has the panel open in 2 tabs | both of A's tabs ring with the ringtone and show "assigned to you"; nobody else for 25 s |
| 2 | A answers in one tab | other tab stops; in-call bar with timer, mute, hang up, "Open chat"; two-way audio |
| 3 | Move to other pages during the call | the call bar stays; hang up ends it; chat shows "📞 Incoming WhatsApp call · m:ss · answered by A" with a Recording button |
| 4 | Customer calls again, A presses **Decline** | everyone else (staff, admin, superadmin) starts ringing immediately; A is not rung again |
| 5 | B answers | others stop ringing and see "Call answered by B" |
| 6 | Chat call button for a customer without permission | menu shows the reason in red; "Ask for WhatsApp call permission" works; after Allow the menu turns green |
| 7 | "Call on WhatsApp" | customer's WhatsApp rings; bar shows Calling… then the timer |
| 8 | Staff member **not assigned** to the chat (Phase 2 test D) | cannot open the chat / call it (refused with "You can call only chats assigned to you") |
| 9 | Calls page (sidebar 📞) | lists calls with filters (missed/answered/outgoing, dates) and recordings |

Logs for anything that fails:

    pm2 logs whats-backend --lines 200 --nostream | grep '\[calls\]'
    grep -E "WA-|ERROR|WARNING" /var/log/bjs-asterisk/messages.log | tail -50
    # in the browser: right-click > Inspect > Console, copy red errors

## Rollback
- Web panel: `git checkout <previous commit> && npm ci && npm run build && pm2 restart <name>` (calls keep working
  with Linphone).
- Backend/Asterisk: previous commits; `docker compose up -d --force-recreate`.
