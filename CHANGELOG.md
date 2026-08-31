# Changelog

## Unreleased

### Fixed

- **Addon: the service did not start** — `Error: ENOENT ... mkdir '/root/.hm2mqtt'`. hm2mqtt's state
  directory falls back to `$HOME/.hm2mqtt`, and on a CCU that is `/root` on a read-only rootfs. The
  addon now writes inside `/usr/local/addons/hm2mqtt` and nowhere else: `HM2MQTT_STATE_DIR` ships
  preconfigured in the addon's config, and the service script pins it, `HOME` and the XDG
  directories before starting - which also repairs installations whose config predates this.
- The state directory and the two callback addresses are no longer offered in the addon UI: on the
  CCU they are fixed (the interface processes call back over loopback), and an option a user can set
  but the addon overrides is worse than no option.
- Outside the addon too: a state directory that cannot be created now reports the path and what to
  set instead of an ENOENT stack trace - a read-only container filesystem hits the same thing.

## 3.4.1

### Fixed

- **Addon UI: "invalid session" on every action** (reported by @sikousikou on an OpenCCU x86_64 VM).
  The page itself opened, but saving the configuration or starting the service answered
  `{"error":"invalid session"}`: the UI builds its requests with `URLSearchParams`, which
  percent-encodes the `@` of a CCU session id (`@1234567890@` → `%401234567890%40`), and the CGIs
  never decoded the query string, so the session check never matched. Query parameters are decoded
  now.
- The decoder itself is written out instead of the usual tcl `regsub`+`subst` one-liner, which runs
  command substitution over its input — a query string containing `[…]` would have been executed.
  Both are covered by `addon/test/cgi-test.sh`.

## 3.4.0

### Added

- **hm2mqtt as a CCU addon**: an installable package for _Systemsteuerung → Zusatzsoftware_, for
  running hm2mqtt on the CCU itself instead of on a server — CCU3 with the official eQ-3 firmware,
  and OpenCCU on armv7l, aarch64 and x86_64. It brings its own Node.js and configures itself
  through a web UI in the CCU's WebUI: every option of the CLI in a form (generated from
  `--config-schema`, so it cannot fall behind), service control, log view, German and English.
  Everything lives in `/usr/local/addons/hm2mqtt` and refers only to itself — no `/usr/local/bin`
  symlinks, no PATH or profile changes, and another addon's Node.js is neither used nor disturbed.
  Built by `addon/build.sh`, attached to every release, marked `-beta` until an install on real
  hardware is confirmed.
- **`--local`**: when hm2mqtt runs on the CCU, it talks to the interface processes directly instead
  of through lighttpd — binrpc on 32001/32000 for BidCos-RF/Wired, hmipserver on 32010,
  VirtualDevices on 39292, ReGa on 8183 — which skips a proxy hop, the CCU's authentication and its
  firewall, and lets the callback servers bind loopback. The same behaviour node-red-contrib-ccu
  has. Detected by probing those ports when the address is local; `--no-local` forces the proxy
  ports. Nothing changes for the usual setup with a CCU somewhere on the network.

### Changed

- Requires mqtt-interfaces-core ^0.15.1, which fixes `--config-schema` and `--discover` truncating
  when their output goes to a pipe (`hm2mqtt --config-schema | jq` lost everything past 8 KB on
  macOS). Nothing else changes: no option was added, removed or altered by the six minor versions
  in between.

## 3.3.0

### Added

- **Finding the CCU on the network**: `--discover` broadcasts the eQ-3 discovery datagram (UDP 43439) and prints every CCU that answers — type, serial, firmware version and the interfaces
  whose ports are open — `--discover-json` for JSON, `--discover-timeout` for how long it
  listens. `-a auto` runs the same scan at start and uses the CCU it found; it refuses to start
  when none or several answer instead of bridging the wrong house.
- `--discover-address` for a CCU a router away (its own VLAN): names the CCU, another subnet's
  broadcast address, or a range to sweep (`172.16.24.0/24`).
- `-a auto` takes the CCU's dns name when it has one that round-trips, so a new dhcp lease does
  not break the instance; `--discover-ip` pins the address instead. `--install -a auto` persists
  what was found rather than leaving every service start to scan the network.
- `--config-schema` marks `ccu-address` with `x-discover: "network"`, so a management UI (she)
  can offer the scan when adding an instance.
- The probe and the reply layout come from [hm-discover](https://github.com/hobbyquaker/hm-discover),
  now expressed as a discovery hint for mqtt-interfaces-core 0.9 ([lib/discovery.js](lib/discovery.js));
  the interface ports it probes are the table `--interfaces auto` already used. Verified against a
  CCU3 (`eQ3-HmIP-CCU3-App`, firmware 3.87.6).

### Changed

- Requires mqtt-interfaces-core ^0.9.0.

## 3.2.1

### Added

- Docker images on `ghcr.io/hobbyquaker/hm2mqtt.js`, built for amd64, arm64 and armv7 by the
  release workflow on every tag (`x.y.z`, `x.y`, `latest`) — no `docker build` needed any more;
  `.dockerignore` added.

### Fixed

- The image creates `/data` owned by `node`: on a fresh volume docker created the mount point
  root-owned, so the state directory could not be written.

## 3.2.0

### Added

- Home Assistant discovery (ROADMAP §13): one HA device per Homematic device, roles from the
  paramset descriptions' `CONTROL` hints (switch, light, cover with tilt, climate for HM and HmIP
  thermostats, lock, event per key, contact/motion/smoke/water/presence sensors, energy and
  weather sensors, maintenance diagnostics) plus generic entities for every other datapoint
  (disabled by default, `--no-ha-generic`); availability from the bridge and `UNREACH`,
  `suggested_area` from the room. HmIP virtual receivers: first receiver controls, transmitter
  provides the state, receivers 2/3 disabled.
- `set/<channel>/LEVEL` accepts `OPEN`/`CLOSE`/`STOP`/`ON`/`OFF`; HM thermostats accept
  `set/<channel>/CONTROL_MODE` with `AUTO-MODE`/`MANU-MODE`/`BOOST-MODE`/`COMFORT-MODE`/
  `LOWERING-MODE`; key presses are also published as `status/<channel>/PRESS` (not retained).
- `--ignore` globs on `<interface>.<channel>.<datapoint>` (B-4).

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
