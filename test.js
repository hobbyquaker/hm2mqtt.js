#!/usr/bin/env node

const cp = require('child_process');
const path = require('path');
const StreamSplitter = require("stream-splitter");

const cmd = path.join(__dirname, '/index.js');
const args = ['-m mqtt://127.0.0.1:1883', '--ccu-address', '127.0.0.1', '-v', 'debug'];

const hm2mqtt = cp.spawn(cmd, args);

let stdout = hm2mqtt.stdout.pipe(StreamSplitter('\n'));
let stderr = hm2mqtt.stderr.pipe(StreamSplitter('\n'));

stderr.on('token', (data) => {
    data = data.toString();
    console.log(data);
});

stdout.on('token', (data) => {
    data = data.toString();
    console.log(data);

    if (data.toString().match(/mqtt connected/)) {
        console.log('\n\nTest passed. Successful mqtt connection.');
        process.exit(0);
    }
});

hm2mqtt.on('close', code => {
    console.log(`child process exited with code ${code}`);
});

setTimeout(() => {
    hm2mqtt.kill();
    process.exit(1);
}, 30000);
