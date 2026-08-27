# Roadmap & implementation spec — hm2mqtt 3.0

hm2mqtt 2.5 (2018, CommonJS, Node 6, `yalm`/`request`/`persist-json`) was abandoned in favour of
[node-red-contrib-ccu](https://github.com/rdmtc/node-red-contrib-ccu); since then the Homematic
side of the house has been a Node-RED flow (two `ccu-mqtt` nodes + a `ccu-rpc` duty-cycle poll)
running on the CCU3 under RedMatic. 3.0 reverses that: hm2mqtt becomes a normal `xyz2mqtt` adapter
on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) (mqtt-smarthome
spec 2.x) and a **drop-in replacement for that flow** — same topics, same payloads, so that the
`she` scripts and everything else subscribed to `hm/#` keep working when the flow is switched off.

Decisions specific to this repo are **H-n**, core gaps continue the core numbering at **G-4+**
(G-1…G-3 were alexa-remote-mqtt's, core 0.3.0), open questions continue the fleet numbering at
**OQ-43+**. Fleet decisions (D-n) and the core's (C-n) are referenced, not repeated. The master
roadmap in the `mqtt-interfaces` umbrella repo was not reachable while writing this; D-n references
follow the core README/ROADMAP wording.

**Status 2026-08-27 (evening): 3.0.0-dev implemented (§7 steps 1–10), 41 unit tests + 7 e2e scenarios with hm-simulator green; verified read-only against the real CCU (ReGa, RPC reads). Not yet done: the parallel run and cutover of §9 — the CCU cannot call back a host outside its LAN (see §12), so the event path is verified with the simulator only until hm2mqtt runs on the home server. No release tagged.**

Contents: 1 the contract (what the flow does today) · 2 what 2.5 and node-red-contrib-ccu
contribute · 3 decisions · 4 topics (Node-RED → 3.0, 2.5 → 3.0) · 5 CLI/env · 6 prerequisites in
sibling libs and the core · 7 implementation steps · 8 tests · 9 cutover · 10 after 3.0 ·
11 open questions.

---

## 1. The contract — what the Node-RED flow does today

Source: the exported `MQTT` tab (2026-08-27) and node-red-contrib-ccu 3.4.2
(`nodes/ccu-mqtt.js`, `nodes/ccu-connection.js`, checkout at
`~/WebstormProjects/node-red-contrib-ccu`).

### 1.1 Setup

| what                     | value                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| runs on                  | the CCU3 itself (RedMatic), `host: localhost` → local binrpc ports (32001/32010/…), ReGa 8183                                                                      |
| interfaces               | ReGaHSS, BidCos-RF, HmIP-RF, VirtualDevices, BidCos-Wired; **CUxD off**                                                                                            |
| RPC callback server      | `127.0.0.1`, binrpc 2047, xmlrpc 2048; ping timeout 60 s (HmIP-RF: 600 s hard-coded), setValue queue timeout 5000 ms / pause 250 ms                                |
| ReGa polling             | **off** (`regaPoll: false`, interval 30 s configured but unused) → sysvars/programs are published at start and after a `set` only (or by `ccu-poll` on other tabs) |
| cache                    | **off** on both `ccu-mqtt` nodes → no initial state publish at start, retained messages on the broker carry the state                                              |
| broker                   | `mqtts://mqtt.lan.raff.rocks:8883`, own CA (`Honest_Basti_Root_CA.pem`), verify server cert, client id `homematic-ccu3`, keepalive 30, clean session               |
| birth / will             | `hm/connected` = `2` retained on connect, `0` retained as will (Node-RED mqtt node — **not** the CCU state)                                                        |
| duty cycle               | every 90 s `listBidcosInterfaces` on BidCos-RF → `hm/status/<ifaceAddress>/DUTY_CYCLE` retained, plain number (function node)                                      |
| subscriptions            | `hm/set/#` (payload auto), `hm/paramset/#` (payload JSON)                                                                                                          |
| node 1 (`mqsh-extended`) | output `hm/status/…`, counters `hm/status/counter/…`                                                                                                               |
| node 2 (`plain`)         | the same under `hm/state/…` with plain payloads, counters `hm/state/counter/…`                                                                                     |

### 1.2 Output topics

`<ch>` = ReGa channel name (fallback: address — `topicReplace` inserts an empty string when the
name is unknown, i.e. `hm/status//STATE`; a bug we do not reproduce).

| topic                                                   | retained              | payload (`mqsh-extended` node)                                                                                                                                                     |
| ------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hm/status/<ch>/<datapoint>`                            | yes, except `PRESS_*` | `{val, ts, lc, hm: {…}}` — `hm` is the node-red-contrib-ccu message minus `topic`/`payload`/`value`, see 1.4                                                                       |
| `hm/status/<ch>/LEVEL_NOTWORKING`, `…/STATE_NOTWORKING` | yes                   | same, published when `working === false` for `LEVEL`/`STATE` (300 ms wait-for-working on actuator channel types); `hm.datapoint`/`hm.datapointName` carry the `_NOTWORKING` suffix |
| `hm/status/<sysvarName>`                                | yes                   | `{val, ts, lc, hm: {iface: 'ReGaHSS', type: 'SYSVAR', …}}`; `ts` = CCU-side timestamp of the variable, only on change (`change: true` filter)                                      |
| `hm/status/<programName>`                               | yes                   | `{val: <active>, ts, hm: {type: 'PROGRAM', …}}` (no `lc`), on every poll where `active` or `ts` (last execution) changed                                                           |
| `hm/status/counter/<iface>/rx`, `…/tx`                  | yes                   | plain integer; `0` published 25 s after start, then every 30 s on change. rx = event batches (not PONG), tx = `setValue`/`putParamset`/`activateLinkParamset` calls                |
| `hm/status/<ifaceAddress>/DUTY_CYCLE`                   | yes                   | plain integer (function node, not a ccu-mqtt output)                                                                                                                               |
| `hm/state/…` (all of the above)                         | as above              | plain: booleans as `0`/`1`, numbers/strings raw, objects JSON                                                                                                                      |
| `hm/connected`                                          | yes                   | `2` / `0`                                                                                                                                                                          |

### 1.3 Input topics

| topic                                                   | payload                                                                                                    | behaviour                                                                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hm/set/<channelNameOrAddress>/<datapoint>`             | auto: number, boolean, string, JSON                                                                        | name → address (channels only), iface lookup, `paramCast` by paramset description (BOOL/ACTION/FLOAT→`explicitDouble`/ENUM by name/INTEGER/STRING), 500 ms per-datapoint throttle/defer     |
| `hm/set/<sysvarOrProgramName>`                          | sysvar: typed (enum names accepted); program: boolean → `Active(bool)`, anything else → `ProgramExecute()` | after a sysvar set an immediate ReGa poll runs                                                                                                                                              |
| `hm/paramset/<channelNameOrAddress>/<paramset>/<param>` | single value                                                                                               | `putParamset` with one key. Bugs in the node: writeable check `!(OPERATIONS) && 2` is always false; cast uses `description[filter.param]` = undefined in `putParamset` → values pass uncast |
| `hm/paramset/<channelNameOrAddress>/<paramset>`         | JSON object                                                                                                | `putParamset` with all keys                                                                                                                                                                 |
| `hm/rpc/<iface>/<method>/<command>/<callid>`            | —                                                                                                          | **dead**: configured on the node but the `ccu-mqtt` node has no `rpc()` handler, and the flow does not even subscribe `hm/rpc/#`                                                            |

### 1.4 The `hm` block (datapoint events)

Field names of node-red-contrib-ccu's `createMessage()` — the compatibility surface for
`mqsh-extended`; 3.0 keeps them 1:1 (H-2):

`ccu, iface, device, deviceName, deviceType, channel, channelName, channelType, channelIndex,
datapoint, datapointName (= "<iface>.<channel>.<datapoint>"), datapointType, datapointMin,
datapointMax, datapointEnum, datapointDefault, datapointControl, valuePrevious, valueEnum,
valueStable, rooms, room, functions, function, ts, tsPrevious, lc, change, cache, uncertain,
working, direction, stable`.

Sysvar: `ccu, iface: 'ReGaHSS', type: 'SYSVAR', name, info, valueType, valueEnum, unit, enum, id,
cache, valuePrevious, valueEnumPrevious, ts, tsPrevious, lc, lcPrevious, change` plus the channel
fields above when the variable is bound to a channel. Program: `id, ccu, iface, type: 'PROGRAM',
name, active, activePrevious, ts, tsPrevious`.

### 1.5 Known consumers

- `she` scripts: `hm//<channel>/<datapoint>` (`//` = `/status/`), `she.mqtt.get()` reads `val`,
  `she.getProp(topic, 'ts')` reads `ts`; `she.mqtt.pub('hm/set/…')`. she's AI tool prompt describes
  the `hm/` tree (STATE for switches, LEVEL for dimmers).
- Whether anything reads `hm/state/…` or the `hm.*` fields is unknown → OQ-43, OQ-46.

---

## 2. What the two code bases contribute

### 2.1 hm2mqtt 2.5 (this repo, `index.js`, 1100 lines)

Almost nothing is kept verbatim (CJS, callbacks, `request`, `yalm`, `persist-json`, node 6), but
the structure is the same problem solved once already:

- RPC clients + servers for binrpc (rfd, hs485d) and xmlrpc (hmip), `init`/`ping`/re-init per
  interface, `system.multicall` unpacking, `listDevices`/`newDevices`/`deleteDevices` with a
  persisted device table, a throttled `getParamsetDescription` queue keyed by
  `PARENT_TYPE/VERSION/TYPE`, `rpcType()` casting, `_NOTWORKING`, rx/tx counters, duty-cycle poll,
  interface port probing (`discover.js`), ReGa scripts for names/variables/programs
  (`regascripts/*.fn`), `--rega-poll-trigger` (virtual button as pseudo push).
- Topics differ from the flow (`hm/param/…`, `hm/rega/<var>`, iface names `rfd`/`hmip`/`hs485d`,
  `hm/rpc/<iface>/<command>/<callid>` → `hm/response/<callid>`, `db/extend/…` metadata). 3.0 follows
  the flow; 2.5 users (are there any? last npm publish 2022, code from 2018) get a migration table.
- `test.js`: mocha e2e against `hm-simulator` (rfd binrpc + hmipserver xmlrpc, no ReGa) driven by
  log-line regexes. The simulator still exists on npm (0.1.1, 2022) and is the basis of the 3.0 e2e
  test (§8).

### 2.2 node-red-contrib-ccu 3.4.2 (`ccu-connection.js`, 2950 lines)

The reference implementation; the Homematic half of 3.0 is a port of it minus Node-RED:

- interface table (§1.1 ports, local vs. remote, TLS/auth variants 4xxxx, `VirtualDevices` with
  path `/groups`, CUxD binrpc 8701, HmIP-RF ping timeout 600 s), `rpcCheckInit` (ping at
  `timeout/2`, re-init after `timeout`, check every `timeout/4`), init id derivable from the URL,
  `getLinks` after init, de-init on close, server `close()` with timeout.
- metadata persistence (`ccu_<host>.json` devices/types, `paramsets.json` descriptions keyed by
  `<iface>/<TYPE>/<FIRMWARE>/<VERSION>/<channelTYPE>/<paramset>`, `ccu_values_<host>.json` last
  values), shipped `paramsets.json` seed, `listDevicesAnswer` per interface (full device for
  HmIP-RF/VirtualDevices, `{ADDRESS, VERSION}` otherwise, empty-string workaround occu#83),
  HmIP-RCV-50 workaround in `listDevices`.
- `createMessage()` (§1.4), `working`/`direction` derivation from `WORKING`, `WORKING_SLATS`,
  `PROCESS`, `DIRECTION`, `ACTIVITY_STATE` inside a multicall and the 300 ms wait-for-working for
  `STATE`/`LEVEL*` on `SIGNAL|SWITCH|RAINDETECTOR_HEAT|ALARMACTUATOR|ARMING|DIMMER|DUAL_WHITE|BLIND|SHUTTER|JALOUSIE|WINMATIC|KEYMATIC`
  channel types; `stable = !working`.
- ReGa via `homematic-rega` (channels with names, rooms, functions, `getValues` for the cache,
  variables, programs, `exec`), RSSI `-256` correction on cached values, `uncertain` for
  1970 timestamps, `setVariable` deferral until variables are known.
- `paramCast()` (§1.3; MIN/MAX clamping deliberately disabled, ccu#74), `setValue` 500 ms
  throttle/defer per datapoint (last write wins), `setValueQueued` (dedupe, timeout, pause — used by
  the `ccu-set-value` node, not by `ccu-mqtt`), tx/rx counters.

---

## 3. Decisions

| ID   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-1  | **3.0.0 = rewrite on mqtt-interfaces-core** (ESM, Node ≥ 20.19, D-4), hard break from 2.5 (D-2). npm package stays `hm2mqtt` (unscoped, bin `hm2mqtt`, env prefix `HM2MQTT_`, default `--name hm`); the GitHub repo stays `hm2mqtt.js`. **The Node-RED flow is the reference, not 2.5**: where the two differ (§4.2) 3.0 follows the flow.                                                                                                                                                                                                                                                                                                               |
| H-2  | **Payloads are `{val, ts, lc}` + `hm` block** (mqsh-extended) by default; the `hm` block keeps node-red-contrib-ccu's field names 1:1 (§1.4). `--no-hm-payload` drops the block (`{val, ts, lc}` only); `--no-json-payloads` gives plain values (core). Needs core G-4 and G-5. `ts`/`lc` of sysvars and cached values are the CCU-side timestamps, as in the flow.                                                                                                                                                                                                                                                                                      |
| H-3  | **Items are the CCU's names, verbatim**: `<channelName>/<DATAPOINT>` (channel name from ReGa, address when unknown), `<sysvarName>`, `<programName>`, `counter/<iface>/<rx\|tx>`, `<ifaceAddress>/DUTY_CYCLE`. No snake_case, no lower-casing (drop-in; datapoint names are protocol constants) — an accepted deviation from the fleet convention (OQ-48). `/` in a name stays (deeper topic, as today); `+`, `#` and empty levels are replaced by `_` with a `warn`. `set/<…>/<DATAPOINT>` takes the last level as datapoint, the rest as name or address.                                                                                              |
| H-4  | **The plain mirror tree `hm/state/…` is opt-in**: `--plain-tree <level>` (e.g. `state`, default off) publishes every status item a second time under `<name>/<level>/…` with plain payloads and booleans as `0`/`1`, exactly as the second `ccu-mqtt` node did. Kept for the cutover only; to be removed once nothing reads it (OQ-43).                                                                                                                                                                                                                                                                                                                  |
| H-5  | **`<name>/connected` means something now**: `2` only when every enabled RPC interface is initialised and ReGa answered, `1` otherwise (the flow always said `2`). Per-interface state as retained `<name>/status/interface/<iface>/connected` (`true`/`false`, no `hm` block) — the `interface/` and `counter/` levels are reserved names; a channel named like them gets `_` appended with a `warn`.                                                                                                                                                                                                                                                    |
| H-6  | **Interface names are the CCU's** (`BidCos-RF`, `HmIP-RF`, `BidCos-Wired`, `VirtualDevices`, `CUxD`, `ReGaHSS`) in topics, `hm.iface`, options and logs. 2.5's `rfd`/`hmip`/`hs485d` are gone. Enabled by `--interfaces` (default `BidCos-RF,HmIP-RF,VirtualDevices,BidCos-Wired`, i.e. the flow; `CUxD` opt-in); an enabled interface whose port does not answer is `warn` + retry every 30 s, not an exit. `--interfaces auto` probes the ports (2.5's `discover.js`).                                                                                                                                                                                 |
| H-7  | **hm2mqtt runs on the home server, not on the CCU**, as systemd template unit `hm2mqtt@hm` (core installer) next to the other adapters, and talks to the CCU over the network: XML-RPC 2001/2000/2010/9292 (`--ccu-tls`/`--ccu-username`/`--ccu-password` for the 4xxxx ports and auth, `secret: true`), binrpc for CUxD 8701 (and `--bidcos-binrpc` for 2001), ReGa 8181. Callback servers bind `--listen-address` (default: first non-loopback IPv4) on `--xmlrpc-port 2126` / `--binrpc-port 2127` (2.5's defaults), `--init-address` when NAT/Docker is in the way. The CCU firewall must allow the host. Running on the CCU is not planned (OQ-44). |
| H-8  | **State lives in `STATE_DIRECTORY`** (`--state-dir`, default `process.env.STATE_DIRECTORY` or `~/.hm2mqtt`): `devices.json` (per interface), `paramsets.json` (descriptions, seeded from node-red-contrib-ccu's `paramsets.json` shipped in the package), `rega.json` (names, rooms, functions), `values.json` (last values, for `valuePrevious`/`lc` across restarts). `<name>/set/…` with unknown names is answered with a `warn`, and a ReGa re-read can be forced with `<name>/set/rega/sync` (replaces 2.5's `command/regasync`).                                                                                                                   |
| H-9  | **Events**: `PRESS_*` datapoints and every `TYPE: 'ACTION'` datapoint are published with `retain: false` (2.5 did ACTION, the flow did `PRESS_*`; the union is what mqtt-smarthome means by an event). Slight deviation for non-`PRESS_` ACTION datapoints (OQ-49). `_NOTWORKING` items are retained and carry the same payload as the flow.                                                                                                                                                                                                                                                                                                             |
| H-10 | **ReGa polling on by default**: `--rega-poll-interval 30` (0 = off) publishes sysvars/programs on change (`ts` change, like the flow's `change: true` filter — no noise when nothing changed); `--rega-poll-trigger BidCoS-RF:50.PRESS_SHORT`-style pseudo-push from 2.5 is kept; a `set/<sysvar>` triggers an immediate poll. The flow had polling off, see OQ-45.                                                                                                                                                                                                                                                                                      |
| H-11 | **No initial state dump by default** (`cache: false` in the flow): retained messages on the broker are the state. `--publish-cache` publishes every datapoint from ReGa `getValues` at start with CCU-side `ts` and `hm.cache: true` / `hm.uncertain` — useful after renames and for a fresh broker, thousands of messages otherwise.                                                                                                                                                                                                                                                                                                                    |
| H-12 | **Set path = node-red-contrib-ccu's, with its bugs fixed**: `paramCast` by paramset description (ENUM names, `explicitDouble`, no MIN/MAX clamping, string fallback for unknown descriptions), the 500 ms per-datapoint throttle/defer, writeable check (`OPERATIONS & 2`) that actually works and rejects with `warn`, `paramset` values cast by _their own_ description. `set` accepts plain and `{val}` payloads (core). Sysvar/program `set` as in §1.3.                                                                                                                                                                                             |
| H-13 | **`rpc` topics come back, opt-in**: `--rpc-topics` subscribes `<name>/rpc/<iface>/<method>/<callid>` (JSON array params) and answers on `<name>/response/<callid>` (2.5 semantics; the flow's 4-level pattern never worked). Off by default — an unrestricted RPC surface over MQTT is a security surface, like `--raw-set` elsewhere in the fleet.                                                                                                                                                                                                                                                                                                      |
| H-14 | **Counters and duty cycle stay**: `--publish-counters` (default on) → `counter/<iface>/rx`, `…/tx` on change (rate-limited to 30 s as today, initial `0` at start); `--duty-cycle-interval 90` (0 = off) → `<ifaceAddress>/DUTY_CYCLE` via `listBidcosInterfaces` on BidCos-RF **and** HmIP-RF (the flow only asked BidCos-RF, which on a CCU3 lists both adapters anyway), plus `<ifaceAddress>/CARRIER_SENSE_LEVEL` and `…/CONNECTED` when present. Payloads follow H-2 (the flow's were plain — `val` is the same number).                                                                                                                            |
| H-15 | **Home Assistant discovery is not part of 3.0.0** — `discovery()` returns nothing, `--ha-discovery` exists (core) but announces no devices. 3.1 adds channel-type → entity mapping (§10). D-5 (on by default) is honoured as soon as there is something to announce.                                                                                                                                                                                                                                                                                                                                                                                     |
| H-16 | **Logging per fleet rules**: `rpc <`/`rpc >` per interface and `rega <`/`rega >` at `debug`; an interface that stops answering or a ping timeout is `warn` once (recovery `info`); unknown paramset descriptions `debug` (they are fetched); a rejected `set` is `warn` with topic, payload and reason (core); `error` only for bad config (no CCU address, port bind failure).                                                                                                                                                                                                                                                                          |
| H-17 | **Client id**: core scheme `<prefix><name>_<random>`; use `--mqtt-client-id-prefix homematic-ccu3_` if a broker ACL is bound to the old id `homematic-ccu3` (OQ-50). TLS with own CA via `--mqtt-tls-ca` (or the shared `MQTT_TLS_CA` in `/etc/mqtt-interfaces/broker.env`).                                                                                                                                                                                                                                                                                                                                                                             |
| H-18 | **Variables and programs are published at start**, not only on change (the flow's `cache: false` suppressed the first poll): they are few and retained, and a fresh broker gets them without waiting for a change. Datapoints stay opt-in (H-11).                                                                                                                                                                                                                                                                                                                                                                                                        |
| H-19 | **`datapointEnum`/`valueEnum` come from `VALUE_LIST`** (node-red-contrib-ccu read `description.ENUM`, which the interface processes never send, so both were always undefined there) and `datapointUnit` is added (OQ-51 → yes; `°C` repaired from the lone latin1 byte). Additive: no consumer could depend on undefined fields.                                                                                                                                                                                                                                                                                                                        |
| H-20 | **Robustness rules learnt on the first live run**: the CCU host is resolved once at start and retried until it resolves (parallel lookups of the same name failed intermittently on macOS); every RPC call has a 30 s timeout (rfd's `init` blocks until it has called us back — with no route it hung forever); state is saved _before_ the de-init at shutdown (the core's 2 s budget). An interface that fails `init` warns once and retries every 30 s; `connected` stays `1`.                                                                                                                                                                       |

---

## 4. Topics

`<name>` = `--name` (default `hm`). Payloads `{val, ts, lc, hm}` unless noted (H-2).

### 4.1 Node-RED flow → 3.0 (the drop-in table)

| flow                                                  | 3.0                                                                                 | notes                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `hm/connected` `2`/`0`                                | `<name>/connected` `0`/`1`/`2`                                                      | `1` while an interface is down (H-5) — consumers testing `== 2` see the CCU state now           |
| —                                                     | `<name>/info`                                                                       | core fields + `ccu` (address), `interfaces` (enabled list), `devices` (count), `rega` (bool)    |
| —                                                     | `<name>/status/interface/<iface>/connected`                                         | H-5                                                                                             |
| `hm/status/<ch>/<dp>`                                 | unchanged                                                                           | `hm` block 1:1                                                                                  |
| `hm/status/<ch>/LEVEL_NOTWORKING`, `STATE_NOTWORKING` | unchanged                                                                           |                                                                                                 |
| `hm/status/<sysvar>`, `hm/status/<program>`           | unchanged                                                                           | published on change; poll interval H-10                                                         |
| `hm/status/counter/<iface>/rx\|tx`                    | unchanged topic                                                                     | payload was plain, now `{val, ts, lc}` (`val` unchanged)                                        |
| `hm/status/<ifaceAddress>/DUTY_CYCLE`                 | unchanged topic                                                                     | payload was plain, now `{val, ts, lc}`; also HmIP-RF, `CARRIER_SENSE_LEVEL`, `CONNECTED` (H-14) |
| `hm/state/…` (plain mirror)                           | `--plain-tree state` (opt-in)                                                       | H-4                                                                                             |
| `hm/set/<chNameOrAddr>/<dp>`                          | unchanged                                                                           | `{val}` wrapper also accepted                                                                   |
| `hm/set/<sysvar\|program>`                            | unchanged                                                                           |                                                                                                 |
| `hm/paramset/<chNameOrAddr>/<paramset>/<param>`       | unchanged                                                                           | now cast + writeable-checked (H-12)                                                             |
| `hm/paramset/<chNameOrAddr>/<paramset>` (JSON)        | unchanged                                                                           |                                                                                                 |
| `hm/rpc/<iface>/<method>/<command>/<callid>` (dead)   | `<name>/rpc/<iface>/<method>/<callid>` → `<name>/response/<callid>`, `--rpc-topics` | H-13                                                                                            |
| —                                                     | `<name>/set/rega/sync`                                                              | re-read names/rooms/functions (H-8)                                                             |
| —                                                     | `<name>/maintenance/set/loglevel`, `…/restart`                                      | core (D-9), `--no-maintenance`                                                                  |

### 4.2 hm2mqtt 2.5 → 3.0 (for the README's migration section)

| 2.5                                                                                                             | 3.0                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `hm/status/<ch>/<dp>` `{val, ts, lc, hm: {ADDRESS, UNIT, ENUM}}`                                                | same topic, `hm` block per §1.4 (`hm.channel`, `hm.datapointEnum`/`valueEnum`, unit is not part of the message → OQ-51) |
| `hm/status/<var>` `{val, ts, hm: {id, UNIT, MIN, MAX, ENUM}}`                                                   | same topic, sysvar `hm` block per §1.4                                                                                  |
| `hm/rega/<var\|program>`                                                                                        | `hm/set/<var\|program>`                                                                                                 |
| `hm/param/<ch>/<paramset>/<dp>`                                                                                 | `hm/paramset/<ch>/<paramset>/<param>`                                                                                   |
| `hm/paramset/<ch>/<paramset>`                                                                                   | unchanged                                                                                                               |
| `hm/rpc/<rfd\|hmip\|hs485d>/<command>/<callid>`                                                                 | `hm/rpc/<BidCos-RF\|HmIP-RF\|BidCos-Wired\|…>/<method>/<callid>`, `--rpc-topics`                                        |
| `hm/command/regasync`                                                                                           | `hm/set/rega/sync`                                                                                                      |
| `hm/status/counter/<rfd\|hmip>/rpc/<rx\|tx>`                                                                    | `hm/status/counter/<BidCos-RF\|HmIP-RF>/<rx\|tx>`                                                                       |
| `db/extend/hm/<address>` (`--publish-metadata`)                                                                 | dropped (OQ-52)                                                                                                         |
| `--ccu-address`, `--mqtt-url`, `-n`, `-v`, `--insecure`, `--json-name-table`, `--disable-rega`, `--mqtt-retain` | see §5                                                                                                                  |

---

## 5. CLI / env

Shared set from the core (`--mqtt-url/-u`, `--mqtt-username`, `--mqtt-password`,
`--mqtt-client-id-prefix`, `--mqtt-tls-ca`, `--name/-n`, `--json-payloads`, `--ha-discovery`,
`--ha-prefix`, `--maintenance`, `--verbosity/-v`, `--install`, `--uninstall`, `--config-schema`)
plus, all as `HM2MQTT_<OPTION>`:

| option                             | alias | type    | default                                         | notes                                                                                         |
| ---------------------------------- | ----- | ------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `--ccu-address`                    | `-a`  | string  | —, required                                     | CCU host/IP                                                                                   |
| `--ccu-tls`                        |       | boolean | false                                           | use the 4xxxx TLS ports and `https` ReGa                                                      |
| `--ccu-insecure`                   |       | boolean | false                                           | accept the CCU's self-signed certificate                                                      |
| `--ccu-username`, `--ccu-password` |       | string  | —                                               | CCU authentication; password `secret: true`                                                   |
| `--interfaces`                     | `-i`  | string  | `BidCos-RF,HmIP-RF,VirtualDevices,BidCos-Wired` | comma list or `auto` (H-6); `CUxD` opt-in                                                     |
| `--bidcos-binrpc`                  |       | boolean | false                                           | talk binrpc instead of XML-RPC to BidCos-RF/-Wired                                            |
| `--listen-address`                 | `-l`  | string  | first non-loopback IPv4                         | RPC callback servers bind here                                                                |
| `--init-address`                   |       | string  | = listen address                                | address the CCU should call back (NAT/Docker)                                                 |
| `--xmlrpc-port`, `--binrpc-port`   |       | number  | 2126, 2127                                      |                                                                                               |
| `--ping-timeout`                   |       | number  | 60                                              | seconds without an event before ping / re-init; HmIP-RF uses 600 (occu#42)                    |
| `--rega`                           |       | boolean | true                                            | `--no-rega`: no names, sysvars, programs (addresses in topics)                                |
| `--rega-poll-interval`             |       | number  | 30                                              | seconds; 0 = off (H-10)                                                                       |
| `--rega-poll-trigger`              |       | string  | —                                               | `<channel>.<datapoint>` whose event triggers a poll                                           |
| `--name-file`                      | `-m`  | string  | —                                               | JSON `{address: name}` overriding ReGa names (2.5's `--json-name-table`), `file: {…}` for she |
| `--hm-payload`                     |       | boolean | true                                            | `hm` block in status payloads (H-2)                                                           |
| `--plain-tree`                     |       | string  | —                                               | e.g. `state` (H-4)                                                                            |
| `--publish-cache`                  |       | boolean | false                                           | H-11                                                                                          |
| `--publish-counters`               |       | boolean | true                                            | H-14                                                                                          |
| `--duty-cycle-interval`            |       | number  | 90                                              | seconds; 0 = off                                                                              |
| `--rpc-topics`                     |       | boolean | false                                           | H-13                                                                                          |
| `--state-dir`                      |       | string  | `$STATE_DIRECTORY` or `~/.hm2mqtt`              | H-8                                                                                           |

Dropped from 2.5: `--insecure` (→ `--ccu-insecure` for the CCU; broker CA via `--mqtt-tls-ca`),
`--mqtt-retain` (retain rules are the convention's), `--disable-rega` (→ `--no-rega`),
`--publish-metadata`, `--hmip-reconnect-interval` (folded into the per-interface ping timeout).

---

## 6. Prerequisites — sibling libs and the core

### 6.1 mqtt-interfaces-core 0.7.0 — done 2026-08-27 (tag `v0.7.0`)

- **G-4 — extra fields in a status payload.** `pubStatus(item, val, {retain, extra})` merges
  `extra` into the JSON payload (`{val, ts, lc, ...extra}`), ignored with `--no-json-payloads`;
  `StatusTracker` keeps `extra` so `republishStatus()` re-publishes it. Change detection stays on
  `val` only. Unit test: publish with `extra`, reconnect, assert the re-publish carries it.
- **G-5 — device-side timestamps.** `pubStatus(item, val, {ts, lc})` overrides the tracker's
  clock for values that carry their own timestamp (sysvars, `getValues` cache; also useful for
  cul2mqtt's learned intervals). Default unchanged.
- **G-6 — subscriptions outside `<name>/set/#`.** `createAdapter({subscriptions: {'paramset/#':
handler, 'rpc/+/+/+': handler}})` subscribes `<name>/<pattern>` on every (re)connect and routes
  matching messages to the handler `(parts, value, topic, raw)` with the same error handling as
  `onSet`; today such topics hit `log.warn('mqtt ignoring unexpected topic')` on every message.
  (The `set/rega/sync` command needs nothing: it is a normal `onSet` branch.)
- Nice-to-have, not blocking: `info` refresh — `publishInfo()` is already public; the adapter calls
  it when the device count changes.

### 6.2 homematic-rega 2.0 — done 2026-08-27 (tag `v2.0.0`)

Used by node-red-contrib-ccu 3.4 (1.5.2, 2022): depends on `request` (deprecated), callbacks,
CJS. 2.0: ESM + promise API, `fetch` (Node ≥ 20), keep ISO-8859-1 decoding (`iconv-lite`), TLS
(`https`, port 48181) and basic auth, the script set (`getChannels`, `getRooms`, `getFunctions`,
`getValues`, `getVariables`, `getPrograms`, `exec` with `objects`), timeouts. Timestamps are
returned as strings in CCU local time — convert them to epoch ms _in the lib_ (node-red did
`new Date(ts + ' UTC+' + offset)` at every call site). Published to npm before hm2mqtt 3.0 is
tagged; `file:../homematic-rega` while developing (`deploy.sh` ships `file:` deps).
_Result_: 2.0.0 has zero runtime dependencies (Node's `latin1` replaces iconv-lite, a small parser
replaces xml2js, `http`/`https` replace request), `timeZone`/`timeout`/`webPort` options, `ts` in
ms (`0` = never), exported `parseResponse`/`parseTimestamp`/`unescapeLatin1`, 12 unit tests
against a mock `rega.exe`.

### 6.3 homematic-xmlrpc 2.0 — done 2026-08-27 (tag `v2.0.0`)

1.0.2 (2022) depends on `xmlbuilder` **as a GitHub tarball** (`hobbyquaker/xmlbuilder-js` commit)
— fragile for `npm ci` and provenance builds. Minimum: pin a published `xmlbuilder`/`xmlbuilder2`
release or inline the tiny part that was patched; expose `server.close()` and an `error` event so
the adapter does not reach into `httpServer` (node-red's TODO). ESM is optional — CJS imports fine.
_Result_: 2.0.0 replaces xmlbuilder with a built-in writer (`lib/xmlbuilder.js`, expanded empty
elements as the CCU needs them — the reason for the fork), `sax ^1.4`, Node ≥ 20, server `error`

- `listening` events, promise-returning `close()`; the vows suite (171 tests) is green again and
  runs in CI.

### 6.4 binrpc 3.3.1

Works as is (CJS, `binary` + `put`). Same TODO as above (`close()`, `error` event on the server
object). A 4.0 without `binary`/`put` (both unmaintained) is a separate, later job.

### 6.5 hm-simulator

0.1.1 simulates rfd (binrpc 2001) and hmipserver (xmlrpc 2010): `init`, `ping`,
`system.listMethods`, `getParamsetDescription`, outgoing `listDevices`/`newDevices`/`event`/
`system.multicall`. Enough for the e2e test of the RPC layer (§8); add `putParamset`/`setValue`
echo and a fake ReGa (`/rega.exe` answering the six scripts from fixtures) if the ReGa layer is to
be covered end-to-end — otherwise ReGa stays unit-tested with recorded responses.

---

## 7. Implementation steps — done 2026-08-27 (commits on master, `3.0.0-dev.0`)

Skeleton per the core README §2 (copy from cul2mqtt): `index.js`, `config.js`, `lib/`,
`test/*.test.js`, `Dockerfile`, `deploy.sh`, eslint/prettier, CI + release workflows, `AGENTS.md`.
`package.json`: `"type": "module"`, `files` incl. `paramsets.json` seed and `example-names.json`,
`mqttInterfaces: {spec: '2.0', envPrefix: 'HM2MQTT', needs: ['network'], serviceExtra: []}`.

1. ~~**Core 0.7.0** (G-4, G-5, G-6) with tests, published. **homematic-rega 2.0** published.
   homematic-xmlrpc dependency fix published.~~ — done 2026-08-27 (§6).
2. **`lib/interfaces.js`** — the interface table (H-6/H-7: names, ports local/remote/TLS,
   protocol, path, init/ping flags, ping timeout) as data; `probeInterfaces(host)` for
   `--interfaces auto`.
3. **`lib/rpc.js`** — one `RpcConnection` per interface: client (binrpc/xmlrpc, TLS, auth),
   shared callback servers per protocol, `init`/de-init, init id `hm2mqtt_<name>_<iface>`
   (iface parsed back from it), `rpcCheckInit` (ping/re-init timers, `lastEvent`), incoming
   methods (`system.listMethods`, `system.multicall`, `event`, `listDevices`, `newDevices`,
   `deleteDevices`, `updateDevice`, `replaceDevice`, `readdedDevice`, `setReadyConfig`),
   `methodCall()` with the deferred queue while a client is missing, tx/rx counters, `emit`s
   `event`, `devices`, `connected`. No MQTT, no naming — testable with a fake server.
4. **`lib/metadata.js`** — device table + paramset descriptions: persistence in the state dir
   (H-8), seed loading, `paramsetName()` key, the throttled `getParamsetDescription` queue
   (200 ms), `listDevicesAnswer()` per interface incl. the HmIP-RCV-50 / empty-string
   workarounds, `findIface(address)`.
5. **`lib/rega.js`** — names/rooms/functions/groups, sysvars/programs with change detection
   (`updateRegaVariable` semantics: `ts`-based, `valuePrevious`, `lc`), `getValues` cache
   (RSSI `-256`, `uncertain`), `setVariable`/`programActive`/`programExecute`, poll loop with
   `pending` guard, `--rega-poll-trigger`, deferral of `setVariable` until variables are known.
6. **`lib/message.js`** — pure: `createMessage()` port (§1.4 fields, `change`, `lc`,
   `valueStable`, `working`/`direction` derivation, wait-for-working rule), sysvar/program
   messages, `_NOTWORKING` derivation. This is where the payload compatibility is unit-tested
   against fixtures recorded from the flow (§8).
7. **`lib/topics.js`** — pure: item names from messages (H-3 sanitising, reserved levels),
   resolution of `set`/`paramset` topics to `{iface, address, datapoint}` or `{sysvar}` /
   `{program}` (name → address via the ReGa table, channel-only for `set`, devices allowed for
   `paramset`, `/` in names), `rpc` topic parsing.
8. **`lib/cast.js`** — pure: `paramCast()` + writeable check (H-12), `castSysvar()`.
9. **`index.js`** — `createAdapter()` wiring: `info`, `onSet` (datapoints, sysvars, programs,
   `rega/sync`), `subscriptions` (`paramset/#`, `rpc/…` when enabled), `pubStatus` with `extra:
{hm}` / `ts` / `retain` per H-2/H-9, plain mirror (H-4), counters + duty cycle timers (H-14),
   `setDeviceConnected()` from the interface states (H-5), `onShutdown` → de-init all interfaces,
   close servers, save state; `onMqttConnect` → nothing special (core re-publishes retained items).
10. **`lib/install.js`**, `Dockerfile` (`VOLUME /data`, `HM2MQTT_STATE_DIR=/data`, host network or
    `--init-address`), README (options, topics with payload examples, both migration tables, CCU
    firewall note, she), CHANGELOG `3.0.0`.

---

## 8. Tests — unit and simulator e2e done 2026-08-27

- **Unit** (`node --test`): `message` (fixtures = real messages captured from the flow: subscribe
  `hm/status/#` on the live broker, save a few hundred payloads as `test/fixtures/flow-*.json`,
  assert 3.0 produces identical `val`/`hm` fields for the same RPC input), `topics` (names with
  `/`, spaces, umlauts, reserved levels, set resolution), `cast` (every TYPE, enum names, unknown
  description), `metadata` (paramset keys, queue, persistence round trip), `rega` (parsing of
  recorded script output, change detection, timestamps), `rpc` against an in-process fake
  server (init/ping/re-init timing with fake timers, multicall unpacking, counters), `config`
  (env, schema, secrets), installer via `deps` hooks.
- **e2e** (`npm run test:e2e`, not in CI by default): hm-simulator + a local mosquitto, the 2.5
  scenario (`BidCoS-RF:1 PRESS_SHORT` appears on `hm/status/BidCoS-RF:1/PRESS_SHORT`, a
  `set` reaches the simulator) written against MQTT instead of log-line regexes.
- **Parallel run against the real CCU** (§9) is the acceptance test for the drop-in claim.

---

## 9. Cutover — open (needs a host in the CCU's LAN, see §12)

1. Install on the home server as `hm2mqtt@hm3` with `--name hm3` while the flow keeps running
   (two clients on the CCU are fine — different callback URLs/init ids). Firewall: CCU → host
   2126/2127.
2. Run `scripts/compare-trees.js` for a day: subscribes `hm/#` and `hm3/#`, reports items missing
   on either side and payload differences (`val`, and every `hm.*` field). Expected diffs: none
   in `val`/`hm.*`, `ts` jitter, `connected` semantics (H-5), counters (`{val}` vs plain).
3. Verify: `set` on a switch/dimmer/blind/thermostat and a sysvar/program from she; `paramset` on
   a thermostat MASTER; `maintenance/set/restart` comes back; CCU reboot → interfaces re-init and
   `connected` 1 → 2; she Services page shows the instance with a sensible config form.
4. Switch: disable the two `ccu-mqtt` nodes and the duty-cycle inject in Node-RED (keep the tab
   for a while), `--uninstall --name hm3`, `--install --name hm` (`--plain-tree state` only if
   OQ-43 says so). Clear retained leftovers that 3.0 does not produce (`hm/status//…` from unnamed
   channels, `hm/state/#` once unused) with `mosquitto_sub`/`mosquitto_pub -r -n`.
5. Tag `v3.0.0` (release workflow), README/CHANGELOG, master roadmap inventory line.

---

## 10. After 3.0

- **3.1 — Home Assistant discovery** (H-15, D-5): design in §13 (research of matterbridge-homematic,
  CCU-Jack and openccu-loom, 2026-08-27).
- **`--discover` / `--ccu-address auto`** with `hm-discover` (UDP broadcast, B-2 in the core).
- **CUxD** end-to-end (binrpc 8701, no ping) and **LINK paramsets** (`paramset/<ch>/<peer>`
  with `activateLinkParamset`).
- **Read paramsets**: `<name>/set/paramset/get/<ch>/<paramset>` → `<name>/status/paramset/<ch>/<paramset>`
  (replaces 2.5's `db/extend` metadata publish, OQ-52).
- **Drop `--plain-tree`** once nothing consumes `hm/state` (OQ-43) — a 4.0 break. The `hm`
  block is not trimmed: its fields are consumed (OQ-46, 2026-08-27).
- binrpc 4.0 / homematic-xmlrpc 2.0 without `binary`/`put`/`sax 0.4`.

---

## 11. Open questions

| ID    | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Proposal                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| OQ-43 | Does anything consume the plain mirror tree `hm/state/…`? (she scripts use `hm//…` = `status`.) `mosquitto_sub -v -t 'hm/state/#'` shows what is retained, not who reads it — check she scripts and any other subscriber (`$SYS`/broker logs).                                                                                                                                                                                                                                                                                                                                                                 | Ship `--plain-tree` (H-4), enable it only if a reader is found, remove in 4.0.                         |
| OQ-44 | Run on the home server (H-7) or on the CCU3/RaspberryMatic (as the flow does)? Node ≥ 20 on the CCU3's armv7 RedMatic runtime is not available; RaspberryMatic could run the Docker image but the fleet's systemd/she management would not apply.                                                                                                                                                                                                                                                                                                                                                              | Home server.                                                                                           |
| OQ-45 | ReGa polling: the flow has it off (30 s configured). Deliberate (CCU load while Node-RED ran on the CCU itself) or forgotten? Do other Node-RED tabs use `ccu-poll`/`ccu-sysvar` and expect sysvar topics to update?                                                                                                                                                                                                                                                                                                                                                                                           | Default 30 s from the home server (H-10); publishes only on change.                                    |
| OQ-46 | Which `hm.*` fields are actually read (she `getProp(topic, 'hm', …)`, dashboards)? Decides whether the full block must stay the default (H-2) or `{val, ts, lc}` suffices later.                                                                                                                                                                                                                                                                                                                                                                                                                               | Keep the full block for 3.0; grep she scripts before 4.0.                                              |
| OQ-47 | Is Home Assistant in use at all? Decides the priority of 3.1 (§10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Build 3.1 only when needed; the fleet convention is satisfied by the option being present.             |
| OQ-48 | Item names with upper-case datapoints and free-form channel names (spaces, umlauts, `/`) deviate from the fleet's snake_case rule (core README §6). Needs a note in the umbrella spec ("items are the source system's identifiers when that system has stable, user-visible names").                                                                                                                                                                                                                                                                                                                           | Accept; add the spec note with 3.0.                                                                    |
| OQ-49 | Non-`PRESS_` `ACTION` datapoints non-retained (H-9) — any consumer relying on a retained ACTION value?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Union rule (H-9); the compare run (§9) shows the affected topics.                                      |
| OQ-50 | Is a Mosquitto ACL/dynsec role bound to the client id `homematic-ccu3`?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Create a dynsec identity for `hm` via she instead; `--mqtt-client-id-prefix` as the fallback (H-17).   |
| OQ-51 | 2.5 published `hm.UNIT`; node-red-contrib-ccu's message has no unit. Add `datapointUnit` (from the description, `°C` decoding as in 2.5) to the `hm` block?                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Yes — additive, harmless; also needed for HA discovery (3.1).                                          |
| OQ-52 | Replacement for 2.5's `db/extend/<name>/<address>` metadata publish (`--publish-metadata`)? Nothing in the fleet consumes `db/extend` any more.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Drop; `paramset/get` in 3.x (§10) covers the remaining use.                                            |
| OQ-53 | HA discovery default for hm2mqtt: on (D-5) with most layer-1 entities disabled by default, or off (`--ha-discovery` opt-in) because ~775 channels yield thousands of entities?                                                                                                                                                                                                                                                                                                                                                                                                                                 | On, per D-5; the enabled-by-default rules of H-22 keep HA usable; revisit after the first real HA run. |
| OQ-54 | **Item templates** like node-red-contrib-ccu's `${…}` topic templates (user wish, 2026-08-27): `--item-template` (default `${channelName\|channel}/${datapoint}`), `--sysvar-item-template`, `--program-item-template` with every `hm` field as placeholder and a `\|` fallback chain; prefixes `status/`/`set/` stay the convention's. `set` becomes a reverse lookup over an item → (address, datapoint) map built from the known channels and VALUES descriptions, collisions warned once; HA discovery (§13) derives its topics from the same function. Needs no config file (D-7). Before or after 3.0.0? | Before 3.0.0 (default unchanged, but the `set` path changes shape); ~half a day.                       |

---

## 12. Implementation log — 2026-08-27

What was built, in order, and what the live runs taught:

- Prerequisites first: mqtt-interfaces-core 0.7.0 (G-4/G-5/G-6), homematic-rega 2.0.0 (ESM,
  promises, zero deps, `timeZone`), homematic-xmlrpc 2.0.0 (built-in XML writer, `sax ^1.4`,
  server `error`/`listening`, promise `close()`); all three on npm via the release workflows.
- hm2mqtt 3.0.0-dev: `lib/interfaces.js`, `lib/rpc.js` (RpcServers + RpcConnection),
  `lib/metadata.js` (seeded from node-red-contrib-ccu's `paramsets.json`, 2222 keys),
  `lib/values.js` (createMessage port, wait-for-WORKING, `_NOTWORKING`, cache), `lib/rega.js`,
  `lib/cast.js`, `lib/topics.js`, `lib/compare.js` + `scripts/compare-trees.js` (§9 tool),
  `index.js`; README with both migration tables, CHANGELOG, AGENTS.md, Dockerfile, deploy.sh,
  CI (lint/test on 20/22/24 + e2e job with mosquitto), release workflow.
- Tests: 41 unit tests (fakes for RPC libs, timers, ReGa), e2e (`npm run test:e2e`) with
  hm-simulator in-process (rfd binrpc, hmip xmlrpc, ReGa mock) and a spawned mosquitto:
  init → newDevices → descriptions → `connected 2`, events with the full `hm` block, `PRESS_*`
  not retained, plain tree, `set` by name and by address, variables/programs incl. enum-name set
  and re-poll, `--rpc-topics`, warn-not-crash, SIGTERM → unsubscribe + state files.
- Live against the CCU3 (3.87.6) from the development Mac: ReGa (886 channels, 3285 values,
  umlauts), `listDevices` on all four interfaces (BidCos-RF 270, BidCos-Wired 104, HmIP-RF 457,
  VirtualDevices 52), `getVersion`, `listBidcosInterfaces`, TLS+auth on the 4xxxx ports.
  **The callback path could not be tested from here**: the CCU (172.16.24.0/24) has no route to
  the Mac (192.168.8.x behind WireGuard; ICMP to the VPN address works, TCP does not). rfd's
  `init` therefore blocks (it calls `listDevices` on us before answering) — now a 30 s timeout +
  retry; HmIP-RF/VirtualDevices answer `init` first and call back later, so they report
  connected without events arriving. The event path is verified with the simulator; the real
  run needs hm2mqtt on the home server (H-7) — `deploy.sh` is ready for that.
- Other findings: after a CCU reboot the HmIPServer answered `503` through the lighttpd proxy
  for several minutes (init retries cover it); the CCU's own lighttpd proxy front-ends the
  XML-RPC ports and handles TLS/auth, binrpc is not reachable remotely (so `--bidcos-binrpc`
  is for CCU2/Homegear only); the auth is not enforced on this CCU (plain works); 5 duplicate
  channel names exist (`Wetterstation`, `Tür Garage`, …) and are logged at start (they share a
  topic, exactly as with the flow).
- Answers received: OQ-43 keep `--plain-tree` opt-in; OQ-45 poll every 30 s (H-10); OQ-44
  home server (confirmed by the network layout); OQ-46 **consumers read `hm.channel`/
  `channelName`/`device`, `valueEnum`/`datapointEnum`/`datapointUnit`, `working`/`direction`/
  `stable` and `rooms`/`functions` — the whole `hm` block is API, H-2 stays the default for
  good, no trimming in 4.0**; OQ-49 non-`PRESS_` ACTION datapoints unretained is fine (H-9
  stands); OQ-50 no broker ACL on the client id (core scheme `hm_<random>`); OQ-47 Home
  Assistant is not a priority (3.1 stays on the list). Still open: OQ-48 (spec note), OQ-52.
- The parallel run and cutover (§9) are done by the user on the home server.
- **Live on the home server (mqtt-ifaces, 2026-08-27 17:30, after the CCU firewall was opened):**
  all four interfaces subscribed, 270/104/457/52 devices announced, 537 missing HmIP descriptions
  fetched, events flowing (542 batches from HmIP-RF in 150 s). `hm3/set/Licht Kellertreppe/STATE`
  true/false → `setValue` → event back on `hm3` **and** on the flow's `hm` after ~470 ms each;
  payloads field-for-field identical except `hm.ccu` (`localhost` on the flow, which ran on the
  CCU, vs. the configured `--ccu-address`). First-start events that arrive before `newDevices`
  lacked device/datapoint fields → now held until the devices are known. Test checkout left at
  `~/hm2mqtt-test` on the host (state dir `state/`, `run*.log`, `compare*.txt`); retained `hm3/#`
  test topics cleared afterwards.
- **Parallel run started 2026-08-27 ~18:00**: `deploy.sh mqtt-ifaces` + `sudo hm2mqtt --install -n hm3
-a homematic-ccu3 -u mqtt://mqtt.lan.raff.rocks` → `hm2mqtt@hm3.service` (state
  `/var/lib/hm2mqtt/hm3/`, config `/etc/hm2mqtt/hm3.env`). Node-RED keeps `hm/…` untouched. Next:
  `node ~/hm2mqtt-test/scripts/compare-trees.js mqtt://mqtt.lan.raff.rocks hm hm3 3600` after a day;
  the installer froze the option defaults into the env file (fine, but `--state-dir` had to lose
  its `~/.hm2mqtt` default for that reason — resolved at runtime now).
- Next: `npm run deploy <home-server>` (or `npm install -g` there), `--install -n hm3` for the
  parallel run, `scripts/compare-trees.js mqtts://… hm hm3 3600 --ca …`, then the cutover of §9.

---

## 13. Home Assistant discovery — research and design (2026-08-27)

Three projects were read for how they turn Homematic channels/datapoints into semantic devices:

| project                                                                                             | how it maps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | what to take                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **matterbridge-homematic** (hobbyquaker, TS, 1.0.4) — CCU → Matter                                  | 17 handlers keyed by **channel TYPE** (`SWITCH`, `DIMMER`, `BLIND`, `SHUTTER_CONTACT`, `KEY`, `KEYMATIC`, `SMOKE_DETECTOR`, thermostats …) plus 14 **device-model** overrides; HmIP `*_VIRTUAL_RECEIVER` channels are re-typed to the classic type before mapping (first receiver after the TRANSMITTER wins, the other two dropped); paramset descriptions are only used to detect `LOWBAT`. One Matter endpoint per channel, no per-device composition, rooms unused, unknown types skipped.                                                                                                                                                                                                                 | virtual-receiver pre-resolution; WORKING/DIRECTION/ACTIVITY_STATE suppression of intermediate LEVELs; battery from `LOWBAT`/`OPERATING_VOLTAGE` with per-model voltage ranges; `LEVEL 1.005` = "restore last level" for dimmer on; `STATE` inversion of contacts; `CONTROL_MODE 1 + 4.5 °C` = off for thermostats; name heuristics light vs. plug (`licht                                         | lampe`/`steckdose | plug`). |
| **CCU-Jack** (mdzio, Go, 2.13) — CCU → REST/MQTT                                                    | **No HA discovery at all** (issues #7/#121: "depends on the channel type … too much effort"). Topics are addresses (`device/status/<serial>/<ch>/<param>`), payload `{v, ts, s}`, retain except `PRESS_*`/`INSTALL_TEST`. It exposes the raw `type`/`control`/`unit`/`valueList` of every parameter via REST and leaves classification to consumers; the community script (kaistraube/ccujack_homeassistant) maps by a hand-written **device-model → channel-no → parameter** JSON for 8 models.                                                                                                                                                                                                               | the retain rule by datapoint name; descriptions fetched once with 50 ms spacing and cached, `MASTER` lazily, `LINK`/`SERVICE` never (battery devices do not answer); `UNREACH` availability template `payload_not_available: true`; diagnostics (`RSSI_*`, `DUTY_CYCLE`, `CONFIG_PENDING`) as `entity_category: diagnostic`, disabled by default. Model tables are the least maintainable option. |
| **openccu-loom** (SukramJ = Homematic(IP) Local author, Go, 0.65, beta) — CCU → MQTT/HA/REST/Matter | Three layers: **generic** data points from the paramset description (`TYPE`/`OPERATIONS`/`VALUE_LIST` → sensor/binary_sensor/switch/select/number/text/button — complete, cheap), **custom** composite entities (light/cover/climate/lock/siren/valve/event) from **158 hand-curated device-model profiles** (exact, then longest prefix), **calculated** ones (dew point, battery % from a 75-model voltage table, derived binaries). HA `device_class`/unit/category from ported aiohomematic tables keyed by (model prefix, parameter). One HA device per physical device, `via_device` = central, rooms → `suggested_area` only when exactly one room, availability = bridge + `UNREACH` + per-value flag. | the layer split and the generic resolver; ~20 hard-won HA lessons in its ADRs/changelog (below). Its profile list is the most complete mapping that exists but is code, not data, and tied to the aiohomematic lineage.                                                                                                                                                                           |

None of the three uses the one thing hm2mqtt already has for every channel: the **`CONTROL` hint of
the paramset description**, eQ-3's own role string per parameter. Checked against this CCU's
~775 channels it covers the primary datapoint of every actuator/sensor type in use and is stable
across HM and HmIP generations: `SWITCH.STATE` (SWITCH, SWITCH_VIRTUAL_RECEIVER),
`SWITCH_TRANSMITTER.STATE`, `DIMMER.LEVEL` (DIMMER, VIRTUAL_DIMMER, DIMMER_VIRTUAL_RECEIVER),
`DIMMER_REAL.LEVEL`, `BLIND.LEVEL`, `BLIND_TRANSMITTER.LEVEL`, `BLIND_VIRTUAL_RECEIVER.LEVEL`,
`DOOR_SENSOR.STATE` (SHUTTER_CONTACT, MULTI_MODE_INPUT_TRANSMITTER), `RHS.STATE`, `BUTTON.SHORT`
/ `BUTTON_NO_FUNCTION.SHORT` (KEY, VIRTUAL_KEY, KEY_TRANSCEIVER), `HEATING_CONTROL.SETPOINT` (HM)
/ `HEATING_CONTROL_HMIP.SETPOINT` (HmIP), `LOCK.STATE` (KEYMATIC), `DANGER.STATE` (SMOKE_DETECTOR),
`POWERMETER.POWER` / `POWERMETER_PSM.POWER`, `WEATHER_TRANSMIT.*`, `MOTIONDETECTOR_TRANSCEIVER.MOTION_DETECTION_STATE`.
Gaps: `MOTION_DETECTOR.MOTION` (HM, no CONTROL), `WEATHER.*` (HM-WDS100), `MAINTENANCE.*` — a
handful of datapoint-name rules covers those.

### Decisions

| ID   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-21 | **Mapping key = `CONTROL` hint of the paramset description, channel TYPE as fallback, device model only as override.** A small table `CONTROL prefix → role` (`SWITCH`, `DIMMER`, `BLIND`, `DOOR_SENSOR`, `RHS`, `BUTTON`, `HEATING_CONTROL`, `HEATING_CONTROL_HMIP`, `LOCK`, `DANGER`, `POWERMETER`, `WEATHER_TRANSMIT`, `MOTIONDETECTOR_TRANSCEIVER`) plus name rules for the HM gaps (`MOTION`, `BRIGHTNESS`, `WEATHER.*`, `MAINTENANCE.*`). No hand-curated per-model profile list (loom's 158) — the descriptions describe the device.                                                                                                                                                                                                                                                                                |
| H-22 | **Two layers like loom, no more.** Layer 1 (generic, complete): every VALUES parameter → `sensor` / `binary_sensor` / `switch` (BOOL R/W) / `select` (ENUM R/W, writes the index) / `number` (FLOAT/INTEGER R/W) / `text` / `button` (write-only ACTION) from `TYPE`/`OPERATIONS`/`VALUE_LIST`/`UNIT`; `device_class`/`unit`/`state_class`/`entity_category` from a parameter-name table (aiohomematic's, as loom ported it). Layer 2 (composite, from H-21 roles): `light` (dimmer), `cover` (blind/shutter, `LEVEL_2` tilt when present), `climate` (thermostats), `lock`, `event` (keys), `switch` (SWITCH.STATE — layer 1 already yields it). Parameters consumed by a layer-2 entity are not repeated as layer-1 entities. Layer-1 entities of actuator channels and all diagnostics are `enabled_by_default: false`. |
| H-23 | **Discovery uses the existing topics only.** State = `<name>/status/<channel>/<DP>` with `value_json.val` templates, command = `<name>/set/<channel>/<DP>` with `command_template`. Two small additions to the `set` path make HA's single-topic conventions work without breaking the topic API: `set/<ch>/LEVEL` accepts `OPEN`/`CLOSE`/`STOP` (→ LEVEL 1 / 0 / `STOP true`) and `ON`/`OFF` for dimmers (→ `LEVEL 1.005` restore-last / `0`); and keys get an aggregate event item `<name>/status/<ch>/PRESS` (`{val: "PRESS_SHORT"}`, not retained) so one HA `event` entity per key channel carries all press types. Both are additive items.                                                                                                                                                                          |
| H-24 | **One HA device per Homematic device**, `id = hm2mqtt_<instance>_<deviceAddress>`, `name` = ReGa device name, `mdl` = device TYPE, `mf` = eQ-3, `via_device` = the bridge device (the CCU: `hm2mqtt_<instance>`), `suggested_area` = the room when the device's channels sit in exactly one room. Entity names = channel name minus the device-name prefix, `uniq_id = hm2mqtt_<instance>_<channelAddress>_<DP>` — **pinned before 3.1 ships** (changing them orphans every entity). Availability per device = bridge `<name>/connected` (≥2) **and** `<name>/status/<device>:0/UNREACH` (`offline` when true; devices without UNREACH: bridge only), `avty_mode: all` (core G-2).                                                                                                                                         |
| H-25 | **HmIP virtual receivers**: the first `*_VIRTUAL_RECEIVER` after a `*_TRANSMITTER` is the control entity; receivers 2/3 exist but disabled by default; state templates read the TRANSMITTER channel (`SWITCH_TRANSMITTER.STATE`, `DIMMER_TRANSMITTER.LEVEL`, `BLIND_TRANSMITTER.LEVEL`) where one exists (loom's `use_group_channel_for_cover_state`). `WORKING`/`DIRECTION`/`ACTIVITY_STATE` feed cover `opening`/`closing` via `ACTIVITY_STATE`/`DIRECTION` templates; dimmers use `LEVEL_NOTWORKING` as state topic so sliders do not jump (the item exists for exactly this).                                                                                                                                                                                                                                          |
| H-26 | **Climate**: `current_temperature_topic` ACTUAL_TEMPERATURE, `temperature_command_topic` SET_POINT_TEMPERATURE / SET_TEMPERATURE, `mode_state` from `SET_POINT_MODE` (HmIP: 0 auto, 1 heat, 2 auto+away) / `CONTROL_MODE` (HM enum AUTO/MANU/PARTY/BOOST), `mode_command` via `command_template` on CONTROL_MODE (HM) / `SET_POINT_MODE` (HmIP), off = setpoint 4.5 °C (both matterbridge and loom do it that way), presets `boost` (BOOST_MODE) and, HM only, `comfort`/`eco`; `action` heating when `LEVEL > 0` (HmIP) / `VALVE_STATE > 0` (HM). Per-parameter topics, never an aggregated JSON state (loom ADR 0011).                                                                                                                                                                                                   |
| H-27 | **Out of scope for 3.1**: RGBW/colour lights, sirens, garage doors (MOD-HO), door-lock pro (DLD), calculated values (dew point, battery % from voltage tables — `LOW_BAT` binary_sensor and `OPERATING_VOLTAGE` sensor are enough), sysvars/programs as HA entities (a follow-up: `switch`/`sensor`/`button` per variable/program is cheap once the device layer exists), sub-devices.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### HA lessons collected (loom changelog/ADRs, matterbridge, CCU-Jack script)

- Pin `uniq_id`/device identifiers before the first release; scope them by instance name.
- Never make availability depend on a parameter that might be hidden/disabled (`UNREACH`).
- Per-parameter state topics with templates, no aggregated JSON — empty Jinja results otherwise.
- `event` entities: no `value_template`; siren: no `available` in the state JSON; `object_id` is gone in HA 2026.3 → `default_entity_id`.
- Selects write the ENUM **index**, labels only for display (`options` = `VALUE_LIST`).
- Cache and diff discovery payloads; re-announce only on change (the core already does `discoveryDirty`).
- Diagnostics (`RSSI_*`, `DUTY_CYCLE`, `CONFIG_PENDING`, `OPERATING_VOLTAGE`, `SABOTAGE`) exist but disabled by default; `LOW_BAT` → `battery` binary_sensor enabled.
- Contacts: `STATE true` = open (`DOOR_SENSOR.STATE`), rotary handle `0 closed / 1 tilted / 2 open` → `window` binary_sensor open when ≠ 0.
- Units to repair from the descriptions: `100%` → `%` (×100), `% rF` → `%`, `Lux` → `lx`, `°C` (latin1 byte), `""` → none.
- Volume: this CCU has ~775 channels → thousands of layer-1 entities. Discovery on by default (D-5) is only bearable with the enabled-by-default rules of H-22; a `--ha-discovery` off default for hm2mqtt is the alternative — **OQ-53**.

### Implementation sketch (3.1)

1. `lib/roles.js` — pure: `(channelType, description) → role table` from `CONTROL` + name rules; unit repair; parameter-name → HA description table (`device_class`, `unit`, `state_class`, `entity_category`, `enabled`).
2. `lib/hadiscovery.js` — pure: `(devices, channelNames, rooms, descriptions, values) → [device blocks]` per H-22…H-26 using the core's `entity()`/`devicePayload()`; tests with the paramset seed and the real device table (`devices.json`) as fixtures — every channel type on this CCU must produce the expected components.
3. `index.js`: `discovery()` returns the blocks, `discoveryTriggers` = devices/names changes (already re-published on `newDevices`), the `set` extensions of H-23 (`OPEN/CLOSE/STOP`, `ON/OFF`, `PRESS` aggregate).
4. Validate against a real HA (docker `homeassistant/home-assistant` with the MQTT integration) — the fleet's open B-8 item; check entity counts, availability, climate modes, cover position/tilt, event entities.
5. `--ha-discovery` default decision (OQ-53) and README section.

---

## 14. Backlog from the CCU-Jack / openccu-loom research (2026-08-27)

Candidates, with effort and a suggested slot; prune as you like.

| ID  | Item                                                                                                                                                                                                                                                                                     | Effort | Slot         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------ |
| B-1 | **Description fetching like CCU-Jack**: `VALUES` eagerly, `MASTER` lazily on first `paramset` use, `LINK`/`SERVICE` never (battery devices do not answer — the source of our `getParamsetDescription` timeouts), 50 ms spacing instead of 200 ms. 537 HmIP descriptions: ~2 min → ~20 s. | 0.5 h  | 3.0.0        |
| B-2 | **Retained-topic cleaner for the cutover** (loom keeps a one-shot topic migrator): `scripts/clean-retained.js <url> <pattern>…` — the flow left 2291 nameless `hm/status//X` topics and years of stale items. Needed by §9.                                                              | 1 h    | 3.0.0        |
| B-3 | **Periodic name re-sync**: `--rega-names-interval 3600` (`getChannels` costs 250 ms) so renames, rooms and functions propagate without a restart; `set/rega/sync` stays for immediate.                                                                                                   | 0.5 h  | 3.0.0        |
| B-4 | **Datapoint ignore filter**: `--ignore '*.*.RSSI_*,HmIP-RF.*.*_STATUS'` (globs on `iface.channel.datapoint`) — a light version of loom's visibility model; cuts HmIP chatter and the HA entity flood (§13, OQ-53).                                                                       | 1 h    | 3.0.x        |
| B-5 | **`get` topics** (CCU-Jack's REST read, over MQTT): `<name>/get/<channel>/<datapoint>` → `getValue` → republish; `<name>/get/<channel>/<paramset>` → `getParamset` → `<name>/status/paramset/<channel>/<paramset>` (resolves OQ-52; MASTER settings, datapoints the CCU never pushes).   | 2 h    | 3.1          |
| B-6 | **Calculated items** (loom): dew point/enthalpy from temperature+humidity, battery % from per-model voltage tables (port loom's 75-entry `voltage_data`), derived binaries (`WINDOW_OPEN` from `RHS.STATE`, `SMOKE_ALARM` from the HmIP alarm enum). Opt-in `--calculated`.              | 0.5 d  | 3.2          |
| B-7 | **Sysvar publish filter** (`--sysvar-filter` regex; CCU-Jack: description contains "mqtt", loom: `HAHM`/`HX` markers). Ten variables today — only when the list grows noisy.                                                                                                             | 0.5 h  | when needed  |
| B-8 | **`<device>/online` item** from `UNREACH` with `STICKY_UNREACH` fallback (cul2mqtt's `online` pattern) so consumers get one boolean instead of inverting `UNREACH`. New item → additive, but decide deliberately.                                                                        | 1 h    | 3.1 with §13 |

Deliberately **not** taken over: CCU-Jack's virtual devices (foreign MQTT devices as CCU devices via the
VirtualDevices interface), loom's REST/WebSocket/MCP/web UI (she manages, MQTT is the API), multi-CCU
in one process (fleet pattern: one instance per CCU, `hm2mqtt@ccu2`), running on the CCU itself
(OQ-44).
