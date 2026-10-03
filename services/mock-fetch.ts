import { seedProjects } from '~/data/seed';
import { createInitialDocument } from './review-batch';
import { readDocument } from './batch-storage';
import type { ApprovalProject } from '~/types/certification';

/**
 * 模拟接口只认当前唯一有效批次：
 * 即使恢复区暂存了待重试批次，列表/详情也读取同一份有效数据。
 */
function currentProjects(): ApprovalProject[] {
  if (typeof localStorage === 'undefined') return structuredClone(seedProjects);
  const read = readDocument();
  const active = read.document.batches.find((batch) => batch.meta.status === 'active');
  return structuredClone(active ? active.projects : createInitialDocument(seedProjects).batches[0]!.projects);
}

export const mockFetch: typeof fetch = async (input) => {
  const source = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(source, 'http://local.test');
  await new Promise((resolve) => setTimeout(resolve, 70));

  const send = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        'content-type': 'application/json'
      }
    });

  if (url.pathname === '/api/projects') {
    return send(currentProjects());
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (match) {
    const project = currentProjects().find((item) => item.id === decodeURIComponent(match[1]!));
    return project ? send(project) : send({ message: '项目不存在' }, 404);
  }

  return send({ message: '未实现的模拟接口' }, 404);
};
