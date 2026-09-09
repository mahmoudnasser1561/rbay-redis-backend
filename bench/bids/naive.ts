import type { CreateBidAttrs } from '$services/types';
import { bidHistoryKey, itemsKey, itemsByPriceKey } from '$services/keys';
import { client } from '$services/redis';
import { DateTime } from 'luxon';
import { getItem } from '$services/queries/items/items';

// Benchmark-only reconstruction of createBid as it stood at commit 68b1220,
// before any concurrency guard existed. rPush (history) is unguarded and
// always appends; hSet (price/highestBidUserId) is a last-write-wins race.
// So under concurrent bids: history can show the true highest bid happened,
// while the item's authoritative price/winner reflects an earlier, lower one.
export const createBid = async (attrs: CreateBidAttrs) => {
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
		client.rPush(bidHistoryKey(attrs.itemId), serialized),
		client.hSet(itemsKey(item.id), {
			bids: item.bids + 1,
			price: attrs.amount,
			highestBidUserId: attrs.userId
		}),
		client.zAdd(itemsByPriceKey(), {
			value: item.id,
			score: attrs.amount
		})
	]);
};

const serializeHistory = (amount: number, createdAt: number) => {
	return `${amount}:${createdAt}`;
};
