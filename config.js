import {parseConfig} from 'mqtt-interfaces-core';
import pkg from './package.json' with {type: 'json'};
import {DEFAULT_INTERFACES, INTERFACE_NAMES} from './lib/interfaces.js';
import {DEFAULT_ITEM_TEMPLATE, DEFAULT_SYSVAR_ITEM_TEMPLATE, DEFAULT_PROGRAM_ITEM_TEMPLATE} from './lib/topics.js';

export const OPTIONS = {
    'ccu-address': {
        alias: 'a',
        type: 'string',
        describe: 'hostname or ip of the CCU, or "auto" to find it on the network (see --discover)',
        demandOption: true,
    },
    'ccu-tls': {type: 'boolean', describe: 'use the TLS ports (4xxxx) and https for ReGa', default: false},
    'ccu-insecure': {type: 'boolean', describe: "accept the CCU's self-signed certificate", default: false},
    'ccu-username': {type: 'string', describe: 'CCU user (authentication enabled on the CCU)'},
    'ccu-password': {type: 'string', describe: 'CCU password', secret: true},
    interfaces: {
        alias: 'i',
        type: 'string',
        describe: `comma separated interfaces (${INTERFACE_NAMES.join(', ')}) or "auto" (probe the ports)`,
        default: DEFAULT_INTERFACES.join(','),
    },
    'bidcos-binrpc': {
        type: 'boolean',
        describe: 'talk binrpc instead of xmlrpc to BidCos-RF and BidCos-Wired',
        default: false,
    },
    'listen-address': {
        alias: 'l',
        type: 'string',
        describe: 'address the rpc callback servers bind to (default: first non-loopback ipv4)',
    },
    'init-address': {
        type: 'string',
        describe: 'address the CCU calls back (default: listen address); needed behind NAT/Docker',
    },
    'xmlrpc-port': {type: 'number', describe: 'xmlrpc callback server port', default: 2126},
    'binrpc-port': {type: 'number', describe: 'binrpc callback server port', default: 2127},
    'ping-timeout': {
        type: 'number',
        describe: 'seconds without an event before ping / re-init (HmIP-RF: 600)',
        default: 60,
    },
    rega: {
        type: 'boolean',
        describe: 'names, rooms, functions, variables and programs from ReGa (--no-rega: addresses only)',
        default: true,
    },
    'rega-poll-interval': {type: 'number', describe: 'seconds between variable/program polls, 0 = off', default: 30},
    'rega-names-interval': {
        type: 'number',
        describe:
            'seconds between re-reads of names, rooms and functions from ReGa, 0 = only at start and on set/rega/sync',
        default: 3600,
    },
    'rega-poll-trigger': {
        type: 'string',
        describe: 'channel.datapoint whose event triggers a variable/program poll, e.g. BidCoS-RF:50.PRESS_SHORT',
    },
    'ccu-timezone': {type: 'string', describe: "IANA time zone of the CCU (default: this host's time zone)"},
    'name-file': {
        alias: 'm',
        type: 'string',
        describe: 'JSON file {address: name} overriding the ReGa names (see example-names.json)',
        file: {
            format: 'json',
            example: 'example-names.json',
            schema: 'names.schema.json',
            describe: 'device and channel names',
        },
    },
    'item-template': {
        type: 'string',
        describe:
            'item (topic part after status/ and set/) of a datapoint; ${field} placeholders with | fallbacks, every hm field',
        default: DEFAULT_ITEM_TEMPLATE,
    },
    'sysvar-item-template': {
        type: 'string',
        describe: 'item of a system variable',
        default: DEFAULT_SYSVAR_ITEM_TEMPLATE,
    },
    'program-item-template': {type: 'string', describe: 'item of a program', default: DEFAULT_PROGRAM_ITEM_TEMPLATE},
    payload: {
        type: 'string',
        describe:
            'status payload format: mqsh-extended ({val, ts, lc, hm}), mqsh-basic ({val, ts, lc}) or plain (value only, booleans as 0/1)',
        choices: ['plain', 'mqsh-basic', 'mqsh-extended'],
        default: 'mqsh-extended',
    },
    'hm-payload': {type: 'boolean', describe: 'deprecated: --no-hm-payload = --payload mqsh-basic', hidden: true},
    'plain-tree': {
        type: 'string',
        describe: 'additionally publish plain payloads under <name>/<level>/... (e.g. "state")',
    },
    'publish-cache': {type: 'boolean', describe: 'publish every datapoint value from ReGa at start', default: false},
    'publish-counters': {
        type: 'boolean',
        describe: 'publish rpc rx/tx counters on counter/<interface>/rx|tx',
        default: true,
    },
    'duty-cycle-interval': {type: 'number', describe: 'seconds between duty cycle polls, 0 = off', default: 90},
    ignore: {
        type: 'string',
        describe:
            'comma separated globs on <interface>.<channel>.<datapoint> not to publish, e.g. "*.*.RSSI_*,HmIP-RF.*.*_STATUS"',
    },
    'ha-generic': {
        type: 'boolean',
        describe: 'Home Assistant discovery: also announce datapoints without a role as (disabled) generic entities',
        default: true,
    },
    'rpc-topics': {
        type: 'boolean',
        describe: 'accept arbitrary rpc calls on <name>/rpc/<interface>/<method>/<callid> (security surface!)',
        default: false,
    },
    'state-dir': {
        type: 'string',
        describe:
            'directory for devices, paramset descriptions, names and last values (default: $STATE_DIRECTORY or ~/.hm2mqtt)',
        default: process.env.STATE_DIRECTORY,
    },
};

export default parseConfig({
    pkg,
    options: OPTIONS,
    defaults: {name: 'hm'},
    discovery: true,
    examples: [
        ['$0 --discover', 'find CCUs on the network and exit'],
        ['$0 -a homematic-ccu3 -u mqtt://broker', 'run in the foreground'],
        ['$0 -a 192.168.1.50 -i BidCos-RF,HmIP-RF --plain-tree state', 'two interfaces plus the plain mirror tree'],
        ['sudo $0 --install -n hm -a homematic-ccu3 -u mqtt://broker', 'install as service hm2mqtt@hm'],
    ],
});
