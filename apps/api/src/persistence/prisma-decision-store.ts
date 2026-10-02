import type { DecisionRecord } from "@dipbuyer/shared";
import type { DecisionStore } from "@dipbuyer/agent";

/**
 * Postgres-backed DecisionStore (production persistence; the engineering design notes§11). The full DecisionRecord
 * is stored as immutable JSON `payload` plus indexed columns. We type only the Prisma client
 * subset we use (PrismaLike) so this file compiles WITHOUT a generated @prisma/client — the real
 * client is injected at runtime by the factory (see decision.providers.ts) only when DATABASE_URL
 * is set. Records are append-only (enforce immutability with a DB trigger in migration).
 */
export interface PrismaLike {
  $connect(): Promise<void>;
  decisionRecord: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    findMany(args: { orderBy?: unknown; take?: number }): Promise<Array<{ payload: unknown }>>;
    findFirst(args: { where?: unknown; orderBy?: unknown }): Promise<{ payload: unknown } | null>;
  };
}

export class PrismaDecisionStore implements DecisionStore {
  constructor(private readonly prisma: PrismaLike) {}

  async save(record: DecisionRecord): Promise<void> {
    await this.prisma.decisionRecord.create({
      data: {
        decisionId: record.decisionId,
        ts: new Date(record.ts),
        mode: record.mode,
        execution: record.execution,
        tenantId: record.tenantId ?? null,
        symbol: record.symbol,
        lynchCategory: record.lynchCategory ?? null,
        convictionScore: record.convictionScore,
        verdict: record.verdict,
        rationale: record.rationale,
        payload: record as unknown as Record<string, unknown>,
        strategyConfig: record.model.strategyConfigHash,
      },
    });
  }

  async recent(limit = 50): Promise<DecisionRecord[]> {
    const rows = await this.prisma.decisionRecord.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    return rows.map((r) => r.payload as DecisionRecord);
  }

  async latestFor(symbol: string): Promise<DecisionRecord | null> {
    const row = await this.prisma.decisionRecord.findFirst({ where: { symbol }, orderBy: { ts: "desc" } });
    return row ? (row.payload as DecisionRecord) : null;
  }
}

/**
 * Lazily constructs a PrismaClient (indirect import so tsc needs no generated types) and eagerly
 * `$connect()`s so an unreachable/unmigrated database fails HERE — letting the factory fall back to
 * the in-memory store instead of throwing 500s on every write at request time.
 */
export async function createPrismaClient(): Promise<PrismaLike> {
  const pkg = "@prisma/client";
  const mod = (await import(pkg)) as { PrismaClient: new () => PrismaLike };
  const client = new mod.PrismaClient();
  await client.$connect();
  return client;
}
