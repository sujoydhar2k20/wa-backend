# WhatsApp calling: Phase 5 (reports, safety checks, go-live)

Everything below runs on the server as root unless it says "Mac". Nothing here shows the call button
to customers until step 6, and step 6 has a dry run first.

---------------------------------------------------------------------------------------------
## 1. Deploy (backend + Asterisk + web panel)

    cd /var/www/whats-app-backend && git pull && pm2 restart whats-backend
    cd /var/www/whats-app-frontend && git pull && npm ci && npm run build && pm2 restart <frontend app name>

Admins now see **Calls -> Reports**: customer calls, answer rate, time to answer, missed calls not
followed up (with "Open chat"), calls per day, busy hours, per staff member, and **Download CSV**.

## 2. Certificate renewal (important: without this, calls stop when the certificate expires)

Asterisk reads the TLS certificate only when its container starts. Let's Encrypt renews every ~60 days.

    cd /var/www/whats-app-backend/deploy/asterisk/cert-renew
    cp bjs-asterisk-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/ && chmod 755 /etc/letsencrypt/renewal-hooks/deploy/bjs-asterisk-deploy-hook.sh
    cp bjs-asterisk-cert.cron /etc/cron.d/bjs-asterisk-cert && chmod 644 /etc/cron.d/bjs-asterisk-cert
    certbot renew --dry-run                      # must end with "Congratulations, all simulated renewals succeeded"

Check the certificate Meta sees (expiry date):

    echo | openssl s_client -connect lk.biswakarmagold.com:5061 -servername lk.biswakarmagold.com 2>/dev/null | openssl x509 -noout -subject -enddate

## 3. Safety checks (read-only; send Claude any line that looks different)

    cd /var/www/whats-app-backend
    ufw status | grep -E "5061|10000|20000|8088|5038|3004"   # expect 5061/tcp and the RTP udp range only
    ss -lntp | grep -E ":8088 |:5038 "                        # both must show 127.0.0.1 only
    ss -lntup | grep asterisk | grep -vE "127.0.0.1|:5061|:1[0-9]{4} " | head   # expect nothing
    stat -c '%a %U %n' deploy/asterisk/.env .env /var/lib/bjs-calls/asterisk/*.conf   # expect 600
    docker exec bjs-asterisk asterisk -rx "pjsip show endpoints" | grep -c -- "-desk"   # expect 0 (no test desk phones left)
    docker exec bjs-asterisk asterisk -rx "module show like cdr_csv" | tail -1          # expect 0 modules loaded
    pm2 logs whats-backend --lines 300 --nostream | grep -iE "\[calls\].*(error|failed)" | tail -20

## 4. Before showing the button to customers

- [ ] Android phone tests passed (earpiece/speaker, locked phone rings, decline, call from a chat).
- [ ] Every staff member who takes calls is logged in on the web panel and/or the Android app.
      Android 14+: "Show calls on the lock screen" allowed; battery usage for BJS Connect = Unrestricted.
- [ ] Calling hours set in WhatsApp Manager (Phone numbers -> your number -> Calls), if you want them.
- [ ] A payment method is added to the WhatsApp Business Account (needed for calls *you* place).
- [ ] Staff know to tell customers the call is recorded.

## 5. Check the current setting (read-only)

    cd /var/www/whats-app-backend
    node scripts/calling-sip-setup.js status --phone 1244660898719753 | grep -E "call_icon|status"

## 6. Go live: show the WhatsApp call button to customers

Dry run first (changes nothing):

    node scripts/calling-sip-setup.js call-icon show --phone 1244660898719753 --countries IN

Apply (only customers with Indian numbers see the button; drop `--countries IN` for everyone):

    node scripts/calling-sip-setup.js call-icon show --phone 1244660898719753 --countries IN --yes
    # must print: OK call_icon_visibility: DEFAULT  and  SIP password unchanged: YES

Undo at any time (customers can still call through call buttons you send):

    node scripts/calling-sip-setup.js call-icon hide --phone 1244660898719753 --yes

Pause calling completely (emergency):

    node scripts/calling-sip-setup.js disable --phone 1244660898719753

Note: `rotate-sip-password` now keeps the button as it is (shown or hidden); before this change it
always hid it.

## 7. First week after go-live

- Calls -> Reports daily: "Missed calls not followed up" should be called back the same day.
- Busy hours tell you when more staff should be online.
- Any "Call failed" reports: send Claude the time and `pm2 logs whats-backend --lines 300 --nostream | grep '\[calls\]'`.
