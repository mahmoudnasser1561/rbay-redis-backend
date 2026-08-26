export const pageCacheKey = (id: string) => `pagecache#${id}`;

export const userCacheKey = (userId: string) => `users#${userId}`;

export const sessionCacheKey = (sessionId: string) => `sessions#${sessionCacheKey}`;