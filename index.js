#!/usr/bin/env node

/**
 * hm2mqtt — Homematic CCU to MQTT. A drop-in replacement for the node-red-contrib-ccu
 * `ccu-mqtt` flow on mqtt-interfaces-core; see ROADMAP.md for the decisions (H-n).
 */

import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAdapter} from 'mqtt-interfaces-core';
import {Rega} from 'homematic-rega';
import config from './config.js';
import pkg from './package.json' with {type: 'json'};
import {handle as handleInstall} from './lib/install.js';
import {parseInterfaces, probeInterfaces, interfaceConfig} from './lib/interfaces.js';
import {RpcServers, RpcConnection} from './lib/rpc.js';
import {Metadata} from './lib/metadata.js';
import {ValueStore, hmBlock, isEvent} from './lib/values.js';
import {RegaSync} from './lib/rega.js';
import {castValue, isWriteable} from './lib/cast.js';
import {datapointItem, sanitizeName, resolveSet, resolveParamset, plainValue} from './lib/topics.js';

handleInstall(config);

const COUNTER_INTERVAL_MS = 30000;
const VALUES_SAVE_MS = 300000;
const SET_THROTTLE_MS = 500;
const DEVICES_WAIT_MS = 10000;
const STOP_TIMEOUT_MS = 1500;
const RESOLVE_RETRY_MS = 10000;

const here = path.dirname(fileURLToPath(import.meta.url));
/** the configured CCU address (the `ccu` field of every payload); connections use the resolved ip */
const host = config.ccuAddress;
let ccuIp = host;

/** Resolves the CCU once (this host's resolver proved flaky under parallel lookups); retries forever. */
async function resolveCcu() {
    for (;;) {
        try {
            const {address} = await dns.lookup(host, {family: 4});
            if (address !== host) {
                log.info('ccu', host, 'resolves to', address);
            }
            return address;
        } catch (err) {
            log.warn('cannot resolve', host, '(' + err.message + ') - retrying in', RESOLVE_RETRY_MS / 1000, 's');
            await new Promise((resolve) => setTimeout(resolve, RESOLVE_RETRY_MS));
        }
    }
}

function firstIp() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const addr of list) {
            if (addr.family === 'IPv4' && !addr.internal) {
                return addr.address;
            }
        }
    }
    return '0.0.0.0';
}

/*
 * state
 */

// the option's default is $STATE_DIRECTORY only, so --install does not freeze this fallback into the env file
config.stateDir = config.stateDir || path.join(os.homedir(), '.hm2mqtt');
fs.mkdirSync(config.stateDir, {recursive: true});

let nameFile = {};
if (config.nameFile) {
    nameFile = JSON.parse(fs.readFileSync(path.resolve(config.nameFile), 'utf8'));
}

const adapter = createAdapter({
    pkg,
    config,
    deviceLabel: 'ccu',
    info: () => ({ccu: host, interfaces: enabled, devices: metadata.count(), rega: Boolean(regaSync)}),
    onSet: handleSet,
    subscriptions: {
        'paramset/#': handleParamset,
        ...(config.rpcTopics ? {'rpc/+/+/+': handleRpc} : {}),
    },
    onShutdown: shutdown,
});
const {log, pubStatus} = adapter;

const metadata = new Metadata({stateDir: config.stateDir, seedFile: path.join(here, 'paramsets.json'), log});
metadata.load();

let regaSync = null;
if (config.rega) {
    const rega = new Rega({
        host: ccuIp,
        tls: config.ccuTls,
        insecure: config.ccuInsecure,
        username: config.ccuUsername,
        password: config.ccuPassword,
        timeZone: config.ccuTimezone,
    });
    regaSync = new RegaSync({rega, host, metadata, stateDir: config.stateDir, nameFile, log});
    regaSync.load();
}

const channelName = (address) => (regaSync ? regaSync.channelName(address) : nameFile[address]);

const values = new ValueStore({
    host,
    context: {
        device: (iface, address) => metadata.device(iface, address),
        valueDescription: (iface, address, datapoint) => metadata.valueDescription(iface, address, datapoint),
        channelName,
        rooms: (address) => (regaSync ? regaSync.rooms(address) : undefined),
        functions: (address) => (regaSync ? regaSync.functions(address) : undefined),
    },
    stateDir: config.stateDir,
    log,
});
values.load();

let enabled = [];
const connections = {};
let servers = null;
let regaOk = false;
const timers = [];
const warnedNames = new Set();
const publishedCounters = {};
let fetchChain = Promise.resolve();

/*
 * publishing
 */

function itemOf(name) {
    const {name: item, changed} = sanitizeName(name);
    if (changed && !warnedNames.has(name)) {
        warnedNames.add(name);
        log.warn('name', JSON.stringify(name), 'is not usable as topic, publishing as', JSON.stringify(item));
    }
    return item;
}

function publishPlain(item, value, retain) {
    if (config.plainTree) {
        adapter.publish(adapter.topic(config.plainTree, item), plainValue(value), {retain});
    }
}

function publishMessage(message, {retain = true} = {}) {
    const item = datapointItem(itemOf(message.channelName || message.channel), message.datapoint);
    const extra = config.hmPayload ? {hm: hmBlock(message)} : undefined;
    pubStatus(item, message.value, {retain, extra, ts: message.ts, lc: message.lc});
    publishPlain(item, message.value, retain);
}

function publishRega(message) {
    const item = itemOf(message.name);
    const extra = config.hmPayload ? {hm: hmBlock(message)} : undefined;
    pubStatus(item, message.value, {retain: true, extra, ts: message.ts, lc: message.lc});
    publishPlain(item, message.value, true);
}

function publishItem(item, value, {retain = true} = {}) {
    pubStatus(item, value, {retain});
    publishPlain(item, value, retain);
}

function updateConnected() {
    const all = enabled.every((iface) => connections[iface] && connections[iface].connected) && (!regaSync || regaOk);
    adapter.setDeviceConnected(all);
}

function publishCounters() {
    if (!config.publishCounters) {
        return;
    }
    for (const iface of enabled) {
        const conn = connections[iface];
        for (const dir of ['rx', 'tx']) {
            const key = `${iface}/${dir}`;
            const value = conn ? conn.counters[dir] : 0;
            if (publishedCounters[key] !== value) {
                publishedCounters[key] = value;
                publishItem(`counter/${key}`, value);
            }
        }
    }
}

async function pollDutyCycle() {
    for (const iface of enabled) {
        const conn = connections[iface];
        if (!conn || !conn.connected || !interfaceConfig(iface, config).dutyCycle) {
            continue;
        }
        try {
            const list = await conn.methodCall('listBidcosInterfaces', []);
            if (!Array.isArray(list)) {
                continue;
            }
            for (const entry of list) {
                if (!entry || typeof entry.ADDRESS !== 'string') {
                    continue;
                }
                const item = itemOf(entry.ADDRESS);
                if (typeof entry.DUTY_CYCLE === 'number') {
                    publishItem(`${item}/DUTY_CYCLE`, entry.DUTY_CYCLE);
                }
                if (typeof entry.CARRIER_SENSE_LEVEL === 'number') {
                    publishItem(`${item}/CARRIER_SENSE_LEVEL`, entry.CARRIER_SENSE_LEVEL);
                }
                if (typeof entry.CONNECTED === 'boolean') {
                    publishItem(`${item}/CONNECTED`, entry.CONNECTED);
                }
            }
        } catch (err) {
            log.debug('rpc', iface, 'listBidcosInterfaces failed:', err.message);
        }
    }
}

/*
 * incoming: set / paramset / rpc
 */

const lookup = {
    channelAddress: (name, devices = false) => {
        if (regaSync) {
            return regaSync.channelAddress(name, devices);
        }
        const address = Object.entries(nameFile).find(([, n]) => n === name)?.[0] || name;
        if (!metadata.findIface(address)) {
            return undefined;
        }
        return devices || address.includes(':') ? address : undefined;
    },
    isSysvar: (name) => Boolean(regaSync && regaSync.hasVariable(name)),
    isProgram: (name) => Boolean(regaSync && regaSync.hasProgram(name)),
};

const setTimers = new Map();

/** node-red-contrib-ccu's setValue throttle: one call per datapoint per 500 ms, the last value wins. */
function throttled(id, fn) {
    const pending = setTimers.get(id);
    if (pending) {
        if (pending.deferred) {
            pending.deferred.resolve();
        }
        return new Promise((resolve, reject) => {
            pending.deferred = {fn, resolve, reject};
        });
    }
    const entry = {deferred: null};
    entry.timer = setTimeout(() => {
        setTimers.delete(id);
        if (entry.deferred) {
            const {fn: deferredFn, resolve, reject} = entry.deferred;
            log.debug('deferred set', id);
            deferredFn().then(resolve, reject);
        }
    }, SET_THROTTLE_MS);
    setTimers.set(id, entry);
    return fn();
}

function connectionOf(address) {
    const iface = metadata.findIface(address);
    if (!iface) {
        throw new Error(`unknown device ${address}`);
    }
    const conn = connections[iface];
    if (!conn) {
        throw new Error(`interface ${iface} of ${address} is not enabled`);
    }
    return {iface, conn};
}

async function setValue(address, datapoint, value) {
    const {iface, conn} = connectionOf(address);
    const description = metadata.valueDescription(iface, address, datapoint);
    if (!isWriteable(description)) {
        throw new Error(`${address} ${datapoint} is not writeable`);
    }
    if (!description) {
        log.debug('no paramset description for', iface, address, datapoint);
    }
    const cast = castValue(value, description);
    return throttled(`${iface}.${address}.${datapoint}`, () => conn.methodCall('setValue', [address, datapoint, cast]));
}

async function handleSet(parts, value, topic) {
    if (value === undefined) {
        log.warn('mqtt ignoring empty payload on', topic);
        return;
    }
    const target = resolveSet(parts, lookup);
    if (!target) {
        throw new Error('unknown channel, variable or program');
    }
    switch (target.kind) {
        case 'datapoint':
            return setValue(target.address, target.datapoint, value);
        case 'sysvar':
            return regaSync.setVariable(target.name, value);
        case 'program':
            return typeof value === 'boolean'
                ? regaSync.programActive(target.name, value)
                : regaSync.programExecute(target.name);
        case 'command':
            if (target.command === 'sync' && regaSync) {
                return regaSync.syncNames();
            }
            throw new Error('unknown command ' + target.command);
        default:
            throw new Error('unhandled target ' + target.kind);
    }
}

async function handleParamset(parts, value) {
    const whole = value && typeof value === 'object' && !Array.isArray(value);
    const target = resolveParamset(parts, lookup, {single: !whole});
    if (!target) {
        throw new Error(
            whole
                ? 'unknown channel/device or paramset'
                : 'unknown channel/device, paramset or parameter (object payloads set a whole paramset)',
        );
    }
    const {iface, conn} = connectionOf(target.address);
    const description =
        (await metadata.fetchDescription(iface, target.address, target.paramset, (m, p) => conn.methodCall(m, p))) ||
        {};
    const paramset = {};
    const entries = whole ? Object.entries(value) : [[target.param, value]];
    for (const [param, v] of entries) {
        const d = description[param];
        if (!isWriteable(d)) {
            throw new Error(`${target.address} ${target.paramset} ${param} is not writeable`);
        }
        if (!d) {
            log.debug('no paramset description for', iface, target.address, target.paramset, param);
        }
        paramset[param] = castValue(v, d);
    }
    await conn.methodCall('putParamset', [target.address, target.paramset, paramset]);
}

async function handleRpc(parts, value) {
    const [ifaceName, method, callId] = parts;
    const iface = enabled.find((n) => n.toLowerCase() === String(ifaceName).toLowerCase());
    const conn = iface && connections[iface];
    const respond = (payload) => adapter.publish(adapter.topic('response', callId), payload, {retain: false});
    if (!conn) {
        respond({error: `unknown interface ${ifaceName}`});
        throw new Error(`unknown interface ${ifaceName}`);
    }
    const params = Array.isArray(value) ? value : value === undefined ? [] : [value];
    try {
        respond(await conn.methodCall(method, params));
    } catch (err) {
        respond({error: err.message});
        throw err;
    }
}

/*
 * interfaces
 */

function fetchDescriptions(iface, addresses) {
    const conn = connections[iface];
    fetchChain = fetchChain
        .then(() => metadata.fetchDescriptions(iface, (method, params) => conn.methodCall(method, params), {addresses}))
        .catch((err) => log.warn(iface, 'fetching paramset descriptions failed:', err.message));
    return fetchChain;
}

/**
 * Right after init() the CCU pushes events before it announces its devices (newDevices). On a
 * first start (empty state) those events would lack device/channel/datapoint fields, so they
 * are held per interface until the devices are known (or 10 s passed).
 */
const heldEvents = {};

function holdEvent(iface, event) {
    if (!heldEvents[iface]) {
        return false;
    }
    heldEvents[iface].push(event);
    return true;
}

function releaseEvents(iface) {
    const held = heldEvents[iface];
    if (!held) {
        return;
    }
    delete heldEvents[iface];
    if (held.length > 0) {
        log.debug(iface, 'releasing', held.length, 'events held until the devices were known');
    }
    for (const event of held) {
        onEvent(iface, event);
    }
}

function onEvent(iface, event) {
    if (holdEvent(iface, event)) {
        return;
    }
    if (config.regaPollTrigger && regaSync && `${event.channel}.${event.datapoint}` === config.regaPollTrigger) {
        regaSync.poll().catch((err) => log.warn('rega poll failed:', err.message));
    }
    values.event({iface, ...event}, (message) => {
        const description = metadata.valueDescription(iface, event.channel, event.datapoint);
        if (!metadata.device(iface, event.channel)) {
            log.debug(iface, 'event of unknown channel', event.channel);
        } else if (!description) {
            log.debug(iface, 'no description for', event.channel, event.datapoint);
        }
        publishMessage(message, {retain: !isEvent(event.datapoint, description)});
        const notWorking = values.notWorking(message);
        if (notWorking) {
            publishMessage(notWorking);
        }
    });
}

function createConnection(iface) {
    const ic = interfaceConfig(iface, {tls: config.ccuTls, bidcosBinrpc: config.bidcosBinrpc});
    const conn = new RpcConnection({
        name: iface,
        host: ccuIp,
        protocol: ic.protocol,
        port: ic.port,
        path: ic.path,
        tls: config.ccuTls,
        insecure: config.ccuInsecure,
        username: config.ccuUsername,
        password: config.ccuPassword,
        init: ic.init,
        ping: ic.ping,
        pingTimeout: ic.pingTimeout || config.pingTimeout,
        servers,
        initId: `hm2mqtt_${config.name}_${iface}`,
        listDevices: () => metadata.listDevicesAnswer(iface),
        log,
    });
    conn.on('connected', (connected) => {
        publishItem(`interface/${iface}/connected`, connected);
        updateConnected();
        if (connected) {
            if (metadata.count(iface) === 0 && !heldEvents[iface]) {
                heldEvents[iface] = [];
                setTimeout(() => releaseEvents(iface), DEVICES_WAIT_MS).unref();
            }
            fetchDescriptions(iface);
        }
    });
    conn.on('event', (event) => onEvent(iface, event));
    conn.on('newDevices', (devices) => {
        const added = metadata.addDevices(iface, devices);
        log.info(
            iface,
            'newDevices:',
            devices.length,
            'announced,',
            added.length,
            'new (',
            metadata.count(iface),
            'known )',
        );
        if (added.length > 0) {
            fetchDescriptions(iface, added).then(() => releaseEvents(iface));
            adapter.publishInfo();
        } else {
            releaseEvents(iface);
        }
    });
    conn.on('deleteDevices', (addresses) => {
        const deleted = metadata.deleteDevices(iface, addresses);
        log.info(iface, 'deleteDevices:', deleted.length, 'removed');
        adapter.publishInfo();
    });
    return conn;
}

/*
 * rega
 */

async function startRega() {
    try {
        await regaSync.syncNames();
    } catch (err) {
        log.warn(
            'rega: names not available (' + err.message + '), using',
            Object.keys(regaSync.channelNames).length,
            'cached names',
        );
    }
    const duplicates = Object.entries(
        Object.values(regaSync.channelNames).reduce((acc, name) => ((acc[name] = (acc[name] || 0) + 1), acc), {}),
    )
        .filter(([, n]) => n > 1)
        .map(([name]) => name);
    if (duplicates.length > 0) {
        log.warn(
            'duplicate channel names share a topic:',
            duplicates.slice(0, 20).join(', '),
            duplicates.length > 20 ? '…' : '',
        );
    }
    regaSync.on('sysvar', publishRega);
    regaSync.on('program', publishRega);
    regaSync.on('polled', () => {
        if (!regaOk) {
            regaOk = true;
            log.info('rega connected');
            updateConnected();
        }
    });
    regaSync.on('error', () => {
        if (regaOk) {
            regaOk = false;
            log.warn('rega disconnected');
            updateConnected();
        }
    });
    regaSync.startPolling(config.regaPollInterval);
    loadCache().catch((err) => log.warn('rega getValues failed:', err.message));
    if (config.regaNamesInterval > 0) {
        timers.push(
            setInterval(
                () => regaSync.syncNames().catch((err) => log.warn('rega names re-sync failed:', err.message)),
                config.regaNamesInterval * 1000,
            ),
        );
    }
}

/** The ReGa's copy of every datapoint value: seeds the value store, published with --publish-cache. */
async function loadCache() {
    const list = await regaSync.rega.getValues();
    let published = 0;
    for (const dp of list) {
        const iface = String(dp.name).split('.')[0];
        if (!enabled.includes(iface)) {
            continue;
        }
        const message = values.cached(dp);
        if (!message) {
            continue;
        }
        if (config.publishCache && !message.datapoint.startsWith('PRESS_')) {
            const description = metadata.valueDescription(iface, message.channel, message.datapoint);
            publishMessage(message, {retain: !isEvent(message.datapoint, description)});
            published += 1;
        }
    }
    log.info('rega getValues:', list.length, 'values cached', config.publishCache ? `, ${published} published` : '');
}

/*
 * lifecycle
 */

async function start() {
    adapter.start();
    ccuIp = await resolveCcu();
    if (regaSync) {
        regaSync.rega.host = ccuIp;
        regaSync.rega.url = regaSync.rega.url.replace(host, ccuIp);
        regaSync.rega.webUrl = regaSync.rega.webUrl.replace(host, ccuIp);
    }
    enabled = parseInterfaces(config.interfaces) || (await probeInterfaces(ccuIp, {tls: config.ccuTls}));
    if (enabled.length === 0) {
        log.error('no interface found on', host, '- check --ccu-address / --interfaces');
    }
    log.info('interfaces:', enabled.join(', ') || '(none)');
    const listenAddress = config.listenAddress || firstIp();
    servers = new RpcServers({
        listenAddress,
        initAddress: config.initAddress,
        xmlrpcPort: config.xmlrpcPort,
        binrpcPort: config.binrpcPort,
        log,
    });
    for (const iface of enabled) {
        connections[iface] = createConnection(iface);
        publishItem(`interface/${iface}/connected`, false);
    }
    publishCounters();
    if (regaSync) {
        await startRega();
    }
    await Promise.all(enabled.map((iface) => connections[iface].start()));
    updateConnected();
    adapter.publishInfo();

    timers.push(setInterval(publishCounters, COUNTER_INTERVAL_MS));
    if (config.dutyCycleInterval > 0) {
        timers.push(setInterval(() => pollDutyCycle(), config.dutyCycleInterval * 1000));
        setTimeout(() => pollDutyCycle(), 5000);
    }
    timers.push(setInterval(() => values.save(), VALUES_SAVE_MS));
}

async function shutdown() {
    for (const timer of timers) {
        clearInterval(timer);
    }
    for (const entry of setTimers.values()) {
        clearTimeout(entry.timer);
    }
    values.stop();
    if (regaSync) {
        regaSync.stopPolling();
    }
    // state first: the core gives onShutdown two seconds, the de-init may not answer
    values.save();
    metadata.save();
    const stopAll = Promise.all(Object.values(connections).map((conn) => conn.stop()));
    await Promise.race([stopAll, new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))]);
    if (servers) {
        await Promise.race([servers.close(), new Promise((resolve) => setTimeout(resolve, 300))]);
    }
}

start().catch((err) => {
    log.error('start failed:', err.message);
    adapter.shutdown('start failed', 1);
});
