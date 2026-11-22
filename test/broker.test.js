import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import mqtt from 'mqtt';
import {Aedes} from 'aedes';
import {backoffConnect} from '../lib/broker.js';
import {Outage, clockTime} from '../lib/outage.js';

function fakeLog() {
    const lines = [];
    const at =
        (level) =>
        (...args) =>
            lines.push([level, args.join(' ')]);
    return {lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error')};
}

function fakeTimers() {
    let now = 0;
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
            if (i !== -1) timers.splice(i, 1);
        },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
                if (!due) {
                    break;
                }
                timers.splice(timers.indexOf(due), 1);
                now = due.at;
                due.fn();
            }
            now = target;
        },
        pending: () => timers.length,
    };
}

/** mqtt.js' client as far as the wrapper uses it: a broker that fails every attempt with `error` */
class FakeClient extends EventEmitter {
    constructor(clock, {error = () => 'connect EHOSTUNREACH 192.0.2.1:1883'} = {}) {
        super();
        this.clock = clock;
        this.error = error;
        this.attempts = [];
        this.up = false;
        this.ended = false;
    }

    connect() {
        this.attempts.push(this.clock.now());
        if (this.up) {
            this.emit('connect');
            return;
        }
        const err = new Error(this.error());
        this.emit('error', err);
        this.emit('close');
    }

    end(force, opts, cb) {
        this.ended = true;
        if (cb) cb();
    }
}

function setup({error, stopping} = {}) {
    const clock = fakeTimers();
    const log = fakeLog();
    let client = null;
    let options = null;
    const connect = backoffConnect({
        connect: (url, opts) => {
            options = opts;
            client = new FakeClient(clock, {error});
            return client;
        },
        log: () => log,
        stopping,
        timers: clock,
        now: clock.now,
    });
    const c = connect('mqtt://broker', {clientId: 'x', reconnectPeriod: 1000});
    // what the core does: an error listener that logs every error at error level
    c.on('error', (err) => log.error('mqtt', err.message));
    c.connect(); // mqtt.js connects in its constructor
    return {clock, log, client, options};
}

describe('broker connection: backoff and log (B-11)', () => {
    test("mqtt.js' own fixed-period retry is switched off", () => {
        const {options} = setup();
        assert.equal(options.reconnectPeriod, 0);
        assert.equal(options.clientId, 'x');
    });

    test('an unreachable broker: attempts at 1, 2, 4 … 60 s apart, a few log lines an hour', () => {
        const {clock, log, client} = setup();
        clock.advance(3600 * 1000);
        const gaps = client.attempts.slice(1).map((t, i) => t - client.attempts[i]);
        assert.deepEqual(gaps.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 32000, 60000]);
        assert.ok(gaps.slice(6).every((g) => g === 60000));
        // about 60 attempts an hour instead of ~900 at the old fixed ~4 s
        assert.equal(client.attempts.length, 1 + 6 + Math.floor((3600000 - 63000) / 60000));
        const visible = log.lines.filter(([level]) => level !== 'debug');
        assert.equal(log.lines.filter(([level]) => level === 'error').length, 0, 'nothing at error level');
        // the first failure and one summary every 10 min: 1 + 5 in the first hour
        assert.equal(visible.length, 6);
        assert.match(visible[0][1], /^mqtt connect EHOSTUNREACH 192\.0\.2\.1:1883 - retrying/);
        assert.match(visible[1][1], /^mqtt still failing: connect EHOSTUNREACH .* - \d+ attempts since \d\d:\d\d$/);
    });

    test('connected again: one info line, and the next outage starts at 1 s again', () => {
        const {clock, log, client} = setup();
        clock.advance(100000);
        client.up = true;
        clock.advance(60000);
        const info = log.lines.filter(([level]) => level === 'info');
        assert.equal(info.length, 1);
        assert.match(info[0][1], /^mqtt connected again after \d+ failed attempts since \d\d:\d\d$/);
        // the connection drops
        client.up = false;
        const n = client.attempts.length;
        const lost = clock.now();
        client.emit('close');
        clock.advance(3000);
        assert.deepEqual(
            client.attempts.slice(n).map((t) => t - lost),
            [1000, 3000],
        );
        assert.equal(log.lines.filter(([level]) => level === 'warn').length, 2, 'a new outage warns once');
    });

    test('every error kind alike; a second kind in the same outage is one more line', () => {
        const errors = [
            'connect ECONNREFUSED 127.0.0.1:1883',
            'connect ETIMEDOUT 192.0.2.1:1883',
            'getaddrinfo ENOTFOUND broker',
            'Connection refused: Not authorized',
        ];
        for (const message of errors) {
            const {clock, log} = setup({error: () => message});
            clock.advance(300000);
            const visible = log.lines.filter(([level]) => level !== 'debug');
            assert.equal(visible.length, 1, message);
            assert.equal(visible[0][0], 'warn');
        }
        let i = 0;
        const {clock, log} = setup({error: () => errors[i++ % 2]});
        clock.advance(300000);
        const visible = log.lines.filter(([level]) => level !== 'debug');
        assert.equal(visible.length, 2, 'ECONNREFUSED and ETIMEDOUT alternating: two lines, not one per attempt');
        assert.match(visible[1][1], /failing since \d\d:\d\d$/);
    });

    test('shutting down (B-3): a broken connection is debug, and no retry', () => {
        let stopping = false;
        const {clock, log, client} = setup({stopping: () => stopping});
        client.up = true;
        clock.advance(1000);
        log.lines.length = 0;
        stopping = true;
        const n = client.attempts.length;
        client.emit('error', new Error('read ECONNRESET'));
        client.emit('close');
        clock.advance(120000);
        assert.equal(client.attempts.length, n, 'no retry while stopping');
        assert.deepEqual(log.lines, [['debug', 'mqtt read ECONNRESET (shutting down)']]);
    });

    test('end() cancels a pending retry', () => {
        const {clock, client} = setup();
        assert.equal(clock.pending(), 1);
        client.end(true, {}, () => {});
        assert.equal(clock.pending(), 0);
        assert.ok(client.ended);
        client.emit('close');
        assert.equal(clock.pending(), 0);
    });
});

describe('Outage', () => {
    test('clockTime is HH:MM', () => {
        assert.match(clockTime(Date.now()), /^\d\d:\d\d$/);
    });

    test('ok() without a failure says nothing', () => {
        const log = fakeLog();
        const outage = new Outage({log, label: 'rega'});
        assert.equal(outage.ok(), false);
        assert.equal(log.lines.length, 0);
        outage.fail('xml in rega response missing');
        assert.equal(outage.ok(), true);
        assert.match(log.lines[1][1], /^rega working again after 1 failed attempt since/);
    });
});

/** a free port, closed again */
async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

describe('broker connection with mqtt.js (B-11)', () => {
    test('a refused broker is retried with backoff and connected when it comes up', async () => {
        const port = await freePort();
        const log = fakeLog();
        const connect = backoffConnect({connect: mqtt.connect, log, minMs: 50, maxMs: 200});
        const client = connect(`mqtt://127.0.0.1:${port}`, {clientId: 'b11', connectTimeout: 2000});
        client.on('error', (err) => log.error('mqtt', err.message));
        const reconnects = [];
        client.on('reconnect', () => reconnects.push(Date.now()));
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.ok(reconnects.length >= 3 && reconnects.length <= 6, `${reconnects.length} retries in 0.7 s`);
        const gaps = reconnects.slice(1).map((t, i) => t - reconnects[i]);
        assert.ok(gaps.at(-1) >= 150, 'backed off towards the cap');
        assert.equal(log.lines.filter(([level]) => level === 'warn').length, 1);
        assert.equal(log.lines.filter(([level]) => level === 'error').length, 0);

        const broker = await Aedes.createBroker();
        const server = net.createServer(broker.handle);
        await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('not connected')), 3000);
                client.once('connect', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            assert.match(log.lines.filter(([level]) => level === 'info')[0][1], /^mqtt connected again after/);

            // a connection lost later: retried after 50 ms, and what was published meanwhile is delivered
            const received = [];
            broker.subscribe('b11/#', (packet, cb) => {
                received.push(String(packet.payload));
                cb();
            });
            const again = new Promise((resolve) => client.once('connect', resolve));
            client.stream.destroy();
            await new Promise((resolve) => client.once('close', resolve));
            client.publish('b11/x', 'while offline');
            await again;
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.deepEqual(received, ['while offline']);
        } finally {
            await new Promise((resolve) => client.end(true, {}, resolve));
            await new Promise((resolve) => server.close(resolve));
            await new Promise((resolve) => broker.close(resolve));
        }
    });
});
