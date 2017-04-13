#!/usr/bin/env node

const fs = require('fs');
const pjson = require('persist-json')('hm2mqtt');
const async = require('async');
const log = require('yalm');
const request = require('request');
const Mqtt = require('mqtt');
const xmlrpc = require('homematic-xmlrpc');
const binrpc = require('binrpc');
const discover = require('./discover.js');
const pkg = require('./package.json');
const config = require('./config.js');

log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');

const rpcClient = {};
const rpcServer = {};
const values = {};
const changes = {};
let names = {};
const addresses = {};
function reverseNames() {
    Object.keys(names).forEach(address => {
        addresses[names[address]] = address;
    });
}

const devices = {};
log.debug('loading', 'paramsetDescriptions_' + fileName());
const paramsetDescriptions = pjson.load('paramsetDescriptions_' + fileName()) || {};
const getParamsetTimeout = {};
const paramsetQueue = {};
const lastEvent = {};

let mqttConnected;

log.info('mqtt trying to connect', config.mqttUrl);

const mqtt = Mqtt.connect(config.mqttUrl, {
    clientId: config.name + '_' + Math.random().toString(16).substr(2, 8),
    will: {topic: config.name + '/connected', payload: '0', retain: true},
    username: config.mqttUser,
    password: config.mqttPassword
});

mqtt.on('connect', () => {
    mqttConnected = true;

    log.info('mqtt connected', config.mqttUrl);
    mqtt.publish(config.name + '/connected', '1', {retain: true});

    log.info('mqtt subscribe', config.name + '/set/#');
    mqtt.subscribe(config.name + '/set/#');
});

mqtt.on('close', () => {
    if (mqttConnected) {
        mqttConnected = false;
        log.info('mqtt closed ' + config.mqttUrl);
    }
});

mqtt.on('error', err => {
    log.error('mqtt', err);
});

mqtt.on('message', (topic, payload) => {
    payload = payload.toString();
    log.debug('mqtt <', topic, payload);
    const parts = topic.split('/');
    if (parts.length === 4 && parts[1] === 'set') {
        rpcSet(parts[2], parts[3], String(payload));
    }
});

function rpcSet(name, datapoint, payload) {
    const address = addresses[name] || name;
    let iface;
    Object.keys(devices).forEach(i => {
        if (devices[i][address]) {
            iface = i;
        }
    });
    if (!iface) {
        log.error('unknown device', address);
        return;
    }
    const psName = paramsetName(devices[iface][address]);
    let ps = paramsetDescriptions[psName];
    ps = ps && ps.VALUES && ps.VALUES[datapoint];
    if (!ps) {
        log.error('unknown paramset', paramsetName(devices[iface][address]) + '.VALUES.' + datapoint);
        return;
    }
    let val;
    if (payload.indexOf('{') === 0) {
        try {
            val = JSON.parse(payload).val;
        } catch (err) {
            val = payload;
        }
    } else {
        val = payload;
    }

    switch (ps.TYPE) {
        case 'BOOL':
            // eslint-disable-line no-fallthrough
        case 'ACTION':
            // OMG this is so ugly...
            if (val === 'false') {
                val = false;
            } else if (!isNaN(val)) {
                val = Number(val);
            }
            val = Boolean(val);
            break;
        case 'FLOAT':
            val = parseFloat(val);
            if (val < ps.MIN) {
                val = ps.MIN;
            } else if (val > ps.MAX) {
                val = ps.MAX;
            }
            val = {explicitDouble: val};
            break;
        case 'ENUM':
            if (typeof val === 'string') {
                if (ps.ENUM && (ps.ENUM.indexOf(val) !== -1)) {
                    val = ps.ENUM.indexOf(val);
                }
            }
            // eslint-disable-line no-fallthrough
        case 'INTEGER':
            val = parseInt(val, 10);
            if (val < ps.MIN) {
                val = ps.MIN;
            } else if (val > ps.MAX) {
                val = ps.MAX;
            }
            break;
        case 'STRING':
            val = String(val);
            break;
        default:

    }
    log.debug('rpc', iface, '> setValue', [address, datapoint, val]);
    rpcClient[iface].methodCall('setValue', [address, datapoint, val], err => {
        if (err) {
            log.error(err);
        }
    });
}

if (config.jsonNameTable) {
    log.info('loading name table', config.jsonNameTable);
    names = require(config.jsonNameTable);
    reverseNames();
} else if (!config.disableRega) {
    log.info('loading', 'names_' + fileName());
    names = pjson.load('names_' + fileName()) || {};
    const url = 'http://' + config.ccuAddress + ':8181/rega.exe';
    const body = fs.readFileSync('./devices.fn');
    log.info('requesting names from', url);
    request({
        method: 'POST',
        url,
        body,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': body.length
        }
    }, (err, res, body) => {
        if (!err && body) {
            const end = body.indexOf('<xml>');
            const data = body.substr(0, end);
            try {
                names = JSON.parse(unescape(data));
                reverseNames();
                log.info('saving', 'names_' + fileName());
                pjson.save('names_' + fileName(), names);
            } catch (err) {
                log.error(err);
            }
        } else {
            log.error(err);
        }
    });
}

log.debug('discover interfaces');
discover(config.ccuAddress, {
    // Todo... cuxd: {port: 8701, protocol: 'binrpc'},
    rfd: {port: 2001, protocol: 'binrpc'},
    hs485d: {port: 2000, protocol: 'binrpc'},
    hmip: {port: 2010, protocol: 'xmlrpc'}
}, interfaces => {
    Object.keys(interfaces).forEach(iface => {
        createIface(iface, interfaces[iface].protocol, interfaces[iface].port);
        if (iface === 'hmip' && config.hmipReconnectInterval) {
            setInterval(() => {
                checkInit(iface, interfaces[iface].protocol);
            }, config.hmipReconnectInterval * 1000);
        } else if (iface === 'cuxd') {
            // TODO
        } else if (config.pingInterval) {
            setInterval(() => {
                checkInit(iface, interfaces[iface].protocol);
            }, config.pingInterval * 1000);
        }
    });
});

function fileName(name) {
    return config.ccuAddress + (name ? '_' + name : '');
}

function checkInit(iface, protocol) {
    const now = (new Date()).getTime();
    const elapsed = Math.ceil((now - (lastEvent[iface] || 0)) / 1000);
    log.debug(iface, 'elapsed since lastevent:', elapsed + 's');
    if (iface === 'hmip' && config.hmipReconnectInterval) {
        if (elapsed >= config.hmipReconnectInterval) {
            initIface(iface, protocol);
        }
    } else if (iface === 'cuxd') {
        // TODO cuxd reconnect? ping possible?
    } else if (elapsed >= (config.pingInterval * 2)) {
        initIface(iface, protocol);
    } else if (elapsed >= config.pingInterval) {
        log.debug('rpc', iface, '> ping');
        rpcClient[iface].methodCall('ping', ['hm2mqtt'], err => {
            if (err) {
                log.error(err);
            }
        });
    }
}

function createIface(name, protocol, port) {
    log.debug('loading', 'devices_' + fileName(name));
    devices[name] = pjson.load('devices_' + fileName(name));
    log.debug('createIface', name, protocol, port);
    if (!rpcServer[protocol]) {
        rpcServer[protocol] = createServer(protocol);
    }
    rpcClient[name] = createClient(protocol, port);
    if (protocol === 'binrpc') {
        rpcClient[name].on('connect', () => {
            initIface(name, protocol, port);
        });
    } else {
        initIface(name, protocol, port);
    }
}

const stopIface = {};
function stop() {
    const cmdQueue = [];
    Object.keys(stopIface).forEach(iface => {
        cmdQueue.push(stopIface[iface]);
    });
    async.parallel(cmdQueue, () => {
        process.exit(0);
    });
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function initIface(name, protocol) {
    let url;
    if (protocol === 'binrpc') {
        url = 'xmlrpc_bin://' + config.listenAddress + ':' + config.binrpcListenPort;
    } else {
        url = 'http://' + config.listenAddress + ':' + config.listenPort;
    }
    const params = [url, 'hm2mqtt_' + name];
    log.debug('rpc', name, '> init', params);
    lastEvent[name] = (new Date()).getTime();
    rpcClient[name].methodCall('init', params, (err, res) => {
        log.debug('rpc', name, '< init', err, JSON.stringify(res));
        stopIface[name] = cb => {
            const stopParams = [url, ''];
            log.info('rpc', name, '> init', stopParams);
            rpcClient[name].methodCall('init', stopParams, (err, res) => {
                log.debug('rpc', name, '< init', err, JSON.stringify(res));
                cb();
            });
        };
    });
}

function createClient(protocol, port) {
    let client;
    const options = {
        host: config.ccuAddress,
        port,
        path: '/'
    };
    if (protocol === 'binrpc') {
        client = binrpc.createClient(options);
    } else {
        client = xmlrpc.createClient(options);
    }
    return client;
}

function paramsetName(dev) {
    return dev.PARENT_TYPE + '/' + dev.VERSION + '/' + dev.TYPE;
}

function createParamsetQueue(name) {
    name = ifaceName(name);
    log.info(name, 'got', Object.keys(devices[name]).length, 'devices and channels');

    log.debug('createParamsetQueue', name);
    if (!paramsetQueue[name]) {
        paramsetQueue[name] = [];
    }

    Object.keys(devices[name]).forEach(address => {
        const dev = devices[name][address];
        if (!dev.PARENT_TYPE) {
            return;
        }
        if (!paramsetDescriptions[paramsetName(dev)]) {
            log.debug('unknown', paramsetName(dev), dev.PARAMSETS);
            paramsetDescriptions[paramsetName(dev)] = {};
            dev.PARAMSETS.forEach(ps => {
                paramsetQueue[name].push({ADDRESS: dev.ADDRESS, PARAMSET: ps, name: paramsetName(dev)});
            });
        }
    });
    getParamset(name);
}

function getParamset(name) {
    if (paramsetQueue[name].length > 0) {
        const obj = paramsetQueue[name].shift();
        log.debug('rpc', name, '> getParamsetDescription', [obj.ADDRESS, obj.PARAMSET], obj.name);
        rpcClient[name].methodCall('getParamsetDescription', [obj.ADDRESS, obj.PARAMSET], (err, res) => {
            if (!err) {
                paramsetDescriptions[obj.name][obj.PARAMSET] = res;
            }
            setTimeout(() => {
                getParamset(name);
            }, 500);
        });
    } else {
        log.debug('getParamsetDescriptions', name, 'done');
        log.info('got', Object.keys(paramsetDescriptions).length, 'paramsetDescriptions');
        log.debug('saving', 'paramsetDescriptions_' + fileName());
        pjson.save('paramsetDescriptions_' + fileName(), paramsetDescriptions);
    }
}

function ifaceName(id) {
    return id.replace(/^hm2mqtt_/, '');
}

const rpcMethods = {
    notFound: method => {
        log.debug('rpc < Method ' + method + ' does not exist');
    },
    'system.multicall': (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        const res = [];
        params[0].forEach(c => {
            if (rpcMethods[c.methodName]) {
                rpcMethods[c.methodName](err, c.params);
            } else {
                rpcMethods.notFound(c.methodName, c.params);
            }
            res.push('');
        });
        callback(null, res);
    },
    'system.listMethods': (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        log.debug('rpc < system.listMethods', params);
        callback(null, Object.keys(rpcMethods));
    },
    event: (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        log.debug('rpc < event', JSON.stringify(params));

        const ts = (new Date()).getTime();
        lastEvent[ifaceName(params[0])] = ts;

        if (params[1] === 'CENTRAL' && params[2] === 'PONG') {
            callback(null, '');
            return;
        }

        const key = params[1] + '/' + params[2];
        if (values[key] !== params[3]) {
            changes[key] = ts;
            values[key] = params[3];
        }

        const dev = devices[ifaceName(params[0])] && devices[ifaceName(params[0])][params[1]];
        if (!dev) {
            log.error('unknown device', params[0], params[1]);
            return;
        }
        let ps = paramsetDescriptions[paramsetName(dev)];
        ps = (ps && ps.VALUES && ps.VALUES[params[2]]);
        if (!ps) {
            log.error('unknown paramsetDescription', paramsetName(dev));
            ps = {};
        }

        const topic = config.name + '/status/' + (names[params[1]] || params[1]) + '/' + params[2];

        let payload = {val: params[3], ts, lc: changes[key], hm: {ADDRESS: params[1]}};
        if (ps.UNIT) {
            payload.hm.UNIT = ps.UNIT;
        }
        if (ps.TYPE === 'ENUM') {
            payload.hm.ENUM = ps.VALUE_LIST[params[3]];
        }
        payload = JSON.stringify(payload);

        const retain = ps.TYPE !== 'ACTION';

        log.debug('mqtt >', topic, payload, 'retain:', retain);
        mqtt.publish(topic, payload, {retain});

        if (typeof callback === 'function') {
            callback(null, '');
        }
    },
    listDevices: (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        log.debug('rpc < listDevices', params);
        const name = ifaceName(params[0]);
        const ret = [];
        if (devices[name]) {
            Object.keys(devices[name]).forEach(address => {
                ret.push({
                    ADDRESS: address,
                    VERSION: devices[name][address].VERSION
                });
            });
        }
        log.debug('>', ret.length);
        callback(null, ret);
        getParamsetTimeout[params[0]] = setTimeout(() => {
            createParamsetQueue(params[0]);
        }, 5000);
    },
    deleteDevices: (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        clearTimeout(getParamsetTimeout[params[0]]);
        log.debug('rpc < deleteDevices', params[1].length);
        const name = ifaceName(params[0]);
        params[1].forEach(dev => {
            delete devices[name][dev];
        });
        log.debug('saving', 'devices_' + fileName(name), '(' + Object.keys(devices[name]).length + ')');
        pjson.save('devices_' + fileName(name), devices[name]);
        callback(null, '');
        getParamsetTimeout[params[0]] = setTimeout(() => {
            createParamsetQueue(params[0]);
        }, 5000);
    },
    newDevices: (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        clearTimeout(getParamsetTimeout[params[0]]);
        log.debug('rpc < newDevices', params[1].length);
        const name = ifaceName(params[0]);
        const devs = devices[name] || {};
        params[1].forEach(dev => {
            devs[dev.ADDRESS] = dev;
        });
        log.debug('saving', 'devices_' + fileName(name), '(' + Object.keys(devices[name]).length + ')');
        devices[name] = devs;
        pjson.save('devices_' + fileName(name), devs);
        callback(null, '');
        getParamsetTimeout[params[0]] = setTimeout(() => {
            createParamsetQueue(params[0]);
        }, 5000);
    }
};

rpcMethods.NotFound = rpcMethods.notFound;

function createServer(protocol) {
    let server;
    if (protocol === 'binrpc') {
        server = binrpc.createServer({host: config.listenAddress, port: config.binrpcListenPort});
    } else {
        server = xmlrpc.createServer({host: config.listenAddress, port: config.listenPort});
    }
    Object.keys(rpcMethods).forEach(method => {
        server.on(method, rpcMethods[method]);
    });
    return server;
}
