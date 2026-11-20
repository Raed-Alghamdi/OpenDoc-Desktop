#!/usr/bin/env node
// Fails when a built installer is a test build: its app.asar holds a package.json with the field `opendocTestBuild` (made with
// OPENDOC_DESKTOP_TEST_BUILD=1, see runtime/test-build.mjs). A release must never carry it. Reads each deb, rpm, pacman, AppImage and
// macOS zip it is given (files, or folders searched through); a dmg is listed but not read (it needs macOS; its app is in the zip).
// An installer that cannot be read is an error too. It fails when it finds nothing to check.
//
// Usage: node desktop/tests/packaging/check-release.mjs <file or folder>...
import path from 'node:path';
import { installerKind, installerTestBuildMark, installersUnder } from './app-archive.mjs';
import { testBuildField } from '../../runtime/test-build.mjs';

const targets = process.argv.slice(2);
if (targets.length === 0) { console.error('usage: check-release.mjs <file or folder>...'); process.exit(2); }

const lines = [];
let checked = 0;
let problems = 0;
let files;
try { files = installersUnder(targets); } catch (error) { console.error(error.message); process.exit(2); }
for (const file of files) {
  const label = `${path.basename(file)} (${installerKind(file)})`;
  try {
    const mark = installerTestBuildMark(file);
    if (mark.skipped) { lines.push(`skip  ${label}: not readable without macOS; the zip and the unpacked app carry the same app`); continue; }
    checked += 1;
    if (mark.present) { problems += 1; lines.push(`FAIL  ${label}: this is a test build (${testBuildField} is in its package.json); a release must not carry it`); }
    else lines.push(`ok    ${label}: no ${testBuildField}`);
  } catch (error) {
    problems += 1;
    lines.push(`FAIL  ${label}: ${error.message}`);
  }
}
if (checked === 0 && problems === 0) { problems += 1; lines.push(`FAIL  no installer to check under ${targets.join(', ')}`); }
console.log(lines.join('\n'));
process.exit(problems === 0 ? 0 : 1);
