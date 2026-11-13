import { handleUploadSession } from '../../../server/uploadHandler';
import type { FileEnv } from '../../../server/env';

export const onRequestPost = (ctx: { request: Request; env: FileEnv }): Promise<Response> =>
  handleUploadSession(ctx.request, ctx.env, (input, init) => fetch(input, init));
