const pkg = require('./package.json');

module.exports = require('yargs')
    .env('HM2MQTT')
    .usage(pkg.name + ' ' + pkg.version + '\n' + pkg.description + '\n\nUsage: $0 [options]')
    .describe('verbosity', 'possible values: "error", "warn", "info", "debug"')
    .describe('name', 'instance name. used as mqtt client id and as prefix for connected topic')
    .describe('mqtt-url', 'mqtt broker url. See https://github.com/mqttjs/MQTT.js#connect-using-a-url')
    .describe('ping-interval', 'Send a Ping if no event occured in the last interval. Re-Init on next interval')
    .describe('disable-rega', 'Don\'t sync names from ReGa')
    .describe('json-name-table', 'A JSON file that maps device and channel addresses to names')
    .describe('duty-cycle-poll-interval', 'Interval in seconds to poll duty cycle from rf interfaces. Set to `0` to disable')
    .describe('rega-poll-interval', 'Interval in seconds to poll variables from Rega. Set to 0 to disable polling')
    .describe('rega-poll-trigger', 'A virtual button that triggers a variable poll. Example: BidCoS-RF:50.PRESS_SHORT')
    .describe('listen-address', 'Address the RPC servers bind to')
    .describe('init-address', 'Address used in the RPC init. Normally there is no need to set this')
    .describe('help', 'show help')
    .describe('publish-metadata', '')
    .describe('mqtt-retain', 'enable/disable retain flag for mqtt messages')
    .describe('insecure', 'allow tls connections with invalid certificates')
    .boolean('insecure')
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
        q: 'hmip-reconnect-interval',
        r: 'listen-address',
        s: 'init-address',
        v: 'verbosity'
    })
    .boolean('mqtt-retain')
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
        'duty-cycle-poll-interval': 180,
        'rega-poll-interval': 0,
        'rega-poll-trigger': '',
        'publish-metadata': false,
        'mqtt-retain': true
    })
    .demandOption([
        'ccu-address'
    ])
    .version()
    .help('help')
    .argv;
