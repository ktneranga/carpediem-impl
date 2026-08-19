#!/bin/sh
wget -q -O /dev/null http://localhost:3000/api/health || exit 1
