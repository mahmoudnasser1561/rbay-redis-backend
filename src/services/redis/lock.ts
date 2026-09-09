import { error } from 'console';
import { client } from './client';
import { randomBytes } from 'crypto';

interface WithLockOpts {
	retries?: number;
	retryDelayMs?: number | [number, number];
	timeoutMs?: number;
}

export const withLock = async (
	key: string,
	cb: (redisClient: Client, signal: any) => any,
	opts: WithLockOpts = {}
) => {
	// Initialize a few variables to control retry behavior
	const retryDelayMs = opts.retryDelayMs ?? 100;
	let retries = opts.retries ?? 20;
	const timeoutMs = opts.timeoutMs ?? 2000;

	// Generate a random value to store at the lock key
	const token = randomBytes(6).toString('hex');
	// Create the lock key
	const lockKey = `lock:${key}`;

	// Set up a while loop to implement the retry behavior
	while (retries >= 0) {
		retries--;
		// Try to do a SET NX operation
		const acquired = await client.set(lockKey, token, {
			NX: true,
			PX: timeoutMs
		});

		if (!acquired) {
			// ELSE brief pause and then retry, jittered when a [min, max] range is given
			await pause(resolveDelay(retryDelayMs));
			continue;
		}

		// IF the set is successful, then run the callback
		try {
			const signal = { expired: false };
			// setTimeout(() => {
			// 	signal.expired = true;
			// }, timeoutMs)

			const proxiedClient = buildClientProxy(timeoutMs);
			const result = await cb(proxiedClient, 	signal);
			return result;
		} finally {
			await client.unlock(lockKey, token)
		}
	}
};

type Client = typeof client;
const buildClientProxy = (timeoutMs: number) => {
	const startTime = Date.now();

	const handler = {
		get(target: Client, prop: keyof Client) {
			if (Date.now() >= startTime + timeoutMs) {
				throw new Error('Lock has expired.');
			}

			const value = target[prop];
			return typeof value == 'function' ? value.bind(target) : value;
		}
	}

	return new Proxy(client, handler) as Client;
};

const pause = (duration: number) => {
	return new Promise((resolve) => {
		setTimeout(resolve, duration);
	});
};

const resolveDelay = (delay: number | [number, number]) => {
	if (!Array.isArray(delay)) return delay;
	const [min, max] = delay;
	return min + Math.random() * (max - min);
};