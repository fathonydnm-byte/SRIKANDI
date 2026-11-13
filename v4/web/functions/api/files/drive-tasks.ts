import { handleDriveTasks } from '../../../server/driveTasks';
import type { FileEnv } from '../../../server/env';

export const onRequestPost = (ctx: { request: Request; env: FileEnv }): Promise<Response> =>
  handleDriveTasks(ctx.request, ctx.env, (input, init) => fetch(input, init));
