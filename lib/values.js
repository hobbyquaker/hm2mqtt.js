/**
 * Datapoint values: builds the message of an event exactly like node-red-contrib-ccu's
 * createMessage() (the `hm` block of the payload), keeps the last message per datapoint
 * (persisted as values.json) and applies the actuator "wait for WORKING" rule.
 */

import fs from 'node:fs';
import path from 'node:path';

const WORKING_WAIT_MS = 300;

/** channel types whose STATE / ARMSTATE / LEVEL* come together with WORKING/DIRECTION */
export function waitsForWorking(datapoint, channelType) {
    if (!channelType) {
        return false;
    }
    if (datapoint === 'STATE') {
        return /SIGNAL|SWITCH|RAINDETECTOR_HEAT|ALARMACTUATOR/.test(channelType);
    }
    if (datapoint === 'ARMSTATE') {
        return channelType === 'ARMING';
    }
    if (datapoint.startsWith('LEVEL')) {
        return /DIMMER|DUAL_WHITE|BLIND|SHUTTER|JALOUSIE|WINMATIC|KEYMATIC/.test(channelType);
    }
    return false;
}

/** the interface processes deliver "°C" as a lone latin1 byte which arrives as U+FFFD */
export function unit(description) {
    const u = description && description.UNIT;
    if (!u || u === '""') {
        return undefined;
    }
    return String(u).replace(/�/g, '°');
}

/** true for datapoints that are events, not state: PRESS_* and every ACTION */
export function isEvent(datapoint, description) {
    return datapoint.startsWith('PRESS_') || Boolean(description && description.TYPE === 'ACTION');
}

/** The `hm` block of a payload: the message without topic/payload/value. */
export function hmBlock(message) {
    const hm = {...message};
    delete hm.topic;
    delete hm.payload;
    delete hm.value;
    return hm;
}

export class ValueStore {
    /**
     * @param {object} o
     * @param {string} o.host CCU address (`ccu` field)
     * @param {object} o.context lookups: device(iface, address), valueDescription(iface, address, datapoint),
     *        channelName(address), rooms(address), functions(address)
     * @param {string} [o.stateDir]
     * @param {object} o.log
     * @param {object} [o.timers] {setTimeout, clearTimeout, now}
     */
    constructor({host, context, stateDir, log, timers}) {
        this.host = host;
        this.context = context;
        this.stateDir = stateDir;
        this.log = log;
        this.timers = {setTimeout, clearTimeout, now: Date.now, ...(timers || {})};
        this.values = new Map();
        this.workingTimers = new Map();
    }

    file() {
        return this.stateDir ? path.join(this.stateDir, 'values.json') : null;
    }

    load() {
        const file = this.file();
        if (!file) {
            return;
        }
        try {
            const {values} = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const [name, message] of Object.entries(values || {})) {
                this.values.set(name, {...message, cache: true, change: false, uncertain: true});
            }
            this.log.info('loaded', this.values.size, 'values from', file);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.log.warn('cannot read', file, '-', err.message);
            }
        }
    }

    save() {
        const file = this.file();
        if (!file) {
            return;
        }
        try {
            fs.mkdirSync(this.stateDir, {recursive: true});
            fs.writeFileSync(file, JSON.stringify({values: Object.fromEntries(this.values)}));
            this.log.debug('saved', this.values.size, 'values to', file);
        } catch (err) {
            this.log.warn('cannot save', file, '-', err.message);
        }
    }

    get(iface, channel, datapoint) {
        return this.values.get(`${iface}.${channel}.${datapoint}`);
    }

    /**
     * node-red-contrib-ccu createMessage(): the full message of a datapoint value.
     * @param {string} iface
     * @param {string} channel
     * @param {string} datapoint
     * @param {*} value
     * @param {object} [additions] cache, uncertain, working, direction, ts, lc, change overrides
     */
    message(iface, channel, datapoint, value, additions = {}) {
        const {context} = this;
        const datapointName = `${iface}.${channel}.${datapoint}`;
        const previous = this.values.get(datapointName) || {};
        const channelDevice = context.device(iface, channel);
        const deviceAddress = channelDevice && channelDevice.PARENT;
        const device = deviceAddress ? context.device(iface, deviceAddress) : undefined;
        const description = context.valueDescription(iface, channel, datapoint) || {};
        const ts = this.timers.now();
        const valueStable = additions.working ? previous.valueStable : value;
        const change =
            description.TYPE === 'ACTION' ||
            Boolean(previous.cache) ||
            previous.payload !== value ||
            previous.valueStable !== valueStable;
        const rooms = context.rooms(channel) || [];
        const functions = context.functions(channel) || [];
        const list = description.VALUE_LIST || description.ENUM;
        const channelIndex = channel.includes(':') ? Number.parseInt(channel.split(':')[1], 10) : undefined;

        const message = {
            topic: '',
            payload: value,
            ccu: this.host,
            iface,
            device: deviceAddress,
            deviceName: deviceAddress ? context.channelName(deviceAddress) : undefined,
            deviceType: device && device.TYPE,
            channel,
            channelName: context.channelName(channel),
            channelType: channelDevice && channelDevice.TYPE,
            channelIndex,
            datapoint,
            datapointName,
            datapointType: description.TYPE,
            datapointMin: description.MIN,
            datapointMax: description.MAX,
            datapointEnum: list,
            datapointDefault: description.DEFAULT,
            datapointControl: description.CONTROL,
            datapointUnit: unit(description),
            value,
            valuePrevious: previous.value,
            valueEnum: Array.isArray(list) ? list[Number(value)] : undefined,
            valueStable,
            rooms,
            room: rooms.length > 0 ? rooms[0] : undefined,
            functions,
            function: functions.length > 0 ? functions[0] : undefined,
            ts,
            tsPrevious: previous.ts,
            lc: change ? ts : previous.lc,
            change,
            ...additions,
        };
        message.stable = !message.working;
        return message;
    }

    /**
     * Applies an event from an interface process. `emit(message)` is called once the value is
     * final — immediately, or 300 ms later for actuator datapoints whose WORKING/DIRECTION may
     * follow in a separate call (node-red-contrib-ccu's publishEvent).
     * @param {{iface: string, channel: string, datapoint: string, value: *, working?: boolean, direction?: number}} event
     * @param {(message: object) => void} emit
     */
    event({iface, channel, datapoint, value, working, direction}, emit) {
        const message = this.message(iface, channel, datapoint, value, {
            cache: false,
            uncertain: false,
            working,
            direction,
        });
        if (working || !waitsForWorking(datapoint, message.channelType)) {
            this.values.set(message.datapointName, message);
            emit(message);
            return;
        }
        const key = message.datapointName;
        this.timers.clearTimeout(this.workingTimers.get(key));
        this.workingTimers.set(
            key,
            this.timers.setTimeout(() => {
                this.workingTimers.delete(key);
                const v = (dp) => this.get(iface, channel, dp);
                const w = v('WORKING') || v('WORKING_SLATS');
                if (w) {
                    message.working = Boolean(
                        (v('WORKING') && v('WORKING').value) || (v('WORKING_SLATS') && v('WORKING_SLATS').value),
                    );
                } else if (v('PROCESS')) {
                    message.working = Boolean(v('PROCESS').value);
                }
                if (v('DIRECTION')) {
                    message.direction = v('DIRECTION').value;
                } else if (v('ACTIVITY_STATE')) {
                    const a = v('ACTIVITY_STATE').value;
                    message.direction = a === 0 ? 3 : a === 3 ? 0 : a;
                }
                message.stable = !message.working;
                this.values.set(key, message);
                emit(message);
            }, WORKING_WAIT_MS),
        );
    }

    /**
     * A value from the ReGa cache (getValues) — not an event: cache/uncertain flags, CCU timestamp.
     * @param {{name: string, value: *, ts: number}} dp name = <iface>.<channel>.<datapoint>
     * @returns {object | null} the message, null when the name does not parse
     */
    cached({name, value, ts}) {
        const [iface, channel, datapoint] = String(name).split('.');
        if (!iface || !channel || !datapoint) {
            return null;
        }
        if ((datapoint === 'RSSI_DEVICE' || datapoint === 'RSSI_PEER') && typeof value === 'number' && value > 127) {
            value -= 256; // the ReGa reports the unsigned byte
        }
        const now = this.timers.now();
        const message = this.message(iface, channel, datapoint, value, {
            cache: true,
            change: false,
            working: false,
            uncertain: !ts,
            ts: ts || now,
            lc: ts || now,
        });
        this.values.set(message.datapointName, message);
        return message;
    }

    /** The LEVEL_NOTWORKING / STATE_NOTWORKING companion of a message, or null. */
    notWorking(message) {
        if (message.working !== false || !['LEVEL', 'STATE'].includes(message.datapoint)) {
            return null;
        }
        return {
            ...message,
            datapoint: message.datapoint + '_NOTWORKING',
            datapointName: message.datapointName + '_NOTWORKING',
        };
    }

    stop() {
        for (const timer of this.workingTimers.values()) {
            this.timers.clearTimeout(timer);
        }
        this.workingTimers.clear();
    }
}
