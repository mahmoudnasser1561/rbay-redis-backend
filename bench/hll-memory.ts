// Experiment D: memory + accuracy tradeoff of HyperLogLog vs. a plain Set
// for unique-viewer tracking, at 1k/10k/100k/1M scale. Mirrors the app's
// real key pattern (itemsViewsKey) for the HLL side; the Set side is the
// hypothetical alternative the app doesn't actually use.
//
// IDs are deterministic 8-hex-char strings (not genId(), which is only
// 3 bytes/6 hex chars - far too small a space to guarantee zero collisions
// at 1M draws, which would corrupt the true-cardinality oracle this
// experiment depends on). 8 hex chars matches this app's actual session-ID
// byte length (randomBytes(4) in use-session.ts), so the Set's memory
// footprint stays realistic.

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { client } from '$services/redis';
import { itemsViewsKey } from '$services/keys';
import { resetRedis } from './reset';

const SCALES = [1_000, 10_000, 100_000, 1_000_000];
const BATCH_SIZE = 10_000;

const HLL_KEY = itemsViewsKey('bench-item');
const SET_KEY = 'bench:set-views#bench-item';

interface ScaleResult {
	scale: number;
	hllMemoryBytes: number;
	setMemoryBytes: number;
	pfCount: number;
	relativeErrorPct: number;
}

const idFor = (i: number) => i.toString(16).padStart(8, '0');

const populate = async (scale: number) => {
	for (let start = 0; start < scale; start += BATCH_SIZE) {
		const end = Math.min(start + BATCH_SIZE, scale);
		const batch = Array.from({ length: end - start }, (_, i) => idFor(start + i));
		await Promise.all([client.pfAdd(HLL_KEY, batch), client.sAdd(SET_KEY, batch)]);
	}
};

const runScale = async (scale: number): Promise<ScaleResult> => {
	await resetRedis();
	await populate(scale);

	const [hllMemoryBytes, setMemoryBytes, pfCount] = await Promise.all([
		client.memoryUsage(HLL_KEY),
		client.memoryUsage(SET_KEY),
		client.pfCount(HLL_KEY)
	]);

	const relativeErrorPct = (Math.abs(pfCount - scale) / scale) * 100;

	return {
		scale,
		hllMemoryBytes: hllMemoryBytes ?? 0,
		setMemoryBytes: setMemoryBytes ?? 0,
		pfCount,
		relativeErrorPct
	};
};

const main = async () => {
	console.log(`Experiment D: HyperLogLog vs Set at scales ${SCALES.join(', ')}\n`);

	const results: ScaleResult[] = [];
	for (const scale of SCALES) {
		console.log(`running scale=${scale}...`);
		const result = await runScale(scale);
		results.push(result);
		console.log(
			`  hll=${result.hllMemoryBytes}B  set=${result.setMemoryBytes}B  ` +
				`pfCount=${result.pfCount} (true=${scale})  error=${result.relativeErrorPct.toFixed(3)}%\n`
		);
	}

	mkdirSync('bench/results', { recursive: true });
	const outPath = 'bench/results/experiment-d.json';
	writeFileSync(
		outPath,
		JSON.stringify({ generatedAt: new Date().toISOString(), scales: SCALES, results }, null, 2)
	);
	console.log(`wrote ${outPath}\n`);

	console.log('=== summary ===');
	console.log(
		'scale'.padEnd(10) +
			'hll_bytes'.padEnd(12) +
			'set_bytes'.padEnd(12) +
			'ratio'.padEnd(10) +
			'error_pct'
	);
	for (const r of results) {
		const ratio = r.setMemoryBytes / r.hllMemoryBytes;
		console.log(
			String(r.scale).padEnd(10) +
				String(r.hllMemoryBytes).padEnd(12) +
				String(r.setMemoryBytes).padEnd(12) +
				`${ratio.toFixed(1)}x`.padEnd(10) +
				`${r.relativeErrorPct.toFixed(3)}%`
		);
	}

	process.exit(0);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
