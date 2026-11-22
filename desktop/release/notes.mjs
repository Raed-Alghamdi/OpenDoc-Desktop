#!/usr/bin/env node
// What every release says about installing and updating the app, and the whole notes of a release made from a pushed
// desktop-v tag (desktop.yml's release job). upstream-watch writes its own opening lines (decide.mjs releaseNotes) and appends the
// same install notes, so a release reads the same however it was made. The facts are docs/DESKTOP.md's, shortened: change them there
// first.
//
// Usage: node desktop/release/notes.mjs --tag desktop-v<version>-<build> [--commit <sha>] [--repository <owner/name>] --out <file>
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const UPSTREAM = 'https://github.com/RyanYahya/OpenDoc';

/** `desktop-v0.6.1-2` (or a rehearsal's `dryrun-desktop-v0.6.1-2`) to { version: '0.6.1', build: 2 }. */
export function parseReleaseTag(tag) {
  const match = /^(?:dryrun-)?desktop-v(\d+\.\d+\.\d+)-([1-9]\d*)$/.exec(String(tag ?? ''));
  if (!match) throw new Error(`A release tag is desktop-v<x.y.z>-<build>, got "${tag}".`);
  return { version: match[1], build: Number(match[2]) };
}

/** The install and update notes for this version and build. `repository` (owner/name) and `commit` make the link to the user guide. */
export function installNotes({ version, build, repository = '', commit = '' }) {
  const file = (name) => `\`${name}\``;
  const guide = repository ? `https://github.com/${repository}/blob/${commit || 'HEAD'}/docs/DESKTOP.md` : '';
  return [
    '## Which file',
    '',
    '| System | File |',
    '|---|---|',
    `| Linux, any distribution (x86_64) | ${file('opendoc-desktop-x86_64.AppImage')} |`,
    `| Debian, Ubuntu (x86_64) | ${file(`opendoc-desktop_${version}-${build}_amd64.deb`)} |`,
    `| Fedora, openSUSE (x86_64) | ${file(`opendoc-desktop-${version}-${build}.x86_64.rpm`)} |`,
    `| Arch Linux (x86_64) | ${file(`opendoc-desktop-${version}-${build}-x64.pacman`)} |`,
    `| macOS, Apple Silicon (M1 or newer) | ${file(`opendoc-desktop-${version}-${build}-arm64.dmg`)} (or the \`.zip\`) |`,
    '',
    'There is no build for Intel Macs. `latest-linux.yml` and `latest-mac.yml` are the update information the app reads; you never need them.',
    '',
    '## Installing',
    '',
    '- **AppImage:** `chmod +x opendoc-desktop-x86_64.AppImage`, then run it. It needs FUSE 2 (on Ubuntu 24.04: `sudo apt install libfuse2t64`). Keep it in a folder you can write to: updates replace the file in place. The first start copies the runtime (about 185 MB) to `~/.local/share/opendoc-desktop/runtime/` and sets up the `opendoc` command in `~/.local/bin`. The AppImage makes no menu entry.',
    `- **Ubuntu 24.04:** prefer the deb. It installs an AppArmor profile, so the app runs in Chromium's sandbox; the AppImage starts without that sandbox there.`,
    `- **deb:** \`sudo apt install ./opendoc-desktop_${version}-${build}_amd64.deb\``,
    `- **rpm:** \`sudo dnf install --nogpgcheck ./opendoc-desktop-${version}-${build}.x86_64.rpm\` (openSUSE: \`sudo zypper install --allow-unsigned-rpm ...\`). The flag is needed because the package is not signed.`,
    `- **Arch:** \`sudo pacman -U ./opendoc-desktop-${version}-${build}-x64.pacman\`.`,
    '- **macOS:** open the `.dmg` and drag opendoc-desktop to Applications; don\'t run it from the disk image or from Downloads. The app is not notarized, so macOS blocks the first launch: open it once, then in System Settings > Privacy & Security click **Open Anyway** next to "opendoc-desktop was blocked" (on macOS 14 and earlier: Control-click the app, then **Open**). Or run `xattr -dr com.apple.quarantine /Applications/opendoc-desktop.app` once.',
    '',
    'The deb, rpm and pacman installs put the app in `/opt/opendoc-desktop/`, add the "OpenDoc Desktop" menu entry and the `opendoc` command. On macOS, choose **Install Command-Line Tool...** in the app menu for the `opendoc` command.',
    '',
    '## Updates',
    '',
    'The app checks for a new build only while it is open: at launch, then once a day. **Check for Updates Automatically** in the Help menu (the app menu on macOS) turns that off.',
    '',
    '| Install | What you do |',
    '|---|---|',
    '| AppImage | Nothing. The new file downloads in the background and replaces the AppImage when you quit. |',
    '| deb, rpm, or a pacman file | Click **Restart to Update**, then type your password (installing a system package needs it). |',
    '| macOS | Click **Restart to Update** while the app runs from Applications. From anywhere else it shows a button to this page instead. |',
    '',
    'A download is accepted only from this repository\'s releases, over HTTPS, and only when it matches the SHA-512 listed in `latest-linux.yml` or `latest-mac.yml`. The packages themselves are not signed. To check a file by hand: `openssl dgst -sha512 -binary <file> | base64 -w0` gives the same base64 form.',
    ...(guide ? ['', `The [user guide](${guide}) covers the first run, which workspaces open, the \`opendoc\` command, connecting AI apps and uninstalling.`] : []),
  ].join('\n');
}

/** The notes of a release made from a pushed tag: what it is, where OpenDoc comes from, then the install notes. */
export function tagReleaseNotes({ tag, commit = '', repository = '' }) {
  const { version, build } = parseReleaseTag(tag);
  const opening = [
    `OpenDoc Desktop ${version}, build ${build}: the desktop app for [OpenDoc](${UPSTREAM}) ${version}, on Linux and Apple Silicon Macs. It carries its own runtime, so you install no Node or npm.`,
    '',
    `It is built on the original OpenDoc project by RyanYahya, released under the MIT license: ${UPSTREAM}`,
    ...(commit ? ['', `Built from commit ${commit.slice(0, 12)} of this repository.`] : []),
  ];
  return `${opening.join('\n')}\n\n${installNotes({ version, build, repository, commit })}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { tag: { type: 'string' }, commit: { type: 'string', default: '' }, repository: { type: 'string', default: '' }, out: { type: 'string' } } });
  if (!values.tag || !values.out) {
    console.error('Usage: node desktop/release/notes.mjs --tag desktop-v<version>-<build> [--commit <sha>] [--repository <owner/name>] --out <file>');
    process.exit(2);
  }
  writeFileSync(values.out, tagReleaseNotes(values));
}
