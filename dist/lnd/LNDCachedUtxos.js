"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LNDCachedUtxos = void 0;
const lightning_1 = require("lightning");
class LNDCachedUtxos {
    constructor(lndClient) {
        this.lndClient = lndClient;
    }
    subscribe() {
        return new Promise((resolve, reject) => {
            const subscription = (0, lightning_1.subscribeToTransactions)({ lnd: this.lndClient.lnd });
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
        const subscription = (0, lightning_1.subscribeToTransactions)({ lnd: this.lndClient.lnd });
    }
}
exports.LNDCachedUtxos = LNDCachedUtxos;
