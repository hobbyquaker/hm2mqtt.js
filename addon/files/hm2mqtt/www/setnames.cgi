#!/bin/tclsh
#
# Writes the name file. Validated with the bundled node before it replaces the file, because
# hm2mqtt reads this at startup and refuses to start on malformed JSON - an editor that can stop the
# service from starting is not an editor.

source [file join [file dirname [info script]] lib common.tcl]

require_session
json_header

set body [read stdin]
set temporary $ADDON_DIR/var/names.json.new

file mkdir $ADDON_DIR/var
set fd [open $temporary w]
catch {fconfigure $fd -encoding utf-8}
puts -nonewline $fd $body
close $fd

# object of address -> name, nothing else: a string or an array here would be read as "no names"
set check {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
    for (const [address, name] of Object.entries(data)) {
        if (typeof name !== 'string') throw new Error(`"${address}" must map to a string`);
    }
    console.log(Object.keys(data).length);
}
node_env
if {[catch {exec $ADDON_DIR/bin/node -e $check $temporary} result]} {
    file delete $temporary
    regsub {^.*Error: } $result "" message
    regsub {\n.*$} $message "" message
    puts "{\"error\":[json_string "invalid names file: $message"]}"
    exit 1
}

file rename -force $temporary $NAMES_FILE
catch {exec /bin/sync}
puts "{\"ok\":true,\"names\":$result}"
