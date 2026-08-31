#!/usr/bin/env node

/**
 * Generates GitHub release notes for a tag: the matching CHANGELOG.md section first,
 * then all commits since the previous tag grouped by type with linked commit ids.
 *
 *   node .github/release-notes.js v1.9.0 > notes.md
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const tag = process.argv[2];
if (!tag) {
    console.error('usage: release-notes.js <tag>');
    process.exit(1);
}

const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();

const repoUrl = (() => {
    const remote = process.env.GITHUB_REPOSITORY
        ? 'https://github.com/' + process.env.GITHUB_REPOSITORY
        : git('remote', 'get-url', 'origin');
    return remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
})();

// previous tag in history (not just by name)
let previous = '';
try {
    previous = git('describe', '--tags', '--abbrev=0', tag + '^');
} catch {
    // first release
}

const range = previous ? previous + '..' + tag : tag;
const log = git('log', range, '--no-merges', '--format=%H%x1f%s%x1f%an');
const commits = log
    ? log.split('\n').map((line) => {
          const [sha, subject, author] = line.split('\x1f');
          return {sha, subject: cleanSubject(subject), author};
      })
    : [];

/**
 * A commit subject as it should read in the notes: without the Co-authored-by trailer, and with
 * any literal "\n" turned into a real line break — a `-m` written with an escape the shell never
 * interpreted leaves the whole message, trailer included, sitting in the subject.
 */
function cleanSubject(subject) {
    return String(subject)
        .replace(/\\r\\n|\\n|\\r/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^co-authored-by:/i.test(line))
        .join('\n');
}

// order matters: the first matching group wins, output order is fixed below
const GROUPS = [
    {
        title: 'Tests & tooling',
        test: /^(test|tests|ci|chore|build|lint|style|refactor|perf)\b|\b(tests?|eslint|prettier|workflow|github actions|gitattributes|tooling|release|deploy)\b/i,
    },
    {
        title: 'Documentation',
        test: /^(docs?|readme|changelog|roadmap)\b|\b(readme|changelog|roadmap|documentation|CLAUDE\.md|AGENTS\.md)\b/i,
    },
    {
        title: 'Dependencies',
        test: /^(deps?|dependencies|lockfile|bump)\b|\b(deps|dependenc(y|ies)|lockfile|package-lock|npm audit|depend on)\b/i,
    },
    {title: 'Features', test: /^(feat|add|new|\d+\.\d+\.\d+)\b|^(add|implement|introduce|support)\s/i},
    {title: 'Fixes', test: /^(fix|bug|hotfix)\b|\b(fix|fixes|fixed|crash|normalize|handle|guard)\b/i},
];
const ORDER = ['Features', 'Fixes', 'Documentation', 'Dependencies', 'Tests & tooling'];
const OTHER = 'Other';
const SKIP = /^(bump version|release|v?\d+\.\d+\.\d+)$/i;

const grouped = new Map([...ORDER, OTHER].map((title) => [title, []]));
for (const c of commits) {
    if (SKIP.test(c.subject)) continue;
    const group = GROUPS.find((g) => g.test.test(c.subject));
    grouped.get(group ? group.title : OTHER).push(c);
}

function changelogSection(version) {
    // read the CHANGELOG as of the tag, so the job may run from any checkout
    let text;
    try {
        text = git('show', tag + ':CHANGELOG.md');
    } catch {
        try {
            text = fs.readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8');
        } catch {
            return '';
        }
    }
    const lines = text.split('\n');
    const start = lines.findIndex((l) => new RegExp('^## ' + version.replace(/\./g, '\\.') + '\\b').test(l));
    if (start === -1) return '';
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    if (end === -1) end = lines.length;
    return (
        lines
            .slice(start + 1, end)
            .join('\n')
            .trim()
            // demote headings so they nest under the release title
            .replace(/^### /gm, '#### ')
    );
}

/**
 * The "which file do I need" table (H-42). npm and the Docker image always exist; the addon
 * packages are listed only for the architectures this release actually carries, so the notes can
 * never point at a file that was not built. `dist/` is where the release job collects them.
 * @param {string} version
 * @returns {string}
 */
function installationSection(version) {
    const assets = fs.existsSync('dist') ? fs.readdirSync('dist').filter((name) => name.endsWith('.tar.gz')) : [];
    const image = 'ghcr.io/' + (process.env.GITHUB_REPOSITORY || 'hobbyquaker/hm2mqtt.js').toLowerCase();

    const rows = [
        ['Any host with Node ≥ 20.19 (server, Raspberry Pi, NAS)', `\`npm install -g hm2mqtt@${version}\``],
        ['Docker — amd64, arm64, armv7', `\`${image}:${version}\``],
    ];

    // architecture -> the platforms that need that package
    const platforms = [
        ['armv7l', 'CCU3 with the official eQ-3 firmware — *Systemsteuerung → Zusatzsoftware*'],
        ['armv7l', 'OpenCCU 32-bit (CCU3 hardware, Raspberry Pi 2/3)'],
        ['aarch64', 'OpenCCU 64-bit (Raspberry Pi 4/5)'],
        ['x86_64', 'OpenCCU on x86_64 (debmatic, virtual machines)'],
    ];
    let beta = false;
    for (const [arch, platform] of platforms) {
        const asset = assets.find((name) => name.includes(`-ccu-${arch}-`));
        if (!asset) continue;
        if (asset.includes('-beta')) beta = true;
        rows.push([platform, `[\`${asset}\`](${repoUrl}/releases/download/${tag}/${asset})`]);
    }

    const lines = ['## Installation', '', '| Platform | Install |', '| --- | --- |'];
    for (const [platform, install] of rows) {
        lines.push(`| ${platform} | ${install} |`);
    }
    if (rows.length > 2) {
        lines.push(
            '',
            '### Which addon package?',
            '',
            'The architecture, not the firmware, decides — `ssh` into the CCU and run `uname -m`:',
            '',
            '| `uname -m` | Package |',
            '| --- | --- |',
            '| `armv7l` (CCU3, ELV-Charly, Raspberry Pi 2/3) | `armv7l` |',
            '| `aarch64` (OpenCCU 64-bit on Raspberry Pi 4/5) | `aarch64` |',
            '| `x86_64` (debmatic, OpenCCU in a VM) | `x86_64` |',
            '',
            'A CCU3 with the original eQ-3 firmware is always `armv7l`. The package is installed in the WebUI ' +
                'under *Systemsteuerung → Zusatzsoftware → Zusatzsoftware installieren*, and afterwards a ' +
                '**hm2mqtt** button appears in *Systemsteuerung* where everything is configured. Each package ' +
                'has a `.sha256` next to it.',
            '',
            'What it does on the CCU: it brings its own Node.js and keeps everything inside ' +
                "`/usr/local/addons/hm2mqtt`, so no other addon's Node.js is used or disturbed, and it talks to " +
                'the interface processes directly (binrpc 32001/32000, hmipserver 32010, ReGa 8183) — no CCU ' +
                'authentication, no firewall rules, nothing of hm2mqtt listening on the network. The one thing ' +
                'you have to set is the broker URL: a CCU has no MQTT broker of its own, so point it at one on ' +
                'your network or install the Mosquitto addon.',
        );
        if (beta) {
            lines.push(
                '',
                '> **The addon packages are beta.** They are built and tested in CI, and the bundled runtime ' +
                    'and the whole test suite have been verified on a CCU3 (firmware 3.87.6, kernel 4.14) — but ' +
                    'nobody has yet installed the package itself on real hardware. If you try it, a short report ' +
                    'either way is very welcome; the beta marker comes off once one CCU3 and one OpenCCU install ' +
                    'are confirmed.',
            );
        }
    }
    return lines.join('\n');
}

const out = [];
out.push(installationSection(tag.replace(/^v/, '')), '');
const section = changelogSection(tag.replace(/^v/, ''));
if (section) {
    out.push('## Changelog', '', section, '');
}

out.push('## Commits' + (previous ? ` since ${previous}` : ''), '');
for (const [title, list] of grouped) {
    if (!list.length) continue;
    out.push(`### ${title}`, '');
    for (const c of list) {
        const short = c.sha.slice(0, 7);
        const [first, ...rest] = c.subject.split('\n');
        // two trailing spaces make a hard line break inside the list item
        out.push(`- ${first} ([${short}](${repoUrl}/commit/${c.sha}))` + (rest.length > 0 ? '  ' : ''));
        rest.forEach((line, index) => out.push('  ' + line + (index < rest.length - 1 ? '  ' : '')));
    }
    out.push('');
}
if (previous) {
    out.push(`**Full diff**: [${previous}...${tag}](${repoUrl}/compare/${previous}...${tag})`, '');
}

process.stdout.write(out.join('\n'));
