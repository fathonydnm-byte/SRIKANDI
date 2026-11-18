import type { FileEnv } from '../../../server/env';
import { handleJraLookup } from '../../../server/jraLookup';

export const onRequest = (ctx: { request: Request; env: FileEnv }): Promise<Response> =>
  handleJraLookup(ctx.request, ctx.env, (url, init) => fetch(url, init));
