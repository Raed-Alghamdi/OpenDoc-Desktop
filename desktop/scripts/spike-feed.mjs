#!/usr/bin/env node
// Spike S6: add the build number to electron-builder's update metadata (plan 3.7, "version first, then build").
// electron-builder writes latest-linux.yml / latest-mac.yml with `version` but knows nothing of our build number, and the
// stock updater ignores unknown top-level keys, so one added line is enough. E5/E13 run this after every build.
// Usage: node spike-feed.mjs <metadata.yml> <build> [commit]
import { readFileSync, writeFileSync } from 'node:fs';

const [file, build, commit] = process.argv.slice(2);
if (!file || !/^[1-9]\d*$/.test(build ?? '')) { console.error('usage: spike-feed.mjs <metadata.yml> <build> [commit]'); process.exit(2); }
let text = readFileSync(file, 'utf8').replace(/^build: .*\n/m, '').replace(/^commit: .*\n/m, '');
text = text.replace(/^(version: .*\n)/m, `$1build: ${build}\n${commit ? `commit: ${commit}\n` : ''}`);
writeFileSync(file, text);
console.log(text.split('\n').slice(0, 4).join('\n'));
