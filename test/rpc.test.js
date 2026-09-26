import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';

import {RpcServers, RpcConnection, batchHints, initRetryDelay, notListening, METHODS} from '../lib/rpc.js';
import {createLogger} from 'mqtt-interfaces-core';

function fakes() {
    const calls = [];
    const created = [];
    let fail = null;
    let failWith = () => new Error('boom');
    const clients = [];
    const lib = {
        createClient: (options) => {
            const client = {
                options,
                closed: false,
                close() {
                    this.closed = true;
                },
                methodCall: (method, params, cb) => {
                    calls.push({method, params});
                    if (fail && fail(method)) {
                        return setImmediate(() => cb(failWith()));
                    }
                    setImmediate(() => cb(null, method === 'init' ? '' : ['ok']));
                },
            };
            clients.push(client);
            return client;
        },
        createSecureClient: (options) => lib.createClient({...options, secure: true}),
        createServer: (options, onListening) => {
            const server = new EventEmitter();
            server.options = options;
            server.close = () => Promise.resolve();
            created.push(server);
            setImmediate(onListening);
            return server;
        },
    };
    return {calls, created, clients, lib, setFail: (f, err) => ((fail = f), err && (failWith = err))};
}

function fakeTimers() {
    let now = 1000000;
    const timers = [];
    return {
        now: () => now,
        setTimeout: (fn, ms) => {
            const t = {fn, at: now + ms};
            timers.push(t);
            return t;
        },
        clearTimeout: (t) => {
            const i = timers.indexOf(t);
            if (i !== -1) {
                timers.splice(i, 1);
            }
        },
        advance: async (ms) => {
            now += ms;
            const due = timers.filter((t) => t.at <= now);
            for (const t of due) {
                timers.splice(timers.indexOf(t), 1);
                await t.fn();
            }
        },
        pending: () => timers.length,
    };
}

const lines = [];
const log = createLogger({format: 'journal', level: 'debug', write: (l) => lines.push(l)});

function setup({ping = true, pingTimeout = 60, protocol = 'xmlrpc'} = {}) {
    const f = fakes();
    const timers = fakeTimers();
    const servers = new RpcServers({
        listenAddress: '10.0.0.2',
        xmlrpcPort: 2126,
        binrpcPort: 2127,
        log,
        libs: {xmlrpc: f.lib, binrpc: f.lib},
    });
    const devices = [{ADDRESS: 'ABC:1', VERSION: 1}];
    const conn = new RpcConnection({
        name: 'BidCos-RF',
        host: 'ccu',
        protocol,
        port: 2001,
        init: true,
        ping,
        pingTimeout,
        servers,
        initId: 'hm2mqtt_hm_BidCos-RF',
        listDevices: () => devices,
        log,
        libs: {xmlrpc: f.lib, binrpc: f.lib},
        timers,
    });
    return {...f, timers, servers, conn};
}

describe('batchHints', () => {
    test('working and direction', () => {
        assert.deepEqual(batchHints([['i', 'c', 'LEVEL', 0.5]]), {});
        assert.deepEqual(
            batchHints([
                ['i', 'c', 'WORKING', true],
                ['i', 'c', 'DIRECTION', 1],
            ]),
            {working: true, direction: 1},
        );
        assert.deepEqual(batchHints([['i', 'c', 'PROCESS', 1]]), {working: true});
        assert.deepEqual(batchHints([['i', 'c', 'ACTIVITY_STATE', 3]]), {direction: 0});
        assert.deepEqual(batchHints([['i', 'c', 'ACTIVITY_STATE', 0]]), {direction: 3});
        assert.deepEqual(batchHints([['i', 'c', 'ACTIVITY_STATE', 1]]), {direction: 1});
    });
});

describe('RpcConnection', () => {
    test('start: server started, init called with url and id, connected', async () => {
        const {calls, created, conn, servers} = setup();
        const states = [];
        conn.on('connected', (c) => states.push(c));
        await conn.start();
        assert.equal(created.length, 1);
        assert.deepEqual(created[0].options, {host: '10.0.0.2', port: 2126});
        assert.deepEqual(calls[0], {method: 'init', params: ['http://10.0.0.2:2126', 'hm2mqtt_hm_BidCos-RF']});
        assert.deepEqual(states, [true]);
        assert.equal(servers.url('binrpc'), 'xmlrpc_bin://10.0.0.2:2127');
        assert.equal(conn.connected, true);
    });

    test('client options: tls, auth, path', () => {
        const f = fakes();
        const servers = new RpcServers({listenAddress: 'a', xmlrpcPort: 1, binrpcPort: 2, log, libs: {xmlrpc: f.lib}});
        const base = {host: 'ccu', servers, initId: 'x', log, libs: {xmlrpc: f.lib, binrpc: f.lib}};
        assert.deepEqual(
            new RpcConnection({...base, name: 'a', protocol: 'xmlrpc', port: 2001}).createClient().options,
            {
                host: 'ccu',
                port: 2001,
                path: '/',
                rejectUnauthorized: true,
            },
        );
        const c = new RpcConnection({
            ...base,
            name: 'a',
            protocol: 'xmlrpc',
            port: 49292,
            path: '/groups',
            tls: true,
            insecure: true,
            username: 'Admin',
            password: 'x',
        }).createClient();
        assert.deepEqual(c.options, {
            url: 'https://ccu:49292/groups',
            basic_auth: {user: 'Admin', pass: 'x'},
            rejectUnauthorized: false,
            secure: true,
        });
        assert.deepEqual(
            new RpcConnection({...base, name: 'CUxD', protocol: 'binrpc', port: 8701}).createClient().options,
            {host: 'ccu', port: 8701},
        );
    });

    test('incoming: listMethods, listDevices, newDevices, deleteDevices, event, multicall with hints', async () => {
        const {created, conn} = setup();
        await conn.start();
        const server = created[0];
        const events = [];
        const news = [];
        conn.on('event', (e) => events.push(e));
        conn.on('newDevices', (d) => news.push(d));
        const call = (method, params) =>
            new Promise((resolve) => server.emit(method, null, params, (_, res) => resolve(res)));
        assert.deepEqual(await call('system.listMethods', ['hm2mqtt_hm_BidCos-RF']), METHODS);
        assert.deepEqual(await call('listDevices', ['hm2mqtt_hm_BidCos-RF']), [{ADDRESS: 'ABC:1', VERSION: 1}]);
        assert.equal(await call('newDevices', ['hm2mqtt_hm_BidCos-RF', [{ADDRESS: 'X'}]]), '');
        assert.deepEqual(news, [[{ADDRESS: 'X'}]]);
        assert.equal(await call('event', ['hm2mqtt_hm_BidCos-RF', 'ABC:1', 'STATE', true]), '');
        assert.deepEqual(events[0], {
            channel: 'ABC:1',
            datapoint: 'STATE',
            value: true,
            working: undefined,
            direction: undefined,
        });
        const res = await call('system.multicall', [
            [
                {methodName: 'event', params: ['hm2mqtt_hm_BidCos-RF', 'ABC:1', 'WORKING', true]},
                {methodName: 'event', params: ['hm2mqtt_hm_BidCos-RF', 'ABC:1', 'LEVEL', 0.5]},
                {methodName: 'event', params: ['hm2mqtt_hm_BidCos-RF', 'CENTRAL', 'PONG', 'hm2mqtt']},
                {methodName: 'listDevices', params: ['hm2mqtt_hm_BidCos-RF']},
            ],
        ]);
        assert.deepEqual(res, ['', '', '', [{ADDRESS: 'ABC:1', VERSION: 1}]]);
        assert.deepEqual(events[1], {
            channel: 'ABC:1',
            datapoint: 'WORKING',
            value: true,
            working: true,
            direction: undefined,
        });
        assert.deepEqual(events[2], {
            channel: 'ABC:1',
            datapoint: 'LEVEL',
            value: 0.5,
            working: true,
            direction: undefined,
        });
        assert.equal(events.length, 3);
        assert.equal(conn.counters.rx, 2);
        // unknown init id is answered but ignored
        assert.deepEqual(await call('listDevices', ['nope']), []);
        assert.equal(await call('event', ['nope', 'A', 'B', 1]), '');
        assert.equal(events.length, 3);
    });

    test('a call for an own init id not subscribed yet is debug, a foreign one a warning', async () => {
        const f = fakes();
        const servers = new RpcServers({
            listenAddress: '127.0.0.1',
            xmlrpcPort: 2126,
            binrpcPort: 2127,
            log,
            libs: {xmlrpc: f.lib, binrpc: f.lib},
            ownPrefix: 'hm2mqtt_hm_',
        });
        const from = lines.length;
        servers.route('listDevices', ['hm2mqtt_hm_VirtualDevices'], () => {});
        servers.route('listDevices', ['someone_else'], () => {});
        const mine = lines.slice(from).filter((l) => l.includes('unknown init id'));
        assert.equal(mine.length, 2);
        assert.ok(mine[0].startsWith('<7>') && mine[0].includes('hm2mqtt_hm_VirtualDevices'), mine[0]);
        assert.ok(mine[1].startsWith('<4>') && mine[1].includes('someone_else'), mine[1]);
    });

    test('tx counter and faults', async () => {
        const {conn, calls} = setup();
        await conn.start();
        await conn.methodCall('setValue', ['ABC:1', 'STATE', true]);
        await conn.methodCall('getValue', ['ABC:1', 'STATE']);
        assert.equal(conn.counters.tx, 1);
        assert.equal(calls.length, 3);
        conn.client = {methodCall: (m, p, cb) => cb(null, {faultCode: -2, faultString: 'Invalid device'})};
        await assert.rejects(conn.methodCall('setValue', []), /Invalid device \(-2\)/);
    });

    test('ping after timeout/2, re-init after timeout, alive() resets', async () => {
        const {conn, calls, timers} = setup({pingTimeout: 60});
        await conn.start();
        calls.length = 0;
        await timers.advance(15000); // check at 15 s: elapsed 15 < 30 → nothing
        assert.equal(calls.length, 0);
        await timers.advance(20000); // 35 s → ping
        assert.deepEqual(calls[0], {method: 'ping', params: ['hm2mqtt']});
        conn.handleEvents([['hm2mqtt_hm_BidCos-RF', 'ABC:1', 'STATE', true]]);
        calls.length = 0;
        await timers.advance(15000); // 15 s since the event → nothing
        assert.equal(calls.length, 0);
        await timers.advance(50000); // 65 s → re-init
        assert.equal(calls[0].method, 'init');
        assert.equal(conn.connected, true);
        assert.ok(lines.some((l) => l.includes('no event for')));
    });

    test('init failure: attempts at 1, 2, 4, 8, 15, 15 s, disconnected until it works', async () => {
        const {conn, timers, setFail, calls} = setup();
        setFail((m) => m === 'init');
        await conn.start();
        assert.equal(conn.connected, false);
        assert.equal(timers.pending(), 1);
        const inits = () => calls.filter((c) => c.method === 'init').length;
        const at = [];
        let elapsed = 0;
        // step through in 1 s ticks and record when each attempt happens
        while (at.length < 6) {
            const before = inits();
            await timers.advance(1000);
            elapsed += 1000;
            if (inits() > before) {
                at.push(elapsed);
            }
        }
        assert.deepEqual(at, [1000, 3000, 7000, 15000, 30000, 45000]);
        assert.equal(conn.connected, false);
        setFail(null);
        await timers.advance(15000);
        assert.equal(conn.connected, true);
        assert.equal(timers.pending(), 1); // the ping check, no init timer
    });

    test('init failure: one warn line naming the next attempt, then debug, info on success', async () => {
        const {conn, timers, setFail} = setup();
        setFail((m) => m === 'init');
        const from = lines.length;
        await conn.start();
        await timers.advance(1000);
        await timers.advance(2000);
        setFail(null);
        await timers.advance(4000);
        const mine = lines.slice(from).filter((l) => l.includes('init'));
        const warns = mine.filter((l) => l.startsWith('<4>'));
        assert.equal(warns.length, 1);
        assert.match(warns[0], /init failed: boom - retrying in 1 s \(then up to every 15 s\)/);
        assert.equal(mine.filter((l) => l.startsWith('<7>') && l.includes('init failed: boom')).length, 2);
        assert.match(
            mine.find((l) => l.startsWith('<6>') && l.includes('succeeded')),
            /init succeeded after 4 attempts/,
        );
        assert.equal(lines.slice(from).filter((l) => l.startsWith('<3>')).length, 0);
    });

    test('init failure: a different error is warned again', async () => {
        const {conn, timers, setFail} = setup();
        setFail((m) => m === 'init');
        const from = lines.length;
        await conn.start();
        conn.client.methodCall = (method, params, cb) => setImmediate(() => cb(new Error('other')));
        await timers.advance(1000);
        const warns = lines.slice(from).filter((l) => l.startsWith('<4>') && l.includes('init failed'));
        assert.equal(warns.length, 2);
        assert.match(warns[1], /init failed: other - retrying in 2 s/);
    });

    test('an interface process not listening yet at the start is waited for with info lines, no warning', async () => {
        const {conn, timers, setFail} = setup();
        const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:32001'), {code: 'ECONNREFUSED'});
        setFail((m) => m === 'init', refused);
        const from = lines.length;
        await conn.start();
        for (const ms of [1000, 2000, 4000, 8000, 15000]) {
            await timers.advance(ms);
        }
        setFail(null);
        await timers.advance(15000);
        const mine = lines.slice(from);
        assert.equal(mine.filter((l) => /^<[0-4]>/.test(l)).length, 0, mine.join('\n'));
        assert.equal(
            mine.filter((l) => l.startsWith('<6>') && l.includes('nothing is listening on ccu:2001 yet')).length,
            1,
        );
        assert.match(
            mine.find((l) => l.includes('nothing is listening')),
            /retrying in 1 s \(then up to every 15 s\)/,
        );
        assert.ok(mine.some((l) => l.startsWith('<6>') && /init succeeded after 7 attempts/.test(l)));
        assert.equal(conn.connected, true);
    });

    test('a refused connection after the interface was subscribed once is a warning', async () => {
        const {conn, setFail} = setup({ping: false});
        await conn.start();
        assert.equal(conn.connected, true);
        const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:32001'), {code: 'ECONNREFUSED'});
        setFail((m) => m === 'init', refused);
        const from = lines.length;
        await conn.init();
        const warns = lines.slice(from).filter((l) => l.startsWith('<4>'));
        assert.equal(warns.length, 1);
        assert.match(warns[0], /init failed: connect ECONNREFUSED/);
    });

    test('binrpc: a failed init closes the client, the next attempt connects afresh', async () => {
        const {conn, timers, setFail, clients} = setup({protocol: 'binrpc', ping: false});
        setFail((m) => m === 'init');
        await conn.start();
        assert.equal(clients.length, 1);
        assert.equal(clients[0].closed, true);
        assert.equal(conn.client, null);
        setFail(null);
        await timers.advance(1000);
        assert.equal(clients.length, 2);
        assert.equal(clients[1].closed, false);
        assert.equal(conn.connected, true);
    });

    test('xmlrpc: a failed init keeps the client (every call is its own request)', async () => {
        const {conn, setFail, clients} = setup({ping: false});
        setFail((m) => m === 'init');
        await conn.start();
        assert.equal(clients.length, 1);
        assert.equal(clients[0].closed, false);
        assert.ok(conn.client);
    });

    test('notListening', () => {
        assert.equal(notListening(Object.assign(new Error('x'), {code: 'ECONNREFUSED'})), true);
        assert.equal(notListening(new Error('connect ECONNREFUSED 127.0.0.1:32010')), true);
        assert.equal(notListening(new Error('init timed out after 30 s')), false);
        assert.equal(notListening(undefined), false);
    });

    test('the backoff resets after a successful init', async () => {
        const {conn, timers, setFail, calls} = setup({ping: false});
        setFail((m) => m === 'init');
        await conn.start();
        await timers.advance(1000);
        await timers.advance(2000);
        setFail(null);
        await timers.advance(4000);
        assert.equal(conn.connected, true);
        assert.equal(conn.initFailures, 0);
        // a later outage starts at 1 s again (the re-init after a ping timeout goes the same way)
        setFail((m) => m === 'init');
        calls.length = 0;
        await conn.init();
        assert.equal(conn.connected, false);
        await timers.advance(999);
        assert.equal(calls.filter((c) => c.method === 'init').length, 1);
        await timers.advance(1);
        assert.equal(calls.filter((c) => c.method === 'init').length, 2);
    });

    test('stop() cancels the retry timer', async () => {
        const {conn, timers, setFail, calls} = setup();
        setFail((m) => m === 'init');
        await conn.start();
        assert.equal(timers.pending(), 1);
        await conn.stop();
        assert.equal(timers.pending(), 0);
        calls.length = 0;
        await timers.advance(60000);
        assert.equal(calls.length, 0);
    });

    test('initRetryDelay', () => {
        assert.deepEqual(
            [1, 2, 3, 4, 5, 6, 50].map((n) => initRetryDelay(n)),
            [1000, 2000, 4000, 8000, 15000, 15000, 15000],
        );
    });

    test('stop unsubscribes', async () => {
        const {conn, calls, servers} = setup();
        await conn.start();
        calls.length = 0;
        await conn.stop();
        assert.deepEqual(calls[0], {method: 'init', params: ['http://10.0.0.2:2126', '']});
        assert.equal(conn.connected, false);
        await servers.close();
    });
});
