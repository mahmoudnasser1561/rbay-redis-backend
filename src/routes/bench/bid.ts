import type { RequestHandler } from '@sveltejs/kit';
import { DateTime } from 'luxon';
import { createBid as optimisticCreateBid } from '../../../bench/bids/optimistic';
import { createBid as lockCreateBid } from '../../../bench/bids/lock';

// Experiment B groundwork. Deliberately does NOT use bench/bids/index.ts's
// BID_STRATEGY env-var dispatch: that's safe for Experiment A (one strategy
// per in-process run, all N concurrent calls want the same one) but would
// not be safe for concurrent HTTP requests that could each want a different
// strategy - env-var mutation has no per-request isolation. This dispatches
// via an explicit per-request field instead, with zero shared mutable state.
const strategies = {
	optimistic: optimisticCreateBid,
	lock: lockCreateBid
} as const;

type Strategy = keyof typeof strategies;

// itemEndingAt is part of CreateBidAttrs but unread by every strategy
// implementation (they all re-fetch the item's real endingAt from Redis) -
// see src/services/types.ts / bench/bids/*.ts. A placeholder is fine here.
const PLACEHOLDER_ENDING_AT = () => DateTime.now().plus({ hours: 1 });

export const post: RequestHandler<any> = async ({ request }) => {
	const body = await request.json();
	const strategy: Strategy = body.strategy;

	if (!strategies[strategy]) {
		return {
			status: 400,
			body: { message: `unknown strategy: ${body.strategy}` }
		};
	}

	try {
		await strategies[strategy]({
			itemId: body.itemId,
			userId: body.userId,
			amount: body.amount,
			createdAt: DateTime.now(),
			itemEndingAt: PLACEHOLDER_ENDING_AT()
		});

		return { status: 201 };
	} catch (err: any) {
		const message: string = err?.message ?? String(err);

		// optimistic.ts throws '...exceeded retry budget', lock.ts throws
		// '...retry budget exhausted' - "retry budget" is the substring
		// common to both.
		if (message.includes('retry budget')) {
			return { status: 409, body: { message } };
		}

		return { status: 400, body: { message } };
	}
};
