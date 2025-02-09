import { AuthenticatedLnd } from "lightning";
export type LNDConfig = {
    MNEMONIC_FILE?: string;
    WALLET_PASSWORD_FILE?: string;
    CERT?: string;
    CERT_FILE?: string;
    MACAROON?: string;
    MACAROON_FILE?: string;
    HOST: string;
    PORT: number;
};
export declare class LNDClient {
    lnd: AuthenticatedLnd;
    status: string;
    private readonly config;
    constructor(config: LNDConfig);
    isReady(): boolean;
    getStatusInfo(): Promise<Record<string, string>>;
    private getUnauthenticatedLndGrpc;
    private getAuthenticatedLndGrpc;
    /**
     * LND uses AEZEED mnemonic file, we need to convert the usual bip39 mnemonic into AEZEED
     * @private
     * @returns {string} Filename of the converted AEZEED mnemonic file
     */
    private tryConvertMnemonic;
    private getLNDWalletStatus;
    private createLNDWallet;
    private loadPassword;
    private loadMnemonic;
    private unlockWallet;
    private createWallet;
    private tryConnect;
    private isLNDSynced;
    private checkLNDConnected;
    private startWatchdog;
    initialized: boolean;
    init(): Promise<void>;
}
