import { invoke } from "@tauri-apps/api/core";
import type { TrafficSnapshot } from "./types";

export async function getTraffic(): Promise<TrafficSnapshot> {
  return invoke("get_traffic");
}
