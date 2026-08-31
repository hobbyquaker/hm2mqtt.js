/**
 * How each hm2mqtt option is presented in the addon UI: which group it belongs to, which widget
 * renders it and what it is called in German and English.
 *
 * The options themselves - type, default, description, enum, secret flag, env variable - come from
 * the app's own `--config-schema` output (www/config-schema.json), so this file never repeats them.
 * It only adds what a form needs on top. `test/addon-ui.test.js` fails when an option exists in the
 * schema but not here (or the other way round), which is what keeps the promise that every option
 * is configurable in the UI (H-38).
 */

export const GROUPS = [
    {id: 'ccu', de: 'Verbindung zur CCU', en: 'CCU connection', open: true},
    {id: 'mqtt', de: 'MQTT', en: 'MQTT', open: true},
    {id: 'names', de: 'Namen & Topics', en: 'Names & topics'},
    {id: 'ha', de: 'Home Assistant', en: 'Home Assistant'},
    {id: 'filter', de: 'Filter', en: 'Filter'},
    {id: 'advanced', de: 'Erweitert', en: 'Advanced'},
];

/**
 * Options that exist in the CLI but not in this UI, with the reason. Kept explicit so the
 * coverage test can tell "deliberately hidden" from "forgotten".
 */
export const NOT_APPLICABLE = {
    // the service script pins this to the addon's own var/ directory: on a CCU everything else is
    // either read-only or outside the addon, and an addon writing there is a bug
    'state-dir': 'the addon writes inside /usr/local/addons/hm2mqtt only',
    // running on the CCU, the interface processes call back over loopback and local mode already
    // binds there - there is nothing for a user to decide
    'listen-address': 'always loopback on the CCU',
    'init-address': 'always loopback on the CCU',
};

export const OPTIONS = {
    // --- CCU ---------------------------------------------------------------------------------
    'ccu-address': {group: 'ccu', widget: 'ccu-address', de: 'CCU-Adresse', en: 'CCU address'},
    interfaces: {group: 'ccu', widget: 'interfaces', de: 'Schnittstellen', en: 'Interfaces'},
    local: {
        group: 'ccu',
        widget: 'tristate',
        de: 'Direkt mit den CCU-Prozessen sprechen',
        en: 'Talk to the CCU processes directly',
    },
    'ccu-username': {
        group: 'ccu',
        de: 'Benutzer (nur bei aktivierter Anmeldung)',
        en: 'User (only with authentication)',
    },
    'ccu-password': {group: 'ccu', de: 'Passwort', en: 'Password'},
    'ccu-tls': {group: 'ccu', de: 'TLS-Ports verwenden', en: 'Use the TLS ports'},
    'ccu-insecure': {
        group: 'ccu',
        de: 'Selbstsigniertes Zertifikat akzeptieren',
        en: 'Accept a self-signed certificate',
    },
    'bidcos-binrpc': {group: 'ccu', de: 'BidCos über BIN-RPC', en: 'BidCos over BIN-RPC'},

    // --- MQTT --------------------------------------------------------------------------------
    'mqtt-url': {group: 'mqtt', widget: 'mqtt-url', de: 'Broker-URL', en: 'Broker URL'},
    'mqtt-username': {group: 'mqtt', de: 'Benutzer', en: 'User'},
    'mqtt-password': {group: 'mqtt', de: 'Passwort', en: 'Password'},
    name: {group: 'mqtt', de: 'Instanzname (erste Topic-Ebene)', en: 'Instance name (first topic level)'},
    payload: {group: 'mqtt', de: 'Payload-Format', en: 'Payload format'},
    'json-payloads': {group: 'mqtt', de: 'JSON-Payloads', en: 'JSON payloads'},
    'hm-payload': {group: 'mqtt', de: 'hm-Block im Payload', en: 'hm block in the payload'},
    'plain-tree': {group: 'mqtt', de: 'Zusätzlicher einfacher Themenbaum', en: 'Additional plain topic tree'},
    'mqtt-client-id-prefix': {group: 'mqtt', de: 'Client-ID-Präfix', en: 'Client id prefix'},
    'mqtt-tls-ca': {group: 'mqtt', de: 'CA-Zertifikat (Datei)', en: 'CA certificate (file)'},

    // --- names and topics --------------------------------------------------------------------
    rega: {
        group: 'names',
        de: 'Namen, Räume, Gewerke und Variablen aus der ReGa',
        en: 'Names, rooms, functions and variables from ReGa',
    },
    'rega-names-interval': {group: 'names', de: 'Namen neu einlesen (Sekunden)', en: 'Re-read names (seconds)'},
    'rega-poll-interval': {group: 'names', de: 'Variablen abfragen (Sekunden)', en: 'Poll variables (seconds)'},
    'rega-poll-trigger': {
        group: 'names',
        de: 'Datenpunkt, der eine Abfrage auslöst',
        en: 'Datapoint that triggers a poll',
    },
    'ccu-timezone': {group: 'names', de: 'Zeitzone der CCU', en: 'Time zone of the CCU'},
    'name-file': {group: 'names', de: 'Namensdatei', en: 'Name file'},
    'item-template': {
        group: 'names',
        widget: 'template',
        de: 'Item-Vorlage für Datenpunkte',
        en: 'Item template for datapoints',
    },
    'sysvar-item-template': {
        group: 'names',
        de: 'Item-Vorlage für Systemvariablen',
        en: 'Item template for system variables',
    },
    'program-item-template': {group: 'names', de: 'Item-Vorlage für Programme', en: 'Item template for programs'},

    // --- Home Assistant ----------------------------------------------------------------------
    'ha-discovery': {group: 'ha', de: 'Discovery veröffentlichen', en: 'Publish discovery'},
    'ha-prefix': {group: 'ha', de: 'Discovery-Präfix', en: 'Discovery prefix'},
    'ha-generic': {
        group: 'ha',
        de: 'Generische Entitäten für alle Datenpunkte',
        en: 'Generic entities for every datapoint',
    },

    // --- filter ------------------------------------------------------------------------------
    ignore: {group: 'filter', widget: 'globs', de: 'Datenpunkte ignorieren', en: 'Ignore datapoints'},
    maintenance: {group: 'filter', de: 'Wartungskanäle veröffentlichen', en: 'Publish maintenance channels'},
    'publish-cache': {
        group: 'filter',
        de: 'Zwischengespeicherte Werte beim Start senden',
        en: 'Publish cached values at start',
    },
    'publish-counters': {group: 'filter', de: 'Zähler veröffentlichen', en: 'Publish counters'},
    'rpc-topics': {group: 'filter', de: 'RPC-Topics veröffentlichen', en: 'Publish RPC topics'},

    // --- advanced ----------------------------------------------------------------------------
    'xmlrpc-port': {group: 'advanced', de: 'XML-RPC-Port', en: 'XML-RPC port'},
    'binrpc-port': {group: 'advanced', de: 'BIN-RPC-Port', en: 'BIN-RPC port'},
    'ping-timeout': {group: 'advanced', de: 'Ping-Timeout (Sekunden)', en: 'Ping timeout (seconds)'},
    'duty-cycle-interval': {group: 'advanced', de: 'Duty-Cycle-Abfrage (Sekunden)', en: 'Duty cycle poll (seconds)'},
    'stats-interval': {group: 'advanced', de: 'Statistik-Intervall (Sekunden)', en: 'Statistics interval (seconds)'},
    verbosity: {group: 'advanced', de: 'Log-Level', en: 'Log level'},
};

/**
 * The widget for an option: an explicit one from the table above, otherwise derived from the
 * schema (secret, enum, boolean, number, text).
 * @param {string} key
 * @param {object} schema the option's entry from config-schema.json
 * @returns {string}
 */
export function widgetFor(key, schema) {
    const explicit = OPTIONS[key] && OPTIONS[key].widget;
    if (explicit) return explicit;
    if (schema['x-secret']) return 'password';
    if (Array.isArray(schema.enum)) return 'select';
    if (schema.type === 'boolean') return 'switch';
    if (schema.type === 'number') return 'number';
    return 'text';
}
