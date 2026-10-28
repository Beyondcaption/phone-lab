'use strict';
// Portweiterleitung über usbmuxd (Apples USB-Dienst), ersetzt iproxy. Kein Netzwerk, nur das USB-Kabel.
// forward(udid, devicePort, localPort) öffnet 127.0.0.1:localPort und reicht jede Verbindung zum iPhone durch.
const net = require('net');
const plist = require('./plist');

const SOCK = '/var/run/usbmuxd';
let tag = 0;

function request(sock, msg) {
  const body = Buffer.from(plist.build(msg));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0); head.writeUInt32LE(1, 4); head.writeUInt32LE(8, 8); head.writeUInt32LE(++tag, 12);
  sock.write(Buffer.concat([head, body]));
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 16) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < len) return;
      sock.off('data', onData);
      resolve(plist.parse(buf.subarray(16, len).toString()));
    };
    sock.on('data', onData); sock.once('error', reject);
  });
}

const base = { ClientVersionString: 'phone-lab', ProgName: 'phone-lab', kLibUSBMuxVersion: 3 };

async function listDevices() {
  const sock = net.connect(SOCK);
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  const res = await request(sock, { ...base, MessageType: 'ListDevices' });
  sock.end();
  return (res.DeviceList || []).filter(d => d.Properties.ConnectionType === 'USB')
    .map(d => ({ id: d.DeviceID, udid: d.Properties.SerialNumber }));
}

async function connect(udid, port) {
  const dev = (await listDevices()).find(d => d.udid === udid);
  if (!dev) throw new Error(`usbmuxd: Gerät ${udid} nicht per USB verbunden`);
  const sock = net.connect(SOCK);
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  const res = await request(sock, { ...base, MessageType: 'Connect', DeviceID: dev.id, PortNumber: ((port & 0xff) << 8) | (port >> 8) });
  if (res.Number !== 0) { sock.destroy(); throw new Error(`usbmuxd: Verbindung zu Port ${port} abgelehnt (${res.Number})`); }
  return sock; // ab hier roher TCP-Strom zum iPhone
}

function forward(udid, devicePort, localPort) {
  const server = net.createServer(async client => {
    try {
      const dev = await connect(udid, devicePort);
      client.pipe(dev).pipe(client);
      dev.on('error', () => client.destroy()); client.on('error', () => dev.destroy());
    } catch { client.destroy(); }
  });
  server.listen(localPort, '127.0.0.1');
  return server;
}

module.exports = { listDevices, connect, forward };

if (require.main === module) { // Selbsttest: node usbmux.js  -> listet USB-Geräte
  listDevices().then(l => { console.log(l); if (!l.length) process.exitCode = 1; }, e => { console.error(e.message); process.exitCode = 1; });
}
