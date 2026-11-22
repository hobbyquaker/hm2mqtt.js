/* Fixtures for the Home Assistant discovery tests: a synthetic device for every device type the
   shipped paramsets.json knows, and one device built from given channel types. */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const paramsets = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'paramsets.json'), 'utf8'));
/** the descriptions of the fixture CCU (test/fixtures), for types the shipped file lacks */
const fixtureParamsets = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'paramsets.json'), 'utf8'));

/** one device with the given channel types (channel i gets the i-th type) */
export function fixture(iface, address, type, firmware, version, channelTypes, names = {}) {
    const devices = {[iface]: {}};
    const children = channelTypes.map((_, i) => `${address}:${i}`);
    devices[iface][address] = {ADDRESS: address, TYPE: type, FIRMWARE: firmware, VERSION: version, CHILDREN: children};
    channelTypes.forEach((chType, i) => {
        devices[iface][children[i]] = {ADDRESS: children[i], TYPE: chType, PARENT: address, PARENT_TYPE: type};
    });
    const description = (ifc, chAddress) => {
        const ch = devices[ifc] && devices[ifc][chAddress];
        if (!ch) {
            return undefined;
        }
        const key = `${ifc}/${type}/${firmware}/${version}/${ch.TYPE}/VALUES`;
        const found = paramsets[key] || fixtureParamsets[key];
        if (!found) {
            throw new Error(`fixture key ${key} missing in paramsets.json`);
        }
        return found;
    };
    return {devices, description, channelName: (a) => names[a]};
}

/** every device type paramsets.json knows, one synthetic device each, all in one device table */
export function allKnown() {
    const groups = new Map();
    for (const key of Object.keys(paramsets)) {
        const [iface, type, firmware, version, chType, paramset] = key.split('/');
        if (paramset !== 'VALUES' || !iface || !type || !chType) {
            continue;
        }
        const gkey = [iface, type, firmware, version].join('/');
        if (!groups.has(gkey)) {
            groups.set(gkey, {iface, type, firmware, version: Number(version), channelTypes: []});
        }
        const g = groups.get(gkey);
        if (!g.channelTypes.includes(chType)) {
            g.channelTypes.push(chType);
        }
    }
    const devices = {};
    const descriptions = {};
    const names = {};
    let n = 0;
    for (const g of groups.values()) {
        const channelTypes = [
            ...g.channelTypes.filter((t) => t === 'MAINTENANCE'),
            ...g.channelTypes.filter((t) => t !== 'MAINTENANCE'),
        ];
        const address = 'SYN' + String(n++).padStart(7, '0');
        const fx = fixture(g.iface, address, g.type, g.firmware, g.version, channelTypes);
        devices[g.iface] = {...devices[g.iface], ...fx.devices[g.iface]};
        descriptions[address] = fx.description;
        names[address] = `${g.type} ${address}`;
        channelTypes.forEach((_, i) => {
            names[`${address}:${i}`] = i % 3 === 1 ? `Raum ${i}` : `${g.type} ${address}:${i}`;
        });
    }
    return {
        devices,
        description: (iface, address) => descriptions[address.split(':')[0]](iface, address),
        channelName: (a) => names[a],
    };
}

/** the discovery context discoveryModel() takes */
export function ctxFor(fx, more = {}) {
    return {
        adapterName: 'hm2mqtt',
        name: 'hm',
        jsonPayloads: true,
        devices: fx.devices,
        description: fx.description,
        channelName: fx.channelName,
        rooms: () => undefined,
        statusTopicFor: (iface, address, dp) => `hm/status/${fx.channelName(address) || address}/${dp}`,
        setTopicFor: (iface, address, dp) => `hm/set/${address}/${dp}`,
        interfaces: ['BidCos-RF', 'HmIP-RF'],
        ...more,
    };
}

/** the option variants the payload snapshot covers */
export const VARIANTS = {
    extended: {jsonPayloads: true, hmPayload: true, generic: true},
    basic: {jsonPayloads: true, hmPayload: false, generic: true},
    plain: {jsonPayloads: false, generic: true},
    semantic: {jsonPayloads: true, hmPayload: true, generic: false},
};

export const SNAPSHOT_ROOMS = (a) => (a.endsWith(':1') ? ['Küche'] : a.endsWith(':2') ? ['Flur', 'Küche'] : []);
