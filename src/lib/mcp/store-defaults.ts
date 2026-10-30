/**
 * Client-safe defaults for the onboarding form. Kept apart from store.ts,
 * which pulls in node:crypto and so cannot be bundled into a page.
 */
export interface StoreConfig {
  base_url: string;
  products_path: string;
  product_path: string; // contains :id
  orders_path: string;
  order_status_path: string; // contains :id
}

/** Pre-filled in the onboarding form; the merchant can edit any of it. */
export const DEFAULT_STORE_CONFIG: StoreConfig = {
  base_url: "https://mandate-theta-two.vercel.app",
  products_path: "/api/products",
  product_path: "/api/products/:id",
  orders_path: "/api/orders",
  order_status_path: "/api/orders/:id",
};
