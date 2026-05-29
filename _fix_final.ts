import * as fs from "fs";
let lines = fs.readFileSync("src/shared/constraintCanonicalizer.ts", "utf8").split(/\r?\n/);

// Find indices
let dataStart = -1, dataEnd = -1, availEnd = -1, arrayEnd = -1;
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i].trim();
  if (ln.includes("data integrity|data validation|data accuracy")) {
    dataStart = i - 1; // the "{" line before regex
  }
  if (dataStart !== -1 && dataEnd === -1 && ln === "  }," && i > dataStart + 2) {
    dataEnd = i;
  }
  if (ln === "  }," && lines[i].trim() === "  },") {
    // Check if next line is "];" - that would be availability end
  }
  if (ln === "];" && arrayEnd === -1) {
    arrayEnd = i;
    // avail end is one line before
    availEnd = i - 1;
  }
}

console.log("dataStart:", dataStart, "dataEnd:", dataEnd, "availEnd:", availEnd, "arrayEnd:", arrayEnd);

if (dataStart === -1 || dataEnd === -1 || availEnd === -1) {
  console.log("Could not find all markers");
  process.exit(1);
}

// Extract the data block
const dataBlockLines = lines.slice(dataStart, dataEnd + 1);
console.log("Data block:", dataBlockLines.join("\n"));

// Remove data block
lines.splice(dataStart, dataEnd - dataStart + 1);

// Recalculate availEnd after splice
// The lines have shifted. Find availability end again
availEnd = -1;
arrayEnd = -1;
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i].trim();
  if (ln === "];" && arrayEnd === -1) {
    arrayEnd = i;
    availEnd = i - 1;
  }
}

console.log("After splice - availEnd:", availEnd, "arrayEnd:", arrayEnd);

// Insert data block after availability (before "];")
lines.splice(arrayEnd, 0, ...dataBlockLines);

fs.writeFileSync("src/shared/constraintCanonicalizer.ts", lines.join("\n") + "\n");
console.log("Bug 2 fix applied");
