import type { CreateBidAttrs, Bid } from '$services/types';
import { bidHistoryKey, itemsKey, itemsByPriceKey } from '$services/keys';
import { client } from '$services/redis';
import { DateTime } from 'luxon';
import { getItem } from './items';

// Optimistic (WATCH/MULTI) concurrency control, not a lock. Measured
// against a distributed lock (both the fairness-equalized and production's
// real retry budget) in bench/bids/ - optimistic held zero lost updates and
// zero price deficit at every tested concurrency level up to 500 concurrent
// bidders on one item, while both lock configurations degraded under
// contention. See bench/results/experiment-a.json and
// bench/results/experiment-a-lock-prod-budget.json for the raw numbers.
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

const jitteredDelay = ([min, max]: [number, number]) => {
	return min + Math.random() * (max - min);
};

const pause = (duration: number) => {
	return new Promise((resolve) => setTimeout(resolve, duration));
};

export const getBidHistory = async (itemId: string, offset = 0, count = 10): Promise<Bid[]> => {
	const startIndex = -1 * offset  - count;
	const endIndex = -1 - offset;

	const range = await client.lRange(
		bidHistoryKey(itemId),
		startIndex,
		endIndex
	)

	return range.map(bid => deserializeHistory(bid));
};

const serializeHistory = (amount: number, createdAt: number) => {
	return `${amount}:${createdAt}`;
};

const deserializeHistory = (stored: string) => {
	const [amount, createdAt] = stored.split(":");

	return {
		amount: parseFloat(amount),
		createdAt: DateTime.fromMillis(parseInt(createdAt))
	};
};