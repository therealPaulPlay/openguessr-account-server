import { getDB } from "./dbConnection.js";

// Groups players into buckets via a single SQL query,
// so that rank lookups are instant without any DB round-trip
export class RankApproximator {
    #refreshPromise = null;

    constructor(column, { bucketExpr, toBucket, toUpperBound, baseline = 0 }) {
        this.column = column;
        this.bucketExpr = bucketExpr;
        this.toBucket = toBucket;
        this.toUpperBound = toUpperBound;
        this.baseline = baseline;
        this.buckets = new Map();
    }

    async refresh() {
        const db = getDB();

        const [rows] = await db.promise().query(
            `SELECT ${this.bucketExpr} AS bucket, COUNT(*) AS cnt FROM users WHERE ${this.column} != ? GROUP BY bucket`,
            [this.baseline]
        );

        const buckets = new Map();
        for (const row of rows) buckets.set(Number(row.bucket), Number(row.cnt));

        const [[{ cnt }]] = await db.promise().query(
            `SELECT COUNT(*) AS cnt FROM users WHERE ${this.column} = ?`,
            [this.baseline]
        );
        const baselineBucket = this.toBucket(this.baseline);
        buckets.set(baselineBucket, (buckets.get(baselineBucket) || 0) + Number(cnt));

        this.buckets = buckets;
    }

    ensureLoaded() {
        if (this.buckets.size) return Promise.resolve();
        if (!this.#refreshPromise) {
            this.#refreshPromise = this.refresh().catch(err => {
                this.#refreshPromise = null;
                throw err;
            });
        }
        return this.#refreshPromise;
    }

    getRank(value) {
        if (!this.buckets.size) return null;
        const userBucket = this.toBucket(value);
        let rank = 0;
        for (const [bucket, count] of this.buckets) {
            if (bucket > userBucket) rank += count;
        }
        rank += Math.floor((this.buckets.get(userBucket) || 0) / 2);
        return Math.max(rank, 1);
    }
}
