import { config } from "./config.js";

// PAT-only auth — OAuth removed to avoid cross-project token leakage

export function getActiveToken(): string | null {
  if (config.ghPat) return config.ghPat;
  return null;
}

export function getAuthStatus(): {
  method: "pat" | "none";
} {
  return { method: config.ghPat ? "pat" : "none" };
}
