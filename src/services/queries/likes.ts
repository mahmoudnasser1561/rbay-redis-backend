import { client } from "$services/redis";
import { userKeysLike, itemsKey } from "$services/keys";
import { insert } from "svelte/internal";

export const userLikesItem = async (itemId: string, userId: string) => {
    return client.sIsMember(userKeysLike(userId), itemId)
};

export const likedItems = async (userId: string) => {};

export const likeItem = async (itemId: string, userId: string) => {
    const inserted = await client.sAdd(userKeysLike(userId), itemId);

    if (inserted) {
        return client.hIncrBy(itemsKey(itemId), 'likes', 1);
    }
};

export const unlikeItem = async (itemId: string, userId: string) => {
    const removed = await client.sRem(userKeysLike(userId), itemId);

    if (removed) {
        return client.hIncrBy(itemsKey(itemId), 'likes', -1);
    }
};

export const commonLikedItems = async (userOneId: string, userTwoId: string) => {};
