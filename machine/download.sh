#!/bin/bash
# download FILE...: saves files of the machine on this computer, as downloads of the browser's.
# Each file goes to the page through /run/page/out, which hands what it is given to the page once
# closed: its bytes as `download-part <id>` messages of at most 15 MB (a message holds 16 MiB),
# then `download-end <id>` with the file's name (web/www/downloads.js).

PART=15000000

if [ $# -eq 0 ]; then
  echo "usage: download FILE..." >&2
  exit 2
fi

# `n` bytes as a person reads them.
size_of() {
  local n=$1
  if ((n >= 1000000)); then
    printf '%d.%d MB' $((n / 1000000)) $((n % 1000000 / 100000))
  elif ((n >= 1000)); then
    printf '%d kB' $((n / 1000))
  else
    printf '%d bytes' "$n"
  fi
}

status=0
n=0
for file in "$@"; do
  if [ -d "$file" ]; then
    echo "download: $file is a directory: name its files, such as $file/*" >&2
    status=1
    continue
  fi
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    echo "download: $file is not a file" >&2
    status=1
    continue
  fi
  size=$(wc -c <"$file") || exit 1
  id="$$.$RANDOM.$((n += 1))"
  for ((at = 0; at < size; at += PART)); do
    { echo "download-part $id"; tail -c +$((at + 1)) -- "$file" | head -c "$PART"; } >/run/page/out || exit 1
  done
  { echo "download-end $id"; printf '%s' "${file##*/}"; } >/run/page/out || exit 1
  echo "download: ${file##*/} ($(size_of "$size")) is in this browser's downloads" >&2
done
exit "$status"
