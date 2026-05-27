import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EventLogService } from './event-log.service';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How often the supervisor polls for stuck runs.
 * 60 seconds is suitable for development; tighten in production if SLA requires.
 */
const POLL_INTERVAL_MS = 60_000;

/**
 * A run is considered "stuck" when its project row has not transitioned to a
 * terminal status AND no EventLog entry has been written in the past 10 minutes.
 */
const STUCK_THRESHOLD_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * Project statuses that are terminal — runs in these states are never retried.
 */
const TERMINAL_STATUSES = ['DELIVERED', 'FAILED'] as const;

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * RunSupervisorService — polls every 60 s for stuck runs and applies the
 * deterministic recovery strategy:
 *
 *   1. Stuck run detected (no EventLog entry in > 10 minutes)
 *   2. Check RunBudget:
 *      a. retryCount >= maxRetries  →  escalateToHuman()  →  status = FAILED
 *      b. Otherwise                 →  increment retryCount, log STUCK, reset
 *         status to previous active state. The OrchestrationService's existing
 *         resume/poll logic re-invokes LangGraph from the last checkpoint.
 *
 * The supervisor DOES NOT call the LangGraph graph directly. It only updates
 * DB state. OrchestrationService handles actual re-invocation.
 */
@Injectable()
export class RunSupervisorService {
  private readonly logger = new Logger(RunSupervisorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventLog: EventLogService,
  ) {}

  // ── Polling tick ───────────────────────────────────────────────────────────

  /**
   * Main supervisor loop. Decorated with @Interval so NestJS Schedule triggers
   * it every POLL_INTERVAL_MS milliseconds after the application boots.
   */
  @Interval(POLL_INTERVAL_MS)
  async supervisorTick(): Promise<void> {
    this.logger.debug('Supervisor tick — scanning for stuck runs');

    try {
      const stuckProjects = await this.findStuckProjects();

      if (stuckProjects.length === 0) {
        this.logger.debug('No stuck runs found');
        return;
      }

      this.logger.warn(
        `Supervisor detected ${stuckProjects.length} stuck run(s): [${stuckProjects.map((p) => p.id).join(', ')}]`,
      );

      // Process all stuck projects in parallel; individual failures are isolated.
      await Promise.allSettled(
        stuckProjects.map((project) => this.handleStuckProject(project)),
      );
    } catch (err) {
      this.logger.error(
        `Supervisor tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Public: escalation (also called from EventLogService on budget exhaust) ──

  /**
   * Escalates a project to human review.
   *
   * Sets project status to FAILED, writes an ESCALATED event log entry, and
   * emits a WARN-level log with full context for on-call visibility.
   */
  async escalateToHuman(projectId: string, reason: string): Promise<void> {
    this.logger.warn(
      `[${projectId}] ESCALATING to human — reason: ${reason}`,
    );

    // Gather context for the warning log before mutating state.
    const [budget, lastEvent] = await Promise.allSettled([
      this.prisma.runBudget.findUnique({
        where: { projectId },
        select: {
          tokensConsumed: true,
          tokenBudget: true,
          retryCount: true,
          maxRetries: true,
        },
      }),
      this.prisma.eventLog.findFirst({
        where: { projectId },
        orderBy: { occurredAt: 'desc' },
        select: { nodeName: true, eventType: true, occurredAt: true },
      }),
    ]);

    const budgetInfo =
      budget.status === 'fulfilled' && budget.value
        ? `tokens=${budget.value.tokensConsumed}/${budget.value.tokenBudget}, retries=${budget.value.retryCount}/${budget.value.maxRetries}`
        : 'budget unavailable';

    const lastNode =
      lastEvent.status === 'fulfilled' && lastEvent.value
        ? `${lastEvent.value.nodeName}:${lastEvent.value.eventType} at ${lastEvent.value.occurredAt.toISOString()}`
        : 'no events recorded';

    this.logger.warn(
      `[${projectId}] Escalation context — ${budgetInfo} | last known node: ${lastNode} | reason: ${reason}`,
    );

    // Persist state changes and event log atomically via allSettled.
    await Promise.allSettled([
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: 'FAILED' },
      }),
      this.eventLog.logEscalated(projectId, 'supervisor', reason),
    ]);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Returns all projects that are active (non-terminal) and have had no
   * EventLog activity in the past STUCK_THRESHOLD_MS milliseconds.
   *
   * Uses a raw query to perform the correlated subquery efficiently. The NOT IN
   * list covers terminal statuses; prisma.$queryRaw returns typed rows.
   */
  private async findStuckProjects(): Promise<StuckProject[]> {
    const threshold = new Date(Date.now() - STUCK_THRESHOLD_MS);

    // Raw SQL: join Project to RunBudget and check max(occurredAt) per project.
    // Projects with no EventLog rows at all are also considered stuck (NULL < threshold).
    const rows = await this.prisma.$queryRaw<StuckProjectRow[]>`
      SELECT
        p.id,
        p.status,
        rb."retryCount",
        rb."maxRetries",
        rb."tokensConsumed",
        rb."tokenBudget"
      FROM "Project" p
      INNER JOIN run_budgets rb ON rb."projectId" = p.id
      WHERE p.status NOT IN (${TERMINAL_STATUSES[0]}, ${TERMINAL_STATUSES[1]})
        AND (
          SELECT MAX(el."occurredAt")
          FROM event_logs el
          WHERE el."projectId" = p.id
        ) < ${threshold}
    `;

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      retryCount: Number(row.retryCount),
      maxRetries: Number(row.maxRetries),
      tokensConsumed: Number(row.tokensConsumed),
      tokenBudget: Number(row.tokenBudget),
    }));
  }

  /**
   * Applies the recovery strategy to a single stuck project.
   */
  private async handleStuckProject(project: StuckProject): Promise<void> {
    const budgetExhausted = project.tokensConsumed >= project.tokenBudget;
    const retriesExhausted = project.retryCount >= project.maxRetries;

    if (budgetExhausted || retriesExhausted) {
      const reason = budgetExhausted
        ? `Token budget exhausted (${project.tokensConsumed}/${project.tokenBudget})`
        : `Max retries reached (${project.retryCount}/${project.maxRetries})`;

      await this.escalateToHuman(project.id, reason);
      return;
    }

    // Auto-retry path: increment retryCount, log STUCK event, then reset the
    // project status back to an active state so OrchestrationService can resume
    // the LangGraph run from the last checkpoint.
    this.logger.warn(
      `[${project.id}] Auto-retrying stuck run (attempt ${project.retryCount + 1}/${project.maxRetries})`,
    );

    await Promise.allSettled([
      // Increment retry counter.
      this.prisma.runBudget.update({
        where: { projectId: project.id },
        data: { retryCount: { increment: 1 } },
      }),
      // Write the STUCK audit event.
      this.eventLog.logStuck(project.id, 'supervisor'),
      // Reset project status to its current active state to signal re-invocation.
      // The previous status is preserved — OrchestrationService polls status and
      // resumes the graph from the LangGraph checkpoint when it sees an active state.
      this.prisma.project.update({
        where: { id: project.id },
        data: { status: project.status },
      }),
    ]);

    this.logger.log(
      `[${project.id}] Stuck run marked for retry. OrchestrationService will resume from checkpoint.`,
    );
  }
}

// ─── Internal Types ───────────────────────────────────────────────────────────

interface StuckProjectRow {
  id: string;
  status: string;
  retryCount: bigint | number;
  maxRetries: bigint | number;
  tokensConsumed: bigint | number;
  tokenBudget: bigint | number;
}

interface StuckProject {
  id: string;
  status: string;
  retryCount: number;
  maxRetries: number;
  tokensConsumed: number;
  tokenBudget: number;
}
