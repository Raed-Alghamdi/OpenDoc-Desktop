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
  cp -a "$res/." "$tmp/" || { rm -rf "$tmp"; echo "opendoc: could not copy the runtime to $RT" >&2; exit 1; }
  # The app (or another call of this command) may have finished the same copy first: a complete copy is kept, never removed.
  if [ -f "$RT/node_modules/opendoc/bin/opendoc.mjs" ] && cmp -s "$res/build-info.json" "$RT/build-info.json"; then
    rm -rf "$tmp"
  else
    rm -rf "$RT" && mv "$tmp" "$RT" || { rm -rf "$tmp"; echo "opendoc: could not copy the runtime to $RT" >&2; exit 1; }
  fi
fi

# The workspaces' node_modules go through runtime/current (the app points it at the build it runs). After an update that was swapped
# in at quit, this copy can be newer than the one `current` names, and until the app is opened again the CLI (this copy) and the
# workspace's opendoc import (the old copy) would disagree. So point `current` at this copy when it is newer, with a temporary link
# and an atomic rename (what the app does), and never at an older copy. Version first, then build: the app's own rule. Nothing is
# removed here; the app prunes old copies, and only when no process uses them.
version_order() { # prints lt, eq or gt for versions $1 and $2: numeric parts in order, and a pre-release below its release
  local a=$1 b=$2 ca cb ra rb pa pb
  ca=${a%%[-+]*}; cb=${b%%[-+]*}
  if [ "$ca" != "$cb" ]; then
    if [ "$(printf '%s\n%s\n' "$ca" "$cb" | sort -V | head -n1)" = "$ca" ]; then echo lt; else echo gt; fi
    return
  fi
  ra=${a#"$ca"}; rb=${b#"$cb"}
  pa=; pb=
  case $ra in -*) pa=${ra#-}; pa=${pa%%+*} ;; esac
  case $rb in -*) pb=${rb#-}; pb=${pb%%+*} ;; esac
  if [ "$pa" = "$pb" ]; then echo eq
  elif [ -z "$pa" ]; then echo gt
  elif [ -z "$pb" ]; then echo lt
  elif [ "$(printf '%s\n%s\n' "$pa" "$pb" | sort -V | head -n1)" = "$pa" ]; then echo lt
  else echo gt; fi
}
cur="$DATA/runtime/current"
if [ -L "$cur" ] || [ ! -e "$cur" ]; then # a real folder named current is not ours to replace
  switch=
  if [ "$(readlink "$cur" 2>/dev/null)" = "$ver-$bld" ]; then
    :
  elif [ ! -f "$cur/build-info.json" ] || [ ! -f "$cur/node_modules/opendoc/bin/opendoc.mjs" ]; then
    switch=1 # nothing there, or a link to nothing usable
  else
    cver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$cur/package.json" 2>/dev/null | head -n1)
    cbld=$(sed -n 's/.*"build": *\([0-9]*\).*/\1/p' "$cur/build-info.json" | head -n1)
    if [ -z "$cver" ] || [ -z "$cbld" ]; then
      switch=1
    else
      case $(version_order "$ver" "$cver") in
        gt) switch=1 ;;
        eq) [ "$bld" -gt "$cbld" ] && switch=1 ;;
      esac
    fi
  fi
  if [ -n "$switch" ]; then
    link="$DATA/runtime/.current.$$.tmp"
    rm -f "$link"
    if ln -s "$ver-$bld" "$link" 2>/dev/null && mv -fT "$link" "$cur" 2>/dev/null; then :; else rm -f "$link"; fi
  fi
fi

# Run the CLI in the background so a signal sent to this script reaches it (stdin stays connected).
ELECTRON_RUN_AS_NODE=1 "$MNT/opendoc-desktop" "$RT/node_modules/opendoc/bin/opendoc.mjs" "$@" <&0 &
child=$!
trap 'kill -TERM "$child" 2>/dev/null' INT TERM HUP
wait "$child"
rc=$?
if [ "$rc" -gt 128 ]; then wait "$child" 2>/dev/null; fi
exit $rc
