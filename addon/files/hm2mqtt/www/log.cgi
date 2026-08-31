#!/bin/tclsh
#
# The last lines of the addon's log, as plain text. The service writes to
# var/hm2mqtt.log; lifecycle events additionally go to syslog.

source [file join [file dirname [file normalize [info script]]] lib common.tcl]

set params [require_session]

set lines 200
if {[dict exists $params lines] && [string is integer -strict [dict get $params lines]]} {
    set lines [dict get $params lines]
    if {$lines > 2000} {set lines 2000}
}

puts "Content-Type: text/plain; charset=utf-8\r\n"

if {[file exists $LOG_FILE]} {
    catch {exec tail -n $lines $LOG_FILE} output
    puts $output
} else {
    puts "(no log yet - the service has not run)"
}
