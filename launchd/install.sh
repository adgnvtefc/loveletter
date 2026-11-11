#!/bin/sh
# Installs (or reinstalls) the post office LaunchAgent. Safe to rerun after editing the plist.
# The plist says __HOME__ where your home folder goes (plists can't use ~); this fills it in.
set -eu
cd "$(dirname "$0")/.."
mkdir -p -m 700 ~/.loveletter
mkdir -p ~/.loveletter/logs ~/Library/LaunchAgents
label=com.loveletter.server
target=~/Library/LaunchAgents/"$label.plist"
sed "s|__HOME__|$HOME|g" "launchd/$label.plist" > "$target"
plutil -lint "$target" >/dev/null
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$target"
echo "loaded $label"
