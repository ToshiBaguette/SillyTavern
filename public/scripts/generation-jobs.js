import { getRequestHeaders } from '../script.js';
import { t } from './i18n.js';
import { uuidv4 } from './utils.js';

/**
 * Client side of the server generation jobs (see `src/generation-jobs.js`).
 *
 * A streaming generation request is sent with a job ID header. If the server accepts it as a job,
 * the generation keeps running on the server even if the connection drops, and this module
 * transparently reconnects to the stream from the last received byte. Stopping the generation
 * is done explicitly through the abort endpoint, since closing the connection no longer aborts it.
 */

const JOB_HEADER = 'X-Generation-Job-Id';
const JOBS_ENDPOINT = '/api/backends/generation-jobs';

/** Delays between reconnection attempts when the stream is interrupted mid-generation (~2 minutes total). */
const STREAM_RECONNECT_DELAYS = [500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000, 15000, 15000, 15000, 15000];
/**
 * Delays between reconnection attempts when the request failed before any response was received.
 * Kept short, as the request may never have reached the server.
 */
const REQUEST_RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000];

/**
 * Error thrown when the generation job is no longer available on the server.
 */
class GenerationJobLostError extends Error {
    constructor() {
        super('Generation job is not available on the server');
        this.name = 'GenerationJobLostError';
    }
}

/**
 * @param {any} error Error
 * @param {AbortSignal} [signal] Request signal
 * @returns {boolean} True if the error was caused by the request being aborted
 */
function isAbortError(error, signal) {
    return Boolean(signal?.aborted) || error?.name === 'AbortError';
}

/**
 * Waits for the given amount of time, unless the signal is aborted.
 * @param {number} ms Delay in milliseconds
 * @param {AbortSignal} [signal] Abort signal
 * @returns {Promise<void>}
 */
function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        }
        const onAbort = () => {
            clearTimeout(timeout);
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Asks the server to abort a generation job.
 * @param {string} jobId Job ID
 */
export function abortGenerationJob(jobId) {
    fetch(`${JOBS_ENDPOINT}/abort`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: jobId }),
        keepalive: true,
    }).catch(error => console.warn('Failed to abort the generation job', error));
}

/**
 * Reattaches to the response stream of a generation job.
 * @param {string} jobId Job ID
 * @param {number} offset Number of bytes already received
 * @param {AbortSignal} [signal] Abort signal
 * @returns {Promise<Response>} Response with the stream continuing from the offset
 * @throws {GenerationJobLostError} If the job is no longer available on the server
 */
async function attachToGenerationJob(jobId, offset, signal) {
    const response = await fetch(`${JOBS_ENDPOINT}/stream`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: jobId, offset }),
        signal,
    });

    // The replayed stream mirrors the original response and carries the job header.
    // Without it, the error comes from the jobs endpoint itself (e.g. the job has expired or the server restarted).
    if (response.headers.get(JOB_HEADER) !== jobId) {
        throw new GenerationJobLostError();
    }

    return response;
}

/**
 * Tries to reattach to a generation job, retrying with a backoff while the server is unreachable.
 * @param {string} jobId Job ID
 * @param {number} offset Number of bytes already received
 * @param {number[]} delays Delays between attempts
 * @param {AbortSignal} [signal] Abort signal
 * @param {any} originalError Error that interrupted the stream, thrown if reconnection fails
 * @returns {Promise<Response>} Reattached response
 */
async function reconnectToGenerationJob(jobId, offset, delays, signal, originalError) {
    for (const delay of delays) {
        await abortableDelay(delay, signal);
        try {
            console.debug(`Reconnecting to generation job ${jobId} at offset ${offset}`);
            return await attachToGenerationJob(jobId, offset, signal);
        } catch (error) {
            if (isAbortError(error, signal)) {
                throw error;
            }
            if (error instanceof GenerationJobLostError) {
                console.warn(`Generation job ${jobId} is no longer available on the server`);
                throw originalError;
            }
            console.debug('Reconnection attempt failed', error);
        }
    }
    throw originalError;
}

/**
 * Sends a streaming generation request that survives connection drops.
 *
 * Drop-in replacement for `fetch` for streaming generation endpoints: the returned response body
 * reconnects to the server-side generation job when the connection is interrupted. If the server
 * doesn't support generation jobs, behaves like a regular `fetch`.
 * Aborting `options.signal` stops the generation on the server.
 * @param {string} url Generation endpoint URL
 * @param {RequestInit} options Fetch options
 * @returns {Promise<Response>} Response
 */
export async function fetchGenerationStream(url, options = {}) {
    const signal = options.signal ?? undefined;
    const jobId = uuidv4();
    const headers = new Headers(options.headers);
    headers.set(JOB_HEADER, jobId);

    const onAbort = () => abortGenerationJob(jobId);
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    /** @type {JQuery<HTMLElement> | null} */
    let reconnectToast = null;
    const showReconnectToast = () => {
        if (!reconnectToast) {
            reconnectToast = toastr.warning(t`Connection lost during the generation. Reconnecting...`, '', { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true });
        }
    };
    const hideReconnectToast = () => {
        if (reconnectToast) {
            toastr.clear(reconnectToast);
            reconnectToast = null;
        }
    };

    /** @type {Response} */
    let response;
    try {
        response = await fetch(url, { ...options, headers });
    } catch (error) {
        if (isAbortError(error, signal)) {
            throw error;
        }
        // The request may have reached the server even though the connection failed.
        console.warn('Generation request failed, trying to reattach to the generation job', error);
        showReconnectToast();
        try {
            response = await reconnectToGenerationJob(jobId, 0, REQUEST_RECONNECT_DELAYS, signal, error);
        } catch (reconnectError) {
            cleanup();
            hideReconnectToast();
            throw reconnectError;
        }
        hideReconnectToast();
    }

    // Not a generation job (feature disabled or unsupported endpoint), or an error response read by the caller.
    if (response.headers.get(JOB_HEADER) !== jobId || !response.ok || !response.body) {
        cleanup();
        return response;
    }

    let reader = response.body.getReader();
    let offset = 0;

    const body = new ReadableStream({
        async pull(controller) {
            while (true) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        cleanup();
                        controller.close();
                        return;
                    }
                    offset += value.byteLength;
                    controller.enqueue(value);
                    return;
                } catch (error) {
                    if (isAbortError(error, signal)) {
                        cleanup();
                        controller.error(error);
                        return;
                    }

                    console.warn(`Generation stream interrupted after ${offset} bytes, reconnecting...`, error);
                    showReconnectToast();
                    try {
                        const reattached = await reconnectToGenerationJob(jobId, offset, STREAM_RECONNECT_DELAYS, signal, error);
                        if (!reattached.body) {
                            throw error;
                        }
                        reader = reattached.body.getReader();
                        hideReconnectToast();
                        toastr.success(t`Reconnected to the generation.`);
                    } catch (reconnectError) {
                        cleanup();
                        hideReconnectToast();
                        controller.error(reconnectError);
                        return;
                    }
                }
            }
        },
        cancel(reason) {
            cleanup();
            hideReconnectToast();
            return reader.cancel(reason);
        },
    });

    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
