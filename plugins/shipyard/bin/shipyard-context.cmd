@echo off
REM Windows wrapper for shipyard-context.mjs.
REM Skills invoke `shipyard-context` as a bare command; PATH lookup finds this
REM file on Windows (PATHEXT includes .cmd) and shipyard-context on Unix.
REM
REM LIMITATION: %* does not preserve quoted arguments containing spaces or
REM special characters (& | < > ^ "). Shipyard's own skills do not pass
REM such arguments, but if you invoke shipyard-context manually with a path
REM containing spaces, quote it carefully or set CLAUDE_PLUGIN_DATA to
REM avoid passing the path on the command line.
node "%~dp0shipyard-context.mjs" %*
