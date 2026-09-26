import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {
    parseInterfaces,
    interfaceConfig,
    probeInterfaces,
    DEFAULT_INTERFACES,
    regaPort,
    isLocalHost,
    detectLocal,
    watchInterfaces,
} from '../lib/interfaces.js';

describe('interfaces', () => {
    test('parseInterfaces', () => {
        assert.deepEqual(parseInterfaces('BidCos-RF,HmIP-RF'), ['BidCos-RF', 'HmIP-RF']);
        assert.deepEqual(parseInterfaces('bidcos-rf, cuxd'), ['BidCos-RF', 'CUxD']);
        assert.equal(parseInterfaces('auto'), null);
        assert.equal(parseInterfaces(''), null);
        assert.throws(() => parseInterfaces('rfd'), /unknown interface "rfd"/);
        assert.deepEqual(parseInterfaces(DEFAULT_INTERFACES.join(',')), DEFAULT_INTERFACES);
    });

    test('interfaceConfig: ports, tls, binrpc', () => {
        assert.deepEqual(interfaceConfig('BidCos-RF'), {
            name: 'BidCos-RF',
            protocol: 'xmlrpc',
            port: 2001,
            path: undefined,
            init: true,
            ping: true,
            pingTimeout: undefined,
            dutyCycle: true,
        });
        assert.equal(interfaceConfig('BidCos-RF', {tls: true}).port, 42001);
        assert.equal(interfaceConfig('BidCos-RF', {bidcosBinrpc: true}).protocol, 'binrpc');
        assert.equal(interfaceConfig('BidCos-RF', {bidcosBinrpc: true, tls: true}).protocol, 'xmlrpc');
        assert.equal(interfaceConfig('HmIP-RF', {bidcosBinrpc: true}).protocol, 'xmlrpc');
        assert.equal(interfaceConfig('HmIP-RF').pingTimeout, 600);
        assert.equal(interfaceConfig('VirtualDevices').path, '/groups');
        assert.equal(interfaceConfig('VirtualDevices').ping, false);
        assert.equal(interfaceConfig('CUxD').protocol, 'binrpc');
        assert.equal(interfaceConfig('CUxD', {tls: true}).port, 8701);
        assert.throws(() => interfaceConfig('rfd'), /unknown interface/);
    });

    test('probeInterfaces uses the injected connect', async () => {
        const asked = [];
        const found = await probeInterfaces('ccu', {
            connect: async (host, port) => {
                asked.push(port);
                return [2001, 2010].includes(port);
            },
        });
        assert.deepEqual(found, ['BidCos-RF', 'HmIP-RF']);
        assert.deepEqual(asked, [2001, 2000, 2010, 9292, 8701]);
    });
});

describe('local mode', () => {
    test('BidCos switches to binrpc on the process ports, HmIP and virtual devices past the proxy', () => {
        assert.deepEqual(interfaceConfig('BidCos-RF', {local: true}), {
            name: 'BidCos-RF',
            protocol: 'binrpc',
            port: 32001,
            path: undefined,
            init: true,
            ping: true,
            pingTimeout: undefined,
            dutyCycle: true,
        });
        assert.equal(interfaceConfig('BidCos-Wired', {local: true}).port, 32000);
        assert.equal(interfaceConfig('BidCos-Wired', {local: true}).protocol, 'binrpc');
        // hmipserver speaks no binrpc - only the port changes
        assert.equal(interfaceConfig('HmIP-RF', {local: true}).protocol, 'xmlrpc');
        assert.equal(interfaceConfig('HmIP-RF', {local: true}).port, 32010);
        assert.equal(interfaceConfig('VirtualDevices', {local: true}).port, 39292);
        assert.equal(interfaceConfig('VirtualDevices', {local: true}).path, '/groups');
        // CUxD was always binrpc and has no proxy in front of it
        assert.equal(interfaceConfig('CUxD', {local: true}).port, 8701);
    });

    test('ignores tls locally - the process ports carry none', () => {
        assert.equal(interfaceConfig('BidCos-RF', {local: true, tls: true}).port, 32001);
        assert.equal(interfaceConfig('HmIP-RF', {local: true, tls: true}).port, 32010);
        assert.equal(interfaceConfig('HmIP-RF', {tls: true}).port, 42010);
    });

    test('picks the ReGa port', () => {
        assert.equal(regaPort({}), 8181);
        assert.equal(regaPort({tls: true}), 48181);
        assert.equal(regaPort({local: true}), 8183);
        assert.equal(regaPort({local: true, tls: true}), 8183);
    });

    test('recognises a local address', () => {
        for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1']) {
            assert.equal(isLocalHost(host), true, host);
        }
        for (const host of ['192.168.1.5', 'homematic-ccu3', '', undefined]) {
            assert.equal(isLocalHost(host), false, String(host));
        }
    });

    test('detects local mode by probing the process ports, not by reading a config file', async () => {
        const tried = [];
        const connect = async (host, port) => {
            tried.push(port);
            return port === 32010; // an HmIP-only CCU
        };
        assert.equal(await detectLocal('127.0.0.1', {connect}), true);
        // all process ports plus ReGa's own, probed concurrently
        assert.deepEqual([...tried].sort(), [32000, 32001, 32010, 39292, 8183].sort());
    });

    test('is not local when nothing answers, and never for a remote address', async () => {
        const connect = async () => true;
        assert.equal(await detectLocal('192.168.1.5', {connect}), false, 'a remote address is never local');
        assert.equal(await detectLocal('127.0.0.1', {connect: async () => false}), false);
    });

    test('probes the local ports for --interfaces auto in local mode', async () => {
        const open = new Set([32001, 32010]);
        const found = await probeInterfaces('127.0.0.1', {local: true, connect: async (h, port) => open.has(port)});
        assert.deepEqual(found, ['BidCos-RF', 'HmIP-RF']);
    });

    test('waits for the interface processes on a loopback address when asked to (B-1)', async () => {
        let clock = 0;
        const slept = [];
        let waits = 0;
        let open = false;
        const connect = async () => open;
        const sleep = async (ms) => {
            slept.push(ms);
            clock += ms;
            if (clock >= 15000) {
                open = true; // rfd answers after 15 s
            }
        };
        const local = await detectLocal('127.0.0.1', {
            connect,
            waitMs: 120000,
            sleep,
            now: () => clock,
            onWait: () => (waits += 1),
        });
        assert.equal(local, true);
        assert.deepEqual(slept, [1000, 2000, 4000, 8000]);
        assert.equal(waits, 1, 'one line while it waits');
    });

    test('does not wait when the usual ports answer on the loopback address (a tunnel, a simulator)', async () => {
        let slept = 0;
        const connect = async (h, port) => port === 2001 || port === 2010;
        const local = await detectLocal('127.0.0.1', {connect, waitMs: 120000, sleep: async () => (slept += 1)});
        assert.equal(local, false);
        assert.equal(slept, 0);
    });

    test('gives up waiting after waitMs, and never waits for a remote address', async () => {
        let clock = 0;
        const sleep = async (ms) => {
            clock += ms;
        };
        const local = await detectLocal('127.0.0.1', {
            connect: async () => false,
            waitMs: 120000,
            sleep,
            now: () => clock,
        });
        assert.equal(local, false);
        assert.ok(clock <= 120000 && clock > 100000, String(clock));
        let slept = 0;
        await detectLocal('192.168.1.5', {connect: async () => false, waitMs: 120000, sleep: async () => (slept += 1)});
        assert.equal(slept, 0);
    });
});

describe('watchInterfaces (B-1)', () => {
    function fakeTimers() {
        let now = 0;
        const timers = [];
        return {
            setTimeout: (fn, ms) => {
                const t = {fn, at: now + ms};
                timers.push(t);
                return t;
            },
            clearTimeout: (t) => {
                const i = timers.indexOf(t);
                if (i !== -1) timers.splice(i, 1);
            },
            advance: async (ms) => {
                now += ms;
                for (const t of timers.filter((x) => x.at <= now)) {
                    timers.splice(timers.indexOf(t), 1);
                    await t.fn();
                }
            },
            pending: () => timers.length,
        };
    }

    test('an interface missing at the start is probed on the init schedule and handed over once when it answers', async () => {
        const timers = fakeTimers();
        const open = new Set();
        const probes = [];
        const found = [];
        const connect = async (h, port) => {
            probes.push(port);
            return open.has(port);
        };
        const watch = watchInterfaces('127.0.0.1', ['HmIP-RF', 'VirtualDevices'], {
            local: true,
            connect,
            timers,
            onFound: (name) => found.push(name),
        });
        assert.deepEqual(watch.missing(), ['HmIP-RF', 'VirtualDevices']);
        await timers.advance(999);
        assert.equal(probes.length, 0);
        await timers.advance(1); // 1 s
        assert.deepEqual(probes, [32010, 39292]);
        await timers.advance(2000); // 3 s
        open.add(32010);
        await timers.advance(4000); // 7 s: hmipserver answers
        assert.deepEqual(found, ['HmIP-RF']);
        assert.deepEqual(watch.missing(), ['VirtualDevices']);
        probes.length = 0;
        await timers.advance(8000); // 15 s: only the one still missing is probed
        assert.deepEqual(probes, [39292]);
        open.add(39292);
        await timers.advance(15000);
        assert.deepEqual(found, ['HmIP-RF', 'VirtualDevices']);
        assert.equal(timers.pending(), 0, 'nothing left to probe');
    });

    test('stop() ends the probing', async () => {
        const timers = fakeTimers();
        const watch = watchInterfaces('127.0.0.1', ['CUxD'], {connect: async () => false, timers, onFound: () => {}});
        assert.equal(timers.pending(), 1);
        watch.stop();
        assert.equal(timers.pending(), 0);
    });

    test('nothing missing, nothing scheduled', () => {
        const timers = fakeTimers();
        watchInterfaces('127.0.0.1', [], {connect: async () => false, timers, onFound: () => {}});
        assert.equal(timers.pending(), 0);
    });
});
