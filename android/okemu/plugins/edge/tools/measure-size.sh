#!/usr/bin/env bash
# The plugin's byte cost on a HARD key's CPU (firmware.md §3.1), for AUDIT.md.
#
# Compiles src/okplugin_edge.cpp alone with the Teensy 1.6.5-r5 toolchain
# (Cortex-M4 Thumb, -Os, the firmware's flags) inside the toolchain image, and
# prints code / constants / RAM and each function's size. Run it on the Pi
# (the build station), from a copy of this folder:
#
#   scp -r ok-rn/android/okemu/plugins/edge 192.168.51.162:scratch/
#   ssh 192.168.51.162 'bash scratch/edge/tools/measure-size.sh'
#
# ARDUINO and LIBS default to the Pi's checkouts (3.1.0 libraries in ok-latest).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
ARDUINO="${ARDUINO:-$HOME/projects/ok-firmware/arduino-1.6.5-r5-teensy_127}"
LIBS="${LIBS:-$HOME/projects/ok-latest/libraries}"
FW="${FW:-$HOME/projects/ok-latest/OnlyKey-Firmware}"
out="$(mktemp -d)"
cp "$here"/src/okplugin_edge.* "$out"/
# /libs, not /lib: mounting over /lib hides the image's own loader
docker run --rm --platform linux/amd64 -v "$ARDUINO":/a:ro -v "$LIBS":/libs:ro -v "$FW":/fw:ro -v "$out":/src \
  onlykey/onlykey-firmware-toolchain bash -c '
    set -e
    B=/a/arduino-1.6.5-r5/hardware/tools/arm/bin
    INC="-I/src -I/fw -I/a/arduino-1.6.5-r5/hardware/teensy/avr/cores/teensy3"
    for d in /libs/*/ /libs/*/src/ /libs/fido2/*/; do [ -d "$d" ] && INC="$INC -I$d"; done
    $B/arm-none-eabi-g++ -c -Os -g0 -mcpu=cortex-m4 -mthumb -fno-exceptions -fno-rtti -felide-constructors -std=gnu++0x \
      -ffunction-sections -fdata-sections -D__MK66FX1M0__ -DTEENSYDUINO=127 -DARDUINO=10605 -DF_CPU=120000000 \
      -DLAYOUT_US_ENGLISH -DUSB_SERIAL_HID $INC /src/okplugin_edge.cpp -o /src/okplugin_edge.o
    $B/arm-none-eabi-size -A /src/okplugin_edge.o | awk "/^\.(text|rodata|data|bss)/ {split(\$1,a,\".\"); s[a[2]]+=\$2} END {printf \"code %d  constants %d  data %d  ram %d\n\", s[\"text\"], s[\"rodata\"], s[\"data\"], s[\"bss\"]}"
    echo "--- by symbol (bytes, T/t code, b RAM, r constants)"
    $B/arm-none-eabi-nm --size-sort -S -C /src/okplugin_edge.o | while read a s t n; do echo "$((16#$s)) $t $n"; done | sort -rn
  ' 2>&1 | grep -v '^WARNING: The requested image'
rm -rf "$out"
