"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toCoinselectInput = exports.bitcoinTxToBtcTx = exports.handleLndError = exports.shuffle = exports.getLogger = void 0;
const btc_signer_1 = require("@scure/btc-signer");
const buffer_1 = require("buffer");
const crypto_1 = require("crypto");
function getLogger(prefix) {
    return {
        debug: (msg, ...args) => global.atomiqLogLevel >= 3 && console.debug(prefix + msg, ...args),
        info: (msg, ...args) => global.atomiqLogLevel >= 2 && console.info(prefix + msg, ...args),
        warn: (msg, ...args) => (global.atomiqLogLevel == null || global.atomiqLogLevel >= 1) && console.warn(prefix + msg, ...args),
        error: (msg, ...args) => (global.atomiqLogLevel == null || global.atomiqLogLevel >= 0) && console.error(prefix + msg, ...args)
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
    const txWithoutWitness = btcTx.toBytes(true, false);
    return {
        locktime: btcTx.lockTime,
        version: btcTx.version,
        blockhash: null,
        confirmations: 0,
        txid: (0, crypto_1.createHash)("sha256").update((0, crypto_1.createHash)("sha256").update(txWithoutWitness).digest()).digest().reverse().toString("hex"),
        hex: buffer_1.Buffer.from(txWithoutWitness).toString("hex"),
        raw: buffer_1.Buffer.from(btcTx.toBytes(true, true)).toString("hex"),
        vsize: btcTx.isFinal ? btcTx.vsize : null,
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
                txinwitness: input.finalScriptWitness == null ? [] : input.finalScriptWitness.map(witness => buffer_1.Buffer.from(witness).toString("hex"))
            };
        })
    };
}
exports.bitcoinTxToBtcTx = bitcoinTxToBtcTx;
function toCoinselectInput(input) {
    let amount;
    let outputScript;
    if (input.witnessUtxo != null) {
        outputScript = input.witnessUtxo.script;
        amount = input.witnessUtxo.amount;
    }
    else if (input.nonWitnessUtxo != null) {
        const prevUtxo = input.nonWitnessUtxo.outputs[input.index];
        outputScript = prevUtxo.script;
        amount = prevUtxo.amount;
    }
    else {
        throw new Error("Input needs to have either witnessUtxo or nonWitnessUtxo specified!");
    }
    let inputType;
    switch (btc_signer_1.OutScript.decode(outputScript).type) {
        case "pkh":
            inputType = "p2pkh";
            break;
        case "wpkh":
            inputType = "p2wpkh";
            break;
        case "tr":
            inputType = "p2tr";
            break;
        case "sh":
            inputType = "p2sh-p2wpkh";
            break;
        case "wsh":
            inputType = "p2wsh";
            break;
        default:
            throw new Error("Invalid input type!");
    }
    return {
        txId: buffer_1.Buffer.from(input.txid).toString("hex"),
        vout: input.index,
        value: Number(amount),
        type: inputType
    };
}
exports.toCoinselectInput = toCoinselectInput;
