import type { RequestHandler } from '@sveltejs/kit';

// Benchmark control (§1.0.3): shaped like the real bid endpoint's request/response
// cycle but does no Redis work of its own. Still runs through the global session
// middleware (src/hooks.ts), so this measures the framework + session-Redis floor
// every request pays, not literally zero Redis.
export const post: RequestHandler<any> = async ({ request }) => {
	await request.json();

	return {
		status: 201
	};
};
