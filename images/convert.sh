#!/bin/bash
INFILE=$1
END=$2   # optional: stop here (seconds or HH:MM:SS) to trim the end
OUTFILE=${INFILE%.webm}.gif
TRIM=()
[ -n "$END" ] && TRIM=(-to "$END")
ffmpeg -i "$INFILE" "${TRIM[@]}" -f yuv4mpegpipe - | gifski --fps 8 --quality 80 -o "$OUTFILE" -
