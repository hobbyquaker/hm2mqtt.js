#!/bin/tclsh
#
# The page behind the hm2mqtt button in Systemsteuerung. Checks the session, then serves the
# configuration UI.

source /usr/local/addons/hm2mqtt/www/lib/session.tcl

set params [query_params]
set sid ""
if {[dict exists $params sid]} {
    set sid [dict get $params sid]
}

puts "Content-Type: text/html; charset=utf-8\r\n"

if {[check_session $sid]} {
    set fd [open /usr/local/addons/hm2mqtt/www/index.html r]
    puts -nonewline [read $fd]
    close $fd
} else {
    puts "<!DOCTYPE html><meta charset=\"utf-8\"><title>hm2mqtt</title>"
    puts "<p>Sitzung ungültig. Bitte die Seite schließen und im WebUI neu anmelden.</p>"
    puts "<p>Invalid session. Please close this page and log in to the WebUI again.</p>"
}
