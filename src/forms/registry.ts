import type { FormDefinition } from "../lib/types.js";

// Add imports here as new forms are registered:
// import form1 from './1FAIpQLSabc123.json' with { type: 'json' };
import aiReadinessSelfCheck from "./1FAIpQLSdT6je0hJmpQLbEKUa4Bm4-skYEg64DNmGhJtLpDE2wjAxGKQ.json" with { type: "json" };

const registry = new Map<string, FormDefinition>([
  // Add entries here:
  [
    "1FAIpQLSdT6je0hJmpQLbEKUa4Bm4-skYEg64DNmGhJtLpDE2wjAxGKQ",
    aiReadinessSelfCheck as FormDefinition,
  ],
]);

export default registry;
