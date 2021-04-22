"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var crypto = require('crypto');
const logger = require('../services/logger');
class SyncChecker {
    constructor(redis) {
        this.redis = redis;
    }
    async consensusFilter(nodes, syncCheck, blockchain, pocket, pocketConfiguration) {
        let syncedNodes = [];
        let syncedNodesList = [];
        // Key is "blockchain - a hash of the all the nodes in this session, sorted by public key"
        // Value is an array of node public keys that have passed sync checks for this session in the past 5 minutes
        const syncedNodesKey = blockchain + '-' + crypto.createHash('sha256').update(JSON.stringify(nodes.sort((a, b) => (a.publicKey > b.publicKey) ? 1 : ((b.publicKey > a.publicKey) ? -1 : 0)), (k, v) => k != 'publicKey' ? v : undefined)).digest('hex');
        const syncedNodesCached = await this.redis.get(syncedNodesKey);
        if (syncedNodesCached) {
            syncedNodesList = JSON.parse(syncedNodesCached);
            for (const node of nodes) {
                if (syncedNodesList.includes(node.publicKey)) {
                    syncedNodes.push(node);
                }
            }
            return syncedNodes;
        }
        // Cache is stale, start a new cache fill
        // First check cache lock key; if lock key exists, return full node set
        const syncLock = await this.redis.get('lock-' + syncedNodesKey);
        if (syncLock) {
            return nodes;
        }
        else {
            // Set lock as this thread checks the sync with 10 second ttl
            await this.redis.set('lock-' + syncedNodesKey, 'true', 'EX', 10);
        }
        // Check sync of nodes with consensus
        for (const node of nodes) {
            /*
            const relayResponse = await pocket.sendRelay(
              '{"method":"web3_clientVersion","id":1,"jsonrpc":"2.0"}',
              blockchain,
              pocketAAT,
              this.pocketConfiguration,
              undefined,
              'POST' as HTTPMethod,
              undefined
            );
        
            if (relayResponse instanceof RelayResponse) {
              logger.log('info', 'CLIENT CHECK ' + relayResponse.payload, {requestID: requestID, relayType: '', typeID: '', serviceNode: node.publicKey});
              await this.redis.set(
                blockchain + '-' + node.publicKey + '-clientType',
                relayResponse.payload,
                'EX',
                (60 * 60 * 24),
              );
            }
            */
            syncedNodes.push(node);
            syncedNodesList.push(node.publicKey);
        }
        logger.log('info', 'SYNC CHECK: writing sync status ' + syncedNodesKey);
        await this.redis.set(syncedNodesKey, JSON.stringify(syncedNodesList), 'EX', 300);
        return syncedNodes;
    }
}
exports.SyncChecker = SyncChecker;
//# sourceMappingURL=sync-checker.js.map