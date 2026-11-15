#!/usr/bin/env bash
# Entrypoint for the hot-shots perfTest measurement container.
# Deliberately not using `set -e`: a failing suite must still print a report.
set -uo pipefail

MODE="${MODE:-test}"
INSTRUMENT=/app/perfTest/instrument.js
COUNTS_ROOT=/tmp/hs-counts
STRACE_LOG=/tmp/hs-strace.log

if [ "$MODE" = "bench" ]; then
  echo '==> Running the perfTest micro-benchmark'
  exec node /app/perfTest/test.js
fi

if [ "$MODE" != "test" ]; then
  echo "run.sh: unknown MODE '$MODE' (expected 'test' or 'bench')" >&2
  exit 2
fi

rm -rf "$COUNTS_ROOT"
mkdir -p "$COUNTS_ROOT/pass1"

echo '==> Pass 1: test suite with in-process counters'
start_ns=$(date +%s%N)
HS_COUNTS_DIR="$COUNTS_ROOT/pass1" NODE_OPTIONS="--require $INSTRUMENT" npm test --ignore-scripts
test_status=$?
end_ns=$(date +%s%N)
wall_main=$(( (end_ns - start_ns) / 1000000 ))

if strace -o /dev/null -f /bin/true >/dev/null 2>&1; then
  strace_ok=1
else
  strace_ok=0
fi

wall_strace=0
strace_status=0
if [ "$strace_ok" = "1" ]; then
  echo
  echo '==> Pass 2: test suite under strace (timing here is inflated)'
  start_ns=$(date +%s%N)
  # Deliberately uninstrumented: no NODE_OPTIONS here. The wrappers would add
  # their own syscalls to the very trace we are measuring.
  # Do not add -tt/-ttt -- a timestamp prefix makes report.js's line parser
  # match nothing, silently reporting every syscall count as zero.
  strace -f -qq -o "$STRACE_LOG" \
    -e trace=socket,connect,sendto,sendmsg,sendmmsg \
    npm test --ignore-scripts
  strace_status=$?
  end_ns=$(date +%s%N)
  wall_strace=$(( (end_ns - start_ns) / 1000000 ))
else
  echo
  echo '==> Pass 2 skipped: strace cannot run in this container.'
  echo '    Re-run with --cap-add=SYS_PTRACE --security-opt seccomp=unconfined'
fi

node /app/perfTest/report.js \
  "$COUNTS_ROOT/pass1" "$STRACE_LOG" "$wall_main" "$wall_strace" "$strace_ok"

# A failed pass 2 leaves the syscall tallies partial or empty. Report it. Low
# syscall counts reported as if they were real are worse than no counts at all,
# because the numbers still look correct.
if [ "$strace_status" != "0" ]; then
  echo
  echo "  WARNING: pass 2 exited $strace_status. The syscall counts above are"
  echo '  incomplete and must not be compared against another run.'
fi

# Either pass failing means the measurement is not trustworthy, so surface it.
if [ "$test_status" != "0" ]; then
  exit $test_status
fi
exit $strace_status
