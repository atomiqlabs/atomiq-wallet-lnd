"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LNDBitcoinWallet = void 0;
const LNDClient_1 = require("./LNDClient");
const lightning_1 = require("lightning");
const utils_1 = require("../utils/coinselect2/utils");
const coinselect2_1 = require("../utils/coinselect2");
const Utils_1 = require("../utils/Utils");
const server_base_1 = require("@atomiqlabs/server-base");
const lp_lib_1 = require("@atomiqlabs/lp-lib");
const btc_signer_1 = require("@scure/btc-signer");
const buffer_1 = require("buffer");
const UnionFind_1 = require("../utils/UnionFind");
function lndTxToBtcTx(tx) {
    const btcTx = btc_signer_1.Transaction.fromRaw(buffer_1.Buffer.from(tx.transaction, "hex"), {
        allowUnknownOutputs: true,
        allowUnknownInputs: true,
        allowLegacyWitnessUtxo: true,
        disableScriptCheck: true
    });
    return {
        locktime: btcTx.lockTime,
        version: btcTx.version,
        blockhash: tx.block_id,
        confirmations: tx.confirmation_count,
        txid: tx.id,
        hex: buffer_1.Buffer.from(btcTx.toBytes(true, false)).toString("hex"),
        raw: tx.transaction,
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
        this.MAX_MEMPOOL_TX_CHAIN = 10;
        this.unconfirmedTxIdBlacklist = new Set();
        this.UTXO_CACHE_TIMEOUT = 5 * 1000;
        this.CHANNEL_COUNT_CACHE_TIMEOUT = 30 * 1000;
        if (configOrClient instanceof LNDClient_1.LNDClient) {
            this.lndClient = configOrClient;
        }
        else {
            this.lndClient = new LNDClient_1.LNDClient(configOrClient);
        }
        this.config = config;
        (_a = this.config).network ?? (_a.network = btc_signer_1.NETWORK);
        (_b = this.config).onchainReservedPerChannel ?? (_b.onchainReservedPerChannel = 50000);
        this.addressPoolStorage = new lp_lib_1.StorageManager(this.config.storageDirectory);
    }
    async init() {
        await this.addressPoolStorage.init();
        await this.addressPoolStorage.loadData(LNDSavedAddress);
        await this.lndClient.init();
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
        return [
            (0, server_base_1.createCommand)("splitutxos", "Splits funds to a bunch of smaller utxos", {
                args: {
                    count: {
                        base: true,
                        description: "Count of the UTXOs to create",
                        parser: (0, server_base_1.cmdNumberParser)(false, 1)
                    },
                    value: {
                        base: true,
                        description: "Value of the single UTXO",
                        parser: (0, server_base_1.cmdNumberParser)(true, 0)
                    },
                    feeRate: {
                        base: false,
                        description: "Fee rate for the transaction (sats/vB)",
                        parser: (0, server_base_1.cmdNumberParser)(false, 1, null, true)
                    }
                },
                parser: async (args, sendLine) => {
                    if (this.lndClient.lnd == null)
                        throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                    const changeAddress = await this.getChangeAddress();
                    const amount = Number((0, server_base_1.fromDecimal)(args.value.toFixed(8), 8));
                    const destinations = [];
                    for (let i = 0; i < args.count; i++) {
                        destinations.push({ address: changeAddress, amount });
                    }
                    const result = await this.getSignedMultiTransaction(destinations, args.feeRate);
                    await this.sendRawTransaction(result.raw);
                    return {
                        success: true,
                        message: "UTXOs split, wait for TX confirmations!",
                        transactionId: result.txId,
                    };
                }
            })
        ];
    }
    toOutputScript(_address) {
        const outputScript = (0, btc_signer_1.Address)(this.config.network).decode(_address);
        switch (outputScript.type) {
            case "pkh":
            case "sh":
            case "wpkh":
            case "wsh":
                return buffer_1.Buffer.from(btc_signer_1.OutScript.encode({
                    type: outputScript.type,
                    hash: outputScript.hash
                }));
            case "tr":
                return buffer_1.Buffer.from(btc_signer_1.OutScript.encode({
                    type: "tr",
                    pubkey: outputScript.pubkey
                }));
        }
        throw new Error("Unrecognized address type");
    }
    async getBlockheight() {
        const res = await (0, lightning_1.getHeight)({ lnd: this.lndClient.lnd });
        return res.current_block_height;
    }
    async getFeeRate() {
        let feeRate;
        if (this.config.feeEstimator != null) {
            feeRate = await this.config.feeEstimator.estimateFee();
        }
        else {
            feeRate = await (0, lightning_1.getChainFeeRate)({ lnd: this.lndClient.lnd })
                .then(val => val.tokens_per_vbyte);
        }
        if (feeRate == null || feeRate === 0)
            throw new Error("Unable to estimate chain fee!");
        return feeRate;
    }
    getAddressType() {
        return this.RECEIVE_ADDRESS_TYPE;
    }
    addUnusedAddress(address) {
        logger.debug("addUnusedAddress(): Adding new unused address to local address pool: ", address);
        return this.addressPoolStorage.saveData(address, new LNDSavedAddress(address));
    }
    async getAddress() {
        const addressPool = Object.keys(this.addressPoolStorage.data);
        if (addressPool.length > 0) {
            const address = addressPool[0];
            await this.addressPoolStorage.removeData(address);
            logger.debug("getAddress(): Address returned from local address pool: ", address);
            return address;
        }
        const res = await (0, lightning_1.createChainAddress)({
            lnd: this.lndClient.lnd,
            format: this.RECEIVE_ADDRESS_TYPE
        });
        logger.debug("getAddress(): Address returned from LND: ", res.address);
        return res.address;
    }
    async getRequiredReserve(useCached = false) {
        if (!useCached || this.cachedChannelCount == null || this.cachedChannelCount.timestamp < Date.now() - this.CHANNEL_COUNT_CACHE_TIMEOUT) {
            const { channels } = await (0, lightning_1.getChannels)({ lnd: this.lndClient.lnd });
            this.cachedChannelCount = {
                count: channels.length,
                timestamp: Date.now()
            };
        }
        return this.config.onchainReservedPerChannel * this.cachedChannelCount.count;
    }
    async getWalletTransactions(startHeight) {
        const resChainTxns = await (0, lightning_1.getChainTransactions)({
            lnd: this.lndClient.lnd,
            after: startHeight
        });
        return resChainTxns.transactions.map(lndTxToBtcTx);
    }
    async getWalletTransaction(txId) {
        try {
            const resp = await (0, lightning_1.getChainTransaction)({
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
    async getUtxos(useCached = false) {
        if (!useCached || this.cachedUtxos == null || this.cachedUtxos.timestamp < Date.now() - this.UTXO_CACHE_TIMEOUT) {
            const resBlockheight = await (0, lightning_1.getHeight)({ lnd: this.lndClient.lnd });
            const blockheight = resBlockheight.current_block_height;
            const [{ transactions }, resUtxos] = await Promise.all([
                (0, lightning_1.getChainTransactions)({
                    lnd: this.lndClient.lnd,
                    after: blockheight - this.CONFIRMATIONS_REQUIRED
                }),
                (0, lightning_1.getUtxos)({ lnd: this.lndClient.lnd })
            ]);
            const selfUTXOs = lp_lib_1.PluginManager.getWhitelistedTxIds();
            const unconfirmedTxMap = new Map(transactions.map(val => [val.id, val]));
            for (let tx of transactions) {
                if (tx.is_outgoing) {
                    selfUTXOs.add(tx.id);
                }
                if (!tx.is_confirmed)
                    unconfirmedTxMap.set(tx.id, tx);
            }
            const unionFind = new UnionFind_1.UnionFind();
            for (let [txId, tx] of unconfirmedTxMap) {
                unionFind.add(txId);
                for (let input of tx.inputs) {
                    if (!input.is_local)
                        continue;
                    if (!unconfirmedTxMap.has(input.transaction_id))
                        continue;
                    unionFind.union(txId, input.transaction_id);
                }
            }
            const txClusters = unionFind.getClusters();
            // for(let [txId, clusterSet] of txClusters) {
            //     logger.debug("getUtxos(): Unconfirmed tx cluster count for "+txId+" is "+clusterSet.size);
            // }
            this.cachedUtxos = {
                timestamp: Date.now(),
                utxos: resUtxos.utxos
                    .filter(utxo => {
                    if (utxo.confirmation_count < this.CONFIRMATIONS_REQUIRED && !selfUTXOs.has(utxo.transaction_id))
                        return false;
                    if (utxo.confirmation_count === 0) {
                        const cluster = txClusters.get(utxo.transaction_id);
                        if (cluster == null) {
                            logger.warn("getUtxos(): Unconfirmed UTXO " + utxo.transaction_id + " but cannot find existing cluster!");
                            return false;
                        }
                        const clusterSize = cluster.size;
                        if (clusterSize >= this.MAX_MEMPOOL_TX_CHAIN) {
                            // logger.debug("getUtxos(): Unconfirmed UTXO "+utxo.transaction_id+" existing mempool tx chain too long: "+clusterSize);
                            return false;
                        }
                        if (this.unconfirmedTxIdBlacklist.has(utxo.transaction_id)) {
                            return false;
                        }
                    }
                    return true;
                })
                    .map(utxo => {
                    return {
                        address: utxo.address,
                        type: this.ADDRESS_FORMAT_MAP[utxo.address_format],
                        confirmations: utxo.confirmation_count,
                        outputScript: buffer_1.Buffer.from(utxo.output_script, "hex"),
                        value: utxo.tokens,
                        txId: utxo.transaction_id,
                        vout: utxo.transaction_vout
                    };
                })
            };
        }
        return this.cachedUtxos.utxos;
    }
    async getBalance() {
        const resUtxos = await (0, lightning_1.getUtxos)({ lnd: this.lndClient.lnd });
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
    }
    async sendRawTransaction(tx) {
        try {
            await (0, lightning_1.broadcastChainTransaction)({
                lnd: this.lndClient.lnd,
                transaction: tx
            });
        }
        catch (e) {
            if (Array.isArray(e) && e[0] === 503 && e[2].err.details === "undefined: too-long-mempool-chain") {
                //Blacklist those UTXOs till confirmed
                const parsedTx = btc_signer_1.Transaction.fromRaw(buffer_1.Buffer.from(tx, "hex"), {
                    allowUnknownOutputs: true,
                    allowLegacyWitnessUtxo: true,
                    allowUnknownInputs: true
                });
                for (let i = 0; i < parsedTx.inputsLength; i++) {
                    const input = parsedTx.getInput(i);
                    const txId = buffer_1.Buffer.from(input.txid).toString("hex");
                    logger.warn("sendRawTransaction(): Adding UTXO txId to blacklist because too-long-mempool-chain: ", txId);
                    this.unconfirmedTxIdBlacklist.add(txId);
                }
            }
            throw e;
        }
        this.cachedUtxos = null;
    }
    async signPsbt(psbt) {
        const resp = await (0, lightning_1.signPsbt)({
            lnd: this.lndClient.lnd,
            psbt: buffer_1.Buffer.from(psbt.toPSBT(0)).toString("hex")
        });
        const tx = btc_signer_1.Transaction.fromRaw(buffer_1.Buffer.from(resp.transaction, "hex"), {
            allowUnknownOutputs: true,
            allowLegacyWitnessUtxo: true
        });
        const _psbt = btc_signer_1.Transaction.fromPSBT(buffer_1.Buffer.from(resp.psbt, "hex"), {
            allowUnknownOutputs: true,
            allowLegacyWitnessUtxo: true
        });
        return {
            psbt: _psbt,
            tx,
            raw: resp.transaction,
            txId: tx.id,
            networkFee: Number(_psbt.fee)
        };
    }
    /**
     * Computes bitcoin on-chain network fee, takes channel reserve & network fee multiplier into consideration
     *
     * @param destinations
     * @param estimate Whether the chain fee should be just estimated and therefore cached utxo set could be used
     * @param multiplier Multiplier for the sats/vB returned from the fee estimator
     * @param feeRate Fee rate in sats/vB to use for the transaction
     * @param requiredInputs
     * @private
     * @returns Fee estimate & inputs/outputs to use when constructing transaction, or null in case of not enough funds
     */
    async getChainFee(destinations, estimate = false, multiplier, feeRate, requiredInputs) {
        if (feeRate == null)
            feeRate = await this.getFeeRate();
        let satsPerVbyte = Math.ceil(feeRate);
        if (multiplier != null)
            satsPerVbyte = Math.ceil(satsPerVbyte * multiplier);
        const utxoPool = await this.getUtxos(estimate);
        let obj = (0, coinselect2_1.coinSelect)(utxoPool, destinations.map(val => {
            return {
                address: val.address,
                value: val.amount,
                script: val.script ?? this.toOutputScript(val.address)
            };
        }), satsPerVbyte, this.CHANGE_ADDRESS_TYPE, requiredInputs);
        if (obj.inputs == null || obj.outputs == null) {
            logger.debug("getChainFee(): Cannot run coinselection algorithm, not enough funds?");
            return null;
        }
        const leavesUtxos = utxoPool.filter(val => !obj.inputs.includes(val));
        if (obj.outputs.length > 1)
            leavesUtxos.push(obj.outputs[1]);
        const leavesEconomicValue = utils_1.utils.utxoEconomicValue(leavesUtxos, satsPerVbyte);
        const requiredReserve = await this.getRequiredReserve(estimate);
        if (leavesEconomicValue < requiredReserve) {
            logger.debug("getChainFee(): Doesn't leave enough for reserve, required reserve: " + requiredReserve + " leavesValue: " + leavesEconomicValue);
            return null;
        }
        logger.info("getChainFee(): fee estimated," +
            " targets: " + destinations.map(val => (val.script ? "script(" + val.script.toString("hex") + ")" : val.address) + "=" + val.amount).join(", ") +
            " fee: " + obj.fee +
            " sats/vB: " + satsPerVbyte +
            " inputs: " + obj.inputs.length +
            " outputs: " + obj.outputs.length +
            " multiplier: " + (multiplier ?? 1) + "" +
            " leaveValue: " + leavesEconomicValue);
        return {
            networkFee: obj.fee,
            satsPerVbyte,
            outputs: obj.outputs,
            inputs: obj.inputs
        };
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
    async addToPsbt(psbt, coinselectInputs, coinselectOutputs) {
        const inputs = coinselectInputs.map(input => {
            return {
                txid: input.txId,
                index: input.vout,
                witnessUtxo: {
                    script: input.outputScript,
                    amount: BigInt(input.value)
                },
                sighashType: 0x01,
                sequence: 0
            };
        });
        inputs.forEach(input => psbt.addInput(input));
        //Add address for change output
        for (let output of coinselectOutputs) {
            output.script ?? (output.script = this.toOutputScript(await this.getChangeAddress()));
        }
        const outputs = coinselectOutputs.map(output => {
            return {
                script: output.script,
                amount: BigInt(output.value)
            };
        });
        outputs.forEach(output => psbt.addOutput(output));
    }
    /**
     * Create PSBT for swap payout from coinselection result
     *
     * @param nonce
     * @param coinselectResult
     * @private
     */
    async getPsbt(coinselectResult, nonce) {
        let locktime = 0;
        let sequence = 0xFFFFFFFD;
        //Apply nonce
        if (nonce != null) {
            const locktimeBN = nonce >> 24n;
            locktime = Number(locktimeBN) + 500000000;
            if (locktime > (Date.now() / 1000 - 24 * 60 * 60))
                throw new Error("Invalid escrow nonce (locktime)!");
            const sequenceBN = nonce & 0xffffffn;
            sequence = 0xFE000000 + Number(sequenceBN);
        }
        let psbt = new btc_signer_1.Transaction({ lockTime: locktime });
        //Add coinselect results to PSBT
        await this.addToPsbt(psbt, coinselectResult.inputs, coinselectResult.outputs);
        //Apply nonce
        for (let i = 0; i < psbt.inputsLength; i++) {
            psbt.updateInput(i, { sequence });
        }
        return psbt;
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
        const txFee = Number(psbt.fee);
        //Sanity check on sats/vB
        const maxAllowedFee = (tx.vsize +
            //Considering the extra output was not added, because was detrminetal
            utils_1.utils.outputBytes({ type: this.CHANGE_ADDRESS_TYPE })) * maxAllowedSatsPerVbyte +
            //Possibility that extra output was not added due to it being lower than dust
            utils_1.utils.dustThreshold({ type: this.CHANGE_ADDRESS_TYPE });
        if (txFee > maxAllowedFee)
            throw new Error("Generated tx fee too high: " + JSON.stringify({
                maxAllowedFee: maxAllowedFee.toString(10),
                actualFee: txFee.toString(10),
                psbtHex: buffer_1.Buffer.from(psbt.toPSBT(0)).toString("hex"),
                maxAllowedSatsPerVbyte: maxAllowedSatsPerVbyte.toString(10),
                actualSatsPerVbyte: actualSatsPerVbyte.toString(10)
            }));
    }
    getSignedTransaction(destination, amount, feeRate, nonce, maxAllowedFeeRate) {
        return this.getSignedMultiTransaction([{ address: destination, amount }], feeRate, nonce, maxAllowedFeeRate);
    }
    async getSignedMultiTransaction(destinations, feeRate, nonce, maxAllowedFeeRate) {
        const res = await this.getChainFee(destinations, false, null, feeRate);
        if (res == null)
            return null;
        const psbt = await this.getPsbt(res, nonce);
        const psbtResp = await this.signPsbt(psbt);
        if (maxAllowedFeeRate != null)
            this.checkPsbtFee(psbtResp.psbt, psbtResp.tx, maxAllowedFeeRate, res.satsPerVbyte);
        return psbtResp;
    }
    async drainAll(_destination, inputs, feeRate) {
        feeRate ?? (feeRate = await this.getFeeRate());
        const destination = typeof (_destination) === "string" ? this.toOutputScript(_destination) : _destination;
        const txBytes = utils_1.utils.transactionBytes(inputs, [{ script: destination }]);
        const txFee = txBytes * feeRate;
        const adjustedOutput = inputs.reduce((prev, curr) => prev + curr.value, 0) - txFee;
        if (adjustedOutput < 546) {
            return null;
        }
        const psbt = await this.getPsbt({ inputs, outputs: [{ value: adjustedOutput, script: destination }] });
        return await this.signPsbt(psbt);
    }
    async burnAll(inputs) {
        const psbt = await this.getPsbt({ inputs, outputs: [{
                    script: buffer_1.Buffer.concat([buffer_1.Buffer.from([0x6a, 20]), buffer_1.Buffer.from("BURN, BABY, BURN! AQ", "ascii")]),
                    value: 0
                }] });
        return await this.signPsbt(psbt);
    }
    estimateFee(destination, amount, feeRate, feeRateMultiplier) {
        return this.getChainFee([{ address: destination, amount }], true, feeRateMultiplier, feeRate);
    }
    parsePsbt(psbt) {
        return Promise.resolve((0, Utils_1.bitcoinTxToBtcTx)(psbt));
    }
    async fundPsbt(psbt, feeRate) {
        const requiredInputs = [];
        const requiredOutputs = [];
        //Try to extract data about psbt input type
        for (let i = 0; i < psbt.inputsLength; i++) {
            requiredInputs.push((0, Utils_1.toCoinselectInput)(psbt.getInput(i)));
        }
        for (let i = 0; i < psbt.outputsLength; i++) {
            const output = psbt.getOutput(i);
            requiredOutputs.push({
                script: buffer_1.Buffer.from(output.script),
                amount: Number(output.amount)
            });
        }
        const res = await this.getChainFee(requiredOutputs, false, null, feeRate, requiredInputs);
        if (res == null)
            return null;
        res.inputs.splice(0, requiredInputs.length);
        res.outputs.splice(0, requiredOutputs.length);
        await this.addToPsbt(psbt, res.inputs, res.outputs);
        return psbt;
    }
}
exports.LNDBitcoinWallet = LNDBitcoinWallet;
