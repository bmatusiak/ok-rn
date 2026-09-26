"""
Run python-onlykey's hardware test scripts over Bluetooth, with the Pi pressing.

    python tools/python_onlykey_ble.py unlock        (a locked key: the PIN only)
    python tools/python_onlykey_ble.py configmode    (an unlocked key: hold 6, PIN)
    python tools/python_onlykey_ble.py run <MAC> <script.py> [<script.py> ...]
    OKRUN_LOCAL=1 python tools/python_onlykey_ble.py run usb <script.py> ...
                                                (on the Pi, USB via its UHID bridge)

Run it with python-onlykey's venv (python-onlykey/.venv), whose editable install
is the feature/ble-transport checkout - that is where BleTransport comes from.
The scripts themselves come from the upgrade-to-python3 worktree.

## The chain

    this PC --BLE--> phone (ok-rn's vendor GATT service) --USB--> Pi emulator

ok-rn relays the vendor service to whichever key it has selected, so with the
Pi on the phone's USB and "Hard Key" selected, python-onlykey is talking to the
Pi's emulator. The emulator's slots are disposable, which these scripts need:
each one writes a fresh key into slot 1.

## Why a runner, and not edits to the scripts

The scripts are python-onlykey's own, and they are written for a person at a
USB key: `OnlyKey()` opens USB, and `input()` waits while the person types the
three-digit challenge the script printed. Neither belongs in the scripts'
upgrade to Python 3 (that branch stays a clean diff), so both are supplied
from out here:

  OnlyKey()  becomes OnlyKey(connect=False) with a BleTransport attached
  input()    presses the last challenge the script printed, on the Pi, with
             emulator/bin/press.js - the non-debug path, a finger standing in

## Config mode is required, and the scripts do not enter it

OKSETPRIV is refused outside config mode on every 3.0.x release and on
0c-coder's master (okcore.cpp `case OKSETPRIV`: configmode == true, or first
use). The scripts never enter it and never check the reply, so without it
their decrypt runs against whatever slot 1 already held and fails in a
misleading way. `configmode` does it once for the whole run: hold button 6
for 80 ticks (the library's enterConfigMode: 72 plus margin), then the PIN.
Config mode lasts until the key restarts.

## PIN presses are checked one by one

Each digit is pressed on its own and confirmed against the firmware's own
"Number of keys entered" count in the daemon log before the next. A batch of
seven presses once delivered four (press.js detached mid-run), and a partial
entry that times out COUNTS as a wrong PIN - 2026-09-25 cost the emulator two
attempts that way. The count has a trailing CR from the firmware; strip it.
"""
import builtins
import os
import io
import re
import subprocess
import sys
import time

PI = '192.168.51.162'
PI_EMULATOR = '~/projects/ok-firmware/node-onlykey-emulator'
PI_LOG = '~/okemu-daemon.log'
PIN = '1111111'   # onlykey-testing's PINS.primary, which apk-signer provisioned
CONFIG_HOLD = '6#80'


# OKRUN_LOCAL=1 when this runs ON the Pi: the same commands, without ssh.
LOCAL = os.environ.get('OKRUN_LOCAL') == '1'


def ssh(cmd, timeout=60):
    argv = ['bash', '-c', cmd] if LOCAL else         ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', PI, cmd]
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout).stdout


def press(spec):
    ssh(f'cd {PI_EMULATOR} && timeout 15 node emulator/bin/press.js {spec} >/dev/null 2>&1')


def log_lines():
    return int(ssh(f'wc -l < {PI_LOG}').strip() or 0)


def keys_entered(since):
    out = ssh(f'awk "NR>{since} && /Number of keys entered/ {{v=\\$NF}} END {{print v}}" {PI_LOG}')
    digits = re.sub(r'\D', '', out)
    return int(digits) if digits else 0


def enter_pin():
    mark = log_lines()
    for n, digit in enumerate(PIN, start=1):
        press(digit)
        time.sleep(1.5)
        if n < len(PIN) and keys_entered(mark) != n:
            sys.exit(f'PIN digit {n} did not register - stopping before a partial entry is spent')
    time.sleep(2)
    tail = ssh(f'awk "NR>{mark}" {PI_LOG} | grep -a UNLOCKED | tail -1')
    print('PIN entered;', 'UNLOCKED seen' if 'UNLOCKED' in tail else 'no UNLOCKED yet')


def restart():
    ssh("kill $(pgrep -f '^node emulator/bin/daemon.js')")
    time.sleep(10)   # the supervisor loop brings it back; the phone re-attaches


def configmode():
    print('holding button 6 for config mode...')
    press(CONFIG_HOLD)
    time.sleep(3)
    enter_pin()


class Tee(io.TextIOBase):
    """stdout that also remembers what the script printed, to find its challenge."""

    def __init__(self, out):
        self.out, self.seen = out, ''

    def write(self, s):
        self.seen = (self.seen + s)[-4000:]
        return self.out.write(s)

    def flush(self):
        self.out.flush()


def run(mac, script):
    import runpy
    usb = mac == 'usb'
    if usb:
        # USB on the Pi, against the emulator's UHID bridge. pip's `hid` is
        # the libusb build, which sees only real USB devices; a UHID device
        # has no USB parent, and only the hidraw build finds it. A real key
        # on a real port would not need this.
        import hidraw
        sys.modules['hid'] = hidraw
    import onlykey

    real = onlykey.OnlyKey
    opened = []

    def over_ble(*args, **kwargs):
        from onlykey.transports import BleTransport
        ok = real(connect=False)
        ok._hid = BleTransport.connect(mac)
        opened.append(ok)
        return ok

    def over_usb(*args, **kwargs):
        ok = real(*args, **kwargs)
        opened.append(ok)
        return ok

    onlykey.OnlyKey = over_usb if usb else over_ble
    tee = Tee(sys.stdout)
    sys.stdout = tee

    def answer_challenge(prompt=''):
        last = tee.seen.strip().splitlines()[-1] if tee.seen.strip() else ''
        if 'slot number' in last:
            # rsa_decrypt_testkey uses whatever key a slot already holds.
            slot = os.environ.get('OK_SLOT', '1')
            print(f'[runner] answering the slot prompt: {slot}')
            return slot
        if 'Restart the OnlyKey' in last:
            # The scripts' pause between loading a key (config mode) and using
            # it (not config mode). The Pi stands in for the unplug and the PIN.
            print('[runner] restarting the emulator and entering the PIN on the Pi')
            restart()
            enter_pin()
            time.sleep(3)
            # The phone re-attaches to the restarted key and asks its status;
            # that reply ("LOCKED...") is relayed over Bluetooth too and would
            # be the script's next read. Drop anything queued meanwhile.
            for ok in opened:
                if usb:
                    # The restart recreated the device; the old handle is dead.
                    ok._hid.close()
                    ok._connect()
                    ok.read_string(timeout_ms=500)   # the reconnect's status line
                else:
                    ok._hid.drain()
            return ''
        found = re.findall(r'^\s*([1-6]) ([1-6]) ([1-6])\s*$', tee.seen, re.M)
        if not found:
            raise RuntimeError('input() called, but no challenge code was printed')
        digits = found[-1]
        print(f'[runner] pressing the challenge on the Pi: {" ".join(digits)}')
        for d in digits:
            press(d)
            time.sleep(0.8)
        return ''

    builtins.input = answer_challenge
    runpy.run_path(script, run_name='__main__')


if __name__ == '__main__':
    if sys.argv[1:2] == ['configmode']:
        configmode()
    elif sys.argv[1:2] == ['unlock']:
        enter_pin()
    elif sys.argv[1:2] == ['run'] and len(sys.argv) >= 4:
        mac = sys.argv[2]
        for script in sys.argv[3:]:
            print(f'\n===== {script}')
            # A script that loads a key needs config mode, and ends restarted
            # and unlocked, so config mode is entered again before every one.
            # One that only uses a key already there (rsa_decrypt_testkey)
            # must NOT be in config mode: OKGETPUBKEY and OKDECRYPT are
            # refused there.
            source = open(script, encoding='utf-8').read()
            if re.search(r'setkey\(|load_rsa_key\(|OKSETPRIV', source):
                configmode()
            code =subprocess.run([sys.executable, __file__, 'one', mac, script]).returncode
            print(f'===== {script}: {"PASS" if code == 0 else f"FAIL (exit {code})"}')
    elif sys.argv[1:2] == ['one']:
        run(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
        sys.exit(2)
