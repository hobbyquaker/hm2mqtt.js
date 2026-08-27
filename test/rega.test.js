import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {RegaSync} from '../lib/rega.js';
import {Metadata} from '../lib/metadata.js';
import {createLogger} from 'mqtt-interfaces-core';

const log = createLogger({format: 'journal', level: 'error', write: () => {}});

function fakeRega() {
    const calls = [];
    const data = {
        channels: [
            {id: 10, address: 'ABC', name: 'Dimmer Flur'},
            {id: 11, address: 'ABC:1', name: 'Licht Flur'},
            {id: 12, address: 'DEF:1', name: 'Licht Flur'},
            {id: 13, address: 'XYZ:1', name: 'Regen/Sensor'},
        ],
        rooms: [
            {id: 20, name: 'Flur', channels: [11, 12, 999]},
            {id: 21, name: 'EG', channels: [11]},
        ],
        functions: [{id: 30, name: 'Licht', channels: [11]}],
        variables: [
            {
                id: 950,
                name: 'Anwesenheit',
                info: '',
                val: true,
                ts: 5000,
                unit: '',
                type: 'boolean',
                enum: ['abwesend', 'anwesend'],
                channel: null,
            },
            {
                id: 951,
                name: 'Regen heute',
                info: 'mm',
                val: 1.5,
                ts: 4000,
                unit: 'mm',
                type: 'number',
                enum: [],
                channel: 11,
            },
        ],
        programs: [{id: 2000, name: 'Licht aus', info: '', active: true, ts: 3000}],
    };
    return {
        calls,
        data,
        getChannels: async () => data.channels,
        getRooms: async () => data.rooms,
        getFunctions: async () => data.functions,
        getVariables: async () => data.variables.map((v) => ({...v, enum: [...v.enum]})),
        getPrograms: async () => data.programs.map((p) => ({...p})),
        setVariable: async (id, value) => calls.push(['setVariable', id, value]),
        setProgram: async (id, active) => calls.push(['setProgram', id, active]),
        startProgram: async (id) => calls.push(['startProgram', id]),
    };
}

function setup(extra = {}) {
    const rega = fakeRega();
    const metadata = new Metadata({stateDir: '/nonexistent', log});
    metadata.addDevices('BidCos-RF', [
        {ADDRESS: 'ABC', TYPE: 'HM-LC-Dim1L-CV'},
        {ADDRESS: 'ABC:1', TYPE: 'DIMMER', PARENT: 'ABC'},
        {ADDRESS: 'DEF:1', TYPE: 'SWITCH', PARENT: 'DEF'},
    ]);
    let now = 9000;
    const sync = new RegaSync({rega, host: 'ccu', metadata, log, now: () => now, ...extra});
    return {rega, metadata, sync, setNow: (t) => (now = t)};
}

describe('RegaSync', () => {
    test('syncNames: names, reverse lookup, rooms, functions, name file', async () => {
        const {sync} = setup({nameFile: {'XYZ:1': 'Regensensor', 'ABC:1': ''}});
        const events = [];
        sync.on('names', () => events.push('names'));
        await sync.syncNames();
        assert.deepEqual(events, ['names']);
        assert.equal(sync.channelName('ABC:1'), 'Licht Flur');
        assert.equal(sync.channelName('XYZ:1'), 'Regensensor');
        assert.equal(sync.channelAddress('Licht Flur'), 'ABC:1'); // first channel with that name
        assert.equal(sync.channelAddress('Regensensor'), 'XYZ:1');
        assert.equal(sync.channelAddress('Dimmer Flur'), undefined); // a device, not a channel
        assert.equal(sync.channelAddress('Dimmer Flur', true), 'ABC');
        assert.equal(sync.channelAddress('ABC:1'), 'ABC:1'); // addresses pass through
        assert.equal(sync.channelAddress('nope'), undefined);
        assert.deepEqual(sync.rooms('ABC:1'), ['Flur', 'EG']);
        assert.deepEqual(sync.rooms('DEF:1'), ['Flur']);
        assert.deepEqual(sync.functions('ABC:1'), ['Licht']);
        assert.equal(sync.rooms('ABC'), undefined);
    });

    test('variables and programs: first poll publishes all, later polls only changes', async () => {
        const {sync, rega, setNow} = setup();
        await sync.syncNames();
        const sysvars = [];
        const programs = [];
        sync.on('sysvar', (m) => sysvars.push(m));
        sync.on('program', (m) => programs.push(m));
        await sync.poll();
        assert.equal(sysvars.length, 2);
        assert.equal(programs.length, 1);
        const a = sysvars[0];
        assert.equal(a.iface, 'ReGaHSS');
        assert.equal(a.type, 'SYSVAR');
        assert.equal(a.name, 'Anwesenheit');
        assert.equal(a.value, true);
        assert.equal(a.valueType, 'boolean');
        assert.equal(a.valueEnum, 'anwesend');
        assert.deepEqual(a.enum, ['abwesend', 'anwesend']);
        assert.equal(a.cache, true);
        assert.equal(a.change, false);
        assert.equal(a.ts, 5000);
        assert.equal(a.lc, 5000);
        assert.equal(a.id, 950);
        const r = sysvars[1];
        assert.equal(r.channel, 'ABC:1');
        assert.equal(r.channelName, 'Licht Flur');
        assert.equal(r.channelType, 'DIMMER');
        assert.equal(r.device, 'ABC');
        assert.equal(r.deviceType, 'HM-LC-Dim1L-CV');
        assert.equal(r.channelIndex, 1);
        assert.equal(r.room, undefined); // two rooms → no single room
        assert.equal(r.function, 'Licht');
        assert.equal(programs[0].type, 'PROGRAM');
        assert.equal(programs[0].value, true);
        assert.equal(programs[0].ts, 3000);
        assert.equal(sync.hasVariable('Anwesenheit'), true);
        assert.equal(sync.hasProgram('Licht aus'), true);

        // nothing changed → nothing emitted
        sysvars.length = 0;
        programs.length = 0;
        await sync.poll();
        assert.equal(sysvars.length + programs.length, 0);

        // value changed (new ts)
        rega.data.variables[0].val = false;
        rega.data.variables[0].ts = 6000;
        rega.data.programs[0].ts = 7000;
        await sync.poll();
        assert.equal(sysvars.length, 1);
        assert.equal(sysvars[0].value, false);
        assert.equal(sysvars[0].valuePrevious, true);
        assert.equal(sysvars[0].valueEnum, 'abwesend');
        assert.equal(sysvars[0].valueEnumPrevious, 'anwesend');
        assert.equal(sysvars[0].change, true);
        assert.equal(sysvars[0].cache, false);
        assert.equal(sysvars[0].lc, 6000);
        assert.equal(sysvars[0].lcPrevious, 5000);
        assert.equal(sysvars[0].tsPrevious, 5000);
        assert.equal(programs.length, 1);
        assert.equal(programs[0].tsPrevious, 3000);

        // same value, new ts → published with change false
        rega.data.variables[0].ts = 6500;
        sysvars.length = 0;
        await sync.poll();
        assert.equal(sysvars[0].change, false);
        assert.equal(sysvars[0].lc, 6000);

        // ts 0 (never) → now
        setNow(9999);
        rega.data.variables.push({
            id: 952,
            name: 'Neu',
            info: '',
            val: 'x',
            ts: 0,
            unit: '',
            type: 'string',
            enum: [],
            channel: null,
        });
        sysvars.length = 0;
        await sync.poll();
        assert.equal(sysvars[0].ts, 9999);
    });

    test('set: variables (typed, enum names), programs; unknown names reject', async () => {
        const {sync, rega} = setup();
        await sync.poll();
        await sync.setVariable('Anwesenheit', 'anwesend');
        await sync.setVariable('Regen heute', '2.5');
        await sync.programActive('Licht aus', false);
        await sync.programExecute('Licht aus');
        assert.deepEqual(rega.calls, [
            ['setVariable', 950, true],
            ['setVariable', 951, 2.5],
            ['setProgram', 2000, false],
            ['startProgram', 2000],
        ]);
        await assert.rejects(sync.setVariable('nope', 1), /unknown/);
        await assert.rejects(sync.programExecute('nope'), /unknown/);
    });

    test('polling loop and persistence', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm2mqtt-rega-'));
        const {sync} = setup({stateDir: dir});
        await sync.syncNames();
        assert.ok(fs.existsSync(path.join(dir, 'rega.json')));
        const again = setup({stateDir: dir}).sync;
        again.load();
        assert.equal(again.channelName('ABC:1'), 'Licht Flur');
        assert.deepEqual(again.rooms('ABC:1'), ['Flur', 'EG']);

        const timers = [];
        let polls = 0;
        sync.on('polled', () => polls++);
        await sync.startPolling(30, {setTimer: (fn, ms) => timers.push({fn, ms}), clearTimer: () => timers.pop()});
        assert.equal(polls, 1);
        assert.equal(timers[0].ms, 30000);
        await timers[0].fn();
        assert.equal(polls, 2);
        sync.stopPolling();
        assert.equal(timers.length, 1);
    });
});
