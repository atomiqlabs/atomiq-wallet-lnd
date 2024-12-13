"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.accumulative = void 0;
const utils_1 = require("./utils");
// add inputs until we reach or surpass the target value (or deplete)
// worst-case: O(n)
function accumulative(utxos, outputs, feeRate, type, requiredInputs) {
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
    for (let i = 0; i < utxos.length; ++i) {
        const utxo = utxos[i];
        const { length: utxoBytes } = utils_1.utils.inputBytes(utxo);
        const utxoFee = feeRate * utxoBytes;
        const utxoValue = utils_1.utils.uintOrNaN(utxo.value);
        // skip detrimental input
        if (utxoFee > utxo.value) {
            if (i === utxos.length - 1)
                return { fee: feeRate * (bytesAccum + utxoBytes) };
            continue;
        }
        bytesAccum += utxoBytes;
        inAccum += utxoValue;
        inputs.push(utxo);
        const fee = feeRate * bytesAccum;
        // go again?
        if (inAccum < outAccum + fee)
            continue;
        return utils_1.utils.finalize(inputs, outputs, feeRate, type);
    }
    return { fee: feeRate * bytesAccum };
}
exports.accumulative = accumulative;
