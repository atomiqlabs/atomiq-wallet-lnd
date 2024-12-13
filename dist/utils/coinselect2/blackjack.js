"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.blackjack = void 0;
const utils_1 = require("./utils");
// add inputs until we reach or surpass the target value (or deplete)
// worst-case: O(n)
function blackjack(utxos, outputs, feeRate, type, requiredInputs) {
    if (!isFinite(utils_1.utils.uintOrNaN(feeRate)))
        return null;
    let bytesAccum = utils_1.utils.transactionBytes([], outputs, type);
    let inAccum = 0;
    const inputs = [];
    if (requiredInputs != null)
        for (let utxo of requiredInputs) {
            const { length: utxoBytes } = utils_1.utils.inputBytes(utxo);
            const utxoValue = utils_1.utils.uintOrNaN(utxo.value);
            bytesAccum += utxoBytes;
            inAccum += utxoValue;
            inputs.push(utxo);
        }
    const outAccum = utils_1.utils.sumOrNaN(outputs);
    const threshold = utils_1.utils.dustThreshold({ type });
    for (let i = 0; i < utxos.length; ++i) {
        const input = utxos[i];
        const { length: inputBytes } = utils_1.utils.inputBytes(input);
        const fee = feeRate * (bytesAccum + inputBytes);
        const inputValue = utils_1.utils.uintOrNaN(input.value);
        // would it waste value?
        if ((inAccum + inputValue) > (outAccum + fee + threshold))
            continue;
        bytesAccum += inputBytes;
        inAccum += inputValue;
        inputs.push(input);
        // go again?
        if (inAccum < outAccum + fee)
            continue;
        return utils_1.utils.finalize(inputs, outputs, feeRate, type);
    }
    return { fee: feeRate * bytesAccum };
}
exports.blackjack = blackjack;
