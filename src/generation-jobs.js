import express from 'express';
import bytes from 'bytes';

import { getConfigValue } from './util.js';

/**
 * Generation jobs decouple an LLM generation request from the HTTP connection of the client that started it.
 *
 * When the client sends the {@link GENERATION_JOB_HEADER} header with a generation request, the server:
 * - keeps the upstream request running even if the client connection is closed;
 * - records everything written to the client response into a buffer;
 * - lets the client reattach to the response stream from a given byte offset;
 * - only aborts the upstream request when explicitly asked to via the abort endpoint.
 *
 * Requests without the header keep the legacy behavior: the upstream request is aborted when the client disconnects.
 */

export const GENERATION_JOB_HEADER = 'X-Generation-Job-Id';

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const ENABLED = !!getConfigValue('generationJobs.enabled', true, 'boolean');
const RETENTION_MS = Math.max(0, Number(getConfigValue('generationJobs.retentionSeconds', 300, 'number'))) * 1000;
const MAX_JOB_SIZE = bytes.parse(getConfigValue('generationJobs.maxJobSize', '16mb')) || 0;
const MAX_JOBS_PER_USER = Math.max(1, Number(getConfigValue('generationJobs.maxJobsPerUser', 20, 'number')));
/** Hard limit on how long a job may stay running, as a safety net against leaks. */
const MAX_RUNNING_MS = 60 * 60 * 1000;
/** Time to wait for the backend handler to end the response after an abort before force-finishing the job. */
const ABORT_GRACE_MS = 5000;

/**
 * @typedef {object} JobSubscriber
 * @property {(chunk: Buffer) => void} write Writes a chunk to the subscriber
 * @property {() => void} end Ends the subscriber response
 */

export class GenerationJob {
    /**
     * @param {string} id Job ID provided by the client
     * @param {string} handle User handle owning the job
     * @param {() => void | Promise<void>} onAbort Function that aborts the upstream request
     */
    constructor(id, handle, onAbort) {
        this.id = id;
        this.handle = handle;
        this.onAbort = onAbort;
        /** @type {'running' | 'finished'} */
        this.status = 'running';
        this.aborted = false;
        this.truncated = false;
        /** @type {number | null} */
        this.statusCode = null;
        /** @type {string} */
        this.statusMessage = '';
        /** @type {string | null} */
        this.contentType = null;
        /** @type {Buffer[]} */
        this.chunks = [];
        this.size = 0;
        /** @type {Set<JobSubscriber>} */
        this.subscribers = new Set();
        this.createdAt = Date.now();
        /** @type {number | null} */
        this.finishedAt = null;
        /** @type {NodeJS.Timeout | null} */
        this.timeout = setTimeout(() => this.abort('Generation job exceeded the maximum running time'), MAX_RUNNING_MS);
        this.timeout.unref?.();
    }

    get isRunning() {
        return this.status === 'running';
    }

    /**
     * Captures the response metadata (status, content type) from the original response.
     * @param {import('express').Response} response Original response
     */
    captureHead(response) {
        if (this.statusCode !== null) {
            return;
        }
        this.statusCode = response.statusCode;
        this.statusMessage = response.statusMessage || '';
        const contentType = response.getHeader('content-type');
        this.contentType = contentType ? String(contentType) : null;
    }

    /**
     * Appends a chunk to the job buffer and forwards it to the subscribers.
     * @param {Buffer} chunk Data chunk
     */
    append(chunk) {
        if (!this.isRunning || chunk.length === 0) {
            return;
        }
        if (MAX_JOB_SIZE > 0 && this.size + chunk.length > MAX_JOB_SIZE) {
            console.warn(`Generation job ${this.id} exceeded the maximum size of ${bytes.format(MAX_JOB_SIZE)}. Aborting.`);
            this.truncated = true;
            this.abort('Generation job exceeded the maximum size');
            this.finish();
            return;
        }
        this.chunks.push(chunk);
        this.size += chunk.length;
        for (const subscriber of this.subscribers) {
            subscriber.write(chunk);
        }
    }

    /**
     * Marks the job as finished and ends all subscriber responses.
     */
    finish() {
        if (!this.isRunning) {
            return;
        }
        this.status = 'finished';
        this.finishedAt = Date.now();
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        for (const subscriber of this.subscribers) {
            subscriber.end();
        }
        this.subscribers.clear();
        jobRegistry.scheduleRemoval(this);
    }

    /**
     * Aborts the upstream request of a running job.
     * @param {string} [reason] Reason for logging
     */
    abort(reason = 'Aborted by the client') {
        if (!this.isRunning || this.aborted) {
            return;
        }
        console.info(`Aborting generation job ${this.id}: ${reason}`);
        this.aborted = true;
        try {
            Promise.resolve(this.onAbort()).catch(error => console.warn('Generation job abort handler failed:', error));
        } catch (error) {
            console.warn('Generation job abort handler failed:', error);
        }
        // The backend handler is expected to end the response once the upstream request is aborted.
        // Make sure the job doesn't stay running forever if it doesn't.
        const graceTimeout = setTimeout(() => this.finish(), ABORT_GRACE_MS);
        graceTimeout.unref?.();
    }

    /**
     * Attaches a subscriber and replays the buffered data from the given offset.
     * @param {JobSubscriber} subscriber Subscriber
     * @param {number} offset Byte offset to replay from
     */
    subscribe(subscriber, offset) {
        let skip = offset;
        for (const chunk of this.chunks) {
            if (skip >= chunk.length) {
                skip -= chunk.length;
                continue;
            }
            subscriber.write(skip > 0 ? chunk.subarray(skip) : chunk);
            skip = 0;
        }
        if (this.isRunning) {
            this.subscribers.add(subscriber);
        } else {
            subscriber.end();
        }
    }

    /**
     * @param {JobSubscriber} subscriber Subscriber to detach
     */
    unsubscribe(subscriber) {
        this.subscribers.delete(subscriber);
    }

    dispose() {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        this.subscribers.clear();
        this.chunks = [];
    }
}

class GenerationJobRegistry {
    constructor() {
        /** @type {Map<string, GenerationJob>} */
        this.jobs = new Map();
    }

    /**
     * @param {string} handle User handle
     * @param {string} id Job ID
     * @returns {string} Registry key
     */
    static key(handle, id) {
        return `${handle}:${id}`;
    }

    /**
     * @param {string} handle User handle
     * @param {string} id Job ID
     * @returns {GenerationJob | undefined} Job, if any
     */
    get(handle, id) {
        return this.jobs.get(GenerationJobRegistry.key(handle, id));
    }

    /**
     * Adds a job to the registry, evicting the oldest finished jobs of the user if needed.
     * @param {GenerationJob} job Job to add
     * @returns {boolean} True if the job was added
     */
    add(job) {
        const key = GenerationJobRegistry.key(job.handle, job.id);
        if (this.jobs.has(key)) {
            return false;
        }
        const userJobs = Array.from(this.jobs.values()).filter(x => x.handle === job.handle);
        if (userJobs.length >= MAX_JOBS_PER_USER) {
            const oldestFinished = userJobs.filter(x => !x.isRunning).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))[0];
            if (!oldestFinished) {
                return false;
            }
            this.remove(oldestFinished);
        }
        this.jobs.set(key, job);
        return true;
    }

    /**
     * @param {GenerationJob} job Job to remove
     */
    remove(job) {
        const key = GenerationJobRegistry.key(job.handle, job.id);
        if (this.jobs.get(key) === job) {
            this.jobs.delete(key);
        }
        job.dispose();
    }

    /**
     * Removes a finished job once the retention period is over.
     * @param {GenerationJob} job Finished job
     */
    scheduleRemoval(job) {
        const timeout = setTimeout(() => this.remove(job), RETENTION_MS);
        timeout.unref?.();
    }
}

const jobRegistry = new GenerationJobRegistry();

/**
 * Gets the generation job bound to a response, if any.
 * The job is stored in `response.locals.generationJob` so that helpers (e.g. `forwardFetchResponse`)
 * can check for it without importing this module.
 * @param {import('express').Response} response Express response
 * @returns {GenerationJob | null} Job bound to the response
 */
export function getResponseGenerationJob(response) {
    return response.locals?.generationJob instanceof GenerationJob ? response.locals.generationJob : null;
}

/**
 * Converts a chunk passed to `write` or `end` into a buffer.
 * @param {any} chunk Chunk
 * @param {BufferEncoding | undefined} encoding Encoding for string chunks
 * @returns {Buffer} Buffer
 */
function toBuffer(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

/**
 * Creates a generation job bound to the response if the client requested one.
 * Everything written to the response is recorded into the job, and the response itself
 * becomes the first subscriber of the job (until the client disconnects).
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {() => void | Promise<void>} onAbort Function that aborts the upstream request
 * @returns {GenerationJob | null} Created job, or null if the request is not a generation job
 */
function tryCreateJob(request, response, onAbort) {
    if (!ENABLED || !request.user) {
        return null;
    }

    const id = request.get(GENERATION_JOB_HEADER);
    if (!id || !JOB_ID_PATTERN.test(id) || getResponseGenerationJob(response)) {
        return null;
    }

    const job = new GenerationJob(id, request.user.profile.handle, onAbort);
    if (!jobRegistry.add(job)) {
        job.dispose();
        return null;
    }

    response.locals.generationJob = job;
    response.setHeader(GENERATION_JOB_HEADER, id);

    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    const isWritable = () => !response.destroyed && !response.writableEnded;

    /** @type {JobSubscriber} */
    const originalSubscriber = {
        write: (chunk) => isWritable() && originalWrite(chunk),
        end: () => isWritable() && originalEnd(),
    };
    job.subscribers.add(originalSubscriber);
    response.on('close', () => job.unsubscribe(originalSubscriber));

    // @ts-ignore - simplified signature, callbacks are not used by the backend handlers
    response.write = function (chunk, encoding, callback) {
        job.captureHead(response);
        if (chunk !== undefined && chunk !== null) {
            job.append(toBuffer(chunk, encoding));
        }
        const cb = typeof encoding === 'function' ? encoding : callback;
        if (typeof cb === 'function') {
            process.nextTick(cb);
        }
        return true;
    };

    // @ts-ignore - simplified signature, callbacks are not used by the backend handlers
    response.end = function (chunk, encoding, callback) {
        if (typeof chunk === 'function') {
            callback = chunk;
            chunk = undefined;
        }
        job.captureHead(response);
        if (chunk !== undefined && chunk !== null) {
            job.append(toBuffer(chunk, encoding));
        }
        job.finish();
        const cb = typeof encoding === 'function' ? encoding : callback;
        if (typeof cb === 'function') {
            process.nextTick(cb);
        }
        return response;
    };

    console.debug(`Generation job ${id} started`);
    return job;
}

/**
 * Sets up the abort handling of a generation request.
 *
 * For a regular request, the upstream request is aborted when the client disconnects.
 * For a generation job (client sent {@link GENERATION_JOB_HEADER}), the upstream request keeps running
 * when the client disconnects, and is only aborted when requested through the abort endpoint.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {() => void | Promise<void>} onAbort Function that aborts the upstream request
 * @returns {GenerationJob | null} Created job, if any
 */
export function setupGenerationAbort(request, response, onAbort) {
    request.socket.removeAllListeners('close');
    const job = tryCreateJob(request, response, onAbort);
    if (!job) {
        request.socket.on('close', onAbort);
    }
    return job;
}

/**
 * Reads a job ID from the request body.
 * @param {import('express').Request} request Express request
 * @returns {string | null} Job ID or null if invalid
 */
function getRequestJobId(request) {
    const id = request.body?.id;
    return typeof id === 'string' && JOB_ID_PATTERN.test(id) ? id : null;
}

export const router = express.Router();

/**
 * Reattaches to the response stream of a generation job, starting from a byte offset.
 * The response status and content type mirror the original response.
 */
router.post('/stream', function (request, response) {
    const id = getRequestJobId(request);
    const offset = Number(request.body?.offset ?? 0);
    if (!id || !Number.isSafeInteger(offset) || offset < 0) {
        return response.status(400).send({ error: 'Invalid job ID or offset' });
    }

    const job = jobRegistry.get(request.user.profile.handle, id);
    if (!job) {
        return response.status(404).send({ error: 'Generation job not found' });
    }
    if (offset > job.size) {
        return response.status(416).send({ error: 'Offset is beyond the job data' });
    }

    let headersWritten = false;
    const writeHead = () => {
        if (headersWritten) {
            return;
        }
        headersWritten = true;
        response.status(job.statusCode ?? 200);
        if (job.statusMessage) {
            response.statusMessage = job.statusMessage;
        }
        if (job.contentType) {
            response.setHeader('Content-Type', job.contentType);
        }
        response.setHeader(GENERATION_JOB_HEADER, job.id);
        response.setHeader('Cache-Control', 'no-cache');
    };
    const isWritable = () => !response.destroyed && !response.writableEnded;

    /** @type {JobSubscriber} */
    const subscriber = {
        write: (chunk) => {
            if (!isWritable()) return;
            writeHead();
            response.write(chunk);
            // Make sure the compression middleware doesn't hold back streamed chunks
            // @ts-ignore - added by the compression middleware
            if (typeof response.flush === 'function') response.flush();
        },
        end: () => {
            if (!isWritable()) return;
            writeHead();
            response.end();
        },
    };

    response.on('close', () => job.unsubscribe(subscriber));
    job.subscribe(subscriber, offset);
});

/**
 * Aborts the upstream request of a running generation job.
 */
router.post('/abort', function (request, response) {
    const id = getRequestJobId(request);
    if (!id) {
        return response.status(400).send({ error: 'Invalid job ID' });
    }

    const job = jobRegistry.get(request.user.profile.handle, id);
    if (!job) {
        return response.status(404).send({ error: 'Generation job not found' });
    }

    job.abort();
    return response.send({ ok: true, status: job.status });
});

/**
 * Returns the status of a generation job.
 */
router.post('/status', function (request, response) {
    const id = getRequestJobId(request);
    if (!id) {
        return response.status(400).send({ error: 'Invalid job ID' });
    }

    const job = jobRegistry.get(request.user.profile.handle, id);
    if (!job) {
        return response.status(404).send({ error: 'Generation job not found' });
    }

    return response.send({
        id: job.id,
        status: job.status,
        aborted: job.aborted,
        truncated: job.truncated,
        size: job.size,
        statusCode: job.statusCode,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
    });
});
