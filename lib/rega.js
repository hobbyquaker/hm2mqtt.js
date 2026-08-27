/**
 * The ReGaHSS side: device/channel names, rooms and functions (persisted as rega.json),
 * system variables and programs with change detection and polling, and their set operations.
 * Messages follow node-red-contrib-ccu's sysvar/program objects (the `hm` block of the payload).
 */

import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {castVariable} from './cast.js';

export class RegaSync extends EventEmitter {
    /**
     * @param {object} o
     * @param {object} o.rega homematic-rega instance
     * @param {string} o.host CCU address (`ccu` field)
     * @param {object} [o.metadata] Metadata (channel fields of variables bound to a channel)
     * @param {string} [o.stateDir]
     * @param {Object<string, string>} [o.nameFile] {address: name} overriding ReGa names
     * @param {object} o.log
     * @param {() => number} [o.now]
     */
    constructor({rega, host, metadata, stateDir, nameFile, log, now}) {
        super();
        this.rega = rega;
        this.host = host;
        this.metadata = metadata;
        this.stateDir = stateDir;
        this.nameFile = nameFile || {};
        this.log = log;
        this.now = now || Date.now;
        this.channelNames = {};
        this.addresses = {};
        this.regaIdChannel = {};
        this.channelRooms = {};
        this.channelFunctions = {};
        this.sysvars = {};
        this.programs = {};
        this.pollPending = false;
        this.pollTimer = null;
        this.pollInterval = 0;
        this.ready = false;
    }

    file() {
        return this.stateDir ? path.join(this.stateDir, 'rega.json') : null;
    }

    load() {
        const file = this.file();
        if (!file) {
            return;
        }
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            this.channelNames = data.channelNames || {};
            this.regaIdChannel = data.regaIdChannel || {};
            this.channelRooms = data.channelRooms || {};
            this.channelFunctions = data.channelFunctions || {};
            this.applyNameFile();
            this.log.info('loaded', Object.keys(this.channelNames).length, 'names from', file);
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
            fs.writeFileSync(
                file,
                JSON.stringify({
                    channelNames: this.channelNames,
                    regaIdChannel: this.regaIdChannel,
                    channelRooms: this.channelRooms,
                    channelFunctions: this.channelFunctions,
                }),
            );
        } catch (err) {
            this.log.warn('cannot save', file, '-', err.message);
        }
    }

    applyNameFile() {
        for (const [address, name] of Object.entries(this.nameFile)) {
            if (typeof name === 'string' && name !== '') {
                this.channelNames[address] = name;
            }
        }
        this.addresses = {};
        for (const [address, name] of Object.entries(this.channelNames)) {
            // the first address of a duplicate name wins; channels win over devices
            if (!this.addresses[name] || (address.includes(':') && !this.addresses[name].includes(':'))) {
                this.addresses[name] = address;
            }
        }
    }

    /*
     * lookups
     */

    channelName(address) {
        return this.channelNames[address];
    }

    /** Address of a channel (or device, with `devices`) by ReGa name or address. */
    channelAddress(nameOrAddress, devices = false) {
        let address;
        if (this.metadata && this.metadata.findIface(nameOrAddress)) {
            address = nameOrAddress;
        } else if (this.addresses[nameOrAddress]) {
            address = this.addresses[nameOrAddress];
        } else if (!this.metadata && /^[\w-]+(:\d+)?$/.test(nameOrAddress)) {
            address = nameOrAddress;
        }
        if (!address) {
            return undefined;
        }
        return devices || address.includes(':') ? address : undefined;
    }

    rooms(address) {
        return this.channelRooms[address];
    }

    functions(address) {
        return this.channelFunctions[address];
    }

    hasVariable(name) {
        return Boolean(this.sysvars[name]);
    }

    hasProgram(name) {
        return Boolean(this.programs[name]);
    }

    /*
     * names, rooms, functions
     */

    /** Reads channels, rooms and functions. Emits 'names' when done. */
    async syncNames() {
        const channels = await this.rega.getChannels();
        if (channels.length > 0) {
            this.channelNames = {};
            this.regaIdChannel = {};
        }
        for (const ch of channels) {
            this.channelNames[ch.address] = ch.name;
            this.regaIdChannel[ch.id] = ch.address;
        }
        const rooms = await this.rega.getRooms();
        this.channelRooms = {};
        for (const room of rooms) {
            for (const id of room.channels) {
                const address = this.regaIdChannel[id];
                if (address) {
                    (this.channelRooms[address] = this.channelRooms[address] || []).push(room.name);
                }
            }
        }
        const functions = await this.rega.getFunctions();
        this.channelFunctions = {};
        for (const func of functions) {
            for (const id of func.channels) {
                const address = this.regaIdChannel[id];
                if (address) {
                    (this.channelFunctions[address] = this.channelFunctions[address] || []).push(func.name);
                }
            }
        }
        this.applyNameFile();
        this.log.info('rega:', channels.length, 'channels,', rooms.length, 'rooms,', functions.length, 'functions');
        this.save();
        this.emit('names');
    }

    /*
     * variables and programs
     */

    channelFields(channelId) {
        const channel = this.regaIdChannel[channelId];
        if (!channel) {
            return {};
        }
        const iface = this.metadata && this.metadata.findIface(channel);
        const ch = iface && this.metadata.device(iface, channel);
        const deviceAddress = ch && ch.PARENT;
        const device = deviceAddress && this.metadata.device(iface, deviceAddress);
        const rooms = this.channelRooms[channel];
        const functions = this.channelFunctions[channel];
        return {
            device: deviceAddress,
            deviceName: deviceAddress ? this.channelNames[deviceAddress] : undefined,
            deviceType: device && device.TYPE,
            channel,
            channelName: this.channelNames[channel],
            channelType: ch && ch.TYPE,
            channelIndex: channel.includes(':') ? Number.parseInt(channel.split(':')[1], 10) : undefined,
            rooms,
            room: rooms && rooms.length === 1 ? rooms[0] : undefined,
            functions,
            function: functions && functions.length === 1 ? functions[0] : undefined,
        };
    }

    /**
     * Merges a variable from getVariables(); returns the message when it is new or changed
     * (node-red-contrib-ccu's updateRegaVariable), else null.
     */
    updateVariable(sysvar) {
        const ts = sysvar.ts || this.now();
        let current = this.sysvars[sysvar.name];
        const isNew = !current;
        if (isNew) {
            current = {
                topic: '',
                payload: sysvar.val,
                ccu: this.host,
                iface: 'ReGaHSS',
                type: 'SYSVAR',
                name: sysvar.name,
                info: sysvar.info,
                value: sysvar.val,
                valueType: sysvar.type,
                valueEnum: sysvar.enum[Number(sysvar.val)],
                unit: sysvar.unit,
                enum: sysvar.enum,
                id: sysvar.id,
                cache: true,
                ...(sysvar.channel ? this.channelFields(sysvar.channel) : {}),
            };
            this.sysvars[sysvar.name] = current;
        }
        if (!isNew && current.ts === ts) {
            return null;
        }
        const changed = !isNew && current.value !== sysvar.val;
        Object.assign(current, {
            payload: sysvar.val,
            info: sysvar.info,
            value: sysvar.val,
            valueEnum: current.enum[Number(sysvar.val)],
            valuePrevious: isNew ? undefined : current.value,
            valueEnumPrevious: isNew ? undefined : current.valueEnum,
            ts,
            tsPrevious: isNew ? undefined : current.ts,
            lc: isNew ? ts : changed ? ts : current.lc,
            lcPrevious: isNew ? undefined : current.lc,
            change: changed,
            cache: isNew,
        });
        return {...current};
    }

    updateProgram(prg) {
        const ts = prg.ts || 0;
        const current = this.programs[prg.name];
        if (current && current.active === prg.active && current.ts === ts) {
            return null;
        }
        const message = {
            id: prg.id,
            ccu: this.host,
            iface: 'ReGaHSS',
            type: 'PROGRAM',
            name: prg.name,
            payload: prg.active,
            value: prg.active,
            active: prg.active,
            activePrevious: current ? current.active : undefined,
            ts,
            tsPrevious: current ? current.ts : undefined,
        };
        this.programs[prg.name] = message;
        return {...message};
    }

    /** Polls variables and programs; emits 'sysvar' / 'program' for new or changed ones. */
    async poll() {
        if (this.pollPending) {
            this.log.debug('rega poll already pending');
            return;
        }
        this.pollPending = true;
        try {
            const variables = await this.rega.getVariables();
            for (const sysvar of variables) {
                const message = this.updateVariable(sysvar);
                if (message) {
                    this.emit('sysvar', message);
                }
            }
            const programs = await this.rega.getPrograms();
            for (const prg of programs) {
                const message = this.updateProgram(prg);
                if (message) {
                    this.emit('program', message);
                }
            }
            if (!this.ready) {
                this.ready = true;
                this.log.info('rega:', variables.length, 'variables,', programs.length, 'programs');
            }
            this.emit('polled');
        } finally {
            this.pollPending = false;
        }
    }

    startPolling(intervalSeconds, {setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
        this.pollInterval = intervalSeconds;
        this._setTimer = setTimer;
        this._clearTimer = clearTimer;
        const loop = async () => {
            try {
                await this.poll();
            } catch (err) {
                this.log.warn('rega poll failed:', err.message);
                this.emit('error', err);
            }
            if (this.pollInterval > 0) {
                this.pollTimer = setTimer(loop, this.pollInterval * 1000);
            }
        };
        return loop();
    }

    stopPolling() {
        if (this.pollTimer && this._clearTimer) {
            this._clearTimer(this.pollTimer);
        }
        this.pollTimer = null;
        this.pollInterval = 0;
    }

    /*
     * set
     */

    async setVariable(name, value) {
        const sysvar = this.sysvars[name];
        if (!sysvar) {
            throw new Error(`variable ${name} unknown`);
        }
        const cast = castVariable(value, {type: sysvar.valueType, enum: sysvar.enum});
        this.log.debug('rega > setVariable', name, cast);
        await this.rega.setVariable(sysvar.id, cast);
        await this.poll().catch((err) => this.log.warn('rega poll failed:', err.message));
    }

    async programActive(name, active) {
        const program = this.programs[name];
        if (!program) {
            throw new Error(`program ${name} unknown`);
        }
        this.log.debug('rega > programActive', name, active);
        await this.rega.setProgram(program.id, active);
        await this.poll().catch((err) => this.log.warn('rega poll failed:', err.message));
    }

    async programExecute(name) {
        const program = this.programs[name];
        if (!program) {
            throw new Error(`program ${name} unknown`);
        }
        this.log.debug('rega > programExecute', name);
        await this.rega.startProgram(program.id);
        await this.poll().catch((err) => this.log.warn('rega poll failed:', err.message));
    }
}
