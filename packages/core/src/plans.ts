import { randomUUID } from "node:crypto";
import { KkError } from "./errors.js";

export interface PlanRecord<T> {
  planId: string;
  kind: string;
  createdAt: string;
  expiresAt: string;
  fingerprint: string;
  summary: string;
  risks: string[];
  payload: T;
}

export class PlanStore {
  readonly #plans = new Map<string, PlanRecord<unknown>>();
  readonly #ttlMs: number;

  constructor(ttlMs = 300_000) {
    this.#ttlMs = ttlMs;
  }

  create<T>(input: {
    kind: string;
    fingerprint: string;
    summary: string;
    risks?: string[];
    payload: T;
  }): PlanRecord<T> {
    this.prune();
    const now = Date.now();
    const plan: PlanRecord<T> = {
      planId: randomUUID(),
      kind: input.kind,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#ttlMs).toISOString(),
      fingerprint: input.fingerprint,
      summary: input.summary,
      risks: input.risks ?? [],
      payload: input.payload,
    };
    this.#plans.set(plan.planId, plan as PlanRecord<unknown>);
    return plan;
  }

  get<T>(planId: string, kind?: string): PlanRecord<T> {
    const plan = this.#plans.get(planId);
    if (!plan) throw new KkError("PLAN_NOT_FOUND", `Unknown planId: ${planId}`);
    if (Date.parse(plan.expiresAt) <= Date.now()) {
      this.#plans.delete(planId);
      throw new KkError("PLAN_EXPIRED", `Plan ${planId} has expired`);
    }
    if (kind && plan.kind !== kind) {
      throw new KkError("CONFLICT", `Plan ${planId} is for ${plan.kind}, not ${kind}`);
    }
    return plan as PlanRecord<T>;
  }

  consume<T>(planId: string, kind?: string): PlanRecord<T> {
    const plan = this.get<T>(planId, kind);
    this.#plans.delete(planId);
    return plan;
  }

  prune(): void {
    const now = Date.now();
    for (const [id, plan] of this.#plans) {
      if (Date.parse(plan.expiresAt) <= now) this.#plans.delete(id);
    }
  }
}
