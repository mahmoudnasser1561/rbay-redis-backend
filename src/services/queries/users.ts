import type { CreateUserAttrs } from '$services/types';
import { genId } from '$services/utils';
import { client } from '$services/redis';
import { userCacheKey } from '$services/keys';
import { usernamesUniqueKey } from '$services/keys';
import { attr } from 'svelte/internal';

export const getUserByUsername = async (username: string) => {};

export const getUserById = async (id: string) => {
    const user = await client.hGetAll(userCacheKey(id));

    return deserialize(id, user);
};

export const createUser = async (attrs: CreateUserAttrs) => {
    const id = genId();

    const exists = await client.sIsMember(usernamesUniqueKey(), attrs.username);
    if (exists) {
        throw new Error('Username is taken');
    }

    await client.hSet(userCacheKey(id), serialize(attrs));
    await client.sAdd(usernamesUniqueKey(), attrs.username)
    
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
        username: user.username,
        password: user.password
    };
};