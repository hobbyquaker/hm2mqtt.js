#!/bin/tclsh
#
# The version line of the addon page in Systemsteuerung: prints the newest release tag from GitHub,
# or "n/a" when the CCU has no internet. ?cmd=download redirects to the release page.

set checkURL "https://api.github.com/repos/hobbyquaker/hm2mqtt.js/releases/latest"
set downloadURL "https://github.com/hobbyquaker/hm2mqtt.js/releases/latest"

set cmd ""
catch {
    foreach pair [split $env(QUERY_STRING) &] {
        if {[regexp {^([^=]*)=(.*)$} $pair dummy name value]} {
            if {[string equal $name "cmd"]} {
                set cmd $value
            }
        }
    }
}

if {[string equal $cmd "download"]} {
    puts "Content-Type: text/html; charset=utf-8\r\n"
    puts "<html><head><meta http-equiv='refresh' content='0; url=$downloadURL' /></head></html>"
} else {
    puts "Content-Type: text/plain; charset=utf-8\r\n"
    catch {
        regexp {"tag_name":[ ]*"v?([0-9]+\.[0-9]+\.[0-9]+[^"]*)"} \
            [exec /usr/bin/env wget -qO- --no-check-certificate $checkURL] dummy newversion
    }
    if {[info exists newversion]} {
        puts -nonewline $newversion
    } else {
        puts -nonewline "n/a"
    }
}
