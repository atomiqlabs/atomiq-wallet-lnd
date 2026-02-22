import {
    AuthenticatedLnd,
    authenticatedLndGrpc,
    broadcastChainTransaction, ChainTransaction, getChainTransactions, getHeight, getUtxos, getWalletInfo,
    getWalletStatus,
    UnauthenticatedLnd,
    unauthenticatedLndGrpc,
    unlockWallet
} from "lightning";
import * as fs from "fs";
import {mnemonicToEntropy} from "@scure/bip39";
import {wordlist} from "@scure/bip39/wordlists/english";
import {CipherSeed, daysSinceGenesis} from "aezeed";
import {randomBytes} from "crypto";
import * as fsPromise from "fs/promises";
import {getLogger} from "../utils/Utils";
import {PromiseQueue} from "promise-queue-ts";
import {BitcoinUtxo, PluginManager} from "@atomiqlabs/lp-lib";
import {UnionFind} from "../utils/UnionFind";
import {Buffer} from "buffer";
import {Transaction} from "@scure/btc-signer";

export type LNDConfig = {
    MNEMONIC_FILE?: string,
    MNEMONIC_BIRTHDAY_FILE?: string,
    WALLET_PASSWORD_FILE?: string,
    CERT?: string,
    CERT_FILE?: string,
    MACAROON?: string,
    MACAROON_FILE?: string,
    HOST: string,
    PORT: number
}

const logger = getLogger("LNDClient: ");

export class LNDClient {

    lnd: AuthenticatedLnd;
    status: string = "offline";
    private readonly config: LNDConfig;

    constructor(config: LNDConfig) {
        if (config.CERT == null && config.CERT_FILE == null) throw new Error("Certificate for LND not provided, provide either CERT or CERT_FILE config!");
        if (config.MACAROON == null && config.MACAROON_FILE == null) throw new Error("Macaroon for LND not provided, provide either MACAROON or MACAROON_FILE config!");
        this.config = config;
    }

    isReady(): boolean {
        return this.status==="ready";
    }

    async getStatusInfo(): Promise<Record<string, string>> {
        if(this.lnd==null) return {};
        const resp = await getWalletInfo({lnd: this.lnd});
        return {
            "Synced to chain": ""+resp.is_synced_to_chain,
            "Blockheight": resp.current_block_height.toString()
        };
    }

    private getUnauthenticatedLndGrpc(): UnauthenticatedLnd {
        let cert: string = this.config.CERT;
        if (this.config.CERT_FILE != null) {
            if (!fs.existsSync(this.config.CERT_FILE)) throw new Error("Certificate file not found!");
            cert = fs.readFileSync(this.config.CERT_FILE).toString("base64");
        }

        const {lnd} = unauthenticatedLndGrpc({
            cert,
            socket: this.config.HOST + ':' + this.config.PORT,
        });

        return lnd;
    };

    private getAuthenticatedLndGrpc(): AuthenticatedLnd {
        let cert: string = this.config.CERT;
        if (this.config.CERT_FILE != null) {
            if (!fs.existsSync(this.config.CERT_FILE)) throw new Error("Certificate file not found!");
            cert = fs.readFileSync(this.config.CERT_FILE).toString("base64");
        }

        let macaroon: string = this.config.MACAROON;
        if (this.config.MACAROON_FILE != null) {
            if (!fs.existsSync(this.config.MACAROON_FILE)) throw new Error("Macaroon file not found!");
            macaroon = fs.readFileSync(this.config.MACAROON_FILE).toString("base64");
        }

        const {lnd} = authenticatedLndGrpc({
            cert,
            macaroon,
            socket: this.config.HOST + ':' + this.config.PORT,
        });

        return lnd;
    }

    /**
     * LND uses AEZEED mnemonic file, we need to convert the usual bip39 mnemonic into AEZEED
     * @private
     * @returns {string} Filename of the converted AEZEED mnemonic file
     */
    private tryConvertMnemonic(): string | null {
        if (this.config.MNEMONIC_FILE != null) {
            let birthdayUnixTimestampSeconds: number;
            if(this.config.MNEMONIC_BIRTHDAY_FILE != null) {
                try {
                    const birthdayString = fs.readFileSync(this.config.MNEMONIC_BIRTHDAY_FILE).toString();
                    birthdayUnixTimestampSeconds = parseInt(birthdayString);
                } catch (e) {
                    console.warn("LNDClient: tryConvertMnemonic(): Error while reading the mnemonic birthday file: ", e);
                }
            }

            const mnemonic: string = fs.readFileSync(this.config.MNEMONIC_FILE).toString();
            let entropy: Buffer;
            try {
                entropy = Buffer.from(mnemonicToEntropy(mnemonic, wordlist));
            } catch (e) {
                throw new Error("Error parsing mnemonic phrase!");
            }
            const aezeedMnemonicFile = this.config.MNEMONIC_FILE + ".lnd";
            if (!fs.existsSync(aezeedMnemonicFile)) {
                const genesisDays = birthdayUnixTimestampSeconds==null
                    ? undefined
                    : daysSinceGenesis(new Date(birthdayUnixTimestampSeconds * 1000));

                console.log("LNDClient: tryConvertMnemonic(): Generating LND seed, using days since genesis: "+genesisDays);
                const cipherSeed = new CipherSeed(entropy, randomBytes(5), undefined, genesisDays);
                fs.writeFileSync(aezeedMnemonicFile, cipherSeed.toMnemonic());
            }
            return aezeedMnemonicFile;
        }
        return null;
    }

    private async getLNDWalletStatus(lnd: UnauthenticatedLnd): Promise<"offline" | "ready" | "active" | "waiting" | "starting" | "absent" | "locked"> {
        try {
            const walletStatus = await getWalletStatus({lnd});
            if (walletStatus.is_absent) return "absent";
            if (walletStatus.is_active) return "active";
            if (walletStatus.is_locked) return "locked";
            if (walletStatus.is_ready) return "ready";
            if (walletStatus.is_starting) return "starting";
            if (walletStatus.is_waiting) return "waiting";
        } catch (e) {
            logger.error("getLNDWalletStatus(): Error: ", e);
            return "offline";
        }
    }

    private createLNDWallet(lnd: UnauthenticatedLnd, mnemonic: string, password: string): Promise<{
        macaroon: string
    }> {
        return new Promise<{
            macaroon: string
        }>((resolve, reject) => {
            lnd.unlocker.initWallet({
                aezeed_passphrase: undefined,
                cipher_seed_mnemonic: mnemonic.split(' '),
                wallet_password: Buffer.from(password, "utf8"),
                recovery_window: 1000
            }, (err, res) => {
                if (!!err) {
                    reject([503, 'UnexpectedInitWalletError', {err}]);
                    return;
                }

                if (!res) {
                    reject([503, 'ExpectedResponseForInitWallet']);
                    return;
                }

                if (!Buffer.isBuffer(res.admin_macaroon)) {
                    reject([503, 'ExpectedAdminMacaroonToCrateWallet']);
                    return;
                }

                resolve({
                    macaroon: res.admin_macaroon.toString("base64")
                });
            });
        });
    }

    private async loadPassword(): Promise<string> {
        if (this.config.WALLET_PASSWORD_FILE == null) {
            throw new Error("Error initializing LND, no wallet password provided!");
        }
        let password: string;
        try {
            const resultPass = await fsPromise.readFile(this.config.WALLET_PASSWORD_FILE);
            password = resultPass.toString();
        } catch (e) {
            logger.error("loadPassword(): Error: ", e);
        }
        if (password == null) {
            throw new Error("Invalid LND wallet password file provided!");
        }
        return password;
    }

    private async loadMnemonic(): Promise<string> {
        const mnemonicFile = this.tryConvertMnemonic();
        if (mnemonicFile == null) {
            throw new Error("Error initializing LND, no mnemonic provided!");
        }
        let mnemonic: string;
        try {
            const resultMnemonic = await fsPromise.readFile(mnemonicFile);
            mnemonic = resultMnemonic.toString();
        } catch (e) {
            logger.error("loadMnemonic(): Error: ", e);
        }
        if (mnemonic == null) {
            throw new Error("Invalid LND mnemonic file provided!");
        }
        return mnemonic;
    }

    private async unlockWallet(lnd: UnauthenticatedLnd): Promise<void> {
        await unlockWallet({
            lnd,
            password: await this.loadPassword()
        });
    }

    private async createWallet(lnd: UnauthenticatedLnd): Promise<void> {
        const mnemonic = await this.loadMnemonic();
        const password = await this.loadPassword();
        await this.createLNDWallet(lnd, mnemonic, password);
    }

    private async tryConnect(): Promise<boolean> {
        let lnd: UnauthenticatedLnd;
        try {
            lnd = this.getUnauthenticatedLndGrpc();
        } catch (e) {
            logger.error("tryConnect(): Error: ", e);
            return false;
        }
        const walletStatus = await this.getLNDWalletStatus(lnd);

        if (walletStatus === "active" || walletStatus === "ready") {
            return true;
        }
        this.status = walletStatus;
        if (walletStatus === "waiting" || walletStatus === "starting" || walletStatus === "offline") return false;
        if (walletStatus === "absent") {
            //New wallet has to be created based on the provided mnemonic file
            await this.createWallet(lnd);
            return false;
        }
        if (walletStatus === "locked") {
            //Wallet has to be unlocked
            await this.unlockWallet(lnd);
            return false;
        }
    }

    private async isLNDSynced() {
        const resp = await getWalletInfo({
            lnd: this.lnd
        });
        logger.debug("isLNDSynced(): LND blockheight: "+resp.current_block_height+" is_synced: "+resp.is_synced_to_chain);
        return resp.is_synced_to_chain;
    }

    private async checkLNDConnected(): Promise<void> {
        const connected = await this.tryConnect();
        if(!connected) {
            logger.error("checkLNDConnected(): LND Disconnected!");
            return;
        }
        if(await this.isLNDSynced()) {
            this.status = "ready";
        } else {
            this.status = "syncing";
        }
    }

    private startWatchdog() {
        setInterval(() => this.checkLNDConnected().catch(e => logger.error("startWatchdog(): Error during periodic check: ", e)), 30*1000);
    }

    initialized: boolean = false;

    async init(): Promise<void> {
        if(this.initialized) return;
        let lndReady: boolean = false;
        logger.info("init(): Waiting for LND node connection...");
        while (!lndReady) {
            lndReady = await this.tryConnect();
            if (!lndReady) await new Promise(resolve => setTimeout(resolve, 30 * 1000));
        }
        this.status = "syncing";
        this.lnd = this.getAuthenticatedLndGrpc();
        lndReady = false;
        logger.info("init(): Waiting for LND node synchronization...");
        while(!lndReady) {
            lndReady = await this.isLNDSynced();
            if(!lndReady) await new Promise(resolve => setTimeout(resolve, 30*1000));
        }
        this.startWatchdog();
        this.initialized = true;
        this.status = "ready";
    }

    protected readonly UTXO_CACHE_TIMEOUT = 5*1000;
    protected cachedUtxos: {
        utxos: BitcoinUtxo[],
        timestamp: number
    };
    protected readonly CONFIRMATIONS_REQUIRED = 1;
    protected readonly MAX_MEMPOOL_TX_CHAIN = 10;
    protected readonly unconfirmedTxIdBlacklist: Set<string> = new Set<string>();
    protected readonly ADDRESS_FORMAT_MAP = {
        "p2wpkh": "p2wpkh",
        "np2wpkh": "p2sh-p2wpkh",
        "p2tr" : "p2tr"
    };

    async getUtxos(useCached: boolean = false): Promise<BitcoinUtxo[]> {
        if(!useCached || this.cachedUtxos==null || this.cachedUtxos.timestamp<Date.now()-this.UTXO_CACHE_TIMEOUT) {
            const resBlockheight = await getHeight({lnd: this.lnd});

            const blockheight: number = resBlockheight.current_block_height;

            const [{transactions}, resUtxos] = await Promise.all([
                getChainTransactions({
                    lnd: this.lnd,
                    after: blockheight-this.CONFIRMATIONS_REQUIRED
                }),
                getUtxos({lnd: this.lnd})
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

    async sendRawTransaction(tx: string): Promise<void> {
        try {
            await broadcastChainTransaction({
                lnd: this.lnd,
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

    private readonly walletExecutionQueue: PromiseQueue = new PromiseQueue();

    /**
     * Ensures sequential execution of operations spending wallet UTXOs
     * @param executor
     */
    executeOnWallet<T>(executor: () => Promise<T>): Promise<T> {
        return this.walletExecutionQueue.enqueue(executor);
    }

}