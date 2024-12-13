"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.coinSelect = void 0;
const accumulative_1 = require("./accumulative");
const blackjack_1 = require("./blackjack");
const utils_1 = require("./utils");
const BN = require("bn.js");
const Utils_1 = require("../Utils");
// order by descending value, minus the inputs approximate fee
function utxoScore(x, feeRate) {
    return x.value - (feeRate * utils_1.utils.inputBytes(x).length);
}
function utxoFeePPM(utxo, feeRate) {
    return new BN(utxo.value).mul(new BN(1000000)).div(new BN(Math.ceil(feeRate * utils_1.utils.inputBytes(utxo).length))).toNumber();
}
/**
 * Runs a coinselection algorithm on given inputs, outputs and fee rate
 *
 * @param utxos Utxo pool to select additional inputs from
 * @param outputs Outputs of the transaction
 * @param feeRate Feerate in sats/vB
 * @param changeType Change address type
 * @param requiredInputs Utxos that need to be included as inputs to the transaction
 * @param randomize Randomize the UTXO order before running the coinselection algorithm
 */
function coinSelect(utxos, outputs, feeRate, changeType, requiredInputs, randomize) {
    if (randomize) {
        (0, Utils_1.shuffle)(utxos);
    }
    else {
        utxos.sort((a, b) => utxoScore(b, feeRate) - utxoScore(a, feeRate));
    }
    // attempt to use the blackjack strategy first (no change output)
    let base = (0, blackjack_1.blackjack)(utxos, outputs, feeRate, changeType, requiredInputs);
    if (base.inputs)
        return base;
    // else, try the accumulative strategy
    return (0, accumulative_1.accumulative)(utxos, outputs, feeRate, changeType, requiredInputs);
}
exports.coinSelect = coinSelect;
