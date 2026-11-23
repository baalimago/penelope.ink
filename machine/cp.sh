#!/bin/bash
# cp for the browser machine, in /usr/local/bin before the registry's /bin/cp. WASI files have no
# permission bits, so /bin/cp fails any copy that preserves mode ("operation not supported on this
# platform"), and -a and -p ask for that; clai's cp tool runs `cp -a`. This keeps what the machine
# can preserve and drops mode and ownership: -a is -dR --preserve=timestamps, -p is
# --preserve=timestamps, and a --preserve list loses mode and ownership.

keep() {
  local items item out=()
  IFS=, read -ra items <<<"$1"
  for item in "${items[@]}"; do
    case $item in
      mode | ownership) ;;
      all) out+=(timestamps links xattr) ;;
      *) out+=("$item") ;;
    esac
  done
  local IFS=,
  echo "${out[*]}"
}

opts=()
extra=()
rest=()
while (($#)); do
  arg=$1
  shift
  case $arg in
    --)
      rest=(-- "$@")
      break
      ;;
    --archive)
      opts+=(-dR)
      extra=(--preserve=timestamps)
      ;;
    --preserve) extra=(--preserve=timestamps) ;;
    --preserve=*)
      list=$(keep "${arg#--preserve=}")
      [ -n "$list" ] && opts+=("--preserve=$list")
      ;;
    --*) opts+=("$arg") ;;
    -?*)
      # A cluster of short flags; one that takes a value (S, t) ends it, the value inline or next.
      cluster=${arg#-}
      out=""
      while [ -n "$cluster" ]; do
        flag=${cluster:0:1}
        cluster=${cluster:1}
        case $flag in
          a)
            out+=dR
            extra=(--preserve=timestamps)
            ;;
          p) extra=(--preserve=timestamps) ;;
          S | t)
            out+=$flag$cluster
            cluster=""
            ;;
          *) out+=$flag ;;
        esac
      done
      [ -n "$out" ] && opts+=("-$out")
      ;;
    *) opts+=("$arg") ;;
  esac
done

exec /bin/cp "${extra[@]}" "${opts[@]}" "${rest[@]}"
