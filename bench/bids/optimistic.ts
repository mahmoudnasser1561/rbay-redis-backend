import type { CreateBidAttrs } from '$services/types';
import { bidHistoryKey, itemsKey, itemsByPriceKey } from '$services/keys';
import { client } from '$services/redis';
import { DateTime } from 'luxon';
import { getItem } from '$services/queries/items/items';

// Benchmark-only reconstruction of createBid as it stood at commit 83b731c
// (WATCH/MULTI), with one addition: the original never retried when EXEC
// aborted on a watched-key conflict — it just returned null, and the route
// handler ignored the result and returned 201 anyway, so a conflicting bid
// silently vanished (no history entry, no price update) behind a false
// success response. For a fair comparison against the lock strategy, this
// gets the same retry budget the lock strategy is given: 5 attempts,
// jittered 5-25ms backoff (see bench/bids/lock.ts and the fairness note in
// the plan for §1.0.1).
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_RANGE: [number, number] = [5, 25];

export const createBid = async (attrs: CreateBidAttrs) => {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const result = await attemptBid(attrs);
		if (result !== null) {
			return result;
		}
		await pause(jitteredDelay(RETRY_DELAY_RANGE));
	}

	throw new Error('Bid conflict: exceeded retry budget');
};

const attemptBid = (attrs: CreateBidAttrs) => {
	return client.executeIsolated(async (isolatedClient) => {
		await isolatedClient.watch(itemsKey(attrs.itemId));

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

		return isolatedClient
			.multi()
			.rPush(bidHistoryKey(attrs.itemId), serialized)
			.hSet(itemsKey(item.id), {
				bids: item.bids + 1,
				price: attrs.amount,
				highestBidUserId: attrs.userId
			})
			.zAdd(itemsByPriceKey(), {
				value: item.id,
				score: attrs.amount
			})
			.exec();
	});
};

const serializeHistory = (amount: number, createdAt: number) => {
	return `${amount}:${createdAt}`;
};

const jitteredDelay = ([min, max]: [number, number]) => {
	return min + Math.random() * (max - min);
};

const pause = (duration: number) => {
	return new Promise((resolve) => setTimeout(resolve, duration));
};
