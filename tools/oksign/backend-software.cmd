@echo off
rem
rem The software backend, as a one-element command line.
rem
rem OnlyKeyBackend runs whatever OKSIGN_CMD names with no arguments, because
rem passing arguments through ProcessBuilder on Windows is a quoting problem
rem nobody needs. So each backend gets a wrapper like this, and the wrapper
rem supplies its own arguments.
rem
rem Reads OKSIGN_SOFTWARE_KEY from the environment; see backend-software.js.
rem
node "%~dp0backend-software.js"
