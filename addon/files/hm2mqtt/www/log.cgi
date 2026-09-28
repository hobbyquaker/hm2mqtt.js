#!/bin/tclsh
#
# The last lines of the addon's log, as plain text: the file on a CCU, the journal of the unit
# addon-hm2mqtt on openccu-lite (task 17).

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

# task 17: on openccu-lite the log is the journal, and there is no file to show
if {[is_openccu_lite]} {
    set result [journal_log $lines]
    if {[string equal [lindex $result 0] "ok"]} {
        if {[string equal [lindex $result 1] ""]} {
            puts "(no lines in the journal for $JOURNAL_UNIT yet)"
        } else {
            puts [lindex $result 1]
        }
    } else {
        puts "(the journal could not be read: [lindex $result 1])"
        puts ""
        puts "Das Log steht auf der Seite Log des Systems: $LOG_PAGE"
        puts "The log is on the system's Log page: $LOG_PAGE"
    }
    exit 0
}

if {[file exists $LOG_FILE]} {
    catch {exec tail -n $lines $LOG_FILE} output
    puts $output
} else {
    puts "(no log yet - the service has not run)"
}
