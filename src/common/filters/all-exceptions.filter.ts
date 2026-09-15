import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  RefreshTokenReuseError,
} from '../../auth/exceptions/auth.exceptions';
import {
  AccountNotFoundError,
  InsufficientFundsError,
  UnbalancedTransactionError,
} from '../../ledger/exceptions/ledger.exceptions';
import {
  BetAlreadySettledError,
  CashOutTooLateError,
  DuplicateBetError,
  NoActiveRoundError,
  NoBetOnRoundError,
  RoundNotFlyingError,
  RoundNotFoundError,
  RoundNotOpenError,
  StakeOutOfRangeError,
} from '../../rounds/exceptions/rounds.exceptions';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  path: string;
  timestamp: string;
}

/**
 * Maps domain errors onto HTTP without letting services import HTTP concerns.
 *
 * Services throw errors that describe what went wrong in the language of the
 * ledger; this is the single place that decides what that means over HTTP. Any
 * error not listed here becomes a bare 500 with its detail logged and *not*
 * returned — an unhandled error is by definition one whose message has not been
 * reviewed for what it leaks.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, error, message } = this.classify(exception);

    if (status >= Number(HttpStatus.INTERNAL_SERVER_ERROR)) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorBody = {
      statusCode: status,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }

  private classify(exception: unknown): { status: number; error: string; message: string } {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string | string[] }).message ?? exception.message);

      return {
        status: exception.getStatus(),
        error: exception.name,
        message: Array.isArray(message) ? message.join('; ') : message,
      };
    }

    if (exception instanceof InsufficientFundsError) {
      return { status: HttpStatus.CONFLICT, error: exception.name, message: exception.message };
    }

    if (exception instanceof EmailAlreadyRegisteredError) {
      return { status: HttpStatus.CONFLICT, error: exception.name, message: exception.message };
    }

    if (exception instanceof InvalidCredentialsError) {
      return { status: HttpStatus.UNAUTHORIZED, error: exception.name, message: exception.message };
    }

    // Reuse is 401 rather than 403: the credential is now worthless and the
    // client's correct next move is to authenticate again, which is exactly what
    // 401 tells it.
    if (exception instanceof RefreshTokenReuseError) {
      return { status: HttpStatus.UNAUTHORIZED, error: exception.name, message: exception.message };
    }

    if (exception instanceof InvalidRefreshTokenError) {
      return { status: HttpStatus.UNAUTHORIZED, error: exception.name, message: exception.message };
    }

    if (exception instanceof AccountNotFoundError) {
      return { status: HttpStatus.NOT_FOUND, error: exception.name, message: exception.message };
    }

    // Round and bet errors.
    //
    // All of these describe a client asking for something the current state does
    // not allow — a late cash-out, a bet after the window closed. That is a 404
    // or a 409, never a 500. Left unmapped they fall through to "an unexpected
    // error occurred", which tells the client nothing and makes a perfectly
    // correct refusal look like a broken server.
    if (
      exception instanceof NoActiveRoundError ||
      exception instanceof RoundNotFoundError ||
      exception instanceof NoBetOnRoundError
    ) {
      return { status: HttpStatus.NOT_FOUND, error: exception.name, message: exception.message };
    }

    if (
      exception instanceof RoundNotOpenError ||
      exception instanceof RoundNotFlyingError ||
      exception instanceof CashOutTooLateError ||
      exception instanceof BetAlreadySettledError ||
      exception instanceof DuplicateBetError
    ) {
      return { status: HttpStatus.CONFLICT, error: exception.name, message: exception.message };
    }

    if (exception instanceof StakeOutOfRangeError) {
      return { status: HttpStatus.BAD_REQUEST, error: exception.name, message: exception.message };
    }

    // An unbalanced transaction reaching this layer means a bug in the calling
    // service, not bad input. Surface it as a 500 and log loudly.
    if (exception instanceof UnbalancedTransactionError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'LedgerIntegrityError',
        message: 'The request could not be completed',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'InternalServerError',
      message: 'An unexpected error occurred',
    };
  }
}
