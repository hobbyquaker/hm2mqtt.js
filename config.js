const pkg = require('./package.json');

module.exports = require('yargs')
    .usage(pkg.name + ' ' + pkg.version + '\n' + pkg.description + '\n\nUsage: $0 [options]')
    .describe('verbosity', 'possible values: "error", "warn", "info", "debug"')
    .describe('name', 'instance name. used as mqtt client id and as prefix for connected topic')
    .describe('mqtt-url', 'mqtt broker url. See https://github.com/mqttjs/MQTT.js#connect-using-a-url')
    .describe('mqtt-username', 'mqtt broker username')
    .describe('mqtt-password', 'mqtt broker password')
    .describe('help', 'show help')
    .alias({
        a: 'ccu-address',
        b: 'binrpc-listen-port',
        d: 'disable-rega',
        h: 'help',
        i: 'ping-interval',
        j: 'json-name-table',
        l: 'listen-port',
        m: 'mqtt-url',
        n: 'name',
        p: 'mqtt-password',
        q: 'hmip-reconnect-interval',
        r: 'listen-address',
        u: 'mqtt-username',
        v: 'verbosity'
    })
    .default({
        'disable-rega': false,
        'mqtt-url': 'mqtt://127.0.0.1',
        name: 'hm',
        verbosity: 'info',
        'listen-address': require('./firstip.js'),
        'listen-port': 2126,
        'binrpc-listen-port': 2127,
        'ping-interval': 30,
        'hmip-reconnect-interval': 600,
        'rega-poll-interval': 0,
        'rega-poll-trigger': ''
    })
    .demandOption([
        'ccu-address'
    ])
    .version()
    .help('help')
    .argv;
