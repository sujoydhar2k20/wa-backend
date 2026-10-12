'use strict';

/**
 * Minimal Asterisk Manager Interface client: opens a connection, logs in, runs one
 * "Command" action, logs off. Used only to reload config after staff accounts change.
 * AMI listens on 127.0.0.1 only (see deploy/asterisk/config/manager.conf).
 */
const net = require('net');

function amiCommand({ host, port, username, secret }, command, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!secret) return reject(new Error('ASTERISK_AMI_SECRET is not set'));
    const sock = net.createConnection({ host, port });
    let buf = '';
    let stage = 'banner';
    const done = (err, val) => { clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => done(new Error('AMI timeout')), timeoutMs);
    const send = (fields) => sock.write(`${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);

    sock.on('error', (e) => done(e));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (stage === 'banner' && buf.includes('\r\n')) {
        buf = buf.slice(buf.indexOf('\r\n') + 2);
        stage = 'login';
        send({ Action: 'Login', ActionID: 'l1', Username: username, Secret: secret, Events: 'off' });
      }
      let idx;
      while ((idx = buf.indexOf('\r\n\r\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 4);
        if (stage === 'login' && /ActionID: l1/.test(block)) {
          if (!/Response: Success/.test(block)) return done(new Error('AMI login failed'));
          stage = 'command';
          send({ Action: 'Command', ActionID: 'c1', Command: command });
        } else if (stage === 'command' && /ActionID: c1/.test(block)) {
          stage = 'logoff';
          send({ Action: 'Logoff', ActionID: 'o1' });
          if (!/Response: (Success|Follows)/.test(block)) return done(new Error(`AMI command failed: ${block.split('\r\n').find((l) => l.startsWith('Message:')) || ''}`));
          return done(null, block.split('\r\n').filter((l) => l.startsWith('Output:')).map((l) => l.slice(8)).join('\n'));
        }
      }
    });
  });
}

module.exports = { amiCommand };
