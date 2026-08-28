/**
 * Finding CCUs on the network (core B-2): the eQ-3 UDP broadcast probe plus the interface ports,
 * declared as a discovery hint the core scans with.
 *
 * The probe and the reply layout come from
 * [hm-discover](https://github.com/hobbyquaker/hm-discover): a datagram to UDP 43439 that every
 * eQ-3 device (CCU1/2/3, RaspberryMatic, HmIP access points) answers with its type, serial and
 * firmware version. Which interfaces the CCU actually runs is then read off the ports that
 * answer — the same table `--interfaces auto` probes.
 */

import {INTERFACES, INTERFACE_NAMES, interfaceConfig} from './interfaces.js';

/** eQ-3 discovery port and the magic datagram: header + "eQ3-*\0*\0I". */
export const EQ3_PORT = 43439;
export const EQ3_HEADER = '028f91c001';
export const EQ3_PROBE = Buffer.from([
    0x02, 0x8f, 0x91, 0xc0, 0x01, 0x65, 0x51, 0x33, 0x2d, 0x2a, 0x00, 0x2a, 0x00, 0x49,
]);

/**
 * Parse an eQ-3 discovery answer: the 5 byte header, then NUL terminated type and serial, three
 * flag bytes, then the firmware version.
 * @param {Buffer} message
 * @returns {{type: string, serial: string, version?: string} | null} null for a foreign datagram
 */
export function parseEq3(message) {
    if (!Buffer.isBuffer(message) || message.length < 8 || message.subarray(0, 5).toString('hex') !== EQ3_HEADER) {
        return null;
    }
    let offset = 5;
    const string = () => {
        const end = message.indexOf(0, offset);
        if (end < 0) {
            return null;
        }
        const value = message.toString('latin1', offset, end);
        offset = end + 1;
        return value;
    };
    const type = string();
    const serial = string();
    if (type === null || serial === null) {
        return null;
    }
    offset += 3; // three flag bytes between the serial and the version
    const version = string();
    return {type, serial, ...(version ? {version} : {})};
}

/** The ports discovery probes on a candidate: ReGa plus every interface process. */
export function ports({tls = false} = {}) {
    const map = {ReGa: tls ? 48181 : 8181};
    for (const name of INTERFACE_NAMES) {
        map[name] = interfaceConfig(name, {tls}).port;
    }
    return map;
}

/**
 * The hint `--discover` and `--ccu-address auto` scan with. A CCU answers the broadcast; the
 * ports say which interfaces it runs. `requirePort: false` keeps a CCU that answered the probe
 * but has, say, only HmIP-RF enabled and every other port closed — the broadcast answer is proof
 * enough, and the open ports are shown as information.
 */
export function discoveryHint({tls = false} = {}) {
    return {
        udp: {port: EQ3_PORT, payload: EQ3_PROBE, parse: parseEq3},
        ports: ports({tls}),
        requirePort: false,
    };
}

/** The interfaces of a discovered CCU, in table order, from the probed ports. */
export function interfacesOf(entry) {
    return INTERFACE_NAMES.filter((name) => entry && entry.services && entry.services[name]);
}

export {INTERFACES};
