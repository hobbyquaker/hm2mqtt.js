/**
 * The eQ-3 broadcast probe and what it answers (core B-2). The reply layout is the one
 * hm-discover parses; the fixture below is a real CCU3 answer with the serial replaced.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {EQ3_PORT, EQ3_PROBE, discoveryHint, interfacesOf, parseEq3, ports} from '../lib/discovery.js';

/** A reply: header, type\0, serial\0, three flag bytes, version\0. */
function reply({type = 'eQ3-HM-CCU2-App', serial = 'KEQ0112345', version = '3.75.6'} = {}) {
    return Buffer.concat([
        Buffer.from([0x02, 0x8f, 0x91, 0xc0, 0x01]),
        Buffer.from(`${type}\0${serial}\0`, 'latin1'),
        Buffer.from([0x00, 0x00, 0x00]),
        Buffer.from(`${version}\0`, 'latin1'),
    ]);
}

describe('the probe datagram', () => {
    test('is the eQ-3 magic on port 43439', () => {
        assert.equal(EQ3_PORT, 43439);
        assert.equal(EQ3_PROBE.subarray(0, 5).toString('hex'), '028f91c001');
        // hm-discover built this array with 'e', 'Q', '3' as *strings*, which Buffer.from turns
        // into 0x00 — the bytes below are what it meant to send
        assert.equal(EQ3_PROBE.subarray(5).toString('latin1'), 'eQ3-*\0*\0I');
        assert.equal(EQ3_PROBE.length, 14);
    });
});

describe('parseEq3', () => {
    test('type, serial and firmware version of a CCU answer', () => {
        assert.deepEqual(parseEq3(reply()), {
            type: 'eQ3-HM-CCU2-App',
            serial: 'KEQ0112345',
            version: '3.75.6',
        });
    });

    test('a RaspberryMatic answer', () => {
        const parsed = parseEq3(reply({type: 'eQ3-HmIP-CCU3-App', serial: 'RPI0001234', version: '3.79.6.20250426'}));
        assert.equal(parsed.type, 'eQ3-HmIP-CCU3-App');
        assert.equal(parsed.version, '3.79.6.20250426');
    });

    test('an answer without a version is still a CCU', () => {
        const message = Buffer.concat([
            Buffer.from([0x02, 0x8f, 0x91, 0xc0, 0x01]),
            Buffer.from('eQ3-HM-CCU2-App\0KEQ0112345\0', 'latin1'),
            Buffer.from([0x00, 0x00, 0x00]),
        ]);
        assert.deepEqual(parseEq3(message), {type: 'eQ3-HM-CCU2-App', serial: 'KEQ0112345'});
    });

    test('foreign datagrams are dropped', () => {
        assert.equal(parseEq3(Buffer.from('hello')), null);
        assert.equal(parseEq3(Buffer.from([0x02, 0x8f, 0x91, 0xc0, 0x02, 0x41, 0x00, 0x42, 0x00])), null);
        assert.equal(parseEq3(Buffer.alloc(0)), null);
        assert.equal(parseEq3('not a buffer'), null);
    });

    test('a truncated answer is dropped, not half parsed', () => {
        const truncated = Buffer.concat([
            Buffer.from([0x02, 0x8f, 0x91, 0xc0, 0x01]),
            Buffer.from('eQ3-HM-CCU2-App', 'latin1'), // no terminator
        ]);
        assert.equal(parseEq3(truncated), null);
    });
});

describe('the hint', () => {
    test('probes ReGa and every interface port', () => {
        const map = ports();
        assert.equal(map.ReGa, 8181);
        assert.equal(map['BidCos-RF'], 2001);
        assert.equal(map['HmIP-RF'], 2010);
        assert.equal(map.VirtualDevices, 9292);
        assert.equal(map.CUxD, 8701);
    });

    test('the TLS ports with --ccu-tls', () => {
        const map = ports({tls: true});
        assert.equal(map.ReGa, 48181);
        assert.equal(map['BidCos-RF'], 42001);
    });

    test('is a udp probe plus the ports, and keeps a CCU with every port closed', () => {
        const hint = discoveryHint();
        assert.equal(hint.udp.port, 43439);
        assert.equal(hint.udp.parse, parseEq3);
        assert.equal(hint.requirePort, false);
        assert.equal(hint.ports['BidCos-RF'], 2001);
    });

    test('interfacesOf reads the interfaces off the probed ports, in table order', () => {
        const entry = {
            services: {ReGa: true, 'BidCos-RF': true, 'BidCos-Wired': false, 'HmIP-RF': true, CUxD: false},
        };
        assert.deepEqual(interfacesOf(entry), ['BidCos-RF', 'HmIP-RF']);
        assert.deepEqual(interfacesOf({}), []);
    });
});
