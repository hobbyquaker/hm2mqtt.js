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

mkdir -p "$TREE/bin"
ln -sf "$(command -v node)" "$TREE/bin/node"
printf '{"ABC1234567:1": "Wohnzimmer Licht"}\n' > "$TREE/etc/names.json"

export HM2MQTT_ADDON_DIR="$TREE"
# a CCU unless a case says otherwise: no LITE= line, no occulited (the test host's own /VERSION and
# /usr/bin are never looked at)
printf 'VERSION=3.87.6\nPRODUCT=ccu3\n' > "$TMP/VERSION.ccu"
printf 'VERSION=3.89.11\nPRODUCT=ova\nVARIANT=lite\nLITE=1.0.0-dev.30\n' > "$TMP/VERSION.lite"
export HM2MQTT_VERSION_FILE="$TMP/VERSION.ccu"
export HM2MQTT_OCCULITED="$TMP/no-occulited"
export HM2MQTT_PID_FILE="$TMP/hm2mqtt.pid"
export HM2MQTT_RC_SCRIPT="$TMP/rc.d-hm2mqtt"
printf '#!/bin/sh\necho "rc.d called with $1"\n' > "$HM2MQTT_RC_SCRIPT"
chmod +x "$HM2MQTT_RC_SCRIPT"

failed=0
pass() { echo "  ok   - $1"; }
skip() { echo "  skip - $1 ($2)"; }
fail() {
    echo "  FAIL - $1"
    echo "         $2"
    failed=1
}

STUB="$PWD/addon/test/stub.tcl"

# how the CCU serves the page: /usr/local/etc/config/addons/www/<addon> is a symlink to the addon's
# www directory, and lighttpd invokes the CGI through it
mkdir -p "$TMP/config/addons/www"
ln -sfn "$TREE/www" "$TMP/config/addons/www/hm2mqtt"
printf '<h1>UI</h1>\n' > "$TREE/www/index.html"

# cgi <script> <query> [stdin]
# Invoked the way lighttpd does it: working directory is the script's own, the script is named
# relative to it. Passing an absolute path instead hides whether the addon can find itself.
cgi() {
    (cd "$TREE/www" && QUERY_STRING="$2" tclsh "$STUB" "$1" <<<"${3:-}" 2>&1)
}

echo "the page as lighttpd serves it (through the addons/www symlink)"
for style in relative absolute; do
    if [ "$style" = relative ]; then
        out="$(cd "$TMP/config/addons/www/hm2mqtt" && QUERY_STRING='sid=@1234567890@' tclsh "$STUB" settings.cgi 2>&1)"
    else
        out="$(cd / && QUERY_STRING='sid=@1234567890@' tclsh "$STUB" "$TMP/config/addons/www/hm2mqtt/settings.cgi" 2>&1)"
    fi
    case "$out" in
        *'<h1>UI</h1>'*) pass "settings.cgi serves the UI ($style through the symlink)" ;;
        *) fail "settings.cgi serves the UI ($style through the symlink)" "$out" ;;
    esac
done

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

# rc.d sources this file with the shell: a value with spaces, quotes or $( ) has to come back
# out of the shell as exactly one value, and must never execute
tricky=$'my secret;$(touch /tmp/hm2mqtt-cgi-owned) \'quoted\''
out="$(cgi setconfig.cgi 'sid=@1234567890@' "HM2MQTT_NAME=haus
HM2MQTT_MQTT_URL=mqtt://other:1883
HM2MQTT_MQTT_PASSWORD=$tricky")"
case "$out" in
    *'"ok":true'*) pass "accepts a password with shell characters" ;;
    *) fail "accepts a password with shell characters" "$out" ;;
esac
readback="$(sh -c "set -a; . '$TREE/etc/hm2mqtt.env' 2>/dev/null; printf %s \"\$HM2MQTT_MQTT_PASSWORD\"")"
if [ "$readback" = "$tricky" ]; then
    pass "the shell reads the value back unchanged"
else
    fail "the shell reads the value back unchanged" "got: $readback"
fi
if [ -e /tmp/hm2mqtt-cgi-owned ]; then
    fail "sourcing the env file executes nothing" "the \$( ) in the value ran"
    rm -f /tmp/hm2mqtt-cgi-owned
else
    pass "sourcing the env file executes nothing"
fi
out="$(cgi getconfig.cgi 'sid=@1234567890@')"
case "$out" in
    *'"HM2MQTT_MQTT_URL":"mqtt://other:1883"'*) pass "getconfig serves the value unquoted" ;;
    *) fail "getconfig serves the value unquoted" "$out" ;;
esac
# and the placeholder round-trip must preserve the quoted secret, not the quoting
out="$(cgi setconfig.cgi 'sid=@1234567890@' $'HM2MQTT_NAME=haus\nHM2MQTT_MQTT_PASSWORD=********\n')"
readback="$(sh -c "set -a; . '$TREE/etc/hm2mqtt.env' 2>/dev/null; printf %s \"\$HM2MQTT_MQTT_PASSWORD\"")"
if [ "$readback" = "$tricky" ]; then
    pass "the placeholder keeps a quoted secret"
else
    fail "the placeholder keeps a quoted secret" "got: $readback"
fi

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
# with a live pid the status has to carry real memory and uptime - busybox ps has no -p, which is
# how "0 MB" and an empty uptime got shipped
echo $$ > "$HM2MQTT_PID_FILE"
out="$(cgi service.cgi 'sid=@1234567890@&cmd=status')"
case "$out" in
    *'"running":true'*) pass "reports a running service" ;;
    *) fail "reports a running service" "$out" ;;
esac
# memory and uptime come from /proc, which exists on the CCU and in CI but not on macOS
if [ -r "/proc/$$/status" ]; then
    rss="$(printf '%s' "$out" | sed -n 's/.*"rss":"\([0-9]*\)".*/\1/p')"
    if [ -n "$rss" ] && [ "$rss" -gt 0 ] 2>/dev/null; then
        pass "reports resident memory ($rss kB)"
    else
        fail "reports resident memory" "$out"
    fi
    case "$out" in
        *'"uptime":""'*) fail "reports an uptime" "$out" ;;
        *'"uptime":"'*) pass "reports an uptime" ;;
        *) fail "reports an uptime" "$out" ;;
    esac
else
    skip "reports resident memory and uptime" "no /proc on this host"
fi
rm -f "$HM2MQTT_PID_FILE"
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

echo "log.cgi on openccu-lite: the journal through the system's log route (task 17)"
# A stub of the system's GET /api/system/v1/log: it answers the addon's token with two journal
# lines of the unit, anything else with 401, and records what it was asked.
LOG_STUB_REQUESTS="$TMP/log-stub.requests"
LOG_STUB_PORT="$TMP/log-stub.port"
cat > "$TMP/log-stub.mjs" <<'STUB'
import {createServer} from 'node:http';
import {appendFileSync, writeFileSync} from 'node:fs';
const [requests, portFile] = process.argv.slice(2);
const server = createServer((req, res) => {
    appendFileSync(requests, `${req.method} ${req.url} ${req.headers.authorization || '-'}\n`);
    if (req.headers.authorization === 'Bearer olt_addontoken0123') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({source: 'journald', lines: [
            {time: 'Sep 28 23:55:01', tag: 'addon-hm2mqtt', pid: 4711, unit: 'addon-hm2mqtt', message: 'mqtt connected to "broker"'},
            {time: 'Sep 28 23:55:02', tag: 'hm2mqtt', message: 'journal line two [ok]'},
        ]}));
    } else if (req.url === '/api/auth/v1/state') {
        // the session header (task 20): LIVE is a session, NOSID a token (no sid), OTHER names
        // another session, anything else is not known
        const id = (req.headers.authorization || '').replace(/^Bearer /, '');
        const answers = {
            LIVESESSIONLIVESESSIONLI22: {authenticated: true, sid: 'LIVESESSIONLIVESESSIONLI22', user: 'u', role: 'user'},
            NOSIDNOSIDNOSIDNOSIDNOSI22: {authenticated: true, user: 'token', role: 'admin'},
            OTHERSESSIONOTHERSESSION22: {authenticated: true, sid: 'SOMEONEELSESOMEONEELSES22', user: 'x'},
        };
        res.writeHead(answers[id] ? 200 : 401, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(answers[id] || {authenticated: false}));
    } else if (req.headers.authorization === 'Bearer olt_brokenanswer00') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end('{"lines": [');
    } else {
        res.writeHead(401, {'Content-Type': 'application/json'});
        res.end('{"error":"unauthorized"}');
    }
});
server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
STUB
: > "$LOG_STUB_REQUESTS"
node "$TMP/log-stub.mjs" "$LOG_STUB_REQUESTS" "$LOG_STUB_PORT" &
LOG_STUB_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$LOG_STUB_PORT" ] && break
    sleep 0.3
done
LOG_STUB_URL="http://127.0.0.1:$(cat "$LOG_STUB_PORT" 2>/dev/null || echo 1)"
printf 'olt_addontoken0123\n' > "$TMP/hm2mqtt.api"
# lite_log <VERSION file> <occulited path> <token file> [<query>]: log.cgi on openccu-lite
lite_log() {
    (cd "$TREE/www" && QUERY_STRING="${4:-sid=@1234567890@}" HM2MQTT_VERSION_FILE="$1" HM2MQTT_OCCULITED="$2" \
        HM2MQTT_API_TOKEN_FILE="$3" HM2MQTT_OCCULITE_URL="$LOG_STUB_URL" tclsh "$STUB" log.cgi 2>&1)
}
if tclsh <<<'package require json' >/dev/null 2>&1; then
    out="$(lite_log "$TMP/VERSION.lite" "$TMP/no-occulited" "$TMP/hm2mqtt.api" 'sid=@1234567890@&lines=50')"
    case "$out" in
        *'Sep 28 23:55:01 addon-hm2mqtt[4711]: mqtt connected to "broker"'*'Sep 28 23:55:02 hm2mqtt: journal line two [ok]'*) pass "a LITE= line: the journal's lines, one per entry" ;;
        *) fail "a LITE= line: the journal's lines, one per entry" "$out" ;;
    esac
    case "$out" in
        *'line two'*'line one'* | *'line one'*) fail "  and not the file" "$out" ;;
        *) pass "  and not the file" ;;
    esac
    if [ "$(cat "$LOG_STUB_REQUESTS")" = 'GET /api/system/v1/log?unit=addon-hm2mqtt&limit=50 Bearer olt_addontoken0123' ]; then
        pass "  asked for the unit's last lines with the addon's own token"
    else
        fail "  asked for the unit's last lines with the addon's own token" "$(cat "$LOG_STUB_REQUESTS")"
    fi
    : > "$LOG_STUB_REQUESTS"
    out="$(lite_log "$TMP/VERSION.ccu" "$TREE/bin/node" "$TMP/hm2mqtt.api")"
    case "$out" in
        *'journal line two'*) pass "occulited alone (no LITE= line) is openccu-lite too" ;;
        *) fail "occulited alone (no LITE= line) is openccu-lite too" "$out" ;;
    esac
    case "$(cat "$LOG_STUB_REQUESTS")" in
        *'limit=200 '*) pass "  with the default of 200 lines" ;;
        *) fail "  with the default of 200 lines" "$(cat "$LOG_STUB_REQUESTS")" ;;
    esac
    : > "$LOG_STUB_REQUESTS"
    out="$(lite_log "$TMP/VERSION.lite" "$TMP/no-occulited" "$TMP/no-token")"
    case "$out" in
        *'no API token'*'/system/log?unit=addon-hm2mqtt'*) pass "no token: says so and names the system's Log page" ;;
        *) fail "no token: says so and names the system's Log page" "$out" ;;
    esac
    case "$out" in
        *'line one'*) fail "  and shows no file" "$out" ;;
        *) pass "  and shows no file" ;;
    esac
    if [ -s "$LOG_STUB_REQUESTS" ]; then
        fail "  without asking the system" "$(cat "$LOG_STUB_REQUESTS")"
    else
        pass "  without asking the system"
    fi
    printf 'olt_wrongtoken0000\n' > "$TMP/wrong.api"
    out="$(lite_log "$TMP/VERSION.lite" "$TMP/no-occulited" "$TMP/wrong.api")"
    case "$out" in
        *'answered 401'*'/system/log?unit=addon-hm2mqtt'*) pass "a token the system refuses: the status and the Log page" ;;
        *) fail "a token the system refuses: the status and the Log page" "$out" ;;
    esac
    printf 'olt_brokenanswer00\n' > "$TMP/broken.api"
    out="$(lite_log "$TMP/VERSION.lite" "$TMP/no-occulited" "$TMP/broken.api")"
    case "$out" in
        *'could not be read'*) pass "an answer that is no JSON: said so" ;;
        *) fail "an answer that is no JSON: said so" "$out" ;;
    esac
    printf 'olt_x\nOTHER: header\n' > "$TMP/odd.api"
    : > "$LOG_STUB_REQUESTS"
    out="$(lite_log "$TMP/VERSION.lite" "$TMP/no-occulited" "$TMP/odd.api")"
    case "$out" in
        *'no API token'*) pass "a token file with more than a token is not sent" ;;
        *) fail "a token file with more than a token is not sent" "$out" ;;
    esac
    out="$(HM2MQTT_TEST_SESSION=invalid lite_log "$TMP/VERSION.lite" "$TMP/no-occulited" "$TMP/hm2mqtt.api")"
    case "$out" in
        *'invalid session'*) pass "without a session nothing is read" ;;
        *) fail "without a session nothing is read" "$out" ;;
    esac
    if [ -s "$LOG_STUB_REQUESTS" ]; then
        fail "  and the system is not asked" "$(cat "$LOG_STUB_REQUESTS")"
    else
        pass "  and the system is not asked"
    fi
else
    skip "log.cgi on openccu-lite" "tclsh has no json package (tcllib)"
fi
out="$(lite_log "$TMP/VERSION.ccu" "$TMP/no-occulited" "$TMP/hm2mqtt.api")"
case "$out" in
    *'line two'*) pass "a CCU (no LITE= line, no occulited) still shows the file" ;;
    *) fail "a CCU (no LITE= line, no occulited) still shows the file" "$out" ;;
esac

echo "the openccu-lite session header (task 20)"
# The gate sends the session it accepted as HTTP_X_OCCULITE_SESSION; the CGI asks the system's
# GET /api/auth/v1/state about it (the stub above). ReGa refuses every ?sid= in this section unless
# a case says otherwise, so only the header can let a request in.
LIVE=LIVESESSIONLIVESESSIONLI22
# hdr <script> <query> <header> [<VERSION file>] [<HM2MQTT_TEST_SESSION>]: a CGI with the header
hdr() {
    (cd "$TREE/www" && QUERY_STRING="$2" HTTP_X_OCCULITE_SESSION="$3" HM2MQTT_VERSION_FILE="${4:-$TMP/VERSION.lite}" \
        HM2MQTT_OCCULITE_URL="$LOG_STUB_URL" HM2MQTT_TEST_SESSION="${5:-invalid}" tclsh "$STUB" "$1" 2>&1)
}
state_asked() { grep -c "^GET /api/auth/v1/state Bearer $1\$" "$LOG_STUB_REQUESTS"; }
: > "$LOG_STUB_REQUESTS"
out="$(hdr settings.cgi '' "$LIVE")"
case "$out" in
    *'<h1>UI</h1>'*) pass "settings.cgi serves the UI with the header and no ?sid=" ;;
    *) fail "settings.cgi serves the UI with the header and no ?sid=" "$out" ;;
esac
[ "$(state_asked "$LIVE")" = 1 ] && pass "  after asking the system once, with the id as Bearer" || fail "  after asking the system once, with the id as Bearer" "$(cat "$LOG_STUB_REQUESTS")"
out="$(hdr getconfig.cgi '' "$LIVE")"
case "$out" in
    *'"HM2MQTT_NAME"'*) pass "getconfig.cgi answers the header" ;;
    *) fail "getconfig.cgi answers the header" "$out" ;;
esac
out="$(hdr service.cgi 'cmd=restart' "$LIVE")"
case "$out" in
    *'rc.d called with restart'*) pass "service.cgi too" ;;
    *) fail "service.cgi too" "$out" ;;
esac
if tclsh <<<'package require json' >/dev/null 2>&1; then
    out="$(HM2MQTT_API_TOKEN_FILE="$TMP/hm2mqtt.api" hdr log.cgi 'lines=5' "$LIVE")"
    case "$out" in
        *'journal line two'*) pass "and log.cgi" ;;
        *) fail "and log.cgi" "$out" ;;
    esac
fi
for case in "NOSIDNOSIDNOSIDNOSIDNOSI22:an API token (the state names no sid)" \
    "OTHERSESSIONOTHERSESSION22:a state that names another session" \
    "UNKNOWNUNKNOWNUNKNOWNUNK22:a session the system does not know"; do
    id="${case%%:*}"
    what="${case#*:}"
    : > "$LOG_STUB_REQUESTS"
    out="$(hdr getconfig.cgi '' "$id")"
    case "$out" in
        *'"error":"invalid session"'*) pass "$what is refused" ;;
        *) fail "$what is refused" "$out" ;;
    esac
    [ "$(state_asked "$id")" = 1 ] && pass "  after one question" || fail "  after one question" "$(cat "$LOG_STUB_REQUESTS")"
done
for case in "@$LIVE@:an @-wrapped id" "$LIVE $LIVE:two ids" "$LIVE
x:a line break" "$LIVE:x:a colon"; do
    id="${case%:*}"
    what="${case##*:}"
    : > "$LOG_STUB_REQUESTS"
    out="$(hdr settings.cgi '' "$id")"
    case "$out" in
        *'Sitzung ungültig'*) pass "$what in the header is refused" ;;
        *) fail "$what in the header is refused" "$out" ;;
    esac
    if [ -s "$LOG_STUB_REQUESTS" ]; then
        fail "  without asking the system" "$(cat "$LOG_STUB_REQUESTS")"
    else
        pass "  without asking the system"
    fi
done
out="$(hdr getconfig.cgi 'sid=@1234567890@' "UNKNOWNUNKNOWNUNKNOWNUNK22" "$TMP/VERSION.lite" valid)"
case "$out" in
    *'"error":"invalid session"'*) pass "a header the system refuses decides: a ?sid= ReGa confirms next to it does not lift it" ;;
    *) fail "a header the system refuses decides: a ?sid= ReGa confirms next to it does not lift it" "$out" ;;
esac
out="$(hdr getconfig.cgi 'sid=@1234567890@' '' "$TMP/VERSION.lite" valid)"
case "$out" in
    *'"HM2MQTT_NAME"'*) pass "no header on openccu-lite: ?sid= through the tclrega shim as before" ;;
    *) fail "no header on openccu-lite: ?sid= through the tclrega shim as before" "$out" ;;
esac
: > "$LOG_STUB_REQUESTS"
out="$(hdr settings.cgi '' "$LIVE" "$TMP/VERSION.ccu")"
case "$out" in
    *'Sitzung ungültig'*) pass "a CCU ignores the header (a client may have sent it): no ?sid=, no page" ;;
    *) fail "a CCU ignores the header (a client may have sent it): no ?sid=, no page" "$out" ;;
esac
if [ -s "$LOG_STUB_REQUESTS" ]; then
    fail "  and asks nobody" "$(cat "$LOG_STUB_REQUESTS")"
else
    pass "  and asks nobody"
fi
out="$(hdr settings.cgi 'sid=@1234567890@' "UNKNOWNUNKNOWNUNKNOWNUNK22" "$TMP/VERSION.ccu" valid)"
case "$out" in
    *'<h1>UI</h1>'*) pass "  while ?sid= works there as before, whatever the header says" ;;
    *) fail "  while ?sid= works there as before, whatever the header says" "$out" ;;
esac
out="$(cd "$TREE/www" && QUERY_STRING='' HTTP_X_OCCULITE_SESSION="$LIVE" HM2MQTT_VERSION_FILE="$TMP/VERSION.ccu" \
    HM2MQTT_OCCULITED="$TREE/bin/node" HM2MQTT_OCCULITE_URL="$LOG_STUB_URL" HM2MQTT_TEST_SESSION=invalid tclsh "$STUB" settings.cgi 2>&1)"
case "$out" in
    *'<h1>UI</h1>'*) pass "occulited alone (no LITE= line) is openccu-lite: the header counts" ;;
    *) fail "occulited alone (no LITE= line) is openccu-lite: the header counts" "$out" ;;
esac

kill "$LOG_STUB_PID" 2>/dev/null
wait "$LOG_STUB_PID" 2>/dev/null

echo "rc.d/hm2mqtt: where the output goes (task 17)"
# IsLite and LogTarget as shipped, with /VERSION and /usr/bin/occulited pointed at test files
RC_FUNCS="$TMP/rc-funcs.sh"
sed -n '/^IsLite() {$/,/^}$/p; /^LogTarget() {$/,/^}$/p' addon/files/hm2mqtt/rc.d/hm2mqtt > "$RC_FUNCS"
# log_target <VERSION file> <occulited path> <with systemd-cat: 1|0>
log_target() {
    funcs="$(sed -e "s|/VERSION|$1|" -e "s|/usr/bin/occulited|$2|" "$RC_FUNCS")"
    if [ "$3" = 1 ]; then
        sh -c "command() { [ \"\$2\" = systemd-cat ] && return 0; builtin command \"\$@\"; }; $funcs
LogTarget"
    else
        sh -c "command() { [ \"\$2\" = systemd-cat ] && return 1; builtin command \"\$@\"; }; $funcs
LogTarget"
    fi
}
if [ "$(grep -c '^IsLite() {$\|^LogTarget() {$' "$RC_FUNCS")" = 2 ]; then
    pass "IsLite and LogTarget could be taken out of rc.d/hm2mqtt"
else
    fail "IsLite and LogTarget could be taken out of rc.d/hm2mqtt" "$(cat "$RC_FUNCS")"
fi
[ "$(log_target "$TMP/VERSION.lite" "$TMP/no-occulited" 1)" = journal ] && pass "a LITE= line with systemd-cat: the journal" || fail "a LITE= line with systemd-cat: the journal" "$(log_target "$TMP/VERSION.lite" "$TMP/no-occulited" 1)"
[ "$(log_target "$TMP/VERSION.ccu" "$TREE/bin/node" 1)" = journal ] && pass "occulited alone: the journal" || fail "occulited alone: the journal" "$(log_target "$TMP/VERSION.ccu" "$TREE/bin/node" 1)"
[ "$(log_target "$TMP/VERSION.lite" "$TMP/no-occulited" 0)" = file ] && pass "openccu-lite without systemd-cat: the file, rather than no log" || fail "openccu-lite without systemd-cat: the file, rather than no log" "$(log_target "$TMP/VERSION.lite" "$TMP/no-occulited" 0)"
[ "$(log_target "$TMP/VERSION.ccu" "$TMP/no-occulited" 1)" = file ] && pass "a CCU: the file" || fail "a CCU: the file" "$(log_target "$TMP/VERSION.ccu" "$TMP/no-occulited" 1)"
printf 'VERSION=3.89.11\nVARIANT=lite\n#LITE=1\n' > "$TMP/VERSION.variant"
[ "$(log_target "$TMP/VERSION.variant" "$TMP/no-occulited" 1)" = file ] && pass "VARIANT=lite or a commented LITE= alone is not the rule" || fail "VARIANT=lite or a commented LITE= alone is not the rule" "$(log_target "$TMP/VERSION.variant" "$TMP/no-occulited" 1)"
case "$(cat addon/files/hm2mqtt/rc.d/hm2mqtt)" in
    *'RUN="exec systemd-cat -t $JOURNAL_TAG $NODE $APP"'*'rm -f $LOG $LOG.1'* | *'rm -f $LOG $LOG.1'*'RUN="exec systemd-cat -t $JOURNAL_TAG $NODE $APP"'*) pass "the journal start execs systemd-cat and removes the old file pair" ;;
    *) fail "the journal start execs systemd-cat and removes the old file pair" "rc.d/hm2mqtt" ;;
esac

echo "getnames.cgi / setnames.cgi"
out="$(cgi getnames.cgi 'sid=@1234567890@')"
case "$out" in
    *'Wohnzimmer Licht'*) pass "returns the name file" ;;
    *) fail "returns the name file" "$out" ;;
esac
out="$(cgi setnames.cgi 'sid=@1234567890@' '{"DEF4567890:1": "Rollladen"}')"
case "$out" in
    *'"ok":true'*) pass "writes valid names" ;;
    *) fail "writes valid names" "$out" ;;
esac
case "$(cat "$TREE/etc/names.json")" in
    *Rollladen*) pass "the file is replaced" ;;
    *) fail "the file is replaced" "$(cat "$TREE/etc/names.json")" ;;
esac
out="$(cgi setnames.cgi 'sid=@1234567890@' '{"broken": ')"
case "$out" in
    *'"error"'*) pass "refuses malformed JSON" ;;
    *) fail "refuses malformed JSON" "$out" ;;
esac
out="$(cgi setnames.cgi 'sid=@1234567890@' '{"ABC:1": 42}')"
case "$out" in
    *'must map to a string'*) pass "refuses a name that is not a string" ;;
    *) fail "refuses a name that is not a string" "$out" ;;
esac
case "$(cat "$TREE/etc/names.json")" in
    *Rollladen*) pass "a refused write leaves the file untouched" ;;
    *) fail "a refused write leaves the file untouched" "$(cat "$TREE/etc/names.json")" ;;
esac

echo "api.cgi"
out="$(cgi api.cgi 'sid=@1234567890@&cmd=rm')"
case "$out" in
    *'unknown command'*) pass "only allows its four commands" ;;
    *) fail "only allows its four commands" "$out" ;;
esac

echo "tcl 8.2 compatibility (the CCU3 firmware ships 8.2.3)"
# every one of these arrived after 8.2 and fails at runtime on a CCU3, where it would only show up
# as a broken WebUI: dict 8.5, eq/ne 8.4, string is 8.3, {*} 8.5, file normalize 8.4, bare scan 8.4
modern=""
for pattern in 'dict [a-z]' '\{\*\}' 'string is ' '\] eq ' '\] ne ' '\$[a-zA-Z_]* eq ' '\$[a-zA-Z_]* ne ' 'file normalize' 'lassign ' '\[scan [^]]*%[a-z]\]'; do
    hits="$(grep -rnE "$pattern" addon/files/hm2mqtt/www/*.cgi addon/files/hm2mqtt/www/lib/*.tcl addon/files/hm2mqtt/bin/update_addon 2>/dev/null | grep -v '^[^:]*:[0-9]*: *#' || true)"
    [ -n "$hits" ] && modern="$modern$hits\n"
done
if [ -z "$modern" ]; then
    pass "no tcl construct newer than 8.2 in the shipped scripts"
else
    fail "no tcl construct newer than 8.2 in the shipped scripts" "$(printf '%b' "$modern")"
fi

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
