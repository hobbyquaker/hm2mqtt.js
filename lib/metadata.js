/**
 * Devices/channels per interface and the paramset descriptions, persisted in the state
 * directory (devices.json, paramsets.json). The description table is seeded from the
 * paramsets.json node-red-contrib-ccu collected, so most devices need no fetch.
 */

import fs from 'node:fs';
import path from 'node:path';

const SAVE_DELAY_MS = 2000;

export class Metadata {
    /**
     * @param {object} o
     * @param {string} o.stateDir
     * @param {string} [o.seedFile] paramsets.json shipped with the package
     * @param {object} o.log
     */
    constructor({stateDir, seedFile, log}) {
        this.stateDir = stateDir;
        this.seedFile = seedFile;
        this.log = log;
        this.devices = {};
        this.descriptions = {};
        this.dirty = {devices: false, descriptions: false};
        this.saveTimer = null;
    }

    file(name) {
        return path.join(this.stateDir, name);
    }

    readJson(file) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.log.warn('cannot read', file, '-', err.message);
            }
            return null;
        }
    }

    load() {
        const devices = this.readJson(this.file('devices.json'));
        if (devices && typeof devices === 'object') {
            this.devices = devices;
            const n = Object.values(devices).reduce((sum, d) => sum + Object.keys(d).length, 0);
            this.log.info('loaded', n, 'devices/channels from', this.file('devices.json'));
        }
        const descriptions = this.readJson(this.file('paramsets.json'));
        if (descriptions && typeof descriptions === 'object') {
            this.descriptions = descriptions;
            this.log.info(
                'loaded',
                Object.keys(descriptions).length,
                'paramset descriptions from',
                this.file('paramsets.json'),
            );
        } else if (this.seedFile) {
            const seed = this.readJson(this.seedFile);
            if (seed) {
                this.descriptions = seed;
                this.dirty.descriptions = true;
                this.log.info('loaded', Object.keys(seed).length, 'paramset descriptions from the seed', this.seedFile);
                this.save();
            }
        }
    }

    scheduleSave() {
        if (this.saveTimer) {
            return;
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.save();
        }, SAVE_DELAY_MS);
        if (typeof this.saveTimer.unref === 'function') {
            this.saveTimer.unref();
        }
    }

    save() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        try {
            fs.mkdirSync(this.stateDir, {recursive: true});
            if (this.dirty.devices) {
                fs.writeFileSync(this.file('devices.json'), JSON.stringify(this.devices));
                this.dirty.devices = false;
                this.log.debug('saved', this.file('devices.json'));
            }
            if (this.dirty.descriptions) {
                fs.writeFileSync(this.file('paramsets.json'), JSON.stringify(this.descriptions));
                this.dirty.descriptions = false;
                this.log.debug('saved', this.file('paramsets.json'));
            }
        } catch (err) {
            this.log.warn('cannot save state to', this.stateDir, '-', err.message);
        }
    }

    /*
     * devices
     */

    device(iface, address) {
        return this.devices[iface] && this.devices[iface][address];
    }

    /** The interface a device/channel address belongs to. */
    findIface(address) {
        for (const iface of Object.keys(this.devices)) {
            if (this.devices[iface][address]) {
                return iface;
            }
        }
        return undefined;
    }

    count(iface) {
        if (iface) {
            return this.devices[iface] ? Object.keys(this.devices[iface]).length : 0;
        }
        return Object.values(this.devices).reduce((sum, d) => sum + Object.keys(d).length, 0);
    }

    /**
     * Records devices the CCU announced (newDevices). Returns the addresses that were unknown.
     * @param {string} iface
     * @param {object[]} devices
     * @returns {string[]}
     */
    addDevices(iface, devices) {
        if (!this.devices[iface]) {
            this.devices[iface] = {};
        }
        const added = [];
        for (const device of devices) {
            if (!device || typeof device.ADDRESS !== 'string' || !device.TYPE) {
                continue;
            }
            if (!this.devices[iface][device.ADDRESS]) {
                added.push(device.ADDRESS);
            }
            this.devices[iface][device.ADDRESS] = device;
            this.dirty.devices = true;
        }
        if (added.length > 0) {
            this.scheduleSave();
        }
        return added;
    }

    deleteDevices(iface, addresses) {
        if (!this.devices[iface]) {
            return [];
        }
        const deleted = [];
        for (const address of addresses) {
            if (this.devices[iface][address]) {
                delete this.devices[iface][address];
                deleted.push(address);
                this.dirty.devices = true;
            }
        }
        if (deleted.length > 0) {
            this.scheduleSave();
        }
        return deleted;
    }

    /**
     * What we tell the CCU on listDevices(): HmIP-RF and VirtualDevices want the whole device,
     * the others only ADDRESS and VERSION (node-red-contrib-ccu's listDevicesAnswer).
     */
    listDevicesAnswer(iface) {
        const devices = this.devices[iface] || {};
        return Object.values(devices).map((device) => {
            if (iface !== 'HmIP-RF' && iface !== 'VirtualDevices') {
                return {ADDRESS: device.ADDRESS, VERSION: device.VERSION};
            }
            const answer = {};
            for (const key of [
                'ADDRESS',
                'VERSION',
                'AES_ACTIVE',
                'CHILDREN',
                'DIRECTION',
                'FIRMWARE',
                'FLAGS',
                'GROUP',
                'INDEX',
                'INTERFACE',
                'LINK_SOURCE_ROLES',
                'LINK_TARGET_ROLES',
                'PARAMSETS',
                'PARENT',
                'PARENT_TYPE',
                'RF_ADDRESS',
                'ROAMING',
                'RX_MODE',
                'TEAM',
                'TEAM_CHANNELS',
                'TEAM_TAG',
                'TYPE',
            ]) {
                // https://github.com/eq-3/occu/issues/83 — empty strings make the CCU choke
                if (device[key] !== undefined && device[key] !== '') {
                    answer[key] = device[key];
                }
            }
            return answer;
        });
    }

    /*
     * paramset descriptions
     */

    /**
     * Key of a paramset description: interface, device type, firmware, version, channel type,
     * paramset. Link paramsets (peer address as name) share the LINK key.
     */
    paramsetKey(iface, device, paramset) {
        if (!device) {
            return undefined;
        }
        let channelType = '';
        let parent = device;
        if (device.PARENT) {
            channelType = device.TYPE;
            parent = this.device(iface, device.PARENT);
            if (!parent) {
                return undefined;
            }
        }
        if (/^[\da-f]+:\d+$/i.test(paramset)) {
            paramset = 'LINK';
        }
        return [iface, parent.TYPE, parent.FIRMWARE, parent.VERSION, channelType, paramset].join('/');
    }

    /** Description of a whole paramset of a device/channel, undefined when not known yet. */
    description(iface, address, paramset) {
        const key = this.paramsetKey(iface, this.device(iface, address), paramset);
        return key ? this.descriptions[key] : undefined;
    }

    /** Description of one VALUES parameter (datapoint). */
    valueDescription(iface, address, datapoint) {
        const description = this.description(iface, address, 'VALUES');
        return description ? description[datapoint] : undefined;
    }

    setDescription(key, description) {
        this.descriptions[key] = description;
        this.dirty.descriptions = true;
        this.scheduleSave();
    }

    /**
     * Paramsets of the given devices (or all of an interface) whose description is unknown,
     * one entry per key.
     * @param {string} iface
     * @param {string[]} [addresses]
     * @returns {Array<{key: string, address: string, paramset: string}>}
     */
    missingDescriptions(iface, addresses) {
        const devices = this.devices[iface] || {};
        const list = addresses || Object.keys(devices);
        const seen = new Set();
        const missing = [];
        for (const address of list) {
            const device = devices[address];
            if (!device || !Array.isArray(device.PARAMSETS)) {
                continue;
            }
            for (const paramset of device.PARAMSETS) {
                const key = this.paramsetKey(iface, device, paramset);
                if (!key || this.descriptions[key] || seen.has(key)) {
                    continue;
                }
                seen.add(key);
                missing.push({key, address, paramset});
            }
        }
        return missing;
    }

    /**
     * Fetches the missing descriptions sequentially (the CCU does not like bursts).
     * @param {string} iface
     * @param {(method: string, params: Array) => Promise<*>} methodCall
     * @param {{addresses?: string[], pause?: number, sleep?: Function}} [o]
     * @returns {Promise<number>} number fetched
     */
    async fetchDescriptions(iface, methodCall, {addresses, pause = 200, sleep} = {}) {
        const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        const missing = this.missingDescriptions(iface, addresses);
        if (missing.length === 0) {
            return 0;
        }
        this.log.info(iface, 'fetching', missing.length, 'paramset descriptions');
        let fetched = 0;
        for (const {key, address, paramset} of missing) {
            if (this.descriptions[key]) {
                continue;
            }
            try {
                const description = await methodCall('getParamsetDescription', [address, paramset]);
                if (description && typeof description === 'object') {
                    this.setDescription(key, description);
                    fetched += 1;
                }
            } catch (err) {
                this.log.warn(iface, 'getParamsetDescription', address, paramset, 'failed:', err.message);
            }
            await wait(pause);
        }
        this.save();
        return fetched;
    }
}
