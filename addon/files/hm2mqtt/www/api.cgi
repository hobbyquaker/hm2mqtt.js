#!/bin/tclsh
#
# Bridge to scripts/addon-api.js for the things the UI cannot do on its own: probe the CCU
# interfaces, test the broker connection, preview an item template. Each call is a short-lived
# node process; the addon runs no server of its own.

source [file join [file dirname [file normalize [info script]]] lib common.tcl]

set params [require_session]
json_header

set cmd ""
if {[dict exists $params cmd]} {
    set cmd [dict get $params cmd]
}

if {[lsearch -exact {discover probe mqtt-test channels preview} $cmd] < 0} {
    puts "{\"error\":\"unknown command\"}"
    exit 1
}

set argv_list [list $ADDON_DIR/app/scripts/addon-api.js $cmd]
foreach key {host url username password template limit tls port timeout local} {
    if {[dict exists $params $key]} {
        set value [dict get $params $key]
        if {$value ne ""} {
            lappend argv_list --$key $value
        }
    }
}

set env(ICU_DATA) ""
if {[file exists $ADDON_DIR/versions]} {
    set fd [open $ADDON_DIR/versions r]
    foreach line [split [read $fd] "\n"] {
        if {[regexp {^NODE_ICU_DATA=(.*)$} [string trim $line] dummy value]} {
            set env(ICU_DATA) $value
        }
    }
    close $fd
}

if {[catch {exec $ADDON_DIR/bin/node {*}$argv_list} output]} {
    # the helper prints JSON on failure too; pass it through when it looks like JSON
    if {[string index [string trim $output] 0] eq "\{"} {
        puts $output
    } else {
        puts "{\"error\":[json_string $output]}"
    }
    exit 1
}
puts $output
