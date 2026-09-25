@echo off
rem
rem The USB backend: an OnlyKey on USB holding the signing key - a physical
rem key, or the Raspberry Pi presenting the emulator as a USB device.
rem
rem OnlyKeyBackend runs whatever OKSIGN_CMD names, with no arguments, so the
rem wrapper supplies them. OKSIGN_PRESSER (pi / human) is read from the
rem environment - see presser.js.
rem
node "%~dp0sign-usb.js"
