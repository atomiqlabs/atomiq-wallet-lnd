"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LNDBitcoinWallet = void 0;
const LNDClient_1 = require("./LNDClient");
const BN = require("bn.js");
const bitcoinjs_lib_1 = require("bitcoinjs-lib");
const lightning_1 = require("lightning");
const utils_1 = require("../utils/coinselect2/utils");
const coinselect2_1 = require("../utils/coinselect2");
const bitcoin = require("bitcoinjs-lib");
const Utils_1 = require("../utils/Utils");
const lp_lib_1 = require("@atomiqlabs/lp-lib");
function lndTxToBtcTx(tx) {
    const btcTx = bitcoinjs_lib_1.Transaction.fromHex(tx.transaction);
    btcTx.ins.forEach(vin => {
        vin.witness = [];
    });
    return {
        blockhash: tx.block_id,
        confirmations: tx.confirmation_count,
        txid: tx.id,
        hex: btcTx.toHex(),
        raw: tx.transaction,
        vsize: btcTx.virtualSize(),
        outs: btcTx.outs.map((output, index) => {
            return {
                value: output.value,
                n: index,
                scriptPubKey: {
                    asm: bitcoinjs_lib_1.script.toASM(output.script),
                    hex: output.script.toString("hex")
                }
            };
        }),
        ins: btcTx.ins.map(input => {
            return {
                txid: input.hash.reverse().toString("hex"),
                vout: input.index,
                scriptSig: {
                    asm: bitcoinjs_lib_1.script.toASM(input.script),
                    hex: input.script.toString("hex")
                },
                sequence: input.sequence,
                txinwitness: input.witness.map(witness => witness.toString("hex"))
            };
        })
    };
}
const logger = (0, Utils_1.getLogger)("LNDBitcoinWallet: ");
class LNDSavedAddress {
    constructor(objOrAddress) {
        if (typeof (objOrAddress) === "string") {
            this.address = objOrAddress;
        }
        else {
            this.address = objOrAddress.address;
        }
    }
    serialize() {
        return { address: this.address };
    }
}
class LNDBitcoinWallet {
    constructor(configOrClient, config) {
        var _a, _b;
        var _c, _d;
        this.LND_ADDRESS_TYPE_ENUM = {
            "p2wpkh": 1,
            "p2sh-p2wpkh": 2,
            "p2tr": 4
        };
        this.ADDRESS_FORMAT_MAP = {
            "p2wpkh": "p2wpkh",
            "np2wpkh": "p2sh-p2wpkh",
            "p2tr": "p2tr"
        };
        this.CHANGE_ADDRESS_TYPE = "p2tr";
        this.RECEIVE_ADDRESS_TYPE = "p2wpkh";
        this.CONFIRMATIONS_REQUIRED = 1;
        this.UTXO_CACHE_TIMEOUT = 5 * 1000;
        this.CHANNEL_COUNT_CACHE_TIMEOUT = 30 * 1000;
        if (configOrClient instanceof LNDClient_1.LNDClient) {
            this.lndClient = configOrClient;
        }
        else {
            this.lndClient = new LNDClient_1.LNDClient(configOrClient);
        }
        this.config = config;
        (_a = (_c = this.config).network) !== null && _a !== void 0 ? _a : (_c.network = bitcoinjs_lib_1.networks.bitcoin);
        (_b = (_d = this.config).onchainReservedPerChannel) !== null && _b !== void 0 ? _b : (_d.onchainReservedPerChannel = 50000);
        this.addressPoolStorage = new lp_lib_1.StorageManager(this.config.storageDirectory);
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.addressPoolStorage.init();
            yield this.addressPoolStorage.loadData(LNDSavedAddress);
            yield this.lndClient.init();
        });
    }
    isReady() {
        return this.lndClient.isReady();
    }
    getStatus() {
        return this.lndClient.status;
    }
    getStatusInfo() {
        return this.lndClient.getStatusInfo();
    }
    getCommands() {
        return [];
    }
    toOutputScript(_address) {
        return bitcoinjs_lib_1.address.toOutputScript(_address, this.config.network);
    }
    getBlockheight() {
        return __awaiter(this, void 0, void 0, function* () {
            const res = yield (0, lightning_1.getHeight)({ lnd: this.lndClient.lnd });
            return res.current_block_height;
        });
    }
    getFeeRate() {
        return __awaiter(this, void 0, void 0, function* () {
            let feeRate;
            if (this.config.feeEstimator != null) {
                feeRate = yield this.config.feeEstimator.estimateFee();
            }
            else {
                feeRate = yield (0, lightning_1.getChainFeeRate)({ lnd: this.lndClient.lnd })
                    .then(val => val.tokens_per_vbyte);
            }
            if (feeRate == null || feeRate === 0)
                throw new Error("Unable to estimate chain fee!");
            return feeRate;
        });
    }
    getAddressType() {
        return this.RECEIVE_ADDRESS_TYPE;
    }
    addUnusedAddress(address) {
        logger.debug("addUnusedAddress(): Adding new unused address to local address pool: ", address);
        return this.addressPoolStorage.saveData(address, new LNDSavedAddress(address));
    }
    getAddress() {
        return __awaiter(this, void 0, void 0, function* () {
            const addressPool = Object.keys(this.addressPoolStorage.data);
            if (addressPool.length > 0) {
                const address = addressPool[0];
                yield this.addressPoolStorage.removeData(address);
                logger.debug("getAddress(): Address returned from local address pool: ", address);
                return address;
            }
            const res = yield (0, lightning_1.createChainAddress)({
                lnd: this.lndClient.lnd,
                format: this.RECEIVE_ADDRESS_TYPE
            });
            logger.debug("getAddress(): Address returned from LND: ", res.address);
            return res.address;
        });
    }
    getRequiredReserve(useCached = false) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!useCached || this.cachedChannelCount == null || this.cachedChannelCount.timestamp < Date.now() - this.CHANNEL_COUNT_CACHE_TIMEOUT) {
                const { channels } = yield (0, lightning_1.getChannels)({ lnd: this.lndClient.lnd });
                this.cachedChannelCount = {
                    count: channels.length,
                    timestamp: Date.now()
                };
            }
            return this.config.onchainReservedPerChannel * this.cachedChannelCount.count;
        });
    }
    getWalletTransactions(startHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            const resChainTxns = yield (0, lightning_1.getChainTransactions)({
                lnd: this.lndClient.lnd,
                after: startHeight
            });
            return resChainTxns.transactions.map(lndTxToBtcTx);
        });
    }
    getWalletTransaction(txId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield (0, lightning_1.getChainTransaction)({
                    lnd: this.lndClient.lnd,
                    id: txId
                });
                return lndTxToBtcTx(resp);
            }
            catch (e) {
                if (Array.isArray(e) && e[0] === 503 && e[1] === "UnexpectedGetChainTransactionError" && e[2].err.code === 2)
                    return null;
                (0, Utils_1.handleLndError)(e);
            }
            return null;
        });
    }
    subscribeToWalletTransactions(callback, abortSignal) {
        const res = (0, lightning_1.subscribeToTransactions)({ lnd: this.lndClient.lnd });
        res.on("chain_transaction", (tx) => {
            const parsedTx = lndTxToBtcTx(tx);
            if (callback != null)
                callback(parsedTx);
        });
        if (abortSignal != null)
            abortSignal.addEventListener("abort", () => {
                res.removeAllListeners();
            });
    }
    getUtxos(useCached = false) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!useCached || this.cachedUtxos == null || this.cachedUtxos.timestamp < Date.now() - this.UTXO_CACHE_TIMEOUT) {
                const resBlockheight = yield (0, lightning_1.getHeight)({ lnd: this.lndClient.lnd });
                const blockheight = resBlockheight.current_block_height;
                const [resChainTxns, resUtxos] = yield Promise.all([
                    (0, lightning_1.getChainTransactions)({
                        lnd: this.lndClient.lnd,
                        after: blockheight - this.CONFIRMATIONS_REQUIRED
                    }),
                    (0, lightning_1.getUtxos)({ lnd: this.lndClient.lnd })
                ]);
                const selfUTXOs = lp_lib_1.PluginManager.getWhitelistedTxIds();
                const transactions = resChainTxns.transactions;
                for (let tx of transactions) {
                    if (tx.is_outgoing) {
                        selfUTXOs.add(tx.id);
                    }
                }
                this.cachedUtxos = {
                    timestamp: Date.now(),
                    utxos: resUtxos.utxos
                        .filter(utxo => utxo.confirmation_count >= this.CONFIRMATIONS_REQUIRED || selfUTXOs.has(utxo.transaction_id))
                        .map(utxo => {
                        return {
                            address: utxo.address,
                            type: this.ADDRESS_FORMAT_MAP[utxo.address_format],
                            confirmations: utxo.confirmation_count,
                            outputScript: Buffer.from(utxo.output_script, "hex"),
                            value: utxo.tokens,
                            txId: utxo.transaction_id,
                            vout: utxo.transaction_vout
                        };
                    })
                };
            }
            return this.cachedUtxos.utxos;
        });
    }
    getBalance() {
        return __awaiter(this, void 0, void 0, function* () {
            const resUtxos = yield (0, lightning_1.getUtxos)({ lnd: this.lndClient.lnd });
            let confirmed = 0;
            let unconfirmed = 0;
            resUtxos.utxos.forEach(utxo => {
                if (utxo.confirmation_count > 0) {
                    confirmed += utxo.tokens;
                }
                else {
                    unconfirmed += utxo.tokens;
                }
            });
            return { confirmed, unconfirmed };
        });
    }
    sendRawTransaction(tx) {
        return __awaiter(this, void 0, void 0, function* () {
            yield (0, lightning_1.broadcastChainTransaction)({
                lnd: this.lndClient.lnd,
                transaction: tx
            });
            this.cachedUtxos = null;
        });
    }
    signPsbt(psbt) {
        return __awaiter(this, void 0, void 0, function* () {
            const resp = yield (0, lightning_1.signPsbt)({
                lnd: this.lndClient.lnd,
                psbt: psbt.toHex()
            });
            const tx = bitcoinjs_lib_1.Transaction.fromHex(resp.transaction);
            const _psbt = bitcoinjs_lib_1.Psbt.fromHex(resp.psbt);
            return {
                psbt: _psbt,
                tx,
                raw: resp.transaction,
                txId: tx.getId(),
                networkFee: _psbt.getFee()
            };
        });
    }
    /**
     * Computes bitcoin on-chain network fee, takes channel reserve & network fee multiplier into consideration
     *
     * @param targetAddress Bitcoin address to send the funds to
     * @param targetAmount Amount of funds to send to the address
     * @param estimate Whether the chain fee should be just estimated and therefore cached utxo set could be used
     * @param multiplier Multiplier for the sats/vB returned from the fee estimator
     * @param feeRate Fee rate in sats/vB to use for the transaction
     * @private
     * @returns Fee estimate & inputs/outputs to use when constructing transaction, or null in case of not enough funds
     */
    getChainFee(targetAddress, targetAmount, estimate = false, multiplier, feeRate) {
        return __awaiter(this, void 0, void 0, function* () {
            if (feeRate == null)
                feeRate = yield this.getFeeRate();
            let satsPerVbyte = Math.ceil(feeRate);
            if (multiplier != null)
                satsPerVbyte = Math.ceil(satsPerVbyte * multiplier);
            const utxoPool = yield this.getUtxos(estimate);
            let obj = (0, coinselect2_1.coinSelect)(utxoPool, [{
                    address: targetAddress,
                    value: targetAmount,
                    script: this.toOutputScript(targetAddress)
                }], satsPerVbyte, this.CHANGE_ADDRESS_TYPE);
            if (obj.inputs == null || obj.outputs == null) {
                logger.debug("getChainFee(): Cannot run coinselection algorithm, not enough funds?");
                return null;
            }
            const leavesUtxos = utxoPool.filter(val => !obj.inputs.includes(val));
            if (obj.outputs.length > 1)
                leavesUtxos.push(obj.outputs[1]);
            const leavesEconomicValue = utils_1.utils.utxoEconomicValue(leavesUtxos, satsPerVbyte);
            const requiredReserve = yield this.getRequiredReserve(estimate);
            if (leavesEconomicValue < requiredReserve) {
                logger.debug("getChainFee(): Doesn't leave enough for reserve, required reserve: " + requiredReserve + " leavesValue: " + leavesEconomicValue);
                return null;
            }
            logger.info("getChainFee(): fee estimated," +
                " target: " + targetAddress +
                " amount: " + targetAmount.toString(10) +
                " fee: " + obj.fee +
                " sats/vB: " + satsPerVbyte +
                " inputs: " + obj.inputs.length +
                " outputs: " + obj.outputs.length +
                " multiplier: " + (multiplier !== null && multiplier !== void 0 ? multiplier : 1) + "" +
                " leaveValue: " + leavesEconomicValue);
            return {
                networkFee: obj.fee,
                satsPerVbyte,
                outputs: obj.outputs,
                inputs: obj.inputs
            };
        });
    }
    /**
     * Gets the change address from the underlying LND instance
     *
     * @private
     */
    getChangeAddress() {
        return new Promise((resolve, reject) => {
            this.lndClient.lnd.wallet.nextAddr({
                type: this.LND_ADDRESS_TYPE_ENUM[this.CHANGE_ADDRESS_TYPE],
                change: true
            }, (err, res) => {
                if (err != null) {
                    reject([503, 'UnexpectedErrGettingNextAddr', { err }]);
                    return;
                }
                resolve(res.addr);
            });
        });
    }
    /**
     * Create PSBT for swap payout from coinselection result
     *
     * @param nonce
     * @param coinselectResult
     * @private
     */
    getPsbt(coinselectResult, nonce) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            let psbt = new bitcoinjs_lib_1.Psbt();
            let sequence = 0xFFFFFFFD;
            //Apply nonce
            if (nonce != null) {
                const nonceBuffer = Buffer.from(nonce.toArray("be", 8));
                const locktimeBN = new BN(nonceBuffer.slice(0, 5), "be");
                let locktime = locktimeBN.toNumber() + 500000000;
                if (locktime > (Date.now() / 1000 - 24 * 60 * 60))
                    throw new Error("Invalid escrow nonce!");
                psbt.setLocktime(locktime);
                const sequenceBN = new BN(nonceBuffer.slice(5, 8), "be");
                sequence = 0xFE000000 + sequenceBN.toNumber();
            }
            psbt.addInputs(coinselectResult.inputs.map(input => {
                return {
                    hash: input.txId,
                    index: input.vout,
                    witnessUtxo: {
                        script: input.outputScript,
                        value: input.value
                    },
                    sighashType: 0x01,
                    sequence
                };
            }));
            //Add address for change output
            for (let output of coinselectResult.outputs) {
                (_a = output.script) !== null && _a !== void 0 ? _a : (output.script = bitcoin.address.toOutputScript(yield this.getChangeAddress(), this.config.network));
            }
            psbt.addOutputs(coinselectResult.outputs.map(output => {
                return {
                    script: output.script,
                    value: output.value
                };
            }));
            return psbt;
        });
    }
    /**
     * Runs sanity check on the calculated fee for the transaction
     *
     * @param psbt
     * @param tx
     * @param maxAllowedSatsPerVbyte
     * @param actualSatsPerVbyte
     * @private
     * @throws {Error} Will throw an error if the fee sanity check doesn't pass
     */
    checkPsbtFee(psbt, tx, maxAllowedSatsPerVbyte, actualSatsPerVbyte) {
        const txFee = psbt.getFee();
        //Sanity check on sats/vB
        const maxAllowedFee = (tx.virtualSize() +
            //Considering the extra output was not added, because was detrminetal
            utils_1.utils.outputBytes({ type: this.CHANGE_ADDRESS_TYPE })) * maxAllowedSatsPerVbyte +
            //Possibility that extra output was not added due to it being lower than dust
            utils_1.utils.dustThreshold({ type: this.CHANGE_ADDRESS_TYPE });
        if (txFee > maxAllowedFee)
            throw new Error("Generated tx fee too high: " + JSON.stringify({
                maxAllowedFee: maxAllowedFee.toString(10),
                actualFee: txFee.toString(10),
                psbtHex: psbt.toHex(),
                maxAllowedSatsPerVbyte: maxAllowedSatsPerVbyte.toString(10),
                actualSatsPerVbyte: actualSatsPerVbyte.toString(10)
            }));
    }
    getSignedTransaction(destination, amount, feeRate, nonce, maxAllowedFeeRate) {
        return __awaiter(this, void 0, void 0, function* () {
            const res = yield this.getChainFee(destination, amount, false, null, feeRate);
            if (res == null)
                return null;
            const psbt = yield this.getPsbt(res, nonce);
            const psbtResp = yield this.signPsbt(psbt);
            if (maxAllowedFeeRate != null)
                this.checkPsbtFee(psbtResp.psbt, psbtResp.tx, maxAllowedFeeRate, res.satsPerVbyte);
            return psbtResp;
        });
    }
    drainAll(_destination, inputs, feeRate) {
        return __awaiter(this, void 0, void 0, function* () {
            feeRate !== null && feeRate !== void 0 ? feeRate : (feeRate = yield this.getFeeRate());
            const destination = typeof (_destination) === "string" ? this.toOutputScript(_destination) : _destination;
            const txBytes = utils_1.utils.transactionBytes(inputs, [{ script: destination }]);
            const txFee = txBytes * feeRate;
            const adjustedOutput = inputs.reduce((prev, curr) => prev + curr.value, 0) - txFee;
            if (adjustedOutput < 546) {
                return null;
            }
            const psbt = yield this.getPsbt({ inputs, outputs: [{ value: adjustedOutput, script: destination }] });
            return yield this.signPsbt(psbt);
        });
    }
    burnAll(inputs) {
        return __awaiter(this, void 0, void 0, function* () {
            const psbt = yield this.getPsbt({ inputs, outputs: [{
                        script: Buffer.concat([Buffer.from([0x6a, 20]), Buffer.from("BURN, BABY, BURN! AQ", "ascii")]),
                        value: 0
                    }] });
            return yield this.signPsbt(psbt);
        });
    }
    estimateFee(destination, amount, feeRate, feeRateMultiplier) {
        return this.getChainFee(destination, amount, true, feeRateMultiplier, feeRate);
    }
}
exports.LNDBitcoinWallet = LNDBitcoinWallet;
