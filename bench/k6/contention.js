// Experiment B (§1.B): sustained contention, real HTTP, k6.
//
// k6 is a separate Go-based runtime with its own JS engine - it can't import
// this project's TS/Redis code, so this drives the app through two bench-only
// routes: POST /bench/create-item (setup) and POST /bench/bid (the actual
// load, dispatching to whichever strategy is passed in the request body -
// see src/routes/bench/bid.ts for why that's an explicit field rather than
// the BID_STRATEGY env var Experiment A uses).
//
// Usage:
//   k6 run -e WORKLOAD=hot    -e STRATEGY=optimistic bench/k6/contention.js
//   k6 run -e WORKLOAD=spread -e STRATEGY=lock       bench/k6/contention.js
//   k6 run -e WORKLOAD=hot -e STRATEGY=lock --vus 50 --duration 30s bench/k6/contention.js
//
// Defaults below (5 VUs / 15s) are a smoke-test scale, not the full §1.B
// protocol (30s discarded warmup + 60s measured, 5 repeats, 6 concurrency
// levels) - that sweep is a separate orchestration step once this script is
// confirmed working.

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WORKLOAD = __ENV.WORKLOAD || 'hot'; // 'hot' | 'spread'
const STRATEGY = __ENV.STRATEGY || 'optimistic'; // 'optimistic' | 'lock'
const SPREAD_ITEM_COUNT = 100;

export const options = {
	vus: Number(__ENV.VUS) || 5,
	duration: __ENV.DURATION || '15s'
};

const accepted = new Counter('bid_accepted');
const bidTooLow = new Counter('bid_too_low');
const retryExhausted = new Counter('bid_retry_exhausted');
const otherError = new Counter('bid_other_error');
const bidDuration = new Trend('bid_duration', true);

export function setup() {
	if (WORKLOAD !== 'hot' && WORKLOAD !== 'spread') {
		throw new Error(`setup: WORKLOAD must be 'hot' or 'spread', got: ${WORKLOAD}`);
	}
	if (STRATEGY !== 'optimistic' && STRATEGY !== 'lock') {
		throw new Error(`setup: STRATEGY must be 'optimistic' or 'lock', got: ${STRATEGY}`);
	}

	const itemCount = WORKLOAD === 'spread' ? SPREAD_ITEM_COUNT : 1;
	const itemIds = [];

	for (let i = 0; i < itemCount; i++) {
		const res = http.post(`${BASE_URL}/bench/create-item`, null, {
			headers: { 'content-type': 'application/json' }
		});
		if (res.status !== 201) {
			throw new Error(`setup: create-item failed (status ${res.status}): ${res.body}`);
		}
		itemIds.push(JSON.parse(res.body).itemId);
	}

	return { itemIds };
}

export default function (data) {
	const itemIds = data.itemIds;
	const itemId =
		WORKLOAD === 'spread' ? itemIds[(__VU + __ITER) % itemIds.length] : itemIds[0];

	// Wall-clock milliseconds as the bid amount: naturally monotonic and
	// consistent across every VU's view of time with zero coordination
	// needed between them, unlike a per-VU local counter (which would cause
	// most concurrent bids on the hot item to legitimately lose to "too low"
	// in an uninteresting way, since each VU's counter starts fresh at 0).
	const payload = JSON.stringify({
		itemId,
		userId: `vu-${__VU}-iter-${__ITER}`,
		amount: Date.now(),
		strategy: STRATEGY
	});

	const res = http.post(`${BASE_URL}/bench/bid`, payload, {
		headers: { 'content-type': 'application/json' },
		tags: { name: 'bid' }
	});

	bidDuration.add(res.timings.duration);

	if (res.status === 201) {
		accepted.add(1);
	} else if (res.status === 409) {
		retryExhausted.add(1);
	} else if (res.status === 400) {
		bidTooLow.add(1);
	} else {
		otherError.add(1);
	}

	check(res, {
		'status is 201, 400, or 409': (r) => [201, 400, 409].includes(r.status)
	});
}
