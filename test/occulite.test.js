/**
 * Against a real box: `occulited` (openccu-lite's daemon) with a state directory of its own, the
 * hm-simulator for the interfaces and an in-process broker — the whole adapter, taking its names,
 * rooms and functions from the metadata API instead of from ReGa.
 *
 * Opt-in, because it needs the daemon binary:
 *
 *   go build -o /tmp/occulited ./cmd/occulited        # in the openccu-lite checkout
 *   HM2MQTT_OCCULITE=/tmp/occulited npm run test:occulite
 *
 * It uses the simulator's fixed interface ports (2001), like test/e2e.test.js — do not run both at
 * the same time.
 */

import {test, describe, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import mqtt from 'mqtt';

import {MetaSync, detectMeta, readLocalToken} from '../lib/meta.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const binary = process.env.HM2MQTT_OCCULITE;
const skip = binary ? false : 'set HM2MQTT_OCCULITE=<path to the occulited binary>';

/** the box's firmware identity; occulited reads it from <root>/VERSION */
const VERSION_FILE = 'VERSION=3.89.8.20260719\nPRODUCT=ova\nPLATFORM=ova\nVARIANT=lite\n';

function freePort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            server.close(() => resolve(port));
        });
    });
}

function waitPort(port, ms = 10000) {
    const until = Date.now() + ms;
    return new Promise((resolve, reject) => {
        const tryOnce = () => {
            const socket = net.connect({port, host: '127.0.0.1'});
            socket.once('connect', () => {
                socket.destroy();
                resolve();
            });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() > until) {
                    reject(new Error(`port ${port} not open`));
                } else {
                    setTimeout(tryOnce, 100);
                }
            });
        };
        tryOnce();
    });
}

function waitFor(predicate, ms = 10000, what = 'condition') {
    const until = Date.now() + ms;
    return new Promise((resolve, reject) => {
        const check = () => {
            const hit = predicate();
            if (hit) {
                resolve(hit);
            } else if (Date.now() > until) {
                reject(new Error('timeout waiting for ' + what));
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
}

function fakeLog() {
    const lines = {info: [], warn: [], debug: [], error: []};
    const push =
        (level) =>
        (...args) =>
            lines[level].push(args.join(' '));
    return {...Object.fromEntries(Object.keys(lines).map((l) => [l, push(l)])), lines};
}

/** hm-simulator's devices, with the channels its paramset descriptions do not cover removed. */
function simulatorDevices(iface, name) {
    const descriptions = require('hm-simulator/data/paramset-descriptions.json');
    const keys = Object.keys(descriptions);
    const {devices} = require(`hm-simulator/data/devices-${name}.json`);
    const byAddress = Object.fromEntries(devices.map((device) => [device.ADDRESS, device]));
    for (const device of devices) {
        if (device.PARENT) {
            continue;
        }
        const hit = keys.find(
            (key) => key.startsWith(`${iface}/${device.TYPE}/`) && key.split('/')[3] === String(device.VERSION),
        );
        if (hit) {
            device.FIRMWARE = hit.split('/')[2];
        }
    }
    return {
        devices: devices.filter((device) => {
            if (!device.PARENT || !device.PARAMSETS.includes('VALUES')) {
                return true;
            }
            const parent = byAddress[device.PARENT];
            return Boolean(
                parent &&
                descriptions[[iface, parent.TYPE, parent.FIRMWARE, parent.VERSION, device.TYPE, 'VALUES'].join('/')],
            );
        }),
    };
}

/** The document the box serves in this test: names, one room and one function per channel. */
const document = {
    format: 1,
    revision: 0,
    objects: {
        'BidCos-RF.BidCoS-RF': {name: 'Zentrale'},
        'BidCos-RF.BidCoS-RF:1': {name: 'Taster Küche', enums: ['room/eg/kueche', 'function/licht']},
        'BidCos-RF.BidCoS-RF:2': {name: 'Taster Flur', enums: ['room/eg/flur']},
    },
    enums: {
        room: {
            name: {de: 'Räume', en: 'Rooms'},
            tree: [
                {
                    id: 'eg',
                    name: 'Erdgeschoss',
                    children: [
                        {id: 'kueche', name: 'Küche'},
                        {id: 'flur', name: 'Flur'},
                    ],
                },
            ],
        },
        function: {name: {de: 'Gewerke', en: 'Functions'}, tree: [{id: 'licht', name: 'Licht'}]},
        floor: {name: {de: 'Etagen', en: 'Floors'}, tree: []},
    },
};

describe('openccu-lite (occulited)', {skip}, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-occulite-'));
    const root = path.join(dir, 'root');
    const state = path.join(dir, 'state');
    const stateDir = path.join(dir, 'hm2mqtt');
    const logFile = path.join(dir, 'hm2mqtt.log');
    const messages = [];
    let box;
    let boxUrl;
    let sid;
    let broker;
    let sim;
    let child;
    let client;

    const api = (endpoint, {method = 'GET', token = sid, body} = {}) =>
        fetch(`${boxUrl}${endpoint}`, {
            method,
            headers: {
                ...(token ? {authorization: `Bearer ${token}`} : {}),
                ...(body ? {'content-type': 'application/json'} : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    const last = (topic) => messages.filter((m) => m.topic === topic).pop();
    const waitTopic = (topic, ms = 20000, accept = () => true) =>
        waitFor(
            () => {
                const message = last(topic);
                return message && accept(message) ? message : null;
            },
            ms,
            topic,
        );

    before(async () => {
        fs.mkdirSync(root, {recursive: true});
        fs.mkdirSync(state, {recursive: true});
        fs.mkdirSync(stateDir, {recursive: true});
        fs.writeFileSync(path.join(root, 'VERSION'), VERSION_FILE);

        const boxPort = await freePort();
        boxUrl = `http://127.0.0.1:${boxPort}`;
        box = spawn(
            binary,
            [
                '--root',
                root,
                '--state-dir',
                state,
                '--session-dir',
                path.join(dir, 'sessions'),
                '--listen',
                `127.0.0.1:${boxPort}`,
                '--log',
                'stderr',
            ],
            {stdio: ['ignore', 'ignore', fs.openSync(path.join(dir, 'occulited.log'), 'a')]},
        );
        await waitPort(boxPort);

        // first visit: the administrator is created and the answer carries a usable session
        const setup = await (
            await fetch(`${boxUrl}/api/auth/v1/setup`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({username: 'admin', password: 'hm2mqtt-test-pw'}),
            })
        ).json();
        sid = setup.sid;
        assert.ok(sid, 'no session id from /api/auth/v1/setup');
        const imported = await api('/api/meta/v1/import?mode=replace', {method: 'PUT', body: document});
        assert.equal(imported.status, 200);

        // the interfaces and the broker, as in test/e2e.test.js (including its fixup of the
        // simulator's own data, whose firmware versions do not match its paramset descriptions)
        const HmSim = require('hm-simulator/sim.js');
        sim = new HmSim({
            devices: {rfd: simulatorDevices('BidCos-RF', 'rfd'), hmip: simulatorDevices('HmIP-RF', 'hmip')},
            config: {listenAddress: '127.0.0.1', binrpcListenPort: 2001, xmlrpcListenPort: 2010},
            behaviorPath: fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-occulite-behaviors-')),
        });
        await waitPort(2001);

        const {Aedes} = await import('aedes');
        const aedes = await Aedes.createBroker();
        const server = net.createServer(aedes.handle);
        const mqttPort = await freePort();
        await new Promise((resolve) => server.listen(mqttPort, '127.0.0.1', resolve));
        broker = {close: () => new Promise((resolve) => server.close(() => aedes.close(resolve)))};

        client = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`);
        await new Promise((resolve) => client.once('connect', resolve));
        client.subscribe('hmtest/#');
        client.on('message', (topic, payload, packet) =>
            messages.push({topic, raw: payload.toString(), retain: packet.retain}),
        );

        child = spawn(
            process.execPath,
            [
                path.join(here, '..', 'index.js'),
                '-a',
                '127.0.0.1',
                '-u',
                `mqtt://127.0.0.1:${mqttPort}`,
                '-n',
                'hmtest',
                '-i',
                'BidCos-RF',
                '--bidcos-binrpc',
                '--listen-address',
                '127.0.0.1',
                '--xmlrpc-port',
                String(await freePort()),
                '--binrpc-port',
                String(await freePort()),
                '--duty-cycle-interval',
                '0',
                '--no-ha-discovery',
                '--meta-url',
                boxUrl,
                '--meta-token',
                sid,
                '--state-dir',
                stateDir,
                '-v',
                'debug',
            ],
            {env: {...process.env, HM2MQTT_LOG_FORMAT: 'text', NO_COLOR: '1'}, stdio: ['ignore', 'pipe', 'pipe']},
        );
        const log = fs.createWriteStream(logFile);
        child.stdout.pipe(log);
        child.stderr.pipe(log);
    });

    after(async () => {
        if (child && child.exitCode === null) {
            child.kill('SIGKILL');
        }
        if (client) {
            client.end(true);
        }
        if (sim) {
            sim.close();
        }
        if (broker) {
            await broker.close();
        }
        if (box) {
            box.kill('SIGKILL');
        }
    });

    test('the provider reads names, rooms and functions from the box', {timeout: 30000}, async () => {
        const log = fakeLog();
        const sync = new MetaSync({url: boxUrl, token: sid, log});
        await sync.syncNames();
        assert.equal(sync.channelName('BidCoS-RF:1'), 'Taster Küche');
        assert.deepEqual(sync.rooms('BidCoS-RF:1'), ['Küche']);
        assert.deepEqual(sync.functions('BidCoS-RF:1'), ['Licht']);
        assert.equal(sync.channelAddress('Taster Flur'), 'BidCoS-RF:2');
        assert.equal(sync.hasVariable('Anwesenheit'), false);

        // a rename on the box arrives over the event stream, without a poll and without a restart
        const changed = new Promise((resolve) => sync.once('names', resolve));
        const patched = await api('/api/meta/v1/objects/BidCos-RF.BidCoS-RF%3A2', {
            method: 'PATCH',
            body: {name: 'Taster Diele'},
        });
        assert.equal(patched.status, 200);
        await changed;
        assert.equal(sync.channelName('BidCoS-RF:2'), 'Taster Diele');

        // and so does a renamed room, which is a node event and re-reads the snapshot
        const renamed = new Promise((resolve) => sync.once('names', resolve));
        assert.equal(
            (await api('/api/meta/v1/enums/room/nodes/eg/kueche', {method: 'PATCH', body: {name: 'Kochnische'}}))
                .status,
            200,
        );
        await renamed;
        assert.deepEqual(sync.rooms('BidCoS-RF:1'), ['Kochnische']);

        sync.stopPolling();
        // put the names back for the adapter test below
        await api('/api/meta/v1/enums/room/nodes/eg/kueche', {method: 'PATCH', body: {name: 'Küche'}});
    });

    test('detection: the box answers, the simulator does not', {timeout: 30000}, async () => {
        const found = await detectMeta(boxUrl);
        assert.equal(found.ok, true);
        assert.equal(found.version.api, 'meta');
        assert.match(found.version.implementation, /occulited/);
        // the CCU port of the simulator is not the metadata api
        const other = await detectMeta('http://127.0.0.1:2001');
        assert.equal(other.ok, false);
    });

    test("the box's local token is read-only", {timeout: 30000}, async () => {
        const token = readLocalToken(path.join(state, 'local-token'));
        assert.match(token, /^olt_[0-9a-f]{32}$/);
        assert.equal((await api('/api/meta/v1/snapshot', {token})).status, 200);
        assert.equal(
            (await api('/api/meta/v1/objects/BidCos-RF.BidCoS-RF%3A1', {token, method: 'PATCH', body: {name: 'x'}}))
                .status,
            403,
        );
    });

    test('no credential: the provider degrades to addresses', {timeout: 30000}, async () => {
        const log = fakeLog();
        const sync = new MetaSync({url: boxUrl, tokenFile: path.join(dir, 'no-such-token'), log});
        await sync.syncNames();
        assert.deepEqual(sync.channelNames, {});
        assert.equal(log.lines.warn.filter((line) => line.includes('rejected the credential')).length, 1);
        sync.stopPolling();
    });

    test('the adapter publishes with the names from the box', {timeout: 60000}, async () => {
        await waitTopic('hmtest/status/interface/BidCos-RF/connected', 30000, (m) => JSON.parse(m.raw).val === true);
        const info = await waitTopic('hmtest/info', 20000, (m) => JSON.parse(m.raw).devices > 0);
        assert.equal(JSON.parse(info.raw).names, 'occulite');

        sim.api.emit('setValue', 'rfd', 'BidCoS-RF:1', 'PRESS_SHORT', true);
        const message = await waitTopic('hmtest/status/Taster Küche/PRESS_SHORT', 30000);
        const payload = JSON.parse(message.raw);
        assert.equal(payload.val, true);
        assert.equal(payload.hm.channel, 'BidCoS-RF:1');
        assert.equal(payload.hm.channelName, 'Taster Küche');
        assert.equal(payload.hm.deviceName, 'Zentrale');
        assert.deepEqual(payload.hm.rooms, ['Küche']);
        assert.equal(payload.hm.room, 'Küche');
        assert.deepEqual(payload.hm.functions, ['Licht']);

        // a set by the name the box gave the channel
        client.publish('hmtest/set/Taster Küche/PRESS_LONG', 'true');
        await waitTopic('hmtest/status/Taster Küche/PRESS_LONG', 20000);

        // renaming the channel on the box moves the topic - no restart, no re-poll
        assert.equal(
            (
                await api('/api/meta/v1/objects/BidCos-RF.BidCoS-RF%3A1', {
                    method: 'PATCH',
                    body: {name: 'Taster Kueche neu'},
                })
            ).status,
            200,
        );
        const renamed = await waitFor(
            () => {
                const seen = last('hmtest/status/Taster Kueche neu/PRESS_SHORT');
                if (!seen) {
                    sim.api.emit('setValue', 'rfd', 'BidCoS-RF:1', 'PRESS_SHORT', true);
                }
                return seen;
            },
            20000,
            'the topic under the name the box now gives the channel',
        );
        assert.equal(JSON.parse(renamed.raw).hm.channelName, 'Taster Kueche neu');

        // system variables and programs are named as unavailable, once, and nothing polls for them
        const log = fs.readFileSync(logFile, 'utf8');
        assert.equal(log.split('no ReGaHSS on this box').length - 1, 1);
        assert.doesNotMatch(log, /TypeError|ReferenceError|Unhandled/);
    });

    test('SIGTERM: the snapshot is on disk for the next start', {timeout: 30000}, async () => {
        child.kill('SIGTERM');
        const code = await new Promise((resolve) => child.once('exit', resolve));
        assert.equal(code, 0);
        const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'meta.json'), 'utf8'));
        assert.equal(saved.objects['BidCos-RF.BidCoS-RF:1'].name, 'Taster Kueche neu');
        assert.ok(saved.revision > 0);
        assert.ok(!fs.existsSync(path.join(stateDir, 'rega.json')), 'the ReGa cache is not written on this box');
    });
});
