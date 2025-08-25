export class UnionFind {
    private parent: Map<string, string>;

    constructor() {
        this.parent = new Map();
    }

    // Find the root representative of the set containing x
    private find(x: string): string {
        if (!this.parent.has(x)) {
            this.parent.set(x, x);
        } else if (this.parent.get(x) !== x) {
            const root = this.find(this.parent.get(x)!);
            this.parent.set(x, root); // Path compression
        }
        return this.parent.get(x);
    }

    add(x: string): void {
        this.find(x);
    }

    // Union the sets containing a and b
    union(a: string, b: string): void {
        const rootA = this.find(a);
        const rootB = this.find(b);
        if (rootA !== rootB) {
            this.parent.set(rootA, rootB); // Merge the two sets
        }
    }

    getClusters(): Map<string, Set<string>> {
        const clusters: Map<string, Set<string>> = new Map();
        const txClusters: Map<string, Set<string>> = new Map();
        for (const txId of this.parent.keys()) {
            const root = this.find(txId);
            let existingCluster = clusters.get(root);
            if (existingCluster == null) {
                clusters.set(root, (existingCluster = new Set([txId])));
            } else {
                existingCluster.add(txId);
            }
            txClusters.set(txId, existingCluster);
        }
        return txClusters;
    }
}