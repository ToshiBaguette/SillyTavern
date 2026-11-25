import { beforeAll, describe, test, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Response } from 'node-fetch';

// generation-jobs.js reads these config values at module load. Environment variables take
// precedence over config.yaml, so setting them here lets the module import without a config file.
process.env.SILLYTAVERN_GENERATIONJOBS_ENABLED = 'true';
process.env.SILLYTAVERN_GENERATIONJOBS_RETENTIONSECONDS = '0';
process.env.SILLYTAVERN_GENERATIONJOBS_MAXJOBSIZE = '1mb';
process.env.SILLYTAVERN_GENERATIONJOBS_MAXJOBSPERUSER = '20';

/** @type {typeof import('../src/generation-jobs.js').setupGenerationAbort} */
let setupGenerationAbort;
/** @type {typeof import('../src/generation-jobs.js').getResponseGenerationJob} */
let getResponseGenerationJob;
/** @type {string} */
let GENERATION_JOB_HEADER;
/** @type {typeof import('../src/util.js').forwardFetchResponse} */
let forwardFetchResponse;

beforeAll(async () => {
    ({ setupGenerationAbort, getResponseGenerationJob, GENERATION_JOB_HEADER } = await import('../src/generation-jobs.js'));
    ({ forwardFetchResponse } = await import('../src/util.js'));
});

let userCounter = 0;

/**
 * Creates a mock Express request.
 * @param {string | undefined} jobId Job ID header value
 */
function createMockRequest(jobId) {
    return {
        user: { profile: { handle: `user-${++userCounter}` } },
        get: (name) => name.toLowerCase() === GENERATION_JOB_HEADER.toLowerCase() ? jobId : undefined,
        socket: new EventEmitter(),
    };
}

/**
 * Creates a mock Express response that collects what reaches the client.
 */
function createMockResponse() {
    const response = new PassThrough();
    const responseHeaders = {};
    response.statusCode = 200;
    response.statusMessage = '';
    response.locals = {};
    response.setHeader = (name, value) => { responseHeaders[name.toLowerCase()] = value; };
    response.getHeader = (name) => responseHeaders[name.toLowerCase()];
    const received = [];
    response.on('data', chunk => received.push(Buffer.from(chunk)));
    response.received = () => Buffer.concat(received).toString('utf8');
    return response;
}

/**
 * Creates a subscriber collecting the replayed data.
 */
function createSubscriber() {
    const chunks = [];
    const subscriber = {
        ended: false,
        write: (chunk) => chunks.push(Buffer.from(chunk)),
        end: () => { subscriber.ended = true; },
        text: () => Buffer.concat(chunks).toString('utf8'),
    };
    return subscriber;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('setupGenerationAbort', () => {
    test('aborts on client disconnect when no job is requested', () => {
        const request = createMockRequest(undefined);
        const response = createMockResponse();
        const onAbort = jest.fn();

        const job = setupGenerationAbort(request, response, onAbort);

        expect(job).toBeNull();
        expect(getResponseGenerationJob(response)).toBeNull();
        request.socket.emit('close');
        expect(onAbort).toHaveBeenCalledTimes(1);
    });

    test('ignores invalid job IDs', () => {
        const request = createMockRequest('bad id!');
        const response = createMockResponse();
        const onAbort = jest.fn();

        expect(setupGenerationAbort(request, response, onAbort)).toBeNull();
        request.socket.emit('close');
        expect(onAbort).toHaveBeenCalledTimes(1);
    });

    test('keeps a job running when the client disconnects', () => {
        const request = createMockRequest('job-keep-running');
        const response = createMockResponse();
        const onAbort = jest.fn();

        const job = setupGenerationAbort(request, response, onAbort);

        expect(job).not.toBeNull();
        expect(getResponseGenerationJob(response)).toBe(job);
        expect(response.getHeader(GENERATION_JOB_HEADER)).toBe('job-keep-running');
        request.socket.emit('close');
        expect(onAbort).not.toHaveBeenCalled();
        expect(job.isRunning).toBe(true);
        job.finish();
    });
});

describe('GenerationJob', () => {
    test('records writes and replays them from an offset', async () => {
        const request = createMockRequest('job-replay-offset');
        const response = createMockResponse();
        const job = setupGenerationAbort(request, response, () => {});

        response.write('hello ');
        response.write(Buffer.from('wor'));
        await flush();
        expect(response.received()).toBe('hello wor');

        // Client disconnects: later writes are still recorded
        response.destroy();
        await flush();
        response.write('ld');
        response.end('!');

        expect(job.isRunning).toBe(false);
        expect(job.size).toBe('hello world!'.length);

        const subscriber = createSubscriber();
        job.subscribe(subscriber, 'hello '.length + 1);
        expect(subscriber.text()).toBe('orld!');
        expect(subscriber.ended).toBe(true);
    });

    test('forwards live data to subscribers of a running job', () => {
        const request = createMockRequest('job-live-subscriber');
        const response = createMockResponse();
        const job = setupGenerationAbort(request, response, () => {});

        response.write('abc');
        const subscriber = createSubscriber();
        job.subscribe(subscriber, 1);
        response.write('def');
        expect(subscriber.text()).toBe('bcdef');
        expect(subscriber.ended).toBe(false);

        response.end();
        expect(subscriber.ended).toBe(true);
    });

    test('captures the status code of the response', () => {
        const request = createMockRequest('job-status-code');
        const response = createMockResponse();
        const job = setupGenerationAbort(request, response, () => {});

        response.statusCode = 429;
        response.end('{"error":true}');

        expect(job.statusCode).toBe(429);
    });

    test('aborts only once and not after finishing', () => {
        const onAbort = jest.fn();
        const job = setupGenerationAbort(createMockRequest('job-abort-once'), createMockResponse(), onAbort);

        job.abort();
        job.abort();
        expect(onAbort).toHaveBeenCalledTimes(1);
        job.finish();

        const onAbortFinished = jest.fn();
        const finishedJob = setupGenerationAbort(createMockRequest('job-abort-finished'), createMockResponse(), onAbortFinished);
        finishedJob.finish();
        finishedJob.abort();
        expect(onAbortFinished).not.toHaveBeenCalled();
    });
});

describe('forwardFetchResponse with a generation job', () => {
    test('keeps reading the remote stream after the client disconnects', async () => {
        const request = createMockRequest('job-forward-stream');
        const response = createMockResponse();
        const job = setupGenerationAbort(request, response, () => {});
        const remote = new PassThrough();

        await forwardFetchResponse(new Response(remote, { status: 200 }), response);

        remote.write('data: 1\n\n');
        await flush();
        response.destroy();
        request.socket.emit('close');
        remote.write('data: 2\n\n');
        remote.end('data: [DONE]\n\n');
        await flush();

        expect(job.isRunning).toBe(false);
        const subscriber = createSubscriber();
        job.subscribe(subscriber, 0);
        expect(subscriber.text()).toBe('data: 1\n\ndata: 2\n\ndata: [DONE]\n\n');
    });
});
