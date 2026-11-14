import { handleUploadChunk } from '../../../server/uploadHandler';
import type { FileEnv } from '../../../server/env';

export const onRequestPut = (ctx: { request: Request; env: FileEnv }): Promise<Response> =>
  handleUploadChunk(ctx.request, ctx.env, (input, init) => fetch(input, init));
