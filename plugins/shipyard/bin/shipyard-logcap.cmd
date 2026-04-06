@echo off
REM Windows wrapper for shipyard-logcap.mjs.
REM Skills invoke `shipyard-logcap` as a bare command; PATH lookup finds this
REM file on Windows (PATHEXT includes .cmd) and shipyard-logcap on Unix.
REM
REM LIMITATION: %* does not preserve quoted arguments containing spaces or
REM special characters (& | < > ^ "). If you need to wrap a command whose
REM arguments contain such characters, write a small .bat or .ps1 wrapper
REM around the command itself and invoke *that* via shipyard-logcap, or use
REM SHIPYARD_LOGCAP_MAX_SIZE / _MAX_FILES env vars to avoid passing bounds
REM on the command line.
node "%~dp0shipyard-logcap.mjs" %*
