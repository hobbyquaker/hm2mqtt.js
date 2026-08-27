import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {castValue, castVariable, isWriteable} from '../lib/cast.js';

describe('castValue', () => {
    test('BOOL / ACTION', () => {
        const d = {TYPE: 'BOOL'};
        for (const v of [true, 1, '1', 'true', 'on', 'ON', 'yes', 2, 'x']) {
            assert.equal(castValue(v, d), true, String(v));
        }
        for (const v of [false, 0, '0', 'false', 'off', 'no', '']) {
            assert.equal(castValue(v, d), false, String(v));
        }
        assert.equal(castValue('true', {TYPE: 'ACTION'}), true);
    });

    test('FLOAT → explicitDouble, no clamping', () => {
        assert.deepEqual(castValue(21.5, {TYPE: 'FLOAT', MIN: 4.5, MAX: 30.5}), {explicitDouble: 21.5});
        assert.deepEqual(castValue('1', {TYPE: 'FLOAT'}), {explicitDouble: 1});
        assert.deepEqual(castValue(99, {TYPE: 'FLOAT', MAX: 30}), {explicitDouble: 99});
        assert.deepEqual(castValue('abc', {TYPE: 'FLOAT'}), {explicitDouble: 0});
        assert.deepEqual(castValue(true, {TYPE: 'FLOAT'}), {explicitDouble: 1});
        assert.deepEqual(castValue({explicitDouble: 3}, {TYPE: 'FLOAT'}), {explicitDouble: 3});
    });

    test('INTEGER and ENUM (VALUE_LIST names, case-insensitive)', () => {
        assert.equal(castValue('7', {TYPE: 'INTEGER'}), 7);
        assert.equal(castValue(7.9, {TYPE: 'INTEGER'}), 7);
        assert.equal(castValue(true, {TYPE: 'INTEGER'}), 1);
        assert.equal(castValue('x', {TYPE: 'INTEGER'}), 0);
        const e = {TYPE: 'ENUM', VALUE_LIST: ['STABLE', 'NOT_STABLE']};
        assert.equal(castValue('NOT_STABLE', e), 1);
        assert.equal(castValue('not_stable', e), 1);
        assert.equal(castValue(1, e), 1);
        assert.equal(castValue('1', e), 1);
        assert.equal(castValue('UNKNOWN', e), 0);
        assert.equal(castValue('B', {TYPE: 'ENUM', ENUM: ['A', 'B']}), 1);
    });

    test('STRING and unknown descriptions', () => {
        assert.equal(castValue(5, {TYPE: 'STRING'}), '5');
        assert.equal(castValue(5), '5');
        assert.equal(castValue('5'), '5');
        assert.equal(castValue(true), true);
    });
});

describe('castVariable', () => {
    test('boolean, number, string, enum names', () => {
        assert.equal(castVariable('anwesend', {type: 'boolean', enum: ['abwesend', 'anwesend']}), true);
        assert.equal(castVariable('abwesend', {type: 'boolean', enum: ['abwesend', 'anwesend']}), false);
        assert.equal(castVariable('0', {type: 'boolean'}), false);
        assert.equal(castVariable(1, {type: 'boolean'}), true);
        assert.equal(castVariable('21.5', {type: 'number'}), 21.5);
        assert.equal(castVariable(true, {type: 'number'}), 1);
        assert.equal(castVariable('Sommer', {type: 'number', enum: ['Winter', 'Sommer']}), 1);
        assert.equal(castVariable(3, {type: 'string'}), '3');
        assert.equal(castVariable('x', {type: 'number'}), 0);
    });
});

describe('isWriteable', () => {
    test('OPERATIONS bit 2', () => {
        assert.equal(isWriteable({OPERATIONS: 5}), false);
        assert.equal(isWriteable({OPERATIONS: 7}), true);
        assert.equal(isWriteable({OPERATIONS: 2}), true);
        assert.equal(isWriteable(undefined), true);
        assert.equal(isWriteable({}), true);
    });
});
