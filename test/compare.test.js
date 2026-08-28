import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {compareTrees, formatReport} from '../lib/compare.js';

const p = (val, hm) => JSON.stringify({val, ts: 1, lc: 1, hm});

describe('compareTrees', () => {
    test('identical, added fields/items and ignored fields', () => {
        const left = new Map([
            ['Licht/STATE', p(true, {channel: 'A:1', ts: 1, cache: false})],
            ['counter/BidCos-RF/rx', '5'],
        ]);
        const right = new Map([
            ['Licht/STATE', p(true, {channel: 'A:1', ts: 2, cache: true, datapointUnit: '', valueEnum: 'x'})],
            ['counter/BidCos-RF/rx', p(5)],
            ['interface/BidCos-RF/connected', p(true)],
        ]);
        const r = compareTrees(left, right);
        assert.deepEqual(r, {leftOnly: [], rightOnly: [], differences: [], additions: [], same: 2});
    });

    test('differences and one-sided items', () => {
        const left = new Map([
            ['Licht/STATE', p(true, {channelType: 'SWITCH', room: 'Flur'})],
            ['Alt/LEVEL', p(0.5)],
        ]);
        const right = new Map([
            ['Licht/STATE', p(false, {channelType: 'SWITCH', room: 'Bad'})],
            ['Neu/LEVEL', p(0.5)],
        ]);
        const r = compareTrees(left, right);
        assert.deepEqual(r.leftOnly, ['Alt/LEVEL']);
        assert.deepEqual(r.rightOnly, ['Neu/LEVEL']);
        assert.deepEqual(r.differences, [
            {item: 'Licht/STATE', field: 'val', left: true, right: false},
            {item: 'Licht/STATE', field: 'hm.room', left: 'Flur', right: 'Bad'},
        ]);
        assert.equal(r.same, 0);
        const report = formatReport(r, {leftName: 'hm', rightName: 'hm3'});
        assert.match(
            report,
            /0 items identical, 1 items with 2 differences, 0 added fields, 1 only in hm, 1 only in hm3/,
        );
        assert.match(report, /differences by field:\n {2}val: 1\n {2}hm.room: 1/);
        assert.match(report, /Licht\/STATE hm.room: "Flur" → "Bad"/);
    });

    test('fields the reference never had are additions', () => {
        const r = compareTrees(
            new Map([['A/X', p(1, {a: 1})]]),
            new Map([['A/X', p(1, {a: 1, datapointControl: 'C.X'})]]),
        );
        assert.deepEqual(r.differences, []);
        assert.deepEqual(r.additions, [{item: 'A/X', field: 'hm.datapointControl', right: 'C.X'}]);
        assert.equal(r.same, 1);
        assert.match(formatReport(r), /additions\):\n {2}hm.datapointControl: 1/);
    });
});
