# Mermaid Preview with Themes

A VSCode extension that provides a rich preview experience for Mermaid diagrams with independent theme selection, not tied to your VSCode theme. It keeps everything local-no accounts, Copilot prompts, or remote services-while giving you a dedicated preview surface with toolbar controls, per-diagram commands, and quick SVG/PNG/JPG exports instead of relying on the built-in Markdown preview.

## Features

- **Independent Theme Selection**: Choose from multiple Mermaid themes (default, dark, forest, neutral, base) directly in the preview panel
- **Optional VSCode Theme Sync**: Toggle option to automatically sync Mermaid theme with your VSCode theme (dark/light)
- **Live Preview**: Automatic preview updates as you edit your Mermaid diagrams
- **Rich Preview Toolbar**: Zoom, pan, reset, navigate between diagrams, and change the preview chrome (match VS Code, light, or dark) without leaving the panel
- **Export Options**: Save any diagram as SVG, PNG, or JPG right from the preview toolbar
- **Per-Diagram Commands**: Use the gutter icon or CodeLens above each \`\`\`mermaid block to open a focused preview beside the editor
- **Side-by-Side View**: Open preview beside your editor for convenient editing
- **Theme Persistence**: Save your preferred theme as default
- **Multi-Diagram Support**: Preview every Mermaid block in a document and jump between them with the toolbar navigation controls
- **Offline Friendly**: Bundles Mermaid 11.12.2 locally, so previews work without a network connection or account

## Usage

### Opening the Preview

1. Open a Markdown file containing Mermaid diagrams
2. Use one of these methods:
   - Click the preview icon in the editor title bar
   - Right-click in the editor and select "Mermaid: Open Preview"
   - Use Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and search for "Mermaid: Open Preview"
   - For side-by-side view: "Mermaid: Open Preview to the Side"

### Changing Themes

In the preview panel toolbar:
- Use the **Theme** dropdown to select different themes
- Check **"Sync with VSCode theme"** to automatically match VSCode's theme
- Click **"Save as Default"** to persist your theme choice

### Previewing Individual Diagrams

- A **CodeLens button** labeled *Preview Diagram* appears above every ```mermaid block-click it to open a focused preview beside the editor.
- A subtle **gutter icon** highlights each Mermaid fence so you can spot diagrams at a glance and trigger the same side-by-side preview from the icon.
- Both entry points respect your theme/appearance preferences and keep the preview in sync as you edit.

### Supported Themes

- **Default**: Classic Mermaid theme with clean, neutral colors
- **Dark**: Dark background with light elements
- **Forest**: Green-themed palette
- **Neutral**: Minimalist grayscale theme
- **Base**: Simple base theme

## Configuration

Configure the extension through VSCode settings:

```json
{
  // Default theme for Mermaid diagrams
  "mermaidPreview.theme": "default",

  // Automatically sync Mermaid theme with VSCode theme
  "mermaidPreview.useVSCodeTheme": false,

  // Automatically refresh preview on document changes
  "mermaidPreview.autoRefresh": true,

  // Delay in milliseconds before refreshing preview after changes
  "mermaidPreview.refreshDelay": 500
}
```

## Example Mermaid Diagram

```markdown
\`\`\`mermaid
graph TD
    A[Start] --> B{Is it working?}
    B -->|Yes| C[Great!]
    B -->|No| D[Debug]
    D --> B
\`\`\`
```

## Commands

- `Mermaid: Open Preview` - Opens preview in current column
- `Mermaid: Open Preview to the Side` - Opens preview beside editor

## Requirements

- VSCode 1.85.0 or higher
- Markdown files with Mermaid code blocks

## Known Limitations

- Only previews Mermaid diagrams within \`\`\`mermaid code blocks

## Extension Settings

This extension contributes the following settings:

* `mermaidPreview.theme`: Choose the default Mermaid theme
* `mermaidPreview.useVSCodeTheme`: Sync theme with VSCode
* `mermaidPreview.autoRefresh`: Enable/disable auto-refresh
* `mermaidPreview.refreshDelay`: Set refresh delay in milliseconds

## Release Notes

### 0.0.1

Initial release:
- Mermaid diagram preview
- Multiple theme support
- Independent theme selection
- Optional VSCode theme sync
- Live preview updates
- Theme persistence

## Contributing

Found a bug or have a feature request? Please open an issue!

## License

MIT
