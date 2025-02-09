import {
    AuthenticatedLnd,
    authenticatedLndGrpc, getWalletInfo,
    getWalletStatus,
    UnauthenticatedLnd,
    unauthenticatedLndGrpc,
    unlockWallet
} from "lightning";
import * as fs from "fs";
import * as bip39 from "bip39";
import {CipherSeed} from "aezeed";
import {randomBytes} from "crypto";
import * as fsPromise from "fs/promises";
import {getLogger} from "../utils/Utils";

export type LNDConfig = {
    MNEMONIC_FILE?: string,
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
            const mnemonic: string = fs.readFileSync(this.config.MNEMONIC_FILE).toString();
            let entropy: Buffer;
            try {
                entropy = Buffer.from(bip39.mnemonicToEntropy(mnemonic), "hex");
            } catch (e) {
                throw new Error("Error parsing mnemonic phrase!");
            }
            const aezeedMnemonicFile = this.config.MNEMONIC_FILE + ".lnd";
            if (!fs.existsSync(aezeedMnemonicFile)) {
                const cipherSeed = new CipherSeed(entropy, randomBytes(5));
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
        setInterval(() => this.checkLNDConnected().catch(e => console.error(e)), 30*1000);
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
}