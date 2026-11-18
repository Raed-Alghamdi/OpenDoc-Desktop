#!/bin/bash
# Spike S6, macOS part (plan 3.7 / S6 step 5). Run by .github/workflows/spike-s6-macos.yml on a macOS runner, from the repository
# root, after dist-b1 (build 1) and dist-b2 (build 2) exist under desktop/. Nothing leaves the machine: the feed is a local Python
# server on 127.0.0.1. Every check is allowed to fail; the point is to record what macOS does.
#
# Usage: spike-s6-mac-test.sh <arm64|x64>
set -u
ARCH=${1:?arch}
ROOT=$PWD
D=$ROOT/desktop
OUT=${RUNNER_TEMP:-/tmp}/s6-out
mkdir -p "$OUT"
SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/null}
PORT=18099
FEED=$OUT/feed
CFG="$HOME/Library/Application Support/opendoc-desktop"
BUNDLE_NAME=opendoc-desktop.app

tmo() { perl -e 'alarm shift; exec @ARGV' "$@"; } # macOS has no timeout command
export -f tmo
say() { echo "$@" | tee -a "$SUMMARY"; }
block() { say '```'; "$@" 2>&1 | tee -a "$SUMMARY" | head -${LINES_MAX:-40}; say '```'; }
find_app() { ls -d "$D/$1"/mac*/$BUNDLE_NAME 2>/dev/null | head -1; }
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null; }
bundle_state() { # $1 = bundle path
  echo "version $(plist "$1" CFBundleShortVersionString) build $(plist "$1" CFBundleVersion)"
  echo "xattrs: $(xattr -l "$1" 2>/dev/null | tr '\n' ' ')"
  codesign --verify --deep --strict "$1" 2>&1 | head -3 && echo "codesign verify: ok"
  codesign -dv "$1" 2>&1 | grep -E 'Signature|TeamIdentifier|flags' | tr '\n' ' '; echo
}
set_test_config() { # $1 action, $2 log file
  mkdir -p "$CFG"
  printf '{"url":"http://127.0.0.1:%s/github-like","action":"%s","log":"%s","wait":120}' "$PORT" "$1" "$2" > "$CFG/updater-test.json"
}
wait_for() { # $1 file, $2 regex, $3 seconds ; returns 0 when the regex shows up
  local i=0
  while [ "$i" -lt "$3" ]; do grep -Eq "$2" "$1" 2>/dev/null && return 0; sleep 1; i=$((i+1)); done
  return 1
}
kill_app() { pkill -f "$BUNDLE_NAME/Contents/MacOS" 2>/dev/null; sleep 2; pkill -9 -f "$BUNDLE_NAME/Contents/MacOS" 2>/dev/null; true; }
events() { sed 's/^{"t":"[^"]*",//' "$1" 2>/dev/null | grep -E '"event":"(start|app-started|update-available|update-downloaded|downloaded|mac-installed|install-failed|check-failed|download-failed|error|timeout)"' | cut -c1-330; }

say "### S6 macOS $ARCH ($(sw_vers -productName) $(sw_vers -productVersion), $(uname -m))"
APP1=$(find_app dist-b1); APP2=$(find_app dist-b2)
say "build 1: $APP1 ($(bundle_state "$APP1" | head -1))"
say "build 2: $APP2 ($(bundle_state "$APP2" | head -1))"

# The feed: build 2, with the build number added to latest-mac.yml, served by a local server.
TAG=desktop-v0.6.1-2
mkdir -p "$FEED/tags/$TAG"
cp "$D"/dist-b2/*.zip "$D/dist-b2/latest-mac.yml" "$FEED/tags/$TAG/"
node "$D/scripts/spike-feed.mjs" "$FEED/tags/$TAG/latest-mac.yml" 2 abc123 >/dev/null
echo -n "$TAG" > "$FEED/LATEST"
python3 "$D/scripts/spike-feed-server.py" "$FEED" "$PORT" > "$OUT/server.out" 2>&1 &
SERVER_PID=$!
sleep 1
say "feed: $(curl -s "http://127.0.0.1:$PORT/api/v3/repos/Raed-Alghamdi/OpenDoc-Desktop/releases/latest")"
say '```'; head -8 "$FEED/tags/$TAG/latest-mac.yml" | tee -a "$SUMMARY"; say '```'

install_to() { # $1 destination folder
  rm -rf "$1/$BUNDLE_NAME"; mkdir -p "$1"; ditto "$APP1" "$1/$BUNDLE_NAME"
}

run_case() { # $1 label, $2 bundle path, $3 how (open|direct), $4 action, $5 seconds to wait for the end state
  local label=$1 app=$2 how=$3 action=$4 wait_s=${5:-90}
  local log="$OUT/$label.log"; rm -f "$log"
  set_test_config "$action" "$log"
  say ""; say "#### $label ($how, action $action)"
  if [ "$how" = open ]; then
    # A quarantined app makes `open` wait for Gatekeeper's dialog, which nobody clicks on a runner: cap it and record that.
    tmo 30 open -n "$app" --args --update-run; local rc=$?
    if [ "$rc" = 142 ]; then
      say "open did not return within 30 s (exit 142): Gatekeeper's dialog is waiting for a click"
      LINES_MAX=12 block bash -c "log show --last 2m --style compact --predicate 'process == \"syspolicyd\" OR process == \"CoreServicesUIAgent\"' 2>/dev/null | grep -iE 'opendoc|assess|quarantin|translocat|notari|malware|deny|allow' | tail -12 | cut -c1-260"
      pkill -x CoreServicesUIAgent 2>/dev/null; sleep 2 # dismiss the dialog so the next case starts clean
    else say "open exit code: $rc"; fi
  else ( "$app/Contents/MacOS/opendoc-desktop" --update-run >/dev/null 2>&1 & ) ; fi
  if [ "$action" = restart ]; then
    wait_for "$log" '"event":"app-started".*"build":2|"event":"install-failed"|"event":"check-failed"|"event":"download-failed"' "$wait_s" || say "(end state not reached within ${wait_s}s)"
  else
    wait_for "$log" '"event":"(install-failed|check-failed|download-failed|timeout)"' "$wait_s" || sleep 5
  fi
  say '```'; events "$log" | tee -a "$SUMMARY"; say '```'
  if [ -f "$log" ]; then say "process path seen by the app: $(grep -o '"execPath":"[^"]*"' "$log" | head -1)"; fi
  say "running now: $(pgrep -fl "$BUNDLE_NAME/Contents/MacOS" | head -3 | cut -c1-160 | tr '\n' '|')"
}

# ---- A. Build 1 in Applications, started the way a user starts it (Launch Services), with the free updater.
install_to /Applications
say ""; say "#### A. in /Applications"; LINES_MAX=10 block bundle_state "/Applications/$BUNDLE_NAME"
run_case A-applications-open "/Applications/$BUNDLE_NAME" open restart 120
say "bundle after the update:"; LINES_MAX=10 block bundle_state "/Applications/$BUNDLE_NAME"
say "leftovers next to the app: $(ls -a /Applications | grep -E 'opendoc' | tr '\n' ' ')"
say "swap helper log: $(cat /tmp/opendoc-update-helper-*.log 2>/dev/null | tr '\n' ' ')"
say "Gatekeeper assessment of the updated bundle (expected: rejected, ad-hoc and not notarized):"; LINES_MAX=6 block spctl -a -vv "/Applications/$BUNDLE_NAME"
kill_app

# ---- A2. The same, started from a shell (the process's parent is the runner's shell, not Launch Services).
install_to /Applications
run_case A2-applications-direct "/Applications/$BUNDLE_NAME" direct restart 120
LINES_MAX=6 block bundle_state "/Applications/$BUNDLE_NAME"
kill_app

# ---- App Management: what the system logged about the swap, and what permission entries exist.
say ""; say "#### App Management and TCC"
say "log entries about app bundle protection in the last 15 minutes:"
LINES_MAX=25 block bash -c "tmo 90 log show --last 15m --style compact --predicate 'subsystem == \"com.apple.TCC\" OR process == \"tccd\"' 2>/dev/null | grep -iE 'AppBundles|opendoc|App Management|SystemPolicyAppBundles' | tail -25"
say "TCC database entries for app bundle protection (system database, may be unreadable without Full Disk Access):"
LINES_MAX=15 block bash -c "sudo sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' \"select service, client, auth_value, auth_reason from access where service like '%AppBundles%' or client like '%opendoc%' or client like '%OpenDoc%'\" 2>&1; echo '--- user database'; sqlite3 \"\$HOME/Library/Application Support/com.apple.TCC/TCC.db\" \"select service, client, auth_value from access where service like '%AppBundles%'\" 2>&1"
say "control: can a plain shell process write into an app bundle in /Applications? (App Management would block it for another app)"
install_to /Applications
LINES_MAX=4 block bash -c "touch '/Applications/$BUNDLE_NAME/Contents/s6-probe' && echo 'write ok' && rm -f '/Applications/$BUNDLE_NAME/Contents/s6-probe'"
rm -rf "/Applications/$BUNDLE_NAME"

# ---- B. Build 1 in Downloads. Variants of what a browser leaves behind.
DL="$HOME/Downloads"
quarantine() { xattr -w com.apple.quarantine "$1;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$2"; }

install_to "$DL"; quarantine 0081 "$DL/$BUNDLE_NAME"
say ""; say "#### B1. Downloads, quarantined by a browser (flags 0081), not approved"
run_case B1-downloads-quarantined "$DL/$BUNDLE_NAME" open restart 60
say "Gatekeeper's view of it:"; LINES_MAX=6 block spctl -a -vv "$DL/$BUNDLE_NAME"
say "system messages about the launch:"
LINES_MAX=12 block bash -c "tmo 90 log show --last 2m --style compact --predicate 'process == \"syspolicyd\" OR process == \"CoreServicesUIAgent\" OR process == \"launchservicesd\"' 2>/dev/null | grep -iE 'opendoc|Gatekeeper|assess|translocat|quarantine' | tail -12"
kill_app

install_to "$DL"; quarantine 0081 "$DL/$BUNDLE_NAME"
say ""; say "#### B2. Downloads, quarantined, then approved the way Open Anyway records it (spctl --add)"
LINES_MAX=4 block sudo spctl --add "$DL/$BUNDLE_NAME"
run_case B2-downloads-approved "$DL/$BUNDLE_NAME" open restart 60
kill_app
sudo spctl --remove "$DL/$BUNDLE_NAME" 2>/dev/null

install_to "$DL"; quarantine 0083 "$DL/$BUNDLE_NAME"
say ""; say "#### B3. Downloads, quarantine flags 0083 (the value after a user has approved the first launch)"
run_case B3-downloads-flag0083 "$DL/$BUNDLE_NAME" open restart 60
kill_app

install_to "$DL"
say ""; say "#### B4. Downloads, no quarantine flag (the file arrived by curl or by an app's own download)"
run_case B4-downloads-clean "$DL/$BUNDLE_NAME" open restart 90
LINES_MAX=6 block bundle_state "$DL/$BUNDLE_NAME"
kill_app
rm -rf "$DL/$BUNDLE_NAME"

# ---- C. electron-updater's own macOS install (Squirrel.Mac) with the ad-hoc build: how does it fail?
install_to /Applications
say ""; say "#### C. the stock electron-updater macOS install (Squirrel.Mac), ad-hoc signed"
run_case C-stock-squirrel "/Applications/$BUNDLE_NAME" open stock 60
say "ShipIt log:"; LINES_MAX=20 block bash -c "tail -20 \"\$HOME\"/Library/Caches/io.github.ryanyahya.OpenDocDesktop.ShipIt/ShipIt_stderr.log 2>&1"
kill_app
rm -rf "/Applications/$BUNDLE_NAME"
rm -f "$CFG/updater-test.json"

say ""; say "#### what the feed server saw (the app's requests)"
LINES_MAX=40 block bash -c "cut -c1-170 '$FEED/requests.log'"
cp "$FEED/requests.log" "$OUT/requests.log" 2>/dev/null
kill "$SERVER_PID" 2>/dev/null
exit 0
