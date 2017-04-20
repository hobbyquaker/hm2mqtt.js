#!/usr/bin/env node

const cp = require('child_process');
const path = require('path');

const cmd = path.join(__dirname, '/index.js');
const args = ['-m mqtt://127.0.0.1:1883', '--ccu-address', '127.0.0.1', '-v', 'debug'];

const hm2mqtt = cp.spawn(cmd, args);

hm2mqtt.stdout.on('data', (data) => {
    data = data.toString().replace('\n', '');
    console.log(`stdout: ${data}`);

    if (data.toString().match(/mqtt connect/)) {
        console.log('\n\ntest passed: successful mqtt connection');
        process.exit(0);
    }
});

hm2mqtt.stderr.on('data', data => {
    data = data.toString().replace('\n', '');
    console.log(`stderr: ${data}`);
});

hm2mqtt.on('close', code => {
    console.log(`child process exited with code ${code}`);
});

setTimeout(() => {
    hm2mqtt.kill();
    process.exit(1);
}, 30000);
