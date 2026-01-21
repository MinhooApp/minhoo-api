// src/libs/networkMonitor.ts
import axios from "axios";

let isOnline = true;

// Verifica conectividad haciendo ping a tu API cada cierto tiempo
export const monitorNetwork = (intervalMs = 10000) => {
  console.log("🌐 Iniciando monitor de conexión...");

  setInterval(async () => {
    try {
      await axios.get("https://api.minhoo.xyz/ping", { timeout: 3000 });
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
