/**
 * The openccu-lite names provider: the documents of openccu-lite's conformance corpus
 * (test/fixtures/meta/, copied from the box's repository) and a fake `/api/meta/v1` server for
 * detection, the 401 path and an event → "names changed" round trip. No box needed;
 * test/occulite.test.js runs the same provider against a real occulited.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {MetaSync, detectMeta, deriveNames, enumLabels, addressOf, readLocalToken} from '../lib/meta.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'meta');
const house = () => JSON.parse(fs.readFileSync(path.join(fixtures, 'valid-house.json'), 'utf8'));

function fakeLog() {
    const lines = {info: [], warn: [], debug: [], error: []};
    const push =
        (level) =>
        (...args) =>
            lines[level].push(args.join(' '));
    return {...Object.fromEntries(Object.keys(lines).map((l) => [l, push(l)])), lines};
}

/**
 * A box: `/version` without a credential, snapshot and event stream with one. `push()` sends an
 * event to whoever is listening, `doc` is what the snapshot answers.
 */
function fakeBox({token = 'olt_token', doc = house(), version = {api: 'meta', version: 1, format: 1}} = {}) {
    const state = {doc, snapshots: 0, streams: 0, unauthorized: false, clients: new Set(), waiters: []};
    const authorized = (req) => !state.unauthorized && req.headers.authorization === `Bearer ${token}`;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://box');
        if (url.pathname === '/api/meta/v1/version') {
            res.writeHead(200, {'content-type': 'application/json'});
            res.end(JSON.stringify({...version, revision: state.doc.revision}));
            return;
        }
        if (!authorized(req)) {
            res.writeHead(401, {'content-type': 'application/json'});
            res.end(JSON.stringify({error: 'unauthenticated', message: 'login required'}));
            return;
        }
        if (url.pathname === '/api/meta/v1/snapshot') {
            state.snapshots += 1;
            res.writeHead(200, {'content-type': 'application/json'});
            res.end(JSON.stringify(state.doc));
            return;
        }
        if (url.pathname === '/api/meta/v1/events/sse') {
            state.streams += 1;
            state.since = url.searchParams.get('since');
            res.writeHead(200, {'content-type': 'text/event-stream'});
            res.write(': hello\n\n');
            state.clients.add(res);
            req.on('close', () => state.clients.delete(res));
            for (const resolve of state.waiters.splice(0)) {
                resolve();
            }
            return;
        }
        res.writeHead(404).end();
    });
    return {
        state,
        async start() {
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            this.url = `http://127.0.0.1:${server.address().port}`;
            return this;
        },
        push(event) {
            for (const client of state.clients) {
                client.write(`data: ${JSON.stringify(event)}\n\n`);
            }
        },
        streamed() {
            return state.clients.size > 0 ? Promise.resolve() : new Promise((resolve) => state.waiters.push(resolve));
        },
        async close() {
            for (const client of state.clients) {
                client.destroy();
            }
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

const once = (emitter, event, timeout = 4000) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${event} event within ${timeout} ms`)), timeout);
        emitter.once(event, (...args) => {
            clearTimeout(timer);
            resolve(args);
        });
    });

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-meta-'));
}

/** A port nothing listens on: bound to find a free one, then closed again. */
function closedPort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            server.close(() => resolve(port));
        });
    });
}

describe('metadata document', () => {
    test('names, rooms and functions from the conformance corpus', () => {
        const {channelNames, channelRooms, channelFunctions} = deriveNames(house().objects, house().enums);
        // the ref is <interface>.<address>; hm2mqtt keys everything by address
        assert.deepEqual(channelNames, {
            JEQ0230153: 'Thermostat Bad',
            'JEQ0230153:1': 'Thermostat Bad:1',
            '000A1B2C3D4E5F:4': 'Deckenlampe',
            '0011223344AABB:1': 'Küchenlicht',
        });
        // arrays of names, as ReGa's getRooms()/getFunctions() produced them
        assert.deepEqual(channelRooms['000A1B2C3D4E5F:4'], ['Wohnzimmer']);
        assert.deepEqual(channelFunctions['000A1B2C3D4E5F:4'], ['Licht']);
        assert.deepEqual(channelRooms['JEQ0230153:1'], ['Bad']);
        assert.deepEqual(channelFunctions['JEQ0230153:1'], ['Heizung']);
        // a device without enums has no rooms at all (undefined, not [])
        assert.equal(channelRooms.JEQ0230153, undefined);
        // an orphaned object keeps its name
        assert.equal(channelNames['0011223344AABB:1'], 'Küchenlicht');
    });

    test('the leaf node names the room, not the whole path (H-48)', () => {
        const labels = enumLabels(house().enums);
        assert.equal(labels.get('room/eg'), 'Erdgeschoss');
        assert.equal(labels.get('room/eg/wohnzimmer'), 'Wohnzimmer');
        const {channelRooms} = deriveNames(
            {'HmIP-RF.ABC:1': {name: 'x', enums: ['room/eg/wohnzimmer', 'room/og', 'floor/eg', 'room/nowhere']}},
            house().enums,
        );
        // the parent (Erdgeschoss) is not added, an unknown path is skipped, floor is not a room
        assert.deepEqual(channelRooms['ABC:1'], ['Wohnzimmer', 'Obergeschoss']);
    });

    test('every document of the corpus is survivable, valid or not', () => {
        for (const file of fs.readdirSync(fixtures)) {
            const doc = JSON.parse(fs.readFileSync(path.join(fixtures, file), 'utf8'));
            const derived = deriveNames(doc.objects, doc.enums);
            assert.ok(derived.channelNames, file);
            // a ref without an interface part (invalid-bad-ref) is skipped, not named ""
            assert.ok(!Object.keys(derived.channelNames).includes(''), file);
        }
        // depth 8 is the deepest tree the format allows
        const deep = JSON.parse(fs.readFileSync(path.join(fixtures, 'valid-depth-8.json'), 'utf8'));
        assert.equal(enumLabels(deep.enums).get('room/a/b/c/d/e/f/g/h'), 'h');
    });

    test('addressOf', () => {
        assert.equal(addressOf('BidCos-RF.JEQ0230153:1'), 'JEQ0230153:1');
        assert.equal(addressOf('HmIP-RF.0001D3C99C7D4B'), '0001D3C99C7D4B');
        assert.equal(addressOf('noseparator'), '');
        assert.equal(addressOf(undefined), '');
    });

    test('the local token is read from the box', () => {
        const dir = tempDir();
        const file = path.join(dir, 'local-token');
        assert.equal(readLocalToken(file), undefined);
        fs.writeFileSync(file, 'olt_1234567890abcdef1234567890abcdef\n');
        assert.equal(readLocalToken(file), 'olt_1234567890abcdef1234567890abcdef');
        fs.rmSync(dir, {recursive: true, force: true});
    });
});

describe('detection', () => {
    test('the version document means openccu-lite', async () => {
        const box = await fakeBox().start();
        const found = await detectMeta(box.url);
        assert.equal(found.ok, true);
        assert.equal(found.version.version, 1);
        await box.close();
    });

    test('a CCU answers something else - reachable, but not the metadata api', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(404, {'content-type': 'text/html'}).end('<html>404 - Not Found</html>');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const found = await detectMeta(`http://127.0.0.1:${server.address().port}`);
        assert.equal(found.ok, false);
        assert.equal(found.reachable, true, 'a CCU must not be probed again forever');
        await new Promise((resolve) => server.close(resolve));
    });

    test('nothing listening is not a CCU: reachable is false', async () => {
        const found = await detectMeta(`http://127.0.0.1:${await closedPort()}`, {timeout: 2000});
        assert.equal(found.ok, false);
        assert.equal(found.reachable, false);
    });
});

describe('MetaSync', () => {
    test('snapshot, event stream, names event, persistence', async () => {
        const box = await fakeBox().start();
        const dir = tempDir();
        const log = fakeLog();
        const sync = new MetaSync({url: box.url, token: 'olt_token', stateDir: dir, log});

        await sync.syncNames();
        assert.equal(sync.channelName('000A1B2C3D4E5F:4'), 'Deckenlampe');
        assert.deepEqual(sync.rooms('000A1B2C3D4E5F:4'), ['Wohnzimmer']);
        assert.deepEqual(sync.functions('JEQ0230153:1'), ['Heizung']);
        assert.equal(sync.channelAddress('Deckenlampe'), '000A1B2C3D4E5F:4');
        // system variables and programs do not exist here
        assert.equal(sync.hasVariable('Anwesenheit'), false);
        assert.equal(sync.hasProgram('Licht aus'), false);
        await assert.rejects(() => sync.setVariable('x', 1), /not available on this box/);
        assert.ok(log.lines.info.some((line) => line.includes('4 names, 5 rooms, 2 functions (revision 12)')));

        // a rename in the box's UI arrives as an event and changes the name, no restart, no poll
        await box.streamed();
        const changed = once(sync, 'names');
        box.push({
            revision: 13,
            kind: 'object.updated',
            ref: 'HmIP-RF.000A1B2C3D4E5F:4',
            value: {name: 'Deckenlampe Wohnzimmer', enums: ['room/eg/kueche', 'function/licht']},
        });
        await changed;
        assert.equal(sync.channelName('000A1B2C3D4E5F:4'), 'Deckenlampe Wohnzimmer');
        assert.deepEqual(sync.rooms('000A1B2C3D4E5F:4'), ['Küche']);
        assert.equal(sync.revision, 13);

        // a deleted object loses its name
        const deleted = once(sync, 'names');
        box.push({revision: 14, kind: 'object.deleted', ref: 'HmIP-RF.000A1B2C3D4E5F:4'});
        await deleted;
        assert.equal(sync.channelName('000A1B2C3D4E5F:4'), undefined);

        // the store is persisted where rega.json lives, so a restart without the box has names
        sync.stopPolling();
        const restarted = new MetaSync({url: 'http://127.0.0.1:0', stateDir: dir, log: fakeLog()});
        restarted.load();
        assert.equal(restarted.channelName('JEQ0230153:1'), 'Thermostat Bad:1');
        assert.deepEqual(restarted.rooms('JEQ0230153:1'), ['Bad']);
        assert.equal(restarted.revision, 14);
        restarted.stopPolling();
        await box.close();
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('a room renamed on the box renames it in every payload', async () => {
        const box = await fakeBox().start();
        const sync = new MetaSync({url: box.url, token: 'olt_token', log: fakeLog()});
        await sync.syncNames();
        await box.streamed();
        assert.deepEqual(sync.rooms('JEQ0230153:1'), ['Bad']);

        // node.* and enum.* events change names of rooms or paths of members: the provider
        // re-reads the snapshot instead of guessing
        const doc = house();
        doc.revision = 13;
        doc.enums.room.tree[1].children[0].name = 'Badezimmer';
        box.state.doc = doc;
        const changed = once(sync, 'names');
        box.push({revision: 13, kind: 'node.updated', enum: 'room', path: 'room/og/bad', value: {id: 'bad'}});
        await changed;
        assert.deepEqual(sync.rooms('JEQ0230153:1'), ['Badezimmer']);
        assert.equal(box.state.snapshots, 2);

        sync.stopPolling();
        await box.close();
    });

    test('a revision gap and an import both re-read the snapshot', async () => {
        const box = await fakeBox().start();
        const sync = new MetaSync({url: box.url, token: 'olt_token', log: fakeLog()});
        await sync.syncNames();
        await box.streamed();
        assert.equal(box.state.snapshots, 1);

        const doc = house();
        doc.revision = 99;
        doc.objects['BidCos-RF.NEW0000001:1'] = {name: 'Neuer Kanal', enums: []};
        box.state.doc = doc;
        const changed = once(sync, 'names');
        box.push({revision: 99, kind: 'object.updated', ref: 'BidCos-RF.OTHER:1', value: {name: 'x'}});
        await changed;
        assert.equal(box.state.snapshots, 2, 'a gap of more than one revision must re-snapshot');
        assert.equal(sync.channelName('NEW0000001:1'), 'Neuer Kanal');
        assert.equal(sync.channelName('OTHER:1'), undefined, 'the event that showed the gap is not applied blindly');

        const imported = once(sync, 'names');
        box.push({revision: 100, kind: 'import', objects: 5, enums: 3});
        await imported;
        assert.equal(box.state.snapshots, 3);

        sync.stopPolling();
        await box.close();
    });

    test('no credential: addresses only, one warning, and it recovers', async () => {
        const box = await fakeBox().start();
        const log = fakeLog();
        const sync = new MetaSync({url: box.url, token: 'olt_wrong', tokenFile: '/nonexistent', log});

        // 401 must not throw: the addon comes up and publishes addresses
        await sync.syncNames();
        assert.deepEqual(sync.channelNames, {});
        assert.equal(sync.channelName('JEQ0230153:1'), undefined);
        const warnings = log.lines.warn.filter((line) => line.includes('rejected the credential'));
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('--meta-token'));

        // ... and again on the next sync: still one warning
        await sync.syncNames();
        assert.equal(log.lines.warn.filter((line) => line.includes('rejected the credential')).length, 1);

        // the administrator creates a token: the next attempt picks the names up
        sync.token = 'olt_token';
        await sync.syncNames();
        assert.equal(sync.channelName('JEQ0230153:1'), 'Thermostat Bad:1');
        assert.ok(log.lines.info.some((line) => line.includes('accepts the credential again')));

        sync.stopPolling();
        await box.close();
    });

    test('an unreachable box degrades to the cached names', async () => {
        const dir = tempDir();
        fs.writeFileSync(
            path.join(dir, 'meta.json'),
            JSON.stringify({revision: 7, objects: {'BidCos-RF.ABC:1': {name: 'Licht Flur', enums: []}}, enums: {}}),
        );
        const log = fakeLog();
        const sync = new MetaSync({url: `http://127.0.0.1:${await closedPort()}`, stateDir: dir, log});
        sync.load();
        assert.equal(sync.channelName('ABC:1'), 'Licht Flur');
        await assert.rejects(() => sync.syncNames(), /ECONNREFUSED/);
        // the names survive the failed sync, and the provider keeps retrying by itself
        assert.equal(sync.channelName('ABC:1'), 'Licht Flur');
        sync.stopPolling();
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('the stream reconnects with ?since and the heartbeat is not an event', async () => {
        const box = await fakeBox().start();
        const sync = new MetaSync({url: box.url, token: 'olt_token', log: fakeLog()});
        sync.backoff = 10;
        await sync.syncNames();
        await box.streamed();
        assert.equal(box.state.streams, 1);
        assert.equal(box.state.since, null, 'the first connection has nothing to replay');

        // the box restarts: the stream drops and comes back asking for what was missed
        for (const client of box.state.clients) {
            client.destroy();
        }
        box.state.clients.clear();
        await box.streamed();
        assert.equal(box.state.streams, 2);
        assert.equal(box.state.since, '12');

        sync.stopPolling();
        await box.close();
    });
});
