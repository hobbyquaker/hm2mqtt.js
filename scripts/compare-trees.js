#!/usr/bin/env node

/**
 * Parallel-run check before the cutover (ROADMAP §9): subscribes to two status trees on the same
 * broker, collects the retained state plus everything published while running, and prints
 * what differs. Ignores the fields that legitimately differ (timestamps, cache flags).
 *
 *   node scripts/compare-trees.js mqtt://broker hm hm3 [seconds]
 *   node scripts/compare-trees.js mqtts://user:pass@broker:8883 hm hm3 3600 --ca ca.pem
 */

import fs from 'node:fs';
import mqtt from 'mqtt';
import {compareTrees, formatReport} from '../lib/compare.js';

const args = process.argv.slice(2);
const caIndex = args.indexOf('--ca');
const ca = caIndex === -1 ? undefined : fs.readFileSync(args.splice(caIndex, 2)[1]);
const [url, leftName, rightName, seconds = '60'] = args;
if (!url || !leftName || !rightName) {
    console.error('usage: compare-trees.js <mqtt-url> <left-prefix> <right-prefix> [seconds] [--ca file]');
    process.exit(1);
}

const left = new Map();
const right = new Map();
const client = mqtt.connect(url, {ca, rejectUnauthorized: Boolean(ca)});
client.on('connect', () => {
    client.subscribe([`${leftName}/status/#`, `${rightName}/status/#`]);
    console.error(`collecting ${leftName}/status/# and ${rightName}/status/# for ${seconds} s …`);
});
client.on('message', (topic, payload) => {
    const raw = payload.toString();
    if (topic.startsWith(`${leftName}/status/`)) {
        left.set(topic.slice(leftName.length + 8), raw);
    } else if (topic.startsWith(`${rightName}/status/`)) {
        right.set(topic.slice(rightName.length + 8), raw);
    }
});
setTimeout(
    () => {
        client.end(true);
        console.log(formatReport(compareTrees(left, right), {leftName, rightName}));
    },
    Number(seconds) * 1000,
);
