#!/usr/bin/env node
// The decisions behind upstream-watch.yml, kept out of the workflow so each row can be tested (the update rules).
//
//   planWatch      does upstream's version differ from ours, and is that a patch or a minor?
//   nextBuild      the build number for a version, counted up from the published tags
//   decideRelease  after the checks: published, left as a draft, or stopped; and whether the merge moves into the target branch
//   finalReport    the issue text and the release notes, after the merge and the publication have been tried
//
// Usage:
//   node desktop/release/decide.mjs decide --kind <kind> --version <x.y.z> --build <n> --tag <tag> --gate <value> --verify <result>
//        --desktop <result> --minor-published <true|false> --rehearsal <true|false> --out <decision.json>
//   node desktop/release/decide.mjs notes --decision <decision.json> --out <release-notes.md> [--commit <sha>] [--upstream-sha <sha>] [--repository <owner/name>]
//   node desktop/release/decide.mjs report --decision <decision.json> --promotion <success|failure|skipped> --publication <success|failure|skipped>
//        --out-dir <folder> [--run-url ...] [--owner ...] [--target ...] [--candidate-branch ...] [--detail ...]
// Results are GitHub's: success, failure, cancelled or skipped. Anything but success counts as red. With $GITHUB_OUTPUT set, the
// answers are also written there.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { installNotes } from './notes.mjs';

export const UPSTREAM_URL = 'https://github.com/RyanYahya/OpenDoc';
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const TAG = /^(dryrun-)?desktop-v(\d+\.\d+\.\d+)-([1-9]\d*)$/;

export function parseVersion(text) {
  const found = VERSION.exec(String(text).trim());
  if (!found) throw new Error(`"${text}" is not an x.y.z version.`);
  return found.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  return 0;
}

// Upstream against ours: same, older, patch (same x.y, higher z) or minor (anything else higher, a new major included).
export function classifyBump(current, upstream) {
  const order = compareVersions(upstream, current);
  if (order === 0) return 'same';
  if (order < 0) return 'older';
  const [currentMajor, currentMinor] = parseVersion(current);
  const [upstreamMajor, upstreamMinor] = parseVersion(upstream);
  return upstreamMajor === currentMajor && upstreamMinor === currentMinor ? 'patch' : 'minor';
}

// desktop-v<version>-<build>. A `dryrun-` prefix marks a rehearsal's tag, which never counts as a release.
export function parseTag(tag) {
  const found = TAG.exec(tag);
  return found ? { version: found[2], build: Number(found[3]), rehearsal: Boolean(found[1]) } : null;
}

export const tagName = (version, build, rehearsal = false) => `${rehearsal ? 'dryrun-' : ''}desktop-v${version}-${build}`;

// The real releases and tags of a version decide its next build: one more than the highest. Drafts are not counted by the caller
// (a draft has no tag and is replaced by the next run), and rehearsal tags never count.
export function nextBuild(version, tags) {
  const builds = tags.map(parseTag).filter((tag) => tag && !tag.rehearsal && tag.version === version).map((tag) => tag.build);
  return builds.length ? Math.max(...builds) + 1 : 1;
}

// True when some published release already carries this version's x.y line. A patch of a minor nobody has published by hand is
// not published automatically, or 0.7.1 would put 0.7 out without the upgrade step 0.7.0 needs.
export function minorPublished(version, tags) {
  const [major, minor] = parseVersion(version);
  return tags.map(parseTag).some((tag) => {
    if (!tag || tag.rehearsal) return false;
    const [tagMajor, tagMinor] = parseVersion(tag.version);
    return tagMajor === major && tagMinor === minor;
  });
}

export const titlePrefix = (rehearsal) => `[upstream-watch]${rehearsal ? '[rehearsal]' : ''} OpenDoc`;

// An open issue for this upstream version that is still waiting for the repository owner (every title except the "published" notice has a colon
// after the version). While one is open, the daily run does not build the same thing again.
export function findWaitingIssue(issues, version, rehearsal = false) {
  const start = `${titlePrefix(rehearsal)} ${version}:`;
  return issues.find((issue) => String(issue.title).startsWith(start))?.number ?? null;
}

// What to do with upstream's current state.
//   mode auto         compare versions; a patch or a minor means "merge and build"
//   mode rebuild      build the target branch again as the next build of its version (a fix of the app itself)
//   mode hand-merged  a maintainer resolved a conflict on the target branch; build it as it stands
export function planWatch({ mode = 'auto', targetVersion, upstreamVersion, issues = [], retry = false, rehearsal = false }) {
  if (mode === 'rebuild') return { action: 'build', kind: 'rebuild', version: targetVersion };
  if (mode === 'hand-merged') return { action: 'build', kind: 'hand-merged', version: targetVersion };
  if (mode !== 'auto') throw new Error(`Unknown mode "${mode}".`);
  if (!VERSION.test(upstreamVersion)) return { action: 'none', kind: 'none', reason: `upstream's version "${upstreamVersion}" is not a stable x.y.z` };
  const bump = classifyBump(targetVersion, upstreamVersion);
  if (bump === 'same') return { action: 'none', kind: 'none', reason: `upstream is still at ${upstreamVersion}` };
  if (bump === 'older') {
    return { action: 'stopped', kind: 'none', stop: 'older', reason: `upstream's ${upstreamVersion} is older than this branch's ${targetVersion}` };
  }
  const waiting = rehearsal || retry ? null : findWaitingIssue(issues, upstreamVersion);
  if (waiting) return { action: 'waiting', kind: bump, version: upstreamVersion, reason: `issue #${waiting} for ${upstreamVersion} is still open` };
  return { action: 'merge', kind: bump, version: upstreamVersion };
}

const isOn = (value) => String(value ?? '').trim().toLowerCase() === 'true';
const green = (result) => result === 'success';

// The gate. `gate` is the repository variable's value; only the text "true" turns it on. Publishing needs all of: the gate on,
// an upstream patch release, a clean merge (the kind is then patch, never conflict or hand-merged), verify and the installers green,
// and a patch of a minor that has already gone out. Everything else is a draft, or stopped when there is nothing to draft.
export function decideRelease({ kind, version, build, gate, verify, desktop, minorPublished: minorOut = false, rehearsal = false }) {
  const base = {
    kind, version, build, tag: tagName(version, build, rehearsal), rehearsal, gate: isOn(gate), verifyResult: verify, desktopResult: desktop,
    reasons: [], publish: false, promote: false, fail: false,
  };
  // 'stopped' is a run that could not go on before anything was built (upstream older than the branch, a refused push): the report says why.
  if (kind === 'conflict' || kind === 'stopped') return { ...base, outcome: 'stopped', release: 'none', fail: true, reasons: [kind] };
  if (!green(desktop)) return { ...base, outcome: 'stopped', release: 'none', fail: true, reasons: ['desktop-red', ...(green(verify) ? [] : ['verify-red'])] };
  // The installers exist, so there is a draft. A red verify keeps it a draft and keeps the merge out of the target branch.
  if (!green(verify)) return { ...base, outcome: 'draft', release: 'draft', fail: true, reasons: ['verify-red'] };
  const mergeKind = kind === 'patch' || kind === 'minor';
  const reasons = [];
  if (kind === 'minor') reasons.push('new-minor');
  if (kind === 'rebuild') reasons.push('rebuild');
  if (kind === 'hand-merged') reasons.push('hand-merged');
  if (kind === 'patch' && !base.gate) reasons.push('gate-off');
  if (kind === 'patch' && base.gate && !minorOut) reasons.push('minor-unpublished');
  const publish = reasons.length === 0 && kind === 'patch';
  return { ...base, outcome: publish ? 'published' : 'draft', release: publish ? 'published' : 'draft', publish, promote: mergeKind, reasons };
}

const REASON_TEXT = {
  stopped: 'The run could not go on. Nothing was built or published.',
  conflict: 'The merge of upstream into the target branch conflicted. Nothing was built or published.',
  'desktop-red': 'The installer build or the smoke test failed on at least one runner, so there is no release to draft.',
  'verify-red': 'Verify was red on at least one runner. A draft exists if the installers built, but the merge was not moved into the target branch.',
  'new-minor': 'A new minor is never published automatically: it can change how workspaces are written.',
  rebuild: 'A rebuild of the same version always waits for you.',
  'hand-merged': 'A merge resolved by hand always waits for you.',
  'gate-off': 'The publishing gate (the DESKTOP_AUTO_PUBLISH variable) is off.',
  'minor-unpublished': 'No release of this x.y line has gone out by hand yet, so this patch waits too.',
};

const KIND_TEXT = {
  patch: 'an upstream patch release',
  minor: 'a new upstream minor',
  rebuild: 'a rebuild of the same version',
  'hand-merged': 'a hand-merged build',
  conflict: 'an upstream release whose merge conflicted',
  stopped: 'upstream',
};

// Drops empty lines at the start and doubled empty lines, so optional lines can be left out by passing ''.
const squash = (lines) => lines.filter((line, index) => line !== '' || (index > 0 && lines[index - 1] !== '')).join('\n');

// The release notes credit the original project, then carry the install and update notes every release has (notes.mjs).
export function releaseNotes({ version, build, kind, upstreamSha, commit, repository }) {
  const lines = [
    `OpenDoc Desktop ${version}, build ${build}: the desktop app for OpenDoc ${version}.`,
    '',
    `OpenDoc is the original project by its maintainer: ${UPSTREAM_URL}`,
    kind === 'rebuild' ? 'This build changes the app only; OpenDoc itself is unchanged.' : `OpenDoc's own changes are listed in its repository${upstreamSha ? ` (upstream commit ${upstreamSha.slice(0, 12)})` : ''}.`,
    commit ? `Built from commit ${commit.slice(0, 12)} of this repository.` : '',
  ];
  return `${squash(lines)}\n\n${installNotes({ version, build, repository, commit })}\n`;
}

// What happened after the merge and the publication were tried. `promotion` is how moving the merge into the target branch ended and
// `publication` how publishing the draft ended (success, failure or skipped). A publication that did not happen in full is a draft.
export function finalReport(decision, { promotion = 'skipped', publication = 'skipped', runUrl = '', owner = '', target = 'roadmap', candidateBranch = '', detail = '' } = {}) {
  const heldBy = !decision.publish ? '' : promotion !== 'success' ? 'promotion-failed' : publication !== 'success' ? 'publication-failed' : '';
  const held = heldBy !== '';
  const outcome = held ? 'draft' : decision.outcome;
  const fail = decision.fail || held;
  const reasons = held ? [...decision.reasons, heldBy] : decision.reasons;
  const prefix = titlePrefix(decision.rehearsal);
  const subject = `${prefix} ${decision.version}`;
  let title;
  if (outcome === 'published') title = `${subject} published`;
  else if (decision.kind === 'conflict') title = `${subject}: merge conflict, nothing published`;
  else if (reasons.includes('verify-red') || reasons.includes('desktop-red')) title = `${subject}: a check is red, nothing published`;
  else if (outcome === 'stopped') title = `${subject}: stopped, nothing published`;
  else title = `${subject}: draft waiting for you`;

  const body = [];
  if (owner) body.push(`@${owner}`, '');
  body.push(
    `Upstream-watch looked at ${KIND_TEXT[decision.kind] ?? decision.kind}: OpenDoc ${decision.version}${decision.build ? `, build ${decision.build} (${decision.tag})` : ''}.`,
    decision.rehearsal ? 'This was a rehearsal: a test branch and a fake upstream. Nothing real was released.' : '',
    '',
    outcome === 'published'
      ? `It was published automatically (gate on, patch release, clean merge, every check green). ${decision.rehearsal ? 'The rehearsal marked it as a pre-release.' : 'The AUR bump follows.'}`
      : 'Nothing was published.',
  );
  for (const reason of reasons) {
    if (reason === 'promotion-failed') body.push(`- Moving the merge into ${target} failed (it moved meanwhile, or the push was refused), so the publication was held back.`);
    else if (reason === 'publication-failed') body.push('- Publishing the draft failed, so it is still a draft.');
    else body.push(`- ${REASON_TEXT[reason]}`);
  }
  if (detail) body.push('', detail);
  body.push('', `Checks: verify ${decision.verifyResult ?? 'n/a'}, installers and smoke test ${decision.desktopResult ?? 'n/a'}.`);
  if (runUrl) body.push(`Run: ${runUrl}`);
  if (candidateBranch && promotion !== 'success') body.push(`The merged candidate is on the branch \`${candidateBranch}\`.`);
  if (decision.kind === 'conflict') body.push('', `To finish: merge upstream into ${target} by hand, then run the workflow with mode "hand-merged".`);
  else if (reasons.includes('verify-red') && outcome === 'draft') {
    body.push('', `To finish: look at the red check (re-run it if it was a timeout), merge \`${candidateBranch}\` into ${target} by hand, then publish the draft ${decision.tag}.`);
  } else if (outcome === 'draft') body.push('', `To finish: read the draft release ${decision.tag}, then publish it (one click). Close this issue afterwards.`);
  else if (outcome === 'stopped') body.push('', 'To finish: fix the cause and run the workflow again. Close this issue so the daily run may try again.');
  return {
    title,
    body: `${squash(body)}\n`,
    outcome,
    published: outcome === 'published',
    fail,
  };
}

export function emit(outputs) {
  console.log(JSON.stringify(outputs));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, ' ')}\n`).join(''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: Object.fromEntries(['kind', 'version', 'build', 'tag', 'gate', 'verify', 'desktop', 'minor-published', 'rehearsal', 'out', 'decision', 'promotion', 'out-dir',
      'run-url', 'owner', 'target', 'candidate-branch', 'detail', 'commit', 'upstream-sha', 'publication', 'repository'].map((name) => [name, { type: 'string' }])),
  });
  if (command === 'decide') {
    const decision = decideRelease({
      kind: values.kind, version: values.version, build: Number(values.build), gate: values.gate, verify: values.verify, desktop: values.desktop,
      minorPublished: isOn(values['minor-published']), rehearsal: isOn(values.rehearsal),
    });
    decision.verifyResult = values.verify;
    decision.desktopResult = values.desktop;
    if (values.out) writeFileSync(values.out, `${JSON.stringify(decision, null, 2)}\n`);
    emit({ outcome: decision.outcome, release: decision.release, publish: decision.publish, promote: decision.promote, fail: decision.fail, reasons: decision.reasons.join(',') });
  } else if (command === 'notes') {
    const decision = JSON.parse(readFileSync(values.decision, 'utf8'));
    writeFileSync(values.out, releaseNotes({ ...decision, upstreamSha: values['upstream-sha'], commit: values.commit, repository: values.repository }));
  } else if (command === 'report') {
    const decision = JSON.parse(readFileSync(values.decision, 'utf8'));
    const report = finalReport(decision, {
      promotion: values.promotion, publication: values.publication, runUrl: values['run-url'], owner: values.owner, target: values.target, candidateBranch: values['candidate-branch'], detail: values.detail,
    });
    mkdirSync(values['out-dir'], { recursive: true });
    writeFileSync(path.join(values['out-dir'], 'issue.md'), report.body);
    emit({ title: report.title, outcome: report.outcome, published: report.published, fail: report.fail });
  } else {
    console.error('usage: decide.mjs decide|notes|report [options] (see the header of this file)');
    process.exit(2);
  }
}
