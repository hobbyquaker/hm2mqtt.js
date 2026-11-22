/* task 32: Homematic channels as Home Assistant devices - `--ha-channel-devices off` (the payloads
   of before, byte for byte), `children` (child devices; the core builds `cdevs` from a block's
   `children`), `devices` (devices of their own), `--ha-overrides`, and the removal of what a run no
   longer publishes. */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {devicePayload} from 'mqtt-interfaces-core';
import {VALUE_TEMPLATE} from 'mqtt-interfaces-core/hadiscovery';
import {allKnown, ctxFor, fixture, VARIANTS, SNAPSHOT_ROOMS} from './helpers/hafixtures.js';
import {discoveryBlocks, discoveryModel, normalizeOverrides, placement} from '../lib/hadiscovery.js';
import {HaRecord, recordedDiscovery} from '../lib/harecord.js';

const pkg = {name: 'hm2mqtt', version: '0.0.0-test'};

/** what the core publishes for a block (0.17: without `cdevs`) */
const payloadOf = (b) =>
    devicePayload({
        pkg,
        name: 'hm',
        prefix: 'homeassistant',
        id: b.id,
        device: b.device,
        components: b.components,
        availability: b.availability,
        availabilityMode: b.availabilityMode,
    });

/**
 * The core contract hm2mqtt needs for `children` (the she-agent item): a block's
 * `children: [{id, name, components}]` becomes `cdevs: [{ids: [id], name, cmps}]` after `cmps`.
 */
const withChildren = (b) => {
    const message = payloadOf(b);
    if (b.children && b.children.length > 0) {
        message.payload.cdevs = b.children.map((c) => ({ids: [c.id], name: c.name, cmps: c.components}));
    }
    return message;
};

const drsi4 = () => {
    const types = ['MAINTENANCE'];
    for (let i = 0; i < 4; i++) {
        types.push('MULTI_MODE_INPUT_TRANSMITTER');
    }
    for (let i = 0; i < 4; i++) {
        types.push(
            'SWITCH_TRANSMITTER',
            'SWITCH_VIRTUAL_RECEIVER',
            'SWITCH_VIRTUAL_RECEIVER',
            'SWITCH_VIRTUAL_RECEIVER',
        );
    }
    return fixture('HmIP-RF', 'DRS0001', 'HmIP-DRSI4', '1.4.2', 1, types, {
        DRS0001: 'Verteiler',
        'DRS0001:1': 'Verteiler:1',
        'DRS0001:5': 'Verteiler Flurlicht',
        'DRS0001:9': 'Küche Decke',
    });
};

const sw2 = () =>
    fixture('BidCos-RF', 'LEQ1000', 'HM-LC-Sw2-FM', '2.8', 26, ['MAINTENANCE', 'SWITCH', 'SWITCH'], {
        LEQ1000: 'Schalter',
        'LEQ1000:1': 'Schalter Flur',
        'LEQ1000:2': 'Schalter Keller',
    });

const devicesOf = (blocks) => blocks.filter((b) => b.id !== 'hm2mqtt_hm');
const ID = (addr) => `hm2mqtt_hm_${addr}`;

/* The payload of every device type paramsets.json knows, in four option variants, as hm2mqtt
   3.10.3 published it (sha256 of the JSON) - the default model must not change a byte. */
const BEFORE = '7bf07444dc304d6a510ff8ce0e959eb7c89ecb9abc27c1918157d397426d2806';

test('off (the default): the payloads of before, byte for byte, for every known device type', () => {
    for (const model of [undefined, 'off', 'bogus']) {
        const out = {};
        for (const [name, options] of Object.entries(VARIANTS)) {
            const r = discoveryBlocks(ctxFor(allKnown(), {...options, rooms: SNAPSHOT_ROOMS, channelDevices: model}));
            assert.deepEqual(r.clear, []);
            out[name] = r.blocks.map(payloadOf);
        }
        // mqtt-interfaces-core 0.17.1 changed its default state template (a JSON boolean renders as
        // true/false); with the template of before put back the payloads are 3.10.3's exactly
        const json = JSON.stringify(out)
            .split(JSON.stringify(VALUE_TEMPLATE))
            .join(JSON.stringify('{{ value_json.val }}'));
        const hash = crypto.createHash('sha256').update(json).digest('hex');
        assert.equal(hash, BEFORE, `model ${model}: the payloads changed`);
    }
});

test('children: the function channels as child devices, keys and unique_ids unchanged', () => {
    const fx = drsi4();
    const [off] = devicesOf(discoveryModel(ctxFor(fx)));
    const [b] = devicesOf(discoveryModel(ctxFor(fx, {channelDevices: 'children'})));
    assert.deepEqual(b.device, off.device);
    const where = {};
    for (const key of Object.keys(b.components)) {
        where[key] = 'parent';
    }
    for (const child of b.children) {
        for (const key of Object.keys(child.components)) {
            assert.equal(where[key], undefined, `${key} twice`);
            where[key] = child.id;
            assert.equal(child.components[key].uniq_id, off.components[key].uniq_id);
        }
    }
    assert.deepEqual(Object.keys(where).sort(), Object.keys(off.components).sort(), 'every component exactly once');
    assert.equal(where['6_STATE'], `${ID('DRS0001')}_5`, 'the family under its transmitter');
    assert.equal(where['1_STATE'], `${ID('DRS0001')}_1`);
    assert.ok(
        Object.keys(where)
            .filter((k) => k.startsWith('0_'))
            .every((k) => where[k] === 'parent'),
    );
    const child = (n) => b.children.find((c) => c.id === `${ID('DRS0001')}_${n}`);
    assert.equal(child(5).name, 'Flurlicht');
    assert.equal(child(9).name, 'Küche Decke');
    assert.equal(child(1).name, 'Channel 1', 'the CCU default name is no name');
    assert.equal(child(5).components['6_STATE'].name, null, 'the main entity is named after its device');
    assert.equal(child(5).components['7_STATE'].name, 'Channel 7', 'a secondary receiver keeps its label');

    // what Home Assistant gets once the core builds `cdevs`
    const {payload} = withChildren(b);
    assert.deepEqual(
        payload.cdevs.map((c) => Object.keys(c).sort()),
        payload.cdevs.map(() => ['cmps', 'ids', 'name']),
    );
    // the core 0.17 leaves `children` out - hm2mqtt does not hand it children then (below)
    assert.equal(payloadOf(b).payload.cdevs, undefined);
});

test('children through the real core: `cdevs` after `cmps`, every component once, the probe sees the support', () => {
    const [b] = devicesOf(discoveryModel(ctxFor(drsi4(), {channelDevices: 'children'})));
    const {topic, payload} = devicePayload({
        pkg,
        name: 'hm',
        prefix: 'homeassistant',
        id: b.id,
        device: b.device,
        components: b.components,
        children: b.children,
        availability: b.availability,
        availabilityMode: b.availabilityMode,
    });
    assert.equal(topic, `homeassistant/device/${ID('DRS0001')}/config`);
    assert.deepEqual(Object.keys(payload).slice(-2), ['cmps', 'cdevs']);
    assert.deepEqual(payload, withChildren(b).payload, 'the contract the tests above assume');
    const keys = [...Object.keys(payload.cmps), ...payload.cdevs.flatMap((c) => Object.keys(c.cmps))];
    assert.equal(new Set(keys).size, keys.length);
    // the start-up probe of index.js
    const probe = devicePayload({pkg, name: 'probe', components: {}, children: [{id: 'c', name: 'c', components: {}}]});
    assert.ok(probe.payload.cdevs);
    // no children: no key, as before
    assert.equal('cdevs' in devicePayload({pkg, name: 'hm', id: b.id, components: {}, children: []}).payload, false);
});

test('children without child device support in the core: everything stays on the device', () => {
    const fx = drsi4();
    const [off] = devicesOf(discoveryModel(ctxFor(fx)));
    const [b] = devicesOf(discoveryModel(ctxFor(fx, {channelDevices: 'children', childDevices: false})));
    assert.equal(b.children, undefined);
    assert.deepEqual(payloadOf(b), payloadOf(off));
});

test('devices: a block of its own per function channel, with its room and the device as via_device', () => {
    const rooms = (a) => ({'LEQ1000:1': ['Flur'], 'LEQ1000:2': ['Keller']})[a];
    const blocks = devicesOf(discoveryModel(ctxFor(sw2(), {channelDevices: 'devices', rooms})));
    assert.deepEqual(
        blocks.map((b) => b.id),
        [ID('LEQ1000'), `${ID('LEQ1000')}_1`, `${ID('LEQ1000')}_2`],
    );
    const [parent, one, two] = blocks;
    assert.deepEqual(one.device, {
        name: 'Schalter Flur',
        mf: 'eQ-3',
        mdl: 'HM-LC-Sw2-FM',
        sw: '2.8',
        via_device: ID('LEQ1000'),
        sa: 'Flur',
    });
    assert.equal(two.device.sa, 'Keller');
    assert.deepEqual(one.availability, parent.availability);
    assert.equal(one.availabilityMode, 'all');
    assert.equal(one.components['1_STATE'].uniq_id, `${ID('LEQ1000')}_1_STATE`);
    assert.equal(one.components['1_STATE'].name, null);
    assert.deepEqual(parent.components['1_STATE'], {p: 'switch'}, 'no record yet: a stub leaves the device');
});

test('a device with one function is not split', () => {
    const fx = fixture('BidCos-RF', 'LEQ1001', 'HM-LC-Sw2-FM', '2.8', 26, ['MAINTENANCE', 'SWITCH'], {});
    for (const model of ['children', 'devices']) {
        const blocks = devicesOf(discoveryModel(ctxFor(fx, {channelDevices: model})));
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].children, undefined);
    }
});

test('--ha-overrides: the file form, and what it overrides', () => {
    assert.deepEqual(
        normalizeOverrides({
            DRS0001: {split: 'children'},
            'DRS0001:13': {publish: false},
            'DRS0001:9': {device: 'own', publish: true},
            'LEQ1000:2': {device: 'bogus'},
            LEQ1000: {split: 'bogus'},
            X: null,
        }),
        {
            DRS0001: {split: 'children', channels: {13: {publish: false}, 9: {device: 'own'}}},
            LEQ1000: {channels: {2: {}}},
        },
    );
    const units = new Map([
        [0, {function: false}],
        [1, {function: true}],
        [2, {function: true}],
    ]);
    const run = (ctx) => Object.fromEntries(placement(ctx, 'D', units));
    assert.deepEqual(run({}), {0: 'parent', 1: 'parent', 2: 'parent'});
    assert.deepEqual(run({channelDevices: 'devices', overrides: {D: {split: 'off'}}}), {
        0: 'parent',
        1: 'parent',
        2: 'parent',
    });
    assert.deepEqual(run({overrides: {D: {channels: {1: {device: 'own'}, 2: {publish: false}}}}}), {
        0: 'parent',
        1: 'own',
        2: 'drop',
    });
    assert.deepEqual(run({overrides: {D: {channels: {1: {device: 'child'}}}}, childDevices: false}), {
        0: 'parent',
        1: 'parent',
        2: 'parent',
    });

    const overrides = normalizeOverrides({'DRS0001:9': {publish: false}});
    const [b] = devicesOf(discoveryModel(ctxFor(drsi4(), {overrides, previous: {}})));
    const gone = Object.keys(b.components).filter((k) => Object.keys(b.components[k]).length === 1);
    assert.ok(gone.length > 0 && gone.every((k) => /^(9|10|11|12)_/.test(k)), 'only channel 9 and its family');
});

test('the example file follows the schema', () => {
    const example = JSON.parse(fs.readFileSync(new URL('../example-ha-overrides.json', import.meta.url), 'utf8'));
    const schema = JSON.parse(fs.readFileSync(new URL('../ha-overrides.schema.json', import.meta.url), 'utf8'));
    const patterns = Object.entries(schema.patternProperties).map(([re, s]) => [new RegExp(re), s]);
    for (const [key, value] of Object.entries(example)) {
        const match = patterns.find(([re]) => re.test(key));
        assert.ok(match, key);
        for (const [field, v] of Object.entries(value)) {
            const spec = match[1].properties[field];
            assert.ok(spec, `${key}.${field}`);
            assert.ok(spec.enum ? spec.enum.includes(v) : typeof v === spec.type, `${key}.${field}`);
        }
    }
});

test('removal: stubs once, cleared blocks, unknown descriptions kept', () => {
    const fx = sw2();
    const first = discoveryBlocks(ctxFor(fx, {channelDevices: 'devices', previous: {}}));
    assert.deepEqual(Object.keys(first.published.LEQ1000), [ID('LEQ1000'), `${ID('LEQ1000')}_1`, `${ID('LEQ1000')}_2`]);
    const again = discoveryBlocks(ctxFor(fx, {channelDevices: 'devices', previous: first.published}));
    assert.equal(devicesOf(again.blocks)[0].components['1_STATE'], undefined, 'the stub went once');

    const back = discoveryBlocks(ctxFor(fx, {previous: first.published}));
    assert.deepEqual(back.clear, [`${ID('LEQ1000')}_1`, `${ID('LEQ1000')}_2`]);
    assert.equal(devicesOf(back.blocks).length, 1);

    const description = fx.description;
    fx.description = (iface, a) => (a === 'LEQ1000:2' ? undefined : description(iface, a));
    const partial = discoveryBlocks(ctxFor(fx, {channelDevices: 'devices', previous: first.published}));
    assert.deepEqual(partial.clear, [], 'the block of a channel still being described stays');
    assert.ok(partial.published.LEQ1000[`${ID('LEQ1000')}_2`]);

    const kept = discoveryBlocks(ctxFor(fx, {previous: {GONE: {x: {a: 'sensor'}}}}));
    assert.deepEqual(kept.published.GONE, {x: {a: 'sensor'}}, 'a device not in the table keeps its record');
});

test('the record in the state directory: cleared configs are published first, then kept across restarts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-ha-'));
    const sent = [];
    const publish = (topic, payload, options) => sent.push([topic, payload, options.retain]);
    const log = {warn: () => {}};
    recordedDiscovery({
        ctx: ctxFor(sw2(), {channelDevices: 'devices'}),
        record: new HaRecord({stateDir: dir, log}).load(),
        prefix: 'homeassistant',
        publish,
    });
    assert.deepEqual(sent, []);
    const record = new HaRecord({stateDir: dir, log}).load();
    assert.equal(Object.keys(record.devices.LEQ1000).length, 3);
    const blocks = recordedDiscovery({ctx: ctxFor(sw2()), record, prefix: 'homeassistant', publish});
    assert.deepEqual(sent, [
        [`homeassistant/device/${ID('LEQ1000')}_1/config`, '', true],
        [`homeassistant/device/${ID('LEQ1000')}_2/config`, '', true],
    ]);
    assert.equal(devicesOf(blocks).length, 1);
    assert.equal(Object.keys(new HaRecord({stateDir: dir, log}).load().devices.LEQ1000).length, 1);

    // broken file → no record; no state dir → nothing written; a write that fails → a warning
    fs.writeFileSync(path.join(dir, 'ha-discovery.json'), '{broken');
    assert.deepEqual(new HaRecord({stateDir: dir, log}).load().devices, {});
    const none = new HaRecord({log}).load();
    none.save({A: {}});
    assert.equal(none.file, null);
    const warnings = [];
    const bad = path.join(dir, 'nope', 'deeper');
    const failing = new HaRecord({stateDir: bad, log: {warn: (...a) => warnings.push(a.join(' '))}}).load();
    failing.save({A: {}});
    assert.match(warnings[0], /could not write/);
});
