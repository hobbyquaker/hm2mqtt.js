import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {channelRole, haUnit, isFraction, compileIgnore, PARAMETERS} from '../lib/roles.js';

describe('roles', () => {
    test('channelRole from CONTROL hints, type fallback, maintenance first', () => {
        assert.equal(channelRole('SWITCH', {STATE: {CONTROL: 'SWITCH.STATE'}, WORKING: {}}), 'switch');
        assert.equal(channelRole('SWITCH_VIRTUAL_RECEIVER', {STATE: {CONTROL: 'SWITCH.STATE'}}), 'switch');
        assert.equal(channelRole('SWITCH_TRANSMITTER', {STATE: {CONTROL: 'SWITCH_TRANSMITTER.STATE'}}), 'switch_state');
        assert.equal(channelRole('DIMMER_VIRTUAL_RECEIVER', {LEVEL: {CONTROL: 'DIMMER.LEVEL'}}), 'dimmer');
        assert.equal(
            channelRole('BLIND', {LEVEL: {CONTROL: 'BLIND.LEVEL'}, PRESS_SHORT: {CONTROL: 'BUTTON.SHORT'}}),
            'cover',
        );
        assert.equal(channelRole('SHUTTER_CONTACT', {STATE: {CONTROL: 'DOOR_SENSOR.STATE'}}), 'contact');
        assert.equal(channelRole('SHUTTER_CONTACT', {STATE: {}}), 'contact');
        assert.equal(channelRole('KEY_TRANSCEIVER', {PRESS_SHORT: {CONTROL: 'BUTTON_NO_FUNCTION.SHORT'}}), 'key');
        assert.equal(
            channelRole('HEATING_CLIMATECONTROL_TRANSCEIVER', {
                SET_POINT_TEMPERATURE: {CONTROL: 'HEATING_CONTROL_HMIP.SETPOINT'},
            }),
            'climate_hmip',
        );
        assert.equal(
            channelRole('CLIMATECONTROL_RT_TRANSCEIVER', {SET_TEMPERATURE: {CONTROL: 'HEATING_CONTROL.SETPOINT'}}),
            'climate_hm',
        );
        assert.equal(
            channelRole('MAINTENANCE', {ADAPTION_DRIVE: {CONTROL: 'HEATING_CONTROL.ADAPTION'}, UNREACH: {}}),
            'maintenance',
        );
        assert.equal(channelRole('MOTION_DETECTOR', {MOTION: {}}), 'motion');
        assert.equal(channelRole('KEYMATIC', {STATE: {CONTROL: 'LOCK.STATE'}}), 'lock');
        assert.equal(channelRole('WEATHER_RECEIVER', {}), null);
        assert.equal(channelRole('WEATHER_RECEIVER', undefined), null);
    });

    test('units and fractions', () => {
        assert.equal(haUnit('100%'), '%');
        assert.equal(haUnit('% rF'), '%');
        assert.equal(haUnit('�C'), '°C');
        assert.equal(haUnit('&#176;C'), '°C');
        assert.equal(haUnit('Lux'), 'lx');
        assert.equal(haUnit('""'), undefined);
        assert.equal(haUnit(''), undefined);
        assert.equal(haUnit('km/h'), 'km/h');
        assert.equal(isFraction({UNIT: '100%'}), true);
        assert.equal(isFraction({UNIT: '%'}), false);
        assert.equal(PARAMETERS.LOW_BAT.dev_cla, 'battery');
    });

    test('compileIgnore globs', () => {
        const ig = compileIgnore('*.*.RSSI_*, HmIP-RF.*.*_STATUS,BidCos-RF.ABC:1.STATE');
        assert.equal(ig('BidCos-RF', 'ABC:0', 'RSSI_DEVICE'), true);
        assert.equal(ig('HmIP-RF', '0001:3', 'LEVEL_STATUS'), true);
        assert.equal(ig('BidCos-RF', 'ABC:1', 'STATE'), true);
        assert.equal(ig('BidCos-RF', 'ABC:2', 'STATE'), false);
        assert.equal(ig('BidCos-RF', 'ABC:1', 'LEVEL'), false);
        assert.equal(compileIgnore('')('a', 'b', 'c'), false);
        assert.equal(compileIgnore(undefined)('a', 'b', 'c'), false);
    });
});
