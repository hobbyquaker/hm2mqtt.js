import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {
    sanitizeName,
    datapointItem,
    resolveSet,
    resolveParamset,
    plainValue,
    compileTemplate,
    ItemIndex,
    DEFAULT_ITEM_TEMPLATE,
} from '../lib/topics.js';

describe('names', () => {
    test('sanitizeName keeps names verbatim except +, #, empty levels and reserved first levels', () => {
        assert.deepEqual(sanitizeName('Licht Küche'), {name: 'Licht Küche', changed: false});
        assert.deepEqual(sanitizeName('Bad/Decke'), {name: 'Bad/Decke', changed: false});
        assert.deepEqual(sanitizeName('a+b#c'), {name: 'a_b_c', changed: true});
        assert.deepEqual(sanitizeName('a//b/'), {name: 'a/_/b/_', changed: true});
        assert.deepEqual(sanitizeName('counter'), {name: 'counter_', changed: true});
        assert.deepEqual(sanitizeName('interface/x'), {name: 'interface_/x', changed: true});
        assert.deepEqual(sanitizeName('counters'), {name: 'counters', changed: false});
    });

    test('datapointItem', () => {
        assert.equal(datapointItem('Licht Küche', 'STATE'), 'Licht Küche/STATE');
        assert.equal(datapointItem('ABC123:1', 'LEVEL'), 'ABC123:1/LEVEL');
    });
});

describe('resolveSet', () => {
    const names = {'Licht Küche': 'ABC123:1', 'Bad/Decke': 'DEF456:2', 'ABC123:1': 'ABC123:1', Gerät: 'ABC123'};
    const lookup = {
        channelAddress: (name, devices = false) => {
            const a = names[name];
            return a && (devices || a.includes(':')) ? a : undefined;
        },
        isSysvar: (n) => ['Anwesenheit', 'Regen/heute'].includes(n),
        isProgram: (n) => n === 'Licht aus',
    };

    test('datapoints by name and address, names with slashes', () => {
        assert.deepEqual(resolveSet(['Licht Küche', 'STATE'], lookup), {
            kind: 'datapoint',
            address: 'ABC123:1',
            datapoint: 'STATE',
        });
        assert.deepEqual(resolveSet(['ABC123:1', 'STATE'], lookup), {
            kind: 'datapoint',
            address: 'ABC123:1',
            datapoint: 'STATE',
        });
        assert.deepEqual(resolveSet(['Bad', 'Decke', 'LEVEL'], lookup), {
            kind: 'datapoint',
            address: 'DEF456:2',
            datapoint: 'LEVEL',
        });
    });

    test('sysvars, programs, commands, misses', () => {
        assert.deepEqual(resolveSet(['Anwesenheit'], lookup), {kind: 'sysvar', name: 'Anwesenheit'});
        assert.deepEqual(resolveSet(['Regen', 'heute'], lookup), {kind: 'sysvar', name: 'Regen/heute'});
        assert.deepEqual(resolveSet(['Licht aus'], lookup), {kind: 'program', name: 'Licht aus'});
        assert.deepEqual(resolveSet(['rega', 'sync'], lookup), {kind: 'command', command: 'sync'});
        assert.equal(resolveSet(['Gerät', 'STATE'], lookup), null); // devices are not settable
        assert.equal(resolveSet(['Unknown', 'STATE'], lookup), null);
        assert.equal(resolveSet(['Unknown'], lookup), null);
        assert.equal(resolveSet([], lookup), null);
    });

    test('resolveParamset: whole paramset and single parameter, devices allowed', () => {
        assert.deepEqual(resolveParamset(['Licht Küche', 'MASTER'], lookup), {address: 'ABC123:1', paramset: 'MASTER'});
        assert.deepEqual(resolveParamset(['Gerät', 'MASTER'], lookup), {address: 'ABC123', paramset: 'MASTER'});
        assert.deepEqual(resolveParamset(['Bad', 'Decke', 'MASTER', 'ON_TIME'], lookup, {single: true}), {
            address: 'DEF456:2',
            paramset: 'MASTER',
            param: 'ON_TIME',
        });
        assert.equal(resolveParamset(['Licht Küche', 'MASTER'], lookup, {single: true}), null);
        assert.equal(resolveParamset(['Nope', 'MASTER'], lookup), null);
    });

    test('plainValue', () => {
        assert.equal(plainValue(true), 1);
        assert.equal(plainValue(false), 0);
        assert.equal(plainValue(21.5), 21.5);
        assert.equal(plainValue('x'), 'x');
    });
});

describe('item templates', () => {
    const fields = {
        channelName: 'Licht Küche',
        channel: 'ABC:1',
        device: 'ABC',
        channelIndex: 1,
        datapoint: 'STATE',
        iface: 'BidCos-RF',
        rooms: ['Küche'],
        room: 'Küche',
    };

    test('default template renders the classic item, fallbacks and case-insensitive fields', () => {
        const render = compileTemplate(DEFAULT_ITEM_TEMPLATE);
        assert.deepEqual(render(fields), {name: 'Licht Küche/STATE', changed: false});
        assert.deepEqual(render({...fields, channelName: undefined}), {name: 'ABC:1/STATE', changed: false});
        assert.equal(compileTemplate('${CHANNELNAME}/${DataPoint}')(fields).name, 'Licht Küche/STATE');
        assert.equal(compileTemplate('${device}/${channelIndex}/${datapoint}')(fields).name, 'ABC/1/STATE');
        assert.equal(compileTemplate('${room|_}/${channelName}/${datapoint}')(fields).name, 'Küche/Licht Küche/STATE');
        assert.equal(
            compileTemplate('${function|room}/${channelName}')({...fields, rooms: [], room: undefined}).name,
            '_/Licht Küche',
        );
        assert.equal(compileTemplate('${rooms}/${datapoint}')({...fields, rooms: ['a', 'b']}).name, 'a,b/STATE');
        assert.equal(compileTemplate('hm/${datapoint}')(fields).name, 'hm/STATE');
        assert.equal(compileTemplate('${name}')({name: 'Anwesenheit'}).name, 'Anwesenheit');
        assert.deepEqual(compileTemplate('${channelName}/${datapoint}')({channelName: 'a+b', datapoint: 'X'}), {
            name: 'a_b/X',
            changed: true,
        });
        assert.equal(compileTemplate('counter/${datapoint}')(fields).name, 'counter_/STATE');
    });

    test('ItemIndex: first target wins, collisions recorded, clear by kind', () => {
        const index = new ItemIndex();
        assert.equal(index.add('Licht/STATE', {kind: 'datapoint', address: 'A:1', datapoint: 'STATE'}), true);
        assert.equal(index.add('Licht/STATE', {kind: 'datapoint', address: 'A:1', datapoint: 'STATE'}), true);
        assert.equal(index.add('Licht/STATE', {kind: 'datapoint', address: 'B:1', datapoint: 'STATE'}), false);
        assert.deepEqual(index.get('Licht/STATE'), {kind: 'datapoint', address: 'A:1', datapoint: 'STATE'});
        assert.equal(index.collisions.size, 1);
        index.add('Anwesenheit', {kind: 'sysvar', name: 'Anwesenheit'});
        assert.equal(index.size, 2);
        index.clear('datapoint');
        assert.equal(index.get('Licht/STATE'), undefined);
        assert.deepEqual(index.get('Anwesenheit'), {kind: 'sysvar', name: 'Anwesenheit'});
        index.clear();
        assert.equal(index.size, 0);
    });
});
