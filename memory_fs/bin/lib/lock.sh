#!/usr/bin/env bash

NODE_LOCK_STALE_SECONDS=30

_node_lock_mtime() {
  local value
  value="$(stat -f '%m' "$1" 2>/dev/null)" || value=""
  case "$value" in
    ''|*[!0-9]*) ;;
    *) printf '%s\n' "$value"; return 0;;
  esac
  value="$(stat -c '%Y' "$1" 2>/dev/null)" || return 1
  case "$value" in
    ''|*[!0-9]*) return 1;;
    *) printf '%s\n' "$value";;
  esac
}

_valid_node_lock_id() {
  printf '%s' "$1" | grep -qE '^[0-9A-HJKMNP-TV-Z]{26}$'
}

# lock_node <graph-root> <node-id> [node-id ...]
#   Acquire per-Node exclusive locks in sorted byte order, mirroring
#   dsh_plugin/lib/graph.js's withNodeLocks. A caller must immediately install
#   `trap 'unlock_node "$root" "$id"' EXIT`; bash has no native finally.
lock_node() {
  local root="${1:-}"
  [ -n "$root" ] || { echo "error: lock_node requires a graph root" >&2; return 1; }
  shift
  [ "$#" -gt 0 ] || { echo "error: lock_node requires at least one Node ID" >&2; return 1; }

  local id
  for id in "$@"; do
    _valid_node_lock_id "$id" || { echo "error: invalid Node ID for lock: $id" >&2; return 1; }
  done

  local lock_root="$root/.locks"
  mkdir -p "$lock_root" || { echo "error: failed to create Node lock area: $lock_root" >&2; return 1; }

  local ordered lock_dir mtime now mtime_failures=0
  local -a acquired=()
  ordered="$(printf '%s\n' "$@" | LC_ALL=C sort -u)"
  while IFS= read -r id; do
    lock_dir="$lock_root/$id.lock"
    while ! mkdir "$lock_dir" 2>/dev/null; do
      if [ ! -e "$lock_dir" ]; then
        continue
      elif [ ! -d "$lock_dir" ]; then
        # The holder can release (or another waiter can reacquire) between the
        # existence and directory checks; recheck before treating it as foreign.
        if [ ! -e "$lock_dir" ] || [ -d "$lock_dir" ]; then
          continue
        fi
        echo "error: Node lock path is not a directory: $lock_dir" >&2
        [ "${#acquired[@]}" -eq 0 ] || unlock_node "$root" "${acquired[@]}"
        return 1
      fi
      mtime="$(_node_lock_mtime "$lock_dir")" || {
        # The holder can release and another waiter can reacquire between the
        # checks above and stat; a CONFIRMED disappearance retries the mkdir.
        [ ! -e "$lock_dir" ] && continue
        # The dir is still there but unreadable — bound the retries so a
        # persistent stat/IO failure cannot hang forever while holding earlier
        # locks (codex review of #131).
        mtime_failures=$((mtime_failures+1))
        if [ "$mtime_failures" -gt 40 ]; then
          echo "error: failed to read Node lock mtime: $lock_dir" >&2
          [ "${#acquired[@]}" -eq 0 ] || unlock_node "$root" "${acquired[@]}"
          return 1
        fi
        sleep 0.05
        continue
      }
      mtime_failures=0
      now="$(date +%s)" || {
        echo "error: failed to read current time while locking: $id" >&2
        [ "${#acquired[@]}" -eq 0 ] || unlock_node "$root" "${acquired[@]}"
        return 1
      }
      if [ $((now - mtime)) -gt "$NODE_LOCK_STALE_SECONDS" ]; then
        if ! rmdir "$lock_dir" 2>/dev/null && [ -d "$lock_dir" ]; then
          echo "error: failed to remove stale Node lock: $lock_dir" >&2
          [ "${#acquired[@]}" -eq 0 ] || unlock_node "$root" "${acquired[@]}"
          return 1
        fi
      else
        sleep 0.05
      fi
    done
    acquired+=("$id")
  done <<< "$ordered"
}

# unlock_node <graph-root> <node-id> [node-id ...]
#   Release locks acquired by lock_node, in reverse sorted order.
unlock_node() {
  local root="${1:-}"
  [ -n "$root" ] || { echo "error: unlock_node requires a graph root" >&2; return 1; }
  shift
  [ "$#" -gt 0 ] || { echo "error: unlock_node requires at least one Node ID" >&2; return 1; }

  local ordered id rc=0
  for id in "$@"; do
    _valid_node_lock_id "$id" || { echo "error: invalid Node ID for unlock: $id" >&2; return 1; }
  done
  ordered="$(printf '%s\n' "$@" | LC_ALL=C sort -ru)"
  while IFS= read -r id; do
    if ! rmdir "$root/.locks/$id.lock"; then
      echo "error: failed to release Node lock: $root/.locks/$id.lock" >&2
      rc=1
    fi
  done <<< "$ordered"
  return "$rc"
}
