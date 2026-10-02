import "reflect-metadata";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { LoggingInterceptor } from "./common/logging.interceptor.js";
import { AllExceptionsFilter } from "./common/all-exceptions.filter.js";

// Load the workspace-root .env for local/dev runs so keys (LLM, financialdatasets, Algorand) are
// available. In production the host/orchestrator supplies real env vars. Best-effort — runs before
// bootstrap() (and thus before Nest instantiates env-reading providers like DecisionService), and
// never fails boot if the file is absent.
try {
  const envPath = process.env.DOTENV_CONFIG_PATH ?? fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
} catch {
  /* env comes from the host */
}

/**
 * DipBuyer AI API bootstrap. Phase-0 shell: health + decision endpoints wired to the agent
 * DecisionService. Auth0 guards, KYC/suitability gating, orders, backtest and audit-anchoring
 * modules are added in later phases (see apps/api/README.md).
 */
async function bootstrap() {
  // rawBody: webhook signatures (Persona) are computed over the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors();
  app.setGlobalPrefix("api");
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`DipBuyer AI API listening on :${port}/api`);
}

void bootstrap();
