import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { LabAuditsService } from '../src/lab-audits/lab-audits.service.js';

const encryptionKey = Buffer.alloc(32, 9).toString('base64url');

function createService(query: ReturnType<typeof vi.fn>) {
  const projects = {
    requireAccess: vi.fn().mockResolvedValue({ id: 'project-1', role: 'owner', enabled: true }),
    requireOwner: vi.fn().mockResolvedValue({ id: 'project-1', role: 'owner', enabled: true }),
  };
  const service = new LabAuditsService(
    { pool: { query } } as never,
    { AUDIT_HEADER_ENCRYPTION_KEY: encryptionKey } as never,
    projects as never,
  );
  return { service, projects };
}

describe('LabAuditsService', () => {
  it('rejects a URL outside project allowed origins', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ origin: 'https://allowed.example' }] });
    const { service } = createService(query);
    await expect(service.create('user-1', 'project-1', 'https://other.example/page', 'mobile'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps the active-task unique constraint to a stable conflict', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ origin: 'https://allowed.example' }] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    const { service } = createService(query);
    await expect(service.create('user-1', 'project-1', 'https://allowed.example/page', 'desktop'))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects dangerous fixed request headers before storing them', async () => {
    const query = vi.fn();
    const { service } = createService(query);
    await expect(service.updateSettings('user-1', 'project-1', [{ name: 'Host', value: 'internal' }]))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not return a report from another project', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const { service } = createService(query);
    await expect(service.detail('user-1', 'project-1', 'audit-other'))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
