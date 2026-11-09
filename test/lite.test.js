/**
 * openccu-lite through occulite-client (lib/lite.js): the hub that keeps the connection, the
 * interfaces shaped like RpcConnection, the names provider shaped like RegaSync, the credential
 * file and pairing, and the choice of the connection. Against occulite-client's FakeBox (a fake
 * system in one http server) where the wire matters, against stub clients where a branch does.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MetaCopy} from 'occulite-client';
import {FakeBox} from 'occulite-client/testing';

import {
    CREDENTIAL_FILE,
    LiteConnection,
    LiteHub,
    LiteNames,
    RETRY_SCHEDULE_MS,
    addressOf,
    chooseBackend,
    createLiteClient,
    isExecutable,
    isLiteSystem,
    pairAndStore,
    readCredential,
    remoteAuth,
    remoteSetup,
    remoteTrust,
    systemAuth,
    watchForLite,
    spacedCode,
    toWire,
    writeCredential,
} from '../lib/lite.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'meta');
const house = () => JSON.parse(fs.readFileSync(path.join(fixtures, 'valid-house.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-lite-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeLog() {
    const lines = {info: [], warn: [], debug: [], error: []};
    const push =
        (level) =>
        (...args) =>
            lines[level].push(args.join(' '));
    return {...Object.fromEntries(Object.keys(lines).map((l) => [l, push(l)])), lines};
}

async function waitFor(predicate, ms = 5000, what = 'condition') {
    const until = Date.now() + ms;
    for (;;) {
        const hit = predicate();
        if (hit) {
            return hit;
        }
        if (Date.now() > until) {
            throw new Error('timeout waiting for ' + what);
        }
        await sleep(10);
    }
}

/** a port nothing listens on */
function closedPort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            server.close(() => resolve(port));
        });
    });
}

/** An occulite-client stand-in: what the hub reads of a client, and the events it subscribes to. */
class StubBox {
    constructor(o = {}) {
        this.o = o;
        this.handlers = new Map();
        this.status = 'idle';
        this.interfaces = o.interfaces || [];
        this.values = new Map(o.values || []);
        this.devices = new Map(o.devices || []);
        this.info = 'info' in o ? o.info : {implementation: 'stub'};
        this.credential = 'token';
        this.mode = o.mode || 'full';
        this.capabilities = o.capabilities;
        this.meta = o.meta || new MetaCopy();
        this.calls = [];
        this.closed = false;
    }

    on(event, fn) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event).push(fn);
    }

    emit(event, arg) {
        for (const fn of this.handlers.get(event) || []) {
            fn(arg);
        }
    }

    async ready() {
        if (this.o.ready) {
            return this.o.ready(this);
        }
        this.status = 'ready';
    }

    close() {
        this.closed = true;
        this.status = 'closed';
    }

    async call(iface, method, params) {
        this.calls.push([iface, method, params]);
        return this.o.result;
    }
}

/** createClient for the hub: hands out the boxes in turn, records what it was asked */
function clients(...boxes) {
    const asked = [];
    const create = (options) => {
        asked.push(options);
        return boxes.shift();
    };
    return {create, asked};
}

describe('the system and the credential', () => {
    test('isLiteSystem: a LITE= line in /VERSION, else occulited', () => {
        assert.equal(isLiteSystem({read: () => 'VERSION=3.89\nLITE=1.0.0\n', executable: () => false}), true);
        assert.equal(isLiteSystem({read: () => 'VERSION=3.89\n', executable: () => false}), false);
        assert.equal(isLiteSystem({read: () => 'VERSION=3.89\n', executable: () => true}), true);
        const missing = () => {
            throw new Error('ENOENT');
        };
        assert.equal(isLiteSystem({read: missing, executable: () => false}), false);
        // the defaults read this host: a workstation or CI runner is no openccu-lite
        assert.equal(typeof isLiteSystem(), 'boolean');
        assert.equal(isExecutable(process.execPath), true);
        assert.equal(isExecutable(path.join(tmp(), 'nothing')), false);
    });

    test('the credential file: 0600, read back, a broken or empty one is none', () => {
        const dir = tmp();
        assert.equal(readCredential(dir), undefined);
        const file = writeCredential(path.join(dir, 'state'), {
            url: 'https://box',
            token: 'olt_1',
            fingerprint256: 'AB:CD',
        });
        assert.equal(file, path.join(dir, 'state', CREDENTIAL_FILE));
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.deepEqual(readCredential(path.join(dir, 'state')), {
            url: 'https://box',
            token: 'olt_1',
            fingerprint256: 'AB:CD',
        });
        writeCredential(dir, {url: 'http://box', token: 'olt_2'});
        assert.equal(readCredential(dir).fingerprint256, '');
        fs.writeFileSync(path.join(dir, CREDENTIAL_FILE), '{"token": ""}');
        assert.equal(readCredential(dir), undefined);
        fs.writeFileSync(path.join(dir, CREDENTIAL_FILE), 'null');
        assert.equal(readCredential(dir), undefined);
        fs.writeFileSync(path.join(dir, CREDENTIAL_FILE), 'not json');
        assert.equal(readCredential(dir), undefined);
    });

    test('spacedCode, addressOf, toWire', () => {
        assert.equal(spacedCode('482719'), '482 719');
        assert.equal(spacedCode(12), '12');
        assert.equal(addressOf('HmIP-RF.0001D3C99C7D4B:3'), '0001D3C99C7D4B:3');
        assert.equal(addressOf('nodot'), '');
        assert.equal(addressOf(undefined), '');
        // a FLOAT: typed double when the system takes it and the number is integral
        assert.deepEqual(toWire({explicitDouble: 1}, true), {double: 1});
        assert.equal(toWire({explicitDouble: 1}, false), 1);
        assert.equal(toWire({explicitDouble: 0.5}, true), 0.5);
        // a whole paramset, per entry; everything else as it is
        assert.deepEqual(toWire({LEVEL: {explicitDouble: 0}, STATE: true}, true), {LEVEL: {double: 0}, STATE: true});
        assert.deepEqual(toWire({explicitDouble: 1, other: 2}, true), {explicitDouble: 1, other: 2});
        for (const v of [null, 0, 'x', true, [1, 2]]) {
            assert.deepEqual(toWire(v, true), v);
        }
    });

    test('pairAndStore: the code is logged, the credential stored (FakeBox approves)', async () => {
        const fake = new FakeBox({autoApprove: true, token: 'never-used'});
        const url = await fake.start();
        const dir = tmp();
        const log = fakeLog();
        try {
            const paired = await pairAndStore({url, stateDir: dir, log, appVersion: '3.10.0', instance: 'host'});
            assert.match(paired.token, /./);
            assert.deepEqual(readCredential(dir), {url, token: paired.token, fingerprint256: ''});
            const code = log.lines.info.find((line) => line.startsWith('Pairing code'));
            assert.match(
                code,
                /^Pairing code \d{3} \d{3} - approve hm2mqtt\.js on 127\.0\.0\.1:\d+ on the system's Status page$/,
            );
            assert.ok(log.lines.info.some((line) => line.includes('"devices":"operate"')));
        } finally {
            await fake.stop();
        }
    });

    test('pairAndStore: the rpc topics ask for every method', async () => {
        let asked;
        const pair = async (o) => {
            asked = o;
            o.onCode('000001');
            return {token: 't', fingerprint256: 'AA'};
        };
        const log = fakeLog();
        const dir = tmp();
        await pairAndStore({
            url: 'https://box',
            stateDir: dir,
            log,
            appVersion: '1',
            instance: 'i',
            administer: true,
            timeout: 5,
            pair,
        });
        assert.deepEqual(asked.access, {devices: 'administer', names: 'read'});
        assert.equal(asked.timeout, 5);
        assert.equal(asked.app, 'hm2mqtt.js');
        assert.ok(log.lines.info.some((line) => line.includes('Pairing code 000 001') && line.includes('on box on')));
        assert.ok(log.lines.info.some((line) => line.includes('access {}')));
        assert.equal(readCredential(dir).fingerprint256, 'AA');
    });
});

describe('a remote system: credential, url, trust, re-detection', () => {
    test('remoteSetup: --meta-token, else the paired credential; --meta-url, else where it was paired', () => {
        const dir = tmp();
        assert.deepEqual(remoteSetup({stateDir: dir, fallbackUrl: 'http://a'}), {
            credential: undefined,
            url: 'http://a',
        });
        writeCredential(dir, {url: 'https://paired', token: 'olt_p', fingerprint256: 'AB'});
        assert.deepEqual(remoteSetup({stateDir: dir, fallbackUrl: 'http://a'}), {
            credential: {url: 'https://paired', token: 'olt_p', fingerprint256: 'AB'},
            url: 'https://paired',
        });
        assert.deepEqual(
            remoteSetup({metaToken: 'olt_t', metaUrl: 'http://m', stateDir: dir, fallbackUrl: 'http://a'}),
            {
                credential: {token: 'olt_t'},
                url: 'http://m',
            },
        );
    });

    test('remoteAuth reads the paired token at every attempt', () => {
        const dir = tmp();
        const auth = remoteAuth({stateDir: dir});
        assert.deepEqual(auth(), {token: ''});
        writeCredential(dir, {url: 'http://x', token: 'olt_new'});
        assert.deepEqual(auth(), {token: 'olt_new'});
        assert.deepEqual(remoteAuth({metaToken: 'olt_t', stateDir: dir})(), {token: 'olt_t'});
    });

    test('systemAuth: --meta-token, else the local token', () => {
        assert.deepEqual(systemAuth({})(), {local: true});
        assert.deepEqual(systemAuth({metaToken: 'olt_t'})(), {token: 'olt_t'});
    });

    test('remoteTrust: the pinned fingerprint over https, else --ccu-insecure, else Node', () => {
        assert.deepEqual(remoteTrust({fingerprint256: 'AB', url: 'https://x'}), {fingerprint256: 'AB'});
        assert.equal(remoteTrust({fingerprint256: 'AB', url: 'http://x'}), undefined);
        assert.deepEqual(remoteTrust({fingerprint256: '', url: 'https://x', insecure: true}), {insecure: true});
        assert.equal(remoteTrust({url: 'https://x'}), undefined);
    });

    test('watchForLite: probes until something answers, tells only openccu-lite', async () => {
        const log = fakeLog();
        const answers = [
            new Error('probe broke'),
            {kind: 'unreachable', reachable: false},
            {kind: 'openccu-lite', reachable: true},
        ];
        let probes = 0;
        let lite = 0;
        const probe = async () => {
            probes += 1;
            const a = answers.shift();
            if (a instanceof Error) {
                throw a;
            }
            return a;
        };
        watchForLite({url: 'http://x', intervalMs: 5, log, probe, onLite: () => (lite += 1)});
        await waitFor(() => lite === 1, 2000, 'openccu-lite');
        await sleep(30);
        assert.equal(probes, 3, 'no probe after the answer');
        assert.ok(log.lines.debug.includes('re-detection failed: probe broke'));

        let ccuLite = 0;
        const ccu = watchForLite({
            url: 'http://ccu',
            intervalMs: 5,
            log,
            probe: async () => ({kind: 'ccu', reachable: true}),
            onLite: () => (ccuLite += 1),
        });
        await waitFor(() => log.lines.debug.some((l) => l.includes('no openccu-lite on http://ccu')), 2000, 'ccu');
        assert.equal(ccuLite, 0);
        ccu.stop();
        const stopped = watchForLite({
            url: 'http://y',
            intervalMs: 5,
            log,
            probe: () => assert.fail('probed'),
            onLite() {},
        });
        stopped.stop();
        await sleep(20);
    });
});

describe('the scopes of a paired token', () => {
    test('a token paired at operate lists rpc:operate only and runs with devices and values', async () => {
        const fake = new FakeBox({token: 'olt_op', scopes: ['meta:read', 'rpc:operate'], meta: house()});
        const url = await fake.start();
        const hub = new LiteHub({url, auth: () => ({token: 'olt_op'}), log: fakeLog()});
        try {
            const box = await hub.start();
            assert.deepEqual(box.scopes, ['meta:read', 'rpc:operate']);
            assert.equal(box.mode, 'full');
        } finally {
            hub.stop();
            await fake.stop();
        }
    });

    test('createLiteClient: a client on the node transport with the credential resolved', async () => {
        const fake = new FakeBox({token: 'olt_c', meta: house()});
        const url = await fake.start();
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'local-token'), 'olt_c\n');
        const box = createLiteClient({
            url,
            auth: {local: true},
            localTokenFile: path.join(dir, 'local-token'),
            devices: false,
        });
        try {
            await box.ready();
            assert.equal(box.credential, 'local');
            assert.equal(box.mode, 'full');
        } finally {
            box.close();
            await fake.stop();
        }
    });
});

describe('chooseBackend', () => {
    const probe = (answer) => async (url, opts) => ({url, ...answer, opts});

    test('ccu is never asked', async () => {
        assert.deepEqual(
            await chooseBackend({backend: 'ccu', url: 'http://x', loopback: false, probe: () => assert.fail('asked')}),
            {kind: 'ccu'},
        );
    });

    test('on openccu-lite itself nothing is asked', async () => {
        const r = await chooseBackend({
            url: 'http://127.0.0.1',
            loopback: true,
            isLite: () => true,
            probe: () => assert.fail('asked'),
        });
        assert.deepEqual(r, {kind: 'on-system'});
    });

    test('what answers decides', async () => {
        const lite = probe({kind: 'openccu-lite', reachable: true, url: 'https://box'});
        assert.deepEqual(await chooseBackend({url: 'http://box', loopback: false, isLite: () => true, probe: lite}), {
            kind: 'remote',
            url: 'https://box',
        });
        assert.deepEqual(
            await chooseBackend({url: 'http://127.0.0.1', loopback: true, isLite: () => false, probe: lite}),
            {
                kind: 'on-system',
            },
        );
        assert.deepEqual(
            await chooseBackend({url: 'http://ccu', loopback: false, probe: probe({kind: 'ccu', reachable: true})}),
            {
                kind: 'ccu',
            },
        );
        assert.deepEqual(
            await chooseBackend({
                url: 'http://ccu',
                loopback: false,
                probe: probe({kind: 'unreachable', reachable: false, reason: 'refused'}),
            }),
            {kind: 'ccu', redetect: true, reason: 'refused'},
        );
    });

    test('openccu-lite asked for: connect whatever answered', async () => {
        const r = await chooseBackend({
            backend: 'openccu-lite',
            url: 'http://127.0.0.1',
            loopback: true,
            isLite: () => true,
            probe: probe({kind: 'openccu-lite', reachable: true, url: 'https://127.0.0.1'}),
        });
        assert.deepEqual(r, {kind: 'remote', url: 'https://127.0.0.1', reason: undefined});
        const down = await chooseBackend({
            backend: 'openccu-lite',
            url: 'http://box',
            loopback: false,
            probe: probe({kind: 'unreachable', reachable: false, reason: 'timeout'}),
        });
        assert.deepEqual(down, {kind: 'remote', url: 'http://box', reason: 'timeout'});
    });

    test('the default probe: nothing listening is not a CCU', async () => {
        const port = await closedPort();
        const r = await chooseBackend({
            url: `http://127.0.0.1:${port}`,
            loopback: true,
            isLite: () => false,
            timeout: 2000,
        });
        assert.equal(r.kind, 'ccu');
        assert.equal(r.redetect, true);
    });
});

describe('LiteHub against FakeBox', () => {
    const devices = {
        'HmIP-RF': [
            {
                ADDRESS: '000A1B2C3D4E5F',
                TYPE: 'HmIP-BSM',
                CHILDREN: ['000A1B2C3D4E5F:0', '000A1B2C3D4E5F:4'],
                PARAMSETS: ['MASTER'],
            },
            {ADDRESS: '000A1B2C3D4E5F:0', PARENT: '000A1B2C3D4E5F', TYPE: 'MAINTENANCE', PARAMSETS: ['VALUES']},
            {
                ADDRESS: '000A1B2C3D4E5F:4',
                PARENT: '000A1B2C3D4E5F',
                TYPE: 'SWITCH_VIRTUAL_RECEIVER',
                PARAMSETS: ['VALUES'],
            },
        ],
        'BidCos-RF': [{ADDRESS: 'JEQ0230153', TYPE: 'HM-CC-RT-DN', PARAMSETS: ['MASTER']}],
    };
    const values = {
        'HmIP-RF.000A1B2C3D4E5F:0.UNREACH': {value: false, ts: '2026-11-01T10:00:00Z', lc: '2026-10-01T10:00:00Z'},
        'HmIP-RF.000A1B2C3D4E5F:4.STATE': {value: true, ts: '2026-11-01T10:00:00Z', confirmed: false},
        'HmIP-RF.000A1B2C3D4E5F:4.ON_TIME': {value: 0},
    };

    test('devices, values at connect and swept, events, writes, interfaces, resync', async () => {
        const fake = new FakeBox({
            token: 'olt_paired',
            interfaces: ['HmIP-RF', {name: 'BidCos-RF', running: false}],
            devices,
            values,
            storeKeys: ['UNREACH', 'STATE'],
            meta: house(),
        });
        const url = await fake.start();
        const log = fakeLog();
        const hub = new LiteHub({url, auth: () => ({token: 'olt_paired'}), log, clientOptions: {sweepPaceMs: 1}});
        const hmip = hub.connection('HmIP-RF');
        assert.equal(hub.connection('HmIP-RF'), hmip);
        const bidcos = hub.connection('BidCos-RF');
        const seen = {
            events: [],
            newDevices: [],
            deleteDevices: [],
            connected: [],
            stored: [],
            values: [],
            interfaces: [],
        };
        hmip.on('event', (e) => seen.events.push(e));
        hmip.on('newDevices', (d) => seen.newDevices.push(d.map((x) => x.ADDRESS)));
        hmip.on('deleteDevices', (a) => seen.deleteDevices.push(a));
        hmip.on('connected', (c) => seen.connected.push(c));
        hub.on('stored', (ev) => seen.stored.push(`${ev.ref}=${ev.value}`));
        hub.on('values', (entries) =>
            seen.values.push([...entries].map(([ref, v]) => `${ref}=${v.value}/${v.confirmed}`)),
        );
        hub.on('interface', (ev) => seen.interfaces.push(`${ev.interface} ${ev.state}`));
        assert.deepEqual(hub.interfaceNames(), []);
        try {
            const box = await hub.start();
            assert.equal(hub.box, box);
            // asked again (the hourly names re-sync): the same connection, no second one
            assert.equal(await hub.start(), box);
            assert.deepEqual(hub.interfaceNames().sort(), ['BidCos-RF', 'HmIP-RF']);
            assert.equal(hub.isRunning('HmIP-RF'), true);
            assert.equal(hub.isRunning('BidCos-RF'), false);
            // the device lists came with the connect, before the connection was used
            assert.deepEqual(seen.newDevices, [['000A1B2C3D4E5F', '000A1B2C3D4E5F:0', '000A1B2C3D4E5F:4']]);
            assert.ok(log.lines.info.some((l) => l.includes('connected to') && l.includes('devices and names')));
            // the store's values at connect, uncertain where the system restored them
            assert.deepEqual(seen.values[0].sort(), [
                'HmIP-RF.000A1B2C3D4E5F:0.UNREACH=false/true',
                'HmIP-RF.000A1B2C3D4E5F:4.STATE=true/false',
            ]);
            // and what the store does not keep, read once
            await waitFor(() => seen.stored.length > 0, 5000, 'the sweep');
            assert.deepEqual(seen.stored, ['HmIP-RF.000A1B2C3D4E5F:4.ON_TIME=0']);
            await waitFor(
                () => log.lines.info.some((l) => l.includes('values the system does not keep')),
                5000,
                'sweep line',
            );

            // starting a connection hands it the devices the system announced, then the state
            await hmip.start();
            await bidcos.start();
            assert.equal(seen.newDevices.length, 2);
            assert.deepEqual(seen.connected, [true]);
            assert.equal(bidcos.connected, false);

            // an event alone, and a multicall's events together with their hints
            fake.event('HmIP-RF', '000A1B2C3D4E5F:4', 'STATE', false);
            await waitFor(() => seen.events.length === 1, 5000, 'event');
            assert.deepEqual(seen.events[0], {
                channel: '000A1B2C3D4E5F:4',
                datapoint: 'STATE',
                value: false,
                working: undefined,
                direction: undefined,
            });
            const mark = fake.nextSeq();
            fake.event('HmIP-RF', '000A1B2C3D4E5F:4', 'STATE', true, mark);
            fake.event('HmIP-RF', '000A1B2C3D4E5F:4', 'PROCESS', 1, mark);
            await waitFor(() => seen.events.length === 3, 5000, 'batch');
            assert.equal(seen.events[1].working, true);
            assert.equal(hmip.counters.rx, 2);
            // events of an interface nobody uses are dropped
            fake.event('VirtualDevices', 'INT0000001:1', 'LEVEL', 1);

            // writes: a FLOAT typed, counted; any method; a fault comes back as an error
            await hmip.methodCall('setValue', ['000A1B2C3D4E5F:4', 'LEVEL', {explicitDouble: 1}]);
            await hmip.methodCall('putParamset', ['000A1B2C3D4E5F:4', 'VALUES', {LEVEL: {explicitDouble: 0.5}}]);
            const list = await hmip.methodCall('listDevices');
            assert.equal(list.length, 3);
            assert.equal(hmip.counters.tx, 2);
            const writes = fake.calls.filter((c) => c.method === 'setValue' || c.method === 'putParamset');
            assert.deepEqual(writes[0].params, ['000A1B2C3D4E5F:4', 'LEVEL', {double: 1}]);
            assert.deepEqual(writes[1].params, ['000A1B2C3D4E5F:4', 'VALUES', {LEVEL: 0.5}]);
            await assert.rejects(hmip.methodCall('reportValueUsage', []), /unknown method/);

            // devices paired and deleted; an update is logged only
            fake.push('newDevices', {interface: 'HmIP-RF', devices: [{ADDRESS: '0011223344AABB', TYPE: 'HmIP-PS'}]});
            await waitFor(() => seen.newDevices.length === 3, 5000, 'newDevices');
            fake.push('deleteDevices', {interface: 'HmIP-RF', addresses: ['0011223344AABB']});
            await waitFor(() => seen.deleteDevices.length === 1, 5000, 'deleteDevices');
            assert.deepEqual(seen.deleteDevices[0], ['0011223344AABB']);
            fake.updateDevice('HmIP-RF', '000A1B2C3D4E5F', 2);
            await waitFor(() => log.lines.debug.some((l) => l.includes('occulite: HmIP-RF updated')), 5000, 'update');
            fake.push('newDevices', {interface: 'BidCos-RF', devices: []});
            fake.push('newDevices', {interface: 'CUxD', devices: []});

            // an interface comes up: the connection follows, the hub tells
            fake.setInterface('BidCos-RF', true);
            await waitFor(() => bidcos.connected, 5000, 'BidCos-RF up');
            fake.addInterface('VirtualDevices');
            await waitFor(() => seen.interfaces.includes('VirtualDevices added'), 5000, 'added');
            assert.ok(seen.interfaces.includes('BidCos-RF up'));

            // another boot of the system: the values are read again and announced
            fake.bootId = 'boot2';
            fake.dropStreams();
            await waitFor(() => seen.values.length === 2, 10000, 'resync');
            assert.ok(log.lines.info.some((l) => l.includes('values read again after boot')));
        } finally {
            hub.stop();
            await fake.stop();
        }
        assert.equal(hmip.connected, false);
        assert.equal(hub.box, undefined);
    });

    test('a refused credential: connect afresh with the credential of the next attempt', async () => {
        const fake = new FakeBox({token: 'olt_one', devices: {}, meta: house()});
        const url = await fake.start();
        const log = fakeLog();
        let token = 'olt_one';
        const hub = new LiteHub({
            url,
            auth: () => ({token}),
            log,
            schedule: [10],
            clientOptions: {reconnect: {min: 10, max: 20}},
        });
        const hmip = hub.connection('HmIP-RF');
        await hmip.start();
        const states = [];
        hub.on('status', (s) => states.push(s));
        try {
            const first = await hub.start();
            assert.equal(hmip.connected, true);
            // the token is revoked: the stream is refused, the hub starts over and is refused too
            fake.opts.token = 'olt_two';
            fake.dropStreams();
            await waitFor(() => states.includes('offline'), 5000, 'offline');
            await waitFor(() => log.lines.error.some((l) => l.includes('refused the credential:')), 5000, 'refused');
            assert.equal(first.status, 'closed');
            assert.equal(hmip.connected, false);
            // a new pairing: the next attempt reads it
            token = 'olt_two';
            await waitFor(() => hub.box && hub.box !== first, 5000, 'reconnect');
            await waitFor(() => hmip.connected, 5000, 'connected again');
        } finally {
            hub.stop();
            await fake.stop();
        }
    });

    test('names only with a local-token-like credential', async () => {
        const fake = new FakeBox({token: 'olt_local', scopes: ['meta:read'], meta: house()});
        const url = await fake.start();
        const log = fakeLog();
        const hub = new LiteHub({url, auth: () => ({token: 'olt_local'}), namesOnly: true, log});
        let values = 0;
        hub.on('values', () => (values += 1));
        try {
            const box = await hub.start();
            assert.equal(box.mode, 'names-only');
            assert.equal(box.meta.name('HmIP-RF.000A1B2C3D4E5F:4'), 'Deckenlampe');
            assert.equal(values, 0);
            assert.ok(log.lines.info.some((l) => l.includes('names only')));
            await waitFor(() => fake.metaStreamsOpen > 0, 5000, 'the metadata stream');
            const settled = new Promise((resolve) => hub.once('metaSettled', resolve));
            fake.metaEvent({
                kind: 'object.updated',
                revision: house().revision + 1,
                ref: 'HmIP-RF.X:1',
                value: {name: 'x'},
            });
            assert.equal((await settled).reread, false);
        } finally {
            hub.stop();
            await fake.stop();
        }
    });
});

describe('LiteHub branches', () => {
    test('nothing listens: one warn, then debug, until stopped', async () => {
        const port = await closedPort();
        const log = fakeLog();
        const hub = new LiteHub({
            url: `http://127.0.0.1:${port}`,
            auth: () => ({token: 't'}),
            log,
            schedule: [5, 5],
            clientOptions: {connectTimeout: 2000},
        });
        assert.deepEqual(RETRY_SCHEDULE_MS, [1000, 2000, 4000, 8000, 15000]);
        const started = hub.start();
        assert.equal(hub.start(), started, 'one connect loop');
        assert.equal(await hub.firstAttempt, false);
        await waitFor(() => log.lines.debug.some((l) => l.includes('still not connected')), 5000, 'repeat');
        assert.equal(log.lines.warn.filter((l) => l.includes('cannot connect to')).length, 1);
        hub.stop();
        assert.equal(await started, undefined);
    });

    test('an error without a message is named by itself', async () => {
        const log = fakeLog();
        let hub;
        const box = new StubBox({
            ready: async () => {
                hub.stopped = true;
                throw 'plain failure';
            },
        });
        hub = new LiteHub({url: 'http://x', auth: () => ({}), log, createClient: clients(box).create});
        hub.failed('plain failure');
        assert.equal(hub.lastError, 'plain failure');
        assert.ok(log.lines.warn.some((l) => l.includes('- plain failure -')));
    });

    test('a refused credential at connect is an error line', async () => {
        const fake = new FakeBox({token: 'right'});
        const url = await fake.start();
        const log = fakeLog();
        const hub = new LiteHub({url, auth: () => ({token: 'wrong'}), log, schedule: [5]});
        hub.start();
        try {
            assert.equal(await hub.firstAttempt, false);
            assert.equal(hub.lastError.code, 'unauthenticated');
            assert.ok(log.lines.error.some((l) => l.includes('refused the credential:')));
        } finally {
            hub.stop();
            await fake.stop();
        }
    });

    test('stopped while connecting: no box, the loop ends', async () => {
        const log = fakeLog();
        let hub;
        const pending = new StubBox({ready: () => new Promise((resolve) => setTimeout(resolve, 20))});
        const {create} = clients(pending);
        hub = new LiteHub({url: 'http://x', auth: () => ({}), log, createClient: create});
        const running = hub.start();
        hub.stop();
        assert.equal(await running, undefined);
        assert.equal(hub.box, undefined);
        assert.equal(pending.closed, true);

        // stopped while a failed attempt is being judged
        const failing = new StubBox({
            ready: async () => {
                hub.stop();
                throw new Error('boom');
            },
        });
        hub = new LiteHub({url: 'http://x', auth: () => ({}), log, createClient: clients(failing).create});
        assert.equal(await hub.start(), undefined);
        assert.equal(await hub.firstAttempt, false);
    });

    test('a stub system: options, status, events of an old client ignored', async () => {
        const log = fakeLog();
        const old = new StubBox({
            ready: async () => Promise.reject(Object.assign(new Error('x'), {code: 'forbidden'})),
        });
        const box = new StubBox({
            info: {},
            interfaces: [{name: 'HmIP-RF', running: true}],
            devices: [
                ['HmIP-RF.A', {ADDRESS: 'A'}],
                ['BidCos-RF.B', {ADDRESS: 'B'}],
            ],
        });
        const {create, asked} = clients(old, box);
        const hub = new LiteHub({
            url: 'http://x',
            auth: () => ({token: 't'}),
            trust: {insecure: true},
            log,
            createClient: create,
            schedule: [1],
        });
        const conn = hub.connection('HmIP-RF');
        const seen = [];
        conn.on('newDevices', (d) => seen.push(d.map((x) => x.ADDRESS)));
        await hub.start();
        assert.equal(asked[0].values, 'all');
        assert.deepEqual(asked[0].trust, {insecure: true});
        assert.ok(log.lines.info.some((l) => l.includes('(openccu-lite, token credential')));
        await conn.start();
        assert.deepEqual(seen, [['A']]);
        // the closed client's events are not ours any more
        old.emit('batch', [{interface: 'HmIP-RF', address: 'A:1', key: 'STATE', value: true}]);
        assert.equal(conn.counters.rx, 0);
        // a status of the current client moves the connections
        box.status = 'degraded';
        box.emit('status', {state: 'degraded'});
        assert.equal(conn.connected, false);
        box.status = 'ready';
        box.emit('status', {state: 'ready'});
        assert.equal(conn.connected, true);
        // PONG is no event; a value of the sweep is a stored one
        const stored = [];
        hub.on('stored', (ev) => stored.push(ev.ref));
        box.emit('value', {interface: 'HmIP-RF', address: 'CENTRAL', key: 'PONG', value: 'x'});
        box.emit('value', {
            interface: 'HmIP-RF',
            address: 'A:1',
            key: 'STATE',
            value: 1,
            source: 'sweep',
            ref: 'HmIP-RF.A:1.STATE',
        });
        box.emit('value', {interface: 'HmIP-RF', address: 'A:1', key: 'STATE', value: 1, batch: 3});
        assert.equal(conn.counters.rx, 0);
        assert.deepEqual(stored, ['HmIP-RF.A:1.STATE']);
        // an interface event for one nobody uses
        box.emit('interface', {interface: 'CUxD', state: 'up'});
        // a client log line in ours
        asked[1].log.info('client info');
        asked[1].log.warn('client warn');
        asked[1].log.error('client error');
        asked[1].log.debug('client debug');
        assert.ok(log.lines.debug.includes('client info') && log.lines.debug.includes('client warn'));
        assert.ok(log.lines.warn.includes('client error'));
        // offline of a client that is not the connected one changes nothing
        old.emit('status', {state: 'offline'});
        hub.current = old;
        old.emit('status', {state: 'offline'});
        assert.equal(hub.box, box);
        hub.current = box;
        hub.stop();
        // offline after stop does not reconnect
        hub.box = box;
        hub.current = box;
        box.emit('status', {state: 'offline'});
        assert.equal(hub.running, null);
    });
});

describe('LiteConnection', () => {
    test('without a connection a call fails; the result is logged whatever it is', async () => {
        const log = fakeLog();
        const hub = {box: undefined, isRunning: () => false};
        const conn = new LiteConnection({name: 'HmIP-RF', hub, log});
        await assert.rejects(conn.methodCall('setValue', ['A:1', 'STATE', true]), /not connected to openccu-lite/);
        assert.equal(conn.counters.tx, 0);
        const box = new StubBox({result: undefined, capabilities: undefined});
        hub.box = box;
        assert.equal(await conn.methodCall('ping'), undefined);
        assert.deepEqual(box.calls, [['HmIP-RF', 'ping', []]]);
        assert.ok(log.lines.debug.includes('rpc < HmIP-RF ping null'));
        await conn.methodCall('setValue', ['A:1', 'LEVEL', {explicitDouble: 1}]);
        // no json_double capability: a plain number
        assert.deepEqual(box.calls[1], ['HmIP-RF', 'setValue', ['A:1', 'LEVEL', 1]]);
        // start without devices, stop
        hub.box = undefined;
        await conn.start();
        assert.equal(conn.connected, false);
        hub.isRunning = () => true;
        conn.update();
        assert.equal(conn.connected, true);
        await conn.stop();
        assert.equal(conn.connected, false);
        conn.update();
        assert.equal(conn.connected, false);
    });

    test('a multicall: hints from ACTIVITY_STATE, counted once', () => {
        const conn = new LiteConnection({name: 'HmIP-RF', hub: {isRunning: () => true}, log: fakeLog()});
        const events = [];
        conn.on('event', (e) => events.push(e));
        conn.handleEvents([
            {address: 'A:3', key: 'LEVEL', value: 0.5},
            {address: 'A:3', key: 'ACTIVITY_STATE', value: 1},
        ]);
        assert.equal(conn.counters.rx, 1);
        assert.deepEqual(
            events.map((e) => e.direction),
            [1, 1],
        );
        conn.handleEvents([{address: 'HmIP-RF:CENTRAL', key: 'PONG', value: 'x'}]);
        assert.equal(conn.counters.rx, 1);
    });
});

describe('LiteNames', () => {
    /** a hub stand-in: events, a box or none, a scripted first attempt */
    function stubHub({box, first = true, error} = {}) {
        const hub = new EventEmitter();
        hub.box = box;
        hub.lastError = error;
        hub.started = 0;
        hub.start = () => {
            hub.started += 1;
            return first ? Promise.resolve(box) : Promise.reject(new Error('never'));
        };
        hub.firstAttempt = Promise.resolve(first);
        return hub;
    }

    test('names, rooms and functions from the conformance corpus; the direct room only', () => {
        const dir = tmp();
        const doc = house();
        doc.objects['HmIP-RF.ABC:1'] = {
            name: 'x',
            enums: ['room/eg/wohnzimmer', 'room/og', 'floor/eg', 'room/nowhere'],
        };
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(doc));
        const log = fakeLog();
        const names = new LiteNames({
            hub: stubHub(),
            stateDir: dir,
            nameFile: {'JEQ0230153:1': 'Mein Thermostat'},
            log,
        });
        names.load();
        assert.ok(log.lines.info.some((l) => l.startsWith('loaded 5 names from')));
        assert.equal(names.label, 'occulite');
        assert.equal(names.channelName('000A1B2C3D4E5F:4'), 'Deckenlampe');
        assert.equal(names.channelName('JEQ0230153:1'), 'Mein Thermostat');
        assert.deepEqual(names.rooms('000A1B2C3D4E5F:4'), ['Wohnzimmer']);
        assert.deepEqual(names.functions('000A1B2C3D4E5F:4'), ['Licht']);
        assert.deepEqual(names.rooms('JEQ0230153:1'), ['Bad']);
        assert.equal(names.rooms('JEQ0230153'), undefined);
        assert.equal(names.functions('JEQ0230153'), undefined);
        // the parent is not added, an unknown path is skipped, floor is not a room (H-48)
        assert.deepEqual(names.rooms('ABC:1'), ['Wohnzimmer', 'Obergeschoss']);
        assert.equal(names.channelAddress('Deckenlampe'), '000A1B2C3D4E5F:4');
        assert.equal(names.channelAddress('Mein Thermostat'), 'JEQ0230153:1');
        assert.equal(names.hasVariable('x'), false);
        assert.equal(names.hasProgram('x'), false);
        names.setHost('1.2.3.4');
    });

    test('every document of the corpus is survivable, valid or not', () => {
        for (const file of fs.readdirSync(fixtures)) {
            const dir = tmp();
            fs.copyFileSync(path.join(fixtures, file), path.join(dir, 'meta.json'));
            const names = new LiteNames({hub: stubHub(), stateDir: dir, log: fakeLog()});
            names.load();
            assert.ok(!Object.keys(names.channelNames).includes(''), file);
        }
        // a copy without objects at all
        const empty = new StubBox();
        empty.meta.doc = {format: 1, revision: 0, enums: {}};
        const nothing = new LiteNames({hub: stubHub({box: empty}), log: fakeLog()});
        assert.equal(nothing.rebuild(), false);
        // objects that are no objects are skipped
        const box = new StubBox();
        box.meta.load({
            format: 1,
            revision: 1,
            objects: {'HmIP-RF.A:1': null, 'HmIP-RF.B:1': 'x', 'HmIP-RF.C:1': {name: ''}},
            enums: {},
        });
        const names = new LiteNames({hub: stubHub({box}), log: fakeLog()});
        names.rebuild();
        assert.deepEqual(names.channelNames, {});
    });

    test('load and save: no state directory, a broken file, a file that cannot be written', () => {
        const log = fakeLog();
        const none = new LiteNames({hub: stubHub(), log});
        none.load();
        none.save();
        assert.equal(none.file(), null);
        const dir = tmp();
        const names = new LiteNames({hub: stubHub(), stateDir: dir, log});
        names.load();
        assert.equal(log.lines.warn.length, 0, 'a missing file is no warning');
        fs.writeFileSync(path.join(dir, 'meta.json'), 'not json');
        names.load();
        assert.ok(log.lines.warn.some((l) => l.startsWith('cannot read')));
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({objects: {'HmIP-RF.A:1': {name: 'a'}}}));
        names.load();
        assert.equal(names.channelName('A:1'), 'a');
        const blocked = path.join(dir, 'file');
        fs.writeFileSync(blocked, '');
        const unwritable = new LiteNames({hub: stubHub(), stateDir: path.join(blocked, 'sub'), log});
        unwritable.save();
        assert.ok(log.lines.warn.some((l) => l.startsWith('cannot save')));
    });

    test('the live copy: syncNames, changes, status, persistence', async () => {
        const dir = tmp();
        const box = new StubBox();
        box.meta.load(house());
        const hub = stubHub({box});
        const log = fakeLog();
        const names = new LiteNames({hub, stateDir: dir, log});
        let announced = 0;
        let polled = 0;
        const errors = [];
        names.on('names', () => (announced += 1));
        names.on('polled', () => (polled += 1));
        // before the listener: no throw
        hub.emit('status', 'ready');
        hub.emit('status', 'offline');
        names.on('error', (e) => errors.push(e.message));

        await names.syncNames();
        assert.equal(hub.started, 1);
        assert.equal(announced, 1);
        assert.equal(names.channelName('000A1B2C3D4E5F:4'), 'Deckenlampe');
        assert.ok(log.lines.info.some((l) => /occulite: 4 names, \d+ rooms, \d+ functions \(revision \d+\)/.test(l)));
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).objects['HmIP-RF.000A1B2C3D4E5F:4'].name,
            'Deckenlampe',
        );
        // nothing changed: no names event
        await names.syncNames();
        assert.equal(announced, 1);

        // connected: announced and polled; startPolling repeats polled for a listener attached late
        hub.emit('ready', box);
        assert.equal(announced, 2);
        assert.equal(polled, 2);
        await names.startPolling();
        assert.equal(polled, 3);
        await names.poll();

        // a change arrives: derived again once the copy is in step; settled without a change: no announcement
        box.meta.doc.objects['HmIP-RF.000A1B2C3D4E5F:4'].name = 'Stehlampe';
        hub.emit('metaSettled', {revision: 2, reread: true});
        assert.equal(announced, 3);
        assert.equal(names.channelName('000A1B2C3D4E5F:4'), 'Stehlampe');
        hub.emit('metaSettled', {revision: 2, reread: false});
        assert.equal(announced, 3);

        // the connection goes and comes back
        hub.emit('status', 'connecting');
        hub.emit('status', 'degraded');
        assert.deepEqual(errors, ['connection degraded']);
        hub.emit('status', 'degraded');
        hub.emit('status', 'ready');
        assert.equal(polled, 4);
        hub.emit('status', 'ready');
        assert.equal(polled, 4);

        // stopped: no more refreshes, and detached from the hub
        names.stopPolling();
        box.meta.doc.objects['HmIP-RF.000A1B2C3D4E5F:4'].name = 'Leselampe';
        hub.emit('metaSettled', {revision: 3, reread: false});
        assert.equal(announced, 3);
        assert.equal(names.channelName('000A1B2C3D4E5F:4'), 'Stehlampe');
        names.removeAllListeners();
        assert.equal(hub.listenerCount('ready') + hub.listenerCount('status') + hub.listenerCount('metaSettled'), 0);
        await names.startPolling();
    });

    test('syncNames fails while the first attempt failed; nothing written there exists', async () => {
        const names = new LiteNames({hub: stubHub({first: false, error: new Error('refused')}), log: fakeLog()});
        await assert.rejects(names.syncNames(), /refused/);
        const bare = new LiteNames({hub: stubHub({first: true}), log: fakeLog()});
        await assert.rejects(bare.syncNames(), /not connected/);
        await assert.rejects(names.setVariable('x', 1), /system variables are not available on openccu-lite/);
        await assert.rejects(names.programActive('x', true), /programs are not available/);
        await assert.rejects(names.programExecute('x'), /programs are not available/);
    });
});
