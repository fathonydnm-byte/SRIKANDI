import { handleAdminUsers } from '../../../server/adminUsers';
import type { FileEnv } from '../../../server/env';

export const onRequestPost = (ctx: { request: Request; env: FileEnv }): Promise<Response> =>
  handleAdminUsers(ctx.request, ctx.env, (input, init) => fetch(input, init));
