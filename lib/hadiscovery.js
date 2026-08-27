/**
 * Home Assistant discovery: one HA device per Homematic device (ROADMAP §13, H-22…H-26),
 * composite entities from the channel roles (light, cover, climate, lock, event, switch, ...)
 * and generic entities for every other datapoint (disabled by default). Pure: devices,
 * descriptions and names in, device blocks for the core's discovery() out.
 */

import {entity, availability, discoveryId} from 'mqtt-interfaces-core';
import {channelRole, haUnit, isFraction, PARAMETERS} from './roles.js';

const TILT_TYPES = /BLIND/;

/**
 * @typedef {object} DiscoveryContext
 * @property {string} adapterName package name (hm2mqtt)
 * @property {string} name instance name / topic prefix
 * @property {boolean} jsonPayloads
 * @property {boolean} [generic] generic entities for datapoints without a role (default true)
 * @property {Object<string, Object<string, object>>} devices metadata.devices (iface → address → device)
 * @property {(iface: string, address: string) => object | undefined} description VALUES description of a channel
 * @property {(address: string) => string | undefined} channelName
 * @property {(address: string) => string[] | undefined} rooms
 * @property {(iface: string, address: string, datapoint: string) => string} itemFor rendered item of a datapoint
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
    const {adapterName, name, jsonPayloads: json = true, devices, itemFor} = ctx;
    const ignored = ctx.ignored || (() => false);
    const t = templates(json);
    const bridgeId = discoveryId(adapterName, name);
    const st = (iface, address, dp) => `${name}/status/${itemFor(iface, address, dp)}`;
    const cmd = (iface, address, dp) => `${name}/set/${itemFor(iface, address, dp)}`;
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

function deviceBlock({iface, device, list, ctx, t, st, cmd, bridgeId, ignored}) {
    const {adapterName, name, jsonPayloads: json = true, generic = true} = ctx;
    const id = discoveryId(adapterName, `${name}_${device.ADDRESS}`);
    const deviceName = ctx.channelName(device.ADDRESS) || device.ADDRESS;
    const channels = (device.CHILDREN || [])
        .map((address) => list[address])
        .filter(Boolean)
        .map((ch) => ({
            ...ch,
            index: Number.parseInt(String(ch.ADDRESS).split(':')[1], 10),
            name: ctx.channelName(ch.ADDRESS),
            description: ctx.description(iface, ch.ADDRESS) || {},
        }))
        .sort((a, b) => a.index - b.index);
    for (const ch of channels) {
        ch.role = channelRole(ch.TYPE, ch.description);
    }
    resolveVirtualReceivers(channels);

    const components = {};
    const add = (key, e) => {
        components[key] = e;
    };
    const rooms = new Set();
    for (const ch of channels) {
        for (const r of ctx.rooms(ch.ADDRESS) || []) {
            rooms.add(r);
        }
    }
    const maintenance = channels.find((ch) => ch.index === 0);

    for (const ch of channels) {
        const consumed = new Set();
        const e = (dp, platform, label, more = {}) =>
            entity({
                id,
                name,
                item: ctx.itemFor(iface, ch.ADDRESS, dp),
                platform,
                label,
                uid: `${ch.index}_${dp}`,
                jsonPayloads: json,
                ...more,
            });
        const fallback = ch.index === 0 ? 'Maintenance' : `Channel ${ch.index}`;
        const label = labelOf(ch, deviceName, fallback);
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
                    const direction = stateCh.description.ACTIVITY_STATE
                        ? 'ACTIVITY_STATE'
                        : stateCh.description.DIRECTION
                          ? 'DIRECTION'
                          : null;
                    add(
                        key('LEVEL'),
                        e('LEVEL', 'cover', label, {
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
                                ...(direction && {
                                    stat_t: sst(direction),
                                    val_tpl: `{% set d = ${t.int} %}{{ 'opening' if d == 1 else 'closing' if d == 2 else 'stopped' }}`,
                                    stat_opening: 'opening',
                                    stat_closing: 'closing',
                                    stat_stopped: 'stopped',
                                }),
                                ...(tilt && {
                                    tilt_cmd_t: scmd('LEVEL_2'),
                                    tilt_cmd_tpl: '{{ (tilt_position / 100) | round(3) }}',
                                    tilt_status_t: sst('LEVEL_2'),
                                    tilt_status_tpl: t.percent,
                                }),
                                ...disabled,
                            },
                        }),
                    );
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
        for (const [dp, d] of Object.entries(ch.description)) {
            if (consumed.has(dp) || !d || typeof d !== 'object' || ignored(iface, ch.ADDRESS, dp)) {
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
        avty.push({t: st(iface, maintenance.ADDRESS, 'UNREACH'), avty_tpl: t.bool('offline', 'online')});
    }
    return {
        id,
        device: {
            name: deviceName,
            mf: 'eQ-3',
            mdl: device.TYPE,
            ...(device.FIRMWARE && {sw: String(device.FIRMWARE)}),
            via_device: bridgeId,
            ...(rooms.size === 1 && {sa: [...rooms][0]}),
        },
        components,
        availability: avty,
        availabilityMode: 'all',
    };
}

/**
 * HmIP actuators: a *_TRANSMITTER channel (state) followed by three *_VIRTUAL_RECEIVER channels
 * (control). The first receiver becomes the control entity with the transmitter's state topic,
 * the others are secondary (disabled by default) — H-25.
 */
export function resolveVirtualReceivers(channels) {
    const families = [
        {transmitter: 'switch_state', receiver: 'switch'},
        {transmitter: 'dimmer_state', receiver: 'dimmer'},
        {transmitter: 'cover_state', receiver: 'cover'},
    ];
    for (const {transmitter, receiver} of families) {
        let current = null;
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
                }
            }
        }
    }
    // HM virtual dimmers (HM-LC-Dim1TPBU-FM ch 2/3) are secondaries of channel 1
    for (const ch of channels) {
        if (ch.TYPE === 'VIRTUAL_DIMMER') {
            ch.secondary = true;
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
