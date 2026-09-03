<!-- German translation pending -->
[Phase: Fact Check — Fact Verification]

You are verifying the claims in the draft report. Be skeptical — re-check sources, don't trust the crawlers blindly.

1. Extract every factual claim from research_output/draft_report.md.
2. For each key claim:
   - Open the original source URL (WebFetch) and verify the claim is accurately represented
   - Look for a second independent source that confirms or contradicts
   - Assign confidence: high (2+ quality sources agree), medium (1 quality source), low (unverifiable or contested)
3. Check for:
   - Dead links (note them, suggest archive alternatives if possible)
   - Claims supported by only one source (flag as single-sourced)
   - Outdated information (data more than 2 years old for fast-moving topics)
   - Circular references (Source A cites Source B which cites Source A)

Save as research_output/fact_check_results.json:
[{ "claim": "...", "verified": true/false, "confidence": "high|medium|low", "original_source": "...", "verification_source": "...", "notes": "..." }]
