#!/usr/bin/env node
// Signs release files with the release key (Ed25519). Each file gets `<file>.sig` beside it: a raw 64-byte signature over the whole
// file (PureEdDSA, no hash step first). The private key is a PKCS#8 PEM held in an environment variable (the repository secret
// DESKTOP_SIGNING_KEY in CI); it is never printed. After signing, every signature is checked again with the committed public key
// (desktop/resources/updater/release-key.pem), so a secret that does not belong to that key fails here, before anything is attached
// to a release. Anyone can check a file by hand:
//   openssl pkeyutl -verify -pubin -inkey release-key.pem -rawin -in <file> -sigfile <file>.sig
//
// Usage: node desktop/release/sign.mjs [--key-env <name>] [--public-key <pem>] <file>...
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const defaultKeyVariable = 'DESKTOP_SIGNING_KEY';
export const signatureLength = 64;
export const publicKeyFile = fileURLToPath(new URL('../resources/updater/release-key.pem', import.meta.url));

/** The signing key from an environment value, or a thrown Error with a message that never contains the value. */
export function privateKeyFrom(text, name = defaultKeyVariable) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error(`The signing key is missing: ${name} is not set or is empty.`);
  let key;
  try { key = createPrivateKey(text); } catch { throw new Error(`${name} does not hold a private key in PEM form (PKCS#8).`); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${name} holds a ${key.asymmetricKeyType} key, not an Ed25519 key.`);
  return key;
}

/** The public key in a PEM file, which must be Ed25519. */
export function publicKeyFrom(file) {
  let key;
  try { key = createPublicKey(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} does not hold a public key in PEM form.`); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} holds a ${key.asymmetricKeyType} key, not an Ed25519 key.`);
  return key;
}

/** Is `signature` (a Buffer) a valid signature of `data` under `publicKey`? */
export const signatureIsValid = (data, signature, publicKey) => signature.length === signatureLength && verify(null, data, publicKey, signature);

/**
 * Sign each file and check each signature with the public key. Returns the signature files written.
 * Throws on the first problem; a signature that does not verify is removed again first.
 */
export function signFiles(files, { privateKey, publicKey }) {
  if (files.length === 0) throw new Error('No file to sign.');
  const written = [];
  for (const file of files) {
    const data = readFileSync(file);
    const signature = sign(null, data, privateKey);
    const target = `${file}.sig`;
    writeFileSync(target, signature);
    written.push(target);
    if (!signatureIsValid(data, readFileSync(target), publicKey)) {
      rmSync(target, { force: true });
      throw new Error(`The signature of ${path.basename(file)} does not verify with the release public key: the signing key does not match it.`);
    }
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      options: { 'key-env': { type: 'string', default: defaultKeyVariable }, 'public-key': { type: 'string', default: publicKeyFile } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length === 0) {
      console.error('usage: sign.mjs [--key-env <name>] [--public-key <pem>] <file>...');
      process.exit(2);
    }
    const privateKey = privateKeyFrom(process.env[values['key-env']], values['key-env']);
    const publicKey = publicKeyFrom(values['public-key']);
    const written = signFiles(positionals, { privateKey, publicKey });
    console.log(`Signed ${written.length} file${written.length === 1 ? '' : 's'}; every signature verifies with ${path.basename(values['public-key'])}.`);
    for (const file of written) console.log(`  ${path.basename(file)}`);
  } catch (error) {
    console.error(`sign.mjs: ${error.message}`);
    process.exit(1);
  }
}
