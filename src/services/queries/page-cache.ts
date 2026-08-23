import { pageCacheKey } from "$services/keys";
import { client } from "$services/redis";

const cachedRoutes = [
    '/about', '/privacy', '/auth/signin', '/auth/signup'
];

export const getCachedPage = (route: string) => {
    if (cachedRoutes.includes(route)) {
        client.get(pageCacheKey(route));
    }

    return null;
};

export const setCachedPage = (route: string, page: string) => {
    if (cachedRoutes.includes(route)) {
        return client.set(pageCacheKey(route), page, {
            // TODO: increase exp value
            EX: 2
        })
    }
};
