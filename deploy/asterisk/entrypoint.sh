#!/bin/sh
# Renders /etc/asterisk-templates/*.conf into /etc/asterisk using values from the .env file,
# copies the Let's Encrypt certificate for SIP_DOMAIN, prepares the backend-generated include
# files, then starts Asterisk.
set -eu

for v in SIP_DOMAIN PUBLIC_IP WA_BUSINESS_NUMBER META_SIP_PASSWORD BACKEND_URL CALLING_INTERNAL_SECRET AMI_SECRET; do
  eval "val=\${$v:-}"
  case "$val" in
    ""|CHANGE_ME*) echo "FATAL: $v is not set in .env" >&2; exit 1 ;;
  esac
done
for v in CALLING_INTERNAL_SECRET AMI_SECRET; do
  eval "val=\${$v}"
  if [ "${#val}" -lt 32 ]; then echo "FATAL: $v must be at least 32 characters" >&2; exit 1; fi
done

export RTP_START="${RTP_START:-10000}" RTP_END="${RTP_END:-10999}"
export RECORD_CALLS="${RECORD_CALLS:-yes}" DEVICE_WAIT_SECONDS="${DEVICE_WAIT_SECONDS:-8}"

# Only these variables are substituted, so dialplan variables such as ${EXTEN} are left alone.
VARS='$SIP_DOMAIN $PUBLIC_IP $WA_BUSINESS_NUMBER $META_SIP_PASSWORD $BACKEND_URL $CALLING_INTERNAL_SECRET $AMI_SECRET $RTP_START $RTP_END $RECORD_CALLS $DEVICE_WAIT_SECONDS'
for f in /etc/asterisk-templates/*.conf; do
  envsubst "$VARS" < "$f" > "/etc/asterisk/$(basename "$f")"
done

CERT_DIR="/etc/letsencrypt/live/${SIP_DOMAIN}"
if [ ! -r "$CERT_DIR/fullchain.pem" ] || [ ! -r "$CERT_DIR/privkey.pem" ]; then
  echo "FATAL: certificate not found in $CERT_DIR (run certbot first, see DEPLOY.md)" >&2; exit 1
fi
cp -L "$CERT_DIR/fullchain.pem" /var/lib/asterisk/certs/fullchain.pem
cp -L "$CERT_DIR/privkey.pem" /var/lib/asterisk/certs/privkey.pem

# Files written by the backend (staff accounts). Create safe placeholders until the backend writes them.
GEN=/etc/asterisk/generated
mkdir -p "$GEN"
[ -s "$GEN/pjsip_users.conf" ] || printf '; placeholder: the backend has not written staff accounts yet\n' > "$GEN/pjsip_users.conf"
[ -s "$GEN/extensions_users.conf" ] || printf '[users-fallback]\nexten => s,1,Return()\n' > "$GEN/extensions_users.conf"

chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk
chmod 640 /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf /etc/asterisk/manager.conf
chmod 600 /var/lib/asterisk/certs/privkey.pem

exec "$@"
