"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bitcoinTxToBtcTx = exports.handleLndError = exports.shuffle = exports.getLogger = void 0;
const btc_signer_1 = require("@scure/btc-signer");
const buffer_1 = require("buffer");
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
function bitcoinTxToBtcTx(btcTx) {
    return {
        locktime: btcTx.lockTime,
        version: btcTx.version,
        blockhash: null,
        confirmations: 0,
        txid: btcTx.id,
        hex: buffer_1.Buffer.from(btcTx.toBytes(true, false)).toString("hex"),
        raw: buffer_1.Buffer.from(btcTx.toBytes()).toString("hex"),
        vsize: btcTx.vsize,
        outs: Array.from({ length: btcTx.outputsLength }, (_, i) => i).map((index) => {
            const output = btcTx.getOutput(index);
            return {
                value: Number(output.amount),
                n: index,
                scriptPubKey: {
                    asm: btc_signer_1.Script.decode(output.script).map(val => typeof (val) === "object" ? buffer_1.Buffer.from(val).toString("hex") : val.toString()).join(" "),
                    hex: buffer_1.Buffer.from(output.script).toString("hex")
                }
            };
        }),
        ins: Array.from({ length: btcTx.inputsLength }, (_, i) => i).map(index => {
            const input = btcTx.getInput(index);
            return {
                txid: buffer_1.Buffer.from(input.txid).toString("hex"),
                vout: input.index,
                scriptSig: {
                    asm: btc_signer_1.Script.decode(input.finalScriptSig).map(val => typeof (val) === "object" ? buffer_1.Buffer.from(val).toString("hex") : val.toString()).join(" "),
                    hex: buffer_1.Buffer.from(input.finalScriptSig).toString("hex")
                },
                sequence: input.sequence,
                txinwitness: input.finalScriptWitness.map(witness => buffer_1.Buffer.from(witness).toString("hex"))
            };
        })
    };
}
exports.bitcoinTxToBtcTx = bitcoinTxToBtcTx;
