export const meta = { secrets: ["WALLET_ADDRESS"], kv_access: "none", timeout_ms: 10000 };

export async function execute({ secrets, fetch }) {
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const wallet = secrets.WALLET_ADDRESS;
  const data = "0x70a08231" + wallet.slice(2).padStart(64, "0");
  const resp = await fetch("https://mainnet.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "eth_call",
      params: [{ to: usdc, data }, "latest"]
    })
  });
  const result = await resp.json();
  const raw = parseInt(result.result, 16);
  return { balance_usdc: raw / 1e6, raw_hex: result.result };
}
