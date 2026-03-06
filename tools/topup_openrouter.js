export const meta = { secrets: ["OPENROUTER_API_KEY", "WALLET_PRIVATE_KEY", "WALLET_ADDRESS"], kv_access: "none", timeout_ms: 30000 };

export async function execute({ amount, secrets, fetch }) {
  return {
    ok: false,
    error: "On-chain signing not yet implemented",
    amount_requested: amount
  };
}
