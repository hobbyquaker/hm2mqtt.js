# Changelog

## 3.1.0

### Changed

- `--payload plain|mqsh-basic|mqsh-extended` (default `mqsh-extended`) selects the status payload
  format like the `ccu-mqtt` node's payload option; `plain` publishes booleans as `0`/`1`.
  `--no-hm-payload` still works as an alias of `--payload mqsh-basic` but is hidden and deprecated.
  `<name>/info` reports the format as `payload`.

## 3.0.0

Rewrite on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) as a
drop-in replacement for the `ccu-mqtt` node of
[node-red-contrib-ccu](https://github.com/rdmtc/node-red-contrib-ccu): same topics, same
payloads (`{val, ts, lc, hm}` with node-red-contrib-ccu's message as the `hm` block). The plan,
decisions and verification log are in ROADMAP.md; the README has the migration tables (Node-RED
flow → 3.0, 2.x → 3.0).

### Breaking

- ES module, Node.js ≥ 20.19; dependencies replaced (homematic-rega 2, homematic-xmlrpc 2,
  binrpc 3, mqtt-interfaces-core 0.7). `yalm`, `request`, `persist-json` are gone.
- Topics follow the Node-RED flow, not 2.x: `set/<variable|program>` instead of `rega/…`,
  `paramset/<channel>/<paramset>/<param>` instead of `param/…`, CCU interface names
  (`BidCos-RF`, `HmIP-RF`, `BidCos-Wired`, `VirtualDevices`, `CUxD`) instead of `rfd`/`hmip`/
  `hs485d`, `set/rega/sync` instead of `command/regasync`, `rpc/<interface>/<method>/<callid>`
  opt-in via `--rpc-topics`. `db/extend/…` (`--publish-metadata`) is dropped.
- Payloads are `{val, ts, lc, hm}`; `hm` carries every field of node-red-contrib-ccu's message
  (`channel`, `channelName`, `device`, `deviceType`, `channelType`, `datapointType`, `valueEnum`,
  `rooms`, `working`, `direction`, `stable`, …) plus `datapointUnit` and `datapointEnum`.
  `--no-hm-payload` leaves `{val, ts, lc}`, `--no-json-payloads` the bare value.
- `<name>/connected` is `2` only while every enabled interface is subscribed and the ReGa
  answers, `1` otherwise.
- `PRESS_*` and every other `ACTION` datapoint are published without retain.
- Options: `--ccu-address/-a` stays; everything else is new (`--interfaces`, `--ccu-tls`,
  `--ccu-username/--ccu-password`, `--listen-address`, `--init-address`, `--xmlrpc-port` 2126,
  `--binrpc-port` 2127, `--rega`, `--rega-poll-interval`, `--rega-poll-trigger`,
  `--rega-names-interval`, `--name-file`, `--item-template`, `--plain-tree`, `--publish-cache`,
  `--publish-counters`, `--duty-cycle-interval`, `--rpc-topics`, `--state-dir`) plus the shared
  options of the core (`--mqtt-url/-u`, `--name/-n`, `--verbosity/-v`, `--install`, …). Every
  option is also an environment variable `HM2MQTT_<OPTION>`.

### Added

- Interfaces BidCos-RF, BidCos-Wired, HmIP-RF, VirtualDevices (groups) and CUxD via XML-RPC or
  binrpc, with init subscription, ping/re-init supervision and a 30 s call timeout; an interface
  that fails `init` warns once and retries every 30 s. `--interfaces auto` probes the ports.
- Per-interface `status/interface/<iface>/connected`, rpc counters `status/counter/<iface>/rx|tx`,
  duty cycle (`DUTY_CYCLE`, `CARRIER_SENSE_LEVEL`, `CONNECTED`) of every RF adapter via
  `listBidcosInterfaces`.
- ReGa: names, rooms and functions (cached, re-read every hour and on `set/rega/sync`), variables
  and programs published at start and on change (poll every 30 s, or on a virtual button with
  `--rega-poll-trigger`), typed `set` with `ENUM` names.
- Paramset descriptions seeded from node-red-contrib-ccu's collection (2222 keys); missing
  `VALUES` descriptions fetched at 50 ms spacing, `MASTER` on demand, `LINK`/`SERVICE` never.
- `LEVEL_NOTWORKING` / `STATE_NOTWORKING` companions and the actuator wait-for-`WORKING` rule of
  node-red-contrib-ccu; last values persisted (`values.json`) for `valuePrevious`/`lc` across
  restarts.
- Item templates: `--item-template` (default `${channelName|channel}/${datapoint}`),
  `--sysvar-item-template`, `--program-item-template` with every `hm` field as placeholder and
  `|` fallbacks; `set` resolved through a reverse index (address form always accepted).
- `--plain-tree <level>`: the plain-payload mirror tree of the second `ccu-mqtt` node
  (booleans as `0`/`1`), `--publish-cache`: every datapoint value from the ReGa at start,
  `--name-file`: JSON overrides of ReGa names, `--rpc-topics`: arbitrary rpc calls with the
  answer on `response/<callid>`.
- `<name>/info`, `maintenance/set/loglevel` and `maintenance/set/restart`, `--config-schema`,
  systemd template unit `hm2mqtt@<name>` via `--install`/`--uninstall`, Dockerfile, `deploy.sh`.
- `scripts/compare-trees.js` (diff of two status trees for a parallel run) and
  `scripts/clean-retained.js` (list/clear retained topics for the cutover).
- Tests: 44 unit tests (fakes for the RPC libraries, timers, ReGa) and an end-to-end suite with
  hm-simulator and mosquitto (`npm run test:e2e`, also in CI).

### Fixed (compared with node-red-contrib-ccu 3.4)

- `paramset` values are cast by their own description and rejected when not writeable (the node
  compared `!(OPERATIONS) && 2` and cast with the wrong description).
- `datapointEnum`/`valueEnum` are filled from `VALUE_LIST` (the node read `ENUM`, which the
  interface processes never send).
- Events of channels without a ReGa name go to `<address>/<DATAPOINT>` instead of `//<DATAPOINT>`.
- The `rpc` topic works (the node configured it but had no handler).
