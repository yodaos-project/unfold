import { UnfoldError } from './errors.js';

export interface RequestContext {
  request: Request;
  user: string;
  signal: AbortSignal;
}

export type Authenticate = (
  request: Request,
) => string | undefined | Promise<string | undefined>;

export async function requestContext(
  authenticate: Authenticate,
  request: Request,
): Promise<RequestContext> {
  const user = await authenticate(request);
  if (!user)
    throw new UnfoldError(401, 'unauthenticated', 'Authentication required');
  return { request, user, signal: request.signal };
}
