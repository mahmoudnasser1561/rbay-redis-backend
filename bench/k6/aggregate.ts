// Post-processes the raw k6 JSONL streams from run-protocol.sh into
// bench/results/experiment-b.json: warmup-discard (k6 OSS has no native
// way to exclude a warmup window from its summary), then median + IQR
// across the 5 repeats per (strategy, concurrency) config, per the spec's
// "report median and IQR - never a single run."
//
// "Test start" for the 30s warmup cutoff is taken as the earliest timestamp
// among samples tagged name:bid (the actual bid requests, set in
// contention.js) - NOT the file's overall earliest timestamp, which would
// incorrectly be pulled earlier by setup()'s /bench/create-item calls
// (those aren't tagged name:bid, so they're excluded from every metric here
// automatically, not just the warmup cutoff).

import { createReadStream, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';

const RAW_DIR = 'bench/results/k6-raw';
const WARMUP_MS = 30_000;
const MEASURED_WINDOW_SEC = 60;

interface Point {
	metric: string;
	data: { time: string; value: number; tags?: Record<string, string> };
}

interface RunMetrics {
	strategy: string;
	concurrency: number;
	repeat: number;
	throughputReqPerSec: number;
	p50: number;
	p95: number;
	p99: number;
	accepted: number;
	tooLow: number;
	retryExhausted: number;
	otherError: number;
}

const percentile = (sorted: number[], p: number): number => {
	if (sorted.length === 0) return NaN;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)];
};

const median = (values: number[]): number => percentile([...values].sort((a, b) => a - b), 50);
const iqr = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return percentile(sorted, 75) - percentile(sorted, 25);
};

const parseFilename = (file: string) => {
	// hot-<strategy>-N<concurrency>-rep<repeat>.json
	const match = basename(file, '.json').match(/^hot-(\w+)-N(\d+)-rep(\d+)$/);
	if (!match) return null;
	return { strategy: match[1], concurrency: parseInt(match[2], 10), repeat: parseInt(match[3], 10) };
};

const processFile = async (filePath: string): Promise<Point[]> => {
	const points: Point[] = [];
	const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		try {
			points.push(JSON.parse(line));
		} catch {
			// k6's json output can include non-Point lines (e.g. metadata) - skip anything unparseable
		}
	}
	return points;
};

const analyzeRun = (points: Point[], meta: { strategy: string; concurrency: number; repeat: number }): RunMetrics => {
	const bidReqDurations = points.filter(
		(p) => p.metric === 'http_req_duration' && p.data.tags?.name === 'bid'
	);

	if (bidReqDurations.length === 0) {
		throw new Error(`no name:bid http_req_duration samples found for ${JSON.stringify(meta)}`);
	}

	const testStart = Math.min(...bidReqDurations.map((p) => new Date(p.data.time).getTime()));
	const measuredCutoff = testStart + WARMUP_MS;

	const inWindow = (p: Point) => new Date(p.data.time).getTime() >= measuredCutoff;

	const measuredDurations = bidReqDurations.filter(inWindow).map((p) => p.data.value);
	const sortedDurations = [...measuredDurations].sort((a, b) => a - b);

	const countMetric = (name: string) =>
		points.filter((p) => p.metric === name && inWindow(p)).length;

	return {
		...meta,
		throughputReqPerSec: measuredDurations.length / MEASURED_WINDOW_SEC,
		p50: percentile(sortedDurations, 50),
		p95: percentile(sortedDurations, 95),
		p99: percentile(sortedDurations, 99),
		accepted: countMetric('bid_accepted'),
		tooLow: countMetric('bid_too_low'),
		retryExhausted: countMetric('bid_retry_exhausted'),
		otherError: countMetric('bid_other_error')
	};
};

interface GroupSummary {
	strategy: string;
	concurrency: number;
	repeats: number;
	throughputReqPerSec: { median: number; iqr: number };
	p50: { median: number; iqr: number };
	p95: { median: number; iqr: number };
	p99: { median: number; iqr: number };
	accepted: { median: number; iqr: number };
	tooLow: { median: number; iqr: number };
	retryExhausted: { median: number; iqr: number };
	otherError: { median: number; iqr: number };
}

const summarizeGroup = (runs: RunMetrics[]): GroupSummary => {
	const field = (key: keyof RunMetrics) => runs.map((r) => r[key] as number);
	const stat = (key: keyof RunMetrics) => {
		const values = field(key);
		return { median: median(values), iqr: iqr(values) };
	};

	return {
		strategy: runs[0].strategy,
		concurrency: runs[0].concurrency,
		repeats: runs.length,
		throughputReqPerSec: stat('throughputReqPerSec'),
		p50: stat('p50'),
		p95: stat('p95'),
		p99: stat('p99'),
		accepted: stat('accepted'),
		tooLow: stat('tooLow'),
		retryExhausted: stat('retryExhausted'),
		otherError: stat('otherError')
	};
};

const main = async () => {
	const files = readdirSync(RAW_DIR).filter((f) => f.endsWith('.json'));
	console.log(`found ${files.length} raw run files in ${RAW_DIR}`);

	const runs: RunMetrics[] = [];
	for (const file of files) {
		const meta = parseFilename(file);
		if (!meta) {
			console.log(`  skipping unrecognized filename: ${file}`);
			continue;
		}
		const points = await processFile(join(RAW_DIR, file));
		const metrics = analyzeRun(points, meta);
		runs.push(metrics);
		console.log(
			`  ${file}: throughput=${metrics.throughputReqPerSec.toFixed(1)}/s p50=${metrics.p50.toFixed(1)}ms ` +
				`p95=${metrics.p95.toFixed(1)}ms accepted=${metrics.accepted} tooLow=${metrics.tooLow} ` +
				`retryExhausted=${metrics.retryExhausted} otherError=${metrics.otherError}`
		);
	}

	const groups = new Map<string, RunMetrics[]>();
	for (const run of runs) {
		const key = `${run.strategy}|${run.concurrency}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(run);
	}

	const summaries = [...groups.values()].map(summarizeGroup);
	summaries.sort((a, b) => a.strategy.localeCompare(b.strategy) || a.concurrency - b.concurrency);

	mkdirSync('bench/results', { recursive: true });
	writeFileSync(
		'bench/results/experiment-b.json',
		JSON.stringify({ generatedAt: new Date().toISOString(), warmupMs: WARMUP_MS, measuredWindowSec: MEASURED_WINDOW_SEC, runs, summaries }, null, 2)
	);

	console.log('\n=== summary (median [IQR] across repeats) ===');
	console.log('strategy'.padEnd(12) + 'N'.padEnd(6) + 'throughput/s'.padEnd(18) + 'p50 ms'.padEnd(14) + 'p95 ms'.padEnd(14) + 'retry_exhausted');
	for (const s of summaries) {
		console.log(
			s.strategy.padEnd(12) +
				String(s.concurrency).padEnd(6) +
				`${s.throughputReqPerSec.median.toFixed(1)} [${s.throughputReqPerSec.iqr.toFixed(1)}]`.padEnd(18) +
				`${s.p50.median.toFixed(1)} [${s.p50.iqr.toFixed(1)}]`.padEnd(14) +
				`${s.p95.median.toFixed(1)} [${s.p95.iqr.toFixed(1)}]`.padEnd(14) +
				`${s.retryExhausted.median.toFixed(1)} [${s.retryExhausted.iqr.toFixed(1)}]`
		);
	}

	console.log('\nwrote bench/results/experiment-b.json');
	process.exit(0);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
