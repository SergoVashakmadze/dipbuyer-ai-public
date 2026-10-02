import { Global, Module } from "@nestjs/common";
import { fileURLToPath } from "node:url";
import { INVESTOR_STORE, InvestorStore } from "./investor.store.js";

/** apps/api/.data/investors.json unless INVESTOR_STORE_PATH is set. Gitignored. */
const defaultPath = () => fileURLToPath(new URL("../../.data/investors.json", import.meta.url));

@Global()
@Module({
  providers: [{ provide: INVESTOR_STORE, useFactory: () => new InvestorStore(process.env.INVESTOR_STORE_PATH || defaultPath()) }],
  exports: [INVESTOR_STORE],
})
export class InvestorsModule {}
