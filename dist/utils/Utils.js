"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleLndError = exports.shuffle = exports.getLogger = void 0;
function getLogger(prefix) {
    return {
        debug: (msg, ...args) => console.debug(prefix + msg, ...args),
        info: (msg, ...args) => console.info(prefix + msg, ...args),
        warn: (msg, ...args) => console.warn(prefix + msg, ...args),
        error: (msg, ...args) => console.error(prefix + msg, ...args)
    };
}
exports.getLogger = getLogger;
function shuffle(array) {
    let currentIndex = array.length;
    // While there remain elements to shuffle...
    while (currentIndex != 0) {
        // Pick a remaining element...
        let randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [
            array[randomIndex], array[currentIndex]
        ];
    }
}
exports.shuffle = shuffle;
/**
 * Handles & throws LND error if the error is:
 *  - network error
 *  - server side (LND) internal error
 *  - malformed input data error
 *
 * @param e
 */
function handleLndError(e) {
    if (!Array.isArray(e))
        throw e; //Throw errors that are not originating from the SDK
    if (typeof (e[0]) !== "number")
        throw e; //Throw errors that don't have proper format
    if (e[0] >= 500 && e[0] < 600)
        throw e; //Throw server errors 5xx
    if (e[0] === 400)
        throw e; //Throw malformed request data errors
}
exports.handleLndError = handleLndError;
