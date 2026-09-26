/**
 * The CCU interface processes: names as the CCU uses them, ports (plain / TLS / local), protocol,
 * whether they want an init() subscription and answer pings.
 *
 * `localPort` is what the process itself listens on, as opposed to the familiar 2000/2001/2010/9292
 * which are lighttpd proxies in front of it. Running on the CCU we talk to the process directly:
 * one hop less, no XML over HTTP for BidCos (rfd speaks binrpc there), and no CCU authentication -
 * exactly what node-red-contrib-ccu does when it detects a local connection.
 */

import net from 'node:net';
import {initRetryDelay} from './rpc.js';

export const INTERFACES = {
    'BidCos-RF': {
        port: 2001,
        tlsPort: 42001,
        localPort: 32001,
        localBinrpc: true,
        protocol: 'xmlrpc',
        binrpc: true,
        init: true,
        ping: true,
        dutyCycle: true,
    },
    'BidCos-Wired': {
        port: 2000,
        tlsPort: 42000,
        localPort: 32000,
        localBinrpc: true,
        protocol: 'xmlrpc',
        binrpc: true,
        init: true,
        ping: true,
    },
    // https://github.com/eq-3/occu/issues/42 — HmIP-RF answers pings but events are rare, node-red used 600 s
    'HmIP-RF': {
        port: 2010,
        tlsPort: 42010,
        // hmipserver speaks no binrpc; "direct" here only means past the proxy
        localPort: 32010,
        protocol: 'xmlrpc',
        init: true,
        ping: true,
        pingTimeout: 600,
        dutyCycle: true,
    },
    VirtualDevices: {
        port: 9292,
        tlsPort: 49292,
        localPort: 39292,
        path: '/groups',
        protocol: 'xmlrpc',
        init: true,
        ping: false,
    },
    CUxD: {port: 8701, protocol: 'binrpc', init: true, ping: true},
};

export const INTERFACE_NAMES = Object.keys(INTERFACES);
export const DEFAULT_INTERFACES = ['BidCos-RF', 'HmIP-RF', 'VirtualDevices', 'BidCos-Wired'];

/** ReGa's script port: 8181 through lighttpd, 8183 is ReGaHSS itself (no authentication). */
export const REGA_PORT = 8181;
export const REGA_TLS_PORT = 48181;
export const REGA_LOCAL_PORT = 8183;

/**
 * The port the ReGa script interface is reached on.
 * @param {{tls?: boolean, local?: boolean}} [options]
 * @returns {number}
 */
export function regaPort({tls = false, local = false} = {}) {
    if (local) return REGA_LOCAL_PORT;
    return tls ? REGA_TLS_PORT : REGA_PORT;
}

/**
 * Parses the --interfaces option. Returns the list of names, or null for "auto".
 * @param {string} value
 * @returns {string[] | null}
 */
export function parseInterfaces(value) {
    const raw = String(value || '').trim();
    if (raw === '' || raw.toLowerCase() === 'auto') {
        return null;
    }
    const names = raw.split(/[\s,]+/).filter(Boolean);
    const lower = new Map(INTERFACE_NAMES.map((n) => [n.toLowerCase(), n]));
    return names.map((n) => {
        const name = lower.get(n.toLowerCase());
        if (!name) {
            throw new Error(`unknown interface "${n}" (known: ${INTERFACE_NAMES.join(', ')})`);
        }
        return name;
    });
}

/**
 * Connection parameters of an interface for the given CCU options.
 * @param {string} name
 * @param {{tls?: boolean, bidcosBinrpc?: boolean}} [options]
 * @returns {{name: string, protocol: 'xmlrpc' | 'binrpc', port: number, path?: string, init: boolean,
 *          ping: boolean, pingTimeout?: number, dutyCycle: boolean}}
 */
export function interfaceConfig(name, {tls = false, bidcosBinrpc = false, local = false} = {}) {
    const def = INTERFACES[name];
    if (!def) {
        throw new Error('unknown interface ' + name);
    }
    // local wins over tls: the process ports carry no TLS, and they need none on loopback
    const useLocal = local && Boolean(def.localPort);
    const binrpc =
        def.protocol === 'binrpc' || (useLocal && def.localBinrpc) || (def.binrpc && bidcosBinrpc && !tls && !useLocal);
    return {
        name,
        protocol: binrpc ? 'binrpc' : 'xmlrpc',
        port: useLocal ? def.localPort : tls && def.tlsPort ? def.tlsPort : def.port,
        path: def.path,
        init: def.init,
        ping: def.ping,
        pingTimeout: def.pingTimeout,
        dutyCycle: Boolean(def.dutyCycle),
    };
}

function portOpen(host, port, timeout) {
    return new Promise((resolve) => {
        const socket = net.connect({host, port});
        const done = (result) => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeout, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/**
 * Probes which interface ports answer on the CCU (--interfaces auto).
 * @param {string} host
 * @param {{tls?: boolean, local?: boolean, timeout?: number, connect?: Function, names?: string[]}} [options]
 * @returns {Promise<string[]>} interface names in table order (of `names`)
 */
export async function probeInterfaces(
    host,
    {tls = false, local = false, timeout = 2000, connect = portOpen, names = INTERFACE_NAMES} = {},
) {
    const found = [];
    for (const name of names) {
        const {port} = interfaceConfig(name, {tls, local});
        if (await connect(host, port, timeout)) {
            found.push(name);
        }
    }
    return found;
}

/**
 * Probes the interfaces `--interfaces auto` did not find at the start again, on the schedule of a
 * failed init (1, 2, 4, 8 s, then every 15 s), and hands each one that answers to `onFound` - once;
 * the others are probed on until they answer or `stop()` is called (B-1). An interface process that
 * comes up after hm2mqtt (openccu-lite's early start, a restart of hmipserver, a LAN gateway added
 * later) is picked up this way without a restart.
 * @param {string} host
 * @param {string[]} missing interface names
 * @param {object} o
 * @param {(name: string) => void} o.onFound
 * @param {boolean} [o.tls]
 * @param {boolean} [o.local]
 * @param {number} [o.timeout] ms per probe
 * @param {Function} [o.connect] for tests
 * @param {{setTimeout: Function, clearTimeout: Function}} [o.timers] for tests
 * @returns {{stop: () => void, missing: () => string[]}}
 */
export function watchInterfaces(
    host,
    missing,
    {onFound, tls = false, local = false, timeout = 2000, connect = portOpen, timers = {setTimeout, clearTimeout}},
) {
    let left = INTERFACE_NAMES.filter((name) => missing.includes(name));
    let rounds = 0;
    let timer = null;
    let stopped = false;
    const round = async () => {
        timer = null;
        const found = await probeInterfaces(host, {tls, local, timeout, connect, names: left});
        if (stopped) {
            return;
        }
        left = left.filter((name) => !found.includes(name));
        for (const name of found) {
            onFound(name);
        }
        schedule();
    };
    const schedule = () => {
        if (stopped || left.length === 0) {
            return;
        }
        rounds += 1;
        timer = timers.setTimeout(round, initRetryDelay(rounds));
        if (timer && typeof timer.unref === 'function') {
            timer.unref();
        }
    };
    schedule();
    return {
        stop() {
            stopped = true;
            if (timer) {
                timers.clearTimeout(timer);
                timer = null;
            }
        },
        missing: () => [...left],
    };
}

/**
 * Is this address the machine we run on?
 * @param {string} host
 * @returns {boolean}
 */
export function isLocalHost(host) {
    const value = String(host || '')
        .trim()
        .toLowerCase();
    return value === 'localhost' || value === '::1' || value === '[::1]' || /^127\./.test(value);
}

/**
 * Whether the CCU's interface processes can be reached directly, i.e. whether hm2mqtt runs on the
 * CCU itself. Probes the process ports instead of reading a lighttpd config the way
 * node-red-contrib-ccu does - that check looks for `"port" => 32001` in
 * /etc/lighttpd/conf.d/proxy.conf, which on firmware 3.8x is a one-line include, so it silently
 * stopped detecting anything while the ports themselves are all still there.
 *
 * On a loopback address where nothing answers yet, the processes may still be starting (a boot, or
 * openccu-lite's early start): with `waitMs` the probe is repeated on the init schedule (1, 2, 4,
 * 8 s, then every 15 s) until one answers or `waitMs` has passed (B-1); `onWait` is called once,
 * before the first repetition. When the CCU's usual ports answer instead (a tunnel, a simulator,
 * lighttpd's proxies without the processes behind them) it is not local mode and nothing waits.
 * @param {string} host
 * @param {{timeout?: number, connect?: Function, waitMs?: number, onWait?: Function,
 *          sleep?: (ms: number) => Promise<void>, now?: () => number}} [options]
 * @returns {Promise<boolean>}
 */
export async function detectLocal(
    host,
    {
        timeout = 500,
        connect = portOpen,
        waitMs = 0,
        onWait = () => {},
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now = Date.now,
    } = {},
) {
    if (!isLocalHost(host)) {
        return false;
    }
    const ports = INTERFACE_NAMES.map((name) => INTERFACES[name].localPort).filter(Boolean);
    const start = now();
    for (let attempt = 1; ; attempt += 1) {
        // concurrently: this runs at every startup, and closed-but-filtered ports would otherwise
        // stack their timeouts
        const results = await Promise.all([...ports, REGA_LOCAL_PORT].map((port) => connect(host, port, timeout)));
        if (results.some(Boolean)) {
            return true;
        }
        const delay = initRetryDelay(attempt);
        if (now() - start + delay > waitMs) {
            return false;
        }
        const usual = INTERFACE_NAMES.map((name) => INTERFACES[name].port).filter(Boolean);
        const proxied = await Promise.all([...usual, REGA_PORT].map((port) => connect(host, port, timeout)));
        if (proxied.some(Boolean)) {
            return false;
        }
        if (attempt === 1) {
            onWait();
        }
        await sleep(delay);
    }
}
