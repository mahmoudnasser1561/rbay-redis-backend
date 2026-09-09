import type { CreateBidAttrs } from '$services/types';
import { bidHistoryKey, itemsKey, itemsByPriceKey } from '$services/keys';
import { client, withLock } from '$services/redis';
import { DateTime } from 'luxon';
import { getItem } from '$services/queries/items/items';

// Historical comparison point: the lock strategy at production's real retry
// budget (withLock's defaults - 20 retries x fixed 100ms, no jitter), kept
// as its own standalone reconstruction (not a re-export from production
// bids.ts) so it keeps meaning "the lock config that was measured and
// rejected" regardless of what createBid does going forward. Measured
// result: worse on every axis than both the equalized-budget lock and
// optimistic - the fixed (unjittered) delay causes retrying bidders to
// synchronize into thundering-herd rounds, so the larger nominal budget
// doesn't translate into more successful admissions. This is why
// production was swapped to the optimistic strategy.
export const createBid = async (attrs: CreateBidAttrs) => {
	return withLock(attrs.itemId, async (lockedClient: typeof client, signal: any) => {
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

		await Promise.all([
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
	});
};

const serializeHistory = (amount: number, createdAt: number) => {
	return `${amount}:${createdAt}`;
};
