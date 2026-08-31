#!/bin/tclsh
#
# Bridge to app/scripts/addon-api.js for the things the UI cannot do on its own: probe the CCU
# interfaces, test the broker connection, preview an item template. Each call is a short-lived node
# process; the addon runs no server of its own.

source [file join [file dirname [info script]] lib common.tcl]

array set params [require_session]
json_header

set cmd ""
if {[info exists params(cmd)]} {
    set cmd $params(cmd)
}

if {[lsearch -exact {discover probe mqtt-test channels preview} $cmd] < 0} {
    puts "{\"error\":\"unknown command\"}"
    exit 1
}

set arguments [list $ADDON_DIR/app/scripts/addon-api.js $cmd]
foreach key {host url username password template prefix limit tls port timeout local} {
    if {[info exists params($key)] && ![string equal $params($key) ""]} {
        lappend arguments --$key $params($key)
    }
}

set env(ICU_DATA) ""
if {[file exists $ADDON_DIR/versions]} {
    set fd [open $ADDON_DIR/versions r]
    set content [read $fd]
    close $fd
    foreach line [split $content "\n"] {
        if {[regexp {^NODE_ICU_DATA="?([^"]*)"?$} [string trim $line] dummy value]} {
            set env(ICU_DATA) $value
        }
    }
}

# no {*} on tcl 8.2 (the CCU3 ships 8.2.3): build the command and eval it
if {[catch {eval exec [linsert $arguments 0 $ADDON_DIR/bin/node]} output]} {
    # the helper prints JSON on failure too; pass it through when it looks like JSON
    if {[string equal [string index [string trim $output] 0] "\{"]} {
        puts $output
    } else {
        puts "{\"error\":[json_string $output]}"
    }
    exit 1
}
puts $output
