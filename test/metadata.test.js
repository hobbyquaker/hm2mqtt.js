import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {Metadata} from '../lib/metadata.js';
import {createLogger} from 'mqtt-interfaces-core';

const log = createLogger({format: 'journal', level: 'error', write: () => {}});

const DEV = {
    ADDRESS: 'ABC',
    TYPE: 'HM-LC-Sw1-FM',
    FIRMWARE: '1.4',
    VERSION: 1,
    PARAMSETS: ['MASTER'],
    CHILDREN: ['ABC:0', 'ABC:1'],
};
const CH0 = {
    ADDRESS: 'ABC:0',
    TYPE: 'MAINTENANCE',
    PARENT: 'ABC',
    PARENT_TYPE: 'HM-LC-Sw1-FM',
    VERSION: 1,
    PARAMSETS: ['MASTER', 'VALUES'],
};
const CH1 = {
    ADDRESS: 'ABC:1',
    TYPE: 'SWITCH',
    PARENT: 'ABC',
    PARENT_TYPE: 'HM-LC-Sw1-FM',
    VERSION: 1,
    PARAMSETS: ['MASTER', 'VALUES', 'LINK'],
    AES_ACTIVE: '',
    FLAGS: 1,
};

function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-meta-'));
}

describe('Metadata', () => {
    test('devices: add, delete, find, listDevices answers', () => {
        const m = new Metadata({stateDir: tmp(), log});
        assert.deepEqual(m.addDevices('BidCos-RF', [DEV, CH0, CH1]), ['ABC', 'ABC:0', 'ABC:1']);
        assert.deepEqual(m.addDevices('BidCos-RF', [CH1, {ADDRESS: 'X'}]), []);
        assert.equal(m.count('BidCos-RF'), 3);
        assert.equal(m.findIface('ABC:1'), 'BidCos-RF');
        assert.equal(m.findIface('nope'), undefined);
        assert.deepEqual(m.listDevicesAnswer('BidCos-RF')[0], {ADDRESS: 'ABC', VERSION: 1});
        m.addDevices('HmIP-RF', [CH1]);
        const full = m.listDevicesAnswer('HmIP-RF')[0];
        assert.equal(full.AES_ACTIVE, undefined); // empty strings dropped
        assert.equal(full.FLAGS, 1);
        assert.deepEqual(full.PARAMSETS, ['MASTER', 'VALUES', 'LINK']);
        assert.deepEqual(m.deleteDevices('BidCos-RF', ['ABC:1', 'zzz']), ['ABC:1']);
        assert.equal(m.count(), 3);
        assert.deepEqual(m.listDevicesAnswer('nope'), []);
    });

    test('paramset keys, descriptions, missing and fetch', async () => {
        const m = new Metadata({stateDir: tmp(), log});
        m.addDevices('BidCos-RF', [DEV, CH0, CH1]);
        assert.equal(m.paramsetKey('BidCos-RF', CH1, 'VALUES'), 'BidCos-RF/HM-LC-Sw1-FM/1.4/1/SWITCH/VALUES');
        assert.equal(m.paramsetKey('BidCos-RF', DEV, 'MASTER'), 'BidCos-RF/HM-LC-Sw1-FM/1.4/1//MASTER');
        assert.equal(m.paramsetKey('BidCos-RF', CH1, 'DEF456:1'), 'BidCos-RF/HM-LC-Sw1-FM/1.4/1/SWITCH/LINK');
        assert.equal(m.paramsetKey('BidCos-RF', undefined, 'VALUES'), undefined);
        assert.equal(m.valueDescription('BidCos-RF', 'ABC:1', 'STATE'), undefined);
        const missing = m.missingDescriptions('BidCos-RF');
        assert.deepEqual(
            missing.map((x) => x.key),
            [
                'BidCos-RF/HM-LC-Sw1-FM/1.4/1//MASTER',
                'BidCos-RF/HM-LC-Sw1-FM/1.4/1/MAINTENANCE/MASTER',
                'BidCos-RF/HM-LC-Sw1-FM/1.4/1/MAINTENANCE/VALUES',
                'BidCos-RF/HM-LC-Sw1-FM/1.4/1/SWITCH/MASTER',
                'BidCos-RF/HM-LC-Sw1-FM/1.4/1/SWITCH/VALUES',
                'BidCos-RF/HM-LC-Sw1-FM/1.4/1/SWITCH/LINK',
            ],
        );
        const calls = [];
        const fetched = await m.fetchDescriptions(
            'BidCos-RF',
            async (method, params) => {
                calls.push(params);
                if (params[1] === 'LINK') {
                    throw new Error('no link');
                }
                return {STATE: {TYPE: 'BOOL', OPERATIONS: 7}};
            },
            {sleep: async () => {}, addresses: ['ABC:1']},
        );
        assert.equal(fetched, 2);
        assert.deepEqual(calls, [
            ['ABC:1', 'MASTER'],
            ['ABC:1', 'VALUES'],
            ['ABC:1', 'LINK'],
        ]);
        assert.deepEqual(m.valueDescription('BidCos-RF', 'ABC:1', 'STATE'), {TYPE: 'BOOL', OPERATIONS: 7});
        assert.equal(m.missingDescriptions('BidCos-RF', ['ABC:1']).length, 1);
    });

    test('persistence and seed', () => {
        const dir = tmp();
        const seed = path.join(dir, 'seed.json');
        fs.writeFileSync(seed, JSON.stringify({'BidCos-RF/HM-LC-Sw1-FM/1.4/1/SWITCH/VALUES': {STATE: {TYPE: 'BOOL'}}}));
        const stateDir = path.join(dir, 'state');
        const m = new Metadata({stateDir, seedFile: seed, log});
        m.load();
        assert.equal(Object.keys(m.descriptions).length, 1);
        m.addDevices('BidCos-RF', [DEV, CH0, CH1]);
        assert.deepEqual(m.valueDescription('BidCos-RF', 'ABC:1', 'STATE'), {TYPE: 'BOOL'});
        m.save();
        assert.ok(fs.existsSync(path.join(stateDir, 'devices.json')));
        assert.ok(fs.existsSync(path.join(stateDir, 'paramsets.json')));
        const m2 = new Metadata({stateDir, seedFile: 'nope.json', log});
        m2.load();
        assert.equal(m2.count(), 3);
        assert.deepEqual(m2.valueDescription('BidCos-RF', 'ABC:1', 'STATE'), {TYPE: 'BOOL'});
    });
});
