import { handleUploadComplete } from '../../../server/uploadHandler';
import type { FileEnv } from '../../../server/env';

export const onRequestPost = (ctx: { request: Request; env: FileEnv }): Promise<Response> =>
  handleUploadComplete(ctx.request, ctx.env, (input, init) => fetch(input, init));
