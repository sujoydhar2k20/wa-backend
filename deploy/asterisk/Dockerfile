# Asterisk 22 LTS for WhatsApp Business Calling over SIP (TLS + SDES-SRTP + Opus).
# Built from the official source tarball. Free/open source (GPLv2); codec_opus is Sangoma's free binary module.
ARG ASTERISK_VERSION=22.11.0

FROM debian:bookworm-slim AS build
ARG ASTERISK_VERSION
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates wget bzip2 patch pkg-config python3 \
      libedit-dev libjansson-dev libxml2-dev uuid-dev libsqlite3-dev libssl-dev \
      libsrtp2-dev libcurl4-openssl-dev libopus-dev libopusfile-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src
RUN wget -q https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.tar.gz \
    && tar xzf asterisk-${ASTERISK_VERSION}.tar.gz && rm asterisk-${ASTERISK_VERSION}.tar.gz
WORKDIR /usr/src/asterisk-${ASTERISK_VERSION}
RUN ./configure --with-pjproject-bundled --with-srtp --libdir=/usr/lib > /tmp/configure.log
RUN make menuselect.makeopts \
    && menuselect/menuselect --disable BUILD_NATIVE menuselect.makeopts \
    && menuselect/menuselect --enable res_srtp menuselect.makeopts \
    && menuselect/menuselect --enable CORE-SOUNDS-EN-GSM menuselect.makeopts
RUN make -j"$(nproc)" > /tmp/make.log 2>&1 || (tail -50 /tmp/make.log; exit 1)
RUN make install DESTDIR=/out > /tmp/install.log 2>&1 || (tail -50 /tmp/install.log; exit 1)
# Sangoma's free Opus transcoder (binary, Digium EULA), pinned version, installed as its README describes.
ARG CODEC_OPUS=codec_opus-22.0_1.3.0-x86_64
RUN wget -q https://downloads.digium.com/pub/telephony/codec_opus/asterisk-22.0/x86-64/${CODEC_OPUS}.tar.gz \
    && tar xzf ${CODEC_OPUS}.tar.gz \
    && install -m 755 ${CODEC_OPUS}/codec_opus.so ${CODEC_OPUS}/format_ogg_opus.so /out/usr/lib/asterisk/modules/ \
    && mkdir -p /out/var/lib/asterisk/documentation/thirdparty \
    && install -m 644 ${CODEC_OPUS}/codec_opus_config-en_US.xml /out/var/lib/asterisk/documentation/thirdparty/ \
    && rm -rf ${CODEC_OPUS}*
RUN make samples DESTDIR=/out > /dev/null \
    && for m in res_srtp codec_opus res_pjsip res_pjsip_session chan_pjsip app_mixmonitor; do \
         test -f /out/usr/lib/asterisk/modules/$m.so || { echo "MISSING $m.so"; exit 1; }; done \
    && if [ -d /out/var/run ]; then mkdir -p /out/run && cp -a /out/var/run/. /out/run/ && rm -rf /out/var/run; fi

FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libedit2 libjansson4 libxml2 libuuid1 libsqlite3-0 libssl3 \
      libsrtp2-1 libcurl4 libopus0 libopusfile0 gettext-base procps tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r asterisk && useradd -r -g asterisk -d /var/lib/asterisk -s /usr/sbin/nologin asterisk
COPY --from=build /out/ /
RUN mkdir -p /etc/asterisk-templates /var/lib/asterisk/certs /var/spool/asterisk/monitor /var/log/asterisk /var/run/asterisk \
    && chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk
COPY config/ /etc/asterisk-templates/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["asterisk", "-f", "-U", "asterisk", "-G", "asterisk"]
