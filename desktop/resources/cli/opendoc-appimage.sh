#!/bin/bash
# opendoc-desktop agent command (AppImage). The app writes this file to ~/.local/bin/opendoc at every launch and
# fills in the AppImage's location (the line starting APPIMAGE=). The app replaces a file only when it finds the words
# of this comment's first line in it, so it never overwrites a command that is not its own.
#
# It cannot run the AppImage file as Node directly: the AppImage's launcher (AppRun) puts --no-sandbox
# in front of the arguments when user namespaces are restricted (Ubuntu 24.04), and Node refuses
# "--no-sandbox" before the script ("bad option"). So this mounts the AppImage itself with the
# runtime's own --appimage-mount and runs the Electron binary inside the mount, bypassing AppRun.
APPIMAGE=@APPIMAGE@
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/opendoc-desktop"

if [ ! -f "$APPIMAGE" ]; then
  echo "opendoc: the opendoc-desktop AppImage is no longer at $APPIMAGE. Open it once from its new place to repair this command." >&2
  exit 127
fi

mnt_out=$(mktemp)
# --pdeathsig makes the kernel stop the mount helper if this script is killed, so no mount is left behind.
if command -v setpriv >/dev/null 2>&1; then
  setpriv --pdeathsig TERM "$APPIMAGE" --appimage-mount >"$mnt_out" 2>/dev/null &
else
  "$APPIMAGE" --appimage-mount >"$mnt_out" 2>/dev/null &
fi
mnt_pid=$!
cleanup() { kill "$mnt_pid" 2>/dev/null; wait "$mnt_pid" 2>/dev/null; rm -f "$mnt_out"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 141' PIPE
for _ in $(seq 1 200); do [ -s "$mnt_out" ] && break; sleep 0.05; done
MNT=$(head -n1 "$mnt_out")
if [ ! -x "$MNT/opendoc-desktop" ]; then
  echo "opendoc: could not mount $APPIMAGE. AppImages need FUSE (on Ubuntu 24.04: sudo apt install libfuse2t64)." >&2
  exit 126
fi

# The runtime copy for this build; made again when missing or from another build.
res="$MNT/resources/runtime"
ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$res/package.json" | head -n1)
bld=$(sed -n 's/.*"build": *\([0-9]*\).*/\1/p' "$res/build-info.json" | head -n1)
RT="$DATA/runtime/$ver-$bld"
if [ ! -f "$RT/node_modules/opendoc/bin/opendoc.mjs" ] || ! cmp -s "$res/build-info.json" "$RT/build-info.json"; then
  mkdir -p "$DATA/runtime"
  tmp=$(mktemp -d "$DATA/runtime/.tmp.XXXXXX")
  cp -a "$res/." "$tmp/" && rm -rf "$RT" && mv "$tmp" "$RT" || { echo "opendoc: could not copy the runtime to $RT" >&2; exit 1; }
fi

# Run the CLI in the background so a signal sent to this script reaches it (stdin stays connected).
ELECTRON_RUN_AS_NODE=1 "$MNT/opendoc-desktop" "$RT/node_modules/opendoc/bin/opendoc.mjs" "$@" <&0 &
child=$!
trap 'kill -TERM "$child" 2>/dev/null' INT TERM HUP
wait "$child"
rc=$?
if [ "$rc" -gt 128 ]; then wait "$child" 2>/dev/null; fi
exit $rc
