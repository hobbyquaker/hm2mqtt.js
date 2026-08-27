import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {parseInterfaces, interfaceConfig, probeInterfaces, DEFAULT_INTERFACES} from '../lib/interfaces.js';

describe('interfaces', () => {
    test('parseInterfaces', () => {
        assert.deepEqual(parseInterfaces('BidCos-RF,HmIP-RF'), ['BidCos-RF', 'HmIP-RF']);
        assert.deepEqual(parseInterfaces('bidcos-rf, cuxd'), ['BidCos-RF', 'CUxD']);
        assert.equal(parseInterfaces('auto'), null);
        assert.equal(parseInterfaces(''), null);
        assert.throws(() => parseInterfaces('rfd'), /unknown interface "rfd"/);
        assert.deepEqual(parseInterfaces(DEFAULT_INTERFACES.join(',')), DEFAULT_INTERFACES);
    });

    test('interfaceConfig: ports, tls, binrpc', () => {
        assert.deepEqual(interfaceConfig('BidCos-RF'), {
            name: 'BidCos-RF',
            protocol: 'xmlrpc',
            port: 2001,
            path: undefined,
            init: true,
            ping: true,
            pingTimeout: undefined,
            dutyCycle: true,
        });
        assert.equal(interfaceConfig('BidCos-RF', {tls: true}).port, 42001);
        assert.equal(interfaceConfig('BidCos-RF', {bidcosBinrpc: true}).protocol, 'binrpc');
        assert.equal(interfaceConfig('BidCos-RF', {bidcosBinrpc: true, tls: true}).protocol, 'xmlrpc');
        assert.equal(interfaceConfig('HmIP-RF', {bidcosBinrpc: true}).protocol, 'xmlrpc');
        assert.equal(interfaceConfig('HmIP-RF').pingTimeout, 600);
        assert.equal(interfaceConfig('VirtualDevices').path, '/groups');
        assert.equal(interfaceConfig('VirtualDevices').ping, false);
        assert.equal(interfaceConfig('CUxD').protocol, 'binrpc');
        assert.equal(interfaceConfig('CUxD', {tls: true}).port, 8701);
        assert.throws(() => interfaceConfig('rfd'), /unknown interface/);
    });

    test('probeInterfaces uses the injected connect', async () => {
        const asked = [];
        const found = await probeInterfaces('ccu', {
            connect: async (host, port) => {
                asked.push(port);
                return [2001, 2010].includes(port);
            },
        });
        assert.deepEqual(found, ['BidCos-RF', 'HmIP-RF']);
        assert.deepEqual(asked, [2001, 2000, 2010, 9292, 8701]);
    });
});
