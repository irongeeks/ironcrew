#!/usr/bin/env bash
# Render a "whole page -> zoom into office" Ken Burns tour, frame by frame.
set -euo pipefail
SRC="$1"            # 2880x1620 full-page still
OUTDIR="$2"         # frame output dir
N="${N:-140}"       # total frames
FX="${FX:-1327}"; FY="${FY:-441}"     # focal point (office center) in src px
IW=2880; IH=1620; ZMAX="${ZMAX:-1.9}"
mkdir -p "$OUTDIR"; rm -f "$OUTDIR"/f*.png

gen() {
  local i="$1"
  read cw ch cx cy < <(awk -v i="$i" -v N="$N" -v iw="$IW" -v ih="$IH" -v fx="$FX" -v fy="$FY" -v zmax="$ZMAX" 'BEGIN{
    pi=3.141592653589793; p=(N>1)?i/(N-1):0; ease=0.5-0.5*cos(pi*p);
    z=1+(zmax-1)*ease;
    cw=int(iw/z); ch=int(ih/z);
    if(cw%2)cw--; if(ch%2)ch--;
    cx=int(fx-cw/2); cy=int(fy-ch/2);
    if(cx<0)cx=0; if(cy<0)cy=0;
    if(cx>iw-cw)cx=iw-cw; if(cy>ih-ch)cy=ih-ch;
    print cw, ch, cx, cy;
  }')
  ffmpeg -hide_banner -loglevel error -y -i "$SRC" \
    -vf "crop=${cw}:${ch}:${cx}:${cy},scale=1920:1080:flags=lanczos" \
    "$OUTDIR/$(printf 'f%04d' "$i").png"
}
export -f gen
export SRC OUTDIR N FX FY IW IH ZMAX

seq 0 $((N-1)) | xargs -P "$(nproc)" -I{} bash -c 'gen "$@"' _ {}
echo "rendered $N frames -> $OUTDIR"
