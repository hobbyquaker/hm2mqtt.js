#!/usr/bin/env bash
#
# Unpacks a built addon package into the layout a CCU installs it into - including the
# addons/www/<addon> symlink the WebUI reaches the CGIs through - and exercises the pages the same
# way lighttpd does. This is the check that would have caught the blank configuration page: the
# source tree alone never has that symlink, so the CGIs looked fine right up to being installed.
#
#   addon/test/package-test.sh dist/hm2mqtt-ccu-x86_64-<version>.tar.gz

set -uo pipefail

cd "$(dirname "$0")/../.."
PKG="${1:-}"
[ -f "$PKG" ] || {
    echo "usage: $0 <package.tar.gz>" >&2
    exit 1
}
command -v tclsh >/dev/null || {
    echo "tclsh is required" >&2
    exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STUB="$PWD/addon/test/stub.tcl"

mkdir -p "$TMP/usr_local/addons" "$TMP/config/addons/www"
tar xzf "$PKG" -C "$TMP/usr_local/addons" hm2mqtt
ADDON="$TMP/usr_local/addons/hm2mqtt"
ln -sfn "$ADDON/www" "$TMP/config/addons/www/hm2mqtt"
cp "$ADDON/etc/default.env" "$ADDON/etc/hm2mqtt.env"

export HM2MQTT_ADDON_DIR="$ADDON"
export HM2MQTT_PID_FILE="$TMP/hm2mqtt.pid"

failed=0
pass() { echo "  ok   - $1"; }
fail() {
    echo "  FAIL - $1"
    echo "         $2"
    failed=1
}

# through the symlink, absolute path, working directory elsewhere - what lighttpd does
page="$(cd / && QUERY_STRING='sid=@1234567890@' tclsh "$STUB" "$TMP/config/addons/www/hm2mqtt/settings.cgi" 2>&1)"
case "$page" in
    *'<!doctype html>'*) pass "the configuration page is served through the symlink" ;;
    *) fail "the configuration page is served through the symlink" "$page" ;;
esac
case "$page" in
    *'hm2mqtt'*) pass "and it is the built UI" ;;
    *) fail "and it is the built UI" "${page:0:200}" ;;
esac

run() { (cd "$TMP/config/addons/www/hm2mqtt" && QUERY_STRING="$1" tclsh "$STUB" "$2" 2>&1 | tail -1); }

out="$(run 'sid=%401234567890%40' getconfig.cgi)"
case "$out" in
    *'"HM2MQTT_CCU_ADDRESS":"127.0.0.1"'*) pass "getconfig.cgi reads the shipped configuration" ;;
    *) fail "getconfig.cgi reads the shipped configuration" "$out" ;;
esac

out="$(run 'sid=%401234567890%40&cmd=status' service.cgi)"
case "$out" in
    *'"VERSION_ADDON"'*) pass "service.cgi reports the version" ;;
    *) fail "service.cgi reports the version" "$out" ;;
esac

out="$(run 'sid=%401234567890%40' getnames.cgi)"
case "$out" in
    *'{'*) pass "getnames.cgi reads the shipped name file" ;;
    *) fail "getnames.cgi reads the shipped name file" "$out" ;;
esac

# The runtime has to start from where the package puts it - checkable only where the host can
# execute it, i.e. a Linux host of the package's own architecture. The armv7l and aarch64 packages
# are built on x86_64 runners, so there the binary is inspected rather than run.
description="$(file -b "$ADDON/bin/node" 2>/dev/null)"
case "$description" in
    *x86-64*) package_arch=x86_64 ;;
    *aarch64*) package_arch=aarch64 ;;
    *ARM*) package_arch=armv7l ;;
    *) package_arch=unknown ;;
esac
if [ "$(uname -s)" = Linux ] && [ "$package_arch" = "$(uname -m)" ]; then
    if "$ADDON/bin/node" -e 'process.exit(0)' 2>/dev/null; then
        pass "the bundled node runs ($("$ADDON/bin/node" --version))"
    else
        fail "the bundled node runs" "$description"
    fi
elif [ "$package_arch" = unknown ]; then
    fail "the bundled node is an executable" "$description"
else
    echo "  skip - running the bundled node ($package_arch package on $(uname -s)/$(uname -m))"
    case "$description" in
        *ELF*executable*) pass "the bundled node is an $package_arch ELF executable" ;;
        *) fail "the bundled node is an ELF executable" "$description" ;;
    esac
fi

echo
if [ "$failed" = 0 ]; then
    echo "package looks installable"
else
    echo "package test failed"
fi
exit $failed
