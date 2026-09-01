#!/bin/tclsh
#
# Current configuration as JSON, in file order. Secrets are never sent to the browser - the UI only
# learns that one is set and leaves the placeholder alone unless the user types a new value.

source [file join [file dirname [info script]] lib common.tcl]

require_session
json_header

set parts [list]
foreach {key value} [read_env_file $ENV_FILE] {
    if {[string match "*PASSWORD*" $key] && ![string equal $value ""]} {
        set value "********"
    }
    lappend parts "[json_string $key]:[json_string $value]"
}
puts "\{[join $parts ,]\}"
