import { Logger } from '@nestjs/common';
import {
  StateGraph,
  END,
  START,
  NodeInterrupt,
  Send,
  CompiledStateGraph,
} from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { DevFlowState, DevFlowStateType } from './devflow.state';
import { RequirementsParserNode } from '../nodes/requirements-parser.node';
import { ContractNegotiatorNode } from '../nodes/contract-negotiator.node';
import { FrontendAgentNode } from '../nodes/frontend-agent.node';
import { BackendAgentNode } from '../nodes/backend-agent.node';
import { DatabaseAgentNode } from '../nodes/database-agent.node';
import { ArchitectureAgentNode } from '../nodes/architecture-agent.node';
import { ValidatorNode } from '../nodes/validator.node';
import { GithubCommitNode } from '../nodes/github-commit.node';
import { PrismaService } from '../../prisma/prisma.service';

// ─── Node Names ───────────────────────────────────────────────────────────────

export const NODE = {
  PARSE_REQUIREMENTS: 'parse_requirements',
  NEGOTIATE_CONTRACT: 'negotiate_contract',
  GATE_1_CHECK: 'gate_1_check',
  FRONTEND_AGENT: 'frontend_agent',
  BACKEND_AGENT: 'backend_agent',
  DATABASE_AGENT: 'database_agent',
  ARCHITECTURE_AGENT: 'architecture_agent',
  VALIDATE_OUTPUTS: 'validate_outputs',
  GATE_2_CHECK: 'gate_2_check',
  COMMIT_TO_GITHUB: 'commit_to_github',
  MARK_DELIVERED: 'mark_delivered',
} as const;

// ─── Graph Builder ─────────────────────────────────────────────────────────────

export function buildDevFlowGraph(
  requirementsParser: RequirementsParserNode,
  contractNegotiator: ContractNegotiatorNode,
  frontendAgent: FrontendAgentNode,
  backendAgent: BackendAgentNode,
  databaseAgent: DatabaseAgentNode,
  architectureAgent: ArchitectureAgentNode,
  validator: ValidatorNode,
  githubCommit: GithubCommitNode,
  prisma: PrismaService,
  checkpointer: PostgresSaver,
): CompiledStateGraph<DevFlowStateType, Partial<DevFlowStateType>, string> {
  const logger = new Logger('DevFlowGraph');

  const graph = new StateGraph(DevFlowState) as any;

  // ── Node definitions ────────────────────────────────────────────────────────

  graph.addNode(NODE.PARSE_REQUIREMENTS, (state: any) =>
    requirementsParser.execute(state: any),
  );

  graph.addNode(NODE.NEGOTIATE_CONTRACT, (state: any) =>
    contractNegotiator.execute(state: any),
  );

  graph.addNode(NODE.GATE_1_CHECK, async (state: any) => {
    if (state.error) {
      logger.error(`[${state.projectId}] Error before gate 1: ${state.error}`);
      return {};
    }
    if (!state.gate1Approved) {
      logger.log(`[${state.projectId}] Interrupting at gate 1`);
      await prisma.project.update({
        where: { id: state.projectId },
        data: { status: 'AWAITING_GATE_1' },
      });
      throw new NodeInterrupt({
        type: 'GATE_1_REQUIRED',
        projectId: state.projectId,
      });
    }
    logger.log(`[${state.projectId}] Gate 1 approved, continuing`);
    await prisma.project.update({
      where: { id: state.projectId },
      data: { status: 'GENERATING_CODE' },
    });
    return {};
  });

  graph.addNode(NODE.FRONTEND_AGENT, (state: any) =>
    frontendAgent.execute(state: any),
  );

  graph.addNode(NODE.BACKEND_AGENT, (state: any) =>
    backendAgent.execute(state: any),
  );

  graph.addNode(NODE.DATABASE_AGENT, (state: any) =>
    databaseAgent.execute(state: any),
  );

  graph.addNode(NODE.ARCHITECTURE_AGENT, (state: any) =>
    architectureAgent.execute(state: any),
  );

  graph.addNode(NODE.VALIDATE_OUTPUTS, (state: any) =>
    validator.execute(state: any),
  );

  graph.addNode(NODE.GATE_2_CHECK, async (state: any) => {
    if (!state.gate2Approved) {
      logger.log(`[${state.projectId}] Interrupting at gate 2`);
      await prisma.project.update({
        where: { id: state.projectId },
        data: { status: 'AWAITING_GATE_2' },
      });
      throw new NodeInterrupt({
        type: 'GATE_2_REQUIRED',
        projectId: state.projectId,
      });
    }
    logger.log(`[${state.projectId}] Gate 2 approved, committing`);
    return {};
  });

  graph.addNode(NODE.COMMIT_TO_GITHUB, (state: any) =>
    githubCommit.execute(state: any),
  );

  graph.addNode(NODE.MARK_DELIVERED, async (state: any) => {
    logger.log(`[${state.projectId}] Marking project as delivered`);
    await prisma.project.update({
      where: { id: state.projectId },
      data: { status: 'DELIVERED' },
    });
    return {};
  });

  // ── Edge wiring ────────────────────────────────────────────────────────────

  graph.addEdge(START, NODE.PARSE_REQUIREMENTS);
  graph.addEdge(NODE.PARSE_REQUIREMENTS, NODE.NEGOTIATE_CONTRACT);
  graph.addEdge(NODE.NEGOTIATE_CONTRACT, NODE.GATE_1_CHECK);

  // After gate 1: error → END, approved → code generation.
  //
  // Phase 2D — complexity-based fan-out:
  //   'complex'          → dispatch all four code-gen agents in PARALLEL via
  //                         Send(), allowing LLM calls to overlap. LangGraph
  //                         treats each Send() as an independent branch; the
  //                         validate_outputs node acts as the natural join point
  //                         because it reads state.artifacts (reducer = append),
  //                         which accumulates outputs from all parallel branches.
  //   'simple' | 'medium' → sequential execution (frontend → backend → database
  //                         → architecture) to minimise concurrent API load for
  //                         smaller projects.
  //
  // Note: Send() passes the current state snapshot to each target node. The
  // artifacts reducer (existing, next) => [...existing, ...next] merges all
  // parallel outputs before validate_outputs runs.
  graph.addConditionalEdges(NODE.GATE_1_CHECK, (state: any) => {
    if (state.error) return END;

    if (state.complexity === 'complex') {
      logger.log(
        `[${state.projectId}] Complexity=complex — dispatching code agents in parallel`,
      );
      // Send() dispatches each agent as an independent parallel branch.
      // All branches merge at validate_outputs via the artifacts reducer.
      return [
        new Send(NODE.FRONTEND_AGENT, state),
        new Send(NODE.BACKEND_AGENT, state),
        new Send(NODE.DATABASE_AGENT, state),
        new Send(NODE.ARCHITECTURE_AGENT, state),
      ];
    }

    // sequential path for simple / medium complexity
    logger.log(
      `[${state.projectId}] Complexity=${state.complexity ?? 'unknown'} — sequential code generation`,
    );
    return NODE.FRONTEND_AGENT;
  });

  // ── Code-gen node routing ──────────────────────────────────────────────────
  //
  // Each code-gen node uses a conditional edge that reads state.complexity:
  //
  //   'complex'  (parallel path via Send()):
  //     Each agent was dispatched independently; route directly to validate_outputs.
  //     LangGraph merges all parallel branch updates via the artifacts reducer
  //     (existing, next) => [...existing, ...next] before continuing.
  //
  //   'simple' | 'medium' (sequential path):
  //     Chain through the pipeline: frontend → backend → database → architecture
  //     → validate_outputs.

  graph.addConditionalEdges(NODE.FRONTEND_AGENT, (state: any) => {
    if (state.complexity === 'complex') return NODE.VALIDATE_OUTPUTS;
    return NODE.BACKEND_AGENT;
  });

  graph.addConditionalEdges(NODE.BACKEND_AGENT, (state: any) => {
    if (state.complexity === 'complex') return NODE.VALIDATE_OUTPUTS;
    return NODE.DATABASE_AGENT;
  });

  graph.addConditionalEdges(NODE.DATABASE_AGENT, (state: any) => {
    if (state.complexity === 'complex') return NODE.VALIDATE_OUTPUTS;
    return NODE.ARCHITECTURE_AGENT;
  });

  graph.addEdge(NODE.ARCHITECTURE_AGENT, NODE.VALIDATE_OUTPUTS);

  // After validation:
  //   - error starts with "RETRY:" → route back to the appropriate agent
  //   - any other error (max retries exceeded) → gate 2 for human review
  //   - no error → gate 2
  graph.addConditionalEdges(NODE.VALIDATE_OUTPUTS, (state: any) => {
    if (state.error?.startsWith('RETRY:')) {
      const agentHint = state.error.slice('RETRY:'.length);
      switch (agentHint) {
        case 'backend':
          return NODE.BACKEND_AGENT;
        case 'database':
          return NODE.DATABASE_AGENT;
        case 'architecture':
          return NODE.ARCHITECTURE_AGENT;
        default:
          // frontend or unknown — restart the generation pipeline
          return NODE.FRONTEND_AGENT;
      }
    }
    return NODE.GATE_2_CHECK;
  });

  // After gate 2: terminal error → END, approved → commit
  // Note: RETRY: errors at this stage are treated as warnings, not terminal
  graph.addConditionalEdges(NODE.GATE_2_CHECK, (state: any) => {
    const isTerminalError =
      state.error !== null &&
      state.error !== undefined &&
      !state.error.startsWith('RETRY:');
    if (isTerminalError) return END;
    return NODE.COMMIT_TO_GITHUB;
  });

  graph.addEdge(NODE.COMMIT_TO_GITHUB, NODE.MARK_DELIVERED);
  graph.addEdge(NODE.MARK_DELIVERED, END);

  // ── Compile with checkpointer ──────────────────────────────────────────────

  return graph.compile({ checkpointer }) as CompiledStateGraph<
    DevFlowStateType,
    Partial<DevFlowStateType>,
    string
  >;
}
