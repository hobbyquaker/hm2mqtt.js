const pkg = require('./package.json');

module.exports = require('yargs')
    .usage(pkg.name + ' ' + pkg.version + '\n' + pkg.description + '\n\nUsage: $0 [options]')
    .describe('verbosity', 'possible values: "error", "warn", "info", "debug"')
    .describe('name', 'instance name. used as mqtt client id and as prefix for connected topic')
    .describe('mqtt-url', 'mqtt broker url. See https://github.com/mqttjs/MQTT.js#connect-using-a-url')
    .describe('mqtt-username', 'mqtt broker username')
    .describe('mqtt-password', 'mqtt broker password')
    .describe('ping-interval', 'Send a Ping if no event occured in the last interval. Re-Init on next interval')
    .describe('disable-rega', 'Don\'t sync names from ReGa')
    .describe('json-name-table', 'A JSON file that maps device and channel addresses to names')
    .describe('rega-poll-interval', 'Interval in seconds to poll variables from Rega. Set to 0 to disable polling')
    .describe('rega-poll-trigger', 'A virtual button that triggers a variable poll. Example: BidCoS-RF:50.PRESS_SHORT')
    .describe('listen-address', 'Address the RPC servers bind to')
    .describe('init-address', 'Address used in the RPC init. Normally there is no need to set this')
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
        s: 'init-address',
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
