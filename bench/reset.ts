import 'dotenv/config';
import { client } from '$services/redis';
import { createIndexes } from '$services/redis/create-indexes';

// §1.0.2 minimal deterministic reset: FLUSHALL wipes the RediSearch index
// along with everything else, so it has to be recreated explicitly here -
// createIndexes normally only runs once, on the client's 'connect' event,
// which already fired before this script's FLUSHALL call.
const run = async () => {
	console.log(`flushing redis at ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);

	await client.flushAll();
	console.log('FLUSHALL done');

	try {
		// client.ts's own 'connect' handler also calls createIndexes()
		// automatically and unawaited, so it can race this call right after
		// FLUSHALL - both may see the index missing and both attempt to
		// create it. Harmless either way: by the time one of them loses
		// with "Index already exists", the index already exists.
		await createIndexes();
		console.log('idx:items recreated');
	} catch (err: any) {
		if (String(err?.message).includes('Index already exists')) {
			console.log('idx:items recreated (won by the client\'s auto-create-on-connect)');
		} else {
			throw err;
		}
	}

	process.exit(0);
};

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
