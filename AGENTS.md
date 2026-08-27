# Agent instructions — hm2mqtt

## What this is

hm2mqtt bridges a Homematic CCU (BidCos-RF, BidCos-Wired, HmIP-RF, VirtualDevices, CUxD, ReGaHSS)
to MQTT following the [mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome)
convention, as a drop-in replacement for the `ccu-mqtt` node of node-red-contrib-ccu (the
reference implementation: `nodes/ccu-connection.js` there). Shared behaviour comes from
[mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core)
(`../mqtt-interfaces-core` when checked out next to this repo). ROADMAP.md holds the decisions
(H-n) — read it before changing topics or payloads; the topics are API.

## Code layout (ES modules, node >= 20.19)

- `index.js` — `createAdapter()` wiring: interfaces → events → payloads, `set`/`paramset`/`rpc`
  handling, counters, duty cycle, cache, shutdown. No protocol details here.
- `lib/interfaces.js` — the interface table (ports, protocol, ping) and `--interfaces auto` probe.
- `lib/rpc.js` — `RpcConnection` (client, init/ping/re-init, counters) and `RpcServers`
  (callback servers, routing by init id, multicall hints). Talks to homematic-xmlrpc / binrpc.
- `lib/metadata.js` — devices and paramset descriptions, persisted; `paramsets.json` is the seed.
- `lib/values.js` — node-red-contrib-ccu's `createMessage()` (the `hm` block), wait-for-WORKING,
  `_NOTWORKING`, cached values, `values.json`.
- `lib/rega.js` — names/rooms/functions, variables/programs with change detection, polling, set.
- `lib/cast.js`, `lib/topics.js` — pure: value casting by description, item names, topic resolution.
- `test/*.test.js` — node:test with fakes; no CCU or broker needed.

## Practices

- 4 spaces, eslint + prettier (`npm run lint`); let a failing lint stop you.
- Never rename topics or `hm` fields outside a major release.
- Credentials (CCU, broker) never go into defaults, tests, docs or state files.
- An unreachable interface is `warn` once and a retry, never an exit; `connected` shows it.
