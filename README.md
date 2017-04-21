# hm2mqtt.js

[![NPM version](https://badge.fury.io/js/hm2mqtt.svg)](http://badge.fury.io/js/hm2mqtt)
[![Dependency Status](https://img.shields.io/gemnasium/hobbyquaker/hm2mqtt.js.svg?maxAge=2592000)](https://gemnasium.com/github.com/hobbyquaker/hm2mqtt.js)
[![Build Status](https://travis-ci.org/hobbyquaker/hm2mqtt.js.svg?branch=master)](https://travis-ci.org/hobbyquaker/hm2mqtt.js)
[![XO code style](https://img.shields.io/badge/code_style-XO-5ed9c7.svg)](https://github.com/sindresorhus/xo)
[![License][mit-badge]][mit-url]

> Node.js based Interface between Homematic and MQTT

Because [hm2mqtt](https://github.com/owagner/hm2mqtt) isn't developed anymore and I don't really like Java I decided to 
re-implement this with Node.js

It's kind of the same like the original hm2mqtt, but it supports BINRPC and XMLRPC (hm2mqtt only supports BINRPC), so it 
can be used with Homematic IP also. Furthermore it supports Rega variables and programs.


### Installation

Prerequisites: [Node.js](https://nodejs.org) 6.0 or higher.

`npm install -g hm2mqtt`

I suggest to use [pm2](http://pm2.keymetrics.io/) to manage the hm2mqtt process (start on system boot, manage log files, 
...)


### Command Line Options

Use `hm2mqtt --help` to get a list of available options.


### Topics

* Events are published on `<name>/status/<channelName>/<datapoint>` (JSON payload, follows 
[mqtt-smarthome payload format](https://github.com/mqtt-smarthome/mqtt-smarthome/blob/master/Architecture.md))
* Values can be set via `<name>/set/<channelAddress_or_channelName>/<datapoint>` (can be plain or JSON payload). Example:
`hmip/set/Light_Garage/STATE`,
* Values from Paramsets other than `VALUES` can be set via 
`<name>/set/<channelAddress_or_channelName>/<paramset>/<datapoint>`.
* RPC methods can be called via `<name>/rpc/<iface>/<command>/<callId>` and respond to `<name>/response/<callId>` 
(JSON encoded Array as payload). The callId can be an arbitrary string, its purpose is just to collate the response
to the command. iface can be one of `hmip`, `rfd` or `hs485d`.


### Device and Channel Names

Device and Channel names are queried from ReGa, this can be disabled by setting the `--disable-rega` option. To trigger
a re-read after changes on the ReGa you can publish a message to `<name>/command/regasync` or just restart hm2mqtt.
As an alternative to using the names from ReGa you can also supply a json file with the `--json-name-table` option 
containing address to name mappings, created by e.g. 
[homematic-manager](https://github.com/hobbyquaker/homematic-manager). This file should look like:
```javascript
{
    "EEQ1234567": "Device Name",
    "EEQ1234567:1": "Channel Name",
    ...
}
```


### ReGa (Homematic variables and programs)

To receive changes from ReGa you have to set `--rega-poll-interval` and/or `--rega-poll-trigger`. 
`--rega-poll-trigger` can be set to e.g. `BidCoS-RF:50.PRESS_SHORT`, then a polling is done whenever this virtual button 
is pressed. This is meant to create a "pseudo push mechanism" where a program on the ccu reacts on variable changes and 
presses this virtual button.

Variables and Programs are published to `<name>/status/<variableOrProgramName>` and can be set by sending a message to
`<name>/set/<variableOrProgramName>`. Publishing `true` or `false` to a program activates/deactivates the program. To
start a program publish the string `start`.


## License

MIT (c) 2017 [Sebastian Raff](https://github.com/hobbyquaker)

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
