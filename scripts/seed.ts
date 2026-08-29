/**
 * Create the two local test merchants from .env.
 *
 * A real merchant onboards through the UI; this exists so local development
 * has Mandate and Swaseekh to work against without filling the form twice.
 *
 *   npm run seed
 */
import { createMerchant, listMerchants, toPublic } from "../src/lib/merchants";
import { PUBLIC_URL, optionalEnv } from "../src/lib/env";

interface Seed {
  name: string;
  keyIdVar: string;
  keySecretVar: string;
  whatsapp?: string | null;
}

const SEEDS: Seed[] = [
  {
    name: "Mandate",
    keyIdVar: "MANDATE_RAZORPAY_KEY_ID",
    keySecretVar: "MANDATE_RAZORPAY_KEY_SECRET",
  },
  {
    name: "Swaseekh",
    keyIdVar: "SWASEEKH_RAZORPAY_KEY_ID",
    keySecretVar: "SWASEEKH_RAZORPAY_KEY_SECRET",
  },
];

async function main() {
  const existing = await listMerchants();

  for (const seed of SEEDS) {
    if (existing.some((m) => m.business_name === seed.name)) {
      console.log(`- ${seed.name}: already connected, skipping`);
      continue;
    }

    const keyId = optionalEnv(seed.keyIdVar);
    const keySecret = optionalEnv(seed.keySecretVar);
    if (!keyId || !keySecret) {
      console.log(
        `- ${seed.name}: skipped (set ${seed.keyIdVar} and ${seed.keySecretVar} in .env)`,
      );
      continue;
    }

    const { merchant, webhook_secret } = await createMerchant({
      business_name: seed.name,
      razorpay_key_id: keyId,
      razorpay_key_secret: keySecret,
      whatsapp_number: seed.whatsapp ?? null,
      channels_enabled: ["email", "whatsapp"],
    });

    const pub = toPublic(merchant, PUBLIC_URL());
    console.log(`+ ${seed.name} connected`);
    console.log(`    dashboard      ${PUBLIC_URL()}/dashboard/${merchant.id}`);
    console.log(`    webhook url    ${pub.webhook_url}`);
    console.log(`    webhook secret ${webhook_secret}`);
  }
}

main().catch((err) => {
  console.error("Seed failed:", err.message ?? err);
  process.exit(1);
});
