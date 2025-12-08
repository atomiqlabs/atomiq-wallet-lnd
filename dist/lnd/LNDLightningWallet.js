"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LNDLightningWallet = void 0;
const lightning_1 = require("lightning");
const ln_service_1 = require("ln-service");
const Utils_1 = require("../utils/Utils");
const bolt11 = require("@atomiqlabs/bolt11");
const LNDClient_1 = require("./LNDClient");
const server_base_1 = require("@atomiqlabs/server-base");
//Check for lightning nodes which don't properly handle probe requests
const SNOWFLAKE_LIST = new Set([
    "038f8f113c580048d847d6949371726653e02b928196bad310e3eda39ff61723f6",
    "02a98e8c590a1b5602049d6b21d8f4c8861970aa310762f42eae1b2be88372e924",
    "039174f846626c6053ba80f5443d0db33da384f1dde135bf7080ba1eec465019c3",
    "025eee29468652d3a05c7ecb32c50ab5f3d3ebfa2115acccacae905ceaf6f30a23",
    "025cd6a9c52507da0a3ba832b4f698c73558a8c9e32da10d882b0cefad9cb36a76"
]);
function isSnowflake(routes) {
    let is_snowflake = false;
    if (routes != null) {
        for (let route of routes) {
            if (SNOWFLAKE_LIST.has(route[0].public_key) || SNOWFLAKE_LIST.has(route[1].public_key)) {
                is_snowflake = true;
            }
        }
    }
    return is_snowflake;
}
function fromLndRoutes(routes) {
    if (routes == null)
        return null;
    return routes.map(arr => arr.map(route => {
        return {
            baseFeeMtokens: route.base_fee_mtokens == null ? null : BigInt(route.base_fee_mtokens),
            channel: route.channel,
            cltvDelta: route.cltv_delta,
            feeRate: route.fee_rate,
            publicKey: route.public_key,
        };
    }));
}
class LNDLightningWallet {
    constructor(configOrClient) {
        if (configOrClient instanceof LNDClient_1.LNDClient) {
            this.lndClient = configOrClient;
        }
        else {
            this.lndClient = new LNDClient_1.LNDClient(configOrClient);
        }
    }
    init() {
        return this.lndClient.init();
    }
    isReady() {
        return this.lndClient.isReady();
    }
    getStatus() {
        return this.lndClient.status;
    }
    async getStatusInfo() {
        if (this.lndClient.lnd == null)
            return {};
        const resp = await (0, lightning_1.getWalletInfo)({ lnd: this.lndClient.lnd });
        const clientRecords = await this.lndClient.getStatusInfo();
        return {
            ...clientRecords,
            "Connected peers": resp.peers_count.toString(),
            "Channels active": resp.active_channels_count.toString(),
            "Channels pending": resp.pending_channels_count.toString()
        };
    }
    getCommands() {
        return [
            (0, server_base_1.createCommand)("connectlightning", "Connect to a lightning node peer", {
                args: {
                    node: {
                        base: true,
                        description: "Remote node identification as <pubkey>@<ip address>",
                        parser: (data) => {
                            if (data == null)
                                throw new Error("Data cannot be null");
                            const arr = data.split("@");
                            if (arr.length !== 2)
                                throw new Error("Invalid format, should be: <pubkey>@<ip address>");
                            return {
                                pubkey: arr[0],
                                address: arr[1]
                            };
                        }
                    }
                },
                parser: async (args, sendLine) => {
                    if (this.lndClient.lnd == null)
                        throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                    sendLine("Connecting to remote peer...");
                    await (0, lightning_1.addPeer)({
                        lnd: this.lndClient.lnd,
                        public_key: args.node.pubkey,
                        socket: args.node.address
                    });
                    return {
                        success: true,
                        message: "Connection to the lightning peer established!",
                        publicKey: args.node.pubkey,
                        address: args.node.address
                    };
                }
            }),
            (0, server_base_1.createCommand)("openchannel", "Opens up a lightning network payment channel", {
                args: {
                    amount: {
                        base: true,
                        description: "Amount of BTC to use inside a lightning",
                        parser: (0, server_base_1.cmdNumberParser)(true, 0)
                    },
                    node: {
                        base: true,
                        description: "Remote node identification as <pubkey>@<ip address>",
                        parser: (data) => {
                            if (data == null)
                                throw new Error("Data cannot be null");
                            const arr = data.split("@");
                            if (arr.length !== 2)
                                throw new Error("Invalid format, should be: <pubkey>@<ip address>");
                            return {
                                pubkey: arr[0],
                                address: arr[1]
                            };
                        }
                    },
                    feeRate: {
                        base: false,
                        description: "Fee rate for the opening transaction (sats/vB)",
                        parser: (0, server_base_1.cmdNumberParser)(false, 1, null, true)
                    }
                },
                parser: async (args, sendLine) => {
                    if (this.lndClient.lnd == null)
                        throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                    const amtBN = args.amount == null ? null : (0, server_base_1.fromDecimal)(args.amount.toFixed(8), 8);
                    if (amtBN == null)
                        throw new Error("Amount cannot be parsed");
                    const resp = await this.lndClient.executeOnWallet(() => (0, lightning_1.openChannel)({
                        lnd: this.lndClient.lnd,
                        local_tokens: Number(amtBN),
                        min_confirmations: 0,
                        partner_public_key: args.node.pubkey,
                        partner_socket: args.node.address,
                        fee_rate: 1000,
                        base_fee_mtokens: "1000",
                        chain_fee_tokens_per_vbyte: args.feeRate
                    }));
                    return {
                        success: true,
                        message: "Lightning channel funded, wait for TX confirmations!",
                        transactionId: resp.transaction_id,
                        amount: args.amount,
                        partnerPublicKey: args.node.pubkey,
                        partnerAddress: args.node.address,
                        feeRate: args.feeRate
                    };
                }
            }),
            (0, server_base_1.createCommand)("closechannel", "Attempts to cooperatively close a lightning network channel", {
                args: {
                    channelId: {
                        base: true,
                        description: "Channel ID to close cooperatively",
                        parser: (0, server_base_1.cmdStringParser)()
                    },
                    feeRate: {
                        base: false,
                        description: "Fee rate for the closing transaction (sats/vB)",
                        parser: (0, server_base_1.cmdNumberParser)(false, 1, null, true)
                    }
                },
                parser: async (args, sendLine) => {
                    if (this.lndClient.lnd == null)
                        throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                    const resp = await (0, lightning_1.closeChannel)({
                        lnd: this.lndClient.lnd,
                        is_force_close: false,
                        id: args.channelId,
                        tokens_per_vbyte: args.feeRate
                    });
                    return {
                        success: true,
                        message: "Lightning channel closed",
                        transactionId: resp.transaction_id,
                        channelId: args.channelId,
                        isForceClose: false,
                        feeRate: args.feeRate
                    };
                }
            }),
            (0, server_base_1.createCommand)("forceclosechannel", "Force closes a lightning network channel", {
                args: {
                    channelId: {
                        base: true,
                        description: "Channel ID to force close",
                        parser: (0, server_base_1.cmdStringParser)()
                    }
                },
                parser: async (args, sendLine) => {
                    if (this.lndClient.lnd == null)
                        throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                    const resp = await (0, lightning_1.closeChannel)({
                        lnd: this.lndClient.lnd,
                        is_force_close: true,
                        id: args.channelId
                    });
                    return {
                        success: true,
                        message: "Lightning channel force closed",
                        transactionId: resp.transaction_id,
                        channelId: args.channelId,
                        isForceClose: true
                    };
                }
            }),
            (0, server_base_1.createCommand)("listchannels", "Lists existing lightning channels", {
                args: {},
                parser: async (args, sendLine) => {
                    if (this.lndClient.lnd == null)
                        throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                    const { channels } = await (0, lightning_1.getChannels)({
                        lnd: this.lndClient.lnd
                    });
                    const { pending_channels } = await (0, lightning_1.getPendingChannels)({
                        lnd: this.lndClient.lnd
                    });
                    const openedChannels = channels.map(channel => ({
                        id: channel.id,
                        peer: channel.partner_public_key,
                        state: channel.is_closing ? "closing" : channel.is_opening ? "opening" : channel.is_active ? "active" : "inactive",
                        localBalance: (0, server_base_1.toDecimal)(BigInt(channel.local_balance), 8),
                        capacity: (0, server_base_1.toDecimal)(BigInt(channel.capacity), 8),
                        balancePercentage: (channel.local_balance / channel.capacity * 100).toFixed(2) + "%",
                        unsettledBalance: (0, server_base_1.toDecimal)(BigInt(channel.unsettled_balance), 8)
                    }));
                    const pendingChannelsList = pending_channels.map(channel => {
                        const result = {
                            id: channel.transaction_id + ":" + channel.transaction_vout,
                            peer: channel.partner_public_key,
                            state: channel.is_closing ? "closing" : channel.is_opening ? "opening" : channel.is_active ? "active" : "inactive",
                            localBalance: (0, server_base_1.toDecimal)(BigInt(channel.local_balance), 8),
                            capacity: (0, server_base_1.toDecimal)(BigInt(channel.capacity), 8),
                            balancePercentage: (channel.local_balance / channel.capacity * 100).toFixed(2) + "%"
                        };
                        if (channel.is_opening) {
                            result.fundingTxId = channel.transaction_id;
                        }
                        if (channel.is_closing) {
                            result.isTimelocked = channel.is_timelocked;
                            if (channel.is_timelocked) {
                                result.blocksTillClaimable = channel.timelock_blocks;
                            }
                            result.closeTxId = channel.close_transaction_id;
                        }
                        return result;
                    });
                    return {
                        openedChannels,
                        pendingChannels: pendingChannelsList
                    };
                }
            })
        ];
    }
    async getInvoice(paymentHash) {
        const result = await (0, lightning_1.getInvoice)({ id: paymentHash, lnd: this.lndClient.lnd });
        if (result == null)
            return null;
        return {
            id: result.id,
            request: result.request,
            secret: result.secret,
            cltvDelta: result.cltv_delta,
            mtokens: BigInt(result.mtokens),
            createdAt: new Date(result.created_at).getTime(),
            expiresAt: new Date(result.expires_at).getTime(),
            description: result.description,
            descriptionHash: result.description_hash,
            status: result.is_canceled ? "canceled" : result.is_confirmed ? "confirmed" : result.is_held ? "held" : "unpaid",
            payments: result.payments == null ? [] : result.payments.map(payment => {
                return {
                    createdAt: new Date(payment.created_at).getTime(),
                    confirmedAt: payment.confirmed_at == null ? null : new Date(payment.confirmed_at).getTime(),
                    createdHeight: payment.created_height,
                    timeout: payment.timeout,
                    status: payment.is_canceled ? "canceled" : payment.is_confirmed ? "confirmed" : payment.is_held ? "held" : null,
                    mtokens: BigInt(payment.mtokens)
                };
            })
        };
    }
    cancelHodlInvoice(paymentHash) {
        return (0, lightning_1.cancelHodlInvoice)({
            id: paymentHash,
            lnd: this.lndClient.lnd
        });
    }
    settleHodlInvoice(secret) {
        return (0, lightning_1.settleHodlInvoice)({
            secret,
            lnd: this.lndClient.lnd
        });
    }
    async getChannels(activeOnly) {
        const { channels } = await (0, lightning_1.getChannels)({
            is_active: activeOnly,
            lnd: this.lndClient.lnd
        });
        return channels.map(channel => {
            return {
                id: channel.id,
                capacity: BigInt(channel.capacity),
                isActive: channel.is_active,
                peerPublicKey: channel.partner_public_key,
                localBalance: BigInt(channel.local_balance),
                localReserve: BigInt(channel.local_reserve),
                remoteBalance: BigInt(channel.remote_balance),
                remoteReserve: BigInt(channel.remote_reserve),
                unsettledBalance: BigInt(channel.unsettled_balance),
                transactionId: channel.transaction_id,
                transactionVout: channel.transaction_vout
            };
        });
    }
    async getPendingChannels() {
        const { pending_channels } = await (0, lightning_1.getPendingChannels)({ lnd: this.lndClient.lnd });
        return pending_channels.map(channel => {
            return {
                id: null,
                capacity: BigInt(channel.capacity),
                isActive: channel.is_active,
                peerPublicKey: channel.partner_public_key,
                localBalance: BigInt(channel.local_balance),
                localReserve: BigInt(channel.local_reserve),
                remoteBalance: BigInt(channel.remote_balance),
                remoteReserve: BigInt(channel.remote_reserve),
                unsettledBalance: 0n,
                transactionId: channel.transaction_id,
                transactionVout: channel.transaction_vout
            };
        });
    }
    async openChannel(req) {
        if (this.lndClient.lnd == null)
            throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
        const resp = await this.lndClient.executeOnWallet(() => (0, lightning_1.openChannel)({
            lnd: this.lndClient.lnd,
            local_tokens: Number(req.amountSats),
            min_confirmations: 0,
            partner_public_key: req.peerPublicKey,
            partner_socket: req.peerAddress,
            fee_rate: req.channelFees?.feeRatePPM == null ? null : Number(req.channelFees.feeRatePPM),
            base_fee_mtokens: req.channelFees?.baseFeeMsat == null ? null : req.channelFees.baseFeeMsat.toString(10),
            chain_fee_tokens_per_vbyte: req.feeRate
        }));
        return {
            id: null,
            capacity: req.amountSats,
            isActive: false,
            peerPublicKey: req.peerPublicKey,
            localBalance: req.amountSats,
            localReserve: 0n,
            remoteBalance: 0n,
            remoteReserve: 0n,
            unsettledBalance: 0n,
            transactionId: resp.transaction_id,
            transactionVout: resp.transaction_vout
        };
    }
    async closeChannel(req) {
        if (req.forceClose) {
            const resp = await (0, lightning_1.closeChannel)({
                lnd: this.lndClient.lnd,
                is_force_close: true,
                id: req.channelId
            });
            return resp.transaction_id;
        }
        else {
            const resp = await (0, lightning_1.closeChannel)({
                lnd: this.lndClient.lnd,
                is_force_close: false,
                id: req.channelId,
                tokens_per_vbyte: req.feeRate
            });
            return resp.transaction_id;
        }
    }
    async getIdentityPublicKey() {
        const info = await (0, lightning_1.getWalletInfo)({ lnd: this.lndClient.lnd });
        return info.public_key;
    }
    async createInvoice(init) {
        const invoice = await (0, lightning_1.createInvoice)({
            description: init.description,
            description_hash: init.descriptionHash,
            cltv_delta: init.cltvDelta,
            expires_at: init.expiresAt == null ? null : new Date(init.expiresAt).toISOString(),
            mtokens: init.mtokens.toString(10),
            lnd: this.lndClient.lnd
        });
        return {
            id: invoice.id,
            request: invoice.request,
            secret: null,
            cltvDelta: init.cltvDelta,
            mtokens: init.mtokens,
            createdAt: new Date(invoice.created_at).getTime(),
            expiresAt: init.expiresAt,
            description: invoice.description,
            descriptionHash: init.descriptionHash,
            status: "unpaid",
            payments: []
        };
    }
    async createHodlInvoice(init) {
        const invoice = await (0, lightning_1.createHodlInvoice)({
            description: init.description,
            cltv_delta: init.cltvDelta,
            expires_at: new Date(init.expiresAt).toISOString(),
            id: init.id,
            mtokens: init.mtokens.toString(10),
            description_hash: init.descriptionHash,
            lnd: this.lndClient.lnd
        });
        return {
            id: invoice.id,
            request: invoice.request,
            secret: null,
            cltvDelta: init.cltvDelta,
            mtokens: init.mtokens,
            createdAt: new Date(invoice.created_at).getTime(),
            expiresAt: init.expiresAt,
            description: invoice.description,
            descriptionHash: init.descriptionHash,
            status: "unpaid",
            payments: []
        };
    }
    async getPayment(paymentHash) {
        try {
            const payment = await (0, lightning_1.getPayment)({
                id: paymentHash,
                lnd: this.lndClient.lnd
            });
            return {
                status: payment.is_confirmed ? "confirmed" : payment.is_pending ? "pending" : payment.is_failed ? "failed" : null,
                failedReason: payment.failed == null ? undefined :
                    payment.failed.is_invalid_payment ? "invalid_payment" :
                        payment.failed.is_pathfinding_timeout ? "pathfinding_timeout" :
                            payment.failed.is_route_not_found ? "route_not_found" :
                                payment.failed.is_insufficient_balance ? "insufficient_balance" : null,
                secret: payment.payment?.secret,
                feeMtokens: payment.payment != null ? BigInt(payment.payment.fee_mtokens) : undefined,
            };
        }
        catch (e) {
            if (Array.isArray(e) && e[0] === 404 && e[1] === "SentPaymentNotFound")
                return null;
            throw e;
        }
    }
    waitForPayment(paymentHash, abortSignal) {
        const subscription = (0, lightning_1.subscribeToPastPayment)({ id: paymentHash, lnd: this.lndClient.lnd });
        return new Promise((resolve, reject) => {
            if (abortSignal != null) {
                abortSignal.throwIfAborted();
                abortSignal.addEventListener("abort", () => {
                    subscription.removeAllListeners();
                    reject(abortSignal.reason);
                });
            }
            subscription.on('confirmed', (payment) => {
                resolve({
                    status: "confirmed",
                    feeMtokens: BigInt(payment.fee_mtokens),
                    secret: payment.secret
                });
                subscription.removeAllListeners();
            });
            subscription.on('failed', (data) => {
                resolve({
                    status: "failed",
                    failedReason: data.is_invalid_payment ? "invalid_payment" :
                        data.is_pathfinding_timeout ? "pathfinding_timeout" :
                            data.is_route_not_found ? "route_not_found" :
                                data.is_insufficient_balance ? "insufficient_balance" : null,
                });
                subscription.removeAllListeners();
            });
        });
    }
    async pay(init) {
        return new Promise((resolve, reject) => {
            const payment = (0, lightning_1.subscribeToPayViaRequest)({
                request: init.request,
                max_fee_mtokens: init.maxFeeMtokens == null ? undefined : init.maxFeeMtokens.toString(10),
                max_timeout_height: init.maxTimeoutHeight,
                lnd: this.lndClient.lnd
            });
            payment.on("paying", () => {
                resolve();
                payment.removeAllListeners();
            });
            payment.on("failed", (data) => {
                reject(new Error(data.is_invalid_payment ? "invalid_payment" :
                    data.is_pathfinding_timeout ? "pathfinding_timeout" :
                        data.is_route_not_found ? "route_not_found" :
                            data.is_insufficient_balance ? "insufficient_balance" :
                                data.is_canceled ? "canceled" : "unkown error"));
                payment.removeAllListeners();
            });
            payment.on("routing_failure", (data) => {
                reject(new Error("Routing failure: " + data.reason));
                payment.removeAllListeners();
            });
            payment.on("error", (error) => {
                reject(error);
                payment.removeAllListeners();
            });
        });
    }
    async getLightningBalance() {
        const resp = await (0, lightning_1.getChannelBalance)({ lnd: this.lndClient.lnd });
        return {
            localBalance: BigInt(resp.channel_balance),
            remoteBalance: BigInt(resp.inbound),
            unsettledBalance: BigInt(resp.unsettled_balance)
        };
    }
    async probe(init) {
        const bolt11Parsed = bolt11.decode(init.request);
        if (bolt11Parsed.tagsObject.blinded_payinfo != null && bolt11Parsed.tagsObject.blinded_payinfo.length > 0) {
            //Cannot probe bLIP-39 blinded path invoices
            return null;
        }
        const parsedRequest = (0, ln_service_1.parsePaymentRequest)({
            request: init.request
        });
        if (isSnowflake(parsedRequest.routes))
            return null;
        try {
            const result = await (0, lightning_1.probeForRoute)({
                mtokens: init.amountMtokens.toString(10),
                total_mtokens: init.amountMtokens.toString(10),
                max_fee_mtokens: init.maxFeeMtokens.toString(10),
                max_timeout_height: init.maxTimeoutHeight,
                payment: parsedRequest.payment,
                destination: parsedRequest.destination,
                cltv_delta: parsedRequest.cltv_delta,
                routes: parsedRequest.routes,
                is_ignoring_past_failures: true,
                lnd: this.lndClient.lnd
            });
            if (result.route == null)
                return null;
            return {
                confidence: result.route.confidence,
                feeMtokens: BigInt(result.route.fee_mtokens),
                destination: parsedRequest.destination,
                privateRoutes: fromLndRoutes(parsedRequest.routes)
            };
        }
        catch (e) {
            (0, Utils_1.handleLndError)(e);
            return null;
        }
    }
    async getRoutes(init) {
        const parsedRequest = (0, ln_service_1.parsePaymentRequest)({
            request: init.request
        });
        try {
            const result = await (0, lightning_1.getRouteToDestination)({
                mtokens: init.amountMtokens.toString(10),
                total_mtokens: init.amountMtokens.toString(10),
                max_fee_mtokens: init.maxFeeMtokens.toString(10),
                max_timeout_height: init.maxTimeoutHeight,
                payment: parsedRequest.payment,
                destination: parsedRequest.destination,
                cltv_delta: parsedRequest.cltv_delta,
                routes: parsedRequest.routes,
                is_ignoring_past_failures: true,
                lnd: this.lndClient.lnd
            });
            if (result.route == null)
                return null;
            return {
                confidence: result.route.confidence,
                feeMtokens: BigInt(result.route.fee_mtokens),
                destination: parsedRequest.destination,
                privateRoutes: fromLndRoutes(parsedRequest.routes)
            };
        }
        catch (e) {
            (0, Utils_1.handleLndError)(e);
            return null;
        }
    }
    async getRoutesBLIP39(init, bolt11Parsed) {
        const parsedRequest = (0, ln_service_1.parsePaymentRequest)({
            request: init.request
        });
        const routeReqs = bolt11Parsed.tagsObject.blinded_payinfo.map(async (blindedPath) => {
            if (blindedPath.cltv_expiry_delta + 10 > init.maxTimeoutHeight)
                return null;
            const originalMsatAmount = BigInt(parsedRequest.mtokens);
            const blindedFeeTotalMsat = BigInt(blindedPath.fee_base_msat)
                + (originalMsatAmount * BigInt(blindedPath.fee_proportional_millionths) / 1000000n);
            const routeReq = {
                destination: blindedPath.introduction_node,
                cltv_delta: Math.max(blindedPath.cltv_expiry_delta, parsedRequest.cltv_delta),
                mtokens: (originalMsatAmount + blindedFeeTotalMsat).toString(10),
                max_fee_mtokens: (init.maxFeeMtokens - blindedFeeTotalMsat).toString(10),
                max_timeout_height: init.maxTimeoutHeight,
                routes: parsedRequest.routes,
                is_ignoring_past_failures: true,
                lnd: this.lndClient.lnd
            };
            try {
                const resp = await (0, lightning_1.getRouteToDestination)(routeReq);
                if (resp == null || resp.route == null)
                    return null;
                const adjustedFeeMsats = BigInt(resp.route.fee_mtokens) + blindedFeeTotalMsat;
                resp.route.fee_mtokens = adjustedFeeMsats.toString(10);
                resp.route.fee = Number(adjustedFeeMsats / 1000n);
                resp.route.safe_fee = Number((adjustedFeeMsats + 999n) / 1000n);
                const totalAdjustedMsats = BigInt(routeReq.mtokens) + blindedFeeTotalMsat;
                resp.route.mtokens = totalAdjustedMsats.toString(10);
                resp.route.tokens = Number(totalAdjustedMsats / 1000n);
                resp.route.safe_tokens = Number((totalAdjustedMsats + 999n) / 1000n);
                return resp.route;
            }
            catch (e) {
                (0, Utils_1.handleLndError)(e);
                return null;
            }
        });
        const responses = await Promise.all(routeReqs);
        const result = responses.reduce((prev, current) => {
            if (prev == null)
                return current;
            if (current == null)
                return prev;
            const curr_fee_mtokens = BigInt(current.fee_mtokens);
            const prev_fee_mtokens = BigInt(prev.fee_mtokens);
            if (prev_fee_mtokens > curr_fee_mtokens)
                current.fee_mtokens = prev.fee_mtokens;
            current.fee = Math.max(prev.fee, current.fee);
            current.safe_fee = Math.max(prev.safe_fee, current.safe_fee);
            const curr_mtokens = BigInt(current.mtokens);
            const prev_mtokens = BigInt(prev.mtokens);
            if (prev_mtokens > curr_mtokens)
                current.mtokens = prev.mtokens;
            current.tokens = Math.max(prev.tokens, current.tokens);
            current.safe_tokens = Math.max(prev.safe_tokens, current.safe_tokens);
            current.timeout = Math.max(prev.timeout, current.timeout);
            return current;
        });
        return {
            confidence: result.confidence,
            feeMtokens: BigInt(result.fee_mtokens),
            destination: parsedRequest.destination,
            privateRoutes: fromLndRoutes(parsedRequest.routes)
        };
    }
    async route(init) {
        const bolt11Parsed = bolt11.decode(init.request);
        if (bolt11Parsed.tagsObject.blinded_payinfo != null && bolt11Parsed.tagsObject.blinded_payinfo.length > 0) {
            return this.getRoutesBLIP39(init, bolt11Parsed);
        }
        else {
            return this.getRoutes(init);
        }
    }
    async getBlockheight() {
        const res = await (0, lightning_1.getHeight)({ lnd: this.lndClient.lnd });
        return res.current_block_height;
    }
    parsePaymentRequest(request) {
        const res = (0, ln_service_1.parsePaymentRequest)({ request });
        return Promise.resolve({
            id: res.id,
            mtokens: res.mtokens == null ? null : BigInt(res.mtokens),
            expiryEpochMillis: new Date(res.expires_at).getTime(),
            destination: res.destination,
            cltvDelta: res.cltv_delta,
            description: res.description,
            routes: fromLndRoutes(res.routes)
        });
    }
    waitForInvoice(paymentHash, abortSignal) {
        const subscription = (0, lightning_1.subscribeToInvoice)({ id: paymentHash, lnd: this.lndClient.lnd });
        return new Promise((resolve, reject) => {
            if (abortSignal != null) {
                abortSignal.throwIfAborted();
                abortSignal.addEventListener("abort", () => {
                    subscription.removeAllListeners();
                    reject(abortSignal.reason);
                });
            }
            subscription.on('invoice_updated', (result) => {
                if (!result.is_held && !result.is_canceled && !result.is_confirmed)
                    return;
                resolve({
                    id: result.id,
                    request: result.request,
                    secret: result.secret,
                    cltvDelta: result.cltv_delta,
                    mtokens: BigInt(result.mtokens),
                    createdAt: new Date(result.created_at).getTime(),
                    expiresAt: new Date(result.expires_at).getTime(),
                    description: result.description,
                    descriptionHash: result.description_hash,
                    status: result.is_canceled ? "canceled" : result.is_confirmed ? "confirmed" : result.is_held ? "held" : "unpaid",
                    payments: result.payments == null ? [] : result.payments.map(payment => {
                        return {
                            createdAt: new Date(payment.created_at).getTime(),
                            confirmedAt: payment.confirmed_at == null ? null : new Date(payment.confirmed_at).getTime(),
                            createdHeight: payment.created_height,
                            timeout: payment.timeout,
                            status: payment.is_canceled ? "canceled" : payment.is_confirmed ? "confirmed" : payment.is_held ? "held" : null,
                            mtokens: BigInt(payment.mtokens)
                        };
                    })
                });
                subscription.removeAllListeners();
            });
        });
    }
}
exports.LNDLightningWallet = LNDLightningWallet;
