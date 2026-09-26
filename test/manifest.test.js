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
    // (B-1, B-2, task 21)
    const {note, ...runtime} = manifest.runtime;
    assert.deepEqual(runtime, {daemon: true, needs: ['rfd', 'hmipserver'], start: 'early'});
    assert.ok(note.de && note.en);
});
