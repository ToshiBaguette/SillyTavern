import http from 'node:http';
import http2 from 'node:http2';
import express from 'express';

/**
 * Express 4 doesn't support the Node.js HTTP/2 compatibility API: its init middleware replaces
 * the prototype of every request/response with one inheriting from the HTTP/1 classes, which
 * drops the HTTP/2 getters (headers, url, method, socket...). This module re-creates the Express
 * request/response prototypes on top of the HTTP/2 classes and makes Express use them for HTTP/2 requests.
 *
 * It also smooths a few HTTP/1 assumptions made by the rest of the server:
 * - the 'host' header doesn't exist in HTTP/2 (replaced by the ':authority' pseudo-header);
 * - a request body doesn't need a content-length in HTTP/2, but the body parsers expect one (or a transfer-encoding);
 * - 'request.socket' is shared by all the streams of a connection. The endpoints use
 *   'request.socket.on/removeAllListeners("close")' to detect a cancelled generation, so these calls
 *   are scoped to the current stream (i.e. the request) instead of the whole connection;
 * - status messages are not supported by HTTP/2 and setting one prints a warning on every request;
 * - some libraries call the HTTP/1 header methods directly on the response (see installHttp1HeaderShims).
 */

/**
 * Copies the own property descriptors of an object.
 * @param {object} source Source object
 * @returns {PropertyDescriptorMap} Property descriptors
 */
function getDescriptors(source) {
    return Object.getOwnPropertyDescriptors(source);
}

/**
 * Creates a socket-like proxy scoped to a single HTTP/2 stream.
 * @param {http2.Http2Stream} stream HTTP/2 stream
 * @param {any} socket Socket proxy provided by Node.js
 * @returns {any} Scoped socket proxy
 */
function createScopedSocket(stream, socket) {
    /** @type {Map<string|symbol, Set<Function>>} */
    const listeners = new Map();

    const track = (event, listener) => {
        if (!listeners.has(event)) {
            listeners.set(event, new Set());
        }
        listeners.get(event).add(listener);
    };

    return new Proxy(socket, {
        get(target, prop) {
            switch (prop) {
                case 'on':
                case 'addListener':
                case 'once':
                    return (event, listener) => {
                        track(event, listener);
                        stream[prop](event, listener);
                        return target;
                    };
                case 'off':
                case 'removeListener':
                    return (event, listener) => {
                        listeners.get(event)?.delete(listener);
                        stream.removeListener(event, listener);
                        return target;
                    };
                case 'removeAllListeners':
                    // Only remove the listeners added through this request, never the internal ones
                    return (event) => {
                        const events = event === undefined ? [...listeners.keys()] : [event];
                        for (const name of events) {
                            for (const listener of listeners.get(name) ?? []) {
                                stream.removeListener(name, listener);
                            }
                            listeners.delete(name);
                        }
                        return target;
                    };
                default:
                    return Reflect.get(target, prop);
            }
        },
    });
}

const kScopedSocket = Symbol('scopedSocket');

/**
 * Gets the stream-scoped socket of an HTTP/2 request or response.
 * @param {any} self Request or response
 * @param {PropertyDescriptor} baseDescriptor Original 'socket' getter
 * @returns {any} Scoped socket
 */
function getScopedSocket(self, baseDescriptor) {
    const socket = baseDescriptor.get.call(self);
    const stream = self.stream;
    if (!socket || !stream) {
        return socket;
    }
    if (!stream[kScopedSocket]) {
        stream[kScopedSocket] = createScopedSocket(stream, socket);
    }
    return stream[kScopedSocket];
}

const requestSocketDescriptor = Object.getOwnPropertyDescriptor(http2.Http2ServerRequest.prototype, 'socket');
const responseSocketDescriptor = Object.getOwnPropertyDescriptor(http2.Http2ServerResponse.prototype, 'socket');

const http2ExpressRequest = Object.create(http2.Http2ServerRequest.prototype, {
    ...getDescriptors(express.request),
    socket: { configurable: true, get() { return getScopedSocket(this, requestSocketDescriptor); } },
    connection: { configurable: true, get() { return getScopedSocket(this, requestSocketDescriptor); } },
});

const http2ExpressResponse = Object.create(http2.Http2ServerResponse.prototype, {
    ...getDescriptors(express.response),
    socket: { configurable: true, get() { return getScopedSocket(this, responseSocketDescriptor); } },
    connection: { configurable: true, get() { return getScopedSocket(this, responseSocketDescriptor); } },
    // Not supported by HTTP/2: ignore silently instead of printing a warning for every request
    statusMessage: { configurable: true, get() { return ''; }, set() { } },
});

let headerShimsInstalled = false;

/**
 * Some libraries call the HTTP/1 header methods directly, bypassing the response object
 * (e.g. 'cookies', used by the session middleware: http.OutgoingMessage.prototype.setHeader.call(res, ...)).
 * On an HTTP/2 response, these calls would be silently lost (no session cookie, so no CSRF token).
 * Redirect them to the HTTP/2 implementation for HTTP/2 responses only.
 */
function installHttp1HeaderShims() {
    if (headerShimsInstalled) {
        return;
    }
    headerShimsInstalled = true;

    const methods = ['setHeader', 'getHeader', 'removeHeader', 'hasHeader', 'getHeaders', 'getHeaderNames', 'appendHeader'];
    for (const method of methods) {
        const http1Method = http.OutgoingMessage.prototype[method];
        const http2Method = http2.Http2ServerResponse.prototype[method];
        if (typeof http1Method !== 'function' || typeof http2Method !== 'function') {
            continue;
        }
        http.OutgoingMessage.prototype[method] = function (...args) {
            if (this instanceof http2.Http2ServerResponse) {
                return http2Method.apply(this, args);
            }
            return http1Method.apply(this, args);
        };
    }
}

/**
 * Wraps an Express application into a request handler for an HTTP/2 server (with HTTP/1 fallback).
 * @param {import('express').Express} app Express application
 * @returns {(req: any, res: any) => void} Request handler
 */
export function createHttp2Handler(app) {
    installHttp1HeaderShims();

    // Same as app.request/app.response (which only add the 'app' property), but based on HTTP/2 classes
    const appRequest = Object.create(http2ExpressRequest, getDescriptors(app.request));
    const appResponse = Object.create(http2ExpressResponse, getDescriptors(app.response));

    return function (req, res) {
        if (req.httpVersionMajor !== 2) {
            return app(req, res);
        }

        if (!req.headers.host && req.headers[':authority']) {
            req.headers.host = req.headers[':authority'];
        }

        // HTTP/2 doesn't require a content-length for a request body, but the body parsers only read
        // the body if it has a content-length or a transfer-encoding (the HTTP/1 way to tell there's one).
        if (req.headers['content-length'] === undefined && req.headers['transfer-encoding'] === undefined && !req.stream?.endAfterHeaders) {
            req.headers['transfer-encoding'] = 'chunked';
        }

        // Express applies app.request/app.response as prototypes in its init middleware, which runs
        // synchronously when the app is called. Swap them for the HTTP/2 ones during that call only.
        const { request, response } = app;
        app.request = appRequest;
        app.response = appResponse;
        try {
            app(req, res);
        } finally {
            app.request = request;
            app.response = response;
        }
    };
}
