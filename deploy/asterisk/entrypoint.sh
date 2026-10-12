#!/bin/sh
# Renders /etc/asterisk-templates/*.conf into /etc/asterisk using values from the .env file,
# copies the Let's Encrypt certificate for SIP_DOMAIN, then starts Asterisk.
set -eu

for v in SIP_DOMAIN PUBLIC_IP WA_BUSINESS_NUMBER META_SIP_PASSWORD EXT_1001_PASSWORD EXT_1002_PASSWORD EXT_1003_PASSWORD; do
  eval "val=\${$v:-}"
  case "$val" in
    ""|CHANGE_ME*) echo "FATAL: $v is not set in .env" >&2; exit 1 ;;
  esac
done
for v in EXT_1001_PASSWORD EXT_1002_PASSWORD EXT_1003_PASSWORD; do
  eval "val=\${$v}"
  if [ "${#val}" -lt 16 ]; then echo "FATAL: $v must be at least 16 characters" >&2; exit 1; fi
done

export RTP_START="${RTP_START:-10000}" RTP_END="${RTP_END:-10999}"
export EARLY_ANSWER="${EARLY_ANSWER:-no}" RING_FIRST_SECONDS="${RING_FIRST_SECONDS:-25}" RING_ALL_SECONDS="${RING_ALL_SECONDS:-25}"
export RECORD_CALLS="${RECORD_CALLS:-yes}"

# Only these variables are substituted, so dialplan variables such as ${EXTEN} are left alone.
VARS='$SIP_DOMAIN $PUBLIC_IP $WA_BUSINESS_NUMBER $META_SIP_PASSWORD $EXT_1001_PASSWORD $EXT_1002_PASSWORD $EXT_1003_PASSWORD $RTP_START $RTP_END $EARLY_ANSWER $RING_FIRST_SECONDS $RING_ALL_SECONDS $RECORD_CALLS'
for f in /etc/asterisk-templates/*.conf; do
  envsubst "$VARS" < "$f" > "/etc/asterisk/$(basename "$f")"
done

CERT_DIR="/etc/letsencrypt/live/${SIP_DOMAIN}"
if [ ! -r "$CERT_DIR/fullchain.pem" ] || [ ! -r "$CERT_DIR/privkey.pem" ]; then
  echo "FATAL: certificate not found in $CERT_DIR (run certbot first, see DEPLOY.md)" >&2; exit 1
fi
cp -L "$CERT_DIR/fullchain.pem" /var/lib/asterisk/certs/fullchain.pem
cp -L "$CERT_DIR/privkey.pem" /var/lib/asterisk/certs/privkey.pem

chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk
chmod 640 /etc/asterisk/pjsip.conf
chmod 600 /var/lib/asterisk/certs/privkey.pem

exec "$@"
