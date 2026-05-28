import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTaskStatus, WorkOrderPriority } from '@prisma/client';
import { FrontendAgentNode } from '../src/orchestration/nodes/frontend-agent.node';
import { GithubCommitNode } from '../src/orchestration/nodes/github-commit.node';
import { RequirementsParserNode } from '../src/orchestration/nodes/requirements-parser.node';
import { GraphLlmProvider } from '../src/orchestration/providers/graph-llm.provider';
import { DevFlowStateType } from '../src/orchestration/graph/devflow.state';

describe('GraphLlmProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it('parses OpenRouter JSON arrays for LangGraph file agents', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.OPENROUTER_MODEL = 'test/free-model';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  filePath: 'src/app/page.tsx',
                  content: 'export default function Page() { return <div />; }',
                  language: 'tsx',
                },
              ]),
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 34,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GraphLlmProvider().generateJson<Array<{ filePath: string }>>({
      agentName: 'frontend_agent',
      systemPrompt: 'Generate files.',
      userPrompt: 'Generate one file.',
      expectedShape: 'array',
    });

    expect(result).toEqual({
      value: [{ filePath: 'src/app/page.tsx', content: 'export default function Page() { return <div />; }', language: 'tsx' }],
      model: 'test/free-model',
      usage: { inputTokens: 12, outputTokens: 34 },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toBeUndefined();
  });

  it('parses OpenAI JSON arrays for LangGraph file agents', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-test-model';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  filePath: 'ARCHITECTURE.md',
                  content: '# Architecture',
                  language: 'markdown',
                },
              ]),
            },
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 22,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GraphLlmProvider().generateJson<Array<{ filePath: string }>>({
      agentName: 'architecture_agent',
      systemPrompt: 'Generate docs.',
      userPrompt: 'Generate one doc.',
      expectedShape: 'array',
    });

    expect(result).toEqual({
      value: [{ filePath: 'ARCHITECTURE.md', content: '# Architecture', language: 'markdown' }],
      model: 'gpt-test-model',
      usage: { inputTokens: 11, outputTokens: 22 },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toEqual(expect.objectContaining({
      type: 'json_schema',
      json_schema: expect.objectContaining({
        schema: expect.objectContaining({ type: 'array' }),
      }),
    }));
  });

  it('parses Anthropic JSON arrays for LangGraph file agents', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.ANTHROPIC_MODEL = 'claude-test-model';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify([
              {
                filePath: 'API.md',
                content: '# API',
                language: 'markdown',
              },
            ]),
          },
        ],
        usage: {
          input_tokens: 13,
          output_tokens: 21,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GraphLlmProvider().generateJson<Array<{ filePath: string }>>({
      agentName: 'architecture_agent',
      systemPrompt: 'Generate docs.',
      userPrompt: 'Generate one doc.',
      expectedShape: 'array',
    });

    expect(result).toEqual({
      value: [{ filePath: 'API.md', content: '# API', language: 'markdown' }],
      model: 'claude-test-model',
      usage: { inputTokens: 13, outputTokens: 21 },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toContain('Generate docs.');
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user' }),
    ]));
  });

  it('repairs malformed OpenRouter JSON before failing LangGraph agents', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: '[{ bad json' } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: '[{"filePath":"ARCHITECTURE.md","content":"# Architecture","language":"markdown"}]' } }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GraphLlmProvider().generateJson<Array<{ filePath: string }>>({
      agentName: 'architecture_agent',
      systemPrompt: 'Generate docs.',
      userPrompt: 'Generate architecture docs.',
      expectedShape: 'array',
    });

    expect(result.value).toEqual([
      { filePath: 'ARCHITECTURE.md', content: '# Architecture', language: 'markdown' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('LangGraph GitHub delivery node', () => {
  it('creates a repository, commits generated artifacts, injects CI, and persists repoUrl', async () => {
    const github = {
      buildRepoName: vi.fn().mockReturnValue('acme-project-1'),
      createRepo: vi.fn().mockResolvedValue('https://github.com/acme/project-1.git'),
      commitFiles: vi.fn().mockResolvedValue(undefined),
      injectCiWorkflow: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      project: {
        update: vi.fn().mockResolvedValue({}),
      },
      artifact: {
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const node = new GithubCommitNode(github as never, prisma as never);

    const result = await node.execute({
      projectId: 'project-1',
      runId: 'run-1',
      companyName: 'Acme',
      artifacts: [
        {
          agentType: 'frontend',
          filePath: 'src/app/page.tsx',
          content: 'export default function Page() { return <div />; }',
          language: 'tsx',
        },
        {
          agentType: 'architecture',
          filePath: 'ARCHITECTURE.md',
          content: '# Architecture',
          language: 'markdown',
        },
      ],
    } as DevFlowStateType);

    expect(result).toEqual({ repoUrl: 'https://github.com/acme/project-1.git' });
    expect(github.createRepo).toHaveBeenCalledWith('acme-project-1');
    expect(github.commitFiles).toHaveBeenCalledWith(
      'acme-project-1',
      [
        {
          filePath: 'src/app/page.tsx',
          content: 'export default function Page() { return <div />; }',
        },
        {
          filePath: 'ARCHITECTURE.md',
          content: '# Architecture',
        },
      ],
      'feat: initial scaffold by DevFlow [run:run-1]',
    );
    expect(github.injectCiWorkflow).toHaveBeenCalledWith('acme-project-1');
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: { repoUrl: 'https://github.com/acme/project-1.git' },
    });
  });
});

describe('LangGraph OpenRouter-backed agents', () => {
  it('RequirementsParserNode uses the shared graph LLM provider', async () => {
    const graphLlm = {
      generateJson: vi.fn().mockResolvedValue({
        value: {
          projectType: 'SaaS dashboard',
          features: ['Auth', 'Tasks', 'Reports'],
          techStack: {
            frontend: 'Next.js',
            backend: 'NestJS',
            database: 'PostgreSQL',
            styling: 'Tailwind CSS',
          },
          complexity: 'medium',
          estimatedFiles: 8,
        },
        model: 'openrouter-test-model',
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    };
    const prisma = {
      project: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const memory = {
      writeSkill: vi.fn().mockResolvedValue({}),
    };

    const node = new RequirementsParserNode(
      prisma as never,
      memory as never,
      graphLlm as unknown as GraphLlmProvider,
    );

    const result = await node.execute({
      projectId: 'project-1',
      runId: 'run-1',
      brief: 'Build a task dashboard.',
      stackKey: 'nextjs-nestjs-supabase',
      companyName: 'Acme',
    } as DevFlowStateType);

    expect(result.requirements?.projectType).toBe('SaaS dashboard');
    expect(result.complexity).toBe('medium');
    expect(graphLlm.generateJson).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'requirements_parser',
      expectedShape: 'object',
    }));
    expect(memory.writeSkill).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'requirements',
    }));
  });

  it('FrontendAgentNode generates artifacts through the shared graph LLM provider', async () => {
    const graphLlm = {
      generateJson: vi.fn().mockResolvedValue({
        value: [
          {
            filePath: 'src/app/page.tsx',
            content: 'export default function Page() { return <section><div>App</div></section>; }',
            language: 'tsx',
          },
        ],
        model: 'openrouter-test-model',
        usage: { inputTokens: 30, outputTokens: 40 },
      }),
    };
    const memory = {
      readRelevant: vi.fn().mockResolvedValue([]),
      formatAsContext: vi.fn().mockReturnValue(''),
      findSkipCandidate: vi.fn().mockResolvedValue(null),
    };
    const eventLog = {
      logStarted: vi.fn().mockResolvedValue({}),
      logCompleted: vi.fn().mockResolvedValue({}),
    };

    const node = new FrontendAgentNode(
      memory as never,
      eventLog as never,
      graphLlm as unknown as GraphLlmProvider,
    );
    const result = await node.execute({
      projectId: 'project-1',
      runId: 'run-1',
      brief: 'Build a dashboard.',
      stackKey: 'nextjs-nestjs-supabase',
      companyName: 'Acme',
      contract: {
        projectId: 'project-1',
        projectName: 'Acme Dashboard',
        description: 'Task dashboard',
        requirements: {
          projectType: 'SaaS dashboard',
          features: ['Auth'],
          techStack: {
            frontend: 'Next.js',
            backend: 'NestJS',
            database: 'PostgreSQL',
            styling: 'Tailwind CSS',
          },
          complexity: 'simple',
          estimatedFiles: 5,
        },
        fileManifest: ['src/app/page.tsx'],
        acceptanceCriteria: ['Renders dashboard'],
        lockedAt: new Date().toISOString(),
      },
      task: {
        id: 'task-1',
        title: 'Frontend task',
        description: 'Build UI',
        status: ProjectTaskStatus.TODO,
      },
      workOrder: {
        id: 'work-order-1',
        title: 'Frontend work',
        instructions: 'Build UI',
        agentType: 'FRONTEND',
        priority: WorkOrderPriority.NORMAL,
      },
    } as unknown as DevFlowStateType);

    expect(result.artifacts).toEqual(expect.arrayContaining([
      {
        agentType: 'frontend',
        filePath: 'src/app/page.tsx',
        content: 'export default function Page() { return <section><div>App</div></section>; }',
        language: 'tsx',
      },
    ]));
    expect(result.artifacts?.map((artifact) => artifact.filePath)).toEqual([
      'src/app/page.tsx',
      'src/app/layout.tsx',
      'src/components/ui/Button.tsx',
      'src/components/ui/Card.tsx',
      'src/styles/globals.css',
      'README-frontend.md',
    ]);
    expect(graphLlm.generateJson).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'frontend_agent',
      expectedShape: 'array',
    }));
    expect(eventLog.logCompleted).toHaveBeenCalledWith('project-1', 'frontend_agent', {
      inputTokens: 30,
      outputTokens: 40,
      model: 'openrouter-test-model',
    });
  });
});
