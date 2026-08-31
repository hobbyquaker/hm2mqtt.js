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
import {createAdapter, createLogger, runDiscovery, autoAddress} from 'mqtt-interfaces-core';
import {Rega} from 'homematic-rega';
import config from './config.js';
import pkg from './package.json' with {type: 'json'};
import {handle as handleInstall} from './lib/install.js';
import {parseInterfaces, probeInterfaces, interfaceConfig, detectLocal, regaPort} from './lib/interfaces.js';
import {RpcServers, RpcConnection} from './lib/rpc.js';
import {Metadata} from './lib/metadata.js';
import {ValueStore, hmBlock, isEvent} from './lib/values.js';
import {RegaSync} from './lib/rega.js';
import {castValue, isWriteable} from './lib/cast.js';
import {sanitizeName, resolveSet, resolveParamset, plainValue, compileTemplate, ItemIndex} from './lib/topics.js';
import {compileIgnore} from './lib/roles.js';
import {discoveryModel} from './lib/hadiscovery.js';
import {discoveryHint} from './lib/discovery.js';

/*
 * finding the CCU (core B-2): --discover prints what answers the eQ-3 broadcast probe,
 * --ccu-address auto uses it when exactly one CCU answers — its dns name if it has one, so a
 * new dhcp lease does not break the config. This runs before the installer on purpose:
 * `--install -a auto` then writes what was found, instead of leaving every service start to
 * scan the network and fail when the CCU is briefly away. The adapter's logger does not exist
 * yet, so discovery gets its own.
 */
if (config.discover || config.ccuAddress === 'auto') {
    const discoveryLog = createLogger({envPrefix: config.$envPrefix || 'HM2MQTT', level: config.verbosity});
    const hint = discoveryHint({tls: config.ccuTls});
    if (config.discover) {
        await runDiscovery({hint, config, log: discoveryLog}); // prints and exits
    }
    try {
        config.ccuAddress = await autoAddress(hint, {config, log: discoveryLog});
    } catch (err) {
        // no CCU or several: a wrong guess would bridge the wrong house
        discoveryLog.error('--ccu-address auto:', err.message);
        process.exit(1);
    }
}

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

/*
 * payload format (node-red-contrib-ccu's mqsh-extended / mqsh-basic / plain)
 */
let payloadFormat = config.payload;
if (config.hmPayload === false && payloadFormat === 'mqsh-extended') {
    payloadFormat = 'mqsh-basic';
}
if (!config.jsonPayloads) {
    payloadFormat = 'plain';
}
config.jsonPayloads = payloadFormat !== 'plain';
const withHm = payloadFormat === 'mqsh-extended';
/** the value as published: plain format uses node-red's 0/1 for booleans */
const outValue = (value) => (payloadFormat === 'plain' ? plainValue(value) : value);

const ignored = compileIgnore(config.ignore);

const adapter = createAdapter({
    pkg,
    config,
    deviceLabel: 'ccu',
    discovery: () =>
        discoveryModel({
            adapterName: pkg.name,
            name: config.name,
            jsonPayloads: config.jsonPayloads,
            generic: config.haGeneric,
            devices: metadata.devices,
            description: (iface, address) => metadata.description(iface, address, 'VALUES'),
            channelName,
            rooms: (address) => (regaSync ? regaSync.rooms(address) : undefined),
            itemFor: (iface, address, datapoint) => renderItem(values.fields(iface, address, datapoint)).name,
            ignored,
            interfaces: enabled,
        }),
    info: () => ({
        ccu: host,
        interfaces: enabled,
        devices: metadata.count(),
        rega: Boolean(regaSync),
        payload: payloadFormat,
    }),
    onSet: handleSet,
    subscriptions: {
        'paramset/#': handleParamset,
        ...(config.rpcTopics ? {'rpc/+/+/+': handleRpc} : {}),
    },
    onShutdown: shutdown,
});
const {log, pubStatus} = adapter;

/*
 * Running on the CCU itself, the interface processes are on loopback and the familiar
 * 2000/2001/2010/9292/8181 are only lighttpd proxies in front of them: an extra hop, XML over HTTP
 * for BidCos, and the CCU's authentication - all for nothing. --local/--no-local decides; by
 * default we probe, because node-red-contrib-ccu's config-file check stopped working on current
 * firmware (see lib/interfaces.js).
 */
const localMode = config.local === undefined ? await detectLocal(host) : Boolean(config.local);
if (localMode) {
    log.info('local mode: BidCos over binrpc (32001/32000), hmipserver on 32010, ReGa on 8183');
}

const metadata = new Metadata({stateDir: config.stateDir, seedFile: path.join(here, 'paramsets.json'), log});
metadata.load();

let regaSync = null;
if (config.rega) {
    const rega = new Rega({
        host: ccuIp,
        port: regaPort({tls: config.ccuTls, local: localMode}),
        tls: config.ccuTls && !localMode,
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

const renderItem = compileTemplate(config.itemTemplate);
const renderSysvarItem = compileTemplate(config.sysvarItemTemplate);
const renderProgramItem = compileTemplate(config.programItemTemplate);
const itemIndex = new ItemIndex();
let indexTimer = null;

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

function rendered(render, fields, label) {
    const {name: item, changed} = render(fields);
    if (changed && !warnedNames.has(label)) {
        warnedNames.add(label);
        log.warn('item of', label, 'rendered with replacements as', JSON.stringify(item));
    }
    return item;
}

/**
 * Rebuilds the reverse map item → target for set topics: every VALUES parameter of every known
 * channel rendered with the item template (plus its address form), variables and programs.
 */
function rebuildIndex() {
    indexTimer = null;
    itemIndex.clear('datapoint');
    itemIndex.collisions.clear();
    for (const iface of Object.keys(metadata.devices)) {
        for (const [address, device] of Object.entries(metadata.devices[iface])) {
            if (!device.PARENT) {
                continue;
            }
            const description = metadata.description(iface, address, 'VALUES');
            if (!description) {
                continue;
            }
            for (const datapoint of Object.keys(description)) {
                const target = {kind: 'datapoint', address, datapoint};
                itemIndex.add(renderItem(values.fields(iface, address, datapoint)).name, target);
                itemIndex.add(`${address}/${datapoint}`, target);
            }
        }
    }
    if (itemIndex.collisions.size > 0) {
        const list = [...itemIndex.collisions.keys()];
        log.warn(
            'items shared by several channels (the first one wins on set):',
            list.slice(0, 10).join(', '),
            list.length > 10 ? `… ${list.length - 10} more` : '',
        );
    }
    log.debug('item index rebuilt:', itemIndex.size, 'items');
    adapter.markDiscoveryDirty();
    adapter.publishDiscovery();
}

function scheduleIndex() {
    if (indexTimer) {
        return;
    }
    indexTimer = setTimeout(rebuildIndex, 2000);
    indexTimer.unref();
}

function publishPlain(item, value, retain) {
    if (config.plainTree) {
        adapter.publish(adapter.topic(config.plainTree, item), plainValue(value), {retain});
    }
}

function publishMessage(message, {retain = true} = {}) {
    const item = rendered(renderItem, message, message.datapointName);
    const extra = withHm ? {hm: hmBlock(message)} : undefined;
    pubStatus(item, outValue(message.value), {retain, extra, ts: message.ts, lc: message.lc});
    publishPlain(item, message.value, retain);
}

function publishRega(message) {
    const render = message.type === 'PROGRAM' ? renderProgramItem : renderSysvarItem;
    const item = rendered(render, message, `${message.type} ${message.name}`);
    itemIndex.add(item, {kind: message.type === 'PROGRAM' ? 'program' : 'sysvar', name: message.name});
    const extra = withHm ? {hm: hmBlock(message)} : undefined;
    pubStatus(item, outValue(message.value), {retain: true, extra, ts: message.ts, lc: message.lc});
    publishPlain(item, message.value, true);
}

function publishItem(item, value, {retain = true} = {}) {
    pubStatus(item, outValue(value), {retain});
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

/** HM thermostats: CONTROL_MODE is read-only, the modes are set through actions (H-26) */
const HM_MODES = {
    'AUTO-MODE': () => ['AUTO_MODE', true],
    'MANU-MODE': (setpoint) => ['MANU_MODE', setpoint],
    'BOOST-MODE': () => ['BOOST_MODE', true],
    'COMFORT-MODE': () => ['COMFORT_MODE', true],
    'LOWERING-MODE': () => ['LOWERING_MODE', true],
};

/** Words Home Assistant's single-topic conventions send to LEVEL (H-23). */
const LEVEL_WORDS = {OPEN: 1, CLOSE: 0, ON: 1.005, OFF: 0};

async function setValue(address, datapoint, value) {
    const {iface, conn} = connectionOf(address);
    let description = metadata.valueDescription(iface, address, datapoint);
    if (datapoint === 'LEVEL' && typeof value === 'string') {
        const word = value.trim().toUpperCase();
        if (word === 'STOP') {
            if (!metadata.valueDescription(iface, address, 'STOP')) {
                throw new Error(`${address} has no STOP`);
            }
            return setValue(address, 'STOP', true);
        }
        if (word in LEVEL_WORDS) {
            value = LEVEL_WORDS[word];
        }
    }
    if (
        datapoint === 'CONTROL_MODE' &&
        typeof value === 'string' &&
        HM_MODES[value.toUpperCase()] &&
        !isWriteable(description)
    ) {
        const current = values.get(iface, address, 'SET_TEMPERATURE');
        const [dp, v] = HM_MODES[value.toUpperCase()](
            current && typeof current.value === 'number' ? current.value : 20,
        );
        datapoint = dp;
        value = v;
        description = metadata.valueDescription(iface, address, datapoint);
    }
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
    // exact item first (rendered template, address form, variables, programs), then the positional form
    const target = itemIndex.get(parts.join('/')) || resolveSet(parts, lookup);
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
        .catch((err) => log.warn(iface, 'fetching paramset descriptions failed:', err.message))
        .then(scheduleIndex);
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
        if (ignored(iface, event.channel, event.datapoint)) {
            return;
        }
        const description = metadata.valueDescription(iface, event.channel, event.datapoint);
        if (!metadata.device(iface, event.channel)) {
            log.debug(iface, 'event of unknown channel', event.channel);
        } else if (!description) {
            log.debug(iface, 'no description for', event.channel, event.datapoint);
        }
        publishMessage(message, {retain: !isEvent(event.datapoint, description)});
        if (event.datapoint.startsWith('PRESS_') && event.value) {
            // one event item per key channel carrying every press type (HA event entities, H-23)
            publishMessage(
                {
                    ...message,
                    datapoint: 'PRESS',
                    datapointName: message.datapointName.replace(/PRESS_\w+$/, 'PRESS'),
                    value: event.datapoint,
                    payload: event.datapoint,
                },
                {retain: false},
            );
        }
        const notWorking = values.notWorking(message);
        if (notWorking) {
            publishMessage(notWorking);
        }
    });
}

function createConnection(iface) {
    const ic = interfaceConfig(iface, {tls: config.ccuTls, bidcosBinrpc: config.bidcosBinrpc, local: localMode});
    const conn = new RpcConnection({
        name: iface,
        host: ccuIp,
        protocol: ic.protocol,
        port: ic.port,
        path: ic.path,
        tls: config.ccuTls && !localMode,
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
        scheduleIndex();
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
    regaSync.on('names', scheduleIndex);
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
    enabled =
        parseInterfaces(config.interfaces) || (await probeInterfaces(ccuIp, {tls: config.ccuTls, local: localMode}));
    if (enabled.length === 0) {
        log.error('no interface found on', host, '- check --ccu-address / --interfaces');
    }
    log.info('interfaces:', enabled.join(', ') || '(none)');
    // locally the CCU calls back over loopback, so nothing of ours needs to listen on the LAN
    const listenAddress = config.listenAddress || (localMode ? '127.0.0.1' : firstIp());
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
    rebuildIndex();
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
