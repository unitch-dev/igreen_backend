import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiResponse,
  ApiOperation,
  ApiBearerAuth,
  ApiExtraModels,
  getSchemaPath,
  ApiOperationOptions,
} from '@nestjs/swagger';

// ─── Standard error schema ─────────────────────────────────────────────────────
// Mirrors `createFailureResponse()` in `common/interfaces/service-response.interface.ts`,
// which backs every error response emitted by `HttpExceptionFilter`.

export class ErrorResponseDto {
  success: boolean;
  message: string;
  error: Record<string, unknown>;
  errorType: string;
  httpCode: number;
}

// ─── Success wrapper schema ───────────────────────────────────────────────────
// Mirrors `createSuccessResponse()` / `ServiceResponse<T>`, which backs every
// success response emitted by `TransformInterceptor`.

export class SuccessResponseDto<T> {
  success: boolean;
  message: string;
  data: T;
  errorType: string;
  httpCode: number;
}

// ─── Paginated wrapper schema ─────────────────────────────────────────────────

export class PaginatedResponseDto<T> {
  success: boolean;
  message: string;
  data: {
    data: T[];
    meta: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  };
  errorType: string;
  httpCode: number;
}

// ─── Reusable decorator: wraps a DTO in the standard success envelope ─────────

export function ApiSuccessResponse<T extends Type<unknown>>(
  model: T,
  description = 'Success',
  status = 200,
  isArray = false,
) {
  return applyDecorators(
    ApiExtraModels(SuccessResponseDto, model),
    ApiResponse({
      status,
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(SuccessResponseDto) },
          {
            properties: {
              data: isArray
                ? { type: 'array', items: { $ref: getSchemaPath(model) } }
                : { $ref: getSchemaPath(model) },
            },
          },
        ],
      },
    }),
  );
}

// ─── Reusable decorator: paginated list response ──────────────────────────────

export function ApiPaginatedResponse<T extends Type<unknown>>(
  model: T,
  description = 'Paginated list',
) {
  return applyDecorators(
    ApiExtraModels(PaginatedResponseDto, model),
    ApiResponse({
      status: 200,
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(PaginatedResponseDto) },
          {
            properties: {
              data: {
                properties: {
                  data: { type: 'array', items: { $ref: getSchemaPath(model) } },
                  meta: {
                    properties: {
                      total: { type: 'number', example: 100 },
                      page: { type: 'number', example: 1 },
                      limit: { type: 'number', example: 20 },
                      totalPages: { type: 'number', example: 5 },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    }),
  );
}

// ─── Common error responses applied to every secured endpoint ─────────────────

export function ApiCommonErrorResponses() {
  return applyDecorators(
    ApiResponse({
      status: 400,
      description: 'Bad Request — Validation failed or missing required fields',
      schema: {
        example: {
          success: false,
          message: 'Validation failed: email must be a valid email address',
          error: {
            message: ['email must be a valid email address'],
            statusCode: 400,
            path: '/api/v1/example',
            method: 'POST',
          },
          errorType: 'HTTP_400',
          httpCode: 400,
        },
      },
    }),
    ApiResponse({
      status: 401,
      description: 'Unauthorized — Invalid or expired token',
      schema: {
        example: {
          success: false,
          message: 'Invalid or expired token',
          error: {
            message: 'Invalid or expired token',
            statusCode: 401,
            path: '/api/v1/example',
            method: 'GET',
          },
          errorType: 'HTTP_401',
          httpCode: 401,
        },
      },
    }),
    ApiResponse({
      status: 403,
      description: 'Forbidden — Insufficient permissions',
      schema: {
        example: {
          success: false,
          message: 'Missing required permissions: payroll:run',
          error: {
            message: 'Missing required permissions: payroll:run',
            statusCode: 403,
            path: '/api/v1/example',
            method: 'GET',
          },
          errorType: 'HTTP_403',
          httpCode: 403,
        },
      },
    }),
    ApiResponse({
      status: 404,
      description: 'Not Found — Resource does not exist for this organization',
      schema: {
        example: {
          success: false,
          message: 'Resource not found',
          error: {
            message: 'Resource not found',
            statusCode: 404,
            path: '/api/v1/example/123',
            method: 'GET',
          },
          errorType: 'HTTP_404',
          httpCode: 404,
        },
      },
    }),
    ApiResponse({
      status: 409,
      description: 'Conflict — Resource already exists or is in an incompatible state',
      schema: {
        example: {
          success: false,
          message: 'A payroll run for 7/2026 already exists for this organization',
          error: {
            message: 'A payroll run for 7/2026 already exists for this organization',
            statusCode: 409,
            path: '/api/v1/example',
            method: 'POST',
          },
          errorType: 'HTTP_409',
          httpCode: 409,
        },
      },
    }),
    ApiResponse({
      status: 500,
      description: 'Internal Server Error',
      schema: {
        example: {
          success: false,
          message: 'Internal server error',
          error: {
            message: 'Internal server error',
            statusCode: 500,
            path: '/api/v1/example',
            method: 'GET',
          },
          errorType: 'HTTP_500',
          httpCode: 500,
        },
      },
    }),
  );
}

// ─── Convenience: @ApiDoc bundles operation + auth + common errors ─────────────

export function ApiDoc(options: ApiOperationOptions & { auth?: boolean }) {
  const { auth = true, ...operationOptions } = options;
  const decorators = [ApiOperation(operationOptions), ApiCommonErrorResponses()];
  if (auth) decorators.push(ApiBearerAuth());
  return applyDecorators(...decorators);
}
