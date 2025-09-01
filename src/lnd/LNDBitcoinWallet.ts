import {LNDClient, LNDConfig} from "./LNDClient";
import {BtcTx, IStorageManager, StorageObject} from "@atomiqlabs/base";
import {
    broadcastChainTransaction, ChainTransaction,
    createChainAddress, getChainFeeRate, getChainTransaction,
    getChainTransactions,
    getChannels,
    getHeight,
    getUtxos,
    signPsbt, subscribeToTransactions, SubscribeToTransactionsChainTransactionEvent
} from "lightning";
import {CoinselectAddressTypes, CoinselectTxInput, CoinselectTxOutput, utils} from "../utils/coinselect2/utils";
import {coinSelect} from "../utils/coinselect2";
import {bitcoinTxToBtcTx, getLogger, handleLndError, toCoinselectInput} from "../utils/Utils";
import {cmdNumberParser, Command, createCommand, fromDecimal} from "@atomiqlabs/server-base";
import {
    BitcoinUtxo,
    IBitcoinWallet,
    IBtcFeeEstimator,
    PluginManager,
    SignPsbtResponse,
    StorageManager
} from "@atomiqlabs/lp-lib";
import {Address, NETWORK, OutScript, Script, Transaction} from "@scure/btc-signer";
import {BTC_NETWORK} from "@scure/btc-signer/utils";
import {Buffer} from "buffer";
import {UnionFind} from "../utils/UnionFind";
import {PromiseQueue} from "promise-queue-ts";

export type LNDBitcoinWalletConfig = {
    storageDirectory: string,
    network?: BTC_NETWORK,
    feeEstimator?: IBtcFeeEstimator,
    onchainReservedPerChannel?: number,
};

function lndTxToBtcTx(tx: ChainTransaction): BtcTx {
    const btcTx = Transaction.fromRaw(Buffer.from(tx.transaction, "hex"), {
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
        hex: Buffer.from(btcTx.toBytes(true, false)).toString("hex"),
        raw: tx.transaction,
        vsize: btcTx.vsize,

        outs: Array.from({length: btcTx.outputsLength}, (_, i) => i).map((index) => {
            const output = btcTx.getOutput(index);
            return {
                value: Number(output.amount),
                n: index,
                scriptPubKey: {
                    asm: Script.decode(output.script).map(val => typeof(val)==="object" ? Buffer.from(val).toString("hex") : val.toString()).join(" "),
                    hex: Buffer.from(output.script).toString("hex")
                }
            }
        }),
        ins: Array.from({length: btcTx.inputsLength}, (_, i) => i).map(index => {
            const input = btcTx.getInput(index);
            return {
                txid: Buffer.from(input.txid).toString("hex"),
                vout: input.index,
                scriptSig: {
                    asm: Script.decode(input.finalScriptSig).map(val => typeof(val)==="object" ? Buffer.from(val).toString("hex") : val.toString()).join(" "),
                    hex: Buffer.from(input.finalScriptSig).toString("hex")
                },
                sequence: input.sequence,
                txinwitness: input.finalScriptWitness.map(witness => Buffer.from(witness).toString("hex"))
            }
        })
    }
}

const logger = getLogger("LNDBitcoinWallet: ");

class LNDSavedAddress implements StorageObject {

    address: string;

    constructor(objOrAddress: string | any) {
        if(typeof(objOrAddress)==="string") {
            this.address = objOrAddress;
        } else {
            this.address = objOrAddress.address;
        }
    }

    serialize(): any {
        return {address: this.address};
    }

}

export class LNDBitcoinWallet implements IBitcoinWallet {

    protected readonly LND_ADDRESS_TYPE_ENUM = {
        "p2wpkh": 1,
        "p2sh-p2wpkh": 2,
        "p2tr": 4
    };
    protected readonly ADDRESS_FORMAT_MAP = {
        "p2wpkh": "p2wpkh",
        "np2wpkh": "p2sh-p2wpkh",
        "p2tr" : "p2tr"
    };
    protected readonly CHANGE_ADDRESS_TYPE = "p2tr";
    protected readonly RECEIVE_ADDRESS_TYPE = "p2wpkh";
    protected readonly CONFIRMATIONS_REQUIRED = 1;
    protected readonly MAX_MEMPOOL_TX_CHAIN = 10;

    protected readonly unconfirmedTxIdBlacklist: Set<string> = new Set<string>();

    protected readonly UTXO_CACHE_TIMEOUT = 5*1000;
    cachedUtxos: {
        utxos: BitcoinUtxo[],
        timestamp: number
    };
    readonly CHANNEL_COUNT_CACHE_TIMEOUT = 30*1000;
    cachedChannelCount: {
        count: number,
        timestamp: number
    };
    private readonly addressPoolStorage: IStorageManager<LNDSavedAddress>;

    private readonly lndClient: LNDClient;

    readonly config: LNDBitcoinWalletConfig;

    constructor(lndConfig: LNDConfig, config: LNDBitcoinWalletConfig);
    constructor(client: LNDClient, config: LNDBitcoinWalletConfig);
    constructor(configOrClient: LNDConfig | LNDClient, config: LNDBitcoinWalletConfig) {
        if(configOrClient instanceof LNDClient) {
            this.lndClient = configOrClient;
        } else {
            this.lndClient = new LNDClient(configOrClient);
        }
        this.config = config;
        this.config.network ??= NETWORK;
        this.config.onchainReservedPerChannel ??= 50000;
        this.addressPoolStorage = new StorageManager(this.config.storageDirectory);
    }

    async init(): Promise<void> {
        await this.addressPoolStorage.init();
        await this.addressPoolStorage.loadData(LNDSavedAddress);
        await this.lndClient.init();
    }

    isReady(): boolean {
        return this.lndClient.isReady();
    }

    getStatus(): string {
        return this.lndClient.status;
    }

    getStatusInfo(): Promise<Record<string, string>> {
        return this.lndClient.getStatusInfo();
    }

    getCommands(): Command<any>[] {
        return [
            createCommand(
                "splitutxos",
                "Splits funds to a bunch of smaller utxos",
                {
                    args: {
                        count: {
                            base: true,
                            description: "Count of the UTXOs to create",
                            parser: cmdNumberParser(false, 1)
                        },
                        value: {
                            base: true,
                            description: "Value of the single UTXO",
                            parser: cmdNumberParser(true, 0)
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate for the transaction (sats/vB)",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine): Promise<any> => {
                        if(this.lndClient.lnd==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const changeAddress = await this.getChangeAddress();
                        const amount = Number(fromDecimal(args.value.toFixed(8), 8));
                        const destinations = [];
                        for(let i=0;i<args.count;i++) {
                            destinations.push({address: changeAddress, amount})
                        }
                        const result = await this.lndClient.executeOnWallet(async () => {
                            const result = await this.getSignedMultiTransaction(destinations, args.feeRate);
                            await this.sendRawTransaction(result.raw);
                            return result;
                        })
                        return {
                            success: true,
                            message: "UTXOs split, wait for TX confirmations!",
                            transactionId: result.txId,
                        };
                    }
                }
            ),
            createCommand(
                "consolidateutxos",
                "Consolidates small UTXOs",
                {
                    args: {
                        value: {
                            base: true,
                            description: "Maximum value of a single UTXO to use",
                            parser: cmdNumberParser(true, 546)
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate for the transaction (sats/vB)",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine): Promise<any> => {
                        if(this.lndClient.lnd==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const feeRate = args.feeRate ?? await this.getFeeRate();
                        const changeAddress = await this.getChangeAddress();

                        const consolidations: {
                            txId: string,
                            utxoCount: number,
                            outputValue: number,
                            txFee: number
                        }[] = [];

                        await this.lndClient.executeOnWallet(async () => {
                            const utxos = await this.getUtxos(false);
                            const economicalUtxos = utxos.filter(val => val.value<=args.value && utils.utxoEconomicValue([val], feeRate) > 1000);

                            logger.info(`consolidateutxos: Total number of economical utxos: ${utxos.length}`);

                            const changeAddressOutputScript = this.toOutputScript(changeAddress);

                            for(let i=0;i<economicalUtxos.length;i+=1000) {
                                const txUtxos = economicalUtxos.slice(i, i+1000);
                                if(txUtxos.length===0) continue;
                                const txBytes = utils.transactionBytes(txUtxos, [{script: changeAddressOutputScript}]);
                                const inputValue = txUtxos.reduce((prev, curr) => prev + curr.value, 0);
                                const txFee = Math.ceil(txBytes * feeRate);
                                const outputValue = inputValue - txFee;
                                const psbt = await this.getPsbt({inputs: txUtxos, outputs: [{value: outputValue, script: changeAddressOutputScript, address: changeAddress}]});
                                const signed = await this.signPsbt(psbt);
                                this.checkPsbtFee(psbt, signed.tx, (1.2*feeRate) + 1, feeRate);
                                const msg = `consolidateutxos: Consolidating ${txUtxos.length} into single UTXO of ${outputValue} sats, total fee: ${txFee} txId: ${signed.txId}`;
                                logger.info(msg);
                                sendLine(msg);
                                await this.sendRawTransaction(signed.raw);
                                consolidations.push({
                                    txId: signed.txId,
                                    utxoCount: txUtxos.length,
                                    outputValue,
                                    txFee
                                })
                            }
                        });

                        return {
                            success: true,
                            message: "UTXOs consolidated, wait for TXs confirmations!",
                            consolidationTxns: consolidations,
                        };
                    }
                }
            )
        ];
    }

    toOutputScript(_address: string): Buffer {
        const outputScript = Address(this.config.network).decode(_address);
        switch(outputScript.type) {
            case "pkh":
            case "sh":
            case "wpkh":
            case "wsh":
                return Buffer.from(OutScript.encode({
                    type: outputScript.type,
                    hash: outputScript.hash
                }));
            case "tr":
                return Buffer.from(OutScript.encode({
                    type: "tr",
                    pubkey: outputScript.pubkey
                }));
        }
        throw new Error("Unrecognized address type");
    }

    async getBlockheight(): Promise<number> {
        const res = await getHeight({lnd: this.lndClient.lnd});
        return res.current_block_height;
    }

    async getFeeRate(): Promise<number> {
        let feeRate: number;
        if(this.config.feeEstimator!=null) {
            feeRate = await this.config.feeEstimator.estimateFee();
        } else {
            feeRate = await getChainFeeRate({lnd: this.lndClient.lnd})
                .then(val => val.tokens_per_vbyte)
        }
        if(feeRate==null || feeRate===0) throw new Error("Unable to estimate chain fee!");
        return feeRate;
    }

    getAddressType(): "p2wpkh" | "p2sh-p2wpkh" | "p2tr" {
        return this.RECEIVE_ADDRESS_TYPE;
    }

    addUnusedAddress(address: string): Promise<void> {
        logger.debug("addUnusedAddress(): Adding new unused address to local address pool: ", address);
        return this.addressPoolStorage.saveData(address, new LNDSavedAddress(address));
    }

    async getAddress(): Promise<string> {
        const addressPool = Object.keys(this.addressPoolStorage.data);
        if(addressPool.length>0) {
            const address = addressPool[0];
            await this.addressPoolStorage.removeData(address);
            logger.debug("getAddress(): Address returned from local address pool: ", address);
            return address;
        }
        const res = await createChainAddress({
            lnd: this.lndClient.lnd,
            format: this.RECEIVE_ADDRESS_TYPE
        });
        logger.debug("getAddress(): Address returned from LND: ", res.address);
        return res.address;
    }

    async getRequiredReserve(useCached: boolean = false): Promise<number> {
        if(!useCached || this.cachedChannelCount==null || this.cachedChannelCount.timestamp<Date.now()-this.CHANNEL_COUNT_CACHE_TIMEOUT) {
            const {channels} = await getChannels({lnd: this.lndClient.lnd});
            this.cachedChannelCount = {
                count: channels.length,
                timestamp: Date.now()
            }
        }

        return this.config.onchainReservedPerChannel*this.cachedChannelCount.count;
    }

    async getWalletTransactions(startHeight?: number): Promise<BtcTx[]> {
        const resChainTxns = await getChainTransactions({
            lnd: this.lndClient.lnd,
            after: startHeight
        });
        return resChainTxns.transactions.map(lndTxToBtcTx);
    }

    async getWalletTransaction(txId: string): Promise<BtcTx | null> {
        try {
            const resp = await getChainTransaction({
                lnd: this.lndClient.lnd,
                id: txId
            });
            return lndTxToBtcTx(resp);
        } catch (e) {
            if(Array.isArray(e) && e[0]===503 && e[1]==="UnexpectedGetChainTransactionError" && e[2].err.code===2) return null;
            handleLndError(e);
        }
        return null;
    }

    subscribeToWalletTransactions(callback: (tx: BtcTx) => void, abortSignal?: AbortSignal) {
        const res = subscribeToTransactions({lnd: this.lndClient.lnd});
        res.on("chain_transaction", (tx: SubscribeToTransactionsChainTransactionEvent) => {
            const parsedTx = lndTxToBtcTx(tx);
            if(callback!=null) callback(parsedTx);
        });
        if(abortSignal!=null) abortSignal.addEventListener("abort", () => {
            res.removeAllListeners();
        });
    }

    async getUtxos(useCached: boolean = false): Promise<BitcoinUtxo[]> {
        if(!useCached || this.cachedUtxos==null || this.cachedUtxos.timestamp<Date.now()-this.UTXO_CACHE_TIMEOUT) {
            const resBlockheight = await getHeight({lnd: this.lndClient.lnd});

            const blockheight: number = resBlockheight.current_block_height;

            const [{transactions}, resUtxos] = await Promise.all([
                getChainTransactions({
                    lnd: this.lndClient.lnd,
                    after: blockheight-this.CONFIRMATIONS_REQUIRED
                }),
                getUtxos({lnd: this.lndClient.lnd})
            ]);

            const selfUTXOs: Set<string> = PluginManager.getWhitelistedTxIds();
            const unconfirmedTxMap: Map<string, ChainTransaction> = new Map(transactions.map(val => [val.id, val]));
            for(let tx of transactions) {
                if(tx.is_outgoing) {
                    selfUTXOs.add(tx.id);
                }
                if(!tx.is_confirmed) unconfirmedTxMap.set(tx.id, tx);
            }

            const unionFind = new UnionFind();
            for(let [txId, tx] of unconfirmedTxMap) {
                unionFind.add(txId);
                for(let input of tx.inputs) {
                    if(!input.is_local) continue;
                    if(!unconfirmedTxMap.has(input.transaction_id)) continue;
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
                        if (utxo.confirmation_count < this.CONFIRMATIONS_REQUIRED && !selfUTXOs.has(utxo.transaction_id)) return false;
                        if (utxo.confirmation_count===0) {
                            const cluster = txClusters.get(utxo.transaction_id);
                            if(cluster==null) {
                                logger.warn("getUtxos(): Unconfirmed UTXO "+utxo.transaction_id+" but cannot find existing cluster!");
                                return false;
                            }
                            const clusterSize = cluster.size;
                            if(clusterSize >= this.MAX_MEMPOOL_TX_CHAIN) {
                                // logger.debug("getUtxos(): Unconfirmed UTXO "+utxo.transaction_id+" existing mempool tx chain too long: "+clusterSize);
                                return false;
                            }
                            if(this.unconfirmedTxIdBlacklist.has(utxo.transaction_id)) {
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
                            outputScript: Buffer.from(utxo.output_script, "hex"),
                            value: utxo.tokens,
                            txId: utxo.transaction_id,
                            vout: utxo.transaction_vout
                        }
                    })
            };
        }
        return this.cachedUtxos.utxos;
    }

    async getBalance(): Promise<{ confirmed: number; unconfirmed: number }> {
        const resUtxos = await getUtxos({lnd: this.lndClient.lnd});

        let confirmed = 0;
        let unconfirmed = 0;
        resUtxos.utxos.forEach(utxo => {
            if(utxo.confirmation_count>0) {
                confirmed+=utxo.tokens;
            } else {
                unconfirmed+=utxo.tokens;
            }
        });

        return {confirmed, unconfirmed}
    }

    async sendRawTransaction(tx: string): Promise<void> {
        try {
            await broadcastChainTransaction({
                lnd: this.lndClient.lnd,
                transaction: tx
            });
        } catch (e) {
            if(Array.isArray(e) && e[0]===503 && e[2].err.details==="undefined: too-long-mempool-chain") {
                //Blacklist those UTXOs till confirmed
                const parsedTx = Transaction.fromRaw(Buffer.from(tx, "hex"), {
                    allowUnknownOutputs: true,
                    allowLegacyWitnessUtxo: true,
                    allowUnknownInputs: true
                });
                for(let i=0;i<parsedTx.inputsLength;i++) {
                    const input = parsedTx.getInput(i);
                    const txId = Buffer.from(input.txid).toString("hex");
                    logger.warn("sendRawTransaction(): Adding UTXO txId to blacklist because too-long-mempool-chain: ", txId)
                    this.unconfirmedTxIdBlacklist.add(txId);
                }
            }
            throw e;
        }
        this.cachedUtxos = null;
    }

    async signPsbt(psbt: Transaction): Promise<SignPsbtResponse> {
        const resp = await signPsbt({
            lnd: this.lndClient.lnd,
            psbt: Buffer.from(psbt.toPSBT(0)).toString("hex")
        });
        const tx = Transaction.fromRaw(Buffer.from(resp.transaction, "hex"), {
            allowUnknownOutputs: true,
            allowLegacyWitnessUtxo: true
        });
        const _psbt = Transaction.fromPSBT(Buffer.from(resp.psbt, "hex"), {
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
    private async getChainFee(
        destinations: {address?: string, script?: Buffer, amount: number}[],
        estimate: boolean = false,
        multiplier?: number,
        feeRate?: number,
        requiredInputs?: CoinselectTxInput[]
    ): Promise<{
        satsPerVbyte: number,
        networkFee: number,
        inputs: CoinselectTxInput[],
        outputs: CoinselectTxOutput[]
    } | null> {
        if(feeRate==null) feeRate = await this.getFeeRate();

        let satsPerVbyte = Math.ceil(feeRate);
        if(multiplier!=null) satsPerVbyte = Math.ceil(satsPerVbyte*multiplier);

        const utxoPool: BitcoinUtxo[] = await this.getUtxos(estimate);

        let obj = coinSelect(utxoPool, destinations.map(val => {
            return {
                address: val.address,
                value: val.amount,
                script: val.script ?? this.toOutputScript(val.address)
            }
        }), satsPerVbyte, this.CHANGE_ADDRESS_TYPE, requiredInputs, true);

        if(obj.inputs==null || obj.outputs==null) {
            logger.debug("getChainFee(): Cannot run coinselection algorithm, not enough funds?");
            return null;
        }

        const leavesUtxos: {
            value: number,
            script?: Buffer,
            witness?: Buffer,
            type?: CoinselectAddressTypes
        }[] = utxoPool.filter(val => !obj.inputs.includes(val));
        if(obj.outputs.length>1) leavesUtxos.push(obj.outputs[1]);
        const leavesEconomicValue = utils.utxoEconomicValue(leavesUtxos, satsPerVbyte);

        const requiredReserve = await this.getRequiredReserve(estimate);
        if(leavesEconomicValue < requiredReserve) {
            logger.debug("getChainFee(): Doesn't leave enough for reserve, required reserve: "+requiredReserve+" leavesValue: "+leavesEconomicValue);
            return null;
        }

        logger.info("getChainFee(): fee estimated,"+
            " targets: "+destinations.map(val => (val.script ? "script("+val.script.toString("hex")+")" : val.address)+"="+val.amount).join(", ")+
            " fee: "+obj.fee+
            " sats/vB: "+satsPerVbyte+
            " inputs: "+obj.inputs.length+
            " outputs: "+obj.outputs.length+
            " multiplier: "+(multiplier ?? 1)+"" +
            " leaveValue: "+leavesEconomicValue);

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
    getChangeAddress(): Promise<string> {
        return new Promise((resolve, reject) => {
            this.lndClient.lnd.wallet.nextAddr({
                type: this.LND_ADDRESS_TYPE_ENUM[this.CHANGE_ADDRESS_TYPE],
                change: true
            }, (err, res) => {
                if(err!=null) {
                    reject([503, 'UnexpectedErrGettingNextAddr', {err}]);
                    return;
                }
                resolve(res.addr);
            });
        });
    }

    private async addToPsbt(
        psbt: Transaction,
        coinselectInputs: CoinselectTxInput[],
        coinselectOutputs: CoinselectTxOutput[]
    ) {
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
        for(let output of coinselectOutputs) {
            output.script ??= this.toOutputScript(await this.getChangeAddress());
        }

        const outputs = coinselectOutputs.map(output => {
            return {
                script: output.script,
                amount: BigInt(output.value)
            }
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
    private async getPsbt(
        coinselectResult: {inputs: CoinselectTxInput[], outputs: CoinselectTxOutput[]},
        nonce?: bigint
    ): Promise<Transaction> {

        let locktime = 0;
        let sequence = 0xFFFFFFFD;
        //Apply nonce
        if(nonce!=null) {
            const locktimeBN = nonce >> 24n;
            locktime = Number(locktimeBN) + 500000000;
            if(locktime > (Date.now()/1000 - 24*60*60)) throw new Error("Invalid escrow nonce (locktime)!");

            const sequenceBN = nonce & 0xFFFFFFn;
            sequence = 0xFE000000 + Number(sequenceBN);
        }

        let psbt = new Transaction({lockTime: locktime});

        //Add coinselect results to PSBT
        await this.addToPsbt(psbt, coinselectResult.inputs, coinselectResult.outputs);

        //Apply nonce
        for(let i=0;i<psbt.inputsLength;i++) {
            psbt.updateInput(i, {sequence});
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
    protected checkPsbtFee(
        psbt: Transaction,
        tx: Transaction,
        maxAllowedSatsPerVbyte: number,
        actualSatsPerVbyte: number
    ): void {
        const txFee = Number(psbt.fee);

        //Sanity check on sats/vB
        const maxAllowedFee =
            (
                tx.vsize +
                //Considering the extra output was not added, because was detrminetal
                utils.outputBytes({type: this.CHANGE_ADDRESS_TYPE})
            ) * maxAllowedSatsPerVbyte +
            //Possibility that extra output was not added due to it being lower than dust
            utils.dustThreshold({type: this.CHANGE_ADDRESS_TYPE});

        if(txFee > maxAllowedFee) throw new Error("Generated tx fee too high: "+JSON.stringify({
            maxAllowedFee: maxAllowedFee.toString(10),
            actualFee: txFee.toString(10),
            psbtHex: Buffer.from(psbt.toPSBT(0)).toString("hex"),
            maxAllowedSatsPerVbyte: maxAllowedSatsPerVbyte.toString(10),
            actualSatsPerVbyte: actualSatsPerVbyte.toString(10)
        }));
    }

    getSignedTransaction(destination: string, amount: number, feeRate?: number, nonce?: bigint, maxAllowedFeeRate?: number): Promise<SignPsbtResponse> {
        return this.getSignedMultiTransaction([{address: destination, amount}], feeRate, nonce, maxAllowedFeeRate);
    }

    async getSignedMultiTransaction(destinations: {
        address: string;
        amount: number
    }[], feeRate?: number, nonce?: bigint, maxAllowedFeeRate?: number): Promise<SignPsbtResponse> {
        const res = await this.getChainFee(destinations, false, null, feeRate);
        if(res==null) return null;
        const psbt = await this.getPsbt(res, nonce);
        const psbtResp = await this.signPsbt(psbt);
        if(maxAllowedFeeRate!=null) this.checkPsbtFee(psbtResp.psbt, psbtResp.tx, maxAllowedFeeRate, res.satsPerVbyte);
        return psbtResp;
    }

    async drainAll(_destination: string | Buffer, inputs: Omit<BitcoinUtxo, "address">[], feeRate?: number): Promise<SignPsbtResponse> {
        feeRate ??= await this.getFeeRate();

        const destination = typeof(_destination)==="string" ? this.toOutputScript(_destination) : _destination;
        const txBytes = utils.transactionBytes(inputs, [{script: destination}]);
        const txFee = txBytes*feeRate;
        const adjustedOutput = inputs.reduce((prev, curr) => prev + curr.value, 0)-txFee;
        if(adjustedOutput<546) {
            return null;
        }

        const psbt = await this.getPsbt({inputs, outputs: [{value: adjustedOutput, script: destination}]});
        return await this.signPsbt(psbt);
    }

    async burnAll(inputs: Omit<BitcoinUtxo, "address">[]): Promise<SignPsbtResponse> {
        const psbt = await this.getPsbt({inputs, outputs: [{
            script: Buffer.concat([Buffer.from([0x6a, 20]), Buffer.from("BURN, BABY, BURN! AQ", "ascii")]),
            value: 0
        }]});
        return await this.signPsbt(psbt);
    }

    estimateFee(destination: string, amount: number, feeRate?: number, feeRateMultiplier?: number): Promise<{
        satsPerVbyte: number,
        networkFee: number
    }> {
        return this.getChainFee([{address: destination, amount}], true, feeRateMultiplier, feeRate);
    }

    parsePsbt(psbt: Transaction): Promise<BtcTx> {
        return Promise.resolve(bitcoinTxToBtcTx(psbt));
    }

    async fundPsbt(psbt: Transaction, feeRate?: number): Promise<Transaction> {
        const requiredInputs: CoinselectTxInput[] = [];
        const requiredOutputs: {script: Buffer, amount: number}[] = [];
        //Try to extract data about psbt input type
        for(let i=0;i<psbt.inputsLength;i++) {
            requiredInputs.push(toCoinselectInput(psbt.getInput(i)));
        }
        for(let i=0;i<psbt.outputsLength;i++) {
            const output = psbt.getOutput(i);
            requiredOutputs.push({
                script: Buffer.from(output.script),
                amount: Number(output.amount)
            });
        }

        const res = await this.getChainFee(requiredOutputs, false, null, feeRate, requiredInputs);
        if(res==null) return null;

        res.inputs.splice(0, requiredInputs.length);
        res.outputs.splice(0, requiredOutputs.length);

        await this.addToPsbt(psbt, res.inputs, res.outputs);

        return psbt;
    }

    execute(executor: () => Promise<void>): Promise<void> {
        return this.lndClient.executeOnWallet(executor);
    }

}
