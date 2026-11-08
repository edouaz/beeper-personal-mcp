# Visual identity

Beeper Personal MCP uses a quiet blue-to-violet palette, generous space, rounded cards and the system font stack. It takes cues from messaging apps and iOS without copying a company logo or claiming endorsement.

| Token | Light | Dark |
| --- | --- | --- |
| Background | `#f5f5fa` | `#14141c` |
| Card | `#ffffff` | `#20202c` |
| Text | `#20212b` | `#f3f3fa` |
| Secondary text | `#656878` | `#b0b0c5` |
| Accent | `#6558e8` | `#9a8cff` |

Original repository banner: `docs/assets/banner.svg`. OAuth/confirmation UI: `mcp/page.mjs`. Pages have no remote fonts, images, JavaScript or analytics. Both support dark appearance and visible keyboard focus. Avoid decorative content that hides the exact message or the approval consequences.

Product name: **Beeper Personal MCP**. Tagline: **Your conversations, connected.** Use the name with the independent-project notice. MIT covers the original assets in this repository; third-party trademarks remain their owners’ property.


## Downloadable plugin icons

The public [brand kit](https://edouaz.github.io/beeper-personal-mcp/#brand) is in `website/assets/brand-kit.zip`. It includes the original square 1024×1024 SVG app logo, PNG exports at 1024 and 512 pixels, a transparent monochrome composer mark, a dark composer variant and a portable manifest snippet. Raster exports are rendered from the SVGs, not separately redrawn.

The assets are original MIT-licensed project artwork. You may reuse them for your own Beeper Personal MCP installation/plugin; do not imply endorsement by Beeper, OpenAI or Apple. This kit is not a complete plugin package or an OpenAI approval.

### Format validation

Checked against the [official OpenAI plugin submission documentation](https://developers.openai.com/plugins/deploy/submission), consulted November 9, 2026:

- Square icons, at least 48×48; raster dimensions no more than 4096 per side.
- PNG, JPEG, WebP and SVG are supported; each asset must be at most 5 MiB.
- SVGs have explicit square numeric dimensions and square viewBoxes.
- Include a primary `logo` and `composerIcon`; dark variants are optional.
- Paths in a portable plugin’s `extensions.com.openai.interface` start with `./` and point to files included in the plugin.

All supplied images satisfy those dimensions/size constraints. `manifest-example.json` is a fragment to merge into your plugin manifest. Copy the referenced assets into your plugin’s `assets/` directory as well; a URL in the README alone is not a packaged logo.

```json
{
  "extensions": {
    "com.openai": {
      "interface": {
        "logo": "./assets/logo-1024.png",
        "composerIcon": "./assets/composer.svg",
        "composerIconDark": "./assets/composer-dark.svg"
      }
    }
  }
}
```

For the website, edit `website/index.html`, `styles.css` and `script.js`. The GitHub Pages workflow uploads only `website/`; private runtime state is never part of the site. It uses system fonts and no analytics, remote scripts or CDN dependencies.
