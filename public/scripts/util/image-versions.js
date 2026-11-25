/**
 * Registry of image versions, used to build cacheable image URLs.
 *
 * An image URL that contains its version (?v=...) changes whenever the image changes, so the server
 * lets the browser cache it for a long time without asking again (see setImmutableCacheIfVersioned
 * in src/util.js). Without a version, images must be revalidated on every load, and Firefox doesn't
 * cache them at all (it would keep showing an outdated image after an update).
 *
 * Versions come from the server lists (characters, personas, backgrounds). When the client changes
 * an image itself, it bumps the version locally so that the new image shows up immediately.
 */

/** @typedef {'avatar'|'persona'|'bg'} ImageType */

/** @type {Record<ImageType, Map<string, string>>} */
const versions = {
    avatar: new Map(),
    persona: new Map(),
    bg: new Map(),
};

/** @type {Record<ImageType, {loaded: boolean, promise: Promise<void>, resolve: () => void}>} */
const loadState = /** @type {any} */ ({});
for (const type of Object.keys(versions)) {
    let resolve;
    const promise = new Promise(r => resolve = r);
    loadState[type] = { loaded: false, promise, resolve };
}

/**
 * Gets the version of an image.
 * @param {ImageType} type Image type
 * @param {string} file File name
 * @returns {string|undefined} Version, if known
 */
export function getImageVersion(type, file) {
    return versions[type]?.get(file);
}

/**
 * Sets the version of an image.
 * @param {ImageType} type Image type
 * @param {string} file File name
 * @param {string|number|null|undefined} version Version
 */
export function setImageVersion(type, file, version) {
    if (!versions[type] || !file) {
        return;
    }
    if (version === null || version === undefined || version === '') {
        versions[type].delete(file);
        return;
    }
    versions[type].set(file, String(version));
}

/**
 * Replaces all the known versions of a type of image (from a full server list).
 * @param {ImageType} type Image type
 * @param {Iterable<[string, string|number|null|undefined]>} entries Pairs of file name and version
 */
export function setImageVersions(type, entries) {
    if (!versions[type]) {
        return;
    }
    versions[type].clear();
    for (const [file, version] of entries) {
        setImageVersion(type, file, version);
    }
    markImageVersionsLoaded(type);
}

/**
 * Marks the versions of a type of image as loaded (even if the list could not be loaded).
 * @param {ImageType} type Image type
 */
export function markImageVersionsLoaded(type) {
    const state = loadState[type];
    if (state && !state.loaded) {
        state.loaded = true;
        state.resolve();
    }
}

/**
 * Checks whether the versions of a type of image were loaded.
 * @param {ImageType} type Image type
 * @returns {boolean} Whether the versions are loaded
 */
export function areImageVersionsLoaded(type) {
    return Boolean(loadState[type]?.loaded);
}

/**
 * Waits until the versions of a type of image are loaded.
 * @param {ImageType} type Image type
 * @returns {Promise<void>}
 */
export function waitForImageVersions(type) {
    return loadState[type]?.promise ?? Promise.resolve();
}

/**
 * Gives an image a new, unique version: to be called when the client knows the image just changed.
 * @param {ImageType} type Image type
 * @param {string} file File name
 */
export function bumpImageVersion(type, file) {
    setImageVersion(type, file, `l${Date.now().toString(36)}`);
}

/**
 * Converts a character's 'date_added' (the modification time of its card file) to an image version.
 * @param {number|undefined} dateAdded Character's date_added
 * @returns {string|undefined} Version
 */
export function getCharacterImageVersion(dateAdded) {
    return Number.isFinite(dateAdded) && dateAdded > 0 ? Math.floor(dateAdded).toString(36) : undefined;
}
