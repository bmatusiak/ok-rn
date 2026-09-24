"""
Drive the phone's vendor GATT service from this PC, and TIME it.

    python tools/vendor_probe.py [MAC]

Two things at once:
  1. proof that a host can reach IFACE.VENDOR over BLE end to end
  2. the round-trip measurement python-onlykey's timeout_ms=100 default needs

Sends OKCONNECT (0xe4), which the key answers with its status string - the same
exchange the app logs as "OKCONNECT ok". The authenticator must be advertising
and the phone already bonded to this host: the request characteristic is
WRITE_ENCRYPTED, so an unbonded write is refused.

## use_cached_services=False IS LOAD-BEARING

Without it this reports NO VENDOR SERVICE against a phone that is plainly
serving one. WinRT answers GetGattServicesAsync from a per-bond cache, and with
the default it returned three services - 0x1800, 0x1801 and one belonging to
another app - with neither 0xFFFD nor the vendor service among them, while
`node tools/btcache.js <mac>` showed Windows had all three cached as PnP nodes.
Two different caches, disagreeing. Uncached discovery returned six and the
vendor service was there.

Same family as the hazard the GATT server is built around - a host reads a
service list once and serves it forever - and it is worth knowing that a HOST
SCRIPT has its own copy of that problem, separate from the bond.

## Measured 2026-09-24, Pixel 6a -> this PC, ATT MTU 23

    OKCONNECT: 64 bytes in 4 fragments
    written in 11 ms
    REPLY after 181 ms (170 ms after the last write)
    'UNLOCKEDv3.0.5-testc'

END TO END: the host wrote, the phone relayed to IFACE.VENDOR, the soft
firmware answered, and the answer came back.

**181 ms is over python-onlykey's 100 ms default read timeout**
(client.py:404), so the risk the BLE plan flagged as possibly theoretical is
real on a healthy link. The reply is almost all of it - 170 of the 181 ms came
after the last write - and at MTU 23 a 64-byte report is FOUR notifications,
each paced by onNotificationSent against a connection interval. Fragment count
times the interval is the cost, which is a thing a larger MTU changes.
"""
import asyncio, sys, time
from bleak import BleakClient, BleakScanner

ADDR = sys.argv[1] if len(sys.argv) > 1 else "24:29:34:86:EA:AF"
SVC = "0c0ffab0-9f1e-4b1d-9c6a-0f0e1d2c3b4a"
REQ = "0c0ffab1-9f1e-4b1d-9c6a-0f0e1d2c3b4a"
RSP = "0c0ffab2-9f1e-4b1d-9c6a-0f0e1d2c3b4a"
CMD = 0x83
ROUNDS = 10

def fragment(payload, size):
    out = [bytes([CMD | 0x80, (len(payload) >> 8) & 0xff, len(payload) & 0xff]) + payload[:size - 3]]
    off, seq = size - 3, 0
    while off < len(payload):
        out.append(bytes([seq]) + payload[off:off + size - 1])
        off += size - 1
        seq += 1
    return out

class Assembler:
    """Mirror of CtapBleFramer's reassembly, host side."""
    def __init__(self): self.buf, self.want = bytearray(), 0
    def push(self, data):
        if data[0] & 0x80:
            self.want = (data[1] << 8) | data[2]
            self.buf = bytearray(data[3:])
        else:
            self.buf += data[1:]
        return bytes(self.buf) if len(self.buf) >= self.want else None

async def main():
    dev = await BleakScanner.find_device_by_address(ADDR, timeout=15)
    if dev is None:
        print(f"NOT FOUND: {ADDR} is not advertising - is the authenticator on?")
        return 1
    print(f"found {dev.name} {dev.address}")

    replies, asm = asyncio.Queue(), Assembler()
    notifies = []

    async with BleakClient(dev, use_cached_services=False) as c:
        names = [s.uuid.lower() for s in c.services]
        print(f"services: {len(names)}")
        if SVC not in names:
            print(f"NO VENDOR SERVICE. cached table: {names}")
            return 1
        print("vendor service present")

        def on_notify(_, data):
            notifies.append((time.perf_counter(), len(data)))
            msg = asm.push(bytes(data))
            if msg is not None:
                replies.put_nowait((time.perf_counter(), msg))

        await c.start_notify(RSP, on_notify)
        print("subscribed to the response characteristic")

        payload = bytes([0xff, 0xff, 0xff, 0xff, 0xe4] + [0] * 59)
        frags = fragment(payload, 20)
        print(f"OKCONNECT: {len(payload)} bytes in {len(frags)} write fragments")

        times = []
        for run in range(ROUNDS):
            notifies.clear()
            t0 = time.perf_counter()
            for f in frags:
                await c.write_gatt_char(REQ, f, response=False)
            sent = time.perf_counter()
            try:
                t, msg = await asyncio.wait_for(replies.get(), timeout=10)
            except asyncio.TimeoutError:
                print(f"  #{run}: NO REPLY in 10 s")
                return 1
            rtt = (t - t0) * 1000
            times.append(rtt)
            text = msg.decode('latin-1').rstrip(chr(0))
            print(f"  #{run}: {rtt:6.1f} ms  write {(sent - t0) * 1000:4.1f} ms  "
                  f"{len(notifies)} notif  {len(msg)}B  {text!r}")

        times.sort()
        n = len(times)
        print("")
        print(f"min {times[0]:.0f}  median {times[n // 2]:.0f}  max {times[-1]:.0f} ms"
              f"   over 100 ms: {sum(1 for x in times if x > 100)}/{n}")
        await c.stop_notify(RSP)
    return 0

sys.exit(asyncio.run(main()))
