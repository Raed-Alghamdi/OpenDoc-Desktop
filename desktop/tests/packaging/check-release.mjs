#!/usr/bin/env node
// Fails when a built installer is a test build: its app.asar holds a package.json with the field `opendocTestBuild` (made with
// OPENDOC_DESKTOP_TEST_BUILD=1, see runtime/test-build.mjs). A release must never carry it. Reads each deb, rpm, pacman, AppImage and
// macOS zip it is given (files, or folders searched through); a dmg is listed but not read (it needs macOS; its app is in the zip).
// An installer that cannot be read is an error too. It fails when it finds nothing to check.
//
// Every installer (a dmg too) must also have `<file>.sig` beside it: the raw 64-byte Ed25519 signature desktop/release/sign.mjs writes,
// which must verify with the release public key (desktop/resources/updater/release-key.pem, or --public-key <pem> for a test).
// --skip-signatures leaves that out, for the builds that are not signed yet (the build jobs, and the release job before it signs).
//
// Usage: node desktop/tests/packaging/check-release.mjs [--skip-signatures] [--public-key <pem>] <file or folder>...
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { installerKind, installerTestBuildMark, installersUnder } from './app-archive.mjs';
import { testBuildField } from '../../runtime/test-build.mjs';
import { publicKeyFile, publicKeyFrom, signatureIsValid, signatureLength } from '../../release/sign.mjs';

let options;
try { options = parseArgs({ options: { 'skip-signatures': { type: 'boolean', default: false }, 'public-key': { type: 'string', default: publicKeyFile } }, allowPositionals: true, strict: true }); }
catch (error) { console.error(`check-release.mjs: ${error.message}`); process.exit(2); }
const targets = options.positionals;
if (targets.length === 0) { console.error('usage: check-release.mjs [--skip-signatures] [--public-key <pem>] <file or folder>...'); process.exit(2); }
const checkSignatures = !options.values['skip-signatures'];
let publicKey = null;
if (checkSignatures) {
  try { publicKey = publicKeyFrom(options.values['public-key']); } catch (error) { console.error(error.message); process.exit(2); }
}

/** null when `<file>.sig` is a 64-byte file that verifies with the public key, else what is wrong with it. */
function signatureProblem(file) {
  const signatureFile = `${file}.sig`;
  let info;
  try { info = statSync(signatureFile); } catch { return `no ${path.basename(signatureFile)} beside it`; }
  if (!info.isFile()) return `${path.basename(signatureFile)} is not a file`;
  if (info.size !== signatureLength) return `${path.basename(signatureFile)} is ${info.size} bytes, not ${signatureLength}`;
  return signatureIsValid(readFileSync(file), readFileSync(signatureFile), publicKey) ? null : `${path.basename(signatureFile)} does not verify with the release public key`;
}

const lines = [];
let checked = 0;
let problems = 0;
let files;
try { files = installersUnder(targets); } catch (error) { console.error(error.message); process.exit(2); }
for (const file of files) {
  const label = `${path.basename(file)} (${installerKind(file)})`;
  if (checkSignatures) {
    const problem = signatureProblem(file);
    if (problem) { problems += 1; lines.push(`FAIL  ${label}: ${problem}`); }
    else lines.push(`ok    ${label}: signed with the release key`);
  }
  try {
    const mark = installerTestBuildMark(file);
    if (mark.skipped) { checked += checkSignatures ? 1 : 0; lines.push(`skip  ${label}: not readable without macOS; the zip and the unpacked app carry the same app`); continue; }
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
