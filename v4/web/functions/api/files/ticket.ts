import { handleTicket } from '../../../server/ticketHandler';
import type { FileEnv } from '../../../server/env';

export const onRequestPost = (ctx: { request: Request; env: FileEnv }): Promise<Response> =>
  handleTicket(ctx.request, ctx.env, (input, init) => fetch(input, init));
