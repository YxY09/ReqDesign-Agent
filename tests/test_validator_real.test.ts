import { describe, it, expect } from "vitest";
import { PostGenerationValidator } from "../src/tools/validator.js";
import { readFileSync } from "node:fs";

describe("Validator on real test-val3 output", () => {
  it("validates class diagram from live run", () => {
    const analysis = JSON.parse(readFileSync("outputs/test-val3/requirement/analysis.json", "utf8"));
    const diagrams = JSON.parse(readFileSync("outputs/test-val3/diagrams/diagrams.json", "utf8"));
    const diagContent = diagrams.diagrams || diagrams;
    
    const result = PostGenerationValidator.validate(analysis, "diagrams", diagContent);
    
    if (result) {
      const cleaned = result as any;
      const cd = cleaned.class_diagram;
      const classes = [...cd.matchAll(/class\s+(\w+)\s*\{/g)].map((m: any) => m[1]);
      const ents = (analysis.entities || []).map((e: any) => e.name);
      const extra = classes.filter((c: string) => !ents.includes(c));
      console.log("Analysis entities:", ents.join(", "));
      console.log("Original classes:", [...diagContent.class_diagram.matchAll(/class\s+(\w+)\s*\{/g)].map((m: any) => m[1]).join(", "));
      console.log("Cleaned classes:", classes.join(", "));
      console.log("Extra removed:", extra.join(", ") || "NONE");
      expect(extra.length).toBe(0);
    } else {
      console.log("Validator returned null — no changes needed");
    }
  });

  it("validates design from live run", () => {
    const analysis = JSON.parse(readFileSync("outputs/test-val3/requirement/analysis.json", "utf8"));
    const design = readFileSync("outputs/test-val3/design/system_design.md", "utf8");
    
    const result = PostGenerationValidator.validate(analysis, "design", design);
    
    if (result) {
      const cleaned = result as string;
      const ids = (analysis.functions || []).map((f: any) => f.id);
      const oldIds = new Set(design.match(/F\d{3}/g) || []);
      const newIds = new Set(cleaned.match(/F\d{3}/g) || []);
      const ghosts = [...oldIds].filter(id => !ids.includes(id));
      console.log("Ghost IDs in original:", ghosts.length);
      console.log("Ghost IDs after clean:", [...newIds].filter(id => !ids.includes(id)).length);
      expect([...newIds].every((id: string) => ids.includes(id))).toBe(true);
    } else {
      console.log("Validator returned null — no design changes needed");
      // Already clean — ghost IDs must already be 0
      const ids = (analysis.functions || []).map((f: any) => f.id);
      const ghosts = [...new Set(design.match(/F\d{3}/g) || [])].filter(id => !ids.includes(id));
      expect(ghosts.length).toBe(0);
    }
  });
});
