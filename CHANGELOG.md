# Changelog

## 3.5.1

### Changed

- **Addon UI: one bar.** Name, tabs, state and the buttons share the top bar — Konfiguration, Namen
  and Log are no longer a second row. A tab keeps its width when it becomes active (the weight no
  longer changes, only colour and underline), the log view uses the whole page, and the names editor
  has room around it.
- **German only.** A CCU is a German-market device, so the interface is German and the language
  switch is gone.

## 3.5.0

### Changed

- **Topics are configured whole, not as an "item".** `--topic-status` and `--topic-set` (and
  `--topic-sysvar-status`/`-set`, `--topic-program-status`/`-set`) render the entire topic, with
  `${prefix}` standing for the instance name:
  `${prefix}/status/${channelName|channel}/${datapoint}` is the default and renders exactly the
  topics hm2mqtt published before — nothing moves unless you move it. What is subscribed follows
  from the literal part of the `set` templates (`hm/set/#` by default), and incoming topics are
  resolved by looking up the whole topic, since a rendered level may contain slashes. The address
  form and the commands keep working below that literal part.
  `--item-template`, `--sysvar-item-template` and `--program-item-template` are deprecated and
  migrate into the matching pairs, so an existing configuration is unaffected.
  Home Assistant discovery publishes the same rendered topics, so changing a template re-announces
  the entities.
- **Addon UI: three tabs** — Konfiguration, Namen, Log — instead of panels toggled from the header.
  Service control, state and the language switch stay in the header above them.
- `--json-payloads` and `--hm-payload` are no longer offered in the addon UI: both are implied by
  the payload format, and three overlapping switches only invite combinations nobody wants. The CLI
  keeps them.

## 3.4.7

### Fixed

- The package test added in 3.4.6 failed the armv7l and aarch64 release jobs: it tried to execute
  the bundled node, which an x86_64 runner cannot do for an ARM binary. It now runs the binary only
  where the architectures match and inspects it otherwise. 3.4.6 was published to npm and ghcr but
  has no GitHub release and therefore no addon packages - use 3.4.7.

## 3.4.6

### Fixed

- **Addon: the configuration page was blank** (3.4.4 and 3.4.5). The WebUI reaches the CGIs through
  `/usr/local/etc/config/addons/www/hm2mqtt`, a symlink to the addon's `www` directory, so deriving
  the addon's location from the script's own path landed in the symlink's parent —
  `/usr/local/etc/config/addons/www` — and `index.html` could not be opened. The header had already
  been sent and the error went to stderr, which is why the browser showed a white page and no
  console error. `file normalize` had been resolving that symlink until it was replaced for Tcl 8.2
  in 3.4.4. The addon's install path is fixed by the installer, so it is simply known now.
- The test harness serves the CGIs through such a symlink, and a new package test unpacks the built
  package into the layout a CCU installs it into and calls the pages the way lighttpd does — both
  run in CI on every build. Neither existed before, which is why the source tree looked healthy
  while the installed addon was not.

## 3.4.5

### Fixed

- **Addon: the configuration page was blank in 3.4.4.** Replacing `file normalize` (Tcl 8.4) for the
  CCU3's 8.2 left the addon unable to work out where it lives when lighttpd invokes a CGI the way it
  does - as a bare filename, with the working directory set to the script's own. The resulting path
  was one level short, `index.html` could not be opened, and the error went to stderr where no
  browser sees it. The path is made absolute and its `./` segments collapsed, verified on the CCU3's
  own interpreter for all three invocation forms.
- The test harness now invokes the CGIs exactly as lighttpd does, relative and from the script's own
  directory. It had been passing absolute paths, which is why it never saw this.

## 3.4.4

### Fixed

- **Addon: the WebUI could not have worked on a CCU3.** Its firmware ships **Tcl 8.2.3** (1999), and
  the CGIs used `dict` (8.5), `eq`/`ne` in expressions (8.4), `string is` (8.3), `{*}` (8.5),
  `file normalize` (8.4) and `scan` without a variable (8.4) — every one a runtime error there. All
  of it is rewritten for 8.2 and verified by running it on the CCU3's own interpreter: session ids,
  spaces, umlauts and globs decode correctly, and `[exec …]` in a query string stays literal text.
  OpenCCU was unaffected — it has a current Tcl, which is why this only surfaced now.
- **Addon: the status line said "0 MB" and showed no uptime.** It asked `ps -o rss= -p <pid>`, and
  busybox `ps` has no `-p`, so both values silently fell back to nothing. Memory and uptime now come
  from `/proc/<pid>/status` and `/proc/<pid>/stat`, formatted as e.g. `142 MB · 4d 10h`.
- The test harness gained a guard against Tcl newer than 8.2 in the shipped scripts, and checks the
  memory and uptime values wherever `/proc` exists.

## 3.4.3

### Changed

- **Addon: the CCU connection is not a configuration any more.** On the CCU there is nothing to
  decide - the address is loopback, the interface processes are talked to directly (binrpc 32001 for
  rfd, 32000 for hs485d, hmipserver 32010, ReGa 8183), and those ports carry neither TLS nor
  authentication. So the address, `--local`, `--bidcos-binrpc`, the credentials and both TLS options
  are gone from the WebUI; `HM2MQTT_CCU_ADDRESS=127.0.0.1` and `HM2MQTT_LOCAL=true` ship
  preconfigured. What is left in that section is the one thing that is a choice: which interfaces to
  use.
- The interface probe behind "Schnittstellen ermitteln" now probes the ports the addon will actually
  connect to (the process ports in local mode), not the lighttpd proxies in front of them.

## 3.4.2

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

### Added

- **Addon: a names editor.** `HM2MQTT_NAME_FILE` ships preconfigured
  (`/usr/local/addons/hm2mqtt/etc/names.json`) and is no longer an option in the UI; instead the
  WebUI has a **Namen** tab that edits the file directly. Saving validates the JSON twice - in the
  browser and, with the bundled node, in the addon before the file is replaced - because hm2mqtt
  reads it at startup and refuses to start on malformed JSON. The file survives addon updates, like
  the configuration.

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
