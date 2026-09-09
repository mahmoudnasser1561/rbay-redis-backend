#!/usr/bin/env bash
# Experiment B protocol: hot-item workload, optimistic vs lock, 6 concurrency
# levels x 5 repeats = 60 runs, 30s warmup discarded + 60s measured each
# (90s k6 duration per run). CONFIG RESETSTAT fires ~30s in (right as the
# measured window starts) so command-count stats reflect only the measured
# 60s; INFO all is captured right after each run for the same reason.
#
# ~90 minutes total. Run in the background and check bench/results/k6-raw/
# for progress; do not run this in the foreground of an interactive session.
#
# Usage: bash bench/k6/run-protocol.sh
# Sanity-check override (small slice, for verifying the choreography before
# the full run): CONCURRENCY_LEVELS="10" STRATEGIES="optimistic" REPEATS=1 \
#   bash bench/k6/run-protocol.sh

set -euo pipefail
cd "$(dirname "$0")/../.."

set -a
source .env
set +a

CONCURRENCY_LEVELS="${CONCURRENCY_LEVELS:-1 10 50 100 250 500}"
STRATEGIES="${STRATEGIES:-optimistic lock}"
REPEATS="${REPEATS:-5}"
OUT_DIR="bench/results/k6-raw"
mkdir -p "$OUT_DIR"

total=0
for _ in $CONCURRENCY_LEVELS; do
	for _ in $STRATEGIES; do
		for _ in $(seq 1 "$REPEATS"); do
			total=$((total + 1))
		done
	done
done

run_index=0
for strategy in $STRATEGIES; do
	for n in $CONCURRENCY_LEVELS; do
		for rep in $(seq 1 "$REPEATS"); do
			run_index=$((run_index + 1))
			label="hot-${strategy}-N${n}-rep${rep}"
			raw_file="${OUT_DIR}/${label}.json"
			info_file="${OUT_DIR}/${label}.redis-info.txt"
			k6_log="${OUT_DIR}/${label}.k6-log.txt"

			echo "[$(date +%H:%M:%S)] [${run_index}/${total}] ${label} starting"

			npm run bench:reset >/dev/null 2>&1

			k6 run \
				-e WORKLOAD=hot \
				-e STRATEGY="$strategy" \
				--vus "$n" \
				--duration 90s \
				--out "json=${raw_file}" \
				bench/k6/contention.js >"$k6_log" 2>&1 &
			k6_pid=$!

			sleep 30
			docker exec local-redis redis-cli -a "$REDIS_PW" --no-auth-warning CONFIG RESETSTAT >/dev/null
			echo "[$(date +%H:%M:%S)] [${run_index}/${total}] ${label} measured window started (RESETSTAT fired)"

			wait "$k6_pid"
			docker exec local-redis redis-cli -a "$REDIS_PW" --no-auth-warning INFO all >"$info_file"

			echo "[$(date +%H:%M:%S)] [${run_index}/${total}] ${label} done"
		done
	done
done

echo "Experiment B protocol run complete. ${total} runs in ${OUT_DIR}/"
