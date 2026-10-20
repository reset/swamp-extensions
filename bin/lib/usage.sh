# shellcheck shell=bash
# Copyright (C) 2026 Jamie Stormbreaker
# SPDX-License-Identifier: MIT
# smk { overwrite: true }
#
# --help and --describe for every script in bin/, both rendered from the script's own header comment by
# `smk shim`: the comment a reader sees when they open the file is the one place a script says what it
# is, so neither answer is written twice and neither can drift from it.
#
# The header's grammar: a summary paragraph first, then optionally
#
#   Arguments:
#     id (string, required) -- What it is. A continuation line indents further.
#     --preview (flag) -- What the flag does.
#
#   Exit: 0 done, 1 refused, 2 usage error.
#
# USAGE, immediately after SCRIPT_DIR is set and before any work, so --help never starts the job:
#
#   # shellcheck source-path=SCRIPTDIR source=lib/usage.sh
#   source "$SCRIPT_DIR/lib/usage.sh"
#   takes_no_arguments "$@"     # a script with none: refuses anything else with exit 2
#   help_if_asked "$@"          # a script that reads its own arguments
#
# A script declares one of the two, which makes "what does it do with an argument it does not know?" a
# fact in its own line rather than something to work out from its body.

# smk is on PATH in the dev shell every caller loads at its boundary. A script reached from a shell
# that never loaded it (a cold hook or agent) is a boundary that did not load: it stops and says so
# rather than re-entering direnv per command, which re-evaluates a cold shell on every call.
_shim() {
  if command -v smk >/dev/null 2>&1; then
    smk shim "$@"
  else
    echo >&2 "smk is not on PATH -- the dev shell is not loaded. Load it (direnv allow, or the project's dev-shell command) and retry."
    return 1
  fi
}

# Prints the leading description of the file at $1.
usage_from_header() {
  _shim help "$1"
}

# For a script that takes NO ARGUMENTS: answers --help and --describe, and refuses anything else with
# exit 2, rather than ignoring a flag it has never heard of, doing its whole job and exiting 0.
takes_no_arguments() {
  local usage_arg
  for usage_arg in "$@"; do
    case "$usage_arg" in
    --help | -h)
      usage_from_header "${BASH_SOURCE[1]}"
      exit
      ;;
    --describe)
      _shim describe "${BASH_SOURCE[1]}" --takes-no-arguments
      exit
      ;;
    esac
  done
  if (($# > 0)); then
    echo >&2 "Error: $(basename "${BASH_SOURCE[1]}") takes no arguments, but got '$1'."
    echo >&2 "Run it with no arguments, or --help for what it does."
    exit 2
  fi
}

# Answers the caller's --help and --describe from its header, and exits, wherever in "$@" they are.
#
# `--describe-is-mine` as the first word says the script answers --describe itself (a wrapper over a
# program with a richer interface than a header carries) and asks for the --help half only.
help_if_asked() {
  local usage_arg usage_describe_here=true
  if [[ "${1:-}" == "--describe-is-mine" ]]; then
    usage_describe_here=false
    shift
  fi
  for usage_arg in "$@"; do
    case "$usage_arg" in
    --help | -h)
      usage_from_header "${BASH_SOURCE[1]}"
      exit
      ;;
    --describe)
      if [[ "$usage_describe_here" == true ]]; then
        _shim describe "${BASH_SOURCE[1]}"
        exit
      fi
      ;;
    esac
  done
}
