/**
 * The broker connection's retries and their log (B-11). mqtt.js retries a lost or failed
 * connection at a fixed period and mqtt-interfaces-core logs every `error` event at error level:
 * a broker that is not reachable filled the journal with a line every few seconds (thousands per
 * boot on an SD card). Wrapped around the core's `mqttConnect`:
 *
 * - retries back off: 1 s, doubling to 60 s, back to 1 s once connected;
 * - the client's `error` events are logged here instead (`Outage`): the first failure at warn, the
 *   same one again at debug, a summary every ten minutes, one info line when connected again;
 * - while hm2mqtt shuts down a broken connection is expected (at a reboot the broker on the same
 *   system may stop first, B-3): debug, and no retry.
 */

import {Outage} from './outage.js';

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60000;

/**
 * @param {object} o
 * @param {Function} o.connect mqtt.js' `connect(url, options)` (the core's default)
 * @param {object | (() => object)} o.log
 * @param {() => boolean} [o.stopping] whether hm2mqtt is shutting down
 * @param {{setTimeout: Function, clearTimeout: Function}} [o.timers] for tests
 * @param {() => number} [o.now] for tests
 * @param {number} [o.minMs]
 * @param {number} [o.maxMs]
 * @param {number} [o.summaryMs]
 * @returns {(url: string, options: object) => object} a `connect` with the same signature
 */
export function backoffConnect({
    connect,
    log,
    stopping = () => false,
    timers = {setTimeout, clearTimeout},
    now = Date.now,
    minMs = BACKOFF_MIN_MS,
    maxMs = BACKOFF_MAX_MS,
    summaryMs,
}) {
    const getLog = typeof log === 'function' ? log : () => log;
    return (url, options) => {
        // mqtt.js' own retry is a fixed interval; the retries are ours
        const client = connect(url, {...options, reconnectPeriod: 0});
        const outage = new Outage({log: getLog, label: 'mqtt', now, summaryMs});
        let delay = minMs;
        let timer = null;
        let ended = false;
        const quiet = () => ended || stopping();

        const emit = client.emit;
        client.emit = function (event, ...args) {
            if (event !== 'error') {
                return emit.call(this, event, ...args);
            }
            // the error is logged here and not passed on: the core's listener would log every one at error level
            const err = args[0];
            const message = (err && err.message) || String(err);
            if (quiet()) {
                getLog().debug('mqtt', message, '(shutting down)');
            } else {
                outage.fail(message, `retrying, then less often (at most every ${maxMs / 1000} s)`);
            }
            return true;
        };

        client.on('connect', () => {
            delay = minMs;
            outage.ok('connected again');
        });

        client.on('close', () => {
            if (quiet() || timer) {
                return;
            }
            const wait = delay;
            delay = Math.min(delay * 2, maxMs);
            getLog().debug('mqtt reconnecting in', wait / 1000, 's');
            timer = timers.setTimeout(() => {
                timer = null;
                if (quiet()) {
                    return;
                }
                client.emit('reconnect');
                client.connect();
            }, wait);
        });

        const end = client.end;
        client.end = function (...args) {
            ended = true;
            if (timer) {
                timers.clearTimeout(timer);
                timer = null;
            }
            return end.apply(this, args);
        };
        return client;
    };
}
