import { handleDownload } from '../../../server/downloadHandler';
import type { FileEnv } from '../../../server/env';

export const onRequestGet = (ctx: { request: Request; env: FileEnv }): Promise<Response> =>
  handleDownload(ctx.request, ctx.env, (input, init) => fetch(input, init));
