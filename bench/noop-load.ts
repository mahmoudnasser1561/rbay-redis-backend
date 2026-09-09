// §1.0.3 no-op control: establishes the throughput/latency ceiling imposed by
// SvelteKit's request pipeline + session middleware, independent of any bid
// concurrency strategy. Every later experiment's results get compared against
// this baseline to catch the app's own HTTP-layer bottleneck rather than
// mistaking it for a real strategy difference.

import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const BASE_URL = process.env.BENCH_BASE_URL ?? 'http://localhost:3000';
const ENDPOINT = `${BASE_URL}/bench/noop`;
const CONCURRENCY_LEVELS = [1, 10, 50, 100, 250, 500];
const REPEATS_PER_LEVEL = 3;

interface RequestResult {
	ok: boolean;
	latencyMs: number;
}

interface LevelResult {
	concurrency: number;
	repeats: number;
	totalRequests: number;
	failedRequests: number;
	throughputReqPerSec: {
		perRepeat: number[];
		median: number;
	};
	latencyMs: {
		p50: number;
		p95: number;
		p99: number;
	};
}

const percentile = (sorted: number[], p: number): number => {
	if (sorted.length === 0) return NaN;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)];
};

const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const fireOne = async (): Promise<RequestResult> => {
	const start = performance.now();
	try {
		const res = await fetch(ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		});
		const latencyMs = performance.now() - start;
		return { ok: res.status === 201, latencyMs };
	} catch {
		return { ok: false, latencyMs: performance.now() - start };
	}
};

const runLevel = async (concurrency: number): Promise<LevelResult> => {
	const allLatencies: number[] = [];
	const throughputPerRepeat: number[] = [];
	let failedRequests = 0;

	for (let repeat = 0; repeat < REPEATS_PER_LEVEL; repeat++) {
		const batchStart = performance.now();
		const results = await Promise.all(Array.from({ length: concurrency }, () => fireOne()));
		const batchDurationSec = (performance.now() - batchStart) / 1000;

		throughputPerRepeat.push(concurrency / batchDurationSec);

		for (const r of results) {
			allLatencies.push(r.latencyMs);
			if (!r.ok) failedRequests++;
		}
	}

	const sortedLatencies = [...allLatencies].sort((a, b) => a - b);

	return {
		concurrency,
		repeats: REPEATS_PER_LEVEL,
		totalRequests: allLatencies.length,
		failedRequests,
		throughputReqPerSec: {
			perRepeat: throughputPerRepeat.map((v) => Math.round(v * 100) / 100),
			median: Math.round(median(throughputPerRepeat) * 100) / 100
		},
		latencyMs: {
			p50: Math.round(percentile(sortedLatencies, 50) * 100) / 100,
			p95: Math.round(percentile(sortedLatencies, 95) * 100) / 100,
			p99: Math.round(percentile(sortedLatencies, 99) * 100) / 100
		}
	};
};

const main = async () => {
	console.log(`no-op control load test against ${ENDPOINT}`);
	console.log(`concurrency levels: ${CONCURRENCY_LEVELS.join(', ')} | ${REPEATS_PER_LEVEL} repeats each\n`);

	const results: LevelResult[] = [];

	for (const concurrency of CONCURRENCY_LEVELS) {
		process.stdout.write(`  N=${concurrency}... `);
		const result = await runLevel(concurrency);
		results.push(result);
		console.log(
			`throughput=${result.throughputReqPerSec.median} req/s  p50=${result.latencyMs.p50}ms  p95=${result.latencyMs.p95}ms  p99=${result.latencyMs.p99}ms  failed=${result.failedRequests}/${result.totalRequests}`
		);
	}

	mkdirSync('bench/results', { recursive: true });
	const outPath = 'bench/results/noop-baseline.json';
	writeFileSync(
		outPath,
		JSON.stringify(
			{
				endpoint: ENDPOINT,
				generatedAt: new Date().toISOString(),
				concurrencyLevels: CONCURRENCY_LEVELS,
				repeatsPerLevel: REPEATS_PER_LEVEL,
				results
			},
			null,
			2
		)
	);

	console.log(`\nwrote ${outPath}`);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
