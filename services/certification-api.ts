import { ofetch } from 'ofetch';
import { liveEvidence } from './review-batch';
import type { ApprovalProject, ProjectFilters } from '~/types/certification';
import { mockFetch } from './mock-fetch';

const client = ofetch.create(
  {
    baseURL: '/api',
    retry: 0
  },
  {
    fetch: mockFetch as typeof fetch
  }
);

function matches(project: ApprovalProject, filters: ProjectFilters) {
  const query = filters.query.trim().toLowerCase();
  const effectiveEvidence = liveEvidence(project);
  const matchesQuery =
    !query ||
    [project.id, project.name, project.modelCode, project.configuration, project.softwareVersion]
      .join(' ')
      .toLowerCase()
      .includes(query);
  const matchesStatus = filters.status === 'all' || project.status === filters.status;
  const matchesAgency = filters.agency === 'all' || project.agency === filters.agency;
  const matchesRisk =
    filters.risk === 'all' ||
    (filters.risk === 'expiring' && new Date(project.certificateExpiry) <= new Date('2026-12-31')) ||
    (filters.risk === 'missing' &&
      project.regulations.some((item) => item.status === 'missing' || item.status === 'conflict')) ||
    (filters.risk === 'version_conflict' &&
      effectiveEvidence.some(
        (item) => item.softwareVersion !== project.softwareVersion || item.pendingReview || item.invalidated
      ));

  return matchesQuery && matchesStatus && matchesAgency && matchesRisk;
}

export const certificationApi = {
  async listProjects(filters: ProjectFilters) {
    const projects = await client<ApprovalProject[]>('/projects');
    return projects.filter((project) => matches(project, filters));
  },

  async getProject(id: string) {
    return client<ApprovalProject>(`/projects/${encodeURIComponent(id)}`);
  }
};
