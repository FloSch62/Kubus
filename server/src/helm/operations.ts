import type { FastifyBaseLogger } from 'fastify';
import { nanoid } from 'nanoid';
import type {
  HelmActionResult,
  HelmOperation,
  HelmOperationFailure,
  HelmOperationKind,
  HelmOperationProgressPhase,
  HelmOperationStarted,
  HelmOperationWaitingResource,
  HelmRollbackResult,
} from '@kubus/shared';
import { HttpProblem } from '../util/errors.js';

const MAX_OPERATIONS = 100;
const MAX_WAITING_RESOURCES = 12;

type HelmOperationResult = HelmActionResult | HelmRollbackResult;

export interface HelmOperationProgressUpdate {
  phase?: HelmOperationProgressPhase;
  message?: string;
  targetVersion?: string;
  revision?: number;
  completedResources?: number;
  totalResources?: number;
  currentResource?: string;
  waitingFor?: HelmOperationWaitingResource[];
}

export type HelmProgressReporter = (update: HelmOperationProgressUpdate) => void;

export interface StartHelmOperation {
  kind: HelmOperationKind;
  ctx: string;
  namespace: string;
  releaseName: string;
  targetVersion?: string;
  targetRevision?: number;
}

function operationKey(input: Pick<StartHelmOperation, 'ctx' | 'namespace' | 'releaseName'>): string {
  return `${input.ctx}\0${input.namespace}\0${input.releaseName}`;
}

function failureDetails(error: unknown): HelmOperationFailure | undefined {
  if (!(error instanceof HttpProblem) || !error.details || typeof error.details !== 'object') return undefined;
  const details = error.details as Partial<HelmOperationFailure>;
  if (!details.operation || !details.phase || !Array.isArray(details.failed) || !Array.isArray(details.suggestions)) return undefined;
  return details as HelmOperationFailure;
}

function failureProgressPhase(failure: HelmOperationFailure | undefined, fallback: HelmOperationProgressPhase): HelmOperationProgressPhase {
  if (!failure) return fallback;
  const phases: Record<HelmOperationFailure['phase'], HelmOperationProgressPhase> = {
    'pre-hook': 'pre-hook',
    apply: 'applying',
    readiness: 'readiness',
    prune: 'pruning',
    'post-hook': 'post-hook',
    record: 'recording',
  };
  return phases[failure.phase];
}

/**
 * Runs Helm mutations outside the request lifecycle and retains a bounded
 * progress history for reconnects, page navigation, and the releases overview.
 */
export class HelmOperationManager {
  private operations = new Map<string, HelmOperation>();
  private activeByRelease = new Map<string, { id?: string; kind: HelmOperationKind | 'uninstall' }>();

  constructor(
    private log: FastifyBaseLogger,
    private emit: (operation: HelmOperation) => void,
  ) {}

  list(): HelmOperation[] {
    return [...this.operations.values()].toSorted((left, right) => right.startedAt.localeCompare(left.startedAt)).map((operation) => structuredClone(operation));
  }

  /**
   * Run a request-scoped mutation (uninstall) under the same per-release
   * exclusion as background operations: it must never overlap an install,
   * upgrade, or rollback of the same release — and vice versa.
   */
  async runExclusive<T>(input: Pick<StartHelmOperation, 'ctx' | 'namespace' | 'releaseName'>, kind: 'uninstall', run: () => Promise<T>): Promise<T> {
    const key = operationKey(input);
    this.assertIdle(key, input);
    this.activeByRelease.set(key, { kind });
    try {
      return await run();
    } finally {
      this.activeByRelease.delete(key);
    }
  }

  private assertIdle(key: string, input: Pick<StartHelmOperation, 'namespace' | 'releaseName'>): void {
    const active = this.activeByRelease.get(key);
    if (active) {
      throw new HttpProblem(409, `${active.kind} operation already running for ${input.namespace}/${input.releaseName}`);
    }
  }

  start(input: StartHelmOperation, run: (report: HelmProgressReporter) => Promise<HelmOperationResult>): HelmOperationStarted {
    const key = operationKey(input);
    this.assertIdle(key, input);

    this.trimHistory();
    const now = new Date().toISOString();
    const operation: HelmOperation = {
      id: nanoid(12),
      kind: input.kind,
      ctx: input.ctx,
      namespace: input.namespace,
      releaseName: input.releaseName,
      status: 'running',
      phase: 'queued',
      message: `${input.kind} queued`,
      startedAt: now,
      updatedAt: now,
      targetVersion: input.targetVersion,
      targetRevision: input.targetRevision,
    };
    this.operations.set(operation.id, operation);
    this.activeByRelease.set(key, { id: operation.id, kind: input.kind });
    this.emitSnapshot(operation);

    // Let the HTTP handler return 202 before chart download, rendering, hooks,
    // applies, or readiness waits begin.
    queueMicrotask(() => void this.execute(operation.id, key, run));
    return { operationId: operation.id };
  }

  private async execute(id: string, key: string, run: (report: HelmProgressReporter) => Promise<HelmOperationResult>): Promise<void> {
    const report: HelmProgressReporter = (update) => this.update(id, update);
    try {
      const result = await run(report);
      const revision = 'revision' in result ? result.revision : result.newRevision;
      this.finish(id, {
        status: 'succeeded',
        phase: 'completed',
        message: `${this.operations.get(id)?.kind ?? 'Helm'} completed at revision ${revision}`,
        result,
        revision,
        completedResources: undefined,
        totalResources: undefined,
        currentResource: undefined,
        waitingFor: undefined,
      });
    } catch (error) {
      const failure = failureDetails(error);
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn({ operationId: id, err: message }, 'background helm operation failed');
      this.finish(id, {
        status: 'failed',
        phase: failureProgressPhase(failure, this.operations.get(id)?.phase ?? 'completed'),
        message: 'Helm operation failed',
        error: message,
        failure,
        revision: failure?.revision,
        currentResource: undefined,
      });
    } finally {
      this.activeByRelease.delete(key);
    }
  }

  private update(id: string, update: HelmOperationProgressUpdate): void {
    const operation = this.operations.get(id);
    if (!operation || operation.status !== 'running') return;
    Object.assign(operation, update, {
      waitingFor: update.waitingFor?.slice(0, MAX_WAITING_RESOURCES),
      updatedAt: new Date().toISOString(),
    });
    this.emitSnapshot(operation);
  }

  private finish(id: string, update: Partial<HelmOperation>): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    Object.assign(operation, update, { updatedAt: new Date().toISOString() });
    this.emitSnapshot(operation);
  }

  private emitSnapshot(operation: HelmOperation): void {
    this.emit(structuredClone(operation));
  }

  private trimHistory(): void {
    if (this.operations.size < MAX_OPERATIONS) return;
    const terminal = [...this.operations.values()]
      .filter((operation) => operation.status !== 'running')
      .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt));
    while (this.operations.size >= MAX_OPERATIONS && terminal.length) {
      this.operations.delete(terminal.shift()!.id);
    }
  }
}
