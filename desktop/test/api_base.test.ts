import assert from "node:assert/strict";
import test from "node:test";

import { apiUrl } from "../src/verticals/finance/lib/api-base.ts";

test("API 地址兼容根路径与生产子路径", () => {
  assert.equal(apiUrl("/product", "/"), "/api/product");
  assert.equal(apiUrl("/product", "/vibe-research/"), "/vibe-research/api/product");
  assert.equal(apiUrl("health", "vibe-research"), "/vibe-research/api/health");
});
