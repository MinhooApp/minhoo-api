// src/libs/networkMonitor.ts
import axios from "axios";

let isOnline = true;
const isTruthy = (value: any) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

// Verifica conectividad haciendo ping a tu API cada cierto tiempo
export const monitorNetwork = (intervalMs = 10000) => {
  if (!isTruthy(process.env.ENABLE_SELF_PING_MONITOR)) {
    console.log("🌐 Monitor de conexión desactivado");
    return;
  }

  console.log("🌐 Iniciando monitor de conexión...");

  setInterval(async () => {
    try {
      await axios.get("https://api.minhoo.xyz/api/v1/ping", { timeout: 3000 });
      if (!isOnline) {
        console.log("✅ Conexión restaurada");
        isOnline = true;
      }
    } catch {
      if (isOnline) {
        console.log("⚠️  Conexión perdida, activando modo offline");
        isOnline = false;
      }
    }
  }, intervalMs);
};

// Devuelve el estado actual
export const getNetworkStatus = () => isOnline;
