/**
 * What the Home Assistant discovery published, per device (task 32): block id → component key →
 * platform, kept in the state directory across restarts. The next build removes from Home Assistant
 * what it no longer publishes - a component with a `{p}` stub, a block of its own by an empty
 * retained config - which the core alone does only for blocks that vanish within one run.
 */

import fs from 'node:fs';
import path from 'node:path';

import {discoveryTopic} from 'mqtt-interfaces-core';
import {discoveryBlocks} from './hadiscovery.js';

export class HaRecord {
    /**
     * @param {object} o
     * @param {string} [o.stateDir] no directory: nothing is kept
     * @param {{warn: Function}} o.log
     */
    constructor({stateDir, log}) {
        this.file = stateDir ? path.join(stateDir, 'ha-discovery.json') : null;
        this.log = log;
        this.devices = {};
        this.written = null;
    }

    load() {
        if (!this.file) {
            return this;
        }
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.devices = data && data.devices && typeof data.devices === 'object' ? data.devices : {};
        } catch {
            this.devices = {};
        }
        this.written = JSON.stringify({devices: this.devices});
        return this;
    }

    save(devices) {
        this.devices = devices;
        const text = JSON.stringify({devices});
        if (!this.file || text === this.written) {
            return;
        }
        try {
            const temporary = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(temporary, text);
            fs.renameSync(temporary, this.file);
            this.written = text;
        } catch (error) {
            this.log.warn('could not write', this.file, error.message);
        }
    }
}

/**
 * The blocks for the core's discovery(): built against the record, the configs to remove sent
 * first (empty and retained, before the core publishes the blocks), the record updated.
 * @param {object} o
 * @param {object} o.ctx the discovery context (without `previous`)
 * @param {HaRecord} o.record
 * @param {string} o.prefix the discovery prefix
 * @param {(topic: string, payload: string, options: object) => void} o.publish
 * @returns {object[]} the blocks
 */
export function recordedDiscovery({ctx, record, prefix, publish}) {
    const {blocks, clear, published} = discoveryBlocks({...ctx, previous: record.devices});
    for (const id of clear) {
        publish(discoveryTopic(prefix || 'homeassistant', id), '', {retain: true});
    }
    record.save(published);
    return blocks;
}
