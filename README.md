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

Docker (multi-arch image for amd64, arm64 and armv7):

```
docker run -d --name hm2mqtt --restart unless-stopped --network host -v hm2mqtt:/data \
  -e HM2MQTT_CCU_ADDRESS=homematic-ccu3 -e HM2MQTT_MQTT_URL=mqtt://broker \
  ghcr.io/hobbyquaker/hm2mqtt.js
```

Host networking, or publish 2126/2127 and set `HM2MQTT_INIT_ADDRESS` to the docker host's address
so the CCU can call back. `--restart unless-stopped` brings it back after `maintenance/set/restart`.

### On the CCU itself (addon package)

For a setup without a server: hm2mqtt also ships as a CCU addon, installed in the WebUI under
_Systemsteuerung → Zusatzsoftware_. Pick the package for your hardware from the
[latest release](https://github.com/hobbyquaker/hm2mqtt.js/releases/latest):

| Platform                                                         | Package                                |
| ---------------------------------------------------------------- | -------------------------------------- |
| CCU3 with the official eQ-3 firmware, ELV-Charly, OpenCCU 32-bit | `hm2mqtt-ccu-armv7l-<version>.tar.gz`  |
| OpenCCU 64-bit (Raspberry Pi 4/5)                                | `hm2mqtt-ccu-aarch64-<version>.tar.gz` |
| OpenCCU on x86_64 (debmatic, virtual machines)                   | `hm2mqtt-ccu-x86_64-<version>.tar.gz`  |

The architecture decides, not the firmware — `uname -m` on the CCU says which one it is. A CCU3 with
the original eQ-3 firmware is always `armv7l`. Each package has a `.sha256` next to it.

After the install a **hm2mqtt** button appears in _Systemsteuerung_: it configures every option of
this README in a form, starts and stops the service and shows the log. The only setting that has to
be made is the broker URL — a CCU has no MQTT broker of its own, so point hm2mqtt at one on your
network (or install the Mosquitto addon).

Everything the addon needs lives in `/usr/local/addons/hm2mqtt`, including its own Node.js runtime
(the CCU3's firmware is far too old to run a current Node, so the addon brings a musl build that
depends on nothing outside its own directory — another addon's Node.js is neither used nor
disturbed). On the CCU it talks to the interface processes directly instead of through lighttpd:
binrpc on 32001/32000 for BidCos, hmipserver on 32010, ReGa on 8183 — no CCU authentication, no
firewall rules, and nothing of hm2mqtt listening on the network. `--local` / `--no-local` overrides
the automatic detection.

The addon packages are marked `-beta` until someone has confirmed an install on real hardware.

## Finding the CCU

```
hm2mqtt --discover
```

broadcasts the eQ-3 discovery datagram (UDP 43439) and prints every CCU that answers, with its
firmware version and the interfaces whose ports are open:

```
172.16.24.145  eQ3-HmIP-CCU3-App  serial 3014F711A0001F58A992F585  [ReGa BidCos-RF BidCos-Wired HmIP-RF VirtualDevices]  (udp)
```

`--discover-json` prints the same as JSON. `-a auto` runs the scan at start and uses the CCU it
found — it refuses to start when none or more than one answers, rather than bridging the wrong
house:

```
hm2mqtt -a auto -u mqtt://broker
```

A broadcast does not cross a router. If the CCU is on another subnet — a separate VLAN for the
house automation is a common setup — name it (or its subnet's broadcast address):

```
hm2mqtt --discover --discover-address 172.16.24.145
hm2mqtt -a auto --discover-address 172.16.24.255 -u mqtt://broker
```

`--discover-timeout` (default 5 s) is how long the scan listens. The scanning itself lives in
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core); this adapter only
declares the probe and the interface ports ([lib/discovery.js](lib/discovery.js)). The probe and
the reply layout come from [hm-discover](https://github.com/hobbyquaker/hm-discover).

## Options

`hm2mqtt --help` lists everything; every option is also an environment variable
`HM2MQTT_<OPTION>` (e.g. `HM2MQTT_CCU_ADDRESS`), plus the unprefixed `MQTT_URL`, `MQTT_USERNAME`,
`MQTT_PASSWORD`, `MQTT_TLS_CA` as fallback. Precedence: command line > environment > defaults.

| option                                                                                                                                       | default                                           | description                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `-a, --ccu-address`                                                                                                                          | —                                                 | hostname or ip of the CCU (required)                                                                               |
| `--ccu-tls`, `--ccu-insecure`, `--ccu-username`, `--ccu-password`                                                                            | off                                               | TLS ports (42001, 42010, …, ReGa 48181) and authentication of a CCU with the firewall/auth enabled                 |
| `-i, --interfaces`                                                                                                                           | `BidCos-RF,HmIP-RF,VirtualDevices,BidCos-Wired`   | interfaces to subscribe to (`CUxD` opt-in), or `auto` to probe the ports                                           |
| `--bidcos-binrpc`                                                                                                                            | off                                               | binrpc instead of xmlrpc for BidCos-RF/-Wired (CCU2, Homegear; a CCU3 proxies xmlrpc only)                         |
| `-l, --listen-address`, `--init-address`, `--xmlrpc-port`, `--binrpc-port`                                                                   | first ipv4, =listen, 2126, 2127                   | callback servers the CCU pushes events to; `--init-address` when the CCU sees another address (NAT, Docker)        |
| `--ping-timeout`                                                                                                                             | 60                                                | seconds without an event before a ping, twice that before a re-init (HmIP-RF uses 600)                             |
| `--rega` / `--no-rega`                                                                                                                       | on                                                | names, rooms, functions, variables and programs from the ReGaHSS                                                   |
| `--rega-poll-interval`, `--rega-poll-trigger`                                                                                                | 30, —                                             | variable/program poll interval (0 = off) and an optional `channel.datapoint` (virtual button) that triggers a poll |
| `--ccu-timezone`                                                                                                                             | host                                              | IANA time zone of the CCU, for the timestamps of variables and cached values                                       |
| `-m, --name-file`                                                                                                                            | —                                                 | JSON `{address: name}` overriding ReGa names ([example-names.json](example-names.json))                            |
| `--item-template`, `--sysvar-item-template`, `--program-item-template`                                                                       | `${channelName\|channel}/${datapoint}`, `${name}` | how items (topic parts) are built, see [Item templates](#item-templates)                                           |
| `--rega-names-interval`                                                                                                                      | 3600                                              | seconds between re-reads of names/rooms/functions (0 = only at start and on `set/rega/sync`)                       |
| `--payload`                                                                                                                                  | `mqsh-extended`                                   | status payload format: `mqsh-extended`, `mqsh-basic` or `plain` ([Payloads](#payloads))                            |
| `--plain-tree <level>`                                                                                                                       | —                                                 | additionally publish plain payloads under `<name>/<level>/…` (the second `ccu-mqtt` node of the Node-RED flow)     |
| `--publish-cache`                                                                                                                            | off                                               | publish every datapoint value known to the ReGa at start (thousands of retained messages)                          |
| `--publish-counters`, `--duty-cycle-interval`                                                                                                | on, 90                                            | rpc rx/tx counters and `listBidcosInterfaces` duty cycle polling (0 = off)                                         |
| `--rpc-topics`                                                                                                                               | off                                               | arbitrary rpc calls via MQTT — an unrestricted API surface, only on a trusted broker                               |
| `--ignore`                                                                                                                                   | —                                                 | comma separated globs on `<interface>.<channel>.<datapoint>` not to publish, e.g. `*.*.RSSI_*,HmIP-RF.*.*_STATUS`  |
| `--ha-generic` / `--no-ha-generic`                                                                                                           | on                                                | announce datapoints without a role as (disabled) generic entities ([Home Assistant](#home-assistant))              |
| `--state-dir`                                                                                                                                | `$STATE_DIRECTORY` or `~/.hm2mqtt`                | devices, paramset descriptions, names and last values                                                              |
| `-u, --mqtt-url`, `--mqtt-username`, `--mqtt-password`, `--mqtt-tls-ca`, `-n, --name`, `--json-payloads`, `--maintenance`, `-v, --verbosity` | core                                              | shared options of every adapter; `--name` (default `hm`) is the topic prefix                                       |

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

### Topic templates

Every topic is a template, whole. `${prefix}` is the instance name (`--name`, default `hm`), the
other placeholders are the fields of the `hm` block:

| Option                   | Default                                                 |
| ------------------------ | ------------------------------------------------------- |
| `--topic-status`         | `${prefix}/status/${channelName\|channel}/${datapoint}` |
| `--topic-set`            | `${prefix}/set/${channelName\|channel}/${datapoint}`    |
| `--topic-sysvar-status`  | `${prefix}/status/${name}`                              |
| `--topic-sysvar-set`     | `${prefix}/set/${name}`                                 |
| `--topic-program-status` | `${prefix}/status/${name}`                              |
| `--topic-program-set`    | `${prefix}/set/${name}`                                 |

The defaults render exactly the topics hm2mqtt has always used, so nothing moves unless you move it.
`|` is a fallback chain, field names are case-insensitive, an empty result becomes `_`. Examples:
`${prefix}/${room|_}/${channelName}/${datapoint}`, `smarthome/${iface}/${channel}/${datapoint}`,
`${prefix}/status/${device}/${channelIndex}/${datapoint}`.

What hm2mqtt subscribes follows from the literal part of the `set` templates: everything up to the
first placeholder, plus `#` — `hm/set/#` for the default. A rendered level may contain slashes (a
channel named `Haus/OG/Licht` is legitimate), so incoming topics are resolved by looking up the
whole topic in an index of every known channel and datapoint, not by counting levels. Below the
literal part the address form still works (`hm/set/OEQ1234567:1/STATE`), as do the commands
(`hm/set/rega/sync`). Channels rendering the same topic are listed at start; the first one wins.

Moving the templates moves the topics for everything subscribed to them, and Home Assistant
discovery re-announces every entity, because the state and command topics it publishes come from
these same templates.

`--item-template`, `--sysvar-item-template` and `--program-item-template` named only the part after
`<name>/status/`. They still work — each becomes the matching pair of topic templates — but the
topic options replace them.

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
`activePrevious`, `ts` (last execution). `--payload` selects the format the way the `ccu-mqtt` node did:
`mqsh-extended` (default, as above), `mqsh-basic` (`{val, ts, lc}`) or `plain` (the bare value,
booleans as `0`/`1`). `--plain-tree state` additionally mirrors every item to `<name>/state/…` in
the plain format (the second `ccu-mqtt` node of a flow).

## Names

Names come from the ReGa (devices, channels, rooms, functions), are cached in the state
directory and re-read with `<name>/set/rega/sync`. A `--name-file` overrides single addresses.
Without the ReGa (`--no-rega`) topics use addresses. Events of channels without a name use the
address as well.

## Home Assistant

Device-based MQTT discovery (`homeassistant/device/<id>/config`, HA ≥ 2024.11) is on by default
(`--no-ha-discovery` clears it, `--ha-prefix` changes the prefix). One HA device per Homematic
device (manufacturer eQ-3, model = device type, `via_device` = the CCU bridge device,
`suggested_area` = the room when all channels sit in one room), available while `<name>/connected`
is `2` **and** the device's `UNREACH` is false.

Entities are derived from the paramset descriptions, not from a device list — every device the
CCU knows works: the `CONTROL` hint of a channel's primary datapoint decides the role
(`SWITCH.STATE`, `DIMMER.LEVEL`, `BLIND.LEVEL`, `DOOR_SENSOR.STATE`, `HEATING_CONTROL(_HMIP).SETPOINT`,
`LOCK.STATE`, `BUTTON.SHORT`, …), the channel type covers the older HM devices.

| role                                                   | entity                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| switch (HM `SWITCH`, HmIP `*_VIRTUAL_RECEIVER`)        | `switch`; HmIP: state from the `SWITCH_TRANSMITTER` channel, first receiver enabled, receivers 2/3 disabled by default                        |
| dimmer                                                 | `light` with brightness (`LEVEL` 0..1 ↔ 0..100 %)                                                                                             |
| blind / shutter                                        | `cover` with position, `STOP`, tilt (`LEVEL_2`) when present, opening/closing from `DIRECTION`/`ACTIVITY_STATE`                               |
| thermostat (HM and HmIP)                               | `climate`: setpoint, current temperature/humidity, modes `auto`/`heat`, preset `boost` (HM also `comfort`/`eco`), action                      |
| contact, rotary handle, motion, presence, smoke, water | `binary_sensor` with device class (rotary handle also a `closed/tilted/open` sensor)                                                          |
| key                                                    | `event` per key channel with `press_short`, `press_long`, … (from the aggregate `<channel>/PRESS` item)                                       |
| lock (KEYMATIC)                                        | `lock`                                                                                                                                        |
| energy meter, weather                                  | `sensor`s with device/state classes and units                                                                                                 |
| maintenance (`:0`)                                     | `LOW_BAT` battery sensor enabled; `RSSI_*`, `OPERATING_VOLTAGE`, `UNREACH`, `DUTY_CYCLE`, … diagnostic, disabled                              |
| everything else                                        | generic `sensor`/`binary_sensor`/`switch`/`select`/`number`/`button` from the description, disabled by default (`--no-ha-generic` drops them) |

The entities use the normal topics; three small additions make HA's single-topic conventions work:
`set/<channel>/LEVEL` accepts `OPEN`, `CLOSE`, `STOP`, `ON` (restore last level) and `OFF`; HM
thermostats accept `set/<channel>/CONTROL_MODE` with `AUTO-MODE`, `MANU-MODE`, `BOOST-MODE`,
`COMFORT-MODE`, `LOWERING-MODE` (translated to the mode actions); every key press is also
published as `status/<channel>/PRESS` (`val` = `PRESS_SHORT` etc., not retained). `--ignore`
keeps datapoints out of both MQTT and discovery. Not covered yet: RGBW/colour lights, sirens,
garage doors, variables/programs as entities.

## Migration

### From the node-red-contrib-ccu `ccu-mqtt` flow

Same topics for events, variables, programs, counters, `set` and `paramset`. Differences:

- `<name>/connected` reflects the CCU: `1` while an interface is down (the flow always said `2`).
- `hm.ccu` is the configured `--ccu-address` (the flow, running on the CCU, said `localhost`).
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
