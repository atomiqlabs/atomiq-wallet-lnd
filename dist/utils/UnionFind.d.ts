export declare class UnionFind {
    private parent;
    constructor();
    private find;
    add(x: string): void;
    union(a: string, b: string): void;
    getClusters(): Map<string, Set<string>>;
}
