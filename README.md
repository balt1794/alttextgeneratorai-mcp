# AltTextGeneratorAI MCP server

[![npm](https://img.shields.io/npm/v/alttextgeneratorai-mcp.svg)](https://www.npmjs.com/package/alttextgeneratorai-mcp)
[![license](https://img.shields.io/npm/l/alttextgeneratorai-mcp.svg)](LICENSE)

Let your AI assistant write **SEO-friendly, accessible alt text** for images, and **find the images that are missing alt text** on any web page. It works with [AltTextGeneratorAI.com](https://alttextgeneratorai.com), the AI alt text service used in Shopify, WordPress, DatoCMS, Contentstack, Chrome and 30+ other tools.

Ask your assistant things like:

- "Write alt text for https://example.com/photo.jpg in Spanish."
- "Write alt text for the image at ~/Desktop/product.png."
- "Scan https://mystore.com/products/shoes and tell me which images have no alt text."
- "Scan that page and write alt text for the first 10 images that are missing it."
- "How many credits do I have left?"

## Get an API key

Create a free account at [alttextgeneratorai.com/dashboard](https://alttextgeneratorai.com/dashboard) and copy your API key. New accounts get free credits. Credits are a one-time purchase, never expire, and are shared with every AltTextGeneratorAI integration.

## Install

You need [Node.js](https://nodejs.org) 18 or newer. The server is started on demand with `npx`, so there is nothing to install by hand.

### Claude Desktop

Open **Settings > Developer > Edit Config** and add:

```json
{
  "mcpServers": {
    "alttextgeneratorai": {
      "command": "npx",
      "args": ["-y", "alttextgeneratorai-mcp"],
      "env": { "ALTTEXTGENERATORAI_API_KEY": "your_api_key" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add alttextgeneratorai --env ALTTEXTGENERATORAI_API_KEY=your_api_key -- npx -y alttextgeneratorai-mcp
```

### Cursor

Add the same JSON as above to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project).

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "alttextgeneratorai": {
      "command": "npx",
      "args": ["-y", "alttextgeneratorai-mcp"],
      "env": { "ALTTEXTGENERATORAI_API_KEY": "your_api_key" }
    }
  }
}
```

Any other client that supports MCP servers over stdio works the same way: run `npx -y alttextgeneratorai-mcp` with the `ALTTEXTGENERATORAI_API_KEY` environment variable.

## Tools

| Tool | What it does | Credits |
| --- | --- | --- |
| `generate_alt_text` | Writes alt text for an image at a public URL. Optional `language`. | 1 |
| `generate_alt_text_from_file` | Writes alt text for an image file on your computer (JPEG, PNG, GIF or WebP, up to 3 MB). Optional `language`. | 1 |
| `audit_page` | Reads a web page and lists the images that have no alt attribute, or an empty one. Free. With `generate: true` it also writes suggested alt text for them (`max_images` up to 25, default 5). | 0, or 1 per image with `generate` |
| `check_credits` | Shows how many credits you have left. | 0 |

Notes:

- **Languages:** pass the language name in English, for example `spanish`, `french`, `german`, `japanese`. 130+ are supported. The default is English.
- **Empty alt text** (`alt=""`) is correct for purely decorative images, so `audit_page` reports those separately from images where the attribute is missing.
- **Pages that load images with JavaScript** may show fewer images, because the tool reads the page's HTML.
- The tool only reads and suggests. It never changes your website. Add the suggested text to your site yourself, or ask your assistant to do it in your code.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `ALTTEXTGENERATORAI_API_KEY` | Yes, for generating and credits | Your API key. `audit_page` without `generate` works without it. |
| `ALTTEXTGENERATORAI_API_BASE_URL` | No | Override the API address. Default `https://alttextgeneratorai.com/api`. |

## Privacy

To write alt text, the server sends your API key, the chosen language and either the image's public address or the image file itself to AltTextGeneratorAI.com. `audit_page` downloads the page you ask about directly from your computer. Nothing else is sent. See the [privacy policy](https://alttextgeneratorai.com/privacy-policy).

## Development

```bash
npm install
npm run build
npm test      # runs the server over stdio against a fake API
```

## Support

[support@alttextgeneratorai.com](mailto:support@alttextgeneratorai.com) · [alttextgeneratorai.com](https://alttextgeneratorai.com)

## License

MIT
