/**
 * The openccu-lite side: device and channel names, rooms and functions from the metadata API of a
 * box that has no ReGaHSS (`GET /api/meta/v1/...`, served by occulited through lighttpd).
 *
 * Same public surface as lib/rega.js's `RegaSync` — `channelName()`, `channelAddress()`,
 * `rooms()`, `functions()`, `syncNames()`, the `names` event — so index.js and everything below it
 * cannot tell the two apart and the published payloads do not change. What ReGa had and this box
 * has not (system variables, programs, HM-Script, the value cache) is empty here: `sysvars` and
 * `programs` stay `{}` and `hasVariable()`/`hasProgram()` answer false, which is what makes the
 * variable and program topics silently absent instead of failing.
 *
 * The startup call is `/snapshot`; everything after it comes from `/events/sse`, so a rename in the
 * box's UI arrives within a second without polling. Node 20 has no `EventSource` and the package
 * takes no new dependency for one: the stream is node:http, which also gives us the socket timeout
 * (the box sends an SSE heartbeat every 30 s) and `--ccu-insecure` for TLS.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {indexNames, resolveAddress} from './names.js';

/** everything the metadata API serves lives below this path */
export const API_PATH = '/api/meta/v1';
/** the box's own read-only credential, root-readable, for programs running on it */
export const LOCAL_TOKEN_FILE = '/usr/local/etc/occulite/local-token';

const DETECT_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 30000;
/** the box sends an SSE comment every 30 s; three missed heartbeats are a dead connection */
const STREAM_IDLE_MS = 95000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 300000;
/** a burst of events (a bulk edit, an import) becomes one snapshot read */
const COALESCE_MS = 250;
const MAX_BODY = 64 * 1024 * 1024;

/**
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<import('node:http').IncomingMessage>}
 */
function requestStream(url, {headers = {}, insecure = false, timeout = 0, signal} = {}) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch {
            reject(new Error(`invalid url: ${url}`));
            return;
        }
        const client = target.protocol === 'https:' ? https : http;
        const request = client.request(
            target,
            {method: 'GET', headers, signal, ...(insecure ? {rejectUnauthorized: false} : {})},
            resolve,
        );
        if (timeout > 0) {
            request.setTimeout(timeout, () => request.destroy(new Error(`no answer for ${timeout} ms`)));
        }
        request.on('error', reject);
        request.end();
    });
}

function readBody(res) {
    return new Promise((resolve, reject) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_BODY) {
                res.destroy(new Error('answer too large'));
            }
        });
        res.on('end', () => resolve(body));
        res.on('error', reject);
    });
}

/** GET a JSON document; a non-200 becomes an Error carrying `status` and the API's error code. */
async function getJson(url, options = {}) {
    const res = await requestStream(url, {timeout: REQUEST_TIMEOUT_MS, ...options});
    const body = await readBody(res);
    if (res.statusCode !== 200) {
        let code = '';
        try {
            code = JSON.parse(body).error || '';
        } catch {
            // a proxy or a CCU answering HTML: the status is all we have
        }
        const error = new Error(`${url} answered ${res.statusCode}${code ? ' ' + code : ''}`);
        error.status = res.statusCode;
        error.code = code;
        throw error;
    }
    return JSON.parse(body);
}

/**
 * Feature detection (the one call that needs no credential): openccu-lite answers the version
 * document here, a CCU/RaspberryMatic/OpenCCU answers 404 or HTML.
 * @param {string} baseUrl e.g. `http://ccu`
 * @returns {Promise<{ok: boolean, reachable: boolean, version?: object, reason?: string}>}
 */
export async function detectMeta(baseUrl, {insecure = false, timeout = DETECT_TIMEOUT_MS} = {}) {
    try {
        const doc = await getJson(`${baseUrl}${API_PATH}/version`, {insecure, timeout});
        if (doc && doc.api === 'meta' && Number(doc.version) >= 1) {
            return {ok: true, reachable: true, version: doc};
        }
        return {ok: false, reachable: true, reason: 'not the metadata API'};
    } catch (error) {
        // an answer we could not parse still proves that something is listening - that is a CCU,
        // and re-probing it forever would be pointless; a connection error is not.
        const reachable = typeof error.status === 'number' || error instanceof SyntaxError;
        return {ok: false, reachable, reason: error.message};
    }
}

/** The box's own token, when we are running on the box. */
export function readLocalToken(file = LOCAL_TOKEN_FILE) {
    try {
        const token = fs.readFileSync(file, 'utf8').trim();
        return token || undefined;
    } catch {
        return undefined;
    }
}

/** `<enum>/<id>/<id>` -> the name of the node it points at, for every node of every enum. */
export function enumLabels(enums) {
    const labels = new Map();
    const walk = (nodes, prefix) => {
        for (const node of nodes || []) {
            if (!node || typeof node.id !== 'string') {
                continue;
            }
            const nodePath = `${prefix}/${node.id}`;
            labels.set(nodePath, typeof node.name === 'string' && node.name !== '' ? node.name : node.id);
            walk(node.children, nodePath);
        }
    };
    for (const [id, def] of Object.entries(enums || {})) {
        walk(def && def.tree, id);
    }
    return labels;
}

/** The address of a ref: `HmIP-RF.0001D3C99C7D4B:3` -> `0001D3C99C7D4B:3`. */
export function addressOf(ref) {
    const dot = typeof ref === 'string' ? ref.indexOf('.') : -1;
    return dot > 0 ? ref.slice(dot + 1) : '';
}

/**
 * The metadata document as hm2mqtt sees it: names by address, and rooms and functions as arrays of
 * names — the shape ReGa's `getRooms()`/`getFunctions()` produced, so nothing downstream changes.
 *
 * Rooms and functions are trees here (`room/eg/wohnzimmer`) and a member of a node is implicitly a
 * member of its parents. Only the node the object is actually in is named, not its ancestors: that
 * is what a CCU would have reported, and `${room}` in a topic template must not suddenly become
 * two levels (H-48).
 */
export function deriveNames(objects, enums) {
    const labels = enumLabels(enums);
    const channelNames = {};
    const channelRooms = {};
    const channelFunctions = {};
    for (const [ref, object] of Object.entries(objects || {})) {
        if (!object || typeof object !== 'object') {
            continue;
        }
        const address = addressOf(ref);
        if (!address) {
            continue;
        }
        if (typeof object.name === 'string' && object.name !== '') {
            channelNames[address] = object.name;
        }
        for (const nodePath of object.enums || []) {
            const name = labels.get(nodePath);
            if (!name) {
                continue;
            }
            const target = nodePath.startsWith('room/')
                ? channelRooms
                : nodePath.startsWith('function/')
                  ? channelFunctions
                  : null;
            if (!target) {
                // floor and whatever else the user created: hm2mqtt has no field for them
                continue;
            }
            const list = (target[address] = target[address] || []);
            if (!list.includes(name)) {
                list.push(name);
            }
        }
    }
    return {channelNames, channelRooms, channelFunctions};
}

export class MetaSync extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.url base url of the box, e.g. `http://ccu` (no path)
     * @param {string} [o.token] API token (`olt_…`) or session id; default: the box's local token
     * @param {string} [o.tokenFile] where the local token lives
     * @param {boolean} [o.insecure] accept a self-signed certificate (--ccu-insecure)
     * @param {boolean} [o.fixedUrl] the url was configured explicitly and must not follow the ccu ip
     * @param {object} [o.metadata] Metadata (to tell an address from a name on set topics)
     * @param {string} [o.stateDir]
     * @param {Object<string, string>} [o.nameFile] {address: name} overriding the box's names
     * @param {object} o.log
     */
    constructor({
        url,
        token,
        tokenFile = LOCAL_TOKEN_FILE,
        insecure = false,
        fixedUrl = false,
        metadata,
        stateDir,
        nameFile,
        log,
    }) {
        super();
        this.label = 'occulite';
        this.url = String(url || '').replace(/\/+$/, '');
        this.tokenFile = tokenFile;
        this.token = token || readLocalToken(tokenFile);
        this.insecure = insecure;
        this.fixedUrl = fixedUrl;
        this.metadata = metadata;
        this.stateDir = stateDir;
        this.nameFile = nameFile || {};
        this.log = log;
        /** the store as served, kept so a restart without the box still has the names */
        this.objects = {};
        this.enums = {};
        this.revision = 0;
        this.channelNames = {};
        this.addresses = {};
        this.channelRooms = {};
        this.channelFunctions = {};
        /** ReGa concepts without a counterpart here; kept so the lookups below stay valid */
        this.sysvars = {};
        this.programs = {};
        this.synced = false;
        this.stopped = false;
        this.warnedAuth = false;
        this.backoff = RECONNECT_MIN_MS;
        this.streamRes = null;
        this.streamPending = false;
        this.streamAbort = null;
        this.streamTimer = null;
        this.refreshTimer = null;
        this.applyTimer = null;
        this.refreshing = false;
        this.refreshAgain = false;
    }

    /*
     * persistence — same place and purpose as rega.json, one file further so switching a
     * configuration between a CCU and openccu-lite does not overwrite the other one's cache
     */

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
            this.objects = data.objects || {};
            this.enums = data.enums || {};
            this.revision = Number(data.revision) || 0;
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
            fs.writeFileSync(file, JSON.stringify({revision: this.revision, objects: this.objects, enums: this.enums}));
        } catch (err) {
            this.log.warn('cannot save', file, '-', err.message);
        }
    }

    /*
     * lookups — the surface index.js calls
     */

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

    /*
     * the box
     */

    /** The CCU address is resolved once at start (H-20); follow it, unless a url was configured. */
    setHost(ip) {
        if (this.fixedUrl || !ip) {
            return;
        }
        try {
            const url = new URL(this.url);
            url.hostname = ip;
            this.url = url.toString().replace(/\/+$/, '');
        } catch {
            // an unparsable url stays as it is; the requests below will say so
        }
    }

    headers(extra = {}) {
        return {
            accept: 'application/json',
            ...(this.token ? {authorization: `Bearer ${this.token}`} : {}),
            ...extra,
        };
    }

    get(endpoint) {
        return getJson(`${this.url}${API_PATH}${endpoint}`, {headers: this.headers(), insecure: this.insecure});
    }

    /*
     * names, rooms, functions
     */

    /** Reads the snapshot and follows the change stream. Emits 'names'. */
    async syncNames() {
        this.stopped = false;
        this.startStream();
        await this.refresh({announce: true});
    }

    /** ReGa's variable/program poll has no counterpart here; the stream is the update path. */
    async poll() {
        this.startStream();
    }

    startPolling() {
        this.startStream();
        return Promise.resolve();
    }

    stopPolling() {
        this.stopped = true;
        for (const timer of [this.streamTimer, this.refreshTimer, this.applyTimer]) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        this.streamTimer = this.refreshTimer = this.applyTimer = null;
        this.closeStream();
    }

    /** Fetches the snapshot and applies it. Throws once, and retries by itself afterwards. */
    async refresh({announce = false} = {}) {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        // one snapshot at a time: the stream and an event burst both ask for one
        if (this.refreshing) {
            this.refreshAgain = true;
            return;
        }
        this.refreshing = true;
        // scheduled in the finally, where `refreshing` is false again: a failure retries with the
        // backoff, an event that overtook the snapshot as soon as the burst is over
        let retry = null;
        try {
            let doc;
            try {
                doc = await this.get('/snapshot');
            } catch (err) {
                if (err.status === 401 || err.status === 403) {
                    this.denied(err);
                    return;
                }
                retry = this.backoff;
                throw err;
            }
            this.accepted();
            // events that arrived while the snapshot was in flight are newer than it
            const overtaken = this.revision > (Number(doc.revision) || 0);
            const changed = this.applySnapshot(doc);
            this.save();
            if (announce || changed) {
                this.logSummary();
            }
            this.emit('names');
            this.emit('polled');
            if (overtaken) {
                this.refreshAgain = true;
            }
        } finally {
            this.refreshing = false;
            if (this.refreshAgain || retry !== null) {
                this.refreshAgain = false;
                this.scheduleRefresh(retry === null ? COALESCE_MS : retry);
            }
        }
    }

    applySnapshot(doc) {
        this.objects = (doc && doc.objects) || {};
        this.enums = (doc && doc.enums) || {};
        this.revision = Number(doc && doc.revision) || 0;
        this.synced = true;
        return this.rebuild();
    }

    /** Derives names, rooms and functions from the store; true when anything changed. */
    rebuild() {
        const before = JSON.stringify([this.channelNames, this.channelRooms, this.channelFunctions]);
        const derived = deriveNames(this.objects, this.enums);
        this.channelNames = derived.channelNames;
        this.channelRooms = derived.channelRooms;
        this.channelFunctions = derived.channelFunctions;
        this.addresses = indexNames(this.channelNames, this.nameFile);
        return JSON.stringify([this.channelNames, this.channelRooms, this.channelFunctions]) !== before;
    }

    logSummary() {
        const labels = [...enumLabels(this.enums).keys()];
        this.log.info(
            'occulite:',
            Object.keys(this.channelNames).length,
            'names,',
            labels.filter((p) => p.startsWith('room/')).length,
            'rooms,',
            labels.filter((p) => p.startsWith('function/')).length,
            'functions (revision ' + this.revision + ')',
        );
    }

    scheduleRefresh(delay = this.backoff) {
        if (this.stopped || this.refreshTimer) {
            return;
        }
        if (this.refreshing) {
            this.refreshAgain = true;
            return;
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            this.refresh().catch((err) => this.log.debug('occulite: snapshot failed:', err.message));
        }, delay);
    }

    /** Rebuild after object events, coalesced: a bulk edit is one 'names'. */
    scheduleApply() {
        if (this.stopped || this.applyTimer) {
            return;
        }
        this.applyTimer = setTimeout(() => {
            this.applyTimer = null;
            if (this.rebuild()) {
                this.save();
                this.log.debug('occulite: names updated (revision', this.revision + ')');
                this.emit('names');
            }
        }, 50);
    }

    /*
     * the change stream
     */

    startStream() {
        if (this.stopped || this.streamRes || this.streamPending || !this.url) {
            return;
        }
        if (this.streamTimer) {
            clearTimeout(this.streamTimer);
            this.streamTimer = null;
        }
        this.streamPending = true;
        // ?since replays what we missed; without a snapshot there is nothing to replay from
        const since = this.synced && this.revision > 0 ? `?since=${this.revision}` : '';
        const controller = new AbortController();
        this.streamAbort = controller;
        requestStream(`${this.url}${API_PATH}/events/sse${since}`, {
            headers: this.headers({accept: 'text/event-stream'}),
            insecure: this.insecure,
            timeout: STREAM_IDLE_MS,
            signal: controller.signal,
        }).then(
            (res) => this.onStream(res),
            (err) => this.onStreamEnd(err),
        );
    }

    onStream(res) {
        this.streamPending = false;
        if (this.stopped) {
            res.destroy();
            return;
        }
        if (res.statusCode !== 200) {
            res.resume();
            const error = new Error(`event stream answered ${res.statusCode}`);
            error.status = res.statusCode;
            if (res.statusCode === 401 || res.statusCode === 403) {
                this.denied(error);
            }
            this.onStreamEnd(error);
            return;
        }
        this.streamRes = res;
        this.backoff = RECONNECT_MIN_MS;
        this.accepted();
        this.log.debug('occulite: event stream open');
        this.emit('polled');
        if (!this.synced) {
            // the stream is up before the first snapshot: fetch it, unless syncNames() already is
            this.scheduleRefresh(0);
        }
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            buffer += chunk;
            let index;
            while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
                const [separator] = buffer.slice(index).match(/^\r?\n\r?\n/);
                const frame = buffer.slice(0, index);
                buffer = buffer.slice(index + separator.length);
                this.onFrame(frame);
            }
            if (buffer.length > MAX_BODY) {
                buffer = '';
            }
        });
        const end = (err) => {
            if (this.streamRes === res) {
                this.streamRes = null;
                this.onStreamEnd(err);
            }
        };
        res.on('end', () => end(null));
        res.on('close', () => end(null));
        res.on('error', end);
    }

    onStreamEnd(err) {
        this.streamPending = false;
        this.streamRes = null;
        this.streamAbort = null;
        if (this.stopped) {
            return;
        }
        this.log.debug('occulite: event stream closed', err ? '(' + err.message + ')' : '');
        this.emitError(err || new Error('event stream closed'));
        if (this.streamTimer) {
            return;
        }
        this.streamTimer = setTimeout(() => {
            this.streamTimer = null;
            this.startStream();
        }, this.backoff);
        this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    }

    closeStream() {
        if (this.streamAbort) {
            this.streamAbort.abort();
            this.streamAbort = null;
        }
        if (this.streamRes) {
            this.streamRes.destroy();
            this.streamRes = null;
        }
        this.streamPending = false;
    }

    /** One SSE frame: the `data:` lines are the event, a comment (heartbeat) has none. */
    onFrame(frame) {
        const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (data === '') {
            return;
        }
        let event;
        try {
            event = JSON.parse(data);
        } catch {
            this.log.debug('occulite: unparsable event', data.slice(0, 200));
            return;
        }
        this.onEvent(event);
    }

    onEvent(event) {
        if (!event || typeof event !== 'object') {
            return;
        }
        if (event.kind === 'resync') {
            this.log.debug('occulite: resync requested by the box');
            this.revision = Number(event.revision) || this.revision;
            this.scheduleRefresh(0);
            return;
        }
        const revision = Number(event.revision);
        if (Number.isFinite(revision)) {
            if (this.synced && this.revision > 0 && revision > this.revision + 1) {
                this.log.debug('occulite: revision gap', this.revision, '->', revision);
                this.revision = revision;
                this.scheduleRefresh(0);
                return;
            }
            this.revision = revision;
        }
        switch (event.kind) {
            case 'object.updated':
                if (event.ref && event.value) {
                    this.objects[event.ref] = event.value;
                    this.scheduleApply();
                }
                break;
            case 'object.deleted':
                if (event.ref) {
                    delete this.objects[event.ref];
                    this.scheduleApply();
                }
                break;
            default:
                // enum.*, node.* and import change the names of rooms or the paths of their
                // members: the snapshot is the cheapest correct answer
                this.scheduleRefresh(COALESCE_MS);
        }
    }

    /*
     * the credential
     */

    /** 'error' on an EventEmitter with no listener throws; the stream may start before index.js listens */
    emitError(err) {
        if (this.listenerCount('error') > 0) {
            this.emit('error', err);
        }
    }

    denied(err) {
        this.emitError(err);
        if (this.warnedAuth) {
            return;
        }
        this.warnedAuth = true;
        this.log.warn(
            `occulite: the metadata API rejected the credential (${err.status}) - running without names, rooms and functions;`,
            this.token
                ? 'the token was revoked or belongs to another box - create a new one on the box under Benutzer and set --meta-token'
                : `no token configured and none in ${this.tokenFile} - create an API token on the box under Benutzer and set --meta-token`,
        );
    }

    accepted() {
        if (this.warnedAuth) {
            this.warnedAuth = false;
            this.log.info('occulite: the metadata API accepts the credential again');
        }
    }

    /*
     * what this box does not have (kept so a misrouted set says why instead of throwing a TypeError)
     */

    async setVariable() {
        throw new Error('system variables are not available on this box (no ReGaHSS)');
    }

    async programActive() {
        throw new Error('programs are not available on this box (no ReGaHSS)');
    }

    async programExecute() {
        throw new Error('programs are not available on this box (no ReGaHSS)');
    }
}
