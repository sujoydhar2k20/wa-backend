#!/bin/sh
# Install: cp bjs-asterisk-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/ && chmod 755 it
# Certbot runs this after renewing a certificate. Asterisk only reads the certificate when its
# container starts, so mark that a reload is needed; the nightly cron job (bjs-asterisk-cert)
# recreates the container at 03:30 when calls are unlikely, instead of cutting a call now.
SIP_DOMAIN="lk.biswakarmagold.com"
case " $RENEWED_DOMAINS " in
  *" $SIP_DOMAIN "*) mkdir -p /var/lib/bjs-calls && date -u +%FT%TZ > /var/lib/bjs-calls/cert-renewed ;;
esac
exit 0
