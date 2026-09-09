import type { RequestHandler } from '@sveltejs/kit';
import { DateTime } from 'luxon';
import { createItem } from '$services/queries/items/items';

// Experiment B groundwork: k6's setup() can only make HTTP calls, not import
// this project's TS/Redis code, so item creation for both the "hot item" and
// "spread" workloads has to happen via a request to this route.
export const post: RequestHandler<any> = async () => {
	const itemId = await createItem(
		{
			name: 'k6-bench-item',
			imageUrl: '',
			description: '',
			createdAt: DateTime.now(),
			endingAt: DateTime.now().plus({ hours: 1 }),
			ownerId: 'k6-bench-owner',
			highestBidUserId: '',
			status: 'active',
			price: 0,
			views: 0,
			likes: 0,
			bids: 0
		},
		'k6-bench-owner'
	);

	return {
		status: 201,
		body: { itemId }
	};
};
