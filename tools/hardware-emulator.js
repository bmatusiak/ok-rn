#!/usr/bin/env node
/**
 * TCP stand-in for a USB HID device.
 *
 * The Android emulator runs in QEMU and cannot pass host USB endpoints through
 * to the guest, so the app's TCP transport talks to this instead. It speaks the
 * same fixed-width report stream the real device does, and answers CTAPHID_INIT
 * so the app's framing layer can be exercised end to end.
 *
 *   node tools/hardware-emulator.js [options]
 *
 * Options:
 *   --port <n>          listen port                    (default 9000)
 *   --host <addr>       bind address                   (default 0.0.0.0)
 *   --report-size <n>   report width in bytes          (default 64)
 *   --heartbeat <ms>    unsolicited report interval,
 *                       0 disables                     (default 0)
 *   --fail-checksum     corrupt the last byte of every response
 *   --drop-rate <0..1>  fraction of responses to drop silently
 *   --drop-after <n>    kill the connection after n inbound reports
 *   --latency <ms>      delay before each response     (default 0)
 *   --quiet             only log errors
 *
 * EXPLAINER/!.md section 5 asks for these fault switches so the RN error
 * boundaries can be tested deliberately rather than by unplugging cables.
 */

const net = require('net');

// ------------------------------------------------------------------- options

function parseArgs(argv) {
  const opts = {
    port: 9000,
    host: '0.0.0.0',
    reportSize: 64,
    heartbeat: 0,
    failChecksum: false,
    dropRate: 0,
    dropAfter: 0,
    latency: 0,
    quiet: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      return value;
    };
    switch (arg) {
      case '--port': opts.port = Number(next()); break;
      case '--host': opts.host = next(); break;
      case '--report-size': opts.reportSize = Number(next()); break;
      case '--heartbeat': opts.heartbeat = Number(next()); break;
      case '--fail-checksum': opts.failChecksum = true; break;
      case '--drop-rate': opts.dropRate = Number(next()); break;
      case '--drop-after': opts.dropAfter = Number(next()); break;
      case '--latency': opts.latency = Number(next()); break;
      case '--quiet': opts.quiet = true; break;
      case '--help':
      case '-h':
        console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);

// --------------------------------------------------------------- CTAPHID bits

const CTAPHID = {
  PING: 0x01,
  MSG: 0x03,
  INIT: 0x06,
  CBOR: 0x10,
  ERROR: 0x3f,
};

const BROADCAST_CID = 0xffffffff;
/** Channel id handed out in response to CTAPHID_INIT. */
const ASSIGNED_CID = 0x11223344;

function hex(buf) {
  return Array.from(buf)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
}

/** Builds one INIT packet: [CID:4][CMD|0x80][BCNTH][BCNTL][data...] */
function initPacket(cid, cmd, data, size) {
  const packet = Buffer.alloc(size);
  packet.writeUInt32BE(cid >>> 0, 0);
  packet[4] = cmd | 0x80;
  packet.writeUInt16BE(data.length, 5);
  data.copy(packet, 7, 0, Math.min(data.length, size - 7));
  return packet;
}

/**
 * CTAPHID_INIT response: the 8-byte nonce echoed back, the newly allocated
 * channel id, protocol/version bytes, and a capability flags byte.
 */
function buildInitResponse(nonce, size) {
  const body = Buffer.alloc(17);
  nonce.copy(body, 0, 0, 8);
  body.writeUInt32BE(ASSIGNED_CID, 8);
  body[12] = 2;    // CTAPHID protocol version
  body[13] = 1;    // device major
  body[14] = 0;    // device minor
  body[15] = 0;    // device build
  body[16] = 0x04; // CAPABILITY_CBOR
  return initPacket(BROADCAST_CID, CTAPHID.INIT, body, size);
}

// -------------------------------------------------------------------- server

let clientSeq = 0;

const server = net.createServer(socket => {
  const id = ++clientSeq;
  const tag = `[client ${id}]`;
  let inboundCount = 0;
  let heartbeatTimer = null;

  const log = (...args) => {
    if (!opts.quiet) console.log(tag, ...args);
  };

  log(`connected from ${socket.remoteAddress}:${socket.remotePort}`);
  socket.setNoDelay(true);

  const send = buf => {
    if (opts.dropRate > 0 && Math.random() < opts.dropRate) {
      log('DROP (injected)', hex(buf.subarray(0, 8)), '...');
      return;
    }
    const out = Buffer.from(buf);
    if (opts.failChecksum && out.length > 0) {
      // Flip the trailing byte so the app sees a payload that fails validation.
      out[out.length - 1] = out[out.length - 1] ^ 0xff;
      log('CORRUPT (injected) trailing byte');
    }
    const write = () => {
      if (!socket.destroyed) {
        socket.write(out);
        log('-> out', hex(out.subarray(0, 16)), out.length > 16 ? '...' : '');
      }
    };
    if (opts.latency > 0) setTimeout(write, opts.latency);
    else write();
  };

  if (opts.heartbeat > 0) {
    heartbeatTimer = setInterval(() => {
      const report = Buffer.alloc(opts.reportSize);
      report[0] = 0x01;
      report[1] = Math.floor(Math.random() * 256);
      report[2] = 0xaa;
      report[3] = 0x55;
      send(report);
    }, opts.heartbeat);
  }

  socket.on('data', chunk => {
    // The app writes one fixed-width report at a time, but TCP may coalesce
    // them, so slice the stream back into reports before interpreting.
    for (let offset = 0; offset < chunk.length; offset += opts.reportSize) {
      const report = chunk.subarray(offset, offset + opts.reportSize);
      inboundCount += 1;
      log('<- in ', hex(report.subarray(0, 16)), report.length > 16 ? '...' : '');

      if (opts.dropAfter > 0 && inboundCount >= opts.dropAfter) {
        log(`DISCONNECT (injected) after ${inboundCount} reports`);
        socket.destroy();
        return;
      }

      if (report.length < 7) continue;
      const cmd = report[4];
      if ((cmd & 0x80) === 0) continue; // continuation packet, nothing to answer

      const command = cmd & 0x7f;
      const cid = report.readUInt32BE(0);
      const len = report.readUInt16BE(5);

      if (command === CTAPHID.INIT) {
        const nonce = report.subarray(7, 15);
        log(`CTAPHID_INIT nonce=${hex(nonce)} -> cid 0x${ASSIGNED_CID.toString(16)}`);
        send(buildInitResponse(nonce, opts.reportSize));
      } else if (command === CTAPHID.PING) {
        log('CTAPHID_PING -> echo');
        send(initPacket(cid, CTAPHID.PING, report.subarray(7, 7 + Math.min(len, opts.reportSize - 7)), opts.reportSize));
      } else if (command === CTAPHID.CBOR || command === CTAPHID.MSG) {
        // Not a real authenticator: acknowledge with CTAP2 status OK (0x00).
        log(`command 0x${command.toString(16)} -> CTAP2_OK`);
        send(initPacket(cid, command, Buffer.from([0x00]), opts.reportSize));
      } else {
        log(`command 0x${command.toString(16)} -> CTAPHID_ERROR (invalid command)`);
        send(initPacket(cid, CTAPHID.ERROR, Buffer.from([0x01]), opts.reportSize));
      }
    }
  });

  socket.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    log('disconnected');
  });

  socket.on('error', err => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    console.error(tag, 'socket error:', err.message);
  });
});

server.on('error', err => {
  console.error('server error:', err.message);
  process.exit(1);
});

server.listen(opts.port, opts.host, () => {
  console.log(`hardware-emulator listening on ${opts.host}:${opts.port}`);
  console.log(`report size ${opts.reportSize} bytes`);
  console.log('Android emulator reaches this host at 10.0.2.2');
  const faults = [
    opts.failChecksum && 'corrupt-responses',
    opts.dropRate > 0 && `drop-rate=${opts.dropRate}`,
    opts.dropAfter > 0 && `drop-after=${opts.dropAfter}`,
    opts.latency > 0 && `latency=${opts.latency}ms`,
    opts.heartbeat > 0 && `heartbeat=${opts.heartbeat}ms`,
  ].filter(Boolean);
  console.log(faults.length ? `fault injection: ${faults.join(', ')}` : 'fault injection: off');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\nshutting down');
  server.close(() => process.exit(0));
});
