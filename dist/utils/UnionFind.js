"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnionFind = void 0;
class UnionFind {
    constructor() {
        this.parent = new Map();
    }
    // Find the root representative of the set containing x
    find(x) {
        if (!this.parent.has(x)) {
            this.parent.set(x, x);
        }
        else if (this.parent.get(x) !== x) {
            const root = this.find(this.parent.get(x));
            this.parent.set(x, root); // Path compression
        }
        return this.parent.get(x);
    }
    add(x) {
        this.find(x);
    }
    // Union the sets containing a and b
    union(a, b) {
        const rootA = this.find(a);
        const rootB = this.find(b);
        if (rootA !== rootB) {
            this.parent.set(rootA, rootB); // Merge the two sets
        }
    }
    getClusters() {
        const clusters = new Map();
        const txClusters = new Map();
        for (const txId of this.parent.keys()) {
            const root = this.find(txId);
            let existingCluster = clusters.get(root);
            if (existingCluster == null) {
                clusters.set(root, (existingCluster = new Set([txId])));
            }
            else {
                existingCluster.add(txId);
            }
            txClusters.set(txId, existingCluster);
        }
        return txClusters;
    }
}
exports.UnionFind = UnionFind;
