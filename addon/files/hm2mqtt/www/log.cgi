#!/bin/tclsh
#
# The last lines of the addon's log, as plain text.

source [file join [file dirname [info script]] lib common.tcl]

array set params [require_session]

set lines 200
if {[info exists params(lines)] && [regexp {^[0-9]+$} $params(lines)]} {
    set lines $params(lines)
    if {$lines > 2000} {
        set lines 2000
    }
}

puts "Content-Type: text/plain; charset=utf-8\r\n"

if {[file exists $LOG_FILE]} {
    catch {exec tail -n $lines $LOG_FILE} output
    puts $output
} else {
    puts "(no log yet - the service has not run)"
}
