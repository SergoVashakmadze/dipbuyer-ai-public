// One-off: generate the ed25519 proof keypair and print env lines to add to .env.
import { generateKeypair } from "./proof.js";
const { privateKey, publicKey } = generateKeypair();
console.log("PROOF_PRIVATE_KEY=" + privateKey);
console.log("PROOF_PUBLIC_KEY=" + publicKey);
console.log("\n# Add the private key to .env (gitignored). The public key is safe to publish.");
