# Provider icons

Monochrome vendor marks, one file per models.dev provider id.

- Most glyphs come from the OpenCode UI package (`packages/ui/src/assets/icons/provider/`,
  https://github.com/anomalyco/opencode), MIT License, Copyright (c) 2025 opencode.
- Some were added from lobe-icons (https://github.com/lobehub/lobe-icons, `@lobehub/icons-static-svg`),
  MIT License, Copyright (c) LobeHub: volcengine, sensenova, cline-pass, longcat, poolside, arcee, crusoe,
  agnes, tencent-tokenhub, meta, lmstudio, morph, upstage, stepfun, nebius, tencent-coding-plan, modelscope.
- Family variants (token plans / coding plans / regional endpoints) reuse the parent brand's mark.
- `*.png` files are monochrome silhouettes derived from the respective provider's own site icon / favicon
  (fetched from the vendor's website, background keyed out, cropped, 96×96). They are used solely to identify
  that provider in the picker, the same way a browser tab shows a site's favicon.
- `_provider.svg` is our own neutral "hub node" mark, used for providers that publish no usable logo.

Individual provider trademarks belong to their respective owners.
