export class UnfoldError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnfoldError';
  }
}

export class TaskInputError extends UnfoldError {
  constructor(code: string, message: string) {
    super(422, code, message);
    this.name = 'TaskInputError';
  }
}

export function errorResponse(error: unknown): Response {
  if (!(error instanceof UnfoldError)) throw error;
  return Response.json(
    { code: error.code, message: error.message },
    { status: error.status, headers: { 'Cache-Control': 'no-store' } },
  );
}
