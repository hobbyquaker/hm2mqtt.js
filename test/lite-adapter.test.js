/**
 * The whole adapter against an openccu-lite elsewhere: hm2mqtt as a child process, connected through
 * occulite-client to a FakeBox (a fake system in this process), an aedes broker in this process. No
 * callback server, no init: the values the system has are retained topics at connect, events come
 * over the stream, writes go over lite-rpc, the names from the metadata. Runs in `npm test`.
 */

import {test, describe, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import mqtt from 'mqtt';
import {FakeBox} from 'occulite-client/testing';

const here = path.dirname(fileURLToPath(import.meta.url));
const index = path.join(here, '..', 'index.js');

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const {port} = s.address();
            s.close(() => resolve(port));
        });
    });
}

function waitFor(predicate, ms = 15000, what = 'condition') {
    const until = Date.now() + ms;
    return new Promise((resolve, reject) => {
        const check = () => {
            const hit = predicate();
            if (hit) {
                resolve(hit);
            } else if (Date.now() > until) {
                reject(new Error('timeout waiting for ' + what));
            } else {
                setTimeout(check, 50);
            }
        };
        check();
    });
}

const devices = {
    'HmIP-RF': [
        {
            ADDRESS: '000A1B2C3D4E5F',
            TYPE: 'HmIP-PS',
            FIRMWARE: '1.0.0',
            VERSION: 1,
            CHILDREN: ['000A1B2C3D4E5F:0', '000A1B2C3D4E5F:3'],
            PARAMSETS: ['MASTER'],
        },
        {ADDRESS: '000A1B2C3D4E5F:0', PARENT: '000A1B2C3D4E5F', TYPE: 'MAINTENANCE', PARAMSETS: ['VALUES'], VERSION: 1},
        {
            ADDRESS: '000A1B2C3D4E5F:3',
            PARENT: '000A1B2C3D4E5F',
            TYPE: 'SWITCH_VIRTUAL_RECEIVER',
            PARAMSETS: ['VALUES'],
            VERSION: 1,
        },
    ],
};
const descriptions = {
    'HmIP-RF.000A1B2C3D4E5F:0': {UNREACH: {TYPE: 'BOOL', OPERATIONS: 5}},
    'HmIP-RF.000A1B2C3D4E5F:3': {STATE: {TYPE: 'BOOL', OPERATIONS: 7}, ON_TIME: {TYPE: 'FLOAT', OPERATIONS: 2}},
};
const meta = {
    revision: 3,
    objects: {
        'HmIP-RF.000A1B2C3D4E5F': {name: 'Steckdose'},
        'HmIP-RF.000A1B2C3D4E5F:3': {name: 'Stehlampe', enums: ['room/eg/wohnzimmer', 'function/licht']},
    },
    enums: {
        room: {name: {en: 'Rooms'}, tree: [{id: 'eg', name: 'EG', children: [{id: 'wohnzimmer', name: 'Wohnzimmer'}]}]},
        function: {name: {en: 'Functions'}, tree: [{id: 'licht', name: 'Licht'}]},
    },
};

describe('openccu-lite elsewhere (FakeBox)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-lite-adapter-'));
    const stateDir = path.join(dir, 'state');
    const messages = [];
    let fake;
    let broker;
    let client;
    let child;
    let output = '';

    const last = (topic) => messages.filter((m) => m.topic === topic).pop();
    const json = (topic) => JSON.parse(last(topic).raw);

    before(async () => {
        fake = new FakeBox({
            token: 'olt_paired',
            interfaces: ['HmIP-RF'],
            devices,
            descriptions,
            values: {
                'HmIP-RF.000A1B2C3D4E5F:0.UNREACH': {
                    value: false,
                    ts: '2026-11-01T10:00:00Z',
                    lc: '2026-10-01T10:00:00Z',
                },
                'HmIP-RF.000A1B2C3D4E5F:3.STATE': {value: true, ts: '2026-11-01T10:00:00Z', confirmed: false},
            },
            meta,
        });
        const url = await fake.start();
        // the credential as pairing stores it
        fs.mkdirSync(stateDir, {recursive: true});
        fs.writeFileSync(
            path.join(stateDir, 'occulite.json'),
            JSON.stringify({url, token: 'olt_paired', fingerprint256: ''}),
            {mode: 0o600},
        );

        const {Aedes} = await import('aedes');
        const aedes = await Aedes.createBroker();
        const server = net.createServer(aedes.handle);
        const mqttPort = await freePort();
        await new Promise((resolve) => server.listen(mqttPort, '127.0.0.1', resolve));
        broker = {close: () => new Promise((resolve) => server.close(() => aedes.close(resolve)))};
        client = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`);
        await new Promise((resolve) => client.once('connect', resolve));
        client.subscribe('hmlite/#');
        client.on('message', (topic, payload, packet) =>
            messages.push({topic, raw: payload.toString(), retain: packet.retain}),
        );

        child = spawn(
            process.execPath,
            [
                index,
                '-a',
                '127.0.0.1',
                '--backend',
                'openccu-lite',
                '--meta-url',
                url,
                '-u',
                `mqtt://127.0.0.1:${mqttPort}`,
                '-n',
                'hmlite',
                '-i',
                'HmIP-RF,BidCos-RF',
                '--listen-address',
                '127.0.0.1',
                '--rpc-topics',
                '--duty-cycle-interval',
                '0',
                '--no-ha-discovery',
                '--state-dir',
                stateDir,
                '-v',
                'debug',
            ],
            {env: {...process.env, HM2MQTT_LOG_FORMAT: 'text', NO_COLOR: '1'}, stdio: ['ignore', 'pipe', 'pipe']},
        );
        child.stdout.on('data', (d) => (output += d));
        child.stderr.on('data', (d) => (output += d));
    });

    after(async () => {
        if (child && child.exitCode === null) {
            child.kill('SIGKILL');
        }
        client?.end(true);
        await broker?.close();
        await fake?.stop();
    });

    test(
        'values at connect: retained, with the names, uncertain where the system restored them',
        {timeout: 30000},
        async () => {
            await waitFor(() => last('hmlite/status/Stehlampe/STATE'), 20000, 'the STATE topic').catch((err) => {
                throw new Error(err.message + '\n' + output);
            });
            const state = json('hmlite/status/Stehlampe/STATE');
            assert.equal(state.val, true);
            assert.equal(state.ts, Date.parse('2026-11-01T10:00:00Z'));
            assert.equal(state.hm.uncertain, true);
            assert.equal(state.hm.channelName, 'Stehlampe');
            assert.equal(state.hm.deviceName, 'Steckdose');
            assert.deepEqual(state.hm.rooms, ['Wohnzimmer']);
            assert.deepEqual(state.hm.functions, ['Licht']);
            // retained: a client that subscribes now gets it from the broker
            const late = mqtt.connect(client.options.href || `mqtt://127.0.0.1:${client.options.port}`);
            const retained = await new Promise((resolve) => {
                late.on('message', (topic, payload, packet) => resolve(packet.retain));
                late.subscribe('hmlite/status/Stehlampe/STATE');
            });
            late.end(true);
            assert.equal(retained, true);
            const unreach = json('hmlite/status/000A1B2C3D4E5F:0/UNREACH');
            assert.equal(unreach.hm.uncertain, false);
            assert.equal(unreach.lc, Date.parse('2026-10-01T10:00:00Z'));
            // the interface is connected; one the system does not run is left out
            await waitFor(() => last('hmlite/status/interface/HmIP-RF/connected'), 10000, 'connected');
            await waitFor(
                () => json('hmlite/status/interface/HmIP-RF/connected').val === true,
                10000,
                'connected true',
            );
            assert.equal(last('hmlite/status/interface/BidCos-RF/connected'), undefined);
            assert.match(output, /openccu-lite does not run BidCos-RF/);
            assert.match(output, /--listen-address is not used/);
            const info = await waitFor(
                () => last('hmlite/info') && json('hmlite/info').devices > 0 && json('hmlite/info'),
                10000,
                'info',
            );
            assert.equal(info.names, 'occulite');
        },
    );

    test('events over the stream, writes over lite-rpc, the rpc topics', {timeout: 30000}, async () => {
        fake.event('HmIP-RF', '000A1B2C3D4E5F:3', 'STATE', false);
        await waitFor(
            () => last('hmlite/status/Stehlampe/STATE') && json('hmlite/status/Stehlampe/STATE').val === false,
            10000,
            'event',
        );
        assert.equal(json('hmlite/status/Stehlampe/STATE').hm.uncertain, false);

        client.publish('hmlite/set/Stehlampe/STATE', 'true');
        await waitFor(() => fake.calls.find((c) => c.method === 'setValue'), 10000, 'setValue');
        assert.deepEqual(fake.calls.find((c) => c.method === 'setValue').params, ['000A1B2C3D4E5F:3', 'STATE', true]);
        client.publish('hmlite/set/Stehlampe/ON_TIME', '10');
        await waitFor(() => fake.calls.filter((c) => c.method === 'setValue').length === 2, 10000, 'setValue FLOAT');
        assert.deepEqual(fake.calls.filter((c) => c.method === 'setValue')[1].params, [
            '000A1B2C3D4E5F:3',
            'ON_TIME',
            {double: 10},
        ]);

        client.publish('hmlite/rpc/HmIP-RF/getValue/1', JSON.stringify(['000A1B2C3D4E5F:3', 'STATE']));
        await waitFor(() => last('hmlite/response/1'), 10000, 'rpc response');
        assert.equal(last('hmlite/response/1').raw, 'false');
    });

    test('SIGTERM: no callback servers to close, a clean exit', {timeout: 15000}, async () => {
        child.kill('SIGTERM');
        const code = await new Promise((resolve) => child.once('exit', resolve));
        assert.equal(code, 0);
        assert.doesNotMatch(output, /server listening|> init|TypeError|ReferenceError|Unhandled/);
    });
});

describe('openccu-lite elsewhere: every interface it runs, a token, the duty cycle', () => {
    test(
        'auto interfaces, one added later; ignored and PRESS values stay out; a token instead of pairing',
        {timeout: 40000},
        async () => {
            const fake = new FakeBox({
                token: 'olt_token',
                interfaces: ['HmIP-RF', 'CUxD'],
                devices,
                descriptions,
                values: {
                    'HmIP-RF.000A1B2C3D4E5F:3.STATE': {value: true},
                    'HmIP-RF.000A1B2C3D4E5F:3.PRESS_SHORT': {value: true},
                    'HmIP-RF.000A1B2C3D4E5F:0.RSSI_DEVICE': {value: -60},
                },
                meta,
            });
            const url = await fake.start();
            const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-lite-adapter-'));
            // where it was paired: the url stands, the token given on the command line wins
            fs.writeFileSync(path.join(stateDir, 'occulite.json'), JSON.stringify({url, token: 'olt_stale'}));
            const {Aedes} = await import('aedes');
            const aedes = await Aedes.createBroker();
            const server = net.createServer(aedes.handle);
            const mqttPort = await freePort();
            await new Promise((resolve) => server.listen(mqttPort, '127.0.0.1', resolve));
            const seen = [];
            const client = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`);
            await new Promise((resolve) => client.once('connect', resolve));
            client.subscribe('hmauto/#');
            client.on('message', (topic, payload) => seen.push({topic, raw: payload.toString()}));
            let out = '';
            const args = ['-a', '127.0.0.1', '--backend', 'openccu-lite', '--meta-token', 'olt_token'];
            args.push('-u', `mqtt://127.0.0.1:${mqttPort}`, '-n', 'hmauto', '-i', 'auto', '--ignore', '*.*.RSSI_*');
            args.push('--duty-cycle-interval', '1', '--no-ha-discovery', '--state-dir', stateDir, '-v', 'debug');
            const p = spawn(process.execPath, [index, ...args], {
                env: {...process.env, HM2MQTT_LOG_FORMAT: 'text', NO_COLOR: '1'},
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            p.stdout.on('data', (d) => (out += d));
            p.stderr.on('data', (d) => (out += d));
            const has = (topic) => seen.some((m) => m.topic === topic);
            try {
                await waitFor(() => has('hmauto/status/Stehlampe/STATE'), 20000, 'STATE').catch((err) => {
                    throw new Error(err.message + '\n' + out);
                });
                assert.match(out, /interfaces: HmIP-RF, CUxD\n/);
                assert.equal(has('hmauto/status/Stehlampe/PRESS_SHORT'), false);
                assert.equal(has('hmauto/status/000A1B2C3D4E5F:0/RSSI_DEVICE'), false);
                // an interface that comes up later is used
                fake.addInterface('BidCos-RF', {devices: []});
                await waitFor(() => has('hmauto/status/interface/BidCos-RF/connected'), 10000, 'BidCos-RF');
                assert.match(out, /interface BidCos-RF answers now/);
                // the duty cycle is asked through lite-rpc (FakeBox does not know the method: a debug line)
                await waitFor(() => fake.calls.some((c) => c.method === 'listBidcosInterfaces'), 10000, 'duty cycle');
            } finally {
                // a clean exit, so the child's coverage is written
                const exited = new Promise((resolve) => p.once('exit', resolve));
                p.kill('SIGTERM');
                await exited;
                client.end(true);
                await new Promise((resolve) => server.close(() => aedes.close(resolve)));
                await fake.stop();
            }
        },
    );
});

/** hm2mqtt as a child process until it exits: its code and its output */
function run(args, {ms = 20000} = {}) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [index, ...args], {
            env: {...process.env, HM2MQTT_LOG_FORMAT: 'text', NO_COLOR: '1'},
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        const timer = setTimeout(() => p.kill('SIGKILL'), ms);
        p.on('exit', (code) => {
            clearTimeout(timer);
            resolve({code, out});
        });
    });
}

describe('pairing', () => {
    test('--pair: the code is logged, the credential stored with 0600, then it exits', {timeout: 30000}, async () => {
        const fake = new FakeBox({autoApprove: true, token: 'x'});
        const url = await fake.start();
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-pair-'));
        try {
            const {code, out} = await run(['--pair', url, '--state-dir', stateDir]);
            assert.equal(code, 0, out);
            assert.match(
                out,
                /Pairing code \d{3} \d{3} - approve hm2mqtt\.js on 127\.0\.0\.1:\d+ on the system's Status page/,
            );
            const file = path.join(stateDir, 'occulite.json');
            assert.equal(fs.statSync(file).mode & 0o777, 0o600);
            assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).url, url);
        } finally {
            await fake.stop();
        }
    });

    test('--pair: what is no openccu-lite, or nothing, is an error', {timeout: 30000}, async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-pair-'));
        const closed = await freePort();
        const nothing = await run(['--pair', `http://127.0.0.1:${closed}`, '--state-dir', stateDir]);
        assert.equal(nothing.code, 1);
        assert.match(nothing.out, /does not answer \(refused\)/);
        const html = net.createServer((socket) =>
            socket.end(
                'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 6\r\nConnection: close\r\n\r\n<html>',
            ),
        );
        await new Promise((resolve) => html.listen(0, '127.0.0.1', resolve));
        try {
            const ccu = await run(['--pair', `http://127.0.0.1:${html.address().port}`, '--state-dir', stateDir]);
            assert.equal(ccu.code, 1);
            assert.match(ccu.out, /is not an openccu-lite system/);
        } finally {
            html.close();
        }
        const empty = await run(['--pair', '--state-dir', stateDir]);
        assert.equal(empty.code, 1);
        assert.match(empty.out, /--pair needs a url/);
        // a pairing the system rejects
        const fake = new FakeBox({token: 'x'});
        const url = await fake.start();
        try {
            const pending = run(['--pair', url, '--state-dir', stateDir]);
            await waitFor(() => fake.pairings.size > 0 && [...fake.pairings.values()][0].clientNonce, 10000, 'request');
            const [[id, p]] = [...fake.pairings];
            p.state = 'rejected';
            const rejected = await pending;
            assert.equal(rejected.code, 1, id);
            assert.match(rejected.out, /pairing failed: the administrator rejected the request/);
        } finally {
            await fake.stop();
        }
    });

    test(
        'elsewhere without a credential: the hint and an exit; --pair-on-start pairs and goes on',
        {timeout: 40000},
        async () => {
            const fake = new FakeBox({
                autoApprove: true,
                token: 'x',
                interfaces: ['HmIP-RF'],
                devices: {'HmIP-RF': []},
            });
            const url = await fake.start();
            const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-pair-'));
            const mqttPort = await freePort();
            const common = [
                '-a',
                '127.0.0.1',
                '--backend',
                'openccu-lite',
                '--meta-url',
                url,
                '-u',
                `mqtt://127.0.0.1:${mqttPort}`,
            ];
            try {
                const none = await run([...common, '--state-dir', stateDir]);
                assert.equal(none.code, 1);
                assert.match(none.out, /needs a credential: pair once with `hm2mqtt --pair http:\/\/127\.0\.0\.1:\d+`/);
                // without --meta-url the address itself, https with --ccu-tls
                const tls = await run([
                    '-a',
                    '127.0.0.1',
                    '--backend',
                    'openccu-lite',
                    '--ccu-tls',
                    '--state-dir',
                    stateDir,
                ]);
                assert.equal(tls.code, 1);
                assert.match(tls.out, /pair once with `hm2mqtt --pair https:\/\/127\.0\.0\.1`/);

                // the token the pairing gives is FakeBox's own: approve as the system would
                fake.approve = function (id) {
                    const p = this.pairings.get(id);
                    p.state = 'approved';
                    p.token = this.opts.token;
                };
                const p = spawn(
                    process.execPath,
                    [index, ...common, '-i', 'BidCos-RF', '--pair-on-start', '--state-dir', stateDir, '-v', 'debug'],
                    {
                        env: {...process.env, HM2MQTT_LOG_FORMAT: 'text', NO_COLOR: '1'},
                        stdio: ['ignore', 'pipe', 'pipe'],
                    },
                );
                let out = '';
                p.stdout.on('data', (d) => (out += d));
                p.stderr.on('data', (d) => (out += d));
                try {
                    await waitFor(() => /interfaces: \(none\)/.test(out), 20000, 'connected after pairing');
                    assert.match(out, /occulite: connected to/);
                    assert.match(out, /Pairing code/);
                    assert.ok(fs.existsSync(path.join(stateDir, 'occulite.json')));
                } finally {
                    // a clean exit, so the child's coverage is written
                    const exited = new Promise((resolve) => p.once('exit', resolve));
                    p.kill('SIGTERM');
                    await exited;
                }

                // a pairing that fails at start is an error
                fake.approve = function (id) {
                    this.pairings.get(id).state = 'rejected';
                };
                fs.rmSync(path.join(stateDir, 'occulite.json'));
                const failed = await run([...common, '--pair-on-start', '--state-dir', stateDir]);
                assert.equal(failed.code, 1);
                assert.match(failed.out, /pairing failed/);
            } finally {
                await fake.stop();
            }
        },
    );
});

describe('an address that did not answer at start', () => {
    test('openccu-lite answering there later: a restart to connect through its API', {timeout: 30000}, async () => {
        const port = await freePort();
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-redetect-'));
        const args = ['-a', '127.0.0.1', '--meta-url', `http://127.0.0.1:${port}`, '--no-local', '--no-rega'];
        args.push(
            '-i',
            'HmIP-RF',
            '-u',
            `mqtt://127.0.0.1:${await freePort()}`,
            '--state-dir',
            stateDir,
            '-v',
            'debug',
        );
        const p = spawn(process.execPath, [index, ...args], {
            env: {...process.env, HM2MQTT_LOG_FORMAT: 'text', NO_COLOR: '1', HM2MQTT_REDETECT_MS: '200'},
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        const exited = new Promise((resolve) => p.once('exit', resolve));
        let server;
        try {
            await waitFor(() => /nothing answers on http:\/\/127\.0\.0\.1:\d+ \(refused\)/.test(out), 15000, 'refused');
            server = http.createServer((req, res) => {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({api: 'meta', version: 1, format: 1}));
            });
            await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
            assert.equal(await exited, 1);
            assert.match(out, /openccu-lite answers on 127\.0\.0\.1 now - restarting to connect through its API/);
        } finally {
            if (p.exitCode === null) {
                p.kill('SIGKILL');
            }
            server?.close();
        }
    });
});
