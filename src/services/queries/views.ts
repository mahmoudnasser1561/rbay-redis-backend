import { client } from '$services/redis';
import { itemsKey, itemsByViewsKey, itemsViewsKey } from '$services/keys';
import { insert } from 'svelte/internal';

export const incrementView = async (itemId: string, userId: string) => {
	return client.incrementView(itemId, userId);
};