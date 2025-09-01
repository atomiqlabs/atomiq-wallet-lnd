"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LNDClient = void 0;
const lightning_1 = require("lightning");
const fs = require("fs");
const bip39_1 = require("@scure/bip39");
const english_1 = require("@scure/bip39/wordlists/english");
const aezeed_1 = require("aezeed");
const crypto_1 = require("crypto");
const fsPromise = require("fs/promises");
const Utils_1 = require("../utils/Utils");
const promise_queue_ts_1 = require("promise-queue-ts");
const logger = (0, Utils_1.getLogger)("LNDClient: ");
class LNDClient {
    constructor(config) {
        this.status = "offline";
        this.initialized = false;
        this.walletExecutionQueue = new promise_queue_ts_1.PromiseQueue();
        if (config.CERT == null && config.CERT_FILE == null)
            throw new Error("Certificate for LND not provided, provide either CERT or CERT_FILE config!");
        if (config.MACAROON == null && config.MACAROON_FILE == null)
            throw new Error("Macaroon for LND not provided, provide either MACAROON or MACAROON_FILE config!");
        this.config = config;
    }
    isReady() {
        return this.status === "ready";
    }
    async getStatusInfo() {
        if (this.lnd == null)
            return {};
        const resp = await (0, lightning_1.getWalletInfo)({ lnd: this.lnd });
        return {
            "Synced to chain": "" + resp.is_synced_to_chain,
            "Blockheight": resp.current_block_height.toString()
        };
    }
    getUnauthenticatedLndGrpc() {
        let cert = this.config.CERT;
        if (this.config.CERT_FILE != null) {
            if (!fs.existsSync(this.config.CERT_FILE))
                throw new Error("Certificate file not found!");
            cert = fs.readFileSync(this.config.CERT_FILE).toString("base64");
        }
        const { lnd } = (0, lightning_1.unauthenticatedLndGrpc)({
            cert,
            socket: this.config.HOST + ':' + this.config.PORT,
        });
        return lnd;
    }
    ;
    getAuthenticatedLndGrpc() {
        let cert = this.config.CERT;
        if (this.config.CERT_FILE != null) {
            if (!fs.existsSync(this.config.CERT_FILE))
                throw new Error("Certificate file not found!");
            cert = fs.readFileSync(this.config.CERT_FILE).toString("base64");
        }
        let macaroon = this.config.MACAROON;
        if (this.config.MACAROON_FILE != null) {
            if (!fs.existsSync(this.config.MACAROON_FILE))
                throw new Error("Macaroon file not found!");
            macaroon = fs.readFileSync(this.config.MACAROON_FILE).toString("base64");
        }
        const { lnd } = (0, lightning_1.authenticatedLndGrpc)({
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
    tryConvertMnemonic() {
        if (this.config.MNEMONIC_FILE != null) {
            const mnemonic = fs.readFileSync(this.config.MNEMONIC_FILE).toString();
            let entropy;
            try {
                entropy = Buffer.from((0, bip39_1.mnemonicToEntropy)(mnemonic, english_1.wordlist));
            }
            catch (e) {
                throw new Error("Error parsing mnemonic phrase!");
            }
            const aezeedMnemonicFile = this.config.MNEMONIC_FILE + ".lnd";
            if (!fs.existsSync(aezeedMnemonicFile)) {
                const cipherSeed = new aezeed_1.CipherSeed(entropy, (0, crypto_1.randomBytes)(5));
                fs.writeFileSync(aezeedMnemonicFile, cipherSeed.toMnemonic());
            }
            return aezeedMnemonicFile;
        }
        return null;
    }
    async getLNDWalletStatus(lnd) {
        try {
            const walletStatus = await (0, lightning_1.getWalletStatus)({ lnd });
            if (walletStatus.is_absent)
                return "absent";
            if (walletStatus.is_active)
                return "active";
            if (walletStatus.is_locked)
                return "locked";
            if (walletStatus.is_ready)
                return "ready";
            if (walletStatus.is_starting)
                return "starting";
            if (walletStatus.is_waiting)
                return "waiting";
        }
        catch (e) {
            logger.error("getLNDWalletStatus(): Error: ", e);
            return "offline";
        }
    }
    createLNDWallet(lnd, mnemonic, password) {
        return new Promise((resolve, reject) => {
            lnd.unlocker.initWallet({
                aezeed_passphrase: undefined,
                cipher_seed_mnemonic: mnemonic.split(' '),
                wallet_password: Buffer.from(password, "utf8"),
                recovery_window: 1000
            }, (err, res) => {
                if (!!err) {
                    reject([503, 'UnexpectedInitWalletError', { err }]);
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
    async loadPassword() {
        if (this.config.WALLET_PASSWORD_FILE == null) {
            throw new Error("Error initializing LND, no wallet password provided!");
        }
        let password;
        try {
            const resultPass = await fsPromise.readFile(this.config.WALLET_PASSWORD_FILE);
            password = resultPass.toString();
        }
        catch (e) {
            logger.error("loadPassword(): Error: ", e);
        }
        if (password == null) {
            throw new Error("Invalid LND wallet password file provided!");
        }
        return password;
    }
    async loadMnemonic() {
        const mnemonicFile = this.tryConvertMnemonic();
        if (mnemonicFile == null) {
            throw new Error("Error initializing LND, no mnemonic provided!");
        }
        let mnemonic;
        try {
            const resultMnemonic = await fsPromise.readFile(mnemonicFile);
            mnemonic = resultMnemonic.toString();
        }
        catch (e) {
            logger.error("loadMnemonic(): Error: ", e);
        }
        if (mnemonic == null) {
            throw new Error("Invalid LND mnemonic file provided!");
        }
        return mnemonic;
    }
    async unlockWallet(lnd) {
        await (0, lightning_1.unlockWallet)({
            lnd,
            password: await this.loadPassword()
        });
    }
    async createWallet(lnd) {
        const mnemonic = await this.loadMnemonic();
        const password = await this.loadPassword();
        await this.createLNDWallet(lnd, mnemonic, password);
    }
    async tryConnect() {
        let lnd;
        try {
            lnd = this.getUnauthenticatedLndGrpc();
        }
        catch (e) {
            logger.error("tryConnect(): Error: ", e);
            return false;
        }
        const walletStatus = await this.getLNDWalletStatus(lnd);
        if (walletStatus === "active" || walletStatus === "ready") {
            return true;
        }
        this.status = walletStatus;
        if (walletStatus === "waiting" || walletStatus === "starting" || walletStatus === "offline")
            return false;
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
    async isLNDSynced() {
        const resp = await (0, lightning_1.getWalletInfo)({
            lnd: this.lnd
        });
        logger.debug("isLNDSynced(): LND blockheight: " + resp.current_block_height + " is_synced: " + resp.is_synced_to_chain);
        return resp.is_synced_to_chain;
    }
    async checkLNDConnected() {
        const connected = await this.tryConnect();
        if (!connected) {
            logger.error("checkLNDConnected(): LND Disconnected!");
            return;
        }
        if (await this.isLNDSynced()) {
            this.status = "ready";
        }
        else {
            this.status = "syncing";
        }
    }
    startWatchdog() {
        setInterval(() => this.checkLNDConnected().catch(e => logger.error("startWatchdog(): Error during periodic check: ", e)), 30 * 1000);
    }
    async init() {
        if (this.initialized)
            return;
        let lndReady = false;
        logger.info("init(): Waiting for LND node connection...");
        while (!lndReady) {
            lndReady = await this.tryConnect();
            if (!lndReady)
                await new Promise(resolve => setTimeout(resolve, 30 * 1000));
        }
        this.status = "syncing";
        this.lnd = this.getAuthenticatedLndGrpc();
        lndReady = false;
        logger.info("init(): Waiting for LND node synchronization...");
        while (!lndReady) {
            lndReady = await this.isLNDSynced();
            if (!lndReady)
                await new Promise(resolve => setTimeout(resolve, 30 * 1000));
        }
        this.startWatchdog();
        this.initialized = true;
        this.status = "ready";
    }
    /**
     * Ensures sequential execution of operations spending wallet UTXOs
     * @param executor
     */
    executeOnWallet(executor) {
        return this.walletExecutionQueue.enqueue(executor);
    }
}
exports.LNDClient = LNDClient;
