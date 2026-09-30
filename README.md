# ABC Piano Roll for NotebookLM & Gemini

A high-performance browser extension that transforms ABC musical notation in **Google NotebookLM**, **Gemini App**, and **Gemini Spark** into interactive FL Studio-style Piano Roll widgets with realistic audio synthesis, MIDI import/export, and an in-browser composer.

---

## Features

- **Interactive Piano Roll**: Automatically replaces raw ABC notation code blocks in chat turns with interactive, FL Studio-style piano roll canvases.
- **Realistic Piano Sound**: Built-in soundfont-based acoustic piano engine with volume and velocity expression dynamics.
- **Full-Screen Composer**: Click the `🎹 Piano Roll` button next to the prompt input to compose, draw, edit, and insert notes directly into your chat.
- **MIDI Import & Export**:
  - Download any generated score as a standard `.mid` file with a single click.
  - Import external MIDI files into the composer with strict musical quantization.
- **Bi-Directional ABC 2.1 Engine**: Mathematical parser and generator supporting multi-voice polyphony, chords, ties, barline splitting, and accidental cancellation.
- **Zero Dependencies**: Pure vanilla JavaScript and HTML5 Canvas with lazy-loading and streaming support.

---

## Supported Platforms

| Platform | URL |
|---|---|
| **Google NotebookLM** | `https://notebooklm.google.com` / `https://notebook.google.com` |
| **Gemini App** | `https://gemini.google.com/app` |
| **Gemini Spark** | `https://gemini.google.com/spark` |

---

## Installation

Works with any Chromium-based browser (Google Chrome, Microsoft Edge, Brave, Opera, Vivaldi):

1. **Download or Clone** this repository:
   ```bash
   git clone https://github.com/your-username/abc-piano-roll.git
   ```
2. Open your browser and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the project directory containing `manifest.json`.
6. Navigate to [NotebookLM](https://notebooklm.google.com) or [Gemini](https://gemini.google.com) and prompt the model to generate music in ABC format!

---

## Keyboard & Navigation Shortcuts

- **Spacebar**: Play / Pause playback
- **Wheel over Piano Keys**: Vertical Zoom (key height)
- **Wheel over Ruler**: Horizontal Zoom (time scaling)
- **Wheel over Grid**: Vertical Scroll
- **Shift + Wheel**: Horizontal Scroll
- **Left Click on Grid**: Draw / Move notes
- **Right Click on Note**: Delete note
- **Right Edge Drag**: Note duration resize

---

## License

MIT License. Free for personal and commercial use.
