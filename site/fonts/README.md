# kannada.woff2

Noto Sans Kannada, subset to the seven codepoints in ಎಲ್ಲಿದೆ and instanced to a single
weight — 2.1 KB from a 450 KB variable font. Layout features are kept, without which the
ಲ್ಲ conjunct does not form.

It is here because the brand's own name would otherwise render in whatever Kannada font the
reader's machine happens to carry, or in tofu boxes if it carries none.

Licensed under the SIL Open Font License 1.1. https://fonts.google.com/noto/specimen/Noto+Sans+Kannada

Rebuild:
  python3 -m fontTools.varLib.instancer NotoSansKannada.ttf wght=400 wdth=100 --output kn.ttf
  python3 -m fontTools.subset kn.ttf --text="ಎಲ್ಲಿದೆ" --layout-features='*' \
      --flavor=woff2 --output-file=kannada.woff2
