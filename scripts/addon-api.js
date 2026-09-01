#!/usr/bin/env node

/**
 * One-shot helpers for the CCU addon's web UI, called through `www/api.cgi`. Everything here is
 * a short-lived process that prints one JSON object and exits - the addon runs no HTTP server of
 * its own, and the UI's interactive bits (probe the interfaces, test the broker, preview an item
 * template) would otherwise need one.
 *
 *   node scripts/addon-api.js discover   [--timeout 4000]
 *   node scripts/addon-api.js probe      --host 127.0.0.1 [--tls]
 *   node scripts/addon-api.js mqtt-test  --url mqtt://host:1883 [--username u] [--password p]
 *   node scripts/addon-api.js preview    --host 127.0.0.1 --template '${prefix}/status/${channelName|channel}/${datapoint}' [--prefix hm]
 *
 * Errors are JSON too ({"error": "..."}), so the UI never has to parse a stack trace.
 */

import Rega from 'homematic-rega';
import {discover} from 'mqtt-interfaces-core';
import {probeInterfaces, detectLocal, isLocalHost, regaPort, INTERFACE_NAMES} from '../lib/interfaces.js';
import {discoveryHint, interfacesOf} from '../lib/discovery.js';
import {compileTemplate, DEFAULT_TOPIC_STATUS} from '../lib/topics.js';

const [command, ...rest] = process.argv.slice(2);

/**
 * Parses `--key value` and `--flag` arguments.
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

const args = parseArgs(rest);

/**
 * ReGa client for the CCU the addon runs on. Port 8183 is ReGaHSS' own listener, which needs no
 * authentication - it exists on the CCU itself, so a local addon never has to ask for credentials.
 * @param {object} options
 * @returns {Rega}
 */
function rega({host = '127.0.0.1', port, username, password} = {}) {
    return new Rega({
        host,
        port: port ? Number(port) : regaPort({local: isLocalHost(host)}),
        username,
        password,
        translate: false,
    });
}

const commands = {
    // the same broadcast probe as --discover, for an addon that bridges a CCU elsewhere in the
    // network rather than the one it runs on
    async discover() {
        const found = await discover(discoveryHint({tls: Boolean(args.tls)}), {
            timeout: Number(args.timeout || 4000),
            // broadcast only: a subnet sweep can run for minutes, which is not something a web
            // page should wait for. `hm2mqtt --discover` on a shell still does the full search.
            sweep: false,
        });
        return {
            ccus: [...found.values()].map((entry) => ({
                address: entry.address,
                name: entry.name || entry.serial || '',
                interfaces: interfacesOf(entry),
            })),
        };
    },

    async probe() {
        const host = String(args.host || '127.0.0.1');
        // on the CCU the addon talks to the interface processes directly, so probe those ports -
        // the proxy ports may answer as well, but they are not what will be connected to
        const local = args.local === undefined ? await detectLocal(host) : args.local !== 'false';
        const found = await probeInterfaces(host, {tls: Boolean(args.tls), local, timeout: 2000});
        return {host, local, interfaces: found, known: INTERFACE_NAMES};
    },

    async 'mqtt-test'() {
        const url = String(args.url || '');
        if (!url) throw new Error('--url is required');
        // mqtt comes with mqtt-interfaces-core; if it cannot be resolved the test degrades to a
        // plain connect instead of failing outright
        const {default: mqtt} = await import('mqtt');
        const started = Date.now();
        const client = mqtt.connect(url, {
            username: args.username ? String(args.username) : undefined,
            password: args.password ? String(args.password) : undefined,
            clientId: 'hm2mqtt-addon-test-' + Math.random().toString(16).slice(2, 8),
            connectTimeout: 8000,
            reconnectPeriod: 0,
        });
        try {
            await new Promise((resolve, reject) => {
                client.once('connect', resolve);
                client.once('error', reject);
                client.once('close', () => reject(new Error('connection closed')));
            });
            return {ok: true, ms: Date.now() - started};
        } finally {
            client.end(true);
        }
    },

    async preview() {
        const template = String(args.template || DEFAULT_TOPIC_STATUS);
        const prefix = String(args.prefix || 'hm');
        const render = compileTemplate(template);
        const limit = Number(args.limit || 5);
        const channels = await rega(args).getChannels();
        const datapoints = ['STATE', 'LEVEL', 'TEMPERATURE'];
        const examples = channels.slice(0, limit).map((ch, index) => {
            const datapoint = datapoints[index % datapoints.length];
            const fields = {
                prefix,
                channel: ch.address,
                channelName: ch.name,
                device: String(ch.address).split(':')[0],
                datapoint,
            };
            const {name, changed} = render(fields);
            return {channel: ch.name || ch.address, datapoint, item: name, sanitized: changed};
        });
        return {template, examples};
    },
};

if (!command || !commands[command]) {
    process.stdout.write(JSON.stringify({error: `unknown command "${command || ''}"`}) + '\n');
    process.exit(1);
}

try {
    const result = await commands[command]();
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
} catch (error) {
    process.stdout.write(JSON.stringify({error: error.message || String(error)}) + '\n');
    process.exit(1);
}
