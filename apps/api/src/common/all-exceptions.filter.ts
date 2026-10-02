import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";

/** Catches all errors, logs them, and returns a consistent JSON shape (never leak stack traces). */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Exception");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      exception instanceof HttpException ? exception.getResponse() : "Internal server error";
    this.logger.error(`${status} ${exception instanceof Error ? exception.message : String(exception)}`);
    res.status(status).json({ statusCode: status, error: message, timestamp: new Date().toISOString() });
  }
}
