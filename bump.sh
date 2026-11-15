#!/bin/sh
# Stamp script URLs and the offline cache with a new version so phones pick up changes right away.
v=$(date +%Y%m%d%H%M)
sed -i -E "s/\.js\?v=[0-9]+/.js?v=$v/g" index.html
sed -i -E "s/const CACHE = 'yardage-[0-9]+';/const CACHE = 'yardage-$v';/" sw.js
echo "version $v"
