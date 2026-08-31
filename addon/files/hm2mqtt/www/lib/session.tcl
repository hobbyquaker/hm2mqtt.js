#!/bin/tclsh
#
# Validates a CCU WebUI session id against ReGa. Every CGI that reads or changes something must
# call this - the addon pages are reachable without authentication otherwise.
# Same approach as RedMatic's lib/session.tcl (MIT, same author).

load tclrega.so

proc check_session {sid} {
    if {[regexp {@([0-9a-zA-Z]{10})@} $sid all sidnr]} {
        if {[lindex [rega_script "Write(system.GetSessionVarStr('$sidnr'));"] 1] ne ""} {
            return 1
        }
    }
    return 0
}

proc query_params {} {
    set params [dict create]
    catch {
        foreach pair [split $::env(QUERY_STRING) &] {
            if {[regexp {^([^=]*)=(.*)$} $pair dummy name value]} {
                dict set params $name $value
            }
        }
    }
    return $params
}
