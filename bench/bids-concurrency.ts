// Experiment A: fires N concurrent bids (unique amounts 1..N, shuffled
// submission order) at one item, for each of the three strategies in
// bench/bids/, across 5 concurrency levels x 10 repeats. Oracle: whatever
// serialization order a correct implementation picks, the bidder with the
// globally maximum amount (N) always ends up accepted, since nothing
// processed before or after it can exceed it - so a correct final price is
// always exactly N, with no need to control processing order.
//
// Calls the strategies directly in-process (not through HTTP) - this
// isolates the concurrency-control mechanism itself from the HTTP/session
// overhead the no-op control (§1.0.3) already characterized separately.

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DateTime } from 'luxon';
import { createItem, getItem } from '$services/queries/items/items';
import { getBidHistory } from '$services/queries/bids';
import { createBid } from './bids';
import type { BidStrategy } from './bids';
import { resetRedis } from './reset';

const DEFAULT_STRATEGIES: BidStrategy[] = ['naive', 'optimistic', 'lock'];
const STRATEGIES: BidStrategy[] = process.env.BENCH_STRATEGIES
	? (process.env.BENCH_STRATEGIES.split(',') as BidStrategy[])
	: DEFAULT_STRATEGIES;
const CONCURRENCY_LEVELS = [10, 50, 100, 250, 500];
const REPEATS = 10;
const OUT_PATH = process.env.BENCH_OUT_PATH ?? 'bench/results/experiment-a.json';

interface BidAttempt {
	amount: number;
	accepted: boolean;
	errorMessage?: string;
	latencyMs: number;
}

interface RunResult {
	strategy: BidStrategy;
	concurrency: number;
	repeat: number;
	durationMs: number;
	acceptedCount: number;
	historyLength: number;
	finalPrice: number;
	priceDeficit: number;
	lostUpdates: number;
	duplicates: number;
	historyCountMismatch: boolean;
	invariantViolations: number;
	attempts: BidAttempt[];
	historyAmounts: number[];
}

const shuffle = <T,>(items: T[]): T[] => {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
};

const runOnce = async (
	strategy: BidStrategy,
	concurrency: number,
	repeat: number
): Promise<RunResult> => {
	await resetRedis();

	const itemId = await createItem(
		{
			name: `exp-a-${strategy}-${concurrency}-${repeat}`,
			imageUrl: '',
			description: '',
			createdAt: DateTime.now(),
			endingAt: DateTime.now().plus({ hours: 1 }),
			ownerId: 'exp-a-owner',
			highestBidUserId: '',
			status: 'active',
			price: 0,
			views: 0,
			likes: 0,
			bids: 0
		},
		'exp-a-owner'
	);

	const amounts = shuffle(Array.from({ length: concurrency }, (_, i) => i + 1));
	const maxAmount = concurrency;

	process.env.BID_STRATEGY = strategy;

	const startedAt = performance.now();
	const attempts: BidAttempt[] = await Promise.all(
		amounts.map(async (amount): Promise<BidAttempt> => {
			const t0 = performance.now();
			try {
				await createBid({
					itemId,
					userId: `bidder-${amount}`,
					amount,
					createdAt: DateTime.now(),
					itemEndingAt: DateTime.now().plus({ hours: 1 })
				});
				return { amount, accepted: true, latencyMs: performance.now() - t0 };
			} catch (err: any) {
				return {
					amount,
					accepted: false,
					errorMessage: err?.message ?? String(err),
					latencyMs: performance.now() - t0
				};
			}
		})
	);
	const durationMs = performance.now() - startedAt;

	const item = await getItem(itemId);
	const history = await getBidHistory(itemId, 0, concurrency);
	const historyAmounts = history.map((h) => h.amount);

	const acceptedCount = attempts.filter((a) => a.accepted).length;
	const historyCountMismatch = historyAmounts.length !== acceptedCount;

	const finalPrice = item?.price ?? 0;
	const priceDeficit = Math.max(0, maxAmount - finalPrice);

	let lostUpdates = 0;
	for (let i = 1; i < historyAmounts.length; i++) {
		if (historyAmounts[i] <= historyAmounts[i - 1]) lostUpdates++;
	}

	const seen = new Set<number>();
	let duplicates = 0;
	for (const amt of historyAmounts) {
		if (seen.has(amt)) duplicates++;
		else seen.add(amt);
	}

	const invariantViolations =
		(historyCountMismatch ? 1 : 0) + (priceDeficit > 0 ? 1 : 0) + lostUpdates + duplicates;

	return {
		strategy,
		concurrency,
		repeat,
		durationMs,
		acceptedCount,
		historyLength: historyAmounts.length,
		finalPrice,
		priceDeficit,
		lostUpdates,
		duplicates,
		historyCountMismatch,
		invariantViolations,
		attempts,
		historyAmounts
	};
};

const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const printSummary = (results: RunResult[]) => {
	console.log('\n=== summary (median across 10 repeats) ===');
	console.log(
		'strategy'.padEnd(12) +
			'N'.padEnd(6) +
			'price_deficit'.padEnd(16) +
			'lost_updates'.padEnd(15) +
			'violation_rate'.padEnd(16) +
			'duration_ms'
	);
	for (const strategy of STRATEGIES) {
		for (const concurrency of CONCURRENCY_LEVELS) {
			const group = results.filter(
				(r) => r.strategy === strategy && r.concurrency === concurrency
			);
			const deficits = group.map((r) => r.priceDeficit);
			const lost = group.map((r) => r.lostUpdates);
			const durations = group.map((r) => r.durationMs);
			const violationRate = group.filter((r) => r.invariantViolations > 0).length / group.length;

			console.log(
				strategy.padEnd(12) +
					String(concurrency).padEnd(6) +
					String(median(deficits)).padEnd(16) +
					String(median(lost)).padEnd(15) +
					`${(violationRate * 100).toFixed(0)}%`.padEnd(16) +
					median(durations).toFixed(0)
			);
		}
	}
};

const main = async () => {
	const totalRuns = STRATEGIES.length * CONCURRENCY_LEVELS.length * REPEATS;
	console.log(`Experiment A: ${totalRuns} runs (${STRATEGIES.join('/')}  x  N=${CONCURRENCY_LEVELS.join(',')}  x  ${REPEATS} repeats)\n`);

	const results: RunResult[] = [];
	let runIndex = 0;

	for (const strategy of STRATEGIES) {
		for (const concurrency of CONCURRENCY_LEVELS) {
			for (let repeat = 0; repeat < REPEATS; repeat++) {
				runIndex++;
				const result = await runOnce(strategy, concurrency, repeat);
				results.push(result);
				console.log(
					`[${runIndex}/${totalRuns}] ${strategy.padEnd(10)} N=${String(concurrency).padEnd(4)} rep=${repeat + 1}/${REPEATS}  ` +
						`price_deficit=${result.priceDeficit}  lost_updates=${result.lostUpdates}  ` +
						`duplicates=${result.duplicates}  history_mismatch=${result.historyCountMismatch}  ` +
						`accepted=${result.acceptedCount}/${concurrency}  ${result.durationMs.toFixed(0)}ms`
				);
			}
		}
	}

	mkdirSync('bench/results', { recursive: true });
	const outPath = OUT_PATH;
	writeFileSync(
		outPath,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				strategies: STRATEGIES,
				concurrencyLevels: CONCURRENCY_LEVELS,
				repeats: REPEATS,
				results
			},
			null,
			2
		)
	);
	console.log(`\nwrote ${outPath}`);

	printSummary(results);
	process.exit(0);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
