import { describe, expect, it } from "vitest";
import { ReviewComparisonSchema } from "../models/review-comparison.js";

describe("ReviewComparisonSchema", () => {
  it("accepts batched rename and binary metadata", () => {
    const result = ReviewComparisonSchema().parse({
      files: [
        {
          path: "src/new.ts",
          previousPath: "src/old.ts",
          changeType: "renamed",
          binary: false,
        },
        {
          path: "assets/logo.png",
          previousPath: null,
          changeType: "modified",
          binary: true,
        },
      ],
      additions: 4,
      deletions: 2,
    });

    expect(result.files).toHaveLength(2);
    expect(result.files[0]?.previousPath).toBe("src/old.ts");
    expect(result.files[1]?.binary).toBe(true);
  });
});
