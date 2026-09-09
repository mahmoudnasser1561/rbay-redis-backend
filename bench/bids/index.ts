import type { CreateBidAttrs } from '$services/types';

export type BidStrategy = 'naive' | 'optimistic' | 'lock' | 'lock-prod-budget';

const STRATEGIES: BidStrategy[] = ['naive', 'optimistic', 'lock', 'lock-prod-budget'];

const resolveStrategy = (): BidStrategy => {
	const value = process.env.BID_STRATEGY;

	if (!value || !STRATEGIES.includes(value as BidStrategy)) {
		throw new Error(
			`BID_STRATEGY must be one of ${STRATEGIES.join(' | ')}, got: ${value ?? '(unset)'}`
		);
	}

	return value as BidStrategy;
};

const load = async (strategy: BidStrategy): Promise<(attrs: CreateBidAttrs) => Promise<unknown>> => {
	switch (strategy) {
		case 'naive':
			return (await import('./naive')).createBid;
		case 'optimistic':
			return (await import('./optimistic')).createBid;
		case 'lock':
			return (await import('./lock')).createBid;
		case 'lock-prod-budget':
			return (await import('./lock-prod-budget')).createBid;
	}
};

export const createBid = async (attrs: CreateBidAttrs) => {
	const strategy = resolveStrategy();
	const impl = await load(strategy);
	return impl(attrs);
};
