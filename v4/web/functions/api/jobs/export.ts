import type { FileEnv } from '../../../server/env';
import { handleJobsExport } from '../../../server/jobsExport';

// onRequest (bukan hanya onRequestPost): metode lain mendapat JSON 405, bukan halaman SPA.
export const onRequest = (ctx: { request: Request; env: FileEnv }): Promise<Response> =>
  handleJobsExport(ctx.request, ctx.env, (input, init) => fetch(input, init));
