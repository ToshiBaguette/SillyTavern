/**
 * Startup request prefetching.
 *
 * The app initialization runs many steps sequentially, each one waiting for its own server
 * request. On a high-latency connection, every one of those round-trips adds up. To avoid this,
 * independent requests needed during initialization are started all at once as soon as the CSRF
 * token is known, and the initialization steps then consume the already in-flight responses.
 *
 * Each prefetched response can only be consumed once (a response body can only be read once).
 * Any later call falls back to a regular network request.
 */

/** @type {Map<string, Promise<Response>>} */
const prefetchedRequests = new Map();

/** @type {Map<string, any>} */
const startupData = new Map();

/**
 * Starts a request and keeps the pending response for a later consumption.
 * @param {string} url Request URL. Used as the key to retrieve the response.
 * @param {RequestInit} [init] Fetch options
 * @param {(url: string, init: RequestInit) => Promise<Response>} [fetcher] Function used to fetch
 * @returns {Promise<Response>} Pending response. Only peek at it with response.clone(), in a handler
 * attached right away (before the consumer reads the body).
 */
export function prefetchRequest(url, init = {}, fetcher = fetch) {
    if (prefetchedRequests.has(url)) {
        return prefetchedRequests.get(url);
    }

    const promise = fetcher(url, init);
    // Prevent unhandled rejection warnings; the error is surfaced to the consumer.
    promise.catch(() => { });
    prefetchedRequests.set(url, promise);
    return promise;
}

/**
 * Fetches a resource, using a prefetched response if one is available.
 * @param {string} url Request URL
 * @param {RequestInit} [init] Fetch options used if there's no prefetched response
 * @param {(url: string, init: RequestInit) => Promise<Response>} [fetcher] Function used to fetch if there's no prefetched response
 * @returns {Promise<Response>} Response
 */
export function fetchWithPrefetch(url, init = {}, fetcher = fetch) {
    const prefetched = prefetchedRequests.get(url);
    if (prefetched) {
        prefetchedRequests.delete(url);
        return prefetched;
    }
    return fetcher(url, init);
}

/**
 * Drops all prefetched responses and startup data that were not consumed, so that stale data is never used.
 */
export function clearPrefetchedRequests() {
    prefetchedRequests.clear();
    startupData.clear();
}

/**
 * Keeps a piece of data already received during initialization, so that other
 * initialization steps can reuse it instead of requesting it again.
 * @param {string} key Data key
 * @param {any} value Data value
 */
export function setStartupData(key, value) {
    startupData.set(key, value);
}

/**
 * Takes a piece of data stored during initialization. It can only be taken once.
 * @param {string} key Data key
 * @returns {any} Data value, or undefined if not available
 */
export function takeStartupData(key) {
    const value = startupData.get(key);
    startupData.delete(key);
    return value;
}
