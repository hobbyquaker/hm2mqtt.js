#!/usr/bin/env bash
#
# Assembles the Node.js runtime that ships inside the hm2mqtt CCU addon package.
#
#   addon/build-runtime.sh <armv7l|aarch64|x86_64> [outdir]
#
# Everything lands inside the addon's own directory and refers only to itself: the runtime never
# reads a library, a PATH entry or a Node installation belonging to the CCU or to another addon,
# and nothing outside $PREFIX is created, linked or modified.
#
# Where the binary comes from, per architecture:
#
#   armv7l   CCU3 hardware. The official eQ-3 firmware is glibc 2.27 / libstdc++ 6.0.24 (Buildroot
#            2019.08.2), while every nodejs.org binary since Node 18 needs GLIBC_2.28 and
#            GLIBCXX_3.4.26 - and nodejs.org stopped building armv7l after v23 entirely. Alpine
#            still builds current Node for armv7 against musl, so we take that binary together with
#            the musl loader and its shared libraries, and rewrite its ELF interpreter and RPATH to
#            point inside the addon. The CCU's own libc is then irrelevant: the runtime is
#            self-contained and works on official firmware and OpenCCU alike.
#   aarch64  OpenCCU only, glibc is current -> stock nodejs.org tarball.
#   x86_64   OpenCCU only, glibc is current -> stock nodejs.org tarball.
#
# Requires: curl, tar, and for armv7l docker (to let apk resolve the foreign-arch packages) and
# patchelf. Runs on Linux; on macOS use the workflow.

set -euo pipefail

cd "$(dirname "$0")/.."

NODE_MAJOR="${NODE_MAJOR:-24}"
PREFIX="${PREFIX:-/usr/local/addons/hm2mqtt}"
ALPINE_BRANCH="${ALPINE_BRANCH:-edge}"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine:edge}"
ALPINE_MIRROR="${ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine}"

ARCH="${1:-}"
OUT="${2:-addon/work/$ARCH/runtime}"

case "$ARCH" in
    armv7l | aarch64 | x86_64) ;;
    *)
        echo "usage: $0 <armv7l|aarch64|x86_64> [outdir]" >&2
        exit 1
        ;;
esac

require() {
    for cmd in "$@"; do
        command -v "$cmd" >/dev/null 2>&1 || {
            echo "error: '$cmd' is required but not installed" >&2
            exit 1
        }
    done
}

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib"

if [ "$ARCH" = armv7l ]; then
    require curl tar docker patchelf

    APK_VERSION="$(
        curl -fsSL --max-time 120 "$ALPINE_MIRROR/$ALPINE_BRANCH/main/armv7/APKINDEX.tar.gz" |
            tar -xzO APKINDEX |
            awk -v RS='' '/(^|\n)P:nodejs(\n|$)/ {for (i = 1; i <= NF; i++) if ($i ~ /^V:/) print substr($i, 3)}' |
            head -1
    )"
    [ -n "$APK_VERSION" ] || {
        echo "error: alpine/$ALPINE_BRANCH/armv7 has no nodejs package" >&2
        exit 1
    }
    NODE_VERSION="v${APK_VERSION%%-r*}"
    case "$NODE_VERSION" in
        "v$NODE_MAJOR."*) ;;
        *)
            echo "error: alpine/$ALPINE_BRANCH/armv7 ships nodejs $NODE_VERSION, expected ${NODE_MAJOR}.x." >&2
            echo "       Pick another ALPINE_BRANCH or move NODE_MAJOR." >&2
            exit 1
            ;;
    esac
    echo "alpine/$ALPINE_BRANCH/armv7: nodejs $APK_VERSION -> $NODE_VERSION"

    # apk resolves the dependency tree for the foreign architecture into a staging root; no armv7
    # code is executed here, the container only unpacks packages.
    ROOT="$(dirname "$OUT")/root"
    rm -rf "$ROOT"
    mkdir -p "$ROOT"
    docker run --rm -v "$PWD/$ROOT:/out" "$ALPINE_IMAGE" sh -eu -c "
        apk add --no-cache alpine-keys >/dev/null
        mkdir -p /out/etc/apk/keys
        cp /usr/share/apk/keys/armv7/* /out/etc/apk/keys/
        apk --root /out --arch armv7 --initdb --no-cache \
            --repository $ALPINE_MIRROR/$ALPINE_BRANCH/main \
            add nodejs >/dev/null
        chown -R $(id -u):$(id -g) /out
    "

    cp -a "$ROOT/usr/bin/node" "$OUT/bin/node"

    # Copy the transitive DT_NEEDED closure, asking patchelf what each object needs. Only these
    # libraries end up in the package - not everything apk happened to unpack.
    copy_lib() {
        local name="$1" dir real base
        [ -e "$OUT/lib/$name" ] && return 0
        for dir in "$ROOT/lib" "$ROOT/usr/lib"; do
            [ -e "$dir/$name" ] || continue
            real="$(readlink -f "$dir/$name")"
            base="$(basename "$real")"
            cp -a "$real" "$OUT/lib/$base"
            [ "$base" = "$name" ] || ln -sfn "$base" "$OUT/lib/$name"
            return 0
        done
        echo "error: shared library $name not found in the staging root" >&2
        return 1
    }

    queue="$OUT/bin/node"
    while [ -n "$queue" ]; do
        current="${queue%% *}"
        queue="${queue#"$current"}"
        queue="${queue# }"
        for needed in $(patchelf --print-needed "$current" 2>/dev/null); do
            if [ ! -e "$OUT/lib/$needed" ]; then
                copy_lib "$needed"
                queue="$queue $(readlink -f "$OUT/lib/$needed")"
            fi
        done
    done

    # the ELF interpreter itself (musl's loader), which is not a DT_NEEDED entry
    LOADER="$(patchelf --print-interpreter "$OUT/bin/node")"
    cp -a "$ROOT$LOADER" "$OUT/lib/$(basename "$LOADER")"

    # Point everything inside the addon: absolute prefix path first (the installed location),
    # $ORIGIN as well so the tree also works when unpacked somewhere else for testing.
    patchelf --set-interpreter "$PREFIX/lib/$(basename "$LOADER")" \
        --set-rpath "$PREFIX/lib:\$ORIGIN/../lib" "$OUT/bin/node"
    for lib in "$OUT"/lib/*; do
        [ -L "$lib" ] && continue
        case "$(basename "$lib")" in
            ld-musl-*) continue ;;
        esac
        patchelf --set-rpath "$PREFIX/lib:\$ORIGIN" "$lib"
    done

    RUNTIME_SOURCE="alpine/$ALPINE_BRANCH ($APK_VERSION, musl)"
else
    require curl tar

    NODE_VERSION="$(
        curl -fsSL --max-time 120 https://nodejs.org/dist/index.json |
            tr '}' '\n' |
            grep -o "\"version\":\"v$NODE_MAJOR\.[0-9]*\.[0-9]*\"" |
            head -1 |
            sed 's/.*"v/v/;s/"//'
    )"
    [ -n "$NODE_VERSION" ] || {
        echo "error: no Node $NODE_MAJOR release found on nodejs.org" >&2
        exit 1
    }
    case "$ARCH" in
        aarch64) NARCH=arm64 ;;
        x86_64) NARCH=x64 ;;
    esac
    NAME="node-$NODE_VERSION-linux-$NARCH"
    echo "nodejs.org: $NAME"
    WORKDL="$(dirname "$OUT")/dl"
    rm -rf "$WORKDL"
    mkdir -p "$WORKDL"
    curl -fsSL --max-time 900 "https://nodejs.org/dist/$NODE_VERSION/$NAME.tar.xz" | tar -xJ -C "$WORKDL"
    cp -a "$WORKDL/$NAME/bin/node" "$OUT/bin/node"
    cp -a "$WORKDL/$NAME/LICENSE" "$OUT/LICENSE.node"
    rm -rf "$WORKDL"
    RUNTIME_SOURCE="nodejs.org ($NODE_VERSION, glibc)"
fi

# npm is deliberately absent: the addon ships its dependencies pre-installed (there are no build
# tools on a CCU anyway), so the runtime is the node binary and nothing else.

cat > "$OUT/versions" <<VERSIONS
NODE_VERSION=$NODE_VERSION
NODE_ARCH=$ARCH
NODE_SOURCE=$RUNTIME_SOURCE
NODE_PREFIX=$PREFIX
BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
VERSIONS

# Self-check: every library the binary asks for must be part of the tree, and nothing may point
# outside the prefix.
if [ "$ARCH" = armv7l ]; then
    echo
    echo "interpreter: $(patchelf --print-interpreter "$OUT/bin/node")"
    echo "rpath:       $(patchelf --print-rpath "$OUT/bin/node")"
    missing=0
    for needed in $(patchelf --print-needed "$OUT/bin/node"); do
        [ -e "$OUT/lib/$needed" ] || {
            echo "MISSING: $needed" >&2
            missing=1
        }
    done
    [ "$missing" = 0 ] || exit 1
    case "$(patchelf --print-interpreter "$OUT/bin/node")" in
        "$PREFIX"/*) ;;
        *)
            echo "error: interpreter points outside $PREFIX" >&2
            exit 1
            ;;
    esac
    echo "libraries:   $(find "$OUT/lib" -maxdepth 1 -type f | wc -l | tr -d ' ') files, all inside $PREFIX/lib"
fi

echo
echo "runtime:     $OUT ($(du -sh "$OUT" | cut -f1)), $RUNTIME_SOURCE"
