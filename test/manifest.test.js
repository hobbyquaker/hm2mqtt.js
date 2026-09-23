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
    // no runtime block: the adapter needs nothing beyond its own directories, and the start order
    // stays the platform's default until a boot measurement says otherwise
    assert.equal(manifest.runtime, undefined);
});
