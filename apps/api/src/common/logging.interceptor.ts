import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { type Observable, tap } from "rxjs";

/** Logs every request with method, path and latency (structured-log foundation, the engineering design notes). */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ method: string; url: string }>();
    const { method, url } = req;
    const start = Date.now();
    return next.handle().pipe(tap(() => this.logger.log(`${method} ${url} ${Date.now() - start}ms`)));
  }
}
