import { EventEmitter } from 'events';
import { ScrapeResult } from './types';

export type JobStatus = 'pending' | 'running' | 'done' | 'error';

export interface Job {
  id: string;
  url: string;
  sheetName?: string;
  noSheets: boolean;
  status: JobStatus;
  platform?: string;
  result?: ScrapeResult;
  error?: string;
  logs: string[];
  createdAt: string;
  completedAt?: string;
  leadCount?: number;
}

class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();

  create(url: string, opts: { sheetName?: string; noSheets?: boolean }): Job {
    const id = crypto.randomUUID();
    const job: Job = {
      id,
      url,
      sheetName: opts.sheetName,
      noSheets: opts.noSheets ?? false,
      status: 'pending',
      logs: [],
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getAll(): Job[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  log(id: string, message: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.logs.push(`[${new Date().toISOString()}] ${message}`);
    this.emit(`log:${id}`, message);
  }

  update(id: string, updates: Partial<Job>) {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, updates);
    this.emit(`update:${id}`, job);
  }
}

export const jobManager = new JobManager();
