# hm2mqtt

[![mqtt-smarthome](https://img.shields.io/badge/mqtt-smarthome-blue.svg)](https://github.com/mqtt-smarthome/mqtt-smarthome)
[![NPM version](https://badge.fury.io/js/hm2mqtt.svg)](http://badge.fury.io/js/hm2mqtt)
[![CI](https://github.com/hobbyquaker/hm2mqtt.js/actions/workflows/ci.yml/badge.svg)](https://github.com/hobbyquaker/hm2mqtt.js/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](LICENSE)

> Interface between the Homematic CCU and MQTT

hm2mqtt connects a Homematic CCU (CCU2/CCU3/RaspberryMatic — BidCos-RF, BidCos-Wired, HmIP-RF,
virtual devices/groups, CUxD, ReGaHSS variables and programs) to an MQTT broker following the
[mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) convention. Version 3 is an
adapter on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) and a
drop-in replacement for the `ccu-mqtt` node of
[node-red-contrib-ccu](https://github.com/rdmtc/node-red-contrib-ccu): same topics, same payloads.

Contents: [Install](#install) · [Options](#options) · [Topics](#topics) · [Payloads](#payloads) ·
[Names](#names) · [Home Assistant](#home-assistant) · [Migration](#migration) · [Development](#development)

## Install

Node.js ≥ 20.19. The host must be reachable from the CCU: the interface processes call back on
`--xmlrpc-port` 2126 (and 2127 for binrpc/CUxD) — open them in the host firewall and, on a CCU
with the firewall set to _restricted_, allow the host in the CCU's firewall settings.

```
npm install -g hm2mqtt
hm2mqtt -a homematic-ccu3 -u mqtt://broker            # foreground
sudo hm2mqtt --install -n hm -a homematic-ccu3 -u mqtt://broker   # systemd service hm2mqtt@hm
```

`--install` writes the template unit `/etc/systemd/system/hm2mqtt@.service`, the instance
config `/etc/hm2mqtt/hm.env` (every option as `HM2MQTT_*`) and uses `/var/lib/hm2mqtt/hm/` as
state directory; broker credentials can live in the shared `/etc/mqtt-interfaces/broker.env`.
`--uninstall -n hm` removes the instance. `--config-schema` prints a JSON schema of all options
(management UIs like [she](https://github.com/hobbyquaker/she) build their config forms from it).

Docker: `docker run --network host -v hm2mqtt:/data -e HM2MQTT_CCU_ADDRESS=... -e HM2MQTT_MQTT_URL=... hobbyquaker/hm2mqtt`
(host networking, or publish 2126/2127 and set `HM2MQTT_INIT_ADDRESS` to the docker host).

## Options

`hm2mqtt --help` lists everything; every option is also an environment variable
`HM2MQTT_<OPTION>` (e.g. `HM2MQTT_CCU_ADDRESS`), plus the unprefixed `MQTT_URL`, `MQTT_USERNAME`,
`MQTT_PASSWORD`, `MQTT_TLS_CA` as fallback. Precedence: command line > environment > defaults.

| option                                                                                                                                       | default                                         | description                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `-a, --ccu-address`                                                                                                                          | —                                               | hostname or ip of the CCU (required)                                                                               |
| `--ccu-tls`, `--ccu-insecure`, `--ccu-username`, `--ccu-password`                                                                            | off                                             | TLS ports (42001, 42010, …, ReGa 48181) and authentication of a CCU with the firewall/auth enabled                 |
| `-i, --interfaces`                                                                                                                           | `BidCos-RF,HmIP-RF,VirtualDevices,BidCos-Wired` | interfaces to subscribe to (`CUxD` opt-in), or `auto` to probe the ports                                           |
| `--bidcos-binrpc`                                                                                                                            | off                                             | binrpc instead of xmlrpc for BidCos-RF/-Wired (CCU2, Homegear; a CCU3 proxies xmlrpc only)                         |
| `-l, --listen-address`, `--init-address`, `--xmlrpc-port`, `--binrpc-port`                                                                   | first ipv4, =listen, 2126, 2127                 | callback servers the CCU pushes events to; `--init-address` when the CCU sees another address (NAT, Docker)        |
| `--ping-timeout`                                                                                                                             | 60                                              | seconds without an event before a ping, twice that before a re-init (HmIP-RF uses 600)                             |
| `--rega` / `--no-rega`                                                                                                                       | on                                              | names, rooms, functions, variables and programs from the ReGaHSS                                                   |
| `--rega-poll-interval`, `--rega-poll-trigger`                                                                                                | 30, —                                           | variable/program poll interval (0 = off) and an optional `channel.datapoint` (virtual button) that triggers a poll |
| `--ccu-timezone`                                                                                                                             | host                                            | IANA time zone of the CCU, for the timestamps of variables and cached values                                       |
| `-m, --name-file`                                                                                                                            | —                                               | JSON `{address: name}` overriding ReGa names ([example-names.json](example-names.json))                            |
| `--hm-payload` / `--no-hm-payload`                                                                                                           | on                                              | the `hm` meta data block in status payloads ([Payloads](#payloads))                                                |
| `--plain-tree <level>`                                                                                                                       | —                                               | additionally publish plain payloads under `<name>/<level>/…` (the second `ccu-mqtt` node of the Node-RED flow)     |
| `--publish-cache`                                                                                                                            | off                                             | publish every datapoint value known to the ReGa at start (thousands of retained messages)                          |
| `--publish-counters`, `--duty-cycle-interval`                                                                                                | on, 90                                          | rpc rx/tx counters and `listBidcosInterfaces` duty cycle polling (0 = off)                                         |
| `--rpc-topics`                                                                                                                               | off                                             | arbitrary rpc calls via MQTT — an unrestricted API surface, only on a trusted broker                               |
| `--state-dir`                                                                                                                                | `$STATE_DIRECTORY` or `~/.hm2mqtt`              | devices, paramset descriptions, names and last values                                                              |
| `-u, --mqtt-url`, `--mqtt-username`, `--mqtt-password`, `--mqtt-tls-ca`, `-n, --name`, `--json-payloads`, `--maintenance`, `-v, --verbosity` | core                                            | shared options of every adapter; `--name` (default `hm`) is the topic prefix                                       |

## Topics

`<name>` = `--name` (default `hm`). Channel and variable names are the CCU's, verbatim (spaces,
umlauts and `/` included; `+`, `#` and empty levels become `_`).

| topic                                                                   | direction | payload                                                                                                            |
| ----------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `<name>/connected`                                                      | out       | `0` gone, `1` broker connected, `2` every interface subscribed and the ReGa answering (retained)                   |
| `<name>/status/<channel>/<DATAPOINT>`                                   | out       | every event, retained except `PRESS_*` and other `ACTION` datapoints                                               |
| `<name>/status/<channel>/LEVEL_NOTWORKING`, `…/STATE_NOTWORKING`        | out       | the value of an actuator once it stopped moving/dimming (for UI sliders)                                           |
| `<name>/status/<variable>`, `<name>/status/<program>`                   | out       | variables and programs (`val` = value / active), on change and at start                                            |
| `<name>/status/interface/<interface>/connected`                         | out       | `true`/`false` per interface process                                                                               |
| `<name>/status/counter/<interface>/rx`, `…/tx`                          | out       | received event batches / sent setValue+putParamset calls since start                                               |
| `<name>/status/<interfaceAddress>/DUTY_CYCLE`                           | out       | duty cycle of every RF adapter (`listBidcosInterfaces`), plus `CARRIER_SENSE_LEVEL` and `CONNECTED` where reported |
| `<name>/info`                                                           | out       | adapter, version, `ccu`, `interfaces`, `devices` (retained)                                                        |
| `<name>/set/<channelNameOrAddress>/<DATAPOINT>`                         | in        | plain value or `{"val": …}`; cast by the paramset description (booleans, `ENUM` names, floats)                     |
| `<name>/set/<variable>`                                                 | in        | value; `ENUM` names accepted                                                                                       |
| `<name>/set/<program>`                                                  | in        | `true`/`false` activates/deactivates, anything else (e.g. `start`) executes the program                            |
| `<name>/set/rega/sync`                                                  | in        | re-read names, rooms and functions after changes on the CCU                                                        |
| `<name>/paramset/<channelOrDevice>/<PARAMSET>`                          | in        | JSON object → `putParamset`, e.g. `{"MODE_TEMPERATUR_REGULATOR": 2}` on `MASTER`                                   |
| `<name>/paramset/<channelOrDevice>/<PARAMSET>/<PARAM>`                  | in        | single value → `putParamset`                                                                                       |
| `<name>/rpc/<interface>/<method>/<callId>` → `<name>/response/<callId>` | in/out    | `--rpc-topics` only: JSON array of parameters, answer as JSON (or `{"error": …}`)                                  |
| `<name>/maintenance/set/loglevel`, `…/restart`                          | in        | `error`/`warn`/`info`/`debug`; graceful restart (core, `--no-maintenance` disables)                                |

Use the channel name (`Licht Küche`) or the address (`OEQ1234567:1`) in `set` and `paramset`
topics. `set/<channel>/<DATAPOINT>` with two channels sharing a name reaches the first one — the
start-up log lists duplicate names.

## Payloads

Status payloads are JSON: `{"val": …, "ts": <ms>, "lc": <ms>, "hm": {…}}` — `val` the value,
`ts` the time of the event (variables: the CCU's timestamp), `lc` the last change. `hm` is the
meta data block of node-red-contrib-ccu's messages, field for field:

```json
{
  "val": 0.5,
  "ts": 1787900000000,
  "lc": 1787899000000,
  "hm": {
    "ccu": "homematic-ccu3",
    "iface": "BidCos-RF",
    "device": "OEQ1234567",
    "deviceName": "Dimmer Flur",
    "deviceType": "HM-LC-Dim1L-CV",
    "channel": "OEQ1234567:1",
    "channelName": "Licht Flur",
    "channelType": "DIMMER",
    "channelIndex": 1,
    "datapoint": "LEVEL",
    "datapointName": "BidCos-RF.OEQ1234567:1.LEVEL",
    "datapointType": "FLOAT",
    "datapointMin": 0,
    "datapointMax": 1,
    "datapointDefault": 0,
    "datapointControl": "DIMMER.LEVEL",
    "datapointUnit": "100%",
    "valuePrevious": 0.3,
    "valueStable": 0.5,
    "rooms": ["Flur"],
    "room": "Flur",
    "functions": ["Licht"],
    "function": "Licht",
    "ts": 1787900000000,
    "tsPrevious": 1787899000000,
    "lc": 1787899000000,
    "change": true,
    "cache": false,
    "uncertain": false,
    "working": false,
    "direction": 0,
    "stable": true
  }
}
```

`ENUM` datapoints carry `datapointEnum` (the value list) and `valueEnum` (the name of the current
value). Variables have `type: "SYSVAR"` with `valueType`, `unit`, `enum`, `valueEnum`, `id` and —
when bound to a channel — the channel fields; programs `type: "PROGRAM"` with `active`,
`activePrevious`, `ts` (last execution). `--no-hm-payload` leaves `{val, ts, lc}`,
`--no-json-payloads` publishes the bare value. `--plain-tree state` mirrors every item to
`<name>/state/…` with plain values and booleans as `0`/`1`.

## Names

Names come from the ReGa (devices, channels, rooms, functions), are cached in the state
directory and re-read with `<name>/set/rega/sync`. A `--name-file` overrides single addresses.
Without the ReGa (`--no-rega`) topics use addresses. Events of channels without a name use the
address as well.

## Home Assistant

The core's discovery options (`--ha-discovery`, `--ha-prefix`) exist, but 3.0 does not announce
devices yet — channel-type to entity mapping is planned for 3.1 (ROADMAP §10).

## Migration

### From the node-red-contrib-ccu `ccu-mqtt` flow

Same topics for events, variables, programs, counters, `set` and `paramset`. Differences:

- `<name>/connected` reflects the CCU: `1` while an interface is down (the flow always said `2`).
- Counters and duty cycle payloads are `{val, ts, lc}` like every other status (`val` unchanged).
- `PRESS_*` **and** other `ACTION` datapoints are not retained.
- Variables and programs are published at start too, not only on change; polling is on by default.
- `hm` carries `datapointEnum`/`valueEnum` (from the `VALUE_LIST`) and `datapointUnit`.
- `paramset` values are cast by their own description and rejected when not writeable.
- The second (plain) `ccu-mqtt` node is `--plain-tree state`; the `rpc` topic of the node never
  worked — `--rpc-topics` brings the 2.x form back.

### From hm2mqtt 2.x

| 2.x                                                                  | 3.0                                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `hm/status/<ch>/<dp>` with `hm: {ADDRESS, UNIT, ENUM}`               | same topic, `hm` block as above (`channel`, `datapointUnit`, `valueEnum`)         |
| `hm/rega/<variable\|program>`                                        | `hm/set/<variable\|program>`                                                      |
| `hm/param/<ch>/<paramset>/<dp>`                                      | `hm/paramset/<ch>/<paramset>/<param>`                                             |
| `hm/rpc/<rfd\|hmip\|hs485d>/<method>/<callid>`                       | `hm/rpc/<BidCos-RF\|HmIP-RF\|BidCos-Wired\|…>/<method>/<callid>` (`--rpc-topics`) |
| `hm/command/regasync`                                                | `hm/set/rega/sync`                                                                |
| `hm/status/counter/<rfd\|hmip>/rpc/<rx\|tx>`                         | `hm/status/counter/<BidCos-RF\|HmIP-RF>/<rx\|tx>`                                 |
| `db/extend/hm/<address>` (`--publish-metadata`)                      | dropped                                                                           |
| `--insecure`, `--disable-rega`, `--json-name-table`, `--mqtt-retain` | `--ccu-insecure` / `--mqtt-tls-ca`, `--no-rega`, `--name-file`, —                 |
| interface names `rfd`, `hmip`, `hs485d`                              | `BidCos-RF`, `HmIP-RF`, `BidCos-Wired`                                            |

## Development

`npm test` (node:test, no CCU needed), `npm run lint`. `deploy.sh` ships the package (and
`file:../` siblings) to a host and restarts the `hm2mqtt@*` units. Plan and decisions:
[ROADMAP.md](ROADMAP.md); changes: [CHANGELOG.md](CHANGELOG.md).

## License

MIT (c) Sebastian Raff
