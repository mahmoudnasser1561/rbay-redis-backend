import type { CreateBidAttrs } from '$services/types';
import { bidHistoryKey, itemsKey, itemsByPriceKey } from '$services/keys';
import { client, withLock } from '$services/redis';
import { DateTime } from 'luxon';
import { getItem } from '$services/queries/items/items';

// Benchmark variant of the current production lock strategy
// (src/services/queries/bids.ts), reconstructed here rather than imported
// directly so it can be given the same 5-attempt/5-25ms-jitter retry budget
// as bench/bids/optimistic.ts — production's real withLock defaults to 20
// retries at a fixed 100ms, which would make "lock beats optimistic" partly
// a function of a much larger retry allowance rather than the mechanism
// itself. See the fairness note in the plan for §1.0.1.
//
// NOTE: faithfully reproduces a bug present in production — the three writes
// below are fired via Promise.all but not awaited/returned, so withLock's
// `finally` can release the lock before they've actually settled. Left
// as-is deliberately: this benchmark is measuring what's actually shipped.
const RETRY_OPTS = { retries: 5, retryDelayMs: [5, 25] as [number, number] };

export const createBid = async (attrs: CreateBidAttrs) => {
	return withLock(
		attrs.itemId,
		async (lockedClient: typeof client, signal: any) => {
			const item = await getItem(attrs.itemId);
			if (!item) {
				throw new Error('Item does not exist');
			}

			if (item.price >= attrs.amount) {
				throw new Error('Bid too low');
			}

			if (item.endingAt.diff(DateTime.now()).toMillis() < 0) {
				throw new Error('Item closed to bidding');
			}

			const serialized = serializeHistory(attrs.amount, attrs.createdAt.toMillis());

			Promise.all([
				lockedClient.rPush(bidHistoryKey(attrs.itemId), serialized),
				lockedClient.hSet(itemsKey(item.id), {
					bids: item.bids + 1,
					price: attrs.amount,
					highestBidUserId: attrs.userId
				}),
				lockedClient.zAdd(itemsByPriceKey(), {
					value: item.id,
					score: attrs.amount
				})
			]);
		},
		RETRY_OPTS
	);
};

const serializeHistory = (amount: number, createdAt: number) => {
	return `${amount}:${createdAt}`;
};
