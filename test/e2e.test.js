/**
 * End-to-end: hm-simulator (rfd binrpc 2001, hmip xmlrpc 2010, ReGa mock 8181) + a local
 * mosquitto + hm2mqtt as a child process. Opt-in: HM2MQTT_E2E=1 npm test (or npm run test:e2e);
 * needs a mosquitto binary (MOSQUITTO=/path/to/mosquitto to point at one).
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

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const enabled = process.env.HM2MQTT_E2E === '1';

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const {port} = s.address();
            s.close(() => resolve(port));
        });
    });
}

function waitPort(port, ms = 5000) {
    const until = Date.now() + ms;
    return new Promise((resolve, reject) => {
        const tryOnce = () => {
            const c = net.connect({port, host: '127.0.0.1'});
            c.once('connect', () => {
                c.destroy();
                resolve();
            });
            c.once('error', () => {
                c.destroy();
                if (Date.now() > until) {
                    reject(new Error('port ' + port + ' not open'));
                } else {
                    setTimeout(tryOnce, 100);
                }
            });
        };
        tryOnce();
    });
}

function mosquittoBinary() {
    if (process.env.MOSQUITTO) {
        return process.env.MOSQUITTO;
    }
    for (const p of ['/usr/local/sbin/mosquitto', '/opt/homebrew/sbin/mosquitto', '/usr/sbin/mosquitto']) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return 'mosquitto';
}

describe('e2e with hm-simulator', {skip: !enabled && 'set HM2MQTT_E2E=1'}, () => {
    let broker;
    let sim;
    let child;
    let client;
    let mqttPort;
    const messages = [];
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-e2e-'));
    const logFile = path.join(stateDir, 'hm2mqtt.log');

    const last = (topic) => messages.filter((m) => m.topic === topic).pop();
    const waitFor = (predicate, ms = 15000, what = 'condition') =>
        new Promise((resolve, reject) => {
            const until = Date.now() + ms;
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
    const waitTopic = (topic, ms, test = () => true) =>
        waitFor(
            () => {
                const m = last(topic);
                return m && test(m) ? m : null;
            },
            ms,
            topic,
        );

    before(async () => {
        mqttPort = await freePort();
        broker = spawn(mosquittoBinary(), ['-p', String(mqttPort)], {stdio: 'ignore'});
        await waitPort(mqttPort);

        const HmSim = require('hm-simulator/sim.js');
        // the simulator's data set does not match its own paramset descriptions (device firmware
        // versions differ): point every device at a firmware the descriptions know, drop the rest
        const descriptions = require('hm-simulator/data/paramset-descriptions.json');
        const keys = Object.keys(descriptions);
        const usable = (iface, name) => {
            const {devices} = require(`hm-simulator/data/devices-${name}.json`);
            const byAddress = Object.fromEntries(devices.map((d) => [d.ADDRESS, d]));
            for (const d of devices) {
                if (d.PARENT) {
                    continue;
                }
                const prefix = `${iface}/${d.TYPE}/`;
                const hit = keys.find((k) => k.startsWith(prefix) && k.split('/')[3] === String(d.VERSION));
                if (hit) {
                    d.FIRMWARE = hit.split('/')[2];
                }
            }
            return {
                devices: devices.filter((d) => {
                    if (!d.PARENT || !d.PARAMSETS.includes('VALUES')) {
                        return true;
                    }
                    const parent = byAddress[d.PARENT];
                    return Boolean(
                        parent &&
                        descriptions[[iface, parent.TYPE, parent.FIRMWARE, parent.VERSION, d.TYPE, 'VALUES'].join('/')],
                    );
                }),
            };
        };
        sim = new HmSim({
            devices: {rfd: usable('BidCos-RF', 'rfd'), hmip: usable('HmIP-RF', 'hmip')},
            config: {listenAddress: '127.0.0.1', binrpcListenPort: 2001, xmlrpcListenPort: 2010},
            behaviorPath: fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-e2e-behaviors-')), // none: events come from the tests
            rega: {
                port: 8181,
                channels: [
                    {id: 1000, address: 'BidCoS-RF', name: 'Zentrale'},
                    {id: 1001, address: 'BidCoS-RF:1', name: 'Taster 1'},
                    {id: 1002, address: 'BidCoS-RF:2', name: 'Taster 2'},
                ],
                variables: [
                    {
                        id: 950,
                        name: 'Anwesenheit',
                        info: '',
                        val: true,
                        ts: '2026-01-01 12:00:00',
                        unit: '',
                        type: 'boolean',
                        enum: 'abwesend;anwesend',
                        channel: '',
                    },
                ],
                programs: [{id: 2000, name: 'Licht aus', info: '', active: true, ts: '2026-01-01 12:00:00'}],
                rooms: [{id: 20, name: 'Flur', channels: [1001, 1002]}],
                functions: [{id: 30, name: 'Taster', channels: [1001]}],
            },
        });
        await waitPort(2001);
        await waitPort(2010);
        await waitPort(8181);

        const xmlrpcPort = await freePort();
        const binrpcPort = await freePort();
        client = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`);
        await new Promise((resolve) => client.once('connect', resolve));
        client.subscribe('hmtest/#');
        client.on('message', (topic, payload, packet) => {
            messages.push({topic, raw: payload.toString(), retain: packet.retain});
        });

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
                'BidCos-RF,HmIP-RF',
                '--bidcos-binrpc',
                '--listen-address',
                '127.0.0.1',
                '--xmlrpc-port',
                String(xmlrpcPort),
                '--binrpc-port',
                String(binrpcPort),
                '--duty-cycle-interval',
                '0',
                '--rega-poll-interval',
                '2',
                '--plain-tree',
                'state',
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
            broker.kill();
        }
    });

    const json = (m) => JSON.parse(m.raw);

    test('interfaces subscribe, devices arrive, connected 2', {timeout: 30000}, async () => {
        await waitTopic('hmtest/status/interface/BidCos-RF/connected', 20000, (m) => json(m).val === true);
        await waitTopic('hmtest/status/interface/HmIP-RF/connected', 20000, (m) => json(m).val === true);
        await waitTopic('hmtest/connected', 20000, (m) => m.raw === '2');
        const info = await waitTopic('hmtest/info', 20000, (m) => json(m).devices > 0);
        assert.deepEqual(json(info).interfaces, ['BidCos-RF', 'HmIP-RF']);
        assert.ok(json(info).devices >= 90, 'devices: ' + json(info).devices);
    });

    test('events carry the hm block, PRESS_* is not retained, plain tree mirrors', {timeout: 30000}, async () => {
        sim.api.emit('setValue', 'rfd', 'BidCoS-RF:1', 'PRESS_SHORT', true);
        const m = await waitTopic('hmtest/status/Taster 1/PRESS_SHORT', 20000);
        assert.equal(m.retain, false);
        const p = json(m);
        assert.equal(p.val, true);
        assert.ok(p.ts > 0 && p.lc > 0);
        assert.equal(p.hm.iface, 'BidCos-RF');
        assert.equal(p.hm.channel, 'BidCoS-RF:1');
        assert.equal(p.hm.channelName, 'Taster 1');
        assert.equal(p.hm.device, 'BidCoS-RF');
        assert.equal(p.hm.deviceName, 'Zentrale');
        assert.equal(p.hm.deviceType, 'HM-RCV-50');
        assert.equal(p.hm.datapoint, 'PRESS_SHORT');
        assert.equal(p.hm.datapointName, 'BidCos-RF.BidCoS-RF:1.PRESS_SHORT');
        assert.equal(p.hm.datapointType, 'ACTION');
        assert.deepEqual(p.hm.rooms, ['Flur']);
        assert.equal(p.hm.function, 'Taster');
        assert.equal(p.hm.change, true);
        assert.equal(p.hm.cache, false);
        assert.equal(p.hm.stable, true);
        assert.equal(p.hm.ccu, '127.0.0.1');
        const plain = await waitTopic('hmtest/state/Taster 1/PRESS_SHORT', 5000);
        assert.equal(plain.raw, '1');
    });

    test('set by channel name reaches the interface and comes back as event; counters', {timeout: 30000}, async () => {
        client.publish('hmtest/set/Taster 2/PRESS_SHORT', 'true');
        const m = await waitTopic('hmtest/status/Taster 2/PRESS_SHORT', 10000);
        assert.equal(json(m).val, true);
        assert.equal(json(m).hm.channelName, 'Taster 2');
        client.publish('hmtest/set/BidCoS-RF:2/PRESS_LONG', '{"val": 1}');
        await waitTopic('hmtest/status/Taster 2/PRESS_LONG', 10000);
        assert.ok(json(last('hmtest/status/counter/BidCos-RF/rx')).val >= 0);
    });

    test('variables and programs: published at start, set with enum name, re-polled', {timeout: 30000}, async () => {
        const v = await waitTopic('hmtest/status/Anwesenheit', 15000);
        assert.equal(json(v).val, true);
        assert.equal(json(v).hm.type, 'SYSVAR');
        assert.equal(json(v).hm.valueEnum, 'anwesend');
        assert.deepEqual(json(v).hm.enum, ['abwesend', 'anwesend']);
        const prg = await waitTopic('hmtest/status/Licht aus', 15000);
        assert.equal(json(prg).val, true);
        assert.equal(json(prg).hm.type, 'PROGRAM');
        client.publish('hmtest/set/Anwesenheit', 'abwesend');
        const after = await waitTopic('hmtest/status/Anwesenheit', 15000, (m) => json(m).val === false);
        assert.equal(json(after).hm.change, true);
        assert.equal(json(after).hm.valuePrevious, true);
    });

    test('unknown targets and unexpected topics are warned, not crashed', {timeout: 30000}, async () => {
        client.publish('hmtest/set/Nope/STATE', '1');
        client.publish('hmtest/paramset/Nope/MASTER', '{"A": 1}');
        client.publish('hmtest/status/x', '1');
        await waitFor(() => fs.readFileSync(logFile, 'utf8').includes('set Nope/STATE failed'), 5000, 'warn line');
        assert.equal(child.exitCode, null);
    });

    test('SIGTERM: unsubscribe, connected 0, state saved', {timeout: 30000}, async () => {
        child.kill('SIGTERM');
        const code = await new Promise((resolve) => child.once('exit', resolve));
        assert.equal(code, 0);
        await waitTopic('hmtest/connected', 5000, (m) => m.raw === '0');
        for (const f of ['devices.json', 'paramsets.json', 'values.json', 'rega.json']) {
            assert.ok(fs.existsSync(path.join(stateDir, f)), f);
        }
        const log = fs.readFileSync(logFile, 'utf8');
        assert.match(log, /rpc BidCos-RF > init xmlrpc_bin:\/\/127\.0\.0\.1:\d+ \(unsubscribe\)/);
        assert.doesNotMatch(log, /TypeError|ReferenceError|Unhandled/);
    });
});
