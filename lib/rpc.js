/**
 * The RPC side of the CCU: one RpcConnection per interface process (client, init subscription,
 * ping/re-init, counters) and the shared callback servers (one per protocol) that route the
 * CCU's calls to the right connection.
 */

import {EventEmitter} from 'node:events';
import xmlrpcLib from 'homematic-xmlrpc';
import binrpcLib from 'binrpc';

export const METHODS = [
    'system.listMethods',
    'system.multicall',
    'event',
    'listDevices',
    'newDevices',
    'deleteDevices',
    'updateDevice',
    'replaceDevice',
    'readdedDevice',
    'setReadyConfig',
];

const TX_METHODS = new Set(['setValue', 'putParamset', 'activateLinkParamset']);
const INIT_RETRY_MS = 30000;
const DEINIT_TIMEOUT_MS = 2000;

/**
 * Derives the working/direction hints of an event batch (system.multicall) the way
 * node-red-contrib-ccu did: an actuator reports WORKING/DIRECTION together with LEVEL/STATE.
 * @param {Array<[string, string, string, *]>} events [initId, channel, datapoint, value]
 * @returns {{working?: boolean, direction?: number}}
 */
export function batchHints(events) {
    const hints = {};
    for (const [, , datapoint, value] of events) {
        if (datapoint === 'WORKING' || datapoint === 'WORKING_SLATS') {
            hints.working = value;
        } else if (datapoint === 'PROCESS') {
            hints.working = Boolean(value);
        } else if (datapoint === 'DIRECTION') {
            hints.direction = value;
        } else if (datapoint === 'ACTIVITY_STATE') {
            hints.direction = value === 3 ? 0 : value === 0 ? 3 : value;
        }
    }
    return hints;
}

/**
 * The callback servers the CCU talks to. One http (xmlrpc) and/or one binrpc server, started on
 * demand; calls are routed by their init id to the registered RpcConnection.
 */
export class RpcServers {
    /**
     * @param {object} o
     * @param {string} o.listenAddress
     * @param {string} [o.initAddress] address in the init url (default listenAddress)
     * @param {number} o.xmlrpcPort
     * @param {number} o.binrpcPort
     * @param {object} o.log
     * @param {{xmlrpc?: object, binrpc?: object}} [o.libs] for tests
     */
    constructor({listenAddress, initAddress, xmlrpcPort, binrpcPort, log, libs = {}}) {
        this.listenAddress = listenAddress;
        this.initAddress = initAddress || listenAddress;
        this.ports = {xmlrpc: xmlrpcPort, binrpc: binrpcPort};
        this.log = log;
        this.libs = {xmlrpc: xmlrpcLib, binrpc: binrpcLib, ...libs};
        this.servers = {};
        this.connections = new Map();
    }

    url(protocol) {
        return `${protocol === 'binrpc' ? 'xmlrpc_bin' : 'http'}://${this.initAddress}:${this.ports[protocol]}`;
    }

    register(initId, connection) {
        this.connections.set(initId, connection);
    }

    /** Starts the server of a protocol if it is not running yet. Resolves once it listens. */
    ensure(protocol) {
        if (this.servers[protocol]) {
            return this.servers[protocol];
        }
        const lib = this.libs[protocol];
        const options = {host: this.listenAddress, port: this.ports[protocol]};
        this.servers[protocol] = new Promise((resolve, reject) => {
            let server;
            const onListening = () => {
                this.log.info('rpc', protocol, 'server listening on', this.url(protocol));
                resolve(server);
            };
            server = lib.createServer(options, onListening);
            const inner = protocol === 'binrpc' ? server.server || server : server;
            inner.on('error', (err) => {
                this.log.error('rpc', protocol, 'server', err.message || err);
                delete this.servers[protocol];
                reject(err);
            });
            for (const method of METHODS) {
                server.on(method, (err, params, callback) => {
                    if (err) {
                        this.log.warn('rpc <', protocol, method, err.message || err);
                    }
                    this.route(method, params, callback);
                });
            }
            server.on('NotFound', (method, params) => {
                this.log.debug('rpc <', protocol, 'unknown method', method, JSON.stringify(params).slice(0, 200));
            });
        });
        return this.servers[protocol];
    }

    connectionFor(params) {
        const initId = Array.isArray(params) ? params[0] : undefined;
        const connection = this.connections.get(initId);
        if (!connection) {
            this.log.warn('rpc < call for unknown init id', String(initId));
        }
        return connection;
    }

    route(method, params, callback) {
        const done = (result) => {
            if (typeof callback === 'function') {
                callback(null, result);
            }
        };
        if (method === 'system.multicall') {
            done(this.multicall(Array.isArray(params) ? params[0] : []));
            return;
        }
        if (method === 'event') {
            const connection = this.connectionFor(params);
            if (connection) {
                connection.handleEvents([params], batchHints([params]));
            }
            done('');
            return;
        }
        const connection = this.connectionFor(params);
        if (!connection) {
            done(method === 'system.listMethods' ? METHODS : method === 'listDevices' ? [] : '');
            return;
        }
        connection.alive();
        switch (method) {
            case 'system.listMethods':
                done(METHODS);
                break;
            case 'listDevices': {
                const answer = connection.listDevices();
                this.log.debug('rpc >', connection.name, 'listDevices', answer.length, 'devices');
                done(answer);
                break;
            }
            case 'newDevices':
                connection.newDevices(Array.isArray(params[1]) ? params[1] : []);
                done('');
                break;
            case 'deleteDevices':
                connection.deleteDevices(Array.isArray(params[1]) ? params[1] : []);
                done('');
                break;
            default:
                this.log.debug('rpc <', connection.name, method);
                done('');
        }
    }

    multicall(calls) {
        const results = [];
        const events = [];
        if (!Array.isArray(calls)) {
            return results;
        }
        for (const call of calls) {
            if (!call || typeof call !== 'object') {
                continue;
            }
            if (call.methodName === 'event') {
                if (Array.isArray(call.params)) {
                    events.push(call.params);
                }
                results.push('');
            } else if (METHODS.includes(call.methodName)) {
                this.route(call.methodName, call.params, (_, res) => results.push(res));
            } else {
                this.log.debug('rpc < multicall: unknown method', call.methodName);
                results.push('');
            }
        }
        if (events.length > 0) {
            const byConnection = new Map();
            for (const event of events) {
                const connection = this.connectionFor(event);
                if (connection) {
                    if (!byConnection.has(connection)) {
                        byConnection.set(connection, []);
                    }
                    byConnection.get(connection).push(event);
                }
            }
            for (const [connection, list] of byConnection) {
                connection.handleEvents(list, batchHints(list));
            }
        }
        return results;
    }

    async close() {
        for (const protocol of Object.keys(this.servers)) {
            try {
                const server = await this.servers[protocol];
                await Promise.race([
                    Promise.resolve(server.close && server.close()),
                    new Promise((resolve) => setTimeout(resolve, DEINIT_TIMEOUT_MS)),
                ]);
                this.log.debug('rpc', protocol, 'server closed');
            } catch (err) {
                this.log.debug('rpc', protocol, 'server close', err.message || err);
            }
            delete this.servers[protocol];
        }
    }
}

/**
 * One interface process (BidCos-RF, HmIP-RF, ...): client, init subscription, ping/re-init,
 * rx/tx counters. Events: 'connected' (bool), 'event' ({channel, datapoint, value, working,
 * direction}), 'newDevices' (devices), 'deleteDevices' (addresses).
 */
export class RpcConnection extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.name interface name (BidCos-RF, ...)
     * @param {string} o.host CCU address
     * @param {'xmlrpc' | 'binrpc'} o.protocol
     * @param {number} o.port
     * @param {string} [o.path]
     * @param {boolean} [o.tls]
     * @param {boolean} [o.insecure]
     * @param {string} [o.username]
     * @param {string} [o.password]
     * @param {boolean} [o.init] subscribe with init()
     * @param {boolean} [o.ping] the interface answers ping
     * @param {number} [o.pingTimeout] seconds
     * @param {RpcServers} o.servers
     * @param {string} o.initId
     * @param {() => Array} [o.listDevices] answer for the CCU's listDevices()
     * @param {object} o.log
     * @param {{xmlrpc?: object, binrpc?: object}} [o.libs]
     * @param {object} [o.timers] {setTimeout, clearTimeout, now} for tests
     */
    constructor(o) {
        super();
        this.name = o.name;
        this.host = o.host;
        this.protocol = o.protocol;
        this.port = o.port;
        this.path = o.path;
        this.tls = Boolean(o.tls);
        this.insecure = Boolean(o.insecure);
        this.username = o.username;
        this.password = o.password;
        this.wantInit = o.init !== false;
        this.wantPing = Boolean(o.ping);
        this.pingTimeout = o.pingTimeout || 60;
        this.servers = o.servers;
        this.initId = o.initId;
        this.listDevicesAnswer = o.listDevices || (() => []);
        this.log = o.log;
        this.libs = {xmlrpc: xmlrpcLib, binrpc: binrpcLib, ...(o.libs || {})};
        this.timers = {setTimeout, clearTimeout, now: Date.now, ...(o.timers || {})};

        this.client = null;
        this.connected = false;
        this.initialized = false;
        this.stopped = false;
        this.lastEvent = 0;
        this.counters = {rx: 0, tx: 0};
        this.initTimer = null;
        this.pingTimer = null;
        this.lastInitError = null;
    }

    createClient() {
        const lib = this.libs[this.protocol];
        if (this.protocol === 'binrpc') {
            return lib.createClient({host: this.host, port: this.port});
        }
        const options = {};
        if (this.path) {
            options.url = `${this.tls ? 'https' : 'http'}://${this.host}:${this.port}${this.path}`;
        } else {
            options.host = this.host;
            options.port = this.port;
            options.path = '/';
        }
        if (this.username) {
            options.basic_auth = {user: this.username, pass: this.password || ''};
        }
        options.rejectUnauthorized = !this.insecure;
        return this.tls ? lib.createSecureClient(options) : lib.createClient(options);
    }

    /** Calls a method on the interface process. Rejects with an Error (faults included). */
    methodCall(method, params = []) {
        if (!this.client) {
            this.client = this.createClient();
        }
        if (TX_METHODS.has(method)) {
            this.counters.tx += 1;
        }
        this.log.debug('rpc >', this.name, method, JSON.stringify(params).slice(0, 500));
        return new Promise((resolve, reject) => {
            this.client.methodCall(method, params, (err, res) => {
                if (err) {
                    reject(err instanceof Error ? err : new Error(String(err.message || err)));
                } else if (res && typeof res === 'object' && res.faultCode !== undefined) {
                    reject(new Error(`${res.faultString || 'fault'} (${res.faultCode})`));
                } else {
                    this.log.debug('rpc <', this.name, method, JSON.stringify(res).slice(0, 500));
                    resolve(res);
                }
            });
        });
    }

    /** Connects: init subscription (retried every 30 s while it fails), ping supervision. */
    async start() {
        this.stopped = false;
        if (!this.wantInit) {
            try {
                await this.methodCall('system.listMethods');
                this.setConnected(true);
            } catch (err) {
                this.log.warn('rpc', this.name, 'not reachable:', err.message);
            }
            return;
        }
        await this.init();
    }

    async init() {
        if (this.stopped) {
            return;
        }
        this.timers.clearTimeout(this.initTimer);
        this.initTimer = null;
        try {
            const url = this.servers.url(this.protocol);
            await this.servers.ensure(this.protocol);
            this.servers.register(this.initId, this);
            this.lastEvent = this.timers.now();
            this.log.info('rpc', this.name, '> init', url, this.initId);
            await this.methodCall('init', [url, this.initId]);
            this.initialized = true;
            this.lastInitError = null;
            this.setConnected(true);
        } catch (err) {
            const msg = err.message || String(err);
            if (msg !== this.lastInitError) {
                this.log.warn('rpc', this.name, 'init failed:', msg, `- retrying every ${INIT_RETRY_MS / 1000} s`);
                this.lastInitError = msg;
            } else {
                this.log.debug('rpc', this.name, 'init failed:', msg);
            }
            this.setConnected(false);
            this.initTimer = this.timers.setTimeout(() => this.init(), INIT_RETRY_MS);
            return;
        }
        if (this.wantPing) {
            this.schedulePingCheck();
        }
    }

    schedulePingCheck() {
        this.timers.clearTimeout(this.pingTimer);
        this.pingTimer = this.timers.setTimeout(() => this.checkPing(), this.pingTimeout * 250);
    }

    /** node-red-contrib-ccu's rpcCheckInit: ping after timeout/2 without events, re-init after timeout. */
    async checkPing() {
        if (this.stopped) {
            return;
        }
        const elapsed = (this.timers.now() - this.lastEvent) / 1000;
        if (elapsed > this.pingTimeout) {
            this.log.warn('rpc', this.name, 'no event for', Math.round(elapsed), 's - re-init');
            this.setConnected(false);
            await this.init();
            return;
        }
        if (elapsed >= this.pingTimeout / 2) {
            try {
                await this.methodCall('ping', ['hm2mqtt']);
            } catch (err) {
                this.log.warn('rpc', this.name, 'ping failed:', err.message);
                this.setConnected(false);
            }
        }
        this.schedulePingCheck();
    }

    setConnected(connected) {
        connected = Boolean(connected);
        if (connected === this.connected) {
            return;
        }
        this.connected = connected;
        this.log.info('rpc', this.name, connected ? 'connected' : 'disconnected');
        this.emit('connected', connected);
    }

    /** Any incoming call from the CCU proves the subscription is alive. */
    alive() {
        this.lastEvent = this.timers.now();
        if (!this.connected && this.initialized) {
            this.setConnected(true);
        }
    }

    listDevices() {
        return this.listDevicesAnswer();
    }

    newDevices(devices) {
        this.log.debug('rpc <', this.name, 'newDevices', devices.length);
        this.emit('newDevices', devices);
    }

    deleteDevices(addresses) {
        this.log.debug('rpc <', this.name, 'deleteDevices', addresses.length);
        this.emit('deleteDevices', addresses);
    }

    /**
     * @param {Array<[string, string, string, *]>} events [initId, channel, datapoint, value]
     * @param {{working?: boolean, direction?: number}} hints
     */
    handleEvents(events, hints = {}) {
        this.alive();
        let counted = false;
        for (const [, channel, datapoint, value] of events) {
            if (typeof channel !== 'string' || typeof datapoint !== 'string') {
                continue;
            }
            if (datapoint === 'PONG' && channel.includes('CENTRAL')) {
                this.log.debug('rpc <', this.name, 'PONG', String(value));
                continue;
            }
            if (!counted) {
                this.counters.rx += 1;
                counted = true;
            }
            this.emit('event', {channel, datapoint, value, working: hints.working, direction: hints.direction});
        }
    }

    /** Unsubscribes (init with an empty id) and stops the timers. */
    async stop() {
        this.stopped = true;
        this.timers.clearTimeout(this.initTimer);
        this.timers.clearTimeout(this.pingTimer);
        if (this.initialized) {
            const url = this.servers.url(this.protocol);
            this.log.info('rpc', this.name, '> init', url, '(unsubscribe)');
            try {
                await Promise.race([
                    this.methodCall('init', [url, '']),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DEINIT_TIMEOUT_MS)),
                ]);
            } catch (err) {
                this.log.debug('rpc', this.name, 'unsubscribe failed:', err.message);
            }
            this.initialized = false;
        }
        this.setConnected(false);
    }
}
