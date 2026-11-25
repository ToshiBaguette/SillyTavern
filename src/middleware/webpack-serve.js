import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpack from 'webpack';
import getPublicLibConfig from '../../webpack.config.js';

/**
 * Content-based ETag of the compiled bundle, cached by file modification time.
 * The bundle is rewritten on every server start, so a modification time based ETag would make
 * the browsers download it again after each restart, even if its content didn't change.
 * @type {{mtimeMs: number, size: number, etag: string}|null}
 */
let bundleETag = null;

/**
 * Gets a strong ETag for a file, computed from its content.
 * @param {string} filePath Path to the file
 * @returns {string|null} ETag, or null if the file can't be read
 */
function getContentETag(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (bundleETag && bundleETag.mtimeMs === stat.mtimeMs && bundleETag.size === stat.size) {
            return bundleETag.etag;
        }
        const hash = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('base64url');
        bundleETag = { mtimeMs: stat.mtimeMs, size: stat.size, etag: `"${hash}"` };
        return bundleETag.etag;
    } catch {
        return null;
    }
}

export default function getWebpackServeMiddleware() {
    /**
     * A very spartan recreation of webpack-dev-middleware.
     * @param {import('express').Request} req Request object.
     * @param {import('express').Response} res Response object.
     * @param {import('express').NextFunction} next Next function.
     * @type {import('express').RequestHandler}
     */
    function devMiddleware(req, res, next) {
        const publicLibConfig = getPublicLibConfig();
        const outputPath = publicLibConfig.output?.path;
        const outputFile = publicLibConfig.output?.filename;
        const parsedPath = path.parse(req.path);

        if (req.method === 'GET' && parsedPath.dir === '/' && parsedPath.base === outputFile) {
            const etag = getContentETag(path.join(outputPath, outputFile));
            if (etag) {
                // 'send' still answers 304 Not Modified using this header
                res.setHeader('ETag', etag);
                return res.sendFile(outputFile, { root: outputPath, etag: false, lastModified: false });
            }
            return res.sendFile(outputFile, { root: outputPath });
        }

        next();
    }

    /**
     * Wait until Webpack is done compiling.
     * @param {object} param Parameters.
     * @param {boolean} [param.forceDist=false] Whether to force the use the /dist folder.
     * @param {boolean} [param.pruneCache=false] Whether to prune old cache directories before compiling.
     * @returns {Promise<void>}
     */
    devMiddleware.runWebpackCompiler = ({ forceDist = false, pruneCache = false } = {}) => {
        console.log();
        console.log('Compiling frontend libraries...');

        const publicLibConfig = getPublicLibConfig({ forceDist, pruneCache });
        const compiler = webpack(publicLibConfig);

        return new Promise((resolve) => {
            compiler.run((_error, stats) => {
                const output = stats?.toString(publicLibConfig.stats);
                if (output) {
                    console.log(output);
                    console.log();
                }
                compiler.close(() => {
                    resolve();
                });
            });
        });
    };

    return devMiddleware;
}
