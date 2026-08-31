import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {discoveryModel, resolveVirtualReceivers} from '../lib/hadiscovery.js';
import {Metadata} from '../lib/metadata.js';
import {createLogger} from 'mqtt-interfaces-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger({format: 'journal', level: 'error', write: () => {}});

// one device per type of a real CCU (BidCos-RF, BidCos-Wired, HmIP-RF, VirtualDevices) + their VALUES descriptions
const devices = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'devices.json'), 'utf8'));
const metadata = new Metadata({stateDir: '/nonexistent', seedFile: path.join(here, 'fixtures', 'paramsets.json'), log});
metadata.load();
for (const [iface, list] of Object.entries(devices)) {
    metadata.addDevices(iface, Object.values(list));
}

const names = {};
for (const list of Object.values(devices)) {
    for (const d of Object.values(list)) {
        names[d.ADDRESS] = d.PARENT
            ? `${d.PARENT_TYPE} ${d.PARENT}:${d.ADDRESS.split(':')[1]}`
            : `${d.TYPE} ${d.ADDRESS}`;
    }
}

const ctx = (extra = {}) => ({
    adapterName: 'hm2mqtt',
    name: 'hm',
    jsonPayloads: true,
    devices: metadata.devices,
    description: (iface, address) => metadata.description(iface, address, 'VALUES'),
    channelName: (address) => names[address],
    rooms: (address) => (address.endsWith(':1') ? ['Flur'] : undefined),
    statusTopicFor: (iface, address, datapoint) => `hm/status/${names[address] || address}/${datapoint}`,
    setTopicFor: (iface, address, datapoint) => `hm/set/${names[address] || address}/${datapoint}`,
    interfaces: ['BidCos-RF', 'HmIP-RF'],
    ...extra,
});

const byModel = (blocks, model) => blocks.find((b) => b.device && b.device.mdl === model);
const REQUIRED = {
    switch: ['cmd_t', 'stat_t'],
    light: ['cmd_t', 'stat_t'],
    cover: ['cmd_t', 'pos_t'],
    climate: ['temp_cmd_t', 'temp_stat_t'],
    lock: ['cmd_t', 'stat_t'],
    event: ['stat_t', 'evt_typ'],
    binary_sensor: ['stat_t'],
    sensor: ['stat_t'],
    select: ['cmd_t', 'options'],
    number: ['cmd_t'],
    button: ['cmd_t'],
};

describe('discoveryModel', () => {
    const blocks = discoveryModel(ctx());

    test('every device of the real CCU yields a block with well-formed components', () => {
        const deviceCount = Object.values(devices).reduce(
            (n, l) => n + Object.values(l).filter((d) => !d.PARENT).length,
            0,
        );
        assert.equal(blocks.length, deviceCount + 1); // + bridge
        const ids = new Set();
        let entities = 0;
        for (const b of blocks) {
            assert.ok(b.id && !ids.has(b.id), 'unique block id ' + b.id);
            ids.add(b.id);
            const uniq = new Set();
            for (const [key, c] of Object.entries(b.components)) {
                entities += 1;
                assert.ok(c.p && c.uniq_id && c.name, `${b.id} ${key}: p/uniq_id/name`);
                assert.ok(!uniq.has(c.uniq_id), `${b.id}: duplicate uniq_id ${c.uniq_id}`);
                uniq.add(c.uniq_id);
                assert.ok(REQUIRED[c.p], `${b.id} ${key}: platform ${c.p}`);
                for (const field of REQUIRED[c.p]) {
                    assert.ok(c[field] !== undefined, `${b.id} ${key} (${c.p}): missing ${field}`);
                }
                for (const [f, v] of Object.entries(c)) {
                    if (typeof v === 'string' && v.includes('{{')) {
                        assert.equal(
                            (v.match(/\{\{/g) || []).length,
                            (v.match(/\}\}/g) || []).length,
                            `${b.id} ${key} ${f}: unbalanced template`,
                        );
                        assert.equal(
                            (v.match(/\{%/g) || []).length,
                            (v.match(/%\}/g) || []).length,
                            `${b.id} ${key} ${f}: unbalanced block`,
                        );
                    }
                    if (typeof v === 'string' && /^(hm\/status|hm\/set)/.test(v)) {
                        assert.ok(!v.includes('undefined'), `${b.id} ${key} ${f}: ${v}`);
                    }
                }
            }
        }
        assert.ok(entities > 500, 'entities: ' + entities);
    });

    test('bridge device: interfaces and counters', () => {
        const bridge = blocks[0];
        assert.equal(bridge.id, 'hm2mqtt_hm');
        assert.equal(bridge.components['iface_BidCos-RF'].stat_t, 'hm/status/interface/BidCos-RF/connected');
        assert.equal(bridge.components['iface_BidCos-RF'].dev_cla, 'connectivity');
        assert.equal(bridge.components['counter_HmIP-RF_rx'].en, false);
    });

    test('HM switch with power meter (HM-ES-PMSw1-Pl)', () => {
        const b = byModel(blocks, 'HM-ES-PMSw1-Pl');
        assert.equal(b.device.via_device, 'hm2mqtt_hm');
        assert.equal(b.device.mf, 'eQ-3');
        assert.equal(b.device.sa, 'Flur');
        assert.equal(b.availabilityMode, 'all');
        assert.equal(b.availability.length, 2);
        assert.match(b.availability[1].t, /:0\/UNREACH$/);
        const sw = b.components['1_STATE'];
        assert.equal(sw.p, 'switch');
        assert.equal(sw.pl_on, 'true');
        assert.match(sw.cmd_t, /^hm\/set\/.*:1\/STATE$/);
        assert.equal(sw.en, undefined);
        const power = b.components['2_POWER'];
        assert.equal(power.p, 'sensor');
        assert.equal(power.dev_cla, 'power');
        assert.equal(power.unit_of_meas, 'W');
        assert.equal(power.en, undefined);
        const energy = b.components['2_ENERGY_COUNTER'];
        assert.equal(energy.stat_cla, 'total_increasing');
        assert.equal(b.components['0_LOWBAT'], undefined); // mains powered
        assert.equal(byModel(blocks, 'HM-Sec-SC').components['0_LOWBAT'].dev_cla, 'battery');
        assert.equal(byModel(blocks, 'HmIP-SRH').components['0_LOW_BAT'].en, undefined);
        assert.equal(b.components['0_RSSI_DEVICE'].en, false);
        assert.equal(b.components['0_RSSI_DEVICE'].ent_cat, 'diagnostic');
        assert.equal(b.components['0_UNREACH'].val_tpl, "{{ 'OFF' if value_json.val else 'ON' }}");
    });

    test('HmIP switch actuator: transmitter state, first receiver primary, others disabled', () => {
        const b = byModel(blocks, 'HmIP-BSM');
        const primary = b.components['4_STATE'];
        assert.equal(primary.p, 'switch');
        assert.match(primary.stat_t, /:3\/STATE$/); // SWITCH_TRANSMITTER
        assert.match(primary.cmd_t, /:4\/STATE$/);
        assert.equal(primary.en, undefined);
        assert.equal(b.components['5_STATE'].en, false);
        assert.equal(b.components['6_STATE'].en, false);
        assert.equal(b.components['3_STATE'], undefined); // consumed by the receiver
        assert.equal(b.components['1_PRESS'].p, 'event');
        assert.deepEqual(b.components['1_PRESS'].evt_typ, ['press_short', 'press_long', 'press_long_release']);
        assert.equal(b.components['7_POWER'].dev_cla, 'power');
    });

    test('dimmers: HM light and HmIP light with transmitter state', () => {
        const hm = byModel(blocks, 'HM-LC-Dim1L-CV').components['1_LEVEL'];
        assert.equal(hm.p, 'light');
        assert.equal(hm.on_cmd_type, 'brightness');
        assert.equal(hm.bri_scl, 100);
        assert.match(hm.bri_cmd_t, /:1\/LEVEL$/);
        assert.match(hm.bri_val_tpl, /\* 100/);
        const bdt = byModel(blocks, 'HmIP-BDT');
        assert.match(bdt.components['4_LEVEL'].stat_t, /:3\/LEVEL$/);
        assert.equal(bdt.components['5_LEVEL'].en, false);
        const combined = byModel(blocks, 'HM-LC-Dim1TPBU-FM');
        assert.equal(combined.components['1_LEVEL'].en, undefined);
        assert.equal(combined.components['2_LEVEL'].en, false); // VIRTUAL_DIMMER
    });

    test('covers: HM blind with direction, HmIP blind with tilt', () => {
        const hm = byModel(blocks, 'HM-LC-Bl1-FM').components['1_LEVEL'];
        assert.equal(hm.p, 'cover');
        assert.equal(hm.dev_cla, 'blind');
        assert.equal(hm.pl_stop, 'STOP');
        assert.match(hm.stat_t, /:1\/DIRECTION$/);
        assert.match(hm.set_pos_tpl, /position \/ 100/);
        assert.equal(hm.tilt_cmd_t, undefined);
        const ip = byModel(blocks, 'HmIP-FBL').components['4_LEVEL'];
        assert.match(ip.pos_t, /:3\/LEVEL$/);
        assert.match(ip.stat_t, /:3\/ACTIVITY_STATE$/);
        assert.match(ip.tilt_cmd_t, /:4\/LEVEL_2$/);
        assert.match(ip.tilt_status_t, /:3\/LEVEL_2$/);
    });

    test('climate: HmIP thermostat and HM radiator thermostat', () => {
        const ip = byModel(blocks, 'HmIP-eTRV-2').components['1_CLIMATE'];
        assert.equal(ip.p, 'climate');
        assert.match(ip.temp_cmd_t, /:1\/SET_POINT_TEMPERATURE$/);
        assert.match(ip.curr_temp_t, /:1\/ACTUAL_TEMPERATURE$/);
        assert.deepEqual(ip.modes, ['auto', 'heat']);
        assert.match(ip.mode_cmd_t, /:1\/CONTROL_MODE$/);
        assert.match(ip.mode_stat_t, /:1\/SET_POINT_MODE$/);
        assert.deepEqual(ip.pr_modes, ['boost']);
        assert.equal(ip.min_temp, 4.5);
        assert.equal(ip.max_temp, 30.5);
        assert.match(ip.act_t, /:1\/LEVEL$/);
        const wth = byModel(blocks, 'HmIP-WTH-2').components['1_CLIMATE'];
        assert.match(wth.curr_hum_t, /:1\/HUMIDITY$/);
        const hm = byModel(blocks, 'HM-CC-RT-DN').components['4_CLIMATE'];
        assert.match(hm.temp_cmd_t, /:4\/SET_TEMPERATURE$/);
        assert.match(hm.mode_cmd_tpl, /AUTO-MODE/);
        assert.deepEqual(hm.pr_modes, ['boost', 'comfort', 'eco']);
        assert.match(hm.act_t, /:4\/VALVE_STATE$/);
        const wall = byModel(blocks, 'HM-TC-IT-WM-W-EU').components['2_CLIMATE'];
        assert.match(wall.curr_hum_t, /:2\/ACTUAL_HUMIDITY$/);
    });

    test('contacts, rotary handles, motion, smoke, lock, keys', () => {
        const sc = byModel(blocks, 'HM-Sec-SC').components['1_STATE'];
        assert.equal(sc.p, 'binary_sensor');
        assert.equal(sc.dev_cla, 'window');
        const swdo = byModel(blocks, 'HMIP-SWDO').components['1_STATE'];
        assert.equal(swdo.dev_cla, 'window');
        const srh = byModel(blocks, 'HmIP-SRH');
        assert.match(srh.components['1_STATE'].val_tpl, /!= 0/);
        assert.equal(srh.components['1_STATE_text'].p, 'sensor');
        const motion = byModel(blocks, 'HM-Sec-MDIR');
        assert.equal(motion.components['1_MOTION'].dev_cla, 'motion');
        assert.equal(motion.components['1_BRIGHTNESS'].p, 'sensor');
        assert.equal(byModel(blocks, 'HM-Sec-SD').components['1_STATE'].dev_cla, 'smoke');
        const lock = byModel(blocks, 'HM-Sec-Key').components['1_STATE'];
        assert.equal(lock.p, 'lock');
        assert.equal(lock.pl_lock, 'false');
        const rc = byModel(blocks, 'HM-RC-4-2');
        assert.equal(rc.components['1_PRESS'].p, 'event');
        assert.match(rc.components['1_PRESS'].stat_t, /:1\/PRESS$/);
        assert.match(rc.components['1_PRESS'].val_tpl, /event_type/);
        assert.equal(byModel(blocks, 'HmIP-DRSI4').components['1_STATE'].dev_cla, 'opening');
    });

    test('generic layer: enums as select/sensor, numbers, disabled by default; --no-ha-generic drops them', () => {
        const trv = byModel(blocks, 'HM-CC-RT-DN');
        const boost = trv.components['4_BOOST_STATE'];
        assert.equal(boost.p, 'sensor');
        assert.equal(boost.unit_of_meas, 'min');
        assert.equal(boost.en, false);
        const wind = byModel(blocks, 'HM-WDS100-C6-O').components['1_WIND_SPEED'];
        assert.equal(wind.dev_cla, 'wind_speed');
        assert.equal(wind.en, undefined);
        const sound = byModel(blocks, 'HmIP-MP3P').components['2_SOUNDFILE'];
        assert.equal(sound.p, 'select');
        assert.ok(sound.options.length > 100);
        assert.match(sound.cmd_tpl, /index\(value\)/);
        const without = discoveryModel(ctx({generic: false}));
        const count = (list) => list.reduce((n, b) => n + Object.keys(b.components).length, 0);
        assert.ok(count(without) < count(blocks) / 2);
        assert.equal(byModel(without, 'HM-CC-RT-DN').components['4_BOOST_STATE'], undefined);
        assert.ok(byModel(without, 'HM-ES-PMSw1-Pl').components['2_POWER']);
    });

    test('ignore filter and plain payload templates', () => {
        const filtered = discoveryModel(ctx({ignored: (iface, ch, dp) => dp.startsWith('RSSI_')}));
        assert.equal(byModel(filtered, 'HM-ES-PMSw1-Pl').components['0_RSSI_DEVICE'], undefined);
        const plain = discoveryModel(ctx({jsonPayloads: false}));
        const sw = byModel(plain, 'HM-ES-PMSw1-Pl').components['1_STATE'];
        assert.doesNotMatch(sw.val_tpl, /value_json/);
        assert.equal(sw.val_tpl.includes("'1', 'true', 'on'"), true);
    });

    test('resolveVirtualReceivers', () => {
        const chs = [
            {index: 3, TYPE: 'SWITCH_TRANSMITTER', role: 'switch_state'},
            {index: 4, TYPE: 'SWITCH_VIRTUAL_RECEIVER', role: 'switch'},
            {index: 5, TYPE: 'SWITCH_VIRTUAL_RECEIVER', role: 'switch'},
            {index: 6, TYPE: 'SWITCH_VIRTUAL_RECEIVER', role: 'switch'},
            {index: 7, TYPE: 'DIMMER_TRANSMITTER', role: 'dimmer_state'},
            {index: 8, TYPE: 'DIMMER_VIRTUAL_RECEIVER', role: 'dimmer'},
        ];
        resolveVirtualReceivers(chs);
        assert.equal(chs[1].stateChannel, chs[0]);
        assert.equal(chs[0].transmitterFor, chs[1]);
        assert.equal(chs[1].secondary, undefined);
        assert.equal(chs[2].secondary, true);
        assert.equal(chs[3].secondary, true);
        assert.equal(chs[5].stateChannel, chs[4]);
    });
});
