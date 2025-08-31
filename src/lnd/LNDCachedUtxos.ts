import {LNDClient} from "./LNDClient";
import {subscribeToTransactions} from "lightning";

export class LNDCachedUtxos {

    private readonly lndClient: LNDClient;

    constructor(lndClient: LNDClient) {
        this.lndClient = lndClient;
    }

    subscribe(): Promise<void> {
        return new Promise((resolve, reject) => {
            const subscription = subscribeToTransactions({lnd: this.lndClient.lnd});
            subscription.on("error", (error) => {
                subscription.removeAllListeners();
                reject(error);
            });
            subscription.on("status", (status) => {

            });
        });
    }

    async init() {
        await this.lndClient.init();
        const subscription = subscribeToTransactions({lnd: this.lndClient.lnd});
    }

}