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

# Percent-decoding, written out rather than the usual `regsub`+`subst` one-liner: that idiom runs
# command substitution over its input, so a query string containing [...] would be executed.
proc url_decode {value} {
    set out ""
    set length [string length $value]
    for {set i 0} {$i < $length} {incr i} {
        set char [string index $value $i]
        if {$char eq "+"} {
            append out " "
        } elseif {$char eq "%" && $i + 2 < $length} {
            set hex [string range $value [expr {$i + 1}] [expr {$i + 2}]]
            if {[string is xdigit -strict $hex]} {
                append out [format %c [scan $hex %x]]
                incr i 2
            } else {
                append out $char
            }
        } else {
            append out $char
        }
    }
    # the bytes just decoded are utf-8; without this an umlaut arrives as two characters
    return [encoding convertfrom utf-8 $out]
}

# Query parameters, decoded. The UI builds its requests with URLSearchParams, which percent-encodes
# the `@` of a session id (`@1234567890@` -> `%401234567890%40`), so a CGI that skips decoding sees
# no valid session at all.
proc query_params {} {
    set params [dict create]
    catch {
        foreach pair [split $::env(QUERY_STRING) &] {
            if {[regexp {^([^=]*)=(.*)$} $pair dummy name value]} {
                dict set params [url_decode $name] [url_decode $value]
            }
        }
    }
    return $params
}
