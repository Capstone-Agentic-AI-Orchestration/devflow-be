import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GithubService } from '../src/github/github.service';

function makeConfig(values: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('GithubService', () => {
  it('reports missing GitHub delivery requirements', () => {
    const service = new GithubService(makeConfig({}));
    service.onModuleInit();

    expect(service.getDeliveryStatus()).toEqual({
      configured: false,
      available: false,
      owner: null,
      ownerSource: null,
      missingRequirements: [
        'GITHUB_APP_ID',
        'GITHUB_PRIVATE_KEY',
        'GITHUB_INSTALLATION_ID',
        'GITHUB_ORG',
      ],
      reason: 'GitHub delivery requires GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_INSTALLATION_ID, GITHUB_ORG.',
    });
  });

  it('uses explicit GITHUB_ORG as the repository owner', async () => {
    const service = new GithubService(makeConfig({
      'github.appId': '12345',
      'github.privateKey': '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      'github.installationId': 67890,
      'github.org': 'capstone-org',
    }));
    service.onModuleInit();
    const octokit = {
      repos: {
        createInOrg: vi.fn().mockResolvedValue({
          data: { clone_url: 'https://github.com/capstone-org/acme-project.git' },
        }),
      },
    };
    Object.assign(service as unknown as { octokit: unknown }, { octokit });

    const repoUrl = await service.createRepo('acme-project');

    expect(repoUrl).toBe('https://github.com/capstone-org/acme-project.git');
    expect(octokit.repos.createInOrg).toHaveBeenCalledWith({
      org: 'capstone-org',
      name: 'acme-project',
      private: true,
      auto_init: true,
      description: 'Scaffolded by DevFlow',
    });
    expect(service.getDeliveryStatus()).toEqual(expect.objectContaining({
      configured: true,
      available: true,
      owner: 'capstone-org',
      ownerSource: 'env',
      missingRequirements: [],
      reason: null,
    }));
  });

  it('commits files by creating blobs, a tree, a commit, and updating main', async () => {
    const service = new GithubService(makeConfig({
      'github.appId': '12345',
      'github.privateKey': '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      'github.installationId': 67890,
      'github.org': 'capstone-org',
    }));
    service.onModuleInit();
    const octokit = {
      git: {
        getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'latest-sha' } } }),
        getCommit: vi.fn().mockResolvedValue({ data: { tree: { sha: 'base-tree-sha' } } }),
        createBlob: vi
          .fn()
          .mockResolvedValueOnce({ data: { sha: 'blob-1' } })
          .mockResolvedValueOnce({ data: { sha: 'blob-2' } }),
        createTree: vi.fn().mockResolvedValue({ data: { sha: 'new-tree-sha' } }),
        createCommit: vi.fn().mockResolvedValue({ data: { sha: 'new-commit-sha' } }),
        updateRef: vi.fn().mockResolvedValue({}),
      },
    };
    Object.assign(service as unknown as { octokit: unknown }, { octokit });

    await service.commitFiles(
      'acme-project',
      [
        { filePath: 'README.md', content: '# Acme' },
        { filePath: 'src/index.ts', content: 'export const ok = true;' },
      ],
      'feat: initial scaffold',
    );

    expect(octokit.git.createTree).toHaveBeenCalledWith({
      owner: 'capstone-org',
      repo: 'acme-project',
      base_tree: 'base-tree-sha',
      tree: [
        { path: 'README.md', mode: '100644', type: 'blob', sha: 'blob-1' },
        { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'blob-2' },
      ],
    });
    expect(octokit.git.updateRef).toHaveBeenCalledWith({
      owner: 'capstone-org',
      repo: 'acme-project',
      ref: 'heads/main',
      sha: 'new-commit-sha',
    });
  });

  it('fails predictably when commit automation is not configured', async () => {
    const service = new GithubService(makeConfig({}));
    service.onModuleInit();

    await expect(service.createRepo('missing-config')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
