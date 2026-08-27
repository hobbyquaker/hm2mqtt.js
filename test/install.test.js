import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {unitFile, envFile} from '../lib/install.js';
import {SHARED_OPTIONS} from 'mqtt-interfaces-core';

process.env.HM2MQTT_CCU_ADDRESS = 'ccu';
const {OPTIONS} = await import('../config.js');

describe('install', () => {
    test('unit uses the shared layout', () => {
        const unit = unitFile('/usr/bin/node /usr/local/lib/node_modules/hm2mqtt/index.js');
        assert.match(unit, /^EnvironmentFile=-\/etc\/mqtt-interfaces\/broker\.env$/m);
        assert.match(unit, /^EnvironmentFile=\/etc\/hm2mqtt\/%i\.env$/m);
        assert.match(unit, /^Environment=HM2MQTT_NAME=%i$/m);
        assert.match(unit, /^SyslogIdentifier=hm2mqtt@%i$/m);
        assert.match(unit, /^Restart=always$/m);
    });

    test('env file carries the hm2mqtt options', () => {
        const argv = {
            name: 'hm',
            ccuAddress: 'ccu',
            interfaces: 'BidCos-RF,HmIP-RF',
            plainTree: 'state',
            mqttUrl: 'mqtt://b',
        };
        Object.defineProperty(argv, '$options', {value: {...OPTIONS, ...SHARED_OPTIONS}});
        const out = envFile(argv);
        assert.match(out, /^HM2MQTT_CCU_ADDRESS=ccu$/m);
        assert.match(out, /^HM2MQTT_INTERFACES=BidCos-RF,HmIP-RF$/m);
        assert.match(out, /^HM2MQTT_PLAIN_TREE=state$/m);
        assert.doesNotMatch(out, /^HM2MQTT_NAME=/m);
    });

    test('config schema marks the password as secret and the name file as a file', async () => {
        const {configSchema} = await import('mqtt-interfaces-core');
        const schema = configSchema({
            pkg: {name: 'hm2mqtt', version: '3.0.0'},
            envPrefix: 'HM2MQTT',
            options: OPTIONS,
            defaults: {name: 'hm'},
        });
        assert.equal(schema.properties['ccu-password']['x-secret'], true);
        assert.equal(schema.properties['name-file']['x-file'].format, 'json');
        assert.ok(schema.required.includes('ccu-address'));
    });
});
