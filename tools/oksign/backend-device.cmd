@echo off
rem
rem The real backend: an emulated OnlyKey holding the signing key.
rem
rem OnlyKeyBackend runs whatever OKSIGN_CMD names, with no arguments - Windows
rem quoting through ProcessBuilder is a problem worth not having - so the
rem wrapper supplies its own.
rem
rem sign.js provisions the device on first use if .local\storage has no key in
rem it, so there is no separate setup step for a fresh clone.
rem
node "%~dp0sign.js"
