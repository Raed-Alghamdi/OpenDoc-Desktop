// desktop/release/sign.mjs: one raw Ed25519 signature per file, checked against the public key before anything is attached to a release,
// and the committed public key is a real Ed25519 key that openssl accepts.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateKeyFrom, publicKeyFile, publicKeyFrom, signFiles } from '../../release/sign.mjs';

const script = fileURLToPath(new URL('../../release/sign.mjs', import.meta.url));
const scratch = () => mkdtempSync(path.join(os.tmpdir(), 'opendoc-sign-'));
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicPem: publicKey.export({ type: 'spki', format: 'pem' }) };
};
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const sign = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('the committed public key is an Ed25519 key', () => {
  assert.equal(publicKeyFrom(publicKeyFile).asymmetricKeyType, 'ed25519');
  assert.match(readFileSync(publicKeyFile, 'utf8'), /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/);
});

test('each file gets a 64-byte .sig that verifies with the public key, and openssl agrees', { skip: !hasOpenssl && 'openssl is not installed' }, () => {
  const folder = scratch();
  try {
    const keys = pair();
    const files = ['a.deb', 'b.AppImage'].map(name => path.join(folder, name));
    files.forEach((file, index) => writeFileSync(file, `contents ${index}`));
    const publicFile = path.join(folder, 'public.pem');
    writeFileSync(publicFile, keys.publicPem);
    const run = sign(['--public-key', publicFile, ...files], { DESKTOP_SIGNING_KEY: keys.privatePem });
    assert.equal(run.status, 0, run.stderr);
    for (const file of files) {
      assert.equal(readFileSync(`${file}.sig`).length, 64);
      const check = spawnSync('openssl', ['pkeyutl', '-verify', '-pubin', '-inkey', publicFile, '-rawin', '-in', file, '-sigfile', `${file}.sig`], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stdout + check.stderr);
    }
    // A changed file no longer verifies.
    writeFileSync(files[0], 'changed');
    assert.notEqual(spawnSync('openssl', ['pkeyutl', '-verify', '-pubin', '-inkey', publicFile, '-rawin', '-in', files[0], '-sigfile', `${files[0]}.sig`]).status, 0);
    assert.doesNotMatch(run.stdout + run.stderr, /PRIVATE KEY/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a signing key that does not match the public key fails the run', () => {
  const folder = scratch();
  try {
    const signer = pair();
    const other = pair();
    const publicFile = path.join(folder, 'other.pem');
    writeFileSync(publicFile, other.publicPem);
    const file = path.join(folder, 'x.deb');
    writeFileSync(file, 'x');
    const run = sign(['--public-key', publicFile, file], { DESKTOP_SIGNING_KEY: signer.privatePem });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not match/);
    assert.throws(() => signFiles([file], { privateKey: signer.privateKey, publicKey: other.publicKey }), /does not verify/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a missing, empty or wrong key is refused with a clear message that never shows the key', () => {
  const folder = scratch();
  try {
    const file = path.join(folder, 'x.deb');
    writeFileSync(file, 'x');
    const missing = sign([file]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /DESKTOP_SIGNING_KEY is not set or is empty/);
    assert.equal(sign([file], { DESKTOP_SIGNING_KEY: '' }).status, 1);
    assert.equal(sign([file], { DESKTOP_SIGNING_KEY: '  \n' }).status, 1);
    const custom = sign(['--key-env', 'MY_KEY', file]);
    assert.match(custom.stderr, /MY_KEY is not set/);

    const garbage = sign([file], { DESKTOP_SIGNING_KEY: 'not a key SECRET-TEXT' });
    assert.equal(garbage.status, 1);
    assert.match(garbage.stderr, /PEM/);
    assert.doesNotMatch(garbage.stderr, /SECRET-TEXT/);

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const wrong = sign([file], { DESKTOP_SIGNING_KEY: rsa });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /rsa key, not an Ed25519 key/);
    assert.doesNotMatch(wrong.stderr, /BEGIN/);
    assert.throws(() => privateKeyFrom(undefined), /missing/);
    assert.equal(sign(['--key-env', 'DESKTOP_SIGNING_KEY']).status, 2, 'no file is a usage error');
    assert.deepEqual([...new Set([missing, garbage, wrong].map(run => run.status))], [1]);
    for (const name of ['x.deb.sig']) assert.throws(() => readFileSync(path.join(folder, name)), 'nothing was written');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a public key that is not Ed25519 is refused', () => {
  const folder = scratch();
  try {
    const publicFile = path.join(folder, 'rsa.pem');
    writeFileSync(publicFile, generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }));
    assert.throws(() => publicKeyFrom(publicFile), /not an Ed25519 key/);
    writeFileSync(publicFile, 'nothing');
    assert.throws(() => publicKeyFrom(publicFile), /public key/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
