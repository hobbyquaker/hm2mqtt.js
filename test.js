#!/usr/bin/env node

require('should');

const cp = require('child_process');
const request = require('request');
const path = require('path');
const streamSplitter = require('stream-splitter');
const Mqtt = require('mqtt');
mqtt = Mqtt.connect('mqtt://127.0.0.1');

const simCmd = path.join(__dirname, '/node_modules/.bin/hm-simulator');
const simArgs = [];
let sim;
let simPipeOut;
let simPipeErr;
const simSubscriptions = {};
const simBuffer = [];

const hmCmd = path.join(__dirname, '/index.js');
const hmArgs = ['--mqtt-url', 'mqtt://127.0.0.1:1883', '--ccu-address', '127.0.0.1', '-v', 'debug'];
let hm;
let hmPipeOut;
let hmPipeErr;
const hmSubscriptions = {};
const hmBuffer = [];

let subIndex = 0;

function subscribe(type, rx, cb) {
    subIndex += 1;
    if (type === 'sim') {
        simSubscriptions[subIndex] = {rx, cb};
    } else if (type === 'hm') {
        hmSubscriptions[subIndex] = {rx, cb};
    }
    matchSubscriptions(type);
    return subIndex;
}

function unsubscribe(type, subIndex) {
    if (type === 'sim') {
        delete simSubscriptions[subIndex];
    } else if (type === 'hm') {
        delete hmSubscriptions[subIndex];
    }
}

function matchSubscriptions(type, data) {
    let subs;
    let buf;
    if (type === 'sim') {
        subs = simSubscriptions;
        buf = simBuffer;
    } else if (type === 'hm') {
        subs = hmSubscriptions;
        buf = hmBuffer;
    }
    if (data) {
        buf.push(data);
    }
    buf.forEach((line, index) => {
        Object.keys(subs).forEach(key => {
            const sub = subs[key];
            if (line.match(sub.rx)) {
                sub.cb(line);
                delete subs[key];
                buf.splice(index, 1);
            }
        });
    });
}

function startHm() {
    hm = cp.spawn(hmCmd, hmArgs);
    hmPipeOut = hm.stdout.pipe(streamSplitter('\n'));
    hmPipeErr = hm.stderr.pipe(streamSplitter('\n'));
    hmPipeOut.on('token', data => {
        console.log('hm', data.toString());
        matchSubscriptions('hm', data.toString());
    });
    hmPipeErr.on('token', data => {
        console.log('hm', data.toString());
        matchSubscriptions('hm', data.toString());
    });
}

function startSim() {
    sim = cp.spawn(simCmd, simArgs);
    simPipeOut = sim.stdout.pipe(streamSplitter('\n'));
    simPipeErr = sim.stderr.pipe(streamSplitter('\n'));
    simPipeOut.on('token', data => {
        console.log('sim', data.toString());
        matchSubscriptions('sim', data.toString());
    });
    simPipeErr.on('token', data => {
        console.log('sim', data.toString());
        matchSubscriptions('sim', data.toString());
    });
}

function end(code) {
    if (hm.kill) {
        hm.kill();
    }
    if (sim.kill) {
        sim.kill();
    }
    if (typeof code !== 'undefined') {
        process.exit(code);
    }
}

process.on('SIGINT', () => {
    end(1);
});

process.on('exit', () => {
    end();
});

describe('start daemons', () => {
    it('hm-simulator should start without error', function (done)  {
        this.timeout(20000);
        subscribe('sim', /binrpc server listening/, data => {
            done();
        });
        startSim();

    });
    it('hm2mqtt should start without error', function (done) {
        this.timeout(20000);
        subscribe('hm', /hm2mqtt [0-9.]+ starting/, data => {
            done();
        });
        startHm();
    });
});

describe('hm2mqtt - mqtt connection', () => {
    it('hm2mqtt should connect to the mqtt broker', function (done) {
        this.timeout(12000);
        subscribe('hm', /mqtt connected/, data => {
            done();
        });
    });
});

describe('hm2mqtt - hm-simulator connection', () => {
    it('hm2mqtt should have rfd devices', function (done) {
        this.timeout(12000);
        subscribe('hm', /rfd got [0-9]+ devices and channels/, data => {
            done();
        });
    });
    it('hm2mqtt should have hmip devices', function (done) {
        this.timeout(12000);
        subscribe('hm', /hmip got [0-9]+ devices and channels/, data => {
            done();
        });
    });
    it('hm2mqtt should save paramsetDescriptions (1)', function (done) {
        this.timeout(180000);
        subscribe('hm', /saving paramsetDescriptions/, data => {
            done();
        });
    });
    it('hm2mqtt should save paramsetDescriptions (2)', function (done) {
        this.timeout(180000);
        subscribe('hm', /saving paramsetDescriptions/, data => {
            done();
        });
    });
});

describe('hm2mqtt - hm-simulator - mqtt', () => {
    it('hm2mqtt should receive a BidCoS-RF:1 PRESS_SHORT event', function (done) {
        this.timeout(12000);
        subscribe('hm', /rpc < event \["hm2mqtt_rfd","BidCoS-RF:1","PRESS_SHORT",true\]/, data => {
            done();
        });
    });
    it('hm2mqtt should publish a mqtt message on hm/status/BidCoS-RF:1/PRESS_SHORT', function (done) {
        this.timeout(12000);
        subscribe('hm', /mqtt > hm\/status\/BidCoS-RF:1\/PRESS_SHORT/, data => {
            done();
        });
    });
    it('hm2mqtt should publish a BidCoS-RF:2 PRESS_SHORT event', function (done) {
        this.timeout(12000);
        subscribe('hm', /mqtt > hm\/status\/BidCoS-RF:2\/PRESS_SHORT/, data => {
            done();
        });
        mqtt.publish('hm/set/BidCoS-RF:2/PRESS_SHORT', 'true');
    });
});

setTimeout(() => {
    hm2mqtt.kill();
    process.exit(1);
}, 30000);
