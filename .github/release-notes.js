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
 * A short pointer to the artefacts (H-42). Only the addon packages need a table - which file goes
 * on which box is not obvious - and only for the architectures this release actually carries.
 * Everything else (install, options, configuration) is the README's job.
 * @param {string} version
 * @returns {string}
 */
function installationSection(version) {
    const assets = fs.existsSync('dist') ? fs.readdirSync('dist').filter((name) => name.endsWith('.tar.gz')) : [];
    const image = 'ghcr.io/' + (process.env.GITHUB_REPOSITORY || 'hobbyquaker/hm2mqtt.js').toLowerCase();
    const platforms = [
        ['armv7l', 'CCU3, ELV-Charly, OpenCCU 32-bit'],
        ['aarch64', 'OpenCCU 64-bit (Raspberry Pi 4/5)'],
        ['x86_64', 'OpenCCU x86_64 (debmatic, VM)'],
    ];

    const lines = ['## Installation', ''];
    const rows = [];
    let beta = false;
    for (const [arch, platform] of platforms) {
        const asset = assets.find((name) => name.includes(`-ccu-${arch}-`));
        if (!asset) continue;
        if (asset.includes('-beta')) beta = true;
        rows.push(`| ${platform} | [\`${asset}\`](${repoUrl}/releases/download/${tag}/${asset}) |`);
    }
    if (rows.length > 0) {
        lines.push(
            'CCU addon' + (beta ? ' (**beta**)' : '') + ' — install in the WebUI under *Zusatzsoftware*:',
            '',
            '| CCU | Package |',
            '| --- | --- |',
            ...rows,
            '',
        );
    }
    lines.push(
        `Server or NAS: \`npm install -g hm2mqtt@${version}\` · Docker: \`${image}:${version}\` · ` +
            `everything else in the [README](${repoUrl}#readme).`,
    );
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
