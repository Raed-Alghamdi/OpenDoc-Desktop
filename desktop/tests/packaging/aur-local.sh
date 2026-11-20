#!/usr/bin/env bash
# Builds the AUR package opendoc-desktop-bin from a local pacman artifact and checks the result, without installing anything.
#
#   bash desktop/tests/packaging/aur-local.sh desktop/dist/opendoc-desktop-0.6.1-2-x64.pacman
#
# Copies desktop/aur into a scratch folder, points the source at the local file (version and build number are read from the file
# name), runs makepkg (never -i, never as root), then reads the package with bsdtar. Needs makepkg, fakeroot and bsdtar; runs namcap
# when it is installed.
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo "Run this as a normal user: makepkg refuses root." >&2; exit 2; }
artifact=$(realpath "${1:?usage: aur-local.sh <opendoc-desktop-VERSION-BUILD-x64.pacman>}")
[[ $(basename "$artifact") =~ ^opendoc-desktop-([0-9]+\.[0-9]+\.[0-9]+)-([1-9][0-9]*)-x64\.pacman$ ]] || { echo "Unexpected file name: $artifact" >&2; exit 2; }
version=${BASH_REMATCH[1]}
build=${BASH_REMATCH[2]}
aur=$(realpath "$(dirname "${BASH_SOURCE[0]}")/../../aur")
work=$(mktemp -d "${TMPDIR:-/tmp}/opendoc-aur-XXXXXX")
trap 'echo "scratch folder kept: $work"' EXIT

cp "$aur/PKGBUILD" "$aur/opendoc-desktop-bin.install" "$work/"
cd "$work"
sed -i "s/^pkgver=.*/pkgver=${version}/; s/^pkgrel=.*/pkgrel=${build}/" PKGBUILD
# The local file replaces the release URL; the checksum is then real.
sed -i "s|^source=.*|source=(\"\${_asset}::file://${artifact}\")|" PKGBUILD
updpkgsums
nice -n 19 ionice -c 3 env PKGDEST="$work" SRCDEST="$work" BUILDDIR="$work/build" makepkg -f --nodeps --noconfirm
pkg=$(ls "$work"/opendoc-desktop-bin-*.pkg.tar.zst)
list=$(bsdtar -tvf "$pkg")
names=$(bsdtar -tf "$pkg")
fail=0
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fail=1; fi; }

check "update-disabled marker is a root-owned empty file under /opt" "grep -E '^-rw-r--r-- +0 root +root +0 .* opt/opendoc-desktop/resources/update-disabled\$' <<<\"\$list\" >/dev/null"
check "/usr/bin/opendoc-desktop points into /opt" "grep -E 'usr/bin/opendoc-desktop -> /opt/opendoc-desktop/opendoc-desktop' <<<\"\$list\" >/dev/null"
check "/usr/bin/opendoc is a 0755 regular file, the launcher from resources/cli" "grep -E '^-rwxr-xr-x +0 root +root +[0-9]+ .* usr/bin/opendoc\$' <<<\"\$list\" >/dev/null && bsdtar -xOf \"\$pkg\" usr/bin/opendoc | cmp -s - \"\$aur/../resources/cli/opendoc\""
check "the .desktop file is there" "grep -q ' usr/share/applications/opendoc-desktop.desktop' <<<\"\$list\""
check "the design pack file type: the shared-mime entry is the repository's file, the .desktop file names its type" "bsdtar -xOf \"\$pkg\" usr/share/mime/packages/opendoc-desktop.xml | cmp -s - \"\$aur/../resources/mime/opendoc-desktop.xml\" && bsdtar -xOf \"\$pkg\" usr/share/applications/opendoc-desktop.desktop | grep -qx 'MimeType=application/x-opendoc-pack;'"
check "both SVG icons are there" "grep -q 'hicolor/scalable/apps/opendoc-desktop.svg' <<<\"\$list\" && grep -q 'hicolor/symbolic/apps/opendoc-desktop-symbolic.svg' <<<\"\$list\""
check "licences are installed" "grep -q 'usr/share/licenses/opendoc-desktop-bin/LICENSE.opendoc' <<<\"\$list\" && grep -q 'usr/share/licenses/opendoc-desktop-bin/LICENSE.electron.txt' <<<\"\$list\""
check "nothing outside /opt, /usr/bin and /usr/share (metadata files aside)" "! grep -v -E '^(\\.PKGINFO|\\.MTREE|\\.BUILDINFO|\\.INSTALL|opt/?|usr/?|opt/opendoc-desktop(/.*)?|usr/bin(/.*)?|usr/share(/.*)?)\$' <<<\"\$names\" | grep -q ."
check "the release package's own metadata did not leak in" "[[ \$(bsdtar -xOf \"\$pkg\" .PKGINFO | grep -c '^pkgname = opendoc-desktop-bin\$') -eq 1 ]]"
check "no world-writable files" "! awk '{print \$1}' <<<\"\$list\" | grep -q -E '^.{8}w'"
check "no setuid files in the package (the install script sets chrome-sandbox)" "! awk '{print \$1}' <<<\"\$list\" | grep -q -E '^...s|^......s'"
check "the app binary and esbuild are executable" "grep -E '^-rwxr-xr-x .* opt/opendoc-desktop/opendoc-desktop\$' <<<\"\$list\" >/dev/null && grep -E '^-r-xr-xr-x .* opt/.*/@esbuild/[^/]+/bin/esbuild\$' <<<\"\$list\" >/dev/null"
check "the runtime keeps its read-only files" "grep -E '^-r--r--r-- .* opt/opendoc-desktop/resources/runtime/build-info.json\$' <<<\"\$list\" >/dev/null"

echo "--- package info"
bsdtar -xOf "$pkg" .PKGINFO | grep -E '^(pkgname|pkgver|provides|conflict|depend|license|arch|size|packager) '
echo "--- install script"
bsdtar -xOf "$pkg" .INSTALL | head -20
ls -l "$pkg" | awk '{printf "package size: %.1f MiB\n", $5/1048576}'
if command -v namcap >/dev/null; then
  echo "--- namcap PKGBUILD"; namcap PKGBUILD || true
  echo "--- namcap package"; namcap "$pkg" || true
else
  echo "namcap is not installed: skipped"
fi
exit $fail
