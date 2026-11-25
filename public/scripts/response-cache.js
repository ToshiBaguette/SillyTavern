import { localforage } from '../lib.js';

/**
 * Client-side cache for large JSON responses of POST endpoints.
 *
 * Browsers only cache GET requests, so POST responses (like the character list) are downloaded
 * in full on every load, even when nothing changed. The server sends an ETag computed from the
 * response content (see sendJsonWithETag in src/express-common.js). This module keeps the last
 * response with its ETag, sends it back in If-None-Match and, on 304 Not Modified, rebuilds the
 * response from the stored copy: nothing but headers goes over the network.
 */
const store = localforage.createInstance({ name: 'SillyTavern_ResponseCache' });

/**
 * Fetches a JSON resource, reusing the stored copy if the server says it hasn't changed.
 * Returns a regular Response, so it can be used as a drop-in replacement for fetch().
 * @param {string} url Request URL
 * @param {RequestInit} [init] Fetch options
 * @returns {Promise<Response>} Response
 */
export async function fetchWithResponseCache(url, init = {}) {
    /** @type {{etag: string, body: string}|null} */
    let cached = null;
    try {
        cached = await store.getItem(url);
    } catch (error) {
        console.debug('Response cache: could not read', url, error);
    }

    const headers = new Headers(init.headers ?? {});
    const hasCachedCopy = typeof cached?.etag === 'string' && typeof cached?.body === 'string';
    if (hasCachedCopy) {
        headers.set('If-None-Match', cached.etag);
    }

    const response = await fetch(url, { ...init, headers });

    if (response.status === 304 && hasCachedCopy) {
        return new Response(cached.body, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'ETag': cached.etag },
        });
    }

    const etag = response.headers.get('ETag');
    if (!response.ok || !etag) {
        return response;
    }

    const body = await response.text();
    store.setItem(url, { etag, body }).catch(error => console.debug('Response cache: could not write', url, error));
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

/**
 * Removes all the stored responses (e.g. on logout).
 * @returns {Promise<void>}
 */
export async function clearResponseCache() {
    try {
        await store.clear();
    } catch (error) {
        console.debug('Response cache: could not clear', error);
    }
}
