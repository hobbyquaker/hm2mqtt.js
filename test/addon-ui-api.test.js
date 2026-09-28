/**
 * The addon UI's CGI calls (addon/ui/src/api.js): the WebUI session id travels in every query when
 * the page was opened with one, and no empty `sid=` is sent when it was not - openccu-lite opens the
 * page without ?sid= (task 20) and its gate sends the session as a header instead.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

const api = new URL('../addon/ui/src/api.js', import.meta.url);

/** api.js reads location.search once, at import: a fresh module per page address. */
async function load(search) {
    globalThis.location = {search};
    return import(`${api.href}?search=${encodeURIComponent(search)}`);
}

test('a page opened with ?sid= sends it with every call', async () => {
    const {query} = await load('?sid=%401234567890%40');
    assert.equal(query(), 'sid=%401234567890%40');
    assert.equal(query({cmd: 'status'}), 'sid=%401234567890%40&cmd=status');
});

test('a page opened without ?sid= sends no sid at all', async () => {
    const {query} = await load('?theme=dark&lang=de');
    assert.equal(query(), '');
    assert.equal(query({cmd: 'status', lines: 300}), 'cmd=status&lines=300');
    assert.doesNotMatch(query({cmd: 'restart'}), /sid=/);
});

test('empty parameters are left out either way', async () => {
    const {query} = await load('');
    assert.equal(query({cmd: 'probe', address: '', port: null, other: undefined}), 'cmd=probe');
});
