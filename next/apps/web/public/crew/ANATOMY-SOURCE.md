# Crew revision 3 · anatomical source

The articulated bodies, clothing, hair, facial adaptation and material treatment
are authored in this repository. The head topology derives from the MakeHuman
community's CC0 base mesh (graphical data, not application source code).

- Repository: https://github.com/makehumancommunity/makehuman
- Pinned commit: `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`
- Asset: `makehuman/data/3dobjs/base.obj`
- Original SHA-256: `8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c`
- Asset license: CC0 1.0 Universal, included in `LICENSE-HEAD-CC0.md`.
- Primary license declaration explicitly includes the base mesh:
  https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.md#c-the-license-for-the-bundled-assets

Only the body-group head above original Y=5.8 was extracted, clipped at the neck
and simplified with meshoptimizer 1.1.1 to 3,500 triangles, with the border locked.
Helper/joint objects are excluded. The stored indexed mesh has 1,775 vertices.
The precise coordinate normalization, landmarks, source hash and simplification
error are recorded in `apps/web/src/assets/crew-head.provenance.json`.

`apps/web/src/assets/crew-head.json` is versioned input data. Rebuilding all nine
characters from this input is local and deterministic:

```
node apps/web/tools/generate-crew-assets.ts
node apps/web/tools/render-crew-portraits.mjs
```

The exported GLBs embed their buffers, contain no external textures, and are
verified against the manifest at runtime. No provider or paid model is called.
