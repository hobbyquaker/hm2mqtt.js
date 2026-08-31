#!/bin/tclsh
#
# Current configuration as JSON. Secrets are never sent to the browser - the UI only learns
# whether one is set, and leaves the placeholder alone unless the user types a new value.

source [file join [file dirname [file normalize [info script]]] lib common.tcl]

require_session
json_header

set config [dict create]
if {[file exists $ENV_FILE]} {
    set fd [open $ENV_FILE r]
    foreach line [split [read $fd] "\n"] {
        set line [string trim $line]
        if {$line eq "" || [string index $line 0] eq "#"} continue
        if {[regexp {^([A-Za-z_][A-Za-z0-9_]*)=(.*)$} $line dummy key value]} {
            dict set config $key $value
        }
    }
    close $fd
}

set parts {}
dict for {key value} $config {
    if {[string match "*PASSWORD*" $key] && $value ne ""} {
        set value "********"
    }
    lappend parts "[json_string $key]:[json_string $value]"
}
puts "\{[join $parts ,]\}"
