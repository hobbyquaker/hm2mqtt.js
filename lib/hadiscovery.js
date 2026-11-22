/**
 * Home Assistant discovery: one HA device per Homematic device (ROADMAP §13, H-22…H-26),
 * composite entities from the channel roles (light, cover, climate, lock, event, switch, ...)
 * and generic entities for every other datapoint (disabled by default). Pure: devices,
 * descriptions and names in, device blocks for the core's discovery() out.
 */

import {entity, availability, discoveryId} from 'mqtt-interfaces-core';
import {channelRole, haUnit, isFraction, PARAMETERS} from './roles.js';

/**
 * The device classes Home Assistant accepts per platform (B-8). A component whose class is not in
 * its platform's list is refused by Home Assistant with an error log line, so `e()` drops such a
 * class and the tests check every component of every device of the fixture CCU against this table.
 * Platforms missing here (light, climate, lock, select) take no device class at all.
 */
const SENSOR_CLASSES = [
    'absolute_humidity',
    'apparent_power',
    'aqi',
    'area',
    'atmospheric_pressure',
    'battery',
    'blood_glucose_concentration',
    'carbon_dioxide',
    'carbon_monoxide',
    'conductivity',
    'current',
    'data_rate',
    'data_size',
    'distance',
    'duration',
    'energy',
    'energy_distance',
    'energy_storage',
    'frequency',
    'gas',
    'humidity',
    'illuminance',
    'irradiance',
    'moisture',
    'monetary',
    'nitrogen_dioxide',
    'nitrogen_monoxide',
    'nitrous_oxide',
    'ozone',
    'ph',
    'pm1',
    'pm10',
    'pm25',
    'pm4',
    'power',
    'power_factor',
    'precipitation',
    'precipitation_intensity',
    'pressure',
    'radon',
    'reactive_energy',
    'reactive_power',
    'signal_strength',
    'sound_pressure',
    'speed',
    'sulphur_dioxide',
    'temperature',
    'temperature_delta',
    'volatile_organic_compounds',
    'volatile_organic_compounds_parts',
    'voltage',
    'volume',
    'volume_flow_rate',
    'volume_storage',
    'water',
    'weight',
    'wind_direction',
    'wind_speed',
];
export const DEVICE_CLASSES = {
    binary_sensor: new Set([
        'battery',
        'battery_charging',
        'carbon_monoxide',
        'cold',
        'connectivity',
        'door',
        'garage_door',
        'gas',
        'heat',
        'light',
        'lock',
        'moisture',
        'motion',
        'moving',
        'occupancy',
        'opening',
        'plug',
        'power',
        'presence',
        'problem',
        'running',
        'safety',
        'smoke',
        'sound',
        'tamper',
        'update',
        'vibration',
        'window',
    ]),
    sensor: new Set([...SENSOR_CLASSES, 'date', 'enum', 'timestamp', 'uptime']),
    number: new Set(SENSOR_CLASSES),
    switch: new Set(['outlet', 'switch']),
    button: new Set(['identify', 'restart', 'update']),
    cover: new Set(['awning', 'blind', 'curtain', 'damper', 'door', 'garage', 'gate', 'shade', 'shutter', 'window']),
    event: new Set(['button', 'doorbell', 'motion']),
};

/** true when Home Assistant accepts `deviceClass` on `platform` */
export function validDeviceClass(platform, deviceClass) {
    return Boolean(DEVICE_CLASSES[platform] && DEVICE_CLASSES[platform].has(deviceClass));
}

/**
 * Datapoints that are never announced (the maintainer, 2026-10-22, node-red-contrib-ccu B-39:
 * "don't publish STICKY_UNREACH to home assistant auto discovery. UNREACH is enough.").
 */
export const NOT_ANNOUNCED = new Set(['STICKY_UNREACH']);

const TILT_TYPES = /BLIND/;

/**
 * A cover's state from its LEVEL message in the mqsh-extended format: `hm.working` and
 * `hm.direction` (1 up, 2 down - node-red-contrib-ccu's, ACTIVITY_STATE mapped onto DIRECTION) say
 * whether it moves, the value whether it is closed. Closed is what Home Assistant calls closed
 * without a state topic: the position, rounded to a percent, is 0.
 */
export const COVER_STATE_TEMPLATE =
    '{% set hm = value_json.hm | default({}) %}' +
    '{% set d = (hm.direction | default(0) | int(0)) if hm.working | default(false) else 0 %}' +
    "{{ 'opening' if d == 1 else 'closing' if d == 2 else" +
    " 'closed' if ((value_json.val | float(0)) * 100) | round == 0 else 'open' }}";

/**
 * @typedef {object} DiscoveryContext
 * @property {string} adapterName package name (hm2mqtt)
 * @property {string} name instance name / topic prefix
 * @property {boolean} jsonPayloads
 * @property {boolean} [hmPayload] the payloads carry the `hm` block (mqsh-extended; default: jsonPayloads)
 * @property {boolean} [generic] generic entities for datapoints without a role (default true)
 * @property {Object<string, Object<string, object>>} devices metadata.devices (iface → address → device)
 * @property {(iface: string, address: string) => object | undefined} description VALUES description of a channel
 * @property {(address: string) => string | undefined} channelName
 * @property {(address: string) => string[] | undefined} rooms the rooms of a channel (or device)
 * @property {boolean} [area] the room becomes the device's `suggested_area` (default true, task 28)
 * @property {(iface: string, address: string, datapoint: string) => string} statusTopicFor status topic of a datapoint
 * @property {(iface: string, address: string, datapoint: string) => string} setTopicFor set topic of a datapoint
 * @property {(iface: string, address: string, datapoint: string) => boolean} [ignored]
 * @property {string[]} [interfaces] enabled interfaces (bridge entities)
 */

function templates(json) {
    const v = json ? 'value_json.val' : 'value';
    return {
        v,
        num: `{{ ${v} }}`,
        bool: (on = 'ON', off = 'OFF') =>
            json
                ? `{{ '${on}' if ${v} else '${off}' }}`
                : `{{ '${on}' if (${v} | string | lower) in ('1', 'true', 'on') else '${off}' }}`,
        percent: `{{ ((${v} | float(0)) * 100) | round }}`,
        int: `${v} | int(0)`,
        float: `${v} | float(0)`,
    };
}

function labelOf(channel, deviceName, fallback) {
    const name = channel.name;
    if (!name) {
        return fallback;
    }
    if (deviceName && name !== deviceName && name.startsWith(deviceName)) {
        const rest = name.slice(deviceName.length).replace(/^[\s:.-]+/, '');
        return rest || fallback;
    }
    if (name === deviceName) {
        return fallback;
    }
    return name;
}

/**
 * Builds the discovery device blocks.
 * @param {DiscoveryContext} ctx
 * @returns {object[]} device blocks ({id, device, components, availability})
 */
export function discoveryModel(ctx) {
    return discoveryBlocks(ctx).blocks;
}

/** component key → platform of a block, its children's included (stubs `{p}` left out) */
function keysOf(block) {
    const keys = {};
    const take = (cmps) => {
        for (const [key, component] of Object.entries(cmps || {})) {
            if (component && Object.keys(component).length > 1) {
                keys[key] = component.p;
            }
        }
    };
    take(block.components);
    for (const child of block.children || []) {
        take(child.components);
    }
    return keys;
}

/** the channel index a component key starts with (`<index>_<datapoint>`) */
function channelOfKey(key) {
    return Number.parseInt(String(key).split('_')[0], 10);
}

/**
 * The discovery blocks, and what to remove (task 32). Home Assistant keeps a component that is left
 * out of a device's payload; it removes one sent with only its platform (`{p}`). `ctx.previous`
 * holds, per device address, what the last run published (block id → component key → platform): a
 * key published there and missing now - a channel no longer published, or moved to a device of its
 * own - goes once as such a stub, and a block id of the last run with no block now is to be cleared
 * (`clear`). Without a record for the device every component counts as published on the device's
 * block (the first run). Components of channels whose description is not known (yet) are neither
 * removed nor forgotten.
 * @param {DiscoveryContext} ctx
 * @returns {{blocks: object[], clear: string[], published: Object<string, Object<string, Object<string, string>>>}}
 */
export function discoveryBlocks(ctx) {
    const previous = ctx.previous || {};
    const blocks = [];
    const clear = [];
    const published = {};
    const seen = new Set();
    for (const block of rawBlocks(ctx)) {
        if (!block.address) {
            blocks.push(block);
            continue;
        }
        const {own, all, unknown, address, ...parent} = block;
        seen.add(address);
        const before = previous[address] || {};
        const allKeys = {};
        for (const [key, component] of Object.entries(all)) {
            allKeys[key] = component.p;
        }
        const record = {};
        const candidates = [
            parent,
            ...own.map((o) => ({
                id: o.id,
                device: o.device,
                components: o.components,
                availability: parent.availability,
                availabilityMode: parent.availabilityMode,
            })),
        ];
        for (const candidate of candidates) {
            const now = keysOf(candidate);
            const last = before[candidate.id] || (!previous[address] && candidate === parent ? allKeys : {});
            const stubs = {};
            const kept = {...now};
            for (const [key, platform] of Object.entries(last)) {
                if (key in now) {
                    continue;
                }
                if (unknown.has(channelOfKey(key))) {
                    kept[key] = platform;
                } else if (platform) {
                    stubs[key] = {p: platform};
                }
            }
            if (Object.keys(now).length === 0 && Object.keys(kept).length === 0) {
                if (Object.keys(last).length > 0) {
                    clear.push(candidate.id);
                }
                continue;
            }
            if (Object.keys(stubs).length > 0) {
                candidate.components = {...candidate.components, ...stubs};
            }
            record[candidate.id] = kept;
            blocks.push(candidate);
        }
        for (const [id, keys] of Object.entries(before)) {
            if (record[id] || candidates.some((c) => c.id === id)) {
                continue;
            }
            if (Object.keys(keys).some((key) => unknown.has(channelOfKey(key)))) {
                record[id] = keys;
            } else {
                clear.push(id);
            }
        }
        published[address] = record;
    }
    // devices not in the table now (or without an entity) keep their record
    for (const [address, record] of Object.entries(previous)) {
        if (!seen.has(address)) {
            published[address] = record;
        }
    }
    return {blocks, clear, published};
}

function rawBlocks(ctx) {
    const {adapterName, name, jsonPayloads: json = true, devices, statusTopicFor, setTopicFor} = ctx;
    const ignored = ctx.ignored || (() => false);
    const t = templates(json);
    const bridgeId = discoveryId(adapterName, name);
    // whole topics, from the configured templates - a controller has to be told where the values
    // actually are, not where the convention would put them
    const st = (iface, address, dp) => statusTopicFor(iface, address, dp);
    const cmd = (iface, address, dp) => setTopicFor(iface, address, dp);
    const blocks = [];

    // the CCU / bridge device
    const bridgeComponents = {};
    for (const iface of ctx.interfaces || []) {
        bridgeComponents[`iface_${iface}`] = entity({
            id: bridgeId,
            name,
            item: `interface/${iface}/connected`,
            platform: 'binary_sensor',
            label: `${iface} connected`,
            jsonPayloads: json,
            category: 'diagnostic',
            extra: {dev_cla: 'connectivity', val_tpl: t.bool()},
        });
        for (const dir of ['rx', 'tx']) {
            bridgeComponents[`counter_${iface}_${dir}`] = entity({
                id: bridgeId,
                name,
                item: `counter/${iface}/${dir}`,
                platform: 'sensor',
                label: `${iface} ${dir}`,
                jsonPayloads: json,
                category: 'diagnostic',
                extra: {stat_cla: 'total_increasing', en: false},
            });
        }
    }
    blocks.push({id: bridgeId, device: {mf: 'eQ-3', mdl: 'CCU'}, components: bridgeComponents});

    for (const [iface, list] of Object.entries(devices)) {
        for (const device of Object.values(list)) {
            if (device.PARENT) {
                continue;
            }
            const block = deviceBlock({iface, device, list, ctx, t, st, cmd, bridgeId, ignored});
            if (block) {
                blocks.push(block);
            }
        }
    }
    return blocks;
}

/**
 * The room Home Assistant is to suggest as the device's area (task 28). Home Assistant's area is
 * per device, the CCU's rooms are per channel, so: a room every channel that lies in a room shares
 * - the first one in the order of the lowest-numbered such channel - or, when they share none, the
 * first room of the lowest-numbered channel that has one. A room of the device itself (an
 * openccu-lite device may be in a room as a whole) comes first. Home Assistant applies
 * `suggested_area` only when it creates the device; a room changed later stays as assigned there.
 * @param {(address: string) => string[] | undefined} roomsOf
 * @param {string} deviceAddress
 * @param {Array<{ADDRESS: string}>} channels sorted by channel index
 * @returns {string | undefined}
 */
export function suggestedArea(roomsOf, deviceAddress, channels) {
    const lists = [deviceAddress, ...channels.map((ch) => ch.ADDRESS)]
        .map((address) => roomsOf(address))
        .filter((rooms) => Array.isArray(rooms) && rooms.length > 0);
    if (lists.length === 0) {
        return undefined;
    }
    const [first, ...rest] = lists;
    return first.find((room) => rest.every((rooms) => rooms.includes(room))) || first[0];
}

function deviceBlock({iface, device, list, ctx, t, st, cmd, bridgeId, ignored}) {
    const {adapterName, name, jsonPayloads: json = true, generic = true} = ctx;
    const hm = json && ctx.hmPayload !== false;
    const id = discoveryId(adapterName, `${name}_${device.ADDRESS}`);
    const deviceName = ctx.channelName(device.ADDRESS) || device.ADDRESS;
    const channels = (device.CHILDREN || [])
        .map((address) => list[address])
        .filter(Boolean)
        .map((ch) => {
            const description = ctx.description(iface, ch.ADDRESS);
            return {
                ...ch,
                index: Number.parseInt(String(ch.ADDRESS).split(':')[1], 10),
                name: ctx.channelName(ch.ADDRESS),
                description: description || {},
                described: Boolean(description),
            };
        })
        .sort((a, b) => a.index - b.index);
    for (const ch of channels) {
        ch.role = channelRole(ch.TYPE, ch.description);
    }
    resolveVirtualReceivers(channels);

    const components = {};
    /** component key → the channel it comes from and whether it is a role's (not a generic) entity */
    const origins = {};
    let current;
    let inGeneric = false;
    const add = (key, e) => {
        components[key] = e;
        origins[key] = {ch: current, role: !inGeneric};
    };
    const area = ctx.area === false ? undefined : suggestedArea(ctx.rooms, device.ADDRESS, channels);
    const maintenance = channels.find((ch) => ch.index === 0);

    for (const ch of channels) {
        current = ch;
        inGeneric = false;
        const consumed = new Set();
        const e = (dp, platform, label, more = {}) => {
            const built = entity({
                id,
                name,
                item: `${ch.index}/${dp}`,
                platform,
                label,
                uid: `${ch.index}_${dp}`,
                jsonPayloads: json,
                ...more,
            });
            // The topics are whole, rendered from the configured templates. entity() composes
            // <name>/status|set/<item> for a core-style item, so exactly its composed values are
            // replaced here; an explicit stat_t/cmd_t from `extra` and the stateless platforms
            // (which get none) stay as they are.
            if (built.stat_t === `${name}/status/${ch.index}/${dp}`) {
                built.stat_t = own(dp);
            }
            if (built.cmd_t === `${name}/set/${ch.index}/${dp}`) {
                built.cmd_t = scmd(dp);
            }
            // a class the platform does not know makes HA refuse the component (B-8)
            if (built.dev_cla !== undefined && !validDeviceClass(platform, built.dev_cla)) {
                delete built.dev_cla;
            }
            return built;
        };
        const fallback = ch.index === 0 ? 'Maintenance' : `Channel ${ch.index}`;
        const label = labelOf(ch, deviceName, fallback);
        ch.label = label;
        const has = (dp) => Boolean(ch.description[dp]) && !ignored(iface, ch.ADDRESS, dp);
        const key = (dp) => `${ch.index}_${dp}`;
        const stateCh = ch.stateChannel || ch;
        const sst = (dp) => st(iface, stateCh.ADDRESS, dp);
        const own = (dp) => st(iface, ch.ADDRESS, dp);
        const scmd = (dp) => cmd(iface, ch.ADDRESS, dp);
        const disabled = ch.secondary ? {en: false} : {};

        switch (ch.role) {
            case 'switch':
                if (has('STATE')) {
                    add(
                        key('STATE'),
                        e('STATE', 'switch', label, {
                            command: true,
                            extra: {
                                stat_t: sst('STATE'),
                                val_tpl: t.bool(),
                                pl_on: 'true',
                                pl_off: 'false',
                                ...disabled,
                            },
                        }),
                    );
                    consumed.add('STATE');
                }
                break;
            case 'switch_state':
                if (has('STATE') && !ch.transmitterFor) {
                    add(key('STATE'), e('STATE', 'binary_sensor', label, {extra: {val_tpl: t.bool(), en: false}}));
                    consumed.add('STATE');
                }
                if (ch.transmitterFor) {
                    consumed.add('STATE');
                }
                break;
            case 'dimmer':
                if (has('LEVEL')) {
                    add(
                        key('LEVEL'),
                        e('LEVEL', 'light', label, {
                            command: true,
                            extra: {
                                stat_t: sst('LEVEL'),
                                stat_val_tpl: `{{ 'ON' if (${t.float}) > 0 else 'OFF' }}`,
                                pl_on: 'ON',
                                pl_off: 'OFF',
                                on_cmd_type: 'brightness',
                                bri_cmd_t: scmd('LEVEL'),
                                bri_cmd_tpl: '{{ (value / 100) | round(3) }}',
                                bri_scl: 100,
                                bri_stat_t: sst('LEVEL'),
                                bri_val_tpl: t.percent,
                                ...disabled,
                            },
                        }),
                    );
                    consumed.add('LEVEL');
                }
                break;
            case 'dimmer_state':
                if (ch.transmitterFor) {
                    consumed.add('LEVEL');
                }
                break;
            case 'cover': {
                if (has('LEVEL')) {
                    const tilt = has('LEVEL_2');
                    const cover = e('LEVEL', 'cover', label, {
                        command: true,
                        extra: {
                            dev_cla: TILT_TYPES.test(ch.TYPE) ? 'blind' : 'shutter',
                            pl_open: 'OPEN',
                            pl_cls: 'CLOSE',
                            pl_stop: 'STOP',
                            pos_t: sst('LEVEL'),
                            pos_tpl: t.percent,
                            set_pos_t: scmd('LEVEL'),
                            set_pos_tpl: '{{ (position / 100) | round(3) }}',
                            pos_open: 100,
                            pos_clsd: 0,
                            ...(tilt && {
                                tilt_cmd_t: scmd('LEVEL_2'),
                                tilt_cmd_tpl: '{{ (tilt_position / 100) | round(3) }}',
                                tilt_status_t: sst('LEVEL_2'),
                                tilt_status_tpl: t.percent,
                            }),
                            ...disabled,
                        },
                    });
                    // The state comes from the LEVEL message alone, which says in its hm block
                    // whether and where the cover is moving: every message is a whole state. A
                    // state topic that only says moving/stopped makes Home Assistant decide between
                    // open and closed from the position it has at that moment, and the 'stopped'
                    // of ACTIVITY_STATE/DIRECTION is published before the last LEVEL (which waits
                    // for WORKING, lib/values.js) - a closed cover stayed 'open' (#35). Without
                    // the hm block there is no state topic: Home Assistant then takes open/closed
                    // from the position.
                    if (hm) {
                        cover.stat_t = sst('LEVEL');
                        cover.val_tpl = COVER_STATE_TEMPLATE;
                        cover.stat_open = 'open';
                        cover.stat_clsd = 'closed';
                        cover.stat_opening = 'opening';
                        cover.stat_closing = 'closing';
                    } else {
                        delete cover.stat_t;
                        delete cover.val_tpl;
                    }
                    add(key('LEVEL'), cover);
                    for (const dp of ['LEVEL', 'LEVEL_2', 'STOP']) {
                        consumed.add(dp);
                    }
                }
                break;
            }
            case 'cover_state':
                if (ch.transmitterFor) {
                    for (const dp of ['LEVEL', 'LEVEL_2', 'ACTIVITY_STATE', 'DIRECTION']) {
                        consumed.add(dp);
                    }
                }
                break;
            case 'contact':
                if (has('STATE')) {
                    add(
                        key('STATE'),
                        e('STATE', 'binary_sensor', label, {
                            extra: {
                                dev_cla:
                                    ch.TYPE === 'MULTI_MODE_INPUT_TRANSMITTER'
                                        ? 'opening'
                                        : ch.TYPE === 'TILT_SENSOR'
                                          ? 'moving'
                                          : 'window',
                                val_tpl: t.bool(),
                            },
                        }),
                    );
                    consumed.add('STATE');
                }
                break;
            case 'rotary_handle':
                if (has('STATE')) {
                    add(
                        key('STATE'),
                        e('STATE', 'binary_sensor', label, {
                            extra: {dev_cla: 'window', val_tpl: `{{ 'ON' if (${t.int}) != 0 else 'OFF' }}`},
                        }),
                    );
                    add(
                        key('STATE_text'),
                        e('STATE', 'sensor', `${label} handle`, {
                            uid: `${ch.index}_STATE_text`,
                            extra: {val_tpl: `{{ ['closed', 'tilted', 'open'][${t.int}] }}`, en: false},
                        }),
                    );
                    consumed.add('STATE');
                }
                break;
            case 'key': {
                const types = ['PRESS_SHORT', 'PRESS_LONG', 'PRESS_LONG_RELEASE', 'PRESS_CONT'].filter((dp) => has(dp));
                if (types.length > 0) {
                    add(
                        key('PRESS'),
                        e('PRESS', 'event', label, {
                            extra: {
                                dev_cla: 'button',
                                evt_typ: types.map((x) => x.toLowerCase()),
                                val_tpl: `{{ {'event_type': (${t.v} | string | lower)} | tojson }}`,
                            },
                        }),
                    );
                    for (const dp of types) {
                        consumed.add(dp);
                    }
                }
                break;
            }
            case 'climate_hmip':
                if (has('SET_POINT_TEMPERATURE')) {
                    const d = ch.description;
                    add(
                        key('CLIMATE'),
                        e('SET_POINT_TEMPERATURE', 'climate', label, {
                            uid: `${ch.index}_CLIMATE`,
                            extra: {
                                stat_t: undefined,
                                val_tpl: undefined,
                                temp_unit: 'C',
                                temp_step: 0.5,
                                min_temp: d.SET_POINT_TEMPERATURE.MIN ?? 4.5,
                                max_temp: d.SET_POINT_TEMPERATURE.MAX ?? 30.5,
                                temp_stat_t: own('SET_POINT_TEMPERATURE'),
                                temp_stat_tpl: t.num,
                                temp_cmd_t: scmd('SET_POINT_TEMPERATURE'),
                                ...(has('ACTUAL_TEMPERATURE') && {
                                    curr_temp_t: own('ACTUAL_TEMPERATURE'),
                                    curr_temp_tpl: t.num,
                                }),
                                ...(has('HUMIDITY') && {curr_hum_t: own('HUMIDITY'), curr_hum_tpl: t.num}),
                                modes: ['auto', 'heat'],
                                ...(has('SET_POINT_MODE') && {
                                    mode_stat_t: own('SET_POINT_MODE'),
                                    mode_stat_tpl: `{{ 'auto' if (${t.int}) == 0 else 'heat' }}`,
                                }),
                                ...(has('CONTROL_MODE') && {
                                    mode_cmd_t: scmd('CONTROL_MODE'),
                                    mode_cmd_tpl: "{{ 0 if value == 'auto' else 1 }}",
                                }),
                                ...(has('BOOST_MODE') && {
                                    pr_modes: ['boost'],
                                    pr_mode_stat_t: own('BOOST_MODE'),
                                    pr_mode_val_tpl: `{{ 'boost' if ${t.v} else 'none' }}`,
                                    pr_mode_cmd_t: scmd('BOOST_MODE'),
                                    pr_mode_cmd_tpl: "{{ 'true' if value == 'boost' else 'false' }}",
                                }),
                                ...(has('LEVEL') && {
                                    act_t: own('LEVEL'),
                                    act_tpl: `{{ 'heating' if (${t.float}) > 0 else 'idle' }}`,
                                }),
                            },
                        }),
                    );
                    for (const dp of [
                        'SET_POINT_TEMPERATURE',
                        'ACTUAL_TEMPERATURE',
                        'HUMIDITY',
                        'SET_POINT_MODE',
                        'CONTROL_MODE',
                        'BOOST_MODE',
                        'LEVEL',
                    ]) {
                        consumed.add(dp);
                    }
                }
                break;
            case 'climate_hm':
                if (has('SET_TEMPERATURE')) {
                    const d = ch.description;
                    add(
                        key('CLIMATE'),
                        e('SET_TEMPERATURE', 'climate', label, {
                            uid: `${ch.index}_CLIMATE`,
                            extra: {
                                stat_t: undefined,
                                val_tpl: undefined,
                                temp_unit: 'C',
                                temp_step: 0.5,
                                min_temp: d.SET_TEMPERATURE.MIN ?? 4.5,
                                max_temp: d.SET_TEMPERATURE.MAX ?? 30.5,
                                temp_stat_t: own('SET_TEMPERATURE'),
                                temp_stat_tpl: t.num,
                                temp_cmd_t: scmd('SET_TEMPERATURE'),
                                ...(has('ACTUAL_TEMPERATURE') && {
                                    curr_temp_t: own('ACTUAL_TEMPERATURE'),
                                    curr_temp_tpl: t.num,
                                }),
                                ...(has('ACTUAL_HUMIDITY') && {
                                    curr_hum_t: own('ACTUAL_HUMIDITY'),
                                    curr_hum_tpl: t.num,
                                }),
                                modes: ['auto', 'heat'],
                                ...(has('CONTROL_MODE') && {
                                    mode_stat_t: own('CONTROL_MODE'),
                                    mode_stat_tpl: `{{ 'heat' if (${t.int}) == 1 else 'auto' }}`,
                                    mode_cmd_t: scmd('CONTROL_MODE'),
                                    mode_cmd_tpl: "{{ 'AUTO-MODE' if value == 'auto' else 'MANU-MODE' }}",
                                    pr_modes: ['boost', 'comfort', 'eco'],
                                    pr_mode_stat_t: own('CONTROL_MODE'),
                                    pr_mode_val_tpl: `{{ 'boost' if (${t.int}) == 3 else 'none' }}`,
                                    pr_mode_cmd_t: scmd('CONTROL_MODE'),
                                    pr_mode_cmd_tpl:
                                        "{{ {'boost': 'BOOST-MODE', 'comfort': 'COMFORT-MODE', 'eco': 'LOWERING-MODE'}.get(value, 'AUTO-MODE') }}",
                                }),
                                ...(has('VALVE_STATE') && {
                                    act_t: own('VALVE_STATE'),
                                    act_tpl: `{{ 'heating' if (${t.int}) > 0 else 'idle' }}`,
                                }),
                            },
                        }),
                    );
                    for (const dp of [
                        'SET_TEMPERATURE',
                        'ACTUAL_TEMPERATURE',
                        'ACTUAL_HUMIDITY',
                        'CONTROL_MODE',
                        'BOOST_MODE',
                        'AUTO_MODE',
                        'MANU_MODE',
                        'COMFORT_MODE',
                        'LOWERING_MODE',
                    ]) {
                        consumed.add(dp);
                    }
                }
                break;
            case 'lock':
                if (has('STATE')) {
                    add(
                        key('STATE'),
                        e('STATE', 'lock', label, {
                            command: true,
                            extra: {
                                val_tpl: t.bool('UNLOCKED', 'LOCKED'),
                                stat_locked: 'LOCKED',
                                stat_unlocked: 'UNLOCKED',
                                pl_lock: 'false',
                                pl_unlk: 'true',
                            },
                        }),
                    );
                    consumed.add('STATE');
                }
                break;
            case 'smoke':
                if (has('SMOKE_DETECTOR_ALARM_STATUS')) {
                    add(
                        key('SMOKE'),
                        e('SMOKE_DETECTOR_ALARM_STATUS', 'binary_sensor', label, {
                            uid: `${ch.index}_SMOKE`,
                            extra: {dev_cla: 'smoke', val_tpl: `{{ 'ON' if (${t.int}) in (1, 3) else 'OFF' }}`},
                        }),
                    );
                    consumed.add('SMOKE_DETECTOR_ALARM_STATUS');
                } else if (has('STATE')) {
                    add(
                        key('STATE'),
                        e('STATE', 'binary_sensor', label, {extra: {dev_cla: 'smoke', val_tpl: t.bool()}}),
                    );
                    consumed.add('STATE');
                }
                break;
            case 'water':
                for (const dp of ['STATE', 'ALARMSTATE', 'MOISTURE_DETECTED', 'WATERLEVEL_DETECTED']) {
                    if (has(dp)) {
                        add(
                            key(dp),
                            e(
                                dp,
                                'binary_sensor',
                                dp === 'STATE' ? label : `${label} ${dp.toLowerCase().replace(/_/g, ' ')}`,
                                {extra: {dev_cla: 'moisture', val_tpl: t.bool()}},
                            ),
                        );
                        consumed.add(dp);
                    }
                }
                break;
            default:
                break;
        }

        // generic layer: everything else in the channel's VALUES description
        inGeneric = true;
        for (const [dp, d] of Object.entries(ch.description)) {
            if (
                consumed.has(dp) ||
                NOT_ANNOUNCED.has(dp) ||
                !d ||
                typeof d !== 'object' ||
                ignored(iface, ch.ADDRESS, dp)
            ) {
                continue;
            }
            const facts = PARAMETERS[dp] || {};
            const semantic = Boolean(facts.dev_cla || facts.enabled);
            if (!generic && !semantic) {
                continue;
            }
            const ops = typeof d.OPERATIONS === 'number' ? d.OPERATIONS : 5;
            const readable = Boolean(ops & 1) || Boolean(ops & 4);
            const writable = Boolean(ops & 2);
            const dpLabel = ch.index === 0 && ch.role === 'maintenance' ? prettify(dp) : `${label} ${prettify(dp)}`;
            const enabled = facts.enabled === true;
            const common = {
                ...(facts.dev_cla && {dev_cla: facts.dev_cla}),
                ...(facts.ent_cat && {ent_cat: facts.ent_cat}),
                ...(!enabled && {en: false}),
            };
            const unit = facts.unit || haUnit(d.UNIT);
            const value = isFraction(d) ? t.percent : t.num;
            if (d.TYPE === 'BOOL' || d.TYPE === 'ACTION') {
                if (writable && !readable) {
                    if (d.TYPE === 'ACTION') {
                        add(key(dp), e(dp, 'button', dpLabel, {command: true, extra: {pl_prs: 'true', ...common}}));
                    }
                    continue;
                }
                if (writable && d.TYPE === 'BOOL') {
                    add(
                        key(dp),
                        e(dp, 'switch', dpLabel, {
                            command: true,
                            extra: {val_tpl: t.bool(), pl_on: 'true', pl_off: 'false', ...common},
                        }),
                    );
                } else if (d.TYPE === 'BOOL') {
                    add(
                        key(dp),
                        e(dp, 'binary_sensor', dpLabel, {
                            extra: {val_tpl: facts.inverted ? t.bool('OFF', 'ON') : t.bool(), ...common},
                        }),
                    );
                }
                continue;
            }
            if (d.TYPE === 'ENUM' && Array.isArray(d.VALUE_LIST)) {
                if (writable) {
                    add(
                        key(dp),
                        e(dp, 'select', dpLabel, {
                            command: true,
                            extra: {
                                options: d.VALUE_LIST,
                                val_tpl: `{{ ${JSON.stringify(d.VALUE_LIST)}[${t.int}] }}`,
                                cmd_tpl: `{{ ${JSON.stringify(d.VALUE_LIST)}.index(value) }}`,
                                ...common,
                            },
                        }),
                    );
                } else if (readable) {
                    add(
                        key(dp),
                        e(dp, 'sensor', dpLabel, {
                            extra: {val_tpl: `{{ ${JSON.stringify(d.VALUE_LIST)}[${t.int}] }}`, ...common},
                        }),
                    );
                }
                continue;
            }
            if (d.TYPE === 'FLOAT' || d.TYPE === 'INTEGER') {
                if (writable && !readable) {
                    add(
                        key(dp),
                        e(dp, 'number', dpLabel, {
                            command: true,
                            extra: {
                                ...(typeof d.MIN === 'number' && {min: isFraction(d) ? d.MIN * 100 : d.MIN}),
                                ...(typeof d.MAX === 'number' && {
                                    max: isFraction(d) ? Math.min(d.MAX, 1) * 100 : d.MAX,
                                }),
                                step: d.TYPE === 'INTEGER' ? 1 : isFraction(d) ? 1 : 0.1,
                                ...(unit && {unit_of_meas: unit}),
                                ...(isFraction(d) && {cmd_tpl: '{{ (value / 100) | round(3) }}'}),
                                ...common,
                            },
                        }),
                    );
                    continue;
                }
                add(
                    key(dp),
                    e(dp, 'sensor', dpLabel, {
                        extra: {
                            val_tpl: value,
                            ...(unit && {unit_of_meas: unit}),
                            ...(facts.stat_cla && {stat_cla: facts.stat_cla}),
                            ...common,
                        },
                    }),
                );
                continue;
            }
            if (d.TYPE === 'STRING' && readable) {
                add(key(dp), e(dp, 'sensor', dpLabel, {extra: {val_tpl: t.num, ...common}}));
            }
        }
    }

    if (Object.keys(components).length === 0) {
        return null;
    }
    const avty = [...availability(name, 2)];
    if (maintenance && maintenance.description.UNREACH && !ignored(iface, maintenance.ADDRESS, 'UNREACH')) {
        // the template of an entry of an availability *list* is `val_tpl`; `avty_tpl` expands to
        // `availability_template`, which Home Assistant's schema for such an entry does not allow
        // - and it refuses the whole device payload over it (mqtt-interfaces-core 0.15.2)
        avty.push({t: st(iface, maintenance.ADDRESS, 'UNREACH'), val_tpl: t.bool('offline', 'online')});
    }
    const placed = placeUnits(ctx, {id, device, deviceName, channels, components, origins, area});
    return {
        id,
        device: {
            name: deviceName,
            mf: 'eQ-3',
            mdl: device.TYPE,
            ...(device.FIRMWARE && {sw: String(device.FIRMWARE)}),
            via_device: bridgeId,
            ...(area && {sa: area}),
        },
        components: placed.parent,
        ...(placed.children.length > 0 && {children: placed.children}),
        availability: avty,
        availabilityMode: 'all',
        own: placed.own,
        all: components,
        unknown: new Set(channels.filter((ch) => !ch.described).map((ch) => ch.index)),
        address: device.ADDRESS,
    };
}

/** the values of `--ha-channel-devices` and of a device's `split` in `--ha-overrides` (task 32) */
const MODELS = new Set(['off', 'children', 'devices']);
/** where a unit goes: on the device, a child device in its payload, a device of its own */
const PLACES = new Set(['parent', 'child', 'own']);

/**
 * The `--ha-overrides` file in the form the discovery uses: per device address its `split` and per
 * channel index `{publish, device}`. The file's keys are device addresses (`{split}`) and channel
 * addresses (`{publish, device}`).
 * @param {object} file the parsed JSON
 * @returns {Object<string, {split?: string, channels?: Object<number, {publish?: boolean, device?: string}>}>}
 */
export function normalizeOverrides(file) {
    const out = {};
    for (const [address, entry] of Object.entries(file || {})) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const [device, index] = String(address).split(':');
        out[device] = out[device] || {};
        if (index === undefined) {
            if (MODELS.has(entry.split)) {
                out[device].split = entry.split;
            }
            continue;
        }
        const channel = {};
        if (entry.publish === false) {
            channel.publish = false;
        }
        if (PLACES.has(entry.device)) {
            channel.device = entry.device;
        }
        out[device].channels = {...out[device].channels, [Number(index)]: channel};
    }
    return out;
}

/**
 * The channels of a device grouped into units: a channel with the channels of its family (an HmIP
 * transmitter with its virtual receivers, a dimmer with its virtual dimmers). A unit is a
 * *function* unit when one of its components is a role's entity rather than a generic datapoint;
 * the maintenance channel `:0` never is. A unit with a channel whose description is not there yet
 * may well be one (`unknown`), so a device does not collapse into one while metadata is incomplete.
 */
export function deviceUnits(channels, origins) {
    const units = new Map();
    for (const ch of channels) {
        const head = ch.family || ch;
        if (!units.has(head.index)) {
            units.set(head.index, {head, channels: [], keys: [], function: false});
        }
        units.get(head.index).channels.push(ch);
    }
    for (const [key, origin] of Object.entries(origins)) {
        const unit = units.get((origin.ch.family || origin.ch).index);
        unit.keys.push(key);
        if (origin.role && unit.head.index !== 0) {
            unit.function = true;
        }
    }
    for (const unit of units.values()) {
        unit.unknown = unit.head.index !== 0 && unit.channels.some((ch) => ch.described === false);
    }
    return units;
}

/**
 * Where each unit of a device goes: `drop` (not published), `parent`, `child` or `own`. A channel's
 * own setting wins, then the device's `split`, then `--ha-channel-devices`; a model other than `off`
 * moves the function units, and only on a device with two or more of them (a plug or a contact
 * stays one device). The maintenance channel stays on the device. Without child device support in
 * the core (`ctx.childDevices === false`) a unit meant for a child stays on the device.
 */
export function placement(ctx, deviceAddress, units) {
    const config = (ctx.overrides && ctx.overrides[deviceAddress]) || {};
    const model = MODELS.has(config.split) ? config.split : MODELS.has(ctx.channelDevices) ? ctx.channelDevices : 'off';
    const functions = [...units.values()].filter((unit) => unit.function || unit.unknown).length;
    const places = new Map();
    for (const [index, unit] of units) {
        const own = (config.channels && config.channels[index]) || {};
        let place;
        if (own.publish === false) {
            place = 'drop';
        } else if (index === 0) {
            place = 'parent';
        } else if (PLACES.has(own.device)) {
            place = own.device;
        } else if (model !== 'off' && functions >= 2 && unit.function) {
            place = model === 'children' ? 'child' : 'own';
        } else {
            place = 'parent';
        }
        places.set(index, place === 'child' && ctx.childDevices === false ? 'parent' : place);
    }
    return places;
}

/** a unit's channel whose name is a name of its own (not the CCU's default `<device> <address>:<n>`) */
function namedChannel(unit) {
    return [unit.head, ...unit.channels.filter((ch) => ch !== unit.head && !ch.secondary)].find(
        (ch) => ch.label && ch.label !== `Channel ${ch.index}` && !/^\d+$/.test(ch.label),
    );
}

/**
 * The name of an entity on a child or an own device: the channel's part goes - the channel's main
 * entity has no name of its own (`null`, Home Assistant names it after the device), the others
 * keep their datapoint or role label. Secondary channels of a family keep their channel's label.
 */
function shortName(name, ch) {
    if (ch.secondary || typeof name !== 'string' || !ch.label) {
        return name;
    }
    if (name === ch.label) {
        return null;
    }
    if (name.startsWith(ch.label + ' ')) {
        const rest = name.slice(ch.label.length + 1);
        return rest[0].toUpperCase() + rest.slice(1);
    }
    return name;
}

/**
 * Splits the components of a device into the device's own, its child devices and devices of their
 * own, by the units' placement. With the model `off` and no overrides every component stays on the
 * device, in its order - the payload is the one of before.
 */
function placeUnits(ctx, {id, device, deviceName, channels, components, origins, area}) {
    const units = deviceUnits(channels, origins);
    const places = placement(ctx, device.ADDRESS, units);
    const placeOf = (key) => places.get((origins[key].ch.family || origins[key].ch).index);
    const parent = {};
    for (const key of Object.keys(components)) {
        if (placeOf(key) === 'parent') {
            parent[key] = components[key];
        }
    }
    const moved = (unit) => {
        const out = {};
        for (const key of Object.keys(components)) {
            if (unit.keys.includes(key)) {
                out[key] = {...components[key], name: shortName(components[key].name, origins[key].ch)};
            }
        }
        return out;
    };
    const children = [];
    const own = [];
    for (const [index, unit] of units) {
        const place = places.get(index);
        if ((place !== 'child' && place !== 'own') || unit.keys.length === 0) {
            continue;
        }
        const named = namedChannel(unit);
        const childId = `${id}_${index}`;
        if (place === 'child') {
            children.push({id: childId, name: named ? named.label : `Channel ${index}`, components: moved(unit)});
            continue;
        }
        const rest = unit.channels.filter((ch) => ch !== unit.head);
        const ownArea = ctx.area === false ? undefined : suggestedArea(ctx.rooms, unit.head.ADDRESS, rest) || area;
        own.push({
            id: childId,
            device: {
                name: named ? named.name || named.label : `${deviceName} Channel ${index}`,
                mf: 'eQ-3',
                mdl: device.TYPE,
                ...(device.FIRMWARE && {sw: String(device.FIRMWARE)}),
                via_device: id,
                ...(ownArea && {sa: ownArea}),
            },
            components: moved(unit),
        });
    }
    return {parent, children, own};
}

/**
 * HmIP actuators: a *_TRANSMITTER channel (state) followed by three *_VIRTUAL_RECEIVER channels
 * (control). The first receiver becomes the control entity with the transmitter's state topic,
 * the others are secondary (disabled by default) — H-25. `family` names the first channel of the
 * group a channel belongs to (the transmitter, the first receiver of a block, the real dimmer) - one
 * unit when channels become Home Assistant devices of their own (task 32).
 */
export function resolveVirtualReceivers(channels) {
    const families = [
        {transmitter: 'switch_state', receiver: 'switch'},
        {transmitter: 'dimmer_state', receiver: 'dimmer'},
        {transmitter: 'cover_state', receiver: 'cover'},
    ];
    for (const {transmitter, receiver} of families) {
        let current = null;
        let block = null;
        let count = 0;
        for (const ch of channels) {
            if (ch.role === transmitter && /_TRANSMITTER$/.test(ch.TYPE)) {
                current = ch;
                count = 0;
                continue;
            }
            if (ch.role === receiver && /_VIRTUAL_RECEIVER$/.test(ch.TYPE) && current) {
                count += 1;
                ch.stateChannel = current;
                ch.family = current;
                if (count === 1) {
                    current.transmitterFor = ch;
                } else {
                    ch.secondary = true;
                }
            } else if (ch.role === receiver && /_VIRTUAL_RECEIVER$/.test(ch.TYPE)) {
                // standalone receiver blocks without a transmitter: first of three is primary
                count += 1;
                if (count > 1 && (count - 1) % 3 !== 0) {
                    ch.secondary = true;
                    ch.family = block;
                } else {
                    block = ch;
                }
            }
        }
    }
    // HM virtual dimmers (HM-LC-Dim1TPBU-FM ch 2/3) are secondaries of channel 1
    let dimmer = null;
    for (const ch of channels) {
        if (ch.TYPE === 'DIMMER') {
            dimmer = ch;
        }
        if (ch.TYPE === 'VIRTUAL_DIMMER') {
            ch.secondary = true;
            if (dimmer) {
                ch.family = dimmer;
            }
        }
    }
}

function prettify(dp) {
    return dp
        .toLowerCase()
        .split('_')
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');
}
