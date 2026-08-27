import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {ValueStore, waitsForWorking, unit, isEvent, hmBlock} from '../lib/values.js';
import {createLogger} from 'mqtt-interfaces-core';

const log = createLogger({format: 'journal', level: 'error', write: () => {}});

const devices = {
    'BidCos-RF': {
        ABC: {ADDRESS: 'ABC', TYPE: 'HM-LC-Dim1L-CV'},
        'ABC:1': {ADDRESS: 'ABC:1', TYPE: 'DIMMER', PARENT: 'ABC'},
        DEF: {ADDRESS: 'DEF', TYPE: 'HM-RC-4-2'},
        'DEF:1': {ADDRESS: 'DEF:1', TYPE: 'KEY', PARENT: 'DEF'},
    },
};
const descriptions = {
    LEVEL: {TYPE: 'FLOAT', MIN: 0, MAX: 1, DEFAULT: 0, OPERATIONS: 7, UNIT: '100%', CONTROL: 'DIMMER.LEVEL'},
    WORKING: {TYPE: 'BOOL', OPERATIONS: 5},
    DIRECTION: {TYPE: 'ENUM', VALUE_LIST: ['NONE', 'UP', 'DOWN'], OPERATIONS: 5},
    PRESS_SHORT: {TYPE: 'ACTION', OPERATIONS: 6},
    TEMP: {TYPE: 'FLOAT', UNIT: '�C'},
};
const context = {
    device: (iface, address) => devices[iface] && devices[iface][address],
    valueDescription: (iface, address, dp) => descriptions[dp],
    channelName: (address) => ({ABC: 'Dimmer Flur', 'ABC:1': 'Licht Flur', 'DEF:1': 'Taster'})[address],
    rooms: (address) => (address === 'ABC:1' ? ['Flur', 'EG'] : undefined),
    functions: (address) => (address === 'ABC:1' ? ['Licht'] : undefined),
};

function fakeTimers() {
    let now = 1000;
    const timers = [];
    return {
        now: () => now,
        setTimeout: (fn, ms) => {
            const t = {fn, at: now + ms};
            timers.push(t);
            return t;
        },
        clearTimeout: (t) => {
            const i = timers.indexOf(t);
            if (i !== -1) {
                timers.splice(i, 1);
            }
        },
        advance: (ms) => {
            now += ms;
            for (const t of timers.filter((t) => t.at <= now)) {
                timers.splice(timers.indexOf(t), 1);
                t.fn();
            }
        },
        set: (t) => (now = t),
    };
}

const store = (timers = fakeTimers()) => new ValueStore({host: 'ccu', context, log, timers});

describe('helpers', () => {
    test('waitsForWorking, unit, isEvent, hmBlock', () => {
        assert.equal(waitsForWorking('LEVEL', 'DIMMER'), true);
        assert.equal(waitsForWorking('LEVEL_SLATS', 'BLIND'), true);
        assert.equal(waitsForWorking('STATE', 'SWITCH'), true);
        assert.equal(waitsForWorking('STATE', 'SHUTTER_CONTACT'), false);
        assert.equal(waitsForWorking('ARMSTATE', 'ARMING'), true);
        assert.equal(waitsForWorking('LEVEL', undefined), false);
        assert.equal(unit({UNIT: '�C'}), '°C');
        assert.equal(unit({UNIT: '""'}), undefined);
        assert.equal(unit({UNIT: '100%'}), '100%');
        assert.equal(unit({}), undefined);
        assert.equal(isEvent('PRESS_SHORT', undefined), true);
        assert.equal(isEvent('INSTALL_TEST', {TYPE: 'ACTION'}), true);
        assert.equal(isEvent('STATE', {TYPE: 'BOOL'}), false);
        assert.deepEqual(hmBlock({topic: '', payload: 1, value: 1, ccu: 'c', iface: 'i'}), {ccu: 'c', iface: 'i'});
    });
});

describe('ValueStore', () => {
    test('message has the node-red-contrib-ccu fields', () => {
        const timers = fakeTimers();
        const s = store(timers);
        const m = s.message('BidCos-RF', 'ABC:1', 'LEVEL', 0.5, {
            cache: false,
            uncertain: false,
            working: undefined,
            direction: undefined,
        });
        assert.deepEqual(m, {
            topic: '',
            payload: 0.5,
            ccu: 'ccu',
            iface: 'BidCos-RF',
            device: 'ABC',
            deviceName: 'Dimmer Flur',
            deviceType: 'HM-LC-Dim1L-CV',
            channel: 'ABC:1',
            channelName: 'Licht Flur',
            channelType: 'DIMMER',
            channelIndex: 1,
            datapoint: 'LEVEL',
            datapointName: 'BidCos-RF.ABC:1.LEVEL',
            datapointType: 'FLOAT',
            datapointMin: 0,
            datapointMax: 1,
            datapointEnum: undefined,
            datapointDefault: 0,
            datapointControl: 'DIMMER.LEVEL',
            datapointUnit: '100%',
            value: 0.5,
            valuePrevious: undefined,
            valueEnum: undefined,
            valueStable: 0.5,
            rooms: ['Flur', 'EG'],
            room: 'Flur',
            functions: ['Licht'],
            function: 'Licht',
            ts: 1000,
            tsPrevious: undefined,
            lc: 1000,
            change: true,
            cache: false,
            uncertain: false,
            working: undefined,
            direction: undefined,
            stable: true,
        });
    });

    test('fields() are the static part of the message', () => {
        const s = store();
        const f = s.fields('BidCos-RF', 'ABC:1', 'LEVEL');
        assert.equal(f.channelName, 'Licht Flur');
        assert.equal(f.deviceType, 'HM-LC-Dim1L-CV');
        assert.equal(f.datapointControl, 'DIMMER.LEVEL');
        assert.equal(f.room, 'Flur');
        assert.equal(f.value, undefined);
        assert.equal(f.ts, undefined);
    });

    test('change / lc / valuePrevious across events; ACTION always changes; ENUM names', () => {
        const timers = fakeTimers();
        const s = store(timers);
        const out = [];
        const ev = (dp, value, extra = {}) =>
            s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: dp, value, ...extra}, (m) => out.push(m));
        ev('DIRECTION', 1);
        timers.set(2000);
        ev('DIRECTION', 1);
        timers.set(3000);
        ev('DIRECTION', 2);
        assert.deepEqual(
            out.map((m) => [m.change, m.lc, m.valuePrevious, m.valueEnum, m.ts, m.tsPrevious]),
            [
                [true, 1000, undefined, 'UP', 1000, undefined],
                [false, 1000, 1, 'UP', 2000, 1000],
                [true, 3000, 1, 'DOWN', 3000, 2000],
            ],
        );
        out.length = 0;
        s.event({iface: 'BidCos-RF', channel: 'DEF:1', datapoint: 'PRESS_SHORT', value: true}, (m) => out.push(m));
        s.event({iface: 'BidCos-RF', channel: 'DEF:1', datapoint: 'PRESS_SHORT', value: true}, (m) => out.push(m));
        assert.deepEqual(
            out.map((m) => m.change),
            [true, true],
        );
        assert.equal(out[0].channelType, 'KEY');
        assert.deepEqual(out[0].rooms, []);
        assert.equal(out[0].room, undefined);
    });

    test('actuator LEVEL waits 300 ms for WORKING/DIRECTION; _NOTWORKING companion', () => {
        const timers = fakeTimers();
        const s = store(timers);
        const out = [];
        const emit = (m) => out.push(m);
        // WORKING and DIRECTION arrive in separate calls after LEVEL
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'LEVEL', value: 0.3}, emit);
        assert.equal(out.length, 0);
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'WORKING', value: true}, emit);
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'DIRECTION', value: 1}, emit);
        assert.equal(out.length, 2);
        timers.advance(300);
        assert.equal(out.length, 3);
        assert.equal(out[2].datapoint, 'LEVEL');
        assert.equal(out[2].working, true);
        assert.equal(out[2].direction, 1);
        assert.equal(out[2].stable, false);
        assert.equal(s.notWorking(out[2]), null);
        // in a multicall the hints come along; working=true → published immediately, valueStable kept
        out.length = 0;
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'LEVEL', value: 0.6, working: true}, emit);
        assert.equal(out.length, 1);
        assert.equal(out[0].valueStable, 0.3);
        // final: WORKING false then LEVEL 1.0 → after 300 ms working false, NOTWORKING companion
        out.length = 0;
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'WORKING', value: false}, emit);
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'LEVEL', value: 1}, emit);
        timers.advance(300);
        const level = out[1];
        assert.equal(level.working, false);
        assert.equal(level.valueStable, 1);
        const nw = s.notWorking(level);
        assert.equal(nw.datapoint, 'LEVEL_NOTWORKING');
        assert.equal(nw.datapointName, 'BidCos-RF.ABC:1.LEVEL_NOTWORKING');
        assert.equal(nw.value, 1);
        // a newer LEVEL within the wait replaces the pending one
        out.length = 0;
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'LEVEL', value: 0.1}, emit);
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'LEVEL', value: 0.2}, emit);
        timers.advance(300);
        assert.deepEqual(
            out.map((m) => m.value),
            [0.2],
        );
        s.stop();
    });

    test('cached values: flags, timestamps, RSSI fix, bad names', () => {
        const timers = fakeTimers();
        const s = store(timers);
        const m = s.cached({name: 'BidCos-RF.ABC:1.LEVEL', value: 0.5, ts: 500});
        assert.equal(m.cache, true);
        assert.equal(m.change, false);
        assert.equal(m.uncertain, false);
        assert.equal(m.ts, 500);
        assert.equal(m.lc, 500);
        assert.equal(m.working, false);
        const u = s.cached({name: 'BidCos-RF.ABC:0.RSSI_DEVICE', value: 200, ts: 0});
        assert.equal(u.value, -56);
        assert.equal(u.uncertain, true);
        assert.equal(u.ts, 1000);
        assert.equal(s.cached({name: 'garbage', value: 1, ts: 0}), null);
        // a following event sees the cached value as change
        const out = [];
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'DIRECTION', value: 0}, (x) => out.push(x));
        const c = s.cached({name: 'BidCos-RF.ABC:1.DIRECTION', value: 0, ts: 0});
        assert.equal(c.cache, true);
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'DIRECTION', value: 0}, (x) => out.push(x));
        assert.equal(out[1].change, true);
    });

    test('persistence', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-values-'));
        const s = new ValueStore({host: 'ccu', context, log, stateDir: dir, timers: fakeTimers()});
        s.event({iface: 'BidCos-RF', channel: 'ABC:1', datapoint: 'DIRECTION', value: 2}, () => {});
        s.save();
        const s2 = new ValueStore({host: 'ccu', context, log, stateDir: dir, timers: fakeTimers()});
        s2.load();
        const v = s2.get('BidCos-RF', 'ABC:1', 'DIRECTION');
        assert.equal(v.value, 2);
        assert.equal(v.cache, true);
        assert.equal(v.uncertain, true);
    });
});
