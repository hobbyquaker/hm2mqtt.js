/**
 * openccu-lite through occulite-client: the connection that has no callback server.
 *
 * - `LiteHub` owns one occulite-client connection and keeps it: it connects, retries while the
 *   system is not there, and connects afresh when the credential was refused (a new pairing writes
 *   a new credential file, which the next attempt reads).
 * - `LiteConnection` is one interface of it with the surface of lib/rpc.js's `RpcConnection`
 *   (`methodCall`, `connected`, `counters`, the `connected`/`event`/`newDevices`/`deleteDevices`
 *   events), so index.js drives both paths with the same code.
 * - `LiteNames` is names, rooms and functions from the system's metadata with the surface of
 *   lib/rega.js's `RegaSync`. On the system itself it runs on a names-only connection with the
 *   system's local token; off it on the same connection as the devices.
 * - The credential of a paired installation lives in `<state>/occulite.json` (0600).
 */

import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {MetaCopy, OccuLite} from 'occulite-client';
import {nodeAuth, nodeTransport, pair as occulitePair, probe as occuliteProbe} from 'occulite-client/node';
import {batchHints, TX_METHODS} from './rpc.js';
import {indexNames, resolveAddress} from './names.js';

/** the paired credential, in the state directory */
export const CREDENTIAL_FILE = 'occulite.json';
/** connect attempts while the system is not there: 1, 2, 4, 8, then every 15 s */
export const RETRY_SCHEDULE_MS = [1000, 2000, 4000, 8000, 15000];
/** a metadata change the copy cannot apply in place makes the client read the snapshot again;
 *  no event follows that read, so the names are derived once more after it */
const META_SETTLE_MS = [50, 1500];
const CALL_LOG_CHARS = 500;

/** Whether a file exists and may be executed. */
export function isExecutable(file) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Whether this host is an openccu-lite system: a `LITE=` line in /VERSION, or occulited - the
 * rule of the addon's service script, RedMatic and the addon handbook.
 * @param {{read?: (file: string) => string, executable?: (file: string) => boolean}} [io]
 * @returns {boolean}
 */
export function isLiteSystem({read = (file) => fs.readFileSync(file, 'utf8'), executable = isExecutable} = {}) {
    try {
        if (/^LITE=/m.test(read('/VERSION'))) {
            return true;
        }
    } catch {
        // no /VERSION: not a CCU firmware at all, or a container
    }
    return executable('/usr/bin/occulited');
}

/**
 * The paired credential: `{url, token, fingerprint256}`, or undefined when there is none.
 * @param {string} stateDir
 * @returns {{url?: string, token: string, fingerprint256?: string} | undefined}
 */
export function readCredential(stateDir) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(stateDir, CREDENTIAL_FILE), 'utf8'));
        return data && typeof data.token === 'string' && data.token !== '' ? data : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Stores the paired credential with mode 0600, through a temporary file and a rename.
 * @param {string} stateDir
 * @param {{url: string, token: string, fingerprint256?: string}} credential
 * @returns {string} the file
 */
export function writeCredential(stateDir, {url, token, fingerprint256}) {
    fs.mkdirSync(stateDir, {recursive: true});
    const file = path.join(stateDir, CREDENTIAL_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({url, token, fingerprint256: fingerprint256 || ''}, null, 2) + '\n', {
        mode: 0o600,
    });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return file;
}

/**
 * What the configured address is, and so which connection hm2mqtt makes:
 * - `ccu`: a CCU3, OpenCCU or RaspberryMatic - callbacks and ReGa, as always (`redetect` when
 *   nothing answered: something may come up there later; a system that does not answer is never
 *   taken for a CCU for good);
 * - `on-system`: openccu-lite on this host (the address is the loopback) - the interface processes
 *   over the loopback as on a CCU, the names from the metadata API with the system's local token;
 * - `remote`: an openccu-lite elsewhere, or asked for with `openccu-lite` - everything through
 *   occulite-client (`url` is where it answered, after a redirect to https).
 * @param {object} o
 * @param {'auto' | 'ccu' | 'openccu-lite'} [o.backend]
 * @param {string} o.url http[s]://<address>
 * @param {boolean} o.loopback the address is this host
 * @param {() => boolean} [o.isLite]
 * @param {Function} [o.probe] occulite-client's probe(), for tests
 * @param {number} [o.timeout] ms
 * @returns {Promise<{kind: 'ccu' | 'on-system' | 'remote', url?: string, redetect?: boolean, reason?: string}>}
 */
export async function chooseBackend({
    backend = 'auto',
    url,
    loopback,
    isLite = isLiteSystem,
    probe = occuliteProbe,
    timeout = 5000,
}) {
    if (backend === 'ccu') {
        return {kind: 'ccu'};
    }
    if (backend === 'auto' && loopback && isLite()) {
        // no question to ask: at an early start the system's web server may not answer yet
        return {kind: 'on-system'};
    }
    const found = await probe(url, {timeout});
    if (backend === 'openccu-lite') {
        // asked for: whatever answered (or nothing yet), connect and keep trying
        return {kind: 'remote', url: found.kind === 'openccu-lite' ? found.url : url, reason: found.reason};
    }
    if (found.kind === 'openccu-lite') {
        return loopback ? {kind: 'on-system'} : {kind: 'remote', url: found.url};
    }
    if (found.kind === 'ccu') {
        return {kind: 'ccu'};
    }
    return {kind: 'ccu', redetect: true, reason: found.reason};
}

/**
 * The credential and the url of a remote openccu-lite: --meta-token, else the paired credential;
 * --meta-url, else where the system was paired, else where it answered.
 * @param {{metaToken?: string, metaUrl?: string, stateDir: string, fallbackUrl: string}} o
 * @returns {{credential?: {token: string, fingerprint256?: string}, url: string}}
 */
export function remoteSetup({metaToken, metaUrl, stateDir, fallbackUrl}) {
    const stored = readCredential(stateDir);
    return {
        credential: metaToken ? {token: metaToken} : stored,
        url: metaUrl || (stored && stored.url) || fallbackUrl,
    };
}

/**
 * The credential for each connect attempt: --meta-token, else the paired token read again - so a
 * pairing made while hm2mqtt runs is picked up without a restart.
 * @param {{metaToken?: string, stateDir: string}} o
 * @returns {() => {token: string}}
 */
export function remoteAuth({metaToken, stateDir}) {
    return () => ({token: metaToken || (readCredential(stateDir) || {}).token || ''});
}

/**
 * The credential for the names on the system itself: --meta-token, else the system's local token
 * (read-only, `meta:read`: names only).
 * @param {{metaToken?: string}} o
 * @returns {() => object}
 */
export function systemAuth({metaToken}) {
    return () => (metaToken ? {token: metaToken} : {local: true});
}

/**
 * What to trust of a remote system's certificate: the fingerprint pinned at pairing (over https),
 * else anything with --ccu-insecure, else what Node trusts.
 * @param {{fingerprint256?: string, url: string, insecure?: boolean}} o
 */
export function remoteTrust({fingerprint256, url, insecure}) {
    if (fingerprint256 && url.startsWith('https:')) {
        return {fingerprint256};
    }
    return insecure ? {insecure: true} : undefined;
}

/**
 * Probes an address that did not answer at start, every `intervalMs`, until something answers;
 * `onLite` when it is openccu-lite. The CCU connection was the fallback meanwhile.
 * @param {object} o
 * @param {string} o.url
 * @param {number} o.intervalMs
 * @param {() => void} o.onLite
 * @param {object} o.log
 * @param {Function} [o.probe] for tests
 * @returns {{stop: () => void}}
 */
export function watchForLite({url, intervalMs, onLite, log, probe = occuliteProbe}) {
    const timer = setInterval(async () => {
        let found;
        try {
            found = await probe(url, {timeout: 5000});
        } catch (err) {
            log.debug('re-detection failed:', err.message);
            return;
        }
        if (!found.reachable) {
            return;
        }
        // something answers now - whatever it is, this question is settled
        clearInterval(timer);
        if (found.kind !== 'openccu-lite') {
            log.debug('no openccu-lite on', url, '- staying with the CCU connection');
            return;
        }
        onLite();
    }, intervalMs);
    timer.unref();
    return {stop: () => clearInterval(timer)};
}

/** `482719` -> `482 719`: easier to compare with the code on the system's Status page */
export function spacedCode(code) {
    return String(code).replace(/^(\d{3})(\d{3})$/, '$1 $2');
}

/**
 * Pairs with the system and stores the credential: the code is logged, an administrator approves
 * it on the system's Status page, the token and the certificate's fingerprint go into the state
 * directory.
 * @param {object} o
 * @param {string} o.url the system, e.g. `https://192.168.1.20`
 * @param {string} o.stateDir
 * @param {object} o.log
 * @param {string} o.appVersion
 * @param {string} o.instance this installation, e.g. the hostname
 * @param {boolean} [o.administer] ask for every method (the rpc topics), not only operating devices
 * @param {number} [o.timeout] ms
 * @param {Function} [o.pair] occulite-client's pair(), for tests
 * @returns {Promise<{url: string, token: string, fingerprint256: string, file: string}>}
 */
export async function pairAndStore({
    url,
    stateDir,
    log,
    appVersion,
    instance,
    administer,
    timeout,
    pair = occulitePair,
}) {
    const host = new URL(url).host;
    log.info('pairing with', url, '- waiting for the approval on the system');
    const paired = await pair({
        url,
        app: 'hm2mqtt.js',
        appVersion,
        instance,
        access: {devices: administer ? 'administer' : 'operate', names: 'read'},
        purpose: {
            devices: 'publishes the values of the devices to MQTT and switches them on MQTT commands',
            names: 'uses the names, rooms and functions in topics and payloads',
        },
        timeout,
        onCode: (code) =>
            log.info(`Pairing code ${spacedCode(code)} - approve hm2mqtt.js on ${host} on the system's Status page`),
    });
    const file = writeCredential(stateDir, {url, token: paired.token, fingerprint256: paired.fingerprint256});
    log.info('paired: access', JSON.stringify(paired.access || {}), '- the credential is in', file);
    return {url, token: paired.token, fingerprint256: paired.fingerprint256, file};
}

/**
 * A value for lite-rpc's JSON: lib/cast.js wraps a FLOAT as `{explicitDouble}` for the XML-RPC
 * serializer; here an integral one becomes the typed `{double}` when the system takes it, any other
 * a plain number. Objects (a whole paramset) are converted per entry.
 * @param {*} value
 * @param {boolean} jsonDouble the system's `json_double` capability
 */
export function toWire(value, jsonDouble) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return value;
    }
    if (typeof value.explicitDouble === 'number' && Object.keys(value).length === 1) {
        const n = value.explicitDouble;
        return jsonDouble && Number.isInteger(n) ? {double: n} : n;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v, jsonDouble)]));
}

/** The address of a ref of an interface: `HmIP-RF.0001D3C99C7D4B:3` -> `0001D3C99C7D4B:3`. */
export function addressOf(ref) {
    const dot = typeof ref === 'string' ? ref.indexOf('.') : -1;
    return dot > 0 ? ref.slice(dot + 1) : '';
}

/** the lite-rpc tiers: a scope implies the ones before it */
const RPC_TIERS = ['rpc:read', 'rpc:operate', 'rpc:configure', 'rpc:admin'];

/**
 * The scopes with the ones they imply. openccu-lite names a token's highest lite-rpc tier only - a
 * paired token at *operate* has `rpc:operate` and no `rpc:read` in its list, yet may read - and
 * occulite-client 0.3.0 looks for `rpc:read` literally, so it would run such a token as names only.
 * @param {string[]} scopes
 * @returns {string[]}
 */
export function impliedScopes(scopes) {
    const out = new Set(scopes);
    const top = Math.max(...scopes.map((scope) => RPC_TIERS.indexOf(scope)));
    for (let i = 0; i < top; i += 1) {
        out.add(RPC_TIERS[i]);
    }
    return [...out];
}

/**
 * A transport that completes the scopes of the auth state (impliedScopes) and is otherwise the one given.
 * @param {{request: Function, stream: Function}} tx
 */
export function scopeTransport(tx) {
    return {
        async request(method, url, headers, body, signal) {
            const r = await tx.request(method, url, headers, body, signal);
            if (r.status !== 200 || !/\/api\/auth\/v1\/state$/.test(url)) {
                return r;
            }
            try {
                const state = JSON.parse(r.body);
                if (Array.isArray(state.scopes)) {
                    return {...r, body: JSON.stringify({...state, scopes: impliedScopes(state.scopes)})};
                }
            } catch {
                // not JSON: the client says so itself
            }
            return r;
        },
        stream: (url, headers, signal) => tx.stream(url, headers, signal),
    };
}

/**
 * occulite-client/node's createClient with scopeTransport in between.
 * @param {object} o createClient's options: url, auth (a NodeAuth), trust, localTokenFile, ...
 */
export function createLiteClient({auth, trust, localTokenFile, addonTokenDir, env, ...rest}) {
    return new OccuLite({
        ...rest,
        auth: nodeAuth(auth, {localTokenFile, addonTokenDir, env}),
        transport: scopeTransport(nodeTransport(trust)),
    });
}

/** occulite-client's log lines in ours; its info lines are details for us */
function clientLog(log) {
    return {
        debug: (...a) => log.debug(...a),
        info: (...a) => log.debug(...a),
        warn: (...a) => log.debug(...a),
        error: (...a) => log.warn(...a),
    };
}

/**
 * One occulite-client connection, kept up. Events: `ready` (box) after every successful connect,
 * `status` (state), `interface` ({interface, state}), `values` (entries of box.values, after a
 * connect and after a resync), `stored` (a swept value event), `meta`.
 */
export class LiteHub extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.url
     * @param {() => object} o.auth the credential for the next attempt: `{token}`, `{local: true}`, ...
     * @param {object} [o.trust] {fingerprint256} | {ca} | {insecure: true}
     * @param {boolean} [o.namesOnly] names and rooms only: no devices, no values
     * @param {object} o.log
     * @param {Function} [o.createClient] createLiteClient, or a stand-in for tests
     * @param {number[]} [o.schedule] ms between attempts
     * @param {object} [o.clientOptions] passed on (timeouts, sweep pace) - for tests
     */
    constructor({url, auth, trust, namesOnly = false, log, createClient = createLiteClient, schedule, clientOptions}) {
        super();
        this.url = url;
        this.auth = auth;
        this.trust = trust;
        this.namesOnly = namesOnly;
        this.log = log;
        this.createClient = createClient;
        this.schedule = schedule || RETRY_SCHEDULE_MS;
        this.clientOptions = clientOptions || {};
        /** the connected client; undefined until the first connect and between two */
        this.box = undefined;
        /** the client being connected (its events count already: the device lists come before ready) */
        this.current = undefined;
        this.connections = new Map();
        this.lastError = undefined;
        this.stopped = false;
        this.running = null;
        this.sleepTimer = null;
        this.wake = null;
        let first;
        /** resolves with true or false once the first attempt is decided */
        this.firstAttempt = new Promise((resolve) => (first = resolve));
        this.decideFirst = first;
    }

    /** One interface, created on first use. */
    connection(name) {
        if (!this.connections.has(name)) {
            this.connections.set(name, new LiteConnection({name, hub: this, log: this.log}));
        }
        return this.connections.get(name);
    }

    /** The interfaces the system runs (names), once connected. */
    interfaceNames() {
        return this.box ? this.box.interfaces.map((i) => i.name) : [];
    }

    /** Whether an interface is up: the connection is ready and the system says it runs. */
    isRunning(name) {
        const box = this.box;
        return Boolean(box && box.status === 'ready' && box.interfaces.some((i) => i.name === name && i.running));
    }

    /** Connects; resolves once connected. Retries until connected or stopped. */
    start() {
        this.stopped = false;
        if (this.box) {
            // connected: the connection follows the system by itself
            return Promise.resolve(this.box);
        }
        this.running = this.running || this.run();
        return this.running;
    }

    async run() {
        for (let attempt = 0; !this.stopped; attempt += 1) {
            const box = this.createClient({
                url: this.url,
                auth: this.auth(),
                trust: this.trust,
                ...(this.namesOnly ? {values: false, devices: false} : {values: 'all'}),
                log: clientLog(this.log),
                ...this.clientOptions,
            });
            this.current = box;
            this.attach(box);
            try {
                await box.ready();
                if (this.stopped) {
                    break;
                }
                this.box = box;
                this.lastError = undefined;
                this.decideFirst(true);
                this.log.info(
                    'occulite: connected to',
                    this.url,
                    `(${box.info.implementation || 'openccu-lite'}, ${box.credential} credential, ${box.mode === 'full' ? 'devices and names' : 'names only'})`,
                );
                this.updateConnections();
                this.emit('ready', box);
                if (!this.namesOnly) {
                    this.emit('values', box.values.entries());
                }
                this.running = null;
                return box;
            } catch (err) {
                box.close();
                if (this.current === box) {
                    this.current = undefined;
                }
                if (this.stopped) {
                    break;
                }
                this.failed(err);
                this.decideFirst(false);
                await this.sleep(this.schedule[Math.min(attempt, this.schedule.length - 1)]);
            }
        }
        this.running = null;
        return undefined;
    }

    /** One line per kind of failure, the repetitions at debug. */
    failed(err) {
        const message = err.message || String(err);
        const repeated = this.lastError && this.lastError.message === message;
        this.lastError = err;
        if (repeated) {
            this.log.debug('occulite:', this.url, 'still not connected:', message);
        } else if (err.code === 'unauthenticated' || err.code === 'forbidden') {
            this.log.error('occulite:', this.url, 'refused the credential:', message);
        } else {
            this.log.warn('occulite: cannot connect to', this.url, '-', message, '- retrying');
        }
    }

    sleep(ms) {
        return new Promise((resolve) => {
            this.wake = resolve;
            this.sleepTimer = setTimeout(resolve, ms);
        });
    }

    attach(box) {
        const mine = (fn) => (arg) => {
            if (this.current === box) {
                fn(arg);
            }
        };
        box.on(
            'status',
            mine(({state}) => this.onStatus(box, state)),
        );
        box.on(
            'value',
            mine((ev) => {
                if (ev.source === 'sweep') {
                    this.emit('stored', ev);
                } else if (!ev.batch) {
                    this.deliver([ev]);
                }
            }),
        );
        box.on(
            'batch',
            mine((events) => this.deliver(events)),
        );
        box.on(
            'devices',
            mine((ev) => this.onDevices(ev)),
        );
        box.on(
            'interface',
            mine((ev) => {
                const connection = this.connections.get(ev.interface);
                if (connection) {
                    connection.update();
                }
                this.emit('interface', ev);
            }),
        );
        box.on(
            'resync',
            mine(({reason}) => {
                this.log.info('occulite: values read again after', reason, '- republishing');
                this.emit('values', box.values.entries());
            }),
        );
        box.on(
            'meta',
            mine((ev) => this.emit('meta', ev)),
        );
        box.on(
            'sweep',
            mine((r) =>
                this.log.info(
                    'occulite: read',
                    r.channels,
                    'channels for the values the system does not keep:',
                    r.values,
                    'values,',
                    r.failed,
                    'failed,',
                    r.seconds,
                    's',
                ),
            ),
        );
    }

    onStatus(box, state) {
        this.emit('status', state);
        if (this.box === box) {
            this.updateConnections();
        }
        if (state === 'offline' && this.box === box && !this.stopped) {
            // the credential was refused: a new pairing (or token) is read by the next attempt
            this.log.error('occulite:', this.url, 'refused the credential - connecting afresh');
            this.box = undefined;
            this.current = undefined;
            box.close();
            this.updateConnections();
            this.lastError = new Error('the credential was refused');
            this.start();
        }
    }

    /** Value events of one interface process call (or one event), per interface. */
    deliver(events) {
        const byInterface = new Map();
        for (const ev of events) {
            if (!byInterface.has(ev.interface)) {
                byInterface.set(ev.interface, []);
            }
            byInterface.get(ev.interface).push(ev);
        }
        for (const [name, list] of byInterface) {
            const connection = this.connections.get(name);
            if (connection) {
                connection.handleEvents(list);
            }
        }
    }

    onDevices(ev) {
        const connection = this.connections.get(ev.interface);
        if (!connection) {
            return;
        }
        if (ev.kind === 'new' && Array.isArray(ev.descriptions)) {
            connection.newDevices(ev.descriptions);
        } else if (ev.kind === 'deleted') {
            connection.deleteDevices(ev.refs.map(addressOf));
        } else {
            this.log.debug('occulite:', ev.interface, ev.kind, ev.refs.join(', '));
        }
    }

    updateConnections() {
        for (const connection of this.connections.values()) {
            connection.update();
        }
    }

    /** Closes the connection; no attempt follows. */
    stop() {
        this.stopped = true;
        clearTimeout(this.sleepTimer);
        if (this.wake) {
            this.wake();
        }
        for (const box of new Set([this.box, this.current])) {
            if (box) {
                box.close();
            }
        }
        this.box = undefined;
        this.current = undefined;
        this.decideFirst(false);
        for (const connection of this.connections.values()) {
            connection.setConnected(false);
        }
    }
}

/**
 * One interface of a LiteHub, shaped like RpcConnection. Events: 'connected' (bool), 'event'
 * ({channel, datapoint, value, working, direction}), 'newDevices' (devices), 'deleteDevices' (addresses).
 */
export class LiteConnection extends EventEmitter {
    constructor({name, hub, log}) {
        super();
        this.name = name;
        this.hub = hub;
        this.log = log;
        this.connected = false;
        this.stopped = true;
        this.counters = {rx: 0, tx: 0};
    }

    /** A method of the interface process, through lite-rpc. The token's access decides what may be called. */
    async methodCall(method, params = []) {
        const box = this.hub.box;
        if (!box) {
            throw new Error(`${this.name}: not connected to openccu-lite`);
        }
        if (TX_METHODS.has(method)) {
            this.counters.tx += 1;
        }
        const jsonDouble = Boolean(box.capabilities && box.capabilities.json_double);
        this.log.debug('rpc >', this.name, method, JSON.stringify(params).slice(0, CALL_LOG_CHARS));
        const result = await box.call(
            this.name,
            method,
            params.map((p) => toWire(p, jsonDouble)),
        );
        this.log.debug(
            'rpc <',
            this.name,
            method,
            JSON.stringify(result === undefined ? null : result).slice(0, CALL_LOG_CHARS),
        );
        return result;
    }

    /**
     * No init: the stream is the subscription. The devices the system announced before this
     * interface was used come first, then the connected state - while the system runs the interface.
     */
    async start() {
        this.stopped = false;
        const box = this.hub.box;
        const devices = box
            ? [...box.devices].filter(([ref]) => ref.startsWith(this.name + '.')).map(([, d]) => d)
            : [];
        if (devices.length > 0) {
            this.newDevices(devices);
        }
        this.update();
    }

    async stop() {
        this.stopped = true;
        this.setConnected(false);
    }

    update() {
        this.setConnected(!this.stopped && this.hub.isRunning(this.name));
    }

    setConnected(connected) {
        connected = Boolean(connected);
        if (connected === this.connected) {
            return;
        }
        this.connected = connected;
        this.log.info('rpc', this.name, connected ? 'connected' : 'disconnected', '(occulite)');
        this.emit('connected', connected);
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
     * The value events of one call of the interface process (a system.multicall, or one event).
     * @param {Array<{address: string, key: string, value: *}>} events occulite-client's value events
     */
    handleEvents(events) {
        const tuples = events.map((ev) => [this.name, ev.address, ev.key, ev.value]);
        const hints = batchHints(tuples);
        let counted = false;
        for (const [, channel, datapoint, value] of tuples) {
            if (datapoint === 'PONG' && channel.includes('CENTRAL')) {
                continue;
            }
            if (!counted) {
                this.counters.rx += 1;
                counted = true;
            }
            this.emit('event', {channel, datapoint, value, working: hints.working, direction: hints.direction});
        }
    }
}

/**
 * Names, rooms and functions from openccu-lite's metadata, with RegaSync's surface - what index.js,
 * the topic templates and the payloads read. Only the room an object is in is named, not the rooms
 * above it: that is what a CCU reported, and `${room}` in a topic must not become two levels.
 * System variables and programs do not exist here.
 */
export class LiteNames extends EventEmitter {
    /**
     * @param {object} o
     * @param {LiteHub} o.hub
     * @param {object} [o.metadata] Metadata (to tell an address from a name on set topics)
     * @param {string} [o.stateDir]
     * @param {Object<string, string>} [o.nameFile] {address: name} overriding the system's names
     * @param {object} o.log
     */
    constructor({hub, metadata, stateDir, nameFile, log}) {
        super();
        this.label = 'occulite';
        this.hub = hub;
        this.metadata = metadata;
        this.stateDir = stateDir;
        this.nameFile = nameFile || {};
        this.log = log;
        /** the names of the last run, until the system answers */
        this.saved = new MetaCopy();
        this.channelNames = {};
        this.addresses = {};
        this.channelRooms = {};
        this.channelFunctions = {};
        this.sysvars = {};
        this.programs = {};
        this.timers = [];
        this.stopped = false;
        this.online = false;
        this.onReady = () => {
            this.online = true;
            this.refresh(true);
            this.emit('polled');
        };
        this.onStatus = (state) => {
            if (state === 'ready' && !this.online) {
                this.online = true;
                this.emit('polled');
            } else if (state !== 'ready' && state !== 'connecting' && this.online) {
                this.online = false;
                this.emitError(new Error(`connection ${state}`));
            }
        };
        this.onMeta = () => this.scheduleRefresh();
        hub.on('ready', this.onReady);
        hub.on('status', this.onStatus);
        hub.on('meta', this.onMeta);
    }

    file() {
        return this.stateDir ? path.join(this.stateDir, 'meta.json') : null;
    }

    load() {
        const file = this.file();
        if (!file) {
            return;
        }
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            this.saved.load({format: data.format || 1, revision: Number(data.revision) || 0, ...data});
            this.rebuild();
            this.log.info('loaded', Object.keys(this.channelNames).length, 'names from', file);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.log.warn('cannot read', file, '-', err.message);
            }
        }
    }

    save() {
        const file = this.file();
        if (!file) {
            return;
        }
        try {
            fs.mkdirSync(this.stateDir, {recursive: true});
            fs.writeFileSync(file, JSON.stringify(this.copy().snapshot()));
        } catch (err) {
            this.log.warn('cannot save', file, '-', err.message);
        }
    }

    /** the live copy once connected, else the names of the last run */
    copy() {
        return this.hub.box ? this.hub.box.meta : this.saved;
    }

    channelName(address) {
        return this.channelNames[address];
    }

    channelAddress(nameOrAddress, devices = false) {
        return resolveAddress(this, nameOrAddress, devices);
    }

    rooms(address) {
        return this.channelRooms[address];
    }

    functions(address) {
        return this.channelFunctions[address];
    }

    hasVariable() {
        return false;
    }

    hasProgram() {
        return false;
    }

    /** The address is fixed by the connection's url. */
    setHost() {}

    /** Derives names, rooms and functions from the copy; true when anything changed. */
    rebuild() {
        const before = JSON.stringify([this.channelNames, this.channelRooms, this.channelFunctions]);
        const meta = this.copy();
        const channelNames = {};
        const channelRooms = {};
        const channelFunctions = {};
        for (const [ref, object] of Object.entries(meta.doc.objects || {})) {
            const address = addressOf(ref);
            if (!address || !object || typeof object !== 'object') {
                continue;
            }
            if (typeof object.name === 'string' && object.name !== '') {
                channelNames[address] = object.name;
            }
            const {rooms, functions} = meta.membershipNames(ref, {inherit: false});
            if (rooms.length > 0) {
                channelRooms[address] = rooms;
            }
            if (functions.length > 0) {
                channelFunctions[address] = functions;
            }
        }
        this.channelNames = channelNames;
        this.channelRooms = channelRooms;
        this.channelFunctions = channelFunctions;
        this.addresses = indexNames(this.channelNames, this.nameFile);
        return JSON.stringify([this.channelNames, this.channelRooms, this.channelFunctions]) !== before;
    }

    /** Rebuilds; emits 'names' when anything changed (or always, with `announce`). */
    refresh(announce = false) {
        const changed = this.rebuild();
        if (changed || announce) {
            this.save();
            const meta = this.copy();
            this.log.info(
                'occulite:',
                Object.keys(this.channelNames).length,
                'names,',
                meta.rooms().length,
                'rooms,',
                meta.functions().length,
                'functions (revision ' + meta.revision + ')',
            );
            this.emit('names');
        }
    }

    scheduleRefresh() {
        if (this.stopped) {
            return;
        }
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers = META_SETTLE_MS.map((ms) => setTimeout(() => this.refresh(), ms));
    }

    /**
     * Connects (once; the connection follows the changes by itself) and announces the names. Throws
     * when the first attempt failed - the connection keeps trying and announces them when it succeeds.
     */
    async syncNames() {
        this.stopped = false;
        this.hub.start().catch(() => {});
        const ok = await this.hub.firstAttempt;
        if (!ok || !this.hub.box) {
            throw this.hub.lastError || new Error('not connected');
        }
        this.refresh();
    }

    async poll() {}

    /** Called once the provider's listeners are attached: a connection made before says so now. */
    async startPolling() {
        if (this.online) {
            this.emit('polled');
        }
    }

    stopPolling() {
        this.stopped = true;
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers = [];
    }

    /** Detaches from the connection (a provider that is replaced). */
    removeAllListeners(...args) {
        this.hub.off('ready', this.onReady);
        this.hub.off('status', this.onStatus);
        this.hub.off('meta', this.onMeta);
        return super.removeAllListeners(...args);
    }

    emitError(err) {
        if (this.listenerCount('error') > 0) {
            this.emit('error', err);
        }
    }

    async setVariable() {
        throw new Error('system variables are not available on openccu-lite (no ReGaHSS)');
    }

    async programActive() {
        throw new Error('programs are not available on openccu-lite (no ReGaHSS)');
    }

    async programExecute() {
        throw new Error('programs are not available on openccu-lite (no ReGaHSS)');
    }
}
