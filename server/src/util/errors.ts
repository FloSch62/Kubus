import { ApiException } from '@kubernetes/client-node';
import type { FastifyReply } from 'fastify';
import type { ApiErrorBody } from '@kubus/shared';

export class HttpProblem extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public reason?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

interface K8sStatusBody {
  message?: string;
  reason?: string;
  code?: number;
  [key: string]: unknown;
}

function parseK8sBody(body: unknown): K8sStatusBody | undefined {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as K8sStatusBody;
    } catch {
      return { message: body };
    }
  }
  if (body && typeof body === 'object') return body as K8sStatusBody;
  return undefined;
}

/** Map any thrown error to a consistent problem JSON response. */
export function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof HttpProblem) {
    const body: ApiErrorBody = { message: err.message, reason: err.reason, code: err.statusCode, details: err.details };
    void reply.code(err.statusCode).send(body);
    return;
  }
  if (err instanceof ApiException) {
    const status = parseK8sBody(err.body);
    const code = err.code >= 100 && err.code < 600 ? err.code : 500;
    const body: ApiErrorBody = {
      message: status?.message ?? err.message,
      reason: status?.reason,
      code,
      k8sStatus: status,
    };
    void reply.code(code).send(body);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const body: ApiErrorBody = { message, code: 500 };
  void reply.code(500).send(body);
}
