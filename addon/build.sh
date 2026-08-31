#!/usr/bin/env bash
#
# Builds the installable hm2mqtt CCU addon package.
#
#   addon/build.sh <armv7l|aarch64|x86_64> [--beta]
#
# Produces dist/hm2mqtt-ccu-<arch>-<version>[-beta].tar.gz, the file that is uploaded in
# Systemsteuerung -> Zusatzsoftware. Package layout (everything below /usr/local/addons/hm2mqtt):
#
#   bin/node          the bundled runtime (addon/build-runtime.sh)
#   bin/update_addon  tcl helper that maintains the Systemsteuerung entry
#   lib/              shared libraries of the runtime (armv7l only)
#   share/icu/        ICU data - node does not start without it (musl build)
#   app/              hm2mqtt itself, dependencies already installed
#   etc/              default.env, monit.cfg; hm2mqtt.env is created on first install
#   rc.d/hm2mqtt      service script
#   www/              CGIs and the configuration UI
#   var/              log file at runtime
#
# --beta appends -beta to the package version (H-41): the addon carries the hm2mqtt version, but
# stays marked beta until it has been installed on real CCU hardware.

set -euo pipefail

cd "$(dirname "$0")/.."

ARCH="${1:-}"
case "$ARCH" in
    armv7l | aarch64 | x86_64) ;;
    *)
        echo "usage: $0 <armv7l|aarch64|x86_64> [--beta]" >&2
        exit 1
        ;;
esac
shift

BETA=""
while [ $# -gt 0 ]; do
    case "$1" in
        --beta) BETA="-beta"; shift ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done

PREFIX=/usr/local/addons/hm2mqtt
VERSION="$(node -p 'require("./package.json").version')$BETA"
WORK="addon/work/$ARCH/pkg"
TREE="$WORK/hm2mqtt"

echo
echo "building hm2mqtt $VERSION addon package for $ARCH"

rm -rf "$WORK"
mkdir -p "$TREE" dist

# 1. the runtime
PREFIX="$PREFIX" addon/build-runtime.sh "$ARCH" "$TREE"

# 2. the addon files (rc.d, bin/update_addon, etc, www)
cp -a addon/files/hm2mqtt/. "$TREE/"
cp -a addon/files/update_script "$WORK/update_script"
cp -a addon/files/hm2mqtt.cfg "$WORK/hm2mqtt.cfg"
# run-parts ignores files with a dot in the name, and the WebUI calls this through the symlink
chmod +x "$WORK/update_script" "$TREE/rc.d/hm2mqtt" "$TREE/bin/update_addon" "$TREE"/www/*.cgi

# 3. hm2mqtt itself, with its production dependencies, exactly as npm would publish it
echo "installing hm2mqtt and its dependencies..."
TGZ="$(npm pack --silent --pack-destination "$WORK")"
mkdir -p "$TREE/app"
tar -xzf "$WORK/$TGZ" -C "$TREE/app" --strip-components=1
rm -f "$WORK/$TGZ"
npm install --silent --omit=dev --omit=optional --ignore-scripts --no-package-lock \
    --prefix "$TREE/app" >/dev/null

# 4. the option schema the configuration UI renders (H-38: every option, no hand-maintained list).
# Redirected to a file on purpose: --config-schema truncates on a pipe (core G-7).
node index.js --config-schema > "$TREE/www/config-schema.json"

# 5. the configuration UI itself - one self-contained index.html, replacing the placeholder
echo "building the configuration UI..."
if [ ! -d addon/ui/node_modules ]; then
    (cd addon/ui && npm ci --silent --no-audit --no-fund)
fi
(cd addon/ui && npm run build --silent >/dev/null)
cp addon/ui/dist/index.html "$TREE/www/index.html"

# 6. version file, read by the rc.d script and shown in Systemsteuerung
{
    echo "VERSION_ADDON=\"$VERSION\""
    cat "$TREE/versions"
} > "$TREE/versions.new"
mv "$TREE/versions.new" "$TREE/versions"

# 7. keep the bulky, reproducible parts out of the CCU backup (honoured by OpenCCU)
for dir in bin lib share app; do
    [ -d "$TREE/$dir" ] && touch "$TREE/$dir/.nobackup"
done

PKG="dist/hm2mqtt-ccu-$ARCH-$VERSION.tar.gz"
# GNU tar writes the root ownership the CCU installer expects; bsdtar (macOS, local builds) has no
# --owner, which only matters for a package actually shipped - CI runs on Linux
if tar --owner=root --group=root --version >/dev/null 2>&1; then
    tar --owner=root --group=root --exclude=.DS_Store -czf "$PKG" -C "$WORK" hm2mqtt update_script hm2mqtt.cfg
else
    echo "note: GNU tar not available, package ownership will not be root"
    tar --exclude=.DS_Store -czf "$PKG" -C "$WORK" hm2mqtt update_script hm2mqtt.cfg
fi
if command -v sha256sum >/dev/null 2>&1; then
    (cd dist && sha256sum "$(basename "$PKG")" > "$(basename "$PKG").sha256")
else
    (cd dist && shasum -a 256 "$(basename "$PKG")" > "$(basename "$PKG").sha256")
fi

echo
du -sh "$TREE" | sed 's/^/installed size: /'
ls -lh "$PKG" | awk '{print "package:        " $9 " (" $5 ")"}'
