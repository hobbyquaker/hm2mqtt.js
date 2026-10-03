/**
 * The openccu-lite manifest (addon/files/openccu-lite.json): addon/build.sh puts it at the root
 * of the package, beside update_script, where openccu-lite reads it before update_script runs.
 * The CCU3 and OpenCCU ignore it. Checked here is what the platform refuses: the format, the id
 * (the rc.d name update_script links), the release source it resolves the packages from.
 */

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const root = new URL('../addon/files/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('openccu-lite.json', root), 'utf8'));
const updateScript = readFileSync(new URL('update_script', root), 'utf8');

test('the openccu-lite manifest names this addon and its release source', () => {
    assert.equal(manifest.format, 1);
    assert.equal(manifest.id, /^ADDON=(\S+)/m.exec(updateScript)[1]);
    assert.equal(manifest.release.github, 'hobbyquaker/hm2mqtt.js');
    assert.equal(manifest.release.asset, 'hm2mqtt-ccu-{arch}-{version}.tar.gz');
    assert.deepEqual(manifest.requires.architectures, ['armv7l', 'aarch64', 'x86_64']);
    // the adapter keeps a process running (openccu-lite B-158) and needs nothing beyond its own
    // directories; it talks to rfd and hmipserver and starts before them (D-75): a missing interface
    // is re-probed and its init retried after 1, 2, 4, 8 s, then every 15 s, with info lines only
    // (B-1, B-2, task 21); its own API token reads the journal for the settings page's log view
    // (task 17) and nothing else
    const {note, ...runtime} = manifest.runtime;
    assert.deepEqual(runtime, {daemon: true, needs: ['rfd', 'hmipserver'], start: 'early', api_scopes: ['logs:read']});
    assert.ok(note.de && note.en);
    // the settings page and every CGI read openccu-lite's session header (task 20), so the system
    // opens the page without appending ?sid=; the icon and the logo (task 26) are the SVGs in www/,
    // which the system serves from the installed tree (the path's first segment is the package
    // directory that becomes /usr/local/addons/hm2mqtt) and the catalogue reads beside the manifest
    assert.deepEqual(manifest.ui, {
        icon: 'hm2mqtt/www/icon.svg',
        logo: 'hm2mqtt/www/logo.svg',
        logo_dark: 'hm2mqtt/www/logo-dark.svg',
        session_header: true,
    });
    for (const p of [manifest.ui.icon, manifest.ui.logo, manifest.ui.logo_dark]) {
        const svg = readFileSync(new URL(p, root), 'utf8');
        assert.ok(svg.trimStart().startsWith('<svg'), `${p} is an SVG`);
        assert.ok(svg.length < 256 * 1024, `${p} is under the system's 256 KiB`);
    }
});
