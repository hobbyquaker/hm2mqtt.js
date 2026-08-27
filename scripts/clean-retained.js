#!/usr/bin/env node

/**
 * Lists (and with --yes clears) retained messages matching topic patterns — for the cutover
 * (ROADMAP §9): the Node-RED flow left retained topics for unnamed channels (`hm/status//X`)
 * and for devices and names that no longer exist.
 *
 *   node scripts/clean-retained.js mqtt://broker 'hm/status//#'            # list only
 *   node scripts/clean-retained.js mqtt://broker 'hm/status//#' 'hm3/#' --yes
 *   node scripts/clean-retained.js mqtts://broker:8883 'hm/#' --ca ca.pem --grep 'Alte Lampe'
 */

import fs from 'node:fs';
import mqtt from 'mqtt';

const args = process.argv.slice(2);
const take = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args.splice(i, 2)[1];
};
const ca = take('--ca');
const grep = take('--grep');
const seconds = Number(take('--seconds') || 5);
const yes = args.includes('--yes');
const patterns = args.filter((a) => !a.startsWith('--') && a !== args[0]);
const url = args[0];
if (!url || patterns.length === 0) {
    console.error(
        'usage: clean-retained.js <mqtt-url> <pattern>... [--grep <substring>] [--seconds 5] [--ca file] [--yes]',
    );
    process.exit(1);
}

const found = new Map();
const client = mqtt.connect(url, {ca: ca ? fs.readFileSync(ca) : undefined, rejectUnauthorized: Boolean(ca)});
client.on('connect', () => {
    client.subscribe(patterns);
    console.error(`collecting retained messages for ${patterns.join(', ')} (${seconds} s) …`);
});
client.on('message', (topic, payload, packet) => {
    if (packet.retain && payload.length > 0 && (!grep || topic.includes(grep))) {
        found.set(topic, payload.toString().slice(0, 80));
    }
});
setTimeout(() => {
    const topics = [...found.keys()].sort();
    for (const t of topics) {
        console.log(`${t}  ${found.get(t)}`);
    }
    console.error(`${topics.length} retained topics`);
    if (!yes) {
        console.error('dry run — add --yes to clear them');
        client.end(true);
        return;
    }
    let n = 0;
    for (const t of topics) {
        client.publish(t, '', {retain: true}, () => {
            n += 1;
            if (n === topics.length) {
                console.error(`cleared ${n}`);
                client.end(true);
            }
        });
    }
    if (topics.length === 0) {
        client.end(true);
    }
}, seconds * 1000);
