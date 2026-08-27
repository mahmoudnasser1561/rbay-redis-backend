export const pageCacheKey = (id: string) => `pagecache#${id}`;
export const userCacheKey = (userId: string) => `users#${userId}`;
export const sessionCacheKey = (sessionId: string) => `sessions#${sessionCacheKey}`;
export const itemsKey = (itemId: string) => `items#${itemId}`;
export const usernamesUniqueKey = () => `usernames:unique`
export const userKeysLike = (userId: string) => `users:likes#${userId}`