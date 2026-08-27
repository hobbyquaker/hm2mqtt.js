/**
 * The CCU interface processes: names as the CCU uses them, ports (plain / TLS), protocol,
 * whether they want an init() subscription and answer pings.
 */

import net from 'node:net';

export const INTERFACES = {
    'BidCos-RF': {
        port: 2001,
        tlsPort: 42001,
        protocol: 'xmlrpc',
        binrpc: true,
        init: true,
        ping: true,
        dutyCycle: true,
    },
    'BidCos-Wired': {port: 2000, tlsPort: 42000, protocol: 'xmlrpc', binrpc: true, init: true, ping: true},
    // https://github.com/eq-3/occu/issues/42 — HmIP-RF answers pings but events are rare, node-red used 600 s
    'HmIP-RF': {
        port: 2010,
        tlsPort: 42010,
        protocol: 'xmlrpc',
        init: true,
        ping: true,
        pingTimeout: 600,
        dutyCycle: true,
    },
    VirtualDevices: {port: 9292, tlsPort: 49292, path: '/groups', protocol: 'xmlrpc', init: true, ping: false},
    CUxD: {port: 8701, protocol: 'binrpc', init: true, ping: true},
};

export const INTERFACE_NAMES = Object.keys(INTERFACES);
export const DEFAULT_INTERFACES = ['BidCos-RF', 'HmIP-RF', 'VirtualDevices', 'BidCos-Wired'];

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
export function interfaceConfig(name, {tls = false, bidcosBinrpc = false} = {}) {
    const def = INTERFACES[name];
    if (!def) {
        throw new Error('unknown interface ' + name);
    }
    const binrpc = def.protocol === 'binrpc' || (def.binrpc && bidcosBinrpc && !tls);
    return {
        name,
        protocol: binrpc ? 'binrpc' : 'xmlrpc',
        port: tls && def.tlsPort ? def.tlsPort : def.port,
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
 * @param {{tls?: boolean, timeout?: number, connect?: Function}} [options]
 * @returns {Promise<string[]>} interface names in table order
 */
export async function probeInterfaces(host, {tls = false, timeout = 2000, connect = portOpen} = {}) {
    const found = [];
    for (const name of INTERFACE_NAMES) {
        const {port} = interfaceConfig(name, {tls});
        if (await connect(host, port, timeout)) {
            found.push(name);
        }
    }
    return found;
}
