#!/usr/bin/env bash
#
# Exercises the addon's CGIs against a throwaway copy of the addon tree. Needs tclsh, nothing
# else - no CCU, no web server.
#
#   addon/test/cgi-test.sh

set -uo pipefail

cd "$(dirname "$0")/../.."
command -v tclsh >/dev/null || {
    echo "tclsh is required" >&2
    exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TREE="$TMP/hm2mqtt"
mkdir -p "$TREE/etc" "$TREE/var" "$TREE/app/scripts"
cp -a addon/files/hm2mqtt/www "$TREE/www"
cat > "$TREE/etc/hm2mqtt.env" <<'ENV'
# a comment that must survive a write
HM2MQTT_NAME=hm
HM2MQTT_MQTT_URL=mqtt://broker:1883
HM2MQTT_MQTT_PASSWORD=supersecret
ENV
cat > "$TREE/versions" <<'VERSIONS'
VERSION_ADDON=3.3.0-beta
NODE_VERSION=v24.18.1
VERSIONS
printf 'line one\nline two\n' > "$TREE/var/hm2mqtt.log"

export HM2MQTT_PID_FILE="$TMP/hm2mqtt.pid"
export HM2MQTT_RC_SCRIPT="$TMP/rc.d-hm2mqtt"
printf '#!/bin/sh\necho "rc.d called with $1"\n' > "$HM2MQTT_RC_SCRIPT"
chmod +x "$HM2MQTT_RC_SCRIPT"

failed=0
pass() { echo "  ok   - $1"; }
fail() {
    echo "  FAIL - $1"
    echo "         $2"
    failed=1
}

# cgi <script> <query> [stdin]
cgi() {
    QUERY_STRING="$2" tclsh addon/test/stub.tcl "$TREE/www/$1" <<<"${3:-}" 2>&1
}

echo "session"
out="$(HM2MQTT_TEST_SESSION=invalid cgi getconfig.cgi 'sid=@1234567890@')"
case "$out" in
    *'"error":"invalid session"'*) pass "an expired session is refused" ;;
    *) fail "an expired session is refused" "$out" ;;
esac
out="$(cgi getconfig.cgi 'sid=nonsense')"
case "$out" in
    *'invalid session'*) pass "a malformed sid is refused" ;;
    *) fail "a malformed sid is refused" "$out" ;;
esac
# the UI builds its query with URLSearchParams, which percent-encodes the @ of a session id
out="$(cgi getconfig.cgi 'sid=%401234567890%40')"
case "$out" in
    *'"HM2MQTT_NAME"'*) pass "a percent-encoded sid is accepted" ;;
    *) fail "a percent-encoded sid is accepted" "$out" ;;
esac

# the decoder must not execute what it decodes: the usual regsub+subst idiom would run this
out="$(cgi getconfig.cgi 'sid=%40%5Bexec%20touch%20%2Ftmp%2Fhm2mqtt-cgi-pwned%5D%40')"
if [ -e /tmp/hm2mqtt-cgi-pwned ]; then
    fail "a query string cannot execute commands" "the decoder ran [exec ...]"
    rm -f /tmp/hm2mqtt-cgi-pwned
else
    pass "a query string cannot execute commands"
fi
case "$out" in
    *'invalid session'*) pass "and such a sid is refused" ;;
    *) fail "and such a sid is refused" "$out" ;;
esac

echo "getconfig.cgi"
out="$(cgi getconfig.cgi 'sid=@1234567890@')"
case "$out" in
    *'"HM2MQTT_NAME":"hm"'*) pass "returns the configuration as JSON" ;;
    *) fail "returns the configuration as JSON" "$out" ;;
esac
case "$out" in
    *supersecret*) fail "never sends a password to the browser" "$out" ;;
    *'"HM2MQTT_MQTT_PASSWORD":"********"'*) pass "never sends a password to the browser" ;;
    *) fail "never sends a password to the browser" "$out" ;;
esac

echo "setconfig.cgi"
body=$'# a comment that must survive a write\nHM2MQTT_NAME=haus\nHM2MQTT_MQTT_URL=mqtt://other:1883\nHM2MQTT_MQTT_PASSWORD=********\n'
out="$(cgi setconfig.cgi 'sid=@1234567890@' "$body")"
case "$out" in
    *'"ok":true'*) pass "writes a valid configuration" ;;
    *) fail "writes a valid configuration" "$out" ;;
esac
written="$(cat "$TREE/etc/hm2mqtt.env")"
case "$written" in
    *'HM2MQTT_NAME=haus'*) pass "stores the new value" ;;
    *) fail "stores the new value" "$written" ;;
esac
case "$written" in
    *'HM2MQTT_MQTT_PASSWORD=supersecret'*) pass "keeps the stored password behind the placeholder" ;;
    *) fail "keeps the stored password behind the placeholder" "$written" ;;
esac
case "$written" in
    *'# a comment that must survive a write'*) pass "keeps comments" ;;
    *) fail "keeps comments" "$written" ;;
esac

out="$(cgi setconfig.cgi 'sid=@1234567890@' $'HM2MQTT_NAME=haus\nrm -rf /\n')"
case "$out" in
    *'"error"'*) pass "refuses a line that is not HM2MQTT_KEY=value" ;;
    *) fail "refuses a line that is not HM2MQTT_KEY=value" "$out" ;;
esac
case "$(cat "$TREE/etc/hm2mqtt.env")" in
    *'HM2MQTT_NAME=haus'*) pass "leaves the file untouched when a line is refused" ;;
    *) fail "leaves the file untouched when a line is refused" "$(cat "$TREE/etc/hm2mqtt.env")" ;;
esac

echo "service.cgi"
out="$(cgi service.cgi 'sid=@1234567890@&cmd=status')"
case "$out" in
    *'"running":false'*) pass "reports a stopped service" ;;
    *) fail "reports a stopped service" "$out" ;;
esac
case "$out" in
    *'"VERSION_ADDON":"3.3.0-beta"'*) pass "reports the addon version" ;;
    *) fail "reports the addon version" "$out" ;;
esac
out="$(cgi service.cgi 'sid=@1234567890@&cmd=restart')"
case "$out" in
    *'rc.d called with restart'*) pass "passes start/stop/restart to the rc.d script" ;;
    *) fail "passes start/stop/restart to the rc.d script" "$out" ;;
esac
out="$(cgi service.cgi 'sid=@1234567890@&cmd=havoc')"
case "$out" in
    *'unknown command'*) pass "refuses an unknown command" ;;
    *) fail "refuses an unknown command" "$out" ;;
esac

echo "log.cgi"
out="$(cgi log.cgi 'sid=@1234567890@')"
case "$out" in
    *'line two'*) pass "returns the log" ;;
    *) fail "returns the log" "$out" ;;
esac

echo "api.cgi"
out="$(cgi api.cgi 'sid=@1234567890@&cmd=rm')"
case "$out" in
    *'unknown command'*) pass "only allows its four commands" ;;
    *) fail "only allows its four commands" "$out" ;;
esac

echo "the addon writes only inside its own directory"
rc=addon/files/hm2mqtt/rc.d/hm2mqtt
case "$(cat $rc)" in
    *'export HOME="$ADDON_DIR"'*) pass "HOME is pinned to the addon directory" ;;
    *) fail "HOME is pinned to the addon directory" "rc.d does not export HOME" ;;
esac
case "$(cat $rc)" in
    *'export HM2MQTT_STATE_DIR="$ADDON_DIR/var"'*) pass "the state directory is pinned to var/" ;;
    *) fail "the state directory is pinned to var/" "rc.d does not export HM2MQTT_STATE_DIR" ;;
esac
case "$(cat addon/files/hm2mqtt/etc/default.env)" in
    *'HM2MQTT_STATE_DIR=/usr/local/addons/hm2mqtt/var'*) pass "default.env ships the state directory" ;;
    *) fail "default.env ships the state directory" "not set in default.env" ;;
esac
# a path outside the addon in the shipped files is how the /root/.hm2mqtt crash happened
outside="$(grep -rnE '(^|[^a-zA-Z0-9_/])(/root|/home|/var/lib|~)/' addon/files/ | grep -v '^addon/files/hm2mqtt/www/index.html' || true)"
if [ -z "$outside" ]; then
    pass "no shipped file points outside /usr/local"
else
    fail "no shipped file points outside /usr/local" "$outside"
fi

echo
if [ "$failed" = 0 ]; then
    echo "all CGI tests passed"
else
    echo "CGI tests failed"
fi
exit $failed
