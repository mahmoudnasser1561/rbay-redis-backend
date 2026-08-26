import type { CreateUserAttrs } from '$services/types';
import { genId } from '$services/utils';
import { client } from '$services/redis';
import { userCacheKey } from '$services/keys';
import { attr } from 'svelte/internal';

export const getUserByUsername = async (username: string) => {};

export const getUserById = async (id: string) => {
    const user = await client.hGetAll(userCacheKey(id));

    return deserialize(id, user);
};

export const createUser = async (attrs: CreateUserAttrs) => {
    const id = genId();
    await client.hSet(userCacheKey(id), serialize(attrs));
    
    return id;
};

const serialize = (user: CreateUserAttrs) => {
    return {
        username: user.username,
        password: user.password
    }
};

const deserialize = (id: string, user: { [key: string]: string })  => {
    return {
        id: id,
        user: user.username,
        password: user.password
    };
};