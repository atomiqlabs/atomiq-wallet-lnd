import {LNDClient, LNDConfig} from "./LNDClient";
import * as BN from "bn.js";
import {BtcTx} from "@atomiqlabs/base";
import {address, Network, networks, Psbt, script, Transaction} from "bitcoinjs-lib";
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
import * as bitcoin from "bitcoinjs-lib";
import {getLogger, handleLndError} from "../utils/Utils";
import {Command} from "@atomiqlabs/server-base";
import {BitcoinUtxo, IBitcoinWallet, IBtcFeeEstimator, PluginManager, SignPsbtResponse} from "@atomiqlabs/lp-lib";

export type LNDBitcoinWalletConfig = {
    network?: Network,
    feeEstimator?: IBtcFeeEstimator,
    onchainReservedPerChannel?: number
};

function lndTxToBtcTx(tx: ChainTransaction): BtcTx {
    const btcTx = Transaction.fromHex(tx.transaction);
    btcTx.ins.forEach(vin => {
        vin.witness = [];
    })
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
                    asm: script.toASM(output.script),
                    hex: output.script.toString("hex")
                }
            }
        }),
        ins: btcTx.ins.map(input => {
            return {
                txid: input.hash.reverse().toString("hex"),
                vout: input.index,
                scriptSig: {
                    asm: script.toASM(input.script),
                    hex: input.script.toString("hex")
                },
                sequence: input.sequence,
                txinwitness: input.witness.map(witness => witness.toString("hex"))
            }
        })
    }
}

const logger = getLogger("LNDBitcoinWallet: ");

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

    private readonly lndClient: LNDClient;

    readonly config: LNDBitcoinWalletConfig;

    constructor(lndConfig: LNDConfig, config?: LNDBitcoinWalletConfig);
    constructor(client: LNDClient, config?: LNDBitcoinWalletConfig);
    constructor(configOrClient: LNDConfig | LNDClient, config?: LNDBitcoinWalletConfig) {
        if(configOrClient instanceof LNDClient) {
            this.lndClient = configOrClient;
        } else {
            this.lndClient = new LNDClient(configOrClient);
        }
        this.config = config ?? {};
        this.config.network ??= networks.bitcoin;
        this.config.onchainReservedPerChannel ??= 50000;
    }

    init(): Promise<void> {
        return this.lndClient.init();
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
        return [];
    }

    toOutputScript(_address: string): Buffer {
        return address.toOutputScript(_address, this.config.network);
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

    async getAddress(): Promise<string> {
        const res = await createChainAddress({
            lnd: this.lndClient.lnd,
            format: this.RECEIVE_ADDRESS_TYPE
        });
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

            const [resChainTxns, resUtxos] = await Promise.all([
                getChainTransactions({
                    lnd: this.lndClient.lnd,
                    after: blockheight-this.CONFIRMATIONS_REQUIRED
                }),
                getUtxos({lnd: this.lndClient.lnd})
            ]);

            const selfUTXOs: Set<string> = PluginManager.getWhitelistedTxIds();

            const transactions = resChainTxns.transactions;
            for(let tx of transactions) {
                if(tx.is_outgoing) {
                    selfUTXOs.add(tx.id);
                }
            }

            this.cachedUtxos = {
                timestamp: Date.now(),
                utxos: resUtxos.utxos
                    .filter(utxo =>
                        utxo.confirmation_count>=this.CONFIRMATIONS_REQUIRED || selfUTXOs.has(utxo.transaction_id)
                    )
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
        await broadcastChainTransaction({
            lnd: this.lndClient.lnd,
            transaction: tx
        });
        this.cachedUtxos = null;
    }

    async signPsbt(psbt: Psbt): Promise<SignPsbtResponse> {
        const resp = await signPsbt({
            lnd: this.lndClient.lnd,
            psbt: psbt.toHex()
        });
        const tx = Transaction.fromHex(resp.transaction);
        const _psbt = Psbt.fromHex(resp.psbt);
        return {
            psbt: _psbt,
            tx,
            raw: resp.transaction,
            txId: tx.getId(),
            networkFee: _psbt.getFee()
        };
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
    private async getChainFee(targetAddress: string, targetAmount: number, estimate: boolean = false, multiplier?: number, feeRate?: number): Promise<{
        satsPerVbyte: number,
        networkFee: number,
        inputs: CoinselectTxInput[],
        outputs: CoinselectTxOutput[]
    } | null> {
        if(feeRate==null) feeRate = await this.getFeeRate();

        let satsPerVbyte = Math.ceil(feeRate);
        if(multiplier!=null) satsPerVbyte = Math.ceil(satsPerVbyte*multiplier);

        const utxoPool: BitcoinUtxo[] = await this.getUtxos(estimate);

        let obj = coinSelect(utxoPool, [{
            address: targetAddress,
            value: targetAmount,
            script: this.toOutputScript(targetAddress)
        }], satsPerVbyte, this.CHANGE_ADDRESS_TYPE);

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
            " target: "+targetAddress+
            " amount: "+targetAmount.toString(10)+
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

    /**
     * Create PSBT for swap payout from coinselection result
     *
     * @param nonce
     * @param coinselectResult
     * @private
     */
    private async getPsbt(
        coinselectResult: {inputs: CoinselectTxInput[], outputs: CoinselectTxOutput[]},
        nonce?: BN
    ): Promise<Psbt> {
        let psbt = new Psbt();

        let sequence = 0xFFFFFFFD;
        //Apply nonce
        if(nonce!=null) {
            const nonceBuffer = Buffer.from(nonce.toArray("be", 8));

            const locktimeBN = new BN(nonceBuffer.slice(0, 5), "be");
            let locktime = locktimeBN.toNumber() + 500000000;
            if(locktime > (Date.now()/1000 - 24*60*60)) throw new Error("Invalid escrow nonce!");
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
        for(let output of coinselectResult.outputs) {
            output.script ??= bitcoin.address.toOutputScript(await this.getChangeAddress(), this.config.network);
        }

        psbt.addOutputs(coinselectResult.outputs.map(output => {
            return {
                script: output.script,
                value: output.value
            }
        }));

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
        psbt: bitcoin.Psbt,
        tx: bitcoin.Transaction,
        maxAllowedSatsPerVbyte: number,
        actualSatsPerVbyte: number
    ): void {
        const txFee = psbt.getFee();

        //Sanity check on sats/vB
        const maxAllowedFee =
            (
                tx.virtualSize() +
                //Considering the extra output was not added, because was detrminetal
                utils.outputBytes({type: this.CHANGE_ADDRESS_TYPE})
            ) * maxAllowedSatsPerVbyte +
            //Possibility that extra output was not added due to it being lower than dust
            utils.dustThreshold({type: this.CHANGE_ADDRESS_TYPE});

        if(txFee > maxAllowedFee) throw new Error("Generated tx fee too high: "+JSON.stringify({
            maxAllowedFee: maxAllowedFee.toString(10),
            actualFee: txFee.toString(10),
            psbtHex: psbt.toHex(),
            maxAllowedSatsPerVbyte: maxAllowedSatsPerVbyte.toString(10),
            actualSatsPerVbyte: actualSatsPerVbyte.toString(10)
        }));
    }

    async getSignedTransaction(destination: string, amount: number, feeRate?: number, nonce?: BN, maxAllowedFeeRate?: number): Promise<SignPsbtResponse> {
        const res = await this.getChainFee(destination, amount, false, null, feeRate);
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
        return this.getChainFee(destination, amount, true, feeRateMultiplier, feeRate);
    }

}
