// Experiment C1: exact Redis command counts per operation, via
// CONFIG RESETSTAT -> N sequential ops -> INFO commandstats -> parse
// calls= per command, divided by N. Deterministic and immune to timing
// noise - unlike a stopwatch, this can't be thrown off by scheduler
// jitter, so it's the number that belongs in a CI regression gate as
// well as a resume bullet.
//
// IMPORTANT: INFO commandstats counts command EXECUTIONS, including ones
// invoked from inside a Lua script via redis.call() - confirmed directly
// (EVAL running SET+GET produces separate cmdstat_eval, cmdstat_set, and
// cmdstat_get entries, all with calls=1). So the raw total is NOT the
// same thing as "client-server round trips" - a script's internal calls
// don't cost the client an extra network hop. Client round trips are
// computed per scenario below using only the commands the client itself
// issues (evalsha/eval for the scripted path; every command for the
// unscripted paths, since none of them involve server-side scripting).
// The full raw breakdown is saved alongside the computed number so the
// reasoning is checkable, not just asserted.
//
// Three measurements, all sequential/uncontended (no retries possible,
// so the count per op can't vary run to run):
//  1. incrementView: the real Lua script (src/services/redis/client.ts).
//  2. incrementView (naive): PFADD + HINCRBY + ZINCRBY as three separate
//     unscripted round trips, same net effect.
//  3. The bid path: production's actual createBid (optimistic
//     WATCH/MULTI) under zero contention - not a comparison against
//     another implementation, just the real shipped round-trip cost.

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { DateTime } from 'luxon';
import { client } from '$services/redis';
import { itemsViewsKey, itemsKey, itemsByViewsKey } from '$services/keys';
import { createItem } from '$services/queries/items/items';
import { createBid } from '$services/queries/bids';
import { resetRedis } from './reset';

const N = 1000;

const naiveIncrementView = async (itemId: string, userId: string) => {
	const inserted = await client.pfAdd(itemsViewsKey(itemId), userId);
	if (inserted) {
		await client.hIncrBy(itemsKey(itemId), 'views', 1);
		await client.zIncrBy(itemsByViewsKey(), 1, itemId);
	}
};

type Breakdown = Record<string, number>;

const commandBreakdown = async (): Promise<Breakdown> => {
	const raw = await client.info('commandstats');
	const breakdown: Breakdown = {};
	for (const line of raw.split('\n')) {
		const match = line.match(/^cmdstat_([a-z0-9_|]+):calls=(\d+)/);
		if (match) breakdown[match[1]] = parseInt(match[2], 10);
	}
	return breakdown;
};

interface MeasureResult {
	label: string;
	clientRoundTrips: number;
	roundTripsPerOp: number;
	rawBreakdown: Breakdown;
}

const measure = async (
	label: string,
	roundTripCommands: string[],
	run: () => Promise<void>
): Promise<MeasureResult> => {
	await client.configResetStat();
	for (let i = 0; i < N; i++) {
		await run();
	}
	const rawBreakdown = await commandBreakdown();

	const clientRoundTrips = roundTripCommands.reduce((sum, cmd) => sum + (rawBreakdown[cmd] ?? 0), 0);
	const roundTripsPerOp = clientRoundTrips / N;

	console.log(`${label}:`);
	console.log(`  raw breakdown: ${JSON.stringify(rawBreakdown)}`);
	console.log(
		`  client round trips (${roundTripCommands.join('+')}) = ${clientRoundTrips} / ${N} ops = ${roundTripsPerOp.toFixed(3)}/op\n`
	);

	return { label, clientRoundTrips, roundTripsPerOp, rawBreakdown };
};

const freshItemId = async () => {
	return createItem(
		{
			name: 'c1-bench-item',
			imageUrl: '',
			description: '',
			createdAt: DateTime.now(),
			endingAt: DateTime.now().plus({ hours: 1 }),
			ownerId: 'c1-owner',
			highestBidUserId: '',
			status: 'active',
			price: 0,
			views: 0,
			likes: 0,
			bids: 0
		},
		'c1-owner'
	);
};

const main = async () => {
	console.log(`Experiment C1: exact command counts over ${N} sequential ops\n`);
	const results: MeasureResult[] = [];

	// --- incrementView: Lua vs naive ---
	await resetRedis();
	const luaItemId = await freshItemId();
	// warm the script cache first so all N measured calls are clean EVALSHA
	// hits, not skewed by a one-off EVAL-on-cache-miss fallback
	await client.incrementView(luaItemId, 'warmup');
	let luaViewer = 0;
	results.push(
		await measure('incrementView (Lua script)', ['evalsha', 'eval'], async () => {
			luaViewer++;
			await client.incrementView(luaItemId, `viewer-${luaViewer}`);
		})
	);

	await resetRedis();
	const naiveItemId = await freshItemId();
	let naiveViewer = 0;
	results.push(
		await measure(
			'incrementView (naive, 3 unscripted commands)',
			['pfadd', 'hincrby', 'zincrby'],
			async () => {
				naiveViewer++;
				await naiveIncrementView(naiveItemId, `viewer-${naiveViewer}`);
			}
		)
	);

	// --- bid path: production's real createBid, zero contention ---
	// Pre-create all N items OUTSIDE the measurement window so createItem's
	// own commands don't pollute the bid-path count.
	await resetRedis();
	const bidItemIds: string[] = [];
	for (let i = 0; i < N; i++) {
		bidItemIds.push(await freshItemId());
	}
	let bidIndex = 0;
	results.push(
		await measure(
			'createBid (production, uncontended)',
			['watch', 'hgetall', 'multi', 'rpush', 'hset', 'zadd', 'exec', 'auth'],
			async () => {
				const itemId = bidItemIds[bidIndex++];
				await createBid({
					itemId,
					userId: 'c1-bidder',
					amount: 10,
					createdAt: DateTime.now(),
					itemEndingAt: DateTime.now().plus({ hours: 1 })
				});
			}
		)
	);

	mkdirSync('bench/results', { recursive: true });
	const outPath = 'bench/results/experiment-c1.json';
	writeFileSync(
		outPath,
		JSON.stringify({ generatedAt: new Date().toISOString(), opsPerMeasurement: N, results }, null, 2)
	);
	console.log(`wrote ${outPath}`);

	process.exit(0);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
