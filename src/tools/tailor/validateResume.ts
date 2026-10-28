// Mechanical post-generation validator.
// No LLM — pure string comparison against main_resume.md.

export type ValidationResult = {
  passed: boolean;
  violations: string[];
};

// Opening text of each fixed bullet (rules.md: COPILOT-1, COPILOT-2, INFRA-1, INFRA-4).
// Long enough to be unique; short enough to survive minor whitespace variation.
const FIXED_BULLET_ANCHORS = [
  "Took 310 Copilot from concept to production",       // COPILOT-1
  "Deployed **14 computational-biology models**",       // COPILOT-2
  "Owned infrastructure for **three ML training",      // INFRA-1
  "Progressed to become the primary engineer",          // INFRA-4
];

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Returns the full normalized bullet line from source that contains the anchor, or null. */
function extractBulletByAnchor(source: string, anchor: string): string | null {
  const line = source.split("\n").find((l) => l.includes(anchor));
  return line ? normalize(line) : null;
}

/** Extracts the body of a ## Section (text between heading and next ##). */
function extractSection(markdown: string, heading: string): string | null {
  const re = new RegExp(`## ${heading}\\r?\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = markdown.match(re);
  return match ? normalize(match[1]!) : null;
}

/** Returns all **bold text containing a digit** from a single line of markdown. */
function extractBoldMetrics(markdown: string): string[] {
  // [^\n*] prevents crossing line boundaries — avoids matching huge multi-line blocks.
  const matches = markdown.match(/\*\*[^\n*]*\d[^\n*]*\*\*/g) ?? [];
  return [...new Set(matches)];
}

export const validateResume = (output: string, mainResume: string): ValidationResult => {
  const violations: string[] = [];
  const normOutput = normalize(output);

  // 1. Each fixed bullet must appear verbatim (modulo leading `* ` and whitespace).
  for (const anchor of FIXED_BULLET_ANCHORS) {
    const bullet = extractBulletByAnchor(mainResume, anchor);
    if (!bullet) continue; // anchor not in source — shouldn't happen
    // Strip leading `* ` before comparing so the check is bullet-content only.
    const content = normalize(bullet.replace(/^\*\s*/, ""));
    if (!normOutput.includes(content)) {
      violations.push(`Fixed bullet modified or missing (anchor: "${anchor.slice(0, 50)}")`);
    }
  }

  // 2. Profile body must be unchanged; one sentence may be appended at the end.
  const srcProfile = extractSection(mainResume, "PROFILE");
  const outProfile = extractSection(output, "PROFILE");
  if (srcProfile && outProfile) {
    if (!outProfile.startsWith(srcProfile)) {
      // Body was modified — find first differing word.
      violations.push("PROFILE body was modified (must remain verbatim before any appended sentence)");
      const srcWords = srcProfile.split(" ");
      const outWords = outProfile.split(" ");
      for (let i = 0; i < Math.min(srcWords.length, outWords.length); i++) {
        if (srcWords[i] !== outWords[i]) {
          violations.push(
            `  Profile first diff at word ${i + 1}: expected "${srcWords[i]}" got "${outWords[i]}"`,
          );
          break;
        }
      }
    } else {
      // Body is intact — check the appended portion is at most one sentence.
      const appended = outProfile.slice(srcProfile.length).trim();
      if (appended) {
        // Count sentence-ending punctuation to detect more than one sentence.
        const sentenceEnds = (appended.match(/[.!?]/g) ?? []).length;
        if (sentenceEnds > 1) {
          violations.push(
            `PROFILE has more than one appended sentence (${sentenceEnds} sentence-ending marks found): "${appended.slice(0, 80)}..."`,
          );
        }
      }
    }
  }

  // 3. Bold metrics within the Profile section must appear unchanged in the output.
  //    (Catches "7+ years" drift etc. Bank-bullet metrics are intentionally excluded
  //    because bank bullets may be legitimately omitted during tailoring.)
  const srcProfileText = extractSection(mainResume, "PROFILE") ?? "";
  for (const metric of extractBoldMetrics(srcProfileText)) {
    if (!normOutput.includes(metric)) {
      violations.push(`Profile metric removed or changed: ${metric}`);
    }
  }

  return { passed: violations.length === 0, violations };
};
