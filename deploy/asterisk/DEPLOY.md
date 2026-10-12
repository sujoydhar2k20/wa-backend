# Phase 1: WhatsApp calling test on +91 98740 85669 (Asterisk in Docker, SIP mode)

What this does: Meta sends WhatsApp calls for this number to Asterisk at `lk.biswakarmagold.com:5061`
(TLS, SDES-encrypted Opus audio). Asterisk rings test softphones and records answered calls.
Your Node backend, web panel, Android app, chats and broadcasts are NOT changed in this phase.
The WhatsApp call button stays HIDDEN from customers; testers call through a button message.

Tested before delivery (simulated Meta, real Asterisk 22.11.0 image): TLS login, SDES + Opus,
ring 1001 first then 1001-1003, recording with audio. Not testable without Meta: the real Meta leg.

---------------------------------------------------------------------------------------------
## 0. Pre-checks (on the server, as root)

    cd /var/www/whats-app-backend && git pull
    apt install -y docker-compose-v2
    docker compose version
    ss -lntup | grep -E ':5061 |:1[0-9]{4} ' || echo "ports free"      # must print "ports free"

## 1. TLS certificate for lk.biswakarmagold.com

    certbot certonly --nginx -d lk.biswakarmagold.com      # if this errors, send me the output
    ls /etc/letsencrypt/live/lk.biswakarmagold.com/        # fullchain.pem privkey.pem

Restart Asterisk automatically when the certificate renews:

    cat > /etc/letsencrypt/renewal-hooks/deploy/bjs-asterisk.sh <<'HOOK'
    #!/bin/sh
    case "$RENEWED_DOMAINS" in *lk.biswakarmagold.com*) docker restart bjs-asterisk ;; esac
    HOOK
    chmod 755 /etc/letsencrypt/renewal-hooks/deploy/bjs-asterisk.sh

## 2. Firewall (adds rules only)

    ufw allow 5061/tcp comment 'asterisk sip tls'
    ufw allow 10000:10999/udp comment 'asterisk rtp'
    ufw status | grep -E '5061|10000'

If your hosting provider has its own firewall panel, open the same two there.

## 3. Switch on calling + SIP in Meta (call button stays hidden)

    cd /var/www/whats-app-backend
    node scripts/calling-sip-setup.js status  --phone 1244660898719753
    node scripts/calling-sip-setup.js enable  --phone 1244660898719753 --host lk.biswakarmagold.com
    node scripts/calling-sip-setup.js password --phone 1244660898719753
Keep the printed META_SIP_PASSWORD for step 4. Do not paste it into chat.
If `enable` fails, copy the error line (it has no secrets) and stop here.

## 4. Configure and start Asterisk

    cd /var/www/whats-app-backend/deploy/asterisk
    cp .env.example .env && chmod 600 .env
    openssl rand -hex 16     # run 3 times, one password per extension
    nano .env                # fill META_SIP_PASSWORD and EXT_1001/1002/1003_PASSWORD
    mkdir -p /var/lib/bjs-calls/recordings /var/log/bjs-asterisk
    docker compose up -d --build          # first build takes about 5-10 minutes
    docker compose logs --tail 30

Checks:

    docker exec bjs-asterisk asterisk -rx "pjsip show transports"     # transport-tls 0.0.0.0:5061
    docker exec bjs-asterisk asterisk -rx "module show like srtp"     # res_srtp Running
    docker exec bjs-asterisk asterisk -rx "pjsip show endpoints"      # 1001 1002 1003 whatsapp
    openssl s_client -quiet -verify_hostname lk.biswakarmagold.com -connect lk.biswakarmagold.com:5061 </dev/null
        # must show "verify return:1" for every line and no "hostname mismatch"

## 5. Test softphone (Linphone, free: linphone.org) on a phone or computer

Add a SIP account:
- Username `1001`, password = EXT_1001_PASSWORD, domain `lk.biswakarmagold.com`
- Transport **TLS**; SIP server `sip:lk.biswakarmagold.com;transport=tls`
- Disable ICE; Encryption **SRTP-SDES**, mandatory; enable all audio codecs (Opus first)
Status should turn green. Dial **600**: you hear a prompt, then your own voice (echo test).
Optionally set up 1002 on a second device to test "ring everyone".

## 6. Test calls (note the time of each, and the result)

Use a personal WhatsApp number (not the business number) as the "customer".

| # | Test | How | Expected |
|---|------|-----|----------|
| A | Customer calls in | Send the business number any message from the tester, then run `node scripts/calling-sip-setup.js send-call-button --phone 1244660898719753 --to 91XXXXXXXXXX` and tap the button | 1001 rings; answer; both sides hear each other |
| B | Fallback ring | Repeat A, don't answer 1001 for 25 s | after 25 s, 1001-1003 ring together |
| C | Nobody answers | Repeat A, answer nothing | note after how many seconds the tester's call ends (Meta's limit) |
| D | Long call | Repeat A, talk 2+ minutes | no drop at about 32 s, audio stays both ways |
| E | Business calls customer | `node scripts/calling-sip-setup.js request-permission --phone 1244660898719753 --to 91XXXXXXXXXX`, tester taps Allow, then dial `91XXXXXXXXXX` from Linphone | tester's WhatsApp rings; answer; audio both ways |
| F | Recording | after A/E | `ls -R /var/lib/bjs-calls/recordings` shows wav files that play correctly |

Optional G: set `EARLY_ANSWER=yes` in .env, `docker compose up -d`, repeat B and C. The customer's
call connects at once and hears ringing while staff are rung (no Meta time limit), but the call
then never shows as "missed" on the customer's phone. We decide in Phase 2 which behaviour to keep.

Logs for anything that fails (send me the output; it contains no passwords):

    grep -E "WA-|ERROR|WARNING" /var/log/bjs-asterisk/messages.log | tail -50

Detailed SIP trace for one test call:

    docker exec bjs-asterisk asterisk -rx "pjsip set logger on"
    # make the call, then:
    docker exec bjs-asterisk asterisk -rx "pjsip set logger off"
    docker logs bjs-asterisk 2>&1 | tail -400 > /tmp/sip-trace.txt   # contains phone numbers; share privately

## 7. Between test sessions / rollback

Pause calling (number goes back to today's state, Asterisk can keep running):

    node scripts/calling-sip-setup.js disable --phone 1244660898719753

Full removal:

    cd /var/www/whats-app-backend/deploy/asterisk && docker compose down && docker rmi bjs-asterisk:22
    ufw delete allow 5061/tcp && ufw delete allow 10000:10999/udp
    rm /etc/letsencrypt/renewal-hooks/deploy/bjs-asterisk.sh
    # recordings stay in /var/lib/bjs-calls/recordings until you delete them

## Notes
- Meta is recognised only by its published IP ranges (config/pjsip.conf). If a real test call never
  reaches Asterisk, the log will show "No matching endpoint" with the source IP; send it to me.
- Port 5061 is open to the internet for staff phones; extension passwords must stay long and random.
- Recordings are 8 kHz WAV (about 57 MB per hour of talk). Phase 2 converts and links them to chats,
  and adds 1-year cleanup.
