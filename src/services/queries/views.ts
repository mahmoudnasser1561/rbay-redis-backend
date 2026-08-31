import { client } from '$services/redis';
import { itemsKey, itemsByViewsKey, itemsViewsKey } from '$services/keys';
import { insert } from 'svelte/internal';

export const incrementView = async (itemId: string, userId: string) => {
	const inserted = await client.pfAdd(itemsViewsKey(itemId), userId);
	
	if (inserted) {
		return Promise.all([
			client.hIncrBy(itemsKey(itemId), 'views', 1),
			client.zIncrBy(itemsByViewsKey(), 1, itemId)
		]);
	}
};