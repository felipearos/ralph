#!/usr/bin/env bash
# HITL Ralph: run exactly one iteration, watching the output.
set -uo pipefail
RALPH_HOME="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)"
# shellcheck source=project.sh
. "${RALPH_HOME}/project.sh"
exec "${RALPH_HOME}/ralph.sh" 1
